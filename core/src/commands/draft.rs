use crate::error::AppError;
use crate::services::rename_migration::{
    acquire_draft_transaction_guard, draft_sidecar_exists, draft_storage_key_has_live_owner,
    ensure_draft_key_not_reserved, reconcile_draft_sidecar,
};
use crate::services::sidecar::{
    atomic_write_bytes_confined, document_key, file_exists_confined, legacy_sidecar_path,
    open_confined_metadata_dir, read_bytes_confined, remove_file_confined, sidecar_path,
    MAX_DRAFT_NOTE_BYTES,
};
use std::path::{Path, PathBuf};

const DRAFT_SUBDIR: &str = "drafts";
const DRAFT_SUFFIX: &str = ".draft.md";
const RECOVERY_SUFFIX: &str = ".~recovery";

/// Get the draft note path for a given file.
/// Draft notes are stored in `.novelist/drafts/{relative_key}.draft.md`
/// relative to the project root using the shared canonical document key.
/// Absolute scratch files outside the project retain the legacy basename
/// fallback used by single-file callers.
struct DraftLocation {
    path: PathBuf,
    project_scoped: bool,
    storage_key: String,
}

fn draft_location(project_dir: &str, file_path: &str) -> Result<DraftLocation, AppError> {
    let project = Path::new(project_dir);
    let file = Path::new(file_path);
    match document_key(project, file) {
        Ok(key) => Ok(DraftLocation {
            path: sidecar_path(project, DRAFT_SUBDIR, &key, DRAFT_SUFFIX)?,
            project_scoped: true,
            storage_key: key,
        }),
        Err(AppError::PathNotAllowed(_)) if file.is_absolute() => {
            let basename = file.file_name().ok_or_else(|| {
                AppError::InvalidInput(format!(
                    "Cannot determine scratch-file basename: {}",
                    file.display()
                ))
            })?;
            let key = basename.to_string_lossy();
            if project.is_dir() && draft_storage_key_has_live_owner(project, None, &key)? {
                return Err(AppError::InvalidInput(format!(
                    "Scratch draft basename conflicts with a project document: {}",
                    basename.to_string_lossy()
                )));
            }
            let path = legacy_sidecar_path(project, DRAFT_SUBDIR, &key, DRAFT_SUFFIX)?.ok_or_else(
                || {
                    AppError::InvalidInput(format!(
                        "Scratch draft basename is too long: {}",
                        basename.to_string_lossy()
                    ))
                },
            )?;
            Ok(DraftLocation {
                path,
                project_scoped: false,
                storage_key: key.into_owned(),
            })
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
fn draft_path(project_dir: &str, file_path: &str) -> Result<PathBuf, AppError> {
    Ok(draft_location(project_dir, file_path)?.path)
}

async fn prepared_draft_path(project_dir: &str, file_path: &str) -> Result<PathBuf, AppError> {
    let location = draft_location(project_dir, file_path)?;
    let project = Path::new(project_dir);
    let file = Path::new(file_path);
    ensure_draft_key_not_reserved(project, file, &location.storage_key).await?;
    if location.project_scoped && draft_owner_path(file_path).is_file() {
        reconcile_draft_sidecar(project, file).await?;
    }
    Ok(location.path)
}

fn draft_file_name(path: &Path) -> Result<String, AppError> {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| {
            AppError::InvalidInput(format!("Draft path has no filename: {}", path.display()))
        })
}

fn ensure_project_draft_owner_exists(project_dir: &str, file_path: &str) -> Result<(), AppError> {
    let project = Path::new(project_dir);
    let file = Path::new(file_path);
    if document_key(project, file).is_err() {
        return Ok(());
    }
    let owner = draft_owner_path(file_path);
    if !owner.is_file() {
        return Err(AppError::FileNotFound(owner.display().to_string()));
    }
    Ok(())
}

fn draft_owner_path(file_path: &str) -> PathBuf {
    let normalized = file_path.replace('\\', "/");
    PathBuf::from(
        normalized
            .strip_suffix(RECOVERY_SUFFIX)
            .unwrap_or(&normalized),
    )
}

fn project_scoped_owner_missing(project_dir: &str, file_path: &str) -> bool {
    document_key(Path::new(project_dir), Path::new(file_path)).is_ok()
        && !draft_owner_path(file_path).is_file()
}

async fn ensure_missing_owner_not_reserved(
    project_dir: &str,
    file_path: &str,
) -> Result<(), AppError> {
    let project = Path::new(project_dir);
    let file = Path::new(file_path);
    if let Ok(key) = document_key(project, file) {
        ensure_draft_key_not_reserved(project, file, &key).await?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn read_draft_note(
    project_dir: String,
    file_path: String,
) -> Result<Option<String>, AppError> {
    let _guard = acquire_draft_transaction_guard(Path::new(&project_dir)).await?;
    if project_scoped_owner_missing(&project_dir, &file_path) {
        ensure_missing_owner_not_reserved(&project_dir, &file_path).await?;
        return Ok(None);
    }
    let path = prepared_draft_path(&project_dir, &file_path).await?;
    let Some(storage) = open_confined_metadata_dir(Path::new(&project_dir), DRAFT_SUBDIR, false)?
    else {
        return Ok(None);
    };
    let Some(bytes) =
        read_bytes_confined(&storage, &draft_file_name(&path)?, MAX_DRAFT_NOTE_BYTES).await?
    else {
        return Ok(None);
    };
    let content = String::from_utf8(bytes).map_err(|error| {
        AppError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    })?;
    Ok(Some(content))
}

#[tauri::command]
#[specta::specta]
pub async fn write_draft_note(
    project_dir: String,
    file_path: String,
    content: String,
) -> Result<(), AppError> {
    if content.len() > MAX_DRAFT_NOTE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "Draft note is {} bytes; limit is {}",
            content.len(),
            MAX_DRAFT_NOTE_BYTES
        )));
    }
    let _guard = acquire_draft_transaction_guard(Path::new(&project_dir)).await?;
    ensure_project_draft_owner_exists(&project_dir, &file_path)?;
    let path = prepared_draft_path(&project_dir, &file_path).await?;
    let storage = open_confined_metadata_dir(Path::new(&project_dir), DRAFT_SUBDIR, true)?
        .expect("create=true always returns a metadata directory");
    atomic_write_bytes_confined(&storage, &draft_file_name(&path)?, content.as_bytes()).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_draft_note(project_dir: String, file_path: String) -> Result<(), AppError> {
    let _guard = acquire_draft_transaction_guard(Path::new(&project_dir)).await?;
    if project_scoped_owner_missing(&project_dir, &file_path) {
        ensure_missing_owner_not_reserved(&project_dir, &file_path).await?;
        return Ok(());
    }
    let path = prepared_draft_path(&project_dir, &file_path).await?;
    let Some(storage) = open_confined_metadata_dir(Path::new(&project_dir), DRAFT_SUBDIR, false)?
    else {
        return Ok(());
    };
    remove_file_confined(&storage, &draft_file_name(&path)?).await
}

#[tauri::command]
#[specta::specta]
pub async fn has_draft_note(project_dir: String, file_path: String) -> Result<bool, AppError> {
    let _guard = acquire_draft_transaction_guard(Path::new(&project_dir)).await?;
    if project_scoped_owner_missing(&project_dir, &file_path) {
        ensure_missing_owner_not_reserved(&project_dir, &file_path).await?;
        return Ok(false);
    }
    let project = Path::new(&project_dir);
    let file = Path::new(&file_path);
    let location = draft_location(&project_dir, &file_path)?;
    ensure_draft_key_not_reserved(project, file, &location.storage_key).await?;
    if location.project_scoped {
        return draft_sidecar_exists(project, file).await;
    }
    let Some(storage) = open_confined_metadata_dir(project, DRAFT_SUBDIR, false)? else {
        return Ok(false);
    };
    file_exists_confined(&storage, &draft_file_name(&location.path)?).await
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::rename_migration::{
        direct_mapping, migrate_rename_sidecars, write_rename_journal, RenameMigrationStatus,
    };
    use crate::services::sidecar::{document_key, set_confined_remove_failure_after, sidecar_path};
    use std::fs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn canonical_draft(project: &Path, file: &Path) -> PathBuf {
        let key = document_key(project, file).unwrap();
        sidecar_path(project, "drafts", &key, ".draft.md").unwrap()
    }

    fn legacy_draft(project: &Path, file: &Path) -> PathBuf {
        let key = file
            .strip_prefix(project)
            .unwrap()
            .to_string_lossy()
            .replace(['/', '\\'], "__");
        project
            .join(".novelist/drafts")
            .join(format!("{key}.draft.md"))
    }

    fn write_fixture(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn set_modified(path: &Path, modified: std::time::SystemTime) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }

    fn active_drafts(project: &Path) -> Vec<PathBuf> {
        let draft_dir = project.join(".novelist/drafts");
        if !draft_dir.exists() {
            return Vec::new();
        }
        fs::read_dir(draft_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                let name = path.file_name().unwrap().to_string_lossy();
                name.ends_with(".draft.md") && !name.contains(".conflict-")
            })
            .collect()
    }

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
        assert_eq!(
            p,
            Path::new("/project/.novelist/drafts/chapters%2Fch1.md.draft.md")
        );
    }

    #[test]
    fn test_draft_path_outside_project() {
        // Files outside the project fall back to file name only
        let p = draft_path("/project", "/other/path/scratch.md").unwrap();
        assert_eq!(
            p,
            Path::new("/project/.novelist/drafts/scratch.md.draft.md")
        );
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
        fs::write(&file, "# Chapter").unwrap();

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
    async fn nested_cjk_write_uses_canonical_key_and_remains_readable() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("chapters/第一章.md");
        write_fixture(&file, "# 第一章");

        write_draft_note(
            project.display().to_string(),
            file.display().to_string(),
            "人物动机".to_string(),
        )
        .await
        .unwrap();

        assert_eq!(
            read_draft_note(project.display().to_string(), file.display().to_string())
                .await
                .unwrap(),
            Some("人物动机".to_string())
        );
        assert!(canonical_draft(project, &file).exists());
        assert!(!legacy_draft(project, &file).exists());
    }

    #[tokio::test]
    async fn hidden_root_document_round_trips_through_canonical_key() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join(".hidden.md");
        write_fixture(&file, "# Hidden");

        write_draft_note(
            project.display().to_string(),
            file.display().to_string(),
            "hidden note".to_string(),
        )
        .await
        .unwrap();

        assert_eq!(
            read_draft_note(project.display().to_string(), file.display().to_string())
                .await
                .unwrap(),
            Some("hidden note".to_string())
        );
        assert!(canonical_draft(project, &file).exists());
    }

    #[tokio::test]
    async fn same_basename_in_sibling_directories_never_collides() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let first = project.join("第一卷/第一章.md");
        let second = project.join("第二卷/第一章.md");
        write_fixture(&first, "# 第一卷");
        write_fixture(&second, "# 第二卷");

        write_draft_note(
            project.display().to_string(),
            first.display().to_string(),
            "第一卷笔记".to_string(),
        )
        .await
        .unwrap();
        write_draft_note(
            project.display().to_string(),
            second.display().to_string(),
            "第二卷笔记".to_string(),
        )
        .await
        .unwrap();

        assert_ne!(
            canonical_draft(project, &first),
            canonical_draft(project, &second)
        );
        assert_eq!(
            read_draft_note(project.display().to_string(), first.display().to_string())
                .await
                .unwrap(),
            Some("第一卷笔记".to_string())
        );
        assert_eq!(
            read_draft_note(project.display().to_string(), second.display().to_string())
                .await
                .unwrap(),
            Some("第二卷笔记".to_string())
        );
        assert_eq!(active_drafts(project).len(), 2);
    }

    #[tokio::test]
    async fn slash_and_backslash_paths_resolve_to_one_draft() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("chapters/第一章.md");
        let backslash_path = file.display().to_string().replace('/', "\\");
        write_fixture(&file, "# 第一章");

        write_draft_note(
            project.display().to_string(),
            file.display().to_string(),
            "separator-safe".to_string(),
        )
        .await
        .unwrap();

        assert_eq!(
            read_draft_note(project.display().to_string(), backslash_path)
                .await
                .unwrap(),
            Some("separator-safe".to_string())
        );
        assert_eq!(
            active_drafts(project),
            vec![canonical_draft(project, &file)]
        );
    }

    #[tokio::test]
    async fn legacy_flattened_entry_is_migrated_by_ordinary_commands() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("chapters/第一章.md");
        let legacy = legacy_draft(project, &file);
        write_fixture(&file, "# 第一章");
        write_fixture(&legacy, "legacy note");

        assert!(
            has_draft_note(project.display().to_string(), file.display().to_string())
                .await
                .unwrap()
        );
        assert!(
            legacy.exists(),
            "existence checks must not migrate or read legacy draft contents"
        );
        assert!(!canonical_draft(project, &file).exists());

        assert_eq!(
            read_draft_note(project.display().to_string(), file.display().to_string())
                .await
                .unwrap(),
            Some("legacy note".to_string())
        );
        assert!(!legacy.exists());
        assert_eq!(
            active_drafts(project),
            vec![canonical_draft(project, &file)]
        );

        delete_draft_note(project.display().to_string(), file.display().to_string())
            .await
            .unwrap();
        assert!(active_drafts(project).is_empty());
    }

    #[tokio::test]
    async fn ownerless_legacy_entry_is_not_claimed_by_missing_document_operations() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let missing = project.join("orphan/missing.md");
        let legacy = legacy_draft(project, &missing);
        write_fixture(&legacy, "ownerless note");

        assert_eq!(
            read_draft_note(project.display().to_string(), missing.display().to_string())
                .await
                .unwrap(),
            None
        );
        assert!(
            !has_draft_note(project.display().to_string(), missing.display().to_string())
                .await
                .unwrap()
        );
        delete_draft_note(project.display().to_string(), missing.display().to_string())
            .await
            .unwrap();
        assert!(legacy.exists());
        assert_eq!(fs::read_to_string(legacy).unwrap(), "ownerless note");
        assert!(!canonical_draft(project, &missing).exists());
    }

    #[tokio::test]
    async fn missing_literal_owner_cannot_access_colliding_ownerless_legacy_keys() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let nested = project.join("a/b.md");
        let missing_literal = project.join("a__b.md");
        let missing_recovery = PathBuf::from(format!("{}.~recovery", missing_literal.display()));
        let legacy = legacy_draft(project, &nested);
        let nested_recovery = PathBuf::from(format!("{}.~recovery", nested.display()));
        let legacy_recovery = legacy_draft(project, &nested_recovery);
        assert_eq!(legacy, canonical_draft(project, &missing_literal));
        assert_eq!(legacy_recovery, canonical_draft(project, &missing_recovery));
        write_fixture(&legacy, "ownerless normal");
        write_fixture(&legacy_recovery, "ownerless recovery");

        for missing in [&missing_literal, &missing_recovery] {
            assert_eq!(
                read_draft_note(project.display().to_string(), missing.display().to_string())
                    .await
                    .unwrap(),
                None
            );
            assert!(
                !has_draft_note(project.display().to_string(), missing.display().to_string())
                    .await
                    .unwrap()
            );
            delete_draft_note(project.display().to_string(), missing.display().to_string())
                .await
                .unwrap();
        }
        assert_eq!(fs::read_to_string(legacy).unwrap(), "ownerless normal");
        assert_eq!(
            fs::read_to_string(legacy_recovery).unwrap(),
            "ownerless recovery"
        );
    }

    #[tokio::test]
    async fn long_legacy_flattened_name_migrates_to_bounded_canonical_key() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let segment = "a".repeat(50);
        let file = project
            .join(&segment)
            .join(&segment)
            .join(&segment)
            .join("chapter.md");
        write_fixture(&file, "# Long");
        let legacy = legacy_draft(project, &file);
        assert!(legacy.file_name().unwrap().to_string_lossy().len() > 140);
        assert!(legacy.file_name().unwrap().to_string_lossy().len() <= 255);
        write_fixture(&legacy, "long legacy note");

        assert_eq!(
            read_draft_note(project.display().to_string(), file.display().to_string())
                .await
                .unwrap(),
            Some("long legacy note".to_string())
        );
        assert!(!legacy.exists());
        let canonical = canonical_draft(project, &file);
        assert!(canonical.exists());
        assert!(canonical
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains('~'));
    }

    #[tokio::test]
    async fn outside_scratch_uses_exact_legacy_basename_for_compatibility() {
        let project_dir = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let project = project_dir.path();
        let outside = outside_dir.path().join("%scratch.md");
        write_fixture(&outside, "# Scratch");
        let legacy = project.join(".novelist/drafts/%scratch.md.draft.md");
        write_fixture(&legacy, "scratch note");

        assert_eq!(
            read_draft_note(project.display().to_string(), outside.display().to_string())
                .await
                .unwrap(),
            Some("scratch note".to_string())
        );
        assert!(legacy.exists());
    }

    #[tokio::test]
    async fn outside_scratch_cannot_alias_existing_root_document_note() {
        let project_dir = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let project = project_dir.path();
        let root = project.join("same.md");
        let outside = outside_dir.path().join("same.md");
        write_fixture(&root, "# Root");
        write_fixture(&outside, "# Outside");
        write_draft_note(
            project.display().to_string(),
            root.display().to_string(),
            "root note".to_string(),
        )
        .await
        .unwrap();

        let error = read_draft_note(project.display().to_string(), outside.display().to_string())
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert_eq!(
            read_draft_note(project.display().to_string(), root.display().to_string())
                .await
                .unwrap(),
            Some("root note".to_string())
        );
    }

    #[tokio::test]
    async fn outside_scratch_cannot_alias_nested_documents_canonical_key() {
        let project_dir = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let project = project_dir.path();
        let nested = project.join("a/b.md");
        let outside = outside_dir.path().join("a%2Fb.md");
        write_fixture(&nested, "# Nested");
        write_fixture(&outside, "# Outside");
        write_draft_note(
            project.display().to_string(),
            nested.display().to_string(),
            "nested note".to_string(),
        )
        .await
        .unwrap();

        let error = read_draft_note(project.display().to_string(), outside.display().to_string())
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert_eq!(
            read_draft_note(project.display().to_string(), nested.display().to_string())
                .await
                .unwrap(),
            Some("nested note".to_string())
        );
    }

    #[tokio::test]
    async fn canonical_and_legacy_conflict_keeps_newest_active_and_one_recovery_copy() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("chapters/第一章.md");
        let canonical = canonical_draft(project, &file);
        let legacy = legacy_draft(project, &file);
        write_fixture(&file, "# 第一章");
        write_fixture(&canonical, "older canonical");
        std::thread::sleep(std::time::Duration::from_millis(10));
        write_fixture(&legacy, "newer legacy");

        assert_eq!(
            read_draft_note(project.display().to_string(), file.display().to_string())
                .await
                .unwrap(),
            Some("newer legacy".to_string())
        );
        assert!(!legacy.exists());
        assert_eq!(fs::read_to_string(&canonical).unwrap(), "newer legacy");

        let conflicts: Vec<_> = fs::read_dir(project.join(".novelist/drafts"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".conflict-")
            })
            .collect();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(
            fs::read_to_string(&conflicts[0]).unwrap(),
            "older canonical"
        );

        read_draft_note(project.display().to_string(), file.display().to_string())
            .await
            .unwrap();
        let conflict_count = fs::read_dir(project.join(".novelist/drafts"))
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".conflict-")
            })
            .count();
        assert_eq!(conflict_count, 1);
    }

    #[tokio::test]
    async fn newer_canonical_entry_wins_and_preserves_older_legacy_once() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("chapters/第一章.md");
        let canonical = canonical_draft(project, &file);
        let legacy = legacy_draft(project, &file);
        write_fixture(&file, "# 第一章");
        write_fixture(&legacy, "older legacy");
        std::thread::sleep(std::time::Duration::from_millis(10));
        write_fixture(&canonical, "newer canonical");

        assert_eq!(
            read_draft_note(project.display().to_string(), file.display().to_string())
                .await
                .unwrap(),
            Some("newer canonical".to_string())
        );
        assert!(!legacy.exists());
        assert_eq!(fs::read_to_string(&canonical).unwrap(), "newer canonical");
        let conflicts: Vec<_> = fs::read_dir(project.join(".novelist/drafts"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".conflict-")
            })
            .collect();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(fs::read_to_string(&conflicts[0]).unwrap(), "older legacy");
    }

    #[tokio::test]
    async fn rename_with_canonical_and_legacy_sources_uses_original_mtime_precedence() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("chapters/第一章.md");
        let new = project.join("chapters/第二章.md");
        write_fixture(&canonical_draft(project, &old), "older canonical");
        std::thread::sleep(std::time::Duration::from_millis(10));
        write_fixture(&legacy_draft(project, &old), "newer legacy");

        let result = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;

        assert_eq!(result.status, RenameMigrationStatus::FullSuccess);
        assert_eq!(result.conflicts, 1);
        assert_eq!(
            fs::read_to_string(canonical_draft(project, &new)).unwrap(),
            "newer legacy"
        );
        assert!(!canonical_draft(project, &old).exists());
        assert!(!legacy_draft(project, &old).exists());
        let conflicts: Vec<_> = fs::read_dir(project.join(".novelist/drafts"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".conflict-")
            })
            .collect();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(
            fs::read_to_string(&conflicts[0]).unwrap(),
            "older canonical"
        );
    }

    #[tokio::test]
    async fn future_dated_sources_use_original_mtime_not_destination_write_time() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("chapters/第一章.md");
        let new = project.join("chapters/第二章.md");
        let canonical = canonical_draft(project, &old);
        let legacy = legacy_draft(project, &old);
        write_fixture(&canonical, "newest canonical");
        write_fixture(&legacy, "older legacy");
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(86_400);
        set_modified(&canonical, future + std::time::Duration::from_secs(10));
        set_modified(&legacy, future);

        let result = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;

        assert_eq!(result.status, RenameMigrationStatus::FullSuccess);
        assert_eq!(result.conflicts, 1);
        assert_eq!(
            fs::read_to_string(canonical_draft(project, &new)).unwrap(),
            "newest canonical"
        );
        assert!(!canonical.exists());
        assert!(!legacy.exists());
    }

    #[tokio::test]
    async fn equal_future_mtimes_prefer_canonical_source() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("chapters/第一章.md");
        let new = project.join("chapters/第二章.md");
        let canonical = canonical_draft(project, &old);
        let legacy = legacy_draft(project, &old);
        write_fixture(&canonical, "canonical tie winner");
        write_fixture(&legacy, "legacy tie loser");
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(86_400);
        set_modified(&canonical, future);
        set_modified(&legacy, future);

        let result = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;

        assert_eq!(result.status, RenameMigrationStatus::FullSuccess);
        assert_eq!(result.conflicts, 1);
        assert_eq!(
            fs::read_to_string(canonical_draft(project, &new)).unwrap(),
            "canonical tie winner"
        );
        assert!(!canonical.exists());
        assert!(!legacy.exists());
    }

    #[tokio::test]
    async fn partial_cleanup_retry_keeps_original_winner_source_until_last() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("chapters/第一章.md");
        let new = project.join("chapters/第二章.md");
        let canonical = canonical_draft(project, &old);
        let legacy = legacy_draft(project, &old);
        write_fixture(&canonical, "original winner");
        write_fixture(&legacy, "older future source");
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(86_400);
        set_modified(&canonical, future + std::time::Duration::from_secs(10));
        set_modified(&legacy, future);
        let storage_path = project.join(".novelist/drafts").canonicalize().unwrap();
        set_confined_remove_failure_after(storage_path, 1);

        let first = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;

        assert_eq!(
            first.status,
            RenameMigrationStatus::UserFileRenamedWithMetadataErrors
        );
        assert!(canonical.exists(), "winner source must be removed last");
        assert!(!legacy.exists(), "older source should be cleaned first");
        assert_eq!(
            fs::read_to_string(canonical_draft(project, &new)).unwrap(),
            "original winner"
        );

        let retry = migrate_rename_sidecars(project, &direct_mapping(&old, &new), true).await;

        assert_eq!(retry.status, RenameMigrationStatus::IdempotentRetry);
        assert!(!canonical.exists());
        assert_eq!(
            fs::read_to_string(canonical_draft(project, &new)).unwrap(),
            "original winner"
        );
    }

    #[tokio::test]
    async fn ambiguous_legacy_key_never_consumes_literal_root_document_note() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let nested = project.join("a/b.md");
        let literal = project.join("a__b.md");
        write_fixture(&nested, "# Nested");
        write_fixture(&literal, "# Literal");
        let shared = legacy_draft(project, &nested);
        assert_eq!(shared, canonical_draft(project, &literal));
        write_fixture(&shared, "literal root note");

        let nested_note =
            read_draft_note(project.display().to_string(), nested.display().to_string())
                .await
                .unwrap();

        assert_eq!(nested_note, None);
        assert!(
            shared.exists(),
            "literal document's active note must remain"
        );
        assert_eq!(fs::read_to_string(&shared).unwrap(), "literal root note");
        assert_eq!(
            read_draft_note(project.display().to_string(), literal.display().to_string())
                .await
                .unwrap(),
            Some("literal root note".to_string())
        );
        assert!(!canonical_draft(project, &nested).exists());
        let conflicts: Vec<_> = fs::read_dir(project.join(".novelist/drafts"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".conflict-")
            })
            .collect();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(
            fs::read_to_string(&conflicts[0]).unwrap(),
            "literal root note"
        );
    }

    #[tokio::test]
    async fn legacy_candidate_never_consumes_another_documents_encoded_canonical_key() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let nested = project.join("a/%25b.md");
        let literal = project.join("a__%b.md");
        write_fixture(&nested, "# Nested");
        write_fixture(&literal, "# Literal");
        let shared = legacy_draft(project, &nested);
        assert_eq!(shared, canonical_draft(project, &literal));
        write_fixture(&shared, "encoded canonical owner");

        let nested_note =
            read_draft_note(project.display().to_string(), nested.display().to_string())
                .await
                .unwrap();

        assert_eq!(nested_note, None);
        assert!(shared.exists());
        assert_eq!(
            read_draft_note(project.display().to_string(), literal.display().to_string())
                .await
                .unwrap(),
            Some("encoded canonical owner".to_string())
        );
        assert!(!canonical_draft(project, &nested).exists());
    }

    #[tokio::test]
    async fn ambiguous_legacy_rename_retains_source_and_reports_metadata_error() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("a/b.md");
        let new = project.join("a/c.md");
        let literal = project.join("a__b.md");
        write_fixture(&old, "# Nested");
        write_fixture(&literal, "# Literal");
        let shared = legacy_draft(project, &old);
        write_fixture(&shared, "ambiguous note");
        fs::rename(&old, &new).unwrap();

        let result = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;

        assert_eq!(
            result.status,
            RenameMigrationStatus::UserFileRenamedWithMetadataErrors
        );
        assert!(shared.exists());
        assert_eq!(fs::read_to_string(&shared).unwrap(), "ambiguous note");
        assert!(!canonical_draft(project, &new).exists());
        let conflicts: Vec<_> = fs::read_dir(project.join(".novelist/drafts"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains(".conflict-")
            })
            .collect();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(fs::read_to_string(&conflicts[0]).unwrap(), "ambiguous note");
    }

    #[tokio::test]
    async fn nested_rename_chain_with_ordinary_edits_converges_to_one_active_key() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let a = project.join("chapters/第一章.md");
        let b = project.join("chapters/第二章.md");
        let c = project.join("archive/第三章.md");
        write_fixture(&a, "# 第一章");

        write_draft_note(
            project.display().to_string(),
            a.display().to_string(),
            "note-a".to_string(),
        )
        .await
        .unwrap();
        fs::create_dir_all(b.parent().unwrap()).unwrap();
        fs::rename(&a, &b).unwrap();
        let first = migrate_rename_sidecars(project, &direct_mapping(&a, &b), false).await;
        assert_eq!(first.status, RenameMigrationStatus::FullSuccess);
        assert_eq!(
            read_draft_note(project.display().to_string(), b.display().to_string())
                .await
                .unwrap(),
            Some("note-a".to_string())
        );

        write_draft_note(
            project.display().to_string(),
            b.display().to_string(),
            "note-b-edited".to_string(),
        )
        .await
        .unwrap();
        fs::create_dir_all(c.parent().unwrap()).unwrap();
        fs::rename(&b, &c).unwrap();
        let second = migrate_rename_sidecars(project, &direct_mapping(&b, &c), false).await;
        assert_eq!(second.status, RenameMigrationStatus::FullSuccess);
        let retry = migrate_rename_sidecars(project, &direct_mapping(&b, &c), true).await;
        assert_eq!(retry.status, RenameMigrationStatus::IdempotentRetry);

        assert_eq!(
            read_draft_note(project.display().to_string(), c.display().to_string())
                .await
                .unwrap(),
            Some("note-b-edited".to_string())
        );
        for obsolete in [&a, &b] {
            assert!(!canonical_draft(project, obsolete).exists());
            assert!(!legacy_draft(project, obsolete).exists());
        }
        assert_eq!(active_drafts(project), vec![canonical_draft(project, &c)]);
    }

    #[tokio::test]
    async fn stale_write_after_rename_cannot_recreate_obsolete_active_key() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old = project.join("chapters/第一章.md");
        let new = project.join("chapters/第二章.md");
        write_fixture(&old, "# 第一章");
        write_draft_note(
            project.display().to_string(),
            old.display().to_string(),
            "before rename".to_string(),
        )
        .await
        .unwrap();
        fs::rename(&old, &new).unwrap();
        let migration = migrate_rename_sidecars(project, &direct_mapping(&old, &new), false).await;
        assert_eq!(migration.status, RenameMigrationStatus::FullSuccess);

        let error = write_draft_note(
            project.display().to_string(),
            old.display().to_string(),
            "stale write".to_string(),
        )
        .await
        .unwrap_err();

        assert!(matches!(error, AppError::FileNotFound(_)));
        assert_eq!(
            fs::read_to_string(canonical_draft(project, &new)).unwrap(),
            "before rename"
        );
        assert!(!canonical_draft(project, &old).exists());
        assert!(!legacy_draft(project, &old).exists());
        assert_eq!(active_drafts(project), vec![canonical_draft(project, &new)]);
    }

    #[tokio::test]
    async fn pending_rename_journal_blocks_stale_delete_and_scratch_alias() {
        let project_dir = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let project = project_dir.path();
        let old = project.join("old.md");
        let new = project.join("new.md");
        let outside = outside_dir.path().join("old.md");
        write_fixture(&old, "# Old");
        write_fixture(&outside, "# Scratch");
        write_draft_note(
            project.display().to_string(),
            old.display().to_string(),
            "pending migration".to_string(),
        )
        .await
        .unwrap();
        let mappings = direct_mapping(&old, &new);
        let _journal = write_rename_journal(project, &old, &new, &mappings)
            .await
            .unwrap();
        fs::rename(&old, &new).unwrap();

        let delete_error =
            delete_draft_note(project.display().to_string(), old.display().to_string())
                .await
                .unwrap_err();
        let scratch_error =
            read_draft_note(project.display().to_string(), outside.display().to_string())
                .await
                .unwrap_err();

        assert!(matches!(delete_error, AppError::InvalidInput(_)));
        assert!(matches!(scratch_error, AppError::InvalidInput(_)));
        assert_eq!(
            fs::read_to_string(canonical_draft(project, &old)).unwrap(),
            "pending migration"
        );
        assert!(!canonical_draft(project, &new).exists());
    }

    #[tokio::test]
    async fn pending_journal_reserves_requested_documents_legacy_candidate() {
        let project_dir = TempDir::new().unwrap();
        let project = project_dir.path();
        let old = project.join("a__b.md");
        let renamed = project.join("renamed.md");
        let nested = project.join("a/b.md");
        write_fixture(&old, "# Old owner");
        write_fixture(&nested, "# Nested");
        write_draft_note(
            project.display().to_string(),
            old.display().to_string(),
            "reserved source".to_string(),
        )
        .await
        .unwrap();
        let mappings = direct_mapping(&old, &renamed);
        let _journal = write_rename_journal(project, &old, &renamed, &mappings)
            .await
            .unwrap();
        fs::rename(&old, &renamed).unwrap();

        let error = read_draft_note(project.display().to_string(), nested.display().to_string())
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert_eq!(
            fs::read_to_string(canonical_draft(project, &old)).unwrap(),
            "reserved source"
        );
        assert!(!canonical_draft(project, &nested).exists());
    }

    #[tokio::test]
    async fn ordinary_write_waits_for_shared_draft_transaction_lock() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_path_buf();
        let file = project.join("chapter.md");
        write_fixture(&file, "# Chapter");
        let guard = acquire_draft_transaction_guard(&project).await.unwrap();
        let mut write = tokio::spawn({
            let project = project.clone();
            let file = file.clone();
            async move {
                write_draft_note(
                    project.display().to_string(),
                    file.display().to_string(),
                    "serialized".to_string(),
                )
                .await
            }
        });

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut write)
                .await
                .is_err(),
            "ordinary write bypassed the shared draft lock"
        );
        drop(guard);
        write.await.unwrap().unwrap();
        assert_eq!(
            fs::read_to_string(canonical_draft(&project, &file)).unwrap(),
            "serialized"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn draft_commands_reject_symlinked_storage_without_touching_external_files() {
        use std::os::unix::fs::symlink;

        let project_dir = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let project = project_dir.path();
        fs::create_dir(project.join(".novelist")).unwrap();
        symlink(outside_dir.path(), project.join(".novelist/drafts")).unwrap();
        let file = project.join("chapters/第一章.md");
        write_fixture(&file, "# 第一章");

        let error = write_draft_note(
            project.display().to_string(),
            file.display().to_string(),
            "must stay confined".to_string(),
        )
        .await
        .unwrap_err();

        assert!(matches!(error, AppError::PathNotAllowed(_)));
        assert_eq!(fs::read_dir(outside_dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn write_rejects_draft_over_byte_cap_without_creating_sidecar() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("第一章.md");
        write_fixture(&file, "# 第一章");
        let oversized = "x".repeat(crate::services::sidecar::MAX_DRAFT_NOTE_BYTES + 1);

        let error = write_draft_note(
            project.display().to_string(),
            file.display().to_string(),
            oversized,
        )
        .await
        .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert!(!canonical_draft(project, &file).exists());
    }

    #[tokio::test]
    async fn test_has_draft_note() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        let file = dir.path().join("test.md").to_string_lossy().to_string();
        fs::write(&file, "# Test").unwrap();

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
        fs::write(&file, "# Test").unwrap();

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
        fs::write(&file, "# Test").unwrap();

        // .novelist/drafts/ doesn't exist yet
        assert!(!dir.path().join(".novelist").exists());

        write_draft_note(project, file, "content".to_string())
            .await
            .unwrap();

        assert!(dir.path().join(".novelist").join("drafts").exists());
    }
}
