use crate::error::AppError;
use crate::models::project::ProjectConfig;
use std::path::Path;

#[tauri::command]
#[specta::specta]
pub async fn detect_project(dir_path: String) -> Result<Option<ProjectConfig>, AppError> {
    let config_path = Path::new(&dir_path).join(".novelist").join("project.toml");

    if !config_path.exists() {
        return Ok(None);
    }

    let content = tokio::fs::read_to_string(&config_path).await?;
    let config: ProjectConfig = toml::from_str(&content)?;
    Ok(Some(config))
}

#[tauri::command]
#[specta::specta]
pub async fn read_project_config(dir_path: String) -> Result<ProjectConfig, AppError> {
    let config_path = Path::new(&dir_path).join(".novelist").join("project.toml");

    if !config_path.exists() {
        return Err(AppError::FileNotFound(
            config_path.to_string_lossy().to_string(),
        ));
    }

    let content = tokio::fs::read_to_string(&config_path).await?;
    let config: ProjectConfig = toml::from_str(&content)?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_detect_project_found() {
        let dir = TempDir::new().unwrap();
        let novelist_dir = dir.path().join(".novelist");
        fs::create_dir(&novelist_dir).unwrap();
        fs::write(
            novelist_dir.join("project.toml"),
            r#"
[project]
name = "Test Novel"
type = "novel"
version = "0.1.0"

[writing]
daily_goal = 1500
auto_save_minutes = 3
"#,
        )
        .unwrap();
        let config = detect_project(dir.path().to_string_lossy().to_string())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(config.project.name, "Test Novel");
        assert_eq!(config.writing.daily_goal, 1500);
    }

    #[tokio::test]
    async fn test_detect_project_not_found() {
        let dir = TempDir::new().unwrap();
        let result = detect_project(dir.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_config_defaults() {
        let dir = TempDir::new().unwrap();
        let novelist_dir = dir.path().join(".novelist");
        fs::create_dir(&novelist_dir).unwrap();
        fs::write(
            novelist_dir.join("project.toml"),
            r#"
[project]
name = "Minimal"
"#,
        )
        .unwrap();
        let config = read_project_config(dir.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(config.project.project_type, "novel");
        assert_eq!(config.writing.daily_goal, 2000);
        assert_eq!(config.writing.auto_save_minutes, 5);
        assert!(config.outline.order.is_empty());
    }
}
