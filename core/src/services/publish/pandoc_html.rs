//! Markdown → HTML helper for publish adapters that need HTML
//! (Ghost, WordPress self-hosted, WordPress.com).
//!
//! Uses the system Pandoc binary (we do NOT bundle Pandoc — bundle
//! size matters). The binary is resolved by
//! `services::pandoc::resolve_with_settings`, which honors the user's
//! `pandoc_path` override from settings, then probes `$PATH`, then
//! common install locations.
//!
//! On a system without Pandoc the error message points the user to
//! the install page so they can either run `brew install pandoc` /
//! download an installer, or set the binary path in Settings.

use crate::services::pandoc;
use crate::services::publish::types::PublishError;

const INSTALL_HINT: &str =
    "Pandoc not found on PATH. Install from https://pandoc.org/installing.html (e.g. `brew install pandoc` on macOS) or set the binary path in Settings → Editor → Pandoc.";
const MAX_HTML_BYTES: usize = 20 * 1024 * 1024;
const MAX_MARKDOWN_BYTES: usize = 10 * 1024 * 1024;

/// Convert Markdown to HTML via the resolved Pandoc binary.
pub async fn markdown_to_html(md: &str) -> Result<String, PublishError> {
    let (binary, _version) = pandoc::resolve_with_settings()
        .await
        .ok_or_else(|| PublishError::PandocFailed(INSTALL_HINT.to_string()))?;
    markdown_to_html_with_binary(md, &binary).await
}

pub async fn markdown_to_html_with_binary(md: &str, binary: &str) -> Result<String, PublishError> {
    if md.len() > MAX_MARKDOWN_BYTES {
        return Err(PublishError::PandocFailed(
            "Pandoc Markdown input exceeded the 10 MiB limit.".to_string(),
        ));
    }
    let output = pandoc::run_piped_pandoc(
        binary,
        &[
            "-f",
            "markdown-yaml_metadata_block-raw_html-raw_tex-raw_attribute",
            "-t",
            "html",
        ],
        Some(md.as_bytes()),
        MAX_HTML_BYTES,
        pandoc::STDERR_BUDGET.saturating_add(1),
        pandoc::DEFAULT_PANDOC_TIMEOUT,
    )
    .await
    .map_err(|failure| match failure {
        pandoc::PipedPandocFailure::NotFound => PublishError::PandocFailed(INSTALL_HINT.to_string()),
        pandoc::PipedPandocFailure::Timeout => PublishError::PandocFailed(format!(
            "Pandoc exceeded the {} second timeout.",
            pandoc::DEFAULT_PANDOC_TIMEOUT.as_secs()
        )),
        pandoc::PipedPandocFailure::OutputOverflow => {
            PublishError::PandocFailed("Pandoc HTML output exceeded the size limit.".to_string())
        }
        pandoc::PipedPandocFailure::RetainedPipes => PublishError::PandocFailed(
            "Pandoc exited but a descendant retained its output pipes; the process tree was terminated."
                .to_string(),
        ),
        pandoc::PipedPandocFailure::Write => {
            PublishError::PandocFailed("write Pandoc input failed".to_string())
        }
        pandoc::PipedPandocFailure::Spawn => {
            PublishError::PandocFailed("spawn pandoc failed".to_string())
        }
        pandoc::PipedPandocFailure::Wait => {
            PublishError::PandocFailed("wait pandoc failed".to_string())
        }
    })?;

    if let Some(warning) = output.cleanup_warning.as_ref() {
        tracing::warn!(target: "novelist::publish", stage = warning.stage.tag(), message = %warning.message, "Pandoc cleanup warning");
    }

    if !output.status.success() {
        let failure = pandoc::PandocFailure::new(
            pandoc::PandocStage::ExitNonZero,
            "Pandoc exited with a non-zero status.",
        )
        .with_binary(binary.to_string())
        .with_format("html")
        .with_exit_code(output.status.code())
        .with_stderr(&output.stderr);
        return Err(PublishError::PandocFailed(failure.to_string()));
    }

    let html = String::from_utf8(output.stdout).map_err(|e| {
        let failure = pandoc::PandocFailure::new(
            pandoc::PandocStage::OutputDecode,
            format!("Pandoc produced non-UTF-8 stdout: {e}"),
        )
        .with_binary(binary.to_string())
        .with_format("html");
        PublishError::PandocFailed(failure.to_string())
    })?;
    Ok(ammonia::clean(&html))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::io::Write;
    #[cfg(unix)]
    use std::process::Stdio;
    #[cfg(unix)]
    use tempfile::TempDir;

    const STYLED_COPY_REAL_PANDOC_FIXTURE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/styled-copy/canonical.md"
    ));

    async fn resolved_pandoc() -> Option<String> {
        pandoc::resolve_pandoc(None).await.map(|(binary, _)| binary)
    }

    #[tokio::test]
    async fn paragraph_converts_to_p_tag() {
        let Some(binary) = resolved_pandoc().await else {
            eprintln!("skipping: pandoc not installed");
            return;
        };
        let html = markdown_to_html_with_binary("hello world", &binary)
            .await
            .unwrap();
        assert!(html.contains("<p>hello world</p>"), "got: {html}");
    }

    #[tokio::test]
    async fn heading_converts() {
        let Some(binary) = resolved_pandoc().await else {
            return;
        };
        let html = markdown_to_html_with_binary("# Title\n\nbody", &binary)
            .await
            .unwrap();
        assert!(
            html.contains("<h1") && html.contains("Title"),
            "got: {html}"
        );
    }

    #[tokio::test]
    async fn cjk_paragraph_is_preserved() {
        let Some(binary) = resolved_pandoc().await else {
            return;
        };
        let html = markdown_to_html_with_binary("中文段落，混合 English。", &binary)
            .await
            .unwrap();
        assert!(html.contains("中文段落"), "got: {html}");
    }

    #[test]
    fn publish_html_sanitizer_removes_scripts_events_and_javascript_urls() {
        let sanitized = ammonia::clean(
            r#"<script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">x</a>"#,
        );
        assert!(!sanitized.contains("<script"));
        assert!(!sanitized.contains("onerror"));
        assert!(!sanitized.contains("javascript:"));
    }

    #[tokio::test]
    #[ignore = "requires the pinned real Pandoc used by test:rust:pandoc"]
    async fn real_pandoc_publish_blocks_active_raw_content() {
        let Some(binary) = resolved_pandoc().await else {
            panic!("the explicit real-Pandoc matrix requires Pandoc 3.10");
        };
        let markdown = r#"---
header-includes: '<script>alert(1)</script>'
---
<script>alert(2)</script>
<img src="x" onerror="alert(3)">
[unsafe](javascript:alert(4))
"#;

        let html = markdown_to_html_with_binary(markdown, &binary)
            .await
            .unwrap();

        assert!(!html.contains("<script"));
        assert!(!html.contains("<img"));
        assert!(!html.contains("href=\"javascript:"));
    }

    #[tokio::test]
    async fn missing_binary_surfaces_install_hint() {
        let err = markdown_to_html_with_binary("x", "pandoc-nonexistent-binary-xxxxx")
            .await
            .unwrap_err();
        let PublishError::PandocFailed(msg) = err else {
            panic!("expected PandocFailed");
        };
        assert!(
            msg.contains("Install") || msg.contains("https://pandoc.org"),
            "missing install hint: {msg}"
        );
    }

    #[tokio::test]
    async fn oversized_markdown_is_rejected_before_spawn() {
        let markdown = "x".repeat(MAX_MARKDOWN_BYTES + 1);
        let error = markdown_to_html_with_binary(&markdown, "/binary/must/not/run")
            .await
            .expect_err("oversized input must be rejected before spawn");
        let PublishError::PandocFailed(message) = error else {
            panic!("expected PandocFailed");
        };
        assert!(message.contains("10 MiB"), "{message}");
    }

    #[cfg(unix)]
    fn make_non_utf8_stdout_pandoc(dir: &TempDir) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let payload = dir.path().join("non-utf8.stdout");
        std::fs::write(&payload, [0xff, 0xfe]).unwrap();
        let script = dir.path().join("fake-pandoc-non-utf8.sh");
        let mut f = std::fs::File::create(&script).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        let payload_str = payload.to_string_lossy();
        assert!(!payload_str.contains('\''));
        writeln!(f, "/bin/cat '{payload_str}'").unwrap();
        writeln!(f, "exit 0").unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        script
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn non_utf8_stdout_reports_output_decode_without_output_bytes() {
        let dir = TempDir::new().unwrap();
        let fake = make_non_utf8_stdout_pandoc(&dir);
        let err = markdown_to_html_with_binary("# hi", fake.to_str().unwrap())
            .await
            .unwrap_err();
        let PublishError::PandocFailed(msg) = err else {
            panic!("expected PandocFailed");
        };
        assert!(msg.contains("output_decode"), "{msg}");
        assert!(
            !msg.contains("\u{fffd}"),
            "must not render lossy output bytes: {msg}"
        );
        assert!(
            !msg.contains("stdout: ff"),
            "must not expose raw stdout bytes: {msg}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn descendant_retaining_pipes_is_terminated_and_bounded() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let pid_file = dir.path().join("descendant.pid");
        let script = dir.path().join("fake-pandoc-descendant.sh");
        let mut file = std::fs::File::create(&script).unwrap();
        writeln!(file, "#!/bin/sh").unwrap();
        writeln!(file, "/bin/sleep 30 &").unwrap();
        writeln!(file, "printf '%s' \"$!\" > '{}'", pid_file.display()).unwrap();
        writeln!(file, "exit 0").unwrap();
        drop(file);
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();

        let bounded = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            markdown_to_html_with_binary("# hi", script.to_str().unwrap()),
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
            "publish conversion escaped its lifecycle bound"
        );
        assert!(
            !process_is_alive(descendant),
            "publish Pandoc descendant {descendant} survived"
        );
    }

    #[cfg(unix)]
    fn process_is_alive(pid: u32) -> bool {
        std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[tokio::test]
    #[ignore = "requires the pinned real Pandoc used by test:rust:pandoc"]
    async fn styled_copy_real_pandoc_matrix() {
        static PORTABLE_INIT: std::sync::Once = std::sync::Once::new();
        PORTABLE_INIT.call_once(crate::services::portable::init);
        let html = crate::services::publish::styled_copy_pandoc::styled_markdown_to_html(
            STYLED_COPY_REAL_PANDOC_FIXTURE,
        )
        .await
        .expect("the explicit real-Pandoc matrix requires Pandoc and every styled-copy extension");

        assert!(html.contains("<table>"), "table missing:\n{html}");
        assert!(html.contains("第一章"), "CJK table cell missing:\n{html}");
        assert!(
            html.contains("sourceCode typescript") && html.contains("class=\"kw\""),
            "known TypeScript code was not tokenized:\n{html}"
        );
        let unknown_marker = html
            .find("UNKNOWN_PLAIN_CJK_42")
            .expect("unknown-language code marker missing");
        let unknown_start = html[..unknown_marker]
            .rfind("<pre")
            .expect("unknown-language pre block missing");
        let unknown_end = html[unknown_marker..]
            .find("</pre>")
            .map(|offset| unknown_marker + offset)
            .expect("unknown-language pre block was not closed");
        assert!(
            !html[unknown_start..unknown_end].contains("<span"),
            "unknown-language code must remain plaintext:\n{}",
            &html[unknown_start..unknown_end]
        );
        assert!(
            html.contains("role=\"doc-noteref\"")
                && html.contains("role=\"doc-endnotes\"")
                && html.contains("CJK_FOOTNOTE_STATIC"),
            "static footnote source missing:\n{html}"
        );
        assert!(
            html.contains("<mark>重点标记 CJK_MARK</mark>"),
            "mark output missing:\n{html}"
        );
        assert!(
            html.contains("class=\"math inline\"") && html.contains("\\(E=mc^2\\)"),
            "inline TeX source missing:\n{html}"
        );
        assert!(
            html.contains("class=\"math display\"") && html.contains("\\int_0^1 x^2\\,dx"),
            "display TeX source missing:\n{html}"
        );
        assert!(
            html.contains("mermaid")
                && html.contains("graph TD")
                && html.contains("起点 --&gt; 终点"),
            "Mermaid fenced source missing:\n{html}"
        );
    }
}
