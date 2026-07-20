use crate::error::AppError;
use crate::services::pandoc;
use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, OnceCell};

pub const MAX_MARKDOWN_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_HTML_BYTES: usize = 20 * 1024 * 1024;
pub const MAX_DIAGNOSTIC_BYTES: usize = 8 * 1024;
const MAX_CAPABILITY_BYTES: usize = 256 * 1024;
const PANDOC_TIMEOUT: Duration = Duration::from_secs(120);
const REQUIRED_EXTENSIONS: [&str; 7] = [
    "pipe_tables",
    "footnotes",
    "fenced_code_blocks",
    "fenced_code_attributes",
    "backtick_code_blocks",
    "mark",
    "tex_math_dollars",
];

type CapabilitySet = Arc<HashSet<String>>;
type CapabilityResult = Result<CapabilitySet, String>;
type CapabilityCell = Arc<OnceCell<CapabilitySet>>;
static CAPABILITY_CACHE: Lazy<Mutex<HashMap<String, CapabilityCell>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

use pandoc::{PipedPandocFailure as ProcessFailure, PipedPandocOutput as ProcessOutput};

pub async fn styled_markdown_to_html(markdown: &str) -> Result<String, AppError> {
    validate_markdown_size(markdown)?;
    let (binary, _) = pandoc::resolve_with_settings()
        .await
        .ok_or_else(|| AppError::Custom("pandoc_not_found".to_string()))?;
    styled_markdown_to_html_with_binary_and_timeout(markdown, &binary, PANDOC_TIMEOUT).await
}

pub(crate) async fn styled_markdown_to_html_with_binary_and_timeout(
    markdown: &str,
    binary: &str,
    timeout: Duration,
) -> Result<String, AppError> {
    validate_markdown_size(markdown)?;
    let supported = capabilities_for(binary, timeout).await?;
    let missing: Vec<&str> = REQUIRED_EXTENSIONS
        .iter()
        .copied()
        .filter(|extension| !supported.contains(*extension))
        .collect();
    if !missing.is_empty() {
        return Err(AppError::Custom(format!(
            "unsupported_pandoc_extensions: {}",
            missing.join(", ")
        )));
    }

    let mut reader = String::from("markdown");
    for extension in REQUIRED_EXTENSIONS {
        reader.push('+');
        reader.push_str(extension);
    }
    reader.push_str("-raw_html-raw_tex");
    if supported.contains("raw_attribute") {
        reader.push_str("-raw_attribute");
    }

    let args = ["--from", reader.as_str(), "--to=html5", "--mathjax"];
    let output = run_bounded_process(
        binary,
        &args,
        Some(markdown.as_bytes()),
        MAX_HTML_BYTES,
        timeout,
    )
    .await
    .map_err(map_conversion_process_failure)?;

    if !output.status.success() {
        let diagnostic = bounded_diagnostic(&output.stderr);
        return if diagnostic.is_empty() {
            Err(AppError::Custom("pandoc_failed".to_string()))
        } else {
            Err(AppError::Custom(format!("pandoc_failed: {diagnostic}")))
        };
    }

    String::from_utf8(output.stdout)
        .map_err(|_| AppError::Custom("pandoc_output_invalid_utf8".to_string()))
}

fn validate_markdown_size(markdown: &str) -> Result<(), AppError> {
    if markdown.len() > MAX_MARKDOWN_BYTES {
        return Err(AppError::Custom("pandoc_input_too_large".to_string()));
    }
    Ok(())
}

async fn capabilities_for(
    binary: &str,
    timeout: Duration,
) -> Result<Arc<HashSet<String>>, AppError> {
    let cell = {
        let mut cache = CAPABILITY_CACHE.lock().await;
        cache
            .entry(binary.to_string())
            .or_insert_with(|| Arc::new(OnceCell::new()))
            .clone()
    };

    let binary = binary.to_string();
    cell.get_or_try_init(|| async move { probe_capabilities(&binary, timeout).await })
        .await
        .cloned()
        .map_err(AppError::Custom)
}

async fn probe_capabilities(binary: &str, timeout: Duration) -> CapabilityResult {
    let output = run_bounded_process(
        binary,
        &["--list-extensions=markdown"],
        None,
        MAX_CAPABILITY_BYTES,
        timeout,
    )
    .await
    .map_err(|failure| match failure {
        ProcessFailure::NotFound => "pandoc_not_found".to_string(),
        ProcessFailure::Timeout => "pandoc_capability_probe_timeout".to_string(),
        _ => "pandoc_capability_probe_failed".to_string(),
    })?;
    if !output.status.success() {
        return Err("pandoc_capability_probe_failed".to_string());
    }

    let text = String::from_utf8(output.stdout)
        .map_err(|_| "pandoc_capability_probe_failed".to_string())?;
    let supported = text
        .lines()
        .filter_map(|line| {
            let extension = line.trim();
            let extension = extension
                .strip_prefix('+')
                .or_else(|| extension.strip_prefix('-'))
                .unwrap_or(extension);
            (!extension.is_empty()).then(|| extension.to_string())
        })
        .collect();
    Ok(Arc::new(supported))
}

fn map_conversion_process_failure(failure: ProcessFailure) -> AppError {
    let code = match failure {
        ProcessFailure::NotFound => "pandoc_not_found",
        ProcessFailure::Spawn => "pandoc_spawn_failed",
        ProcessFailure::Wait => "pandoc_wait_failed",
        ProcessFailure::Write => "pandoc_input_write_failed",
        ProcessFailure::Timeout => "pandoc_timeout",
        ProcessFailure::OutputOverflow => "pandoc_output_too_large",
        ProcessFailure::RetainedPipes => "pandoc_cleanup_failed",
    };
    AppError::Custom(code.to_string())
}

async fn run_bounded_process(
    binary: &str,
    args: &[&str],
    input: Option<&[u8]>,
    stdout_limit: usize,
    timeout: Duration,
) -> Result<ProcessOutput, ProcessFailure> {
    let output = pandoc::run_piped_pandoc(
        binary,
        args,
        input,
        stdout_limit,
        MAX_DIAGNOSTIC_BYTES,
        timeout,
    )
    .await?;
    if let Some(warning) = output.cleanup_warning.as_ref() {
        tracing::warn!(target: "novelist::styled_copy", stage = warning.stage.tag(), message = %warning.message, "Pandoc cleanup warning");
    }
    Ok(output)
}

fn bounded_diagnostic(bytes: &[u8]) -> String {
    let decoded = String::from_utf8_lossy(bytes);
    let mut diagnostic = sanitize_diagnostic(&decoded);
    if diagnostic.len() > MAX_DIAGNOSTIC_BYTES {
        let mut end = MAX_DIAGNOSTIC_BYTES;
        while !diagnostic.is_char_boundary(end) {
            end -= 1;
        }
        diagnostic.truncate(end);
    }
    diagnostic.trim().to_string()
}

const DIAGNOSTIC_KV_KEYS: &[&str] = &[
    "access_token",
    "api_key",
    "client_secret",
    "password",
    "secret",
    "token",
];

const DIAGNOSTIC_JSON_KEYS: &[&str] = &[
    "access_token",
    "api_key",
    "client_secret",
    "password",
    "secret",
    "token",
];

fn sanitize_diagnostic(input: &str) -> String {
    let mut sanitized = String::with_capacity(input.len());
    for line in input.split_inclusive('\n') {
        sanitized.push_str(&redact_diagnostic_header(line));
    }
    for prefix in ["Bearer ", "bearer ", "Basic ", "Ghost ", "Token "] {
        sanitized = redact_scheme_value(&sanitized, prefix);
    }
    for key in DIAGNOSTIC_KV_KEYS {
        sanitized = redact_key_value(&sanitized, key);
    }
    for key in DIAGNOSTIC_JSON_KEYS {
        sanitized = redact_json_string(&sanitized, key);
    }
    sanitized
}

fn redact_diagnostic_header(line: &str) -> String {
    let Some(colon) = line.find(':') else {
        return line.to_string();
    };
    let header = line[..colon].trim().to_ascii_lowercase();
    if !matches!(
        header.as_str(),
        "authorization" | "cookie" | "set-cookie" | "x-api-key" | "x-auth-token"
    ) {
        return line.to_string();
    }

    let after_colon = &line[colon + 1..];
    let without_line_end = after_colon.trim_end_matches(['\r', '\n']);
    let leading_len = without_line_end
        .find(|character: char| !character.is_whitespace())
        .unwrap_or(without_line_end.len());
    if leading_len == without_line_end.len() {
        return line.to_string();
    }

    let mut redacted = String::with_capacity(line.len());
    redacted.push_str(&line[..colon + 1]);
    redacted.push_str(&without_line_end[..leading_len]);
    redacted.push_str("<redacted>");
    redacted.push_str(&after_colon[without_line_end.len()..]);
    redacted
}

fn redact_scheme_value(input: &str, prefix: &str) -> String {
    let mut redacted = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(index) = rest.find(prefix) {
        redacted.push_str(&rest[..index + prefix.len()]);
        rest = &rest[index + prefix.len()..];
        let value_end = rest
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '"' | '\'' | ',' | ';' | ')' | '&')
            })
            .unwrap_or(rest.len());
        if value_end == 0 {
            continue;
        }
        redacted.push_str("<redacted>");
        rest = &rest[value_end..];
    }
    redacted.push_str(rest);
    redacted
}

fn redact_key_value(input: &str, key: &str) -> String {
    let mut redacted = String::with_capacity(input.len());
    let mut rest = input;
    loop {
        let Some(index) = find_diagnostic_key(rest, key) else {
            redacted.push_str(rest);
            break;
        };
        let after_key = &rest[index + key.len()..];
        let whitespace_len = after_key
            .find(|character: char| !character.is_whitespace())
            .unwrap_or(after_key.len());
        let after_whitespace = &after_key[whitespace_len..];
        if !after_whitespace.starts_with('=') && !after_whitespace.starts_with(':') {
            redacted.push_str(&rest[..index + key.len()]);
            rest = &rest[index + key.len()..];
            continue;
        }

        let after_equals = &after_whitespace[1..];
        let value_whitespace_len = after_equals
            .find(|character: char| !character.is_whitespace())
            .unwrap_or(after_equals.len());
        let value = &after_equals[value_whitespace_len..];
        let value_start = index + key.len() + whitespace_len + 1 + value_whitespace_len;
        redacted.push_str(&rest[..value_start]);
        if let Some(quote) = value
            .chars()
            .next()
            .filter(|character| matches!(character, '"' | '\''))
        {
            redacted.push(quote);
            let quoted = &value[quote.len_utf8()..];
            let value_end = quoted.find(quote).unwrap_or(quoted.len());
            redacted.push_str("<redacted>");
            rest = &quoted[value_end..];
        } else {
            let value_end = value
                .find(|character: char| {
                    character.is_whitespace()
                        || matches!(character, '&' | ';' | ',' | '"' | '\'' | '}')
                })
                .unwrap_or(value.len());
            redacted.push_str("<redacted>");
            rest = &value[value_end..];
        }
    }
    redacted
}

fn find_diagnostic_key(input: &str, key: &str) -> Option<usize> {
    let lower = input.to_ascii_lowercase();
    let mut start = 0;
    while let Some(relative) = lower[start..].find(key) {
        let index = start + relative;
        let has_boundary = index == 0
            || matches!(
                input.as_bytes()[index - 1],
                b' ' | b'\t' | b'\n' | b'\r' | b'?' | b'&' | b';' | b','
            );
        if has_boundary {
            return Some(index);
        }
        start = index + key.len();
    }
    None
}

fn redact_json_string(input: &str, key: &str) -> String {
    let needle = format!("\"{}\"", key.to_ascii_lowercase());
    let mut redacted = String::with_capacity(input.len());
    let mut rest = input;
    loop {
        let lower = rest.to_ascii_lowercase();
        let Some(index) = lower.find(&needle) else {
            redacted.push_str(rest);
            break;
        };
        let after_key_index = index + needle.len();
        let after_key = &rest[after_key_index..];
        let first_whitespace_len = after_key
            .find(|character: char| !character.is_whitespace())
            .unwrap_or(after_key.len());
        let after_first_whitespace = &after_key[first_whitespace_len..];
        if !after_first_whitespace.starts_with(':') {
            redacted.push_str(&rest[..after_key_index]);
            rest = after_key;
            continue;
        }

        let after_colon = &after_first_whitespace[1..];
        let second_whitespace_len = after_colon
            .find(|character: char| !character.is_whitespace())
            .unwrap_or(after_colon.len());
        let value = &after_colon[second_whitespace_len..];
        if !value.starts_with('"') {
            let value_start = after_key_index + first_whitespace_len + 1 + second_whitespace_len;
            redacted.push_str(&rest[..value_start]);
            rest = value;
            continue;
        }

        let value_start = after_key_index + first_whitespace_len + 1 + second_whitespace_len;
        redacted.push_str(&rest[..value_start + 1]);
        let quoted = &rest[value_start + 1..];
        let mut closing_quote = None;
        let mut escaped = false;
        for (offset, character) in quoted.char_indices() {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                closing_quote = Some(offset);
                break;
            }
        }
        redacted.push_str("<redacted>");
        match closing_quote {
            Some(offset) => rest = &quoted[offset..],
            None => break,
        }
    }
    redacted
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::io::Write;
    #[cfg(unix)]
    use std::path::PathBuf;
    #[cfg(unix)]
    use std::process::Stdio;
    use std::time::Duration;
    #[cfg(unix)]
    use tempfile::TempDir;

    #[allow(dead_code)]
    const REQUIRED_EXTENSIONS: &str = "+pipe_tables\n-footnotes\n+fenced_code_blocks\n-fenced_code_attributes\n+backtick_code_blocks\n-mark\n+tex_math_dollars\n+raw_attribute\n";
    const TEST_PROCESS_TIMEOUT: Duration = Duration::from_secs(10);

    #[cfg(unix)]
    fn make_fake_pandoc(
        dir: &TempDir,
        extensions: &str,
        html: &[u8],
        stderr: &[u8],
        exit_code: i32,
        sleep_seconds: Option<u64>,
    ) -> (PathBuf, PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;

        let extensions_path = dir.path().join("extensions.txt");
        let html_path = dir.path().join("output.html");
        let stderr_path = dir.path().join("stderr.txt");
        let argv_path = dir.path().join("argv.txt");
        let stdin_path = dir.path().join("stdin.md");
        let pid_path = dir.path().join("pid.txt");
        std::fs::write(&extensions_path, extensions).unwrap();
        std::fs::write(&html_path, html).unwrap();
        std::fs::write(&stderr_path, stderr).unwrap();

        let script = dir.path().join("fake-pandoc.sh");
        let mut file = std::fs::File::create(&script).unwrap();
        writeln!(file, "#!/bin/sh").unwrap();
        writeln!(file, "printf '%s\\n' \"$@\" >> '{}'", argv_path.display()).unwrap();
        writeln!(file, "if [ \"$1\" = \"--list-extensions=markdown\" ]; then").unwrap();
        writeln!(file, "  /bin/cat '{}'", extensions_path.display()).unwrap();
        writeln!(file, "  exit 0").unwrap();
        writeln!(file, "fi").unwrap();
        writeln!(file, "/bin/cat > '{}'", stdin_path.display()).unwrap();
        writeln!(file, "printf '%s' \"$$\" > '{}'", pid_path.display()).unwrap();
        if let Some(seconds) = sleep_seconds {
            writeln!(file, "exec /bin/sleep {seconds}").unwrap();
        } else {
            writeln!(file, "/bin/cat '{}'", html_path.display()).unwrap();
            writeln!(file, "/bin/cat '{}' >&2", stderr_path.display()).unwrap();
            writeln!(file, "exit {exit_code}").unwrap();
        }
        drop(file);

        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();
        (script, argv_path, pid_path)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn styled_copy_uses_safe_reader_and_caches_prefixed_capabilities() {
        let dir = TempDir::new().unwrap();
        let html = "<p><mark>重点</mark> <span class=\"math inline\">E=mc^2</span></p>";
        let (binary, argv_path, _) =
            make_fake_pandoc(&dir, REQUIRED_EXTENSIONS, html.as_bytes(), b"", 0, None);

        for _ in 0..2 {
            let converted = styled_markdown_to_html_with_binary_and_timeout(
                "==重点== $E=mc^2$",
                binary.to_str().unwrap(),
                TEST_PROCESS_TIMEOUT,
            )
            .await
            .unwrap();
            assert!(converted.contains("<mark>重点</mark>"));
            assert!(converted.contains("class=\"math inline\""));
            assert!(converted.contains("E=mc^2"));
        }

        let argv = std::fs::read_to_string(argv_path).unwrap();
        assert_eq!(argv.matches("--list-extensions=markdown").count(), 1);
        let reader = "markdown+pipe_tables+footnotes+fenced_code_blocks+fenced_code_attributes+backtick_code_blocks+mark+tex_math_dollars-raw_html-raw_tex-raw_attribute";
        assert_eq!(argv.matches(reader).count(), 2, "argv was:\n{argv}");
        assert_eq!(argv.matches("--to=html5").count(), 2);
        assert_eq!(argv.matches("--mathjax").count(), 2);
        assert!(!argv.contains("--standalone"));
        assert!(!argv.contains("--syntax-highlighting"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn transient_capability_failure_is_retried_for_the_same_binary() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let marker = dir.path().join("first-probe-failed");
        let extensions = dir.path().join("extensions.txt");
        let script = dir.path().join("retryable-pandoc.sh");
        std::fs::write(&extensions, REQUIRED_EXTENSIONS).unwrap();
        let mut file = std::fs::File::create(&script).unwrap();
        writeln!(file, "#!/bin/sh").unwrap();
        writeln!(file, "if [ \"$1\" = '--list-extensions=markdown' ]; then").unwrap();
        writeln!(file, "  if [ ! -e '{}' ]; then", marker.display()).unwrap();
        writeln!(file, "    /usr/bin/touch '{}'; exit 47", marker.display()).unwrap();
        writeln!(file, "  fi").unwrap();
        writeln!(file, "  /bin/cat '{}'; exit 0", extensions.display()).unwrap();
        writeln!(file, "fi").unwrap();
        writeln!(file, "/bin/cat >/dev/null").unwrap();
        writeln!(file, "printf '<p>retry succeeded</p>'").unwrap();
        drop(file);
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();

        let first = styled_markdown_to_html_with_binary_and_timeout(
            "first",
            script.to_str().unwrap(),
            TEST_PROCESS_TIMEOUT,
        )
        .await;
        assert_eq!(
            first.unwrap_err().to_string(),
            "pandoc_capability_probe_failed"
        );

        let second = styled_markdown_to_html_with_binary_and_timeout(
            "second",
            script.to_str().unwrap(),
            TEST_PROCESS_TIMEOUT,
        )
        .await
        .expect("transient capability errors must not remain cached");
        assert_eq!(second, "<p>retry succeeded</p>");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn raw_attribute_is_disabled_only_when_supported() {
        let dir = TempDir::new().unwrap();
        let extensions = REQUIRED_EXTENSIONS.replace("+raw_attribute\n", "");
        let (binary, argv_path, _) = make_fake_pandoc(&dir, &extensions, b"<p>x</p>", b"", 0, None);

        styled_markdown_to_html_with_binary_and_timeout(
            "x",
            binary.to_str().unwrap(),
            TEST_PROCESS_TIMEOUT,
        )
        .await
        .unwrap();

        let argv = std::fs::read_to_string(argv_path).unwrap();
        assert!(argv.contains("-raw_html-raw_tex"));
        assert!(!argv.contains("-raw_attribute"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn missing_required_capability_blocks_conversion() {
        let dir = TempDir::new().unwrap();
        let extensions = REQUIRED_EXTENSIONS.replace("-mark\n", "");
        let (binary, argv_path, _) = make_fake_pandoc(&dir, &extensions, b"ignored", b"", 0, None);

        let error = styled_markdown_to_html_with_binary_and_timeout(
            "==blocked==",
            binary.to_str().unwrap(),
            TEST_PROCESS_TIMEOUT,
        )
        .await
        .unwrap_err()
        .to_string();

        assert!(
            error.starts_with("unsupported_pandoc_extensions:"),
            "{error}"
        );
        assert!(error.contains("mark"), "{error}");
        let argv = std::fs::read_to_string(argv_path).unwrap();
        assert_eq!(argv.matches("--list-extensions=markdown").count(), 1);
        assert!(!argv.contains("--to=html5"));
    }

    #[tokio::test]
    async fn oversized_markdown_is_rejected_before_spawn() {
        let markdown = "x".repeat(MAX_MARKDOWN_BYTES + 1);
        let error = styled_markdown_to_html_with_binary_and_timeout(
            &markdown,
            "/binary/must/not/run",
            Duration::from_secs(1),
        )
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(error, "pandoc_input_too_large");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn oversized_html_is_bounded_and_rejected() {
        let dir = TempDir::new().unwrap();
        let html = vec![b'x'; MAX_HTML_BYTES + 1];
        let (binary, _, _) = make_fake_pandoc(&dir, REQUIRED_EXTENSIONS, &html, b"", 0, None);

        let error = styled_markdown_to_html_with_binary_and_timeout(
            "# bounded",
            binary.to_str().unwrap(),
            TEST_PROCESS_TIMEOUT,
        )
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(error, "pandoc_output_too_large");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn diagnostics_are_utf8_safe_and_bounded_to_eight_kib() {
        let dir = TempDir::new().unwrap();
        let diagnostics = format!("{}END_SECRET", "错误".repeat(6000));
        let (binary, _, _) = make_fake_pandoc(
            &dir,
            REQUIRED_EXTENSIONS,
            b"",
            diagnostics.as_bytes(),
            7,
            None,
        );

        let error = styled_markdown_to_html_with_binary_and_timeout(
            "x",
            binary.to_str().unwrap(),
            TEST_PROCESS_TIMEOUT,
        )
        .await
        .unwrap_err()
        .to_string();

        assert!(error.starts_with("pandoc_failed:"), "{error}");
        assert!(error.len() <= MAX_DIAGNOSTIC_BYTES + 32, "{}", error.len());
        assert!(!error.contains("END_SECRET"));
        assert!(error.is_char_boundary(error.len()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn diagnostics_redact_headers_schemes_params_and_json_secrets() {
        let dir = TempDir::new().unwrap();
        let secrets = [
            "AUTH_HEADER_SECRET_123",
            "COOKIE_HEADER_SECRET_456",
            "API_HEADER_SECRET_789",
            "BEARER_SCHEME_SECRET_111",
            "BASIC_SCHEME_SECRET_222",
            "GHOST_SCHEME_SECRET_333",
            "TOKEN_SCHEME_SECRET_444",
            "TOKEN_PARAM_SECRET_555",
            "API_KEY_PARAM_SECRET_666",
            "ACCESS_TOKEN_PARAM_SECRET_777",
            "PASSWORD_PARAM_SECRET_888",
            "CLIENT_SECRET_PARAM_SECRET_999",
            "SECRET_PARAM_SECRET_000",
            "JSON_PASSWORD_SECRET_ABC",
            "JSON_TOKEN_SECRET_DEF",
        ];
        let diagnostics = format!(
            "Could not parse line 12\n\
Authorization: Bearer {}\n\
Cookie: session={}\n\
X-API-Key: {}\n\
filter Bearer {} Basic {} Ghost {} Token {}\n\
https://example.test/?token={}&api_key={}\n\
access_token={}&password={}&client_secret={}&secret={}\n\
{{\"password\":\"{}\",\"token\":\"{}\"}}",
            secrets[0],
            secrets[1],
            secrets[2],
            secrets[3],
            secrets[4],
            secrets[5],
            secrets[6],
            secrets[7],
            secrets[8],
            secrets[9],
            secrets[10],
            secrets[11],
            secrets[12],
            secrets[13],
            secrets[14],
        );
        let (binary, _, _) = make_fake_pandoc(
            &dir,
            REQUIRED_EXTENSIONS,
            b"",
            diagnostics.as_bytes(),
            7,
            None,
        );

        let error = styled_markdown_to_html_with_binary_and_timeout(
            "x",
            binary.to_str().unwrap(),
            TEST_PROCESS_TIMEOUT,
        )
        .await
        .unwrap_err()
        .to_string();

        assert!(error.contains("Could not parse line 12"), "{error}");
        assert!(error.contains("<redacted>"), "{error}");
        for secret in secrets {
            assert!(!error.contains(secret), "leaked {secret}: {error}");
        }
    }

    #[test]
    fn diagnostics_redact_colon_delimited_secret_values() {
        let diagnostic =
            bounded_diagnostic(b"token: COLON_TOKEN_SECRET\npassword : quoted-secret\n");
        assert!(!diagnostic.contains("COLON_TOKEN_SECRET"));
        assert!(!diagnostic.contains("quoted-secret"));
        assert!(diagnostic.contains("token: <redacted>"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn diagnostics_redact_partial_secret_crossing_truncation_boundary() {
        let dir = TempDir::new().unwrap();
        let key = "access_token=";
        let secret = "BOUNDARY_SECRET_VALUE_0123456789";
        let partial = &secret[..8];
        let diagnostics = format!(
            "{}?{}{}",
            "x".repeat(MAX_DIAGNOSTIC_BYTES - 1 - key.len() - partial.len()),
            key,
            secret
        );
        let (binary, _, _) = make_fake_pandoc(
            &dir,
            REQUIRED_EXTENSIONS,
            b"",
            diagnostics.as_bytes(),
            7,
            None,
        );

        let error = styled_markdown_to_html_with_binary_and_timeout(
            "x",
            binary.to_str().unwrap(),
            TEST_PROCESS_TIMEOUT,
        )
        .await
        .unwrap_err()
        .to_string();

        assert!(error.contains("?access_token=<redact"), "{error}");
        assert!(!error.contains(secret), "leaked full secret: {error}");
        assert!(!error.contains(partial), "leaked partial secret: {error}");
        assert!(error.len() <= MAX_DIAGNOSTIC_BYTES + 32, "{}", error.len());
    }

    #[test]
    fn diagnostics_preserve_ordinary_actionable_pandoc_errors() {
        let message = "Could not parse line 12: unexpected token near 章节";
        assert_eq!(bounded_diagnostic(message.as_bytes()), message);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_and_reaps_the_child() {
        let dir = TempDir::new().unwrap();
        let (binary, _, pid_path) =
            make_fake_pandoc(&dir, REQUIRED_EXTENSIONS, b"", b"", 0, Some(30));
        capabilities_for(binary.to_str().unwrap(), TEST_PROCESS_TIMEOUT)
            .await
            .expect("capability setup should complete before testing conversion timeout");

        let error = styled_markdown_to_html_with_binary_and_timeout(
            "x",
            binary.to_str().unwrap(),
            Duration::from_millis(100),
        )
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(error, "pandoc_timeout");

        let pid = std::fs::read_to_string(pid_path).unwrap();
        let status = std::process::Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!status.success(), "timed-out child {pid} is still alive");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn descendant_retaining_pipes_is_terminated_and_bounded() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let extensions = dir.path().join("extensions.txt");
        let pid_file = dir.path().join("descendant.pid");
        let script = dir.path().join("fake-pandoc-descendant.sh");
        std::fs::write(&extensions, REQUIRED_EXTENSIONS).unwrap();
        let mut file = std::fs::File::create(&script).unwrap();
        writeln!(file, "#!/bin/sh").unwrap();
        writeln!(file, "if [ \"$1\" = '--list-extensions=markdown' ]; then").unwrap();
        writeln!(file, "  /bin/cat '{}'", extensions.display()).unwrap();
        writeln!(file, "  exit 0").unwrap();
        writeln!(file, "fi").unwrap();
        writeln!(file, "/bin/cat >/dev/null").unwrap();
        writeln!(file, "/bin/sleep 30 &").unwrap();
        writeln!(file, "printf '%s' \"$!\" > '{}'", pid_file.display()).unwrap();
        writeln!(file, "exit 0").unwrap();
        drop(file);
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();

        capabilities_for(script.to_str().unwrap(), TEST_PROCESS_TIMEOUT)
            .await
            .expect("capability setup should complete before testing descendant cleanup");

        let bounded = tokio::time::timeout(
            Duration::from_secs(5),
            styled_markdown_to_html_with_binary_and_timeout(
                "# hi",
                script.to_str().unwrap(),
                Duration::from_secs(1),
            ),
        )
        .await;
        let descendant = std::fs::read_to_string(&pid_file)
            .expect("fake Pandoc should record its descendant")
            .parse::<u32>()
            .unwrap();
        if bounded.is_err() {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-9", &descendant.to_string()])
                .status();
        }

        assert!(
            bounded.is_ok(),
            "styled-copy conversion escaped its lifecycle bound"
        );
        let status = std::process::Command::new("/bin/kill")
            .args(["-0", &descendant.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(
            !status.success(),
            "styled-copy descendant {descendant} survived"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn non_utf8_html_is_rejected_without_exposing_bytes() {
        let dir = TempDir::new().unwrap();
        let (binary, _, _) =
            make_fake_pandoc(&dir, REQUIRED_EXTENSIONS, &[0xff, 0xfe], b"", 0, None);
        let error = styled_markdown_to_html_with_binary_and_timeout(
            "x",
            binary.to_str().unwrap(),
            TEST_PROCESS_TIMEOUT,
        )
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(error, "pandoc_output_invalid_utf8");
    }

    #[tokio::test]
    async fn real_pandoc_preserves_semantic_math_mermaid_and_blocks_raw_content() {
        let Some((binary, _)) = pandoc::resolve_pandoc(None).await else {
            eprintln!("skipping: pandoc unavailable");
            return;
        };
        let markdown = "==重点== and $E=mc^2$\n\n```mermaid\ngraph TD; A-->B\n```\n\n<script>alert(1)</script>\n\n\\rawtex";
        let html = styled_markdown_to_html_with_binary_and_timeout(
            markdown,
            &binary,
            TEST_PROCESS_TIMEOUT,
        )
        .await
        .unwrap();

        assert!(html.contains("<mark>重点</mark>"), "{html}");
        assert!(html.contains("class=\"math inline\""), "{html}");
        assert!(html.contains("E=mc^2"), "{html}");
        assert!(html.contains("mermaid"), "{html}");
        assert!(html.contains("graph TD; A--&gt;B"), "{html}");
        assert!(!html.contains("<script"), "{html}");
    }
}
