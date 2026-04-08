use crate::error::AppError;
use crate::services::pandoc;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct PandocStatus {
    pub available: bool,
    pub version: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn check_pandoc() -> Result<PandocStatus, AppError> {
    let version = pandoc::detect_pandoc().await;
    Ok(PandocStatus {
        available: version.is_some(),
        version,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn export_project(
    input_files: Vec<String>, // ordered list of .md file paths
    output_path: String,      // output file path (e.g., /tmp/novel.pdf)
    format: String,           // "html", "pdf", "docx", "epub"
    extra_args: Vec<String>,  // additional pandoc arguments
) -> Result<String, AppError> {
    // Concatenate input files into a temp file
    let temp_dir = std::env::temp_dir();
    let temp_input = temp_dir.join("novelist-export-input.md");

    let mut combined = String::new();
    for path in &input_files {
        let content = tokio::fs::read_to_string(path).await?;
        combined.push_str(&content);
        combined.push_str("\n\n");
    }
    tokio::fs::write(&temp_input, &combined).await?;

    // Run pandoc
    let result = pandoc::run_pandoc(
        &temp_input,
        std::path::Path::new(&output_path),
        &format,
        &extra_args,
    )
    .await;

    // Cleanup temp file
    let _ = tokio::fs::remove_file(&temp_input).await;

    result
}
