use crate::error::AppError;
use crate::services::pandoc;
use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet};
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex, OnceCell};

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

type CapabilityResult = Result<Arc<HashSet<String>>, String>;
static CAPABILITY_CACHE: Lazy<Mutex<HashMap<String, Arc<OnceCell<CapabilityResult>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

struct ProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

enum ProcessFailure {
    NotFound,
    Spawn,
    Wait,
    Write,
    Timeout,
    OutputOverflow,
}

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
    let supported = capabilities_for(binary, PANDOC_TIMEOUT).await?;
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
    let result = cell
        .get_or_init(|| async move { probe_capabilities(&binary, timeout).await })
        .await;
    result.clone().map_err(AppError::Custom)
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
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ProcessFailure::NotFound
        } else {
            ProcessFailure::Spawn
        }
    })?;

    let stdin_task = match (input, child.stdin.take()) {
        (Some(bytes), Some(mut stdin)) => {
            let bytes = bytes.to_vec();
            Some(tokio::spawn(async move {
                stdin
                    .write_all(&bytes)
                    .await
                    .map_err(|_| ProcessFailure::Write)?;
                stdin.shutdown().await.map_err(|_| ProcessFailure::Write)
            }))
        }
        _ => None,
    };

    let stdout = child.stdout.take().ok_or(ProcessFailure::Spawn)?;
    let stderr = child.stderr.take().ok_or(ProcessFailure::Spawn)?;
    let (overflow_tx, mut overflow_rx) = oneshot::channel();
    let stdout_task = tokio::spawn(drain_bounded(stdout, stdout_limit, Some(overflow_tx)));
    let stderr_task = tokio::spawn(drain_bounded(stderr, MAX_DIAGNOSTIC_BYTES, None));

    let (deadline_tx, deadline_cancel_rx) = std::sync::mpsc::channel();
    let (deadline_signal_tx, mut deadline_signal_rx) = oneshot::channel();
    let deadline_thread = std::thread::spawn(move || {
        if deadline_cancel_rx.recv_timeout(timeout)
            == Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        {
            let _ = deadline_signal_tx.send(());
        }
    });
    let mut overflow_channel_open = true;
    let mut deadline_channel_open = true;
    let wait_result = loop {
        tokio::select! {
            status = child.wait() => break status.map(Some).map_err(|_| ProcessFailure::Wait),
            overflow = &mut overflow_rx, if overflow_channel_open => {
                match overflow {
                    Ok(()) => break Err(ProcessFailure::OutputOverflow),
                    Err(_) => overflow_channel_open = false,
                }
            }
            deadline = &mut deadline_signal_rx, if deadline_channel_open => {
                match deadline {
                    Ok(()) => break Ok(None),
                    Err(_) => deadline_channel_open = false,
                }
            }
        }
    };
    let _ = deadline_tx.send(());
    let _ = deadline_thread.join();

    let status = match wait_result {
        Ok(Some(status)) => status,
        Ok(None) => {
            kill_and_reap(&mut child).await;
            await_input_task(stdin_task).await.ok();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(ProcessFailure::Timeout);
        }
        Err(failure) => {
            kill_and_reap(&mut child).await;
            await_input_task(stdin_task).await.ok();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(failure);
        }
    };

    let input_result = await_input_task(stdin_task).await;
    let stdout = stdout_task.await.map_err(|_| ProcessFailure::Wait)?;
    let stderr = stderr_task.await.map_err(|_| ProcessFailure::Wait)?;
    if stdout.len() > stdout_limit {
        return Err(ProcessFailure::OutputOverflow);
    }
    if status.success() {
        input_result?;
    }
    Ok(ProcessOutput {
        status,
        stdout,
        stderr,
    })
}

async fn await_input_task(
    task: Option<tokio::task::JoinHandle<Result<(), ProcessFailure>>>,
) -> Result<(), ProcessFailure> {
    match task {
        Some(task) => task.await.map_err(|_| ProcessFailure::Write)?,
        None => Ok(()),
    }
}

async fn kill_and_reap(child: &mut tokio::process::Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn drain_bounded<R>(
    mut reader: R,
    limit: usize,
    overflow: Option<oneshot::Sender<()>>,
) -> Vec<u8>
where
    R: AsyncRead + Unpin,
{
    let retain_limit = if overflow.is_some() {
        limit.saturating_add(1)
    } else {
        limit
    };
    let mut retained = Vec::with_capacity(retain_limit.min(64 * 1024));
    let mut overflow = overflow;
    let mut total = 0usize;
    let mut chunk = [0u8; 8192];
    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        total = total.saturating_add(read);
        let remaining = retain_limit.saturating_sub(retained.len());
        retained.extend_from_slice(&chunk[..read.min(remaining)]);
        if total > limit {
            if let Some(sender) = overflow.take() {
                let _ = sender.send(());
            }
        }
    }
    retained
}

fn bounded_diagnostic(bytes: &[u8]) -> String {
    let mut diagnostic = String::from_utf8_lossy(bytes).into_owned();
    if diagnostic.len() > MAX_DIAGNOSTIC_BYTES {
        let mut end = MAX_DIAGNOSTIC_BYTES;
        while !diagnostic.is_char_boundary(end) {
            end -= 1;
        }
        diagnostic.truncate(end);
    }
    diagnostic.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::time::Duration;
    use tempfile::TempDir;

    const REQUIRED_EXTENSIONS: &str = "+pipe_tables\n-footnotes\n+fenced_code_blocks\n-fenced_code_attributes\n+backtick_code_blocks\n-mark\n+tex_math_dollars\n+raw_attribute\n";

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
                Duration::from_secs(2),
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
    async fn raw_attribute_is_disabled_only_when_supported() {
        let dir = TempDir::new().unwrap();
        let extensions = REQUIRED_EXTENSIONS.replace("+raw_attribute\n", "");
        let (binary, argv_path, _) = make_fake_pandoc(&dir, &extensions, b"<p>x</p>", b"", 0, None);

        styled_markdown_to_html_with_binary_and_timeout(
            "x",
            binary.to_str().unwrap(),
            Duration::from_secs(2),
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
            Duration::from_secs(2),
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
            Duration::from_secs(5),
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
            Duration::from_secs(2),
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
    async fn timeout_kills_and_reaps_the_child() {
        let dir = TempDir::new().unwrap();
        let (binary, _, pid_path) =
            make_fake_pandoc(&dir, REQUIRED_EXTENSIONS, b"", b"", 0, Some(30));

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
            .status()
            .unwrap();
        assert!(!status.success(), "timed-out child {pid} is still alive");
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
            Duration::from_secs(2),
        )
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(error, "pandoc_output_invalid_utf8");
    }

    #[tokio::test]
    async fn real_pandoc_preserves_semantic_math_mermaid_and_blocks_raw_content() {
        if !Path::new("/opt/homebrew/bin/pandoc").exists()
            && std::process::Command::new("pandoc")
                .arg("--version")
                .output()
                .map(|output| !output.status.success())
                .unwrap_or(true)
        {
            eprintln!("skipping: pandoc unavailable");
            return;
        }
        let binary = if Path::new("/opt/homebrew/bin/pandoc").exists() {
            "/opt/homebrew/bin/pandoc"
        } else {
            "pandoc"
        };
        let markdown = "==重点== and $E=mc^2$\n\n```mermaid\ngraph TD; A-->B\n```\n\n<script>alert(1)</script>\n\n\\rawtex";
        let html = styled_markdown_to_html_with_binary_and_timeout(
            markdown,
            binary,
            Duration::from_secs(5),
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
