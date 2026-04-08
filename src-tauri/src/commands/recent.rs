use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use std::time::SystemTime;

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened: String,
}

fn recent_projects_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("~"))
        .join(".novelist")
        .join("recent-projects.json")
}

#[tauri::command]
#[specta::specta]
pub async fn get_recent_projects() -> Result<Vec<RecentProject>, AppError> {
    let path = recent_projects_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let content = tokio::fs::read_to_string(&path).await?;
    let projects: Vec<RecentProject> = serde_json::from_str(&content).unwrap_or_default();
    Ok(projects)
}

#[tauri::command]
#[specta::specta]
pub async fn add_recent_project(path: String, name: String) -> Result<(), AppError> {
    let file_path = recent_projects_path();

    // Ensure ~/.novelist/ exists
    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    // Read existing
    let mut projects: Vec<RecentProject> = if file_path.exists() {
        let content = tokio::fs::read_to_string(&file_path).await?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    };

    // Remove if already exists (will re-add at top)
    projects.retain(|p| p.path != path);

    // Add at front
    let timestamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();

    projects.insert(
        0,
        RecentProject {
            path,
            name,
            last_opened: timestamp,
        },
    );

    // Keep max 20
    projects.truncate(20);

    // Write
    let json = serde_json::to_string_pretty(&projects)?;
    tokio::fs::write(&file_path, json).await?;

    Ok(())
}
