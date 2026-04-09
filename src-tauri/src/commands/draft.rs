use crate::error::AppError;
use std::path::Path;

/// Get the draft note path for a given file.
/// Draft notes are stored in `.novelist/drafts/{filename}.draft.md`
/// relative to the project root.
fn draft_path(project_dir: &str, file_path: &str) -> Result<std::path::PathBuf, AppError> {
    let file_name = Path::new(file_path)
        .file_name()
        .ok_or_else(|| AppError::Custom("Cannot get file name".to_string()))?
        .to_string_lossy()
        .to_string();

    let draft_dir = Path::new(project_dir).join(".novelist").join("drafts");
    Ok(draft_dir.join(format!("{}.draft.md", file_name)))
}

#[tauri::command]
#[specta::specta]
pub async fn read_draft_note(
    project_dir: String,
    file_path: String,
) -> Result<Option<String>, AppError> {
    let path = draft_path(&project_dir, &file_path)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = tokio::fs::read_to_string(&path).await?;
    Ok(Some(content))
}

#[tauri::command]
#[specta::specta]
pub async fn write_draft_note(
    project_dir: String,
    file_path: String,
    content: String,
) -> Result<(), AppError> {
    let path = draft_path(&project_dir, &file_path)?;

    // Ensure .novelist/drafts/ directory exists
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    // Atomic write
    let temp_path = format!("{}.novelist-tmp", path.display());
    tokio::fs::write(&temp_path, &content).await?;
    tokio::fs::rename(&temp_path, &path).await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_draft_note(project_dir: String, file_path: String) -> Result<(), AppError> {
    let path = draft_path(&project_dir, &file_path)?;
    if path.exists() {
        tokio::fs::remove_file(&path).await?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn has_draft_note(project_dir: String, file_path: String) -> Result<bool, AppError> {
    let path = draft_path(&project_dir, &file_path)?;
    Ok(path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_draft_path() {
        let p = draft_path("/home/user/novel", "/home/user/novel/chapter1.md").unwrap();
        assert_eq!(
            p,
            Path::new("/home/user/novel/.novelist/drafts/chapter1.md.draft.md")
        );
    }

    #[test]
    fn test_draft_path_nested_file() {
        let p = draft_path("/project", "/project/chapters/ch1.md").unwrap();
        assert_eq!(p, Path::new("/project/.novelist/drafts/ch1.md.draft.md"));
    }

    #[tokio::test]
    async fn test_read_draft_not_found() {
        let dir = TempDir::new().unwrap();
        let result = read_draft_note(
            dir.path().to_string_lossy().to_string(),
            dir.path().join("test.md").to_string_lossy().to_string(),
        )
        .await
        .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_write_and_read_draft() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("chapter1.md").to_string_lossy().to_string();

        write_draft_note(
            project.clone(),
            file.clone(),
            "Draft notes here".to_string(),
        )
        .await
        .unwrap();

        let content = read_draft_note(project, file).await.unwrap();
        assert_eq!(content, Some("Draft notes here".to_string()));
    }

    #[tokio::test]
    async fn test_has_draft_note() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("test.md").to_string_lossy().to_string();

        assert!(!has_draft_note(project.clone(), file.clone()).await.unwrap());

        write_draft_note(project.clone(), file.clone(), "notes".to_string())
            .await
            .unwrap();

        assert!(has_draft_note(project, file).await.unwrap());
    }

    #[tokio::test]
    async fn test_delete_draft_note() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("test.md").to_string_lossy().to_string();

        write_draft_note(project.clone(), file.clone(), "notes".to_string())
            .await
            .unwrap();
        assert!(has_draft_note(project.clone(), file.clone()).await.unwrap());

        delete_draft_note(project.clone(), file.clone())
            .await
            .unwrap();
        assert!(!has_draft_note(project, file).await.unwrap());
    }

    #[tokio::test]
    async fn test_delete_draft_nonexistent() {
        let dir = TempDir::new().unwrap();
        // Should not error when deleting non-existent draft
        delete_draft_note(
            dir.path().to_string_lossy().to_string(),
            dir.path().join("nope.md").to_string_lossy().to_string(),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn test_write_draft_creates_dirs() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("test.md").to_string_lossy().to_string();

        // .novelist/drafts/ doesn't exist yet
        assert!(!dir.path().join(".novelist").exists());

        write_draft_note(project, file, "content".to_string())
            .await
            .unwrap();

        assert!(dir.path().join(".novelist").join("drafts").exists());
    }
}
