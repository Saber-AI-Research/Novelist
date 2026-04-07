use crate::error::AppError;
use crate::models::file_state::FileEntry;
use std::path::Path;

#[tauri::command]
#[specta::specta]
pub async fn read_file(path: String) -> Result<String, AppError> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(AppError::FileNotFound(path));
    }
    let content = tokio::fs::read_to_string(&path).await?;
    Ok(content)
}

#[tauri::command]
#[specta::specta]
pub async fn write_file(path: String, content: String) -> Result<(), AppError> {
    let temp_path = format!("{}.novelist-tmp", path);
    tokio::fs::write(&temp_path, &content).await?;
    tokio::fs::rename(&temp_path, &path).await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn list_directory(path: String) -> Result<Vec<FileEntry>, AppError> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(AppError::FileNotFound(path));
    }
    if !p.is_dir() {
        return Err(AppError::NotADirectory(path));
    }

    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&path).await?;

    while let Some(entry) = read_dir.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files/dirs, except .novelist
        if name.starts_with('.') && name != ".novelist" {
            continue;
        }

        let metadata = entry.metadata().await?;
        entries.push(FileEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }

    // Sort: directories first, then alphabetical by name
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_read_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("test.md");
        fs::write(&file_path, "# Hello\n\nWorld").unwrap();
        let content = read_file(file_path.to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(content, "# Hello\n\nWorld");
    }

    #[tokio::test]
    async fn test_read_file_not_found() {
        let result = read_file("/nonexistent/path.md".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_write_file_atomic() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("output.md");
        write_file(
            file_path.to_string_lossy().to_string(),
            "# New Content".to_string(),
        )
        .await
        .unwrap();
        let content = fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "# New Content");
        let temp_path = format!("{}.novelist-tmp", file_path.to_string_lossy());
        assert!(!std::path::Path::new(&temp_path).exists());
    }

    #[tokio::test]
    async fn test_list_directory() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("b.md"), "").unwrap();
        fs::write(dir.path().join("a.md"), "").unwrap();
        fs::create_dir(dir.path().join("chapters")).unwrap();
        fs::write(dir.path().join(".hidden"), "").unwrap();
        let entries = list_directory(dir.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "chapters");
        assert!(entries[0].is_dir);
        assert_eq!(entries[1].name, "a.md");
        assert_eq!(entries[2].name, "b.md");
    }
}
