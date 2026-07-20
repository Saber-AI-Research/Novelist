use crate::error::AppError;
use crate::services::sidecar::{
    atomic_write_json_confined, document_key, open_confined_metadata_dir, read_json_confined,
    remove_file_confined, sidecar_path, MAX_MANAGED_NAME_SIDECAR_BYTES,
};
use std::path::{Path, PathBuf};

const NAMING_SUBDIR: &str = "naming";
const NAMING_SUFFIX: &str = ".json";
const MANAGED_NAME_SCHEMA_VERSION: u32 = 1;
const CANONICAL_TITLE_TOKEN: &str = "{title}";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedNameStateV1 {
    pub version: u32,
    pub status: ManagedNameStatus,
    pub template_raw: String,
    pub current_h1: String,
    pub document_key: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ManagedNameStatus {
    Managed,
    Detached,
}

#[tauri::command]
#[specta::specta]
pub async fn compute_document_key(
    project_dir: String,
    file_path: String,
) -> Result<String, AppError> {
    document_key(Path::new(&project_dir), Path::new(&file_path))
}

#[tauri::command]
#[specta::specta]
pub async fn read_managed_name_state(
    project_dir: String,
    file_path: String,
) -> Result<Option<ManagedNameStateV1>, AppError> {
    let project = PathBuf::from(project_dir);
    let file = PathBuf::from(file_path);
    let path = naming_sidecar_path(&project, &file)?;
    let Some(storage) = open_confined_metadata_dir(&project, NAMING_SUBDIR, false)? else {
        return Ok(None);
    };
    let Some(state): Option<ManagedNameStateV1> = read_json_confined(
        &storage,
        &naming_sidecar_file_name(&path)?,
        MAX_MANAGED_NAME_SIDECAR_BYTES,
    )
    .await?
    else {
        return Ok(None);
    };
    validate_state_for_file(&project, &file, &state)?;
    Ok(Some(state))
}
#[tauri::command]
#[specta::specta]
pub async fn write_managed_name_state(
    project_dir: String,
    file_path: String,
    state: ManagedNameStateV1,
) -> Result<(), AppError> {
    let project = PathBuf::from(project_dir);
    let file = PathBuf::from(file_path);
    validate_state_for_file(&project, &file, &state)?;
    let path = naming_sidecar_path(&project, &file)?;
    let storage = open_confined_metadata_dir(&project, NAMING_SUBDIR, true)?
        .expect("create=true always returns a metadata directory");
    atomic_write_json_confined(
        &storage,
        &naming_sidecar_file_name(&path)?,
        &state,
        MAX_MANAGED_NAME_SIDECAR_BYTES,
    )
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn delete_managed_name_state(
    project_dir: String,
    file_path: String,
) -> Result<(), AppError> {
    let project = PathBuf::from(project_dir);
    let file = PathBuf::from(file_path);
    let path = naming_sidecar_path(&project, &file)?;
    let Some(storage) = open_confined_metadata_dir(&project, NAMING_SUBDIR, false)? else {
        return Ok(());
    };
    remove_file_confined(&storage, &naming_sidecar_file_name(&path)?).await
}
pub fn naming_sidecar_path(project_dir: &Path, file_path: &Path) -> Result<PathBuf, AppError> {
    let key = document_key(project_dir, file_path)?;
    sidecar_path(project_dir, NAMING_SUBDIR, &key, NAMING_SUFFIX)
}

fn naming_sidecar_file_name(path: &Path) -> Result<String, AppError> {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| {
            AppError::InvalidInput(format!(
                "Managed-name sidecar has no filename: {}",
                path.display()
            ))
        })
}

fn validate_state_for_file(
    project_dir: &Path,
    file_path: &Path,
    state: &ManagedNameStateV1,
) -> Result<(), AppError> {
    if state.version != MANAGED_NAME_SCHEMA_VERSION {
        return Err(AppError::InvalidInput(format!(
            "Invalid managed-name version: expected {} got {}",
            MANAGED_NAME_SCHEMA_VERSION, state.version
        )));
    }
    if state.template_raw.is_empty() || !state.template_raw.contains(CANONICAL_TITLE_TOKEN) {
        return Err(AppError::InvalidInput(format!(
            "Invalid managed-name templateRaw: must contain {}",
            CANONICAL_TITLE_TOKEN
        )));
    }
    let expected_key = document_key(project_dir, file_path)?;
    if state.document_key != expected_key {
        return Err(AppError::InvalidInput(format!(
            "Invalid managed-name documentKey: expected {} got {}",
            expected_key, state.document_key
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::sidecar::{document_key, sidecar_path};
    use tempfile::tempdir;

    fn state(project: &std::path::Path, file: &std::path::Path) -> ManagedNameStateV1 {
        ManagedNameStateV1 {
            version: 1,
            status: ManagedNameStatus::Managed,
            template_raw: "第{N}章-{title}".to_string(),
            current_h1: "开篇".to_string(),
            document_key: document_key(project, file).unwrap(),
        }
    }

    #[tokio::test]
    async fn managed_name_roundtrip_writes_canonical_v1_shape() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let file = project.join("章节/第一章.md");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "# 开篇").unwrap();

        write_managed_name_state(
            project.display().to_string(),
            file.display().to_string(),
            state(project, &file),
        )
        .await
        .unwrap();

        let loaded =
            read_managed_name_state(project.display().to_string(), file.display().to_string())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(loaded.template_raw, "第{N}章-{title}");
        assert_eq!(loaded.current_h1, "开篇");
        assert_eq!(loaded.document_key, document_key(project, &file).unwrap());

        let path = sidecar_path(project, "naming", &loaded.document_key, ".json").unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(json["version"], 1);
        assert_eq!(json["status"], "managed");
        assert_eq!(json["templateRaw"], "第{N}章-{title}");
        assert_eq!(json["currentH1"], "开篇");
        assert_eq!(json["documentKey"], loaded.document_key);
    }

    #[tokio::test]
    async fn read_missing_returns_none_without_creating_sidecar() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let file = project.join("ordinary.md");
        std::fs::write(&file, "# Ordinary").unwrap();

        let loaded =
            read_managed_name_state(project.display().to_string(), file.display().to_string())
                .await
                .unwrap();
        assert!(loaded.is_none());
        assert!(!project.join(".novelist/naming").exists());
    }

    #[tokio::test]
    async fn rejects_forged_document_key_and_preserves_existing_bytes() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let file = project.join("chapter.md");
        std::fs::write(&file, "# A").unwrap();
        let mut forged = state(project, &file);
        forged.document_key = "other.md".to_string();

        let err = write_managed_name_state(
            project.display().to_string(),
            file.display().to_string(),
            forged,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("documentKey"));
        assert!(!project.join(".novelist/naming/other.md.json").exists());
    }

    #[tokio::test]
    async fn rejects_malformed_status_template_and_schema_without_deleting_file() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let file = project.join("chapter.md");
        std::fs::write(&file, "# A").unwrap();
        let key = document_key(project, &file).unwrap();
        let sidecar = sidecar_path(project, "naming", &key, ".json").unwrap();
        std::fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        std::fs::write(&sidecar, r#"{"version":2,"status":"managed","templateRaw":"{title}","currentH1":"A","documentKey":"chapter.md"}"#).unwrap();

        let err =
            read_managed_name_state(project.display().to_string(), file.display().to_string())
                .await
                .unwrap_err();
        assert!(err.to_string().contains("version"));
        assert!(sidecar.exists());
    }

    #[tokio::test]
    async fn invalid_status_json_is_rejected_without_rewriting_sidecar() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let file = project.join("chapter.md");
        std::fs::write(&file, "# A").unwrap();
        let key = document_key(project, &file).unwrap();
        let sidecar = sidecar_path(project, "naming", &key, ".json").unwrap();
        std::fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
        let raw = r#"{"version":1,"status":"paused","templateRaw":"{title}","currentH1":"A","documentKey":"chapter.md"}"#;
        std::fs::write(&sidecar, raw).unwrap();

        let err =
            read_managed_name_state(project.display().to_string(), file.display().to_string())
                .await
                .unwrap_err();

        assert!(err.to_string().contains("paused") || err.to_string().contains("status"));
        assert_eq!(std::fs::read_to_string(&sidecar).unwrap(), raw);
    }

    #[tokio::test]
    async fn long_document_paths_use_bounded_naming_sidecar_keys() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let mut file = project.to_path_buf();
        for n in 0..18 {
            file = file.join(format!("章节{:02}", n));
        }
        std::fs::create_dir_all(&file).unwrap();
        file = file.join("这是一个很长的章节标题文件名.md");
        std::fs::write(&file, "# A").unwrap();
        let s = state(project, &file);
        assert!(s.document_key.len() <= 140);
        assert!(s.document_key.contains('~'));

        write_managed_name_state(
            project.display().to_string(),
            file.display().to_string(),
            s.clone(),
        )
        .await
        .unwrap();
        let sidecar = sidecar_path(project, "naming", &s.document_key, ".json").unwrap();
        let file_name_len = sidecar.file_name().unwrap().to_string_lossy().len();
        assert!(
            file_name_len <= 255,
            "sidecar filename too long: {file_name_len}"
        );

        let loaded =
            read_managed_name_state(project.display().to_string(), file.display().to_string())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(loaded.document_key, s.document_key);
    }

    #[tokio::test]
    async fn read_rejects_oversized_managed_name_sidecar_and_retains_source() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let file = project.join("第一章.md");
        std::fs::write(&file, "# 第一章").unwrap();
        let path = naming_sidecar_path(project, &file).unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::File::create(&path)
            .unwrap()
            .set_len(MAX_MANAGED_NAME_SIDECAR_BYTES as u64 + 1)
            .unwrap();

        let error =
            read_managed_name_state(project.display().to_string(), file.display().to_string())
                .await
                .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert_eq!(
            std::fs::metadata(path).unwrap().len(),
            MAX_MANAGED_NAME_SIDECAR_BYTES as u64 + 1
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn commands_reject_symlinked_naming_directory_without_touching_outside_file() {
        use std::os::unix::fs::symlink;

        let project_dir = tempdir().unwrap();
        let outside_dir = tempdir().unwrap();
        let project = project_dir.path();
        let file = project.join("第一章.md");
        std::fs::write(&file, "# 第一章").unwrap();
        std::fs::create_dir(project.join(".novelist")).unwrap();
        symlink(
            outside_dir.path(),
            project.join(".novelist").join(NAMING_SUBDIR),
        )
        .unwrap();
        let expected_path = naming_sidecar_path(project, &file).unwrap();
        let outside_path = outside_dir.path().join(expected_path.file_name().unwrap());
        let original_state = state(project, &file);
        let original_bytes = serde_json::to_vec_pretty(&original_state).unwrap();
        std::fs::write(&outside_path, &original_bytes).unwrap();

        let read_error =
            read_managed_name_state(project.display().to_string(), file.display().to_string())
                .await
                .unwrap_err();
        let mut replacement = original_state;
        replacement.current_h1 = "不应写入".to_string();
        let write_error = write_managed_name_state(
            project.display().to_string(),
            file.display().to_string(),
            replacement,
        )
        .await
        .unwrap_err();
        let delete_error =
            delete_managed_name_state(project.display().to_string(), file.display().to_string())
                .await
                .unwrap_err();

        assert!(matches!(read_error, AppError::PathNotAllowed(_)));
        assert!(matches!(write_error, AppError::PathNotAllowed(_)));
        assert!(matches!(delete_error, AppError::PathNotAllowed(_)));
        assert_eq!(std::fs::read(outside_path).unwrap(), original_bytes);
    }

    #[tokio::test]
    async fn write_rejects_managed_name_sidecar_over_migration_cap() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let file = project.join("第一章.md");
        std::fs::write(&file, "# 第一章").unwrap();
        let mut oversized = state(project, &file);
        oversized.current_h1 =
            "x".repeat(crate::services::sidecar::MAX_MANAGED_NAME_SIDECAR_BYTES + 1);

        let error = write_managed_name_state(
            project.display().to_string(),
            file.display().to_string(),
            oversized,
        )
        .await
        .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert!(!naming_sidecar_path(project, &file).unwrap().exists());
    }

    #[tokio::test]
    async fn delete_is_idempotent_and_removes_existing_state() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let file = project.join("chapter.md");
        std::fs::write(&file, "# A").unwrap();
        write_managed_name_state(
            project.display().to_string(),
            file.display().to_string(),
            state(project, &file),
        )
        .await
        .unwrap();

        delete_managed_name_state(project.display().to_string(), file.display().to_string())
            .await
            .unwrap();
        delete_managed_name_state(project.display().to_string(), file.display().to_string())
            .await
            .unwrap();

        assert!(
            read_managed_name_state(project.display().to_string(), file.display().to_string())
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn rejects_template_typos_and_missing_title_token() {
        let dir = tempdir().unwrap();
        let project = dir.path();
        let file = project.join("chapter.md");
        std::fs::write(&file, "# A").unwrap();
        for raw in ["第{N}章-{Title}", "第{N}章-{ title }", "第{N}章", ""] {
            let mut s = state(project, &file);
            s.template_raw = raw.to_string();
            let err = write_managed_name_state(
                project.display().to_string(),
                file.display().to_string(),
                s,
            )
            .await
            .unwrap_err();
            assert!(err.to_string().contains("templateRaw"), "{raw}: {err}");
        }
    }

    #[tokio::test]
    async fn rejects_path_outside_project_before_write() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        let outside = dir.path().join("outside.md");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(&outside, "# A").unwrap();
        let s = ManagedNameStateV1 {
            version: 1,
            status: ManagedNameStatus::Managed,
            template_raw: "第{N}章-{title}".to_string(),
            current_h1: "A".to_string(),
            document_key: "outside.md".to_string(),
        };
        let err = write_managed_name_state(
            project.display().to_string(),
            outside.display().to_string(),
            s,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("outside project") || err.to_string().contains("outside"));
        assert!(!project.join(".novelist/naming").exists());
    }
}
