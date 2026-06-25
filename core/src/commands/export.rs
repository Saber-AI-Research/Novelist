use crate::error::AppError;
use crate::services::pandoc;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::atomic::{AtomicU64, Ordering};

/// Per-process counter so concurrent exports never share a temp filename.
static EXPORT_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct PandocStatus {
    pub available: bool,
    pub version: Option<String>,
    /// Absolute path of the resolved binary, when found. Useful for
    /// the Settings UI to confirm what we're actually invoking.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    /// The user's saved override (mirrors `GlobalSettings.pandoc_path`)
    /// — surfaced so the Settings form can pre-fill the input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_path: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn check_pandoc() -> Result<PandocStatus, AppError> {
    let g = crate::commands::settings::read_global_settings().await;
    let resolved = pandoc::resolve_pandoc(g.pandoc_path.as_deref()).await;
    Ok(PandocStatus {
        available: resolved.is_some(),
        version: resolved.as_ref().map(|(_, v)| v.clone()),
        resolved_path: resolved.map(|(p, _)| p),
        override_path: g.pandoc_path,
    })
}

/// Persist the user's pandoc binary override. `None` clears it (revert
/// to auto-detection). Empty string is treated as `None`.
#[tauri::command]
#[specta::specta]
pub async fn set_pandoc_path(path: Option<String>) -> Result<(), AppError> {
    let mut g = crate::commands::settings::read_global_settings().await;
    g.pandoc_path = match path {
        Some(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    };
    crate::commands::settings::write_global_settings_to_disk(&g).await
}

#[tauri::command]
#[specta::specta]
pub async fn export_project(
    input_files: Vec<String>,
    output_path: String,
    format: String,
    extra_args: Vec<String>,
) -> Result<String, AppError> {
    let allowed_formats = ["html", "pdf", "docx", "epub"];
    if !allowed_formats.contains(&format.as_str()) {
        return Err(AppError::InvalidInput(format!(
            "Unsupported export format: {}. Allowed: {:?}",
            format, allowed_formats
        )));
    }

    for arg in &extra_args {
        let lower = arg.to_lowercase();
        if lower.starts_with("--output") || lower.starts_with("--extract-media") {
            return Err(AppError::InvalidInput(format!(
                "Forbidden argument in extra_args: {}",
                arg
            )));
        }
    }

    // Unique per-export temp name (pid + counter) so two windows exporting at
    // once don't read/delete each other's input or clobber a predictable path
    // in the shared temp dir.
    let temp_dir = std::env::temp_dir();
    let seq = EXPORT_SEQ.fetch_add(1, Ordering::Relaxed);
    let temp_input = temp_dir.join(format!(
        "novelist-export-{}-{}.md",
        std::process::id(),
        seq
    ));

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pandoc_status_serialize() {
        let status = PandocStatus {
            available: true,
            version: Some("pandoc 3.1".to_string()),
            resolved_path: Some("/usr/local/bin/pandoc".to_string()),
            override_path: None,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["available"], true);
        assert_eq!(json["version"], "pandoc 3.1");
    }

    #[test]
    fn test_pandoc_status_unavailable() {
        let status = PandocStatus {
            available: false,
            version: None,
            resolved_path: None,
            override_path: None,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["available"], false);
        assert!(json["version"].is_null());
    }

    #[tokio::test]
    async fn test_export_rejects_unsupported_format() {
        let result = export_project(
            vec![],
            "/tmp/out.xyz".to_string(),
            "xyz".to_string(),
            vec![],
        )
        .await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Unsupported export format"));
    }

    #[tokio::test]
    async fn test_export_rejects_forbidden_args() {
        let result = export_project(
            vec![],
            "/tmp/out.html".to_string(),
            "html".to_string(),
            vec!["--output=/tmp/evil".to_string()],
        )
        .await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Forbidden argument"));
    }

    #[tokio::test]
    async fn test_export_rejects_extract_media() {
        let result = export_project(
            vec![],
            "/tmp/out.html".to_string(),
            "html".to_string(),
            vec!["--extract-media=/tmp".to_string()],
        )
        .await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Forbidden argument"));
    }

    #[tokio::test]
    async fn test_export_allows_valid_formats() {
        for fmt in &["html", "pdf", "docx", "epub"] {
            // These will fail because input_files is empty or pandoc isn't available,
            // but they should NOT fail on format validation
            let result = export_project(
                vec!["/nonexistent/file.md".to_string()],
                "/tmp/out".to_string(),
                fmt.to_string(),
                vec![],
            )
            .await;
            if let Err(e) = &result {
                let msg = e.to_string();
                assert!(
                    !msg.contains("Unsupported export format"),
                    "format '{}' was incorrectly rejected",
                    fmt
                );
            }
        }
    }
}
