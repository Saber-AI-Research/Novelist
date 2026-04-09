use crate::error::AppError;
use std::path::Path;
use tokio::process::Command;

/// Check if pandoc is available on the system
pub async fn detect_pandoc() -> Option<String> {
    let output = Command::new("pandoc")
        .arg("--version")
        .output()
        .await
        .ok()?;
    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout);
        let first_line = version.lines().next().unwrap_or("pandoc").to_string();
        Some(first_line)
    } else {
        None
    }
}

/// Run pandoc export
pub async fn run_pandoc(
    input_path: &Path,
    output_path: &Path,
    format: &str,
    extra_args: &[String],
) -> Result<String, AppError> {
    let mut cmd = Command::new("pandoc");
    cmd.arg(input_path);
    cmd.arg("-o").arg(output_path);

    match format {
        "html" => {
            cmd.arg("-t").arg("html5").arg("--standalone");
        }
        "pdf" => { /* pandoc auto-detects PDF engine */ }
        "docx" => {
            cmd.arg("-t").arg("docx");
        }
        "epub" => {
            cmd.arg("-t").arg("epub");
        }
        _ => {
            cmd.arg("-t").arg(format);
        }
    }

    for arg in extra_args {
        cmd.arg(arg);
    }

    let output = cmd.output().await?;

    if output.status.success() {
        Ok(format!("Export complete: {}", output_path.display()))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(AppError::Custom(format!("Pandoc error: {}", stderr)))
    }
}
