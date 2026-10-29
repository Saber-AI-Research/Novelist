//! Project-scoped AI assets and sessions.
//!
//! These commands intentionally store JSON/Markdown blobs without knowing the
//! frontend schema. The AI panels evolve faster than the Rust core; Rust owns
//! path safety and atomic writes, while TypeScript owns session shape.

use crate::error::AppError;
use crate::services::sidecar::{
    atomic_write_bytes_confined, open_confined_metadata_dir, read_bytes_confined,
    ConfinedMetadataDir,
};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum AiSessionKind {
    Talk,
}

impl AiSessionKind {
    fn prefix(self) -> &'static str {
        match self {
            Self::Talk => "talk",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionFile {
    pub id: String,
    pub kind: AiSessionKind,
    pub path: String,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiPromptAsset {
    pub id: String,
    pub kind: String,
    pub path: String,
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiPromptAssets {
    pub skills: Vec<AiPromptAsset>,
    pub memory: Option<AiPromptAsset>,
}

fn validate_project_dir(project_dir: &str) -> Result<PathBuf, AppError> {
    if project_dir.trim().is_empty() {
        return Err(AppError::InvalidInput("project_dir is required".into()));
    }
    Ok(PathBuf::from(project_dir))
}

fn validate_id(id: &str) -> Result<(), AppError> {
    if id.is_empty() || id.len() > 96 {
        return Err(AppError::InvalidInput(format!(
            "AI session id must be 1..=96 chars: {id}"
        )));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::InvalidInput(format!(
            "AI session id contains illegal characters: {id}"
        )));
    }
    Ok(())
}

const AI_SUBDIR: &str = "ai";
const SESSIONS_SUBDIR: &str = "sessions";
const MEMORY_FILE: &str = "memory.md";
const MAX_AI_FILE_BYTES: usize = 64 * 1024 * 1024;

/// `<project>/.novelist/ai`, opened without following symlinks and confined to
/// the canonical project root, so writes can never land outside.
fn open_ai_dir(project_dir: &str, create: bool) -> Result<Option<ConfinedMetadataDir>, AppError> {
    let project = validate_project_dir(project_dir)?;
    open_confined_metadata_dir(&project, AI_SUBDIR, create)
}

/// `<project>/.novelist/ai/sessions` with the same confinement.
fn open_sessions_dir(
    project_dir: &str,
    create: bool,
) -> Result<Option<ConfinedMetadataDir>, AppError> {
    use cap_fs_ext::DirExt;

    let Some(ai) = open_ai_dir(project_dir, create)? else {
        return Ok(None);
    };
    match ai.dir.symlink_metadata(SESSIONS_SUBDIR) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(AppError::PathNotAllowed(format!(
                "AI sessions directory must not be a symlink: {}",
                ai.absolute.join(SESSIONS_SUBDIR).display()
            )))
        }
        Ok(metadata) if !metadata.is_dir() => {
            return Err(AppError::NotADirectory(
                ai.absolute.join(SESSIONS_SUBDIR).display().to_string(),
            ))
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match ai.dir.create_dir(SESSIONS_SUBDIR) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(AppError::Io(error)),
            }
        }
        Err(error) => return Err(AppError::Io(error)),
    }
    let dir = ai.dir.open_dir_nofollow(SESSIONS_SUBDIR).map_err(|error| {
        AppError::PathNotAllowed(format!(
            "Cannot open AI sessions directory {}: {error}",
            ai.absolute.join(SESSIONS_SUBDIR).display()
        ))
    })?;
    Ok(Some(ConfinedMetadataDir {
        dir,
        absolute: ai.absolute.join(SESSIONS_SUBDIR),
    }))
}

fn session_file_name(kind: AiSessionKind, id: &str) -> Result<String, AppError> {
    validate_id(id)?;
    Ok(format!("{}-{id}.json", kind.prefix()))
}

fn utf8_file(bytes: Vec<u8>) -> Result<String, AppError> {
    String::from_utf8(bytes)
        .map_err(|error| AppError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, error)))
}

mod ai_chat_save {
    use super::*;
    #[cfg(windows)]
    use cap_primitives::fs::_WindowsByHandle;
    use cap_std::ambient_authority;
    #[cfg(unix)]
    use cap_std::fs::MetadataExt;
    use cap_std::fs::{Dir, Metadata as CapMetadata, OpenOptions as CapOpenOptions};

    pub(super) const MAX_AI_CHAT_FILENAME_BYTES: usize = 240;
    const MAX_AI_CHAT_COLLISION_INDEX: u32 = 9_999;
    const MAX_AI_CHAT_TEMP_ATTEMPTS: usize = 64;
    const AI_CHAT_TEMP_SUFFIX: &str = ".novelist-tmp";
    const CHATS_RELATIVE: &str = ".novelist/chats";

    static AI_CHAT_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    static AI_CHAT_DIR_LOCKS: Lazy<Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));

    #[cfg(test)]
    pub(super) type AfterSyncHook = Arc<dyn Fn(&Path, &Path, &Path) + Send + Sync>;
    #[cfg(test)]
    static AFTER_SYNC_HOOKS: Lazy<Mutex<HashMap<PathBuf, AfterSyncHook>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));

    #[cfg(test)]
    pub(super) fn install_after_sync_hook(chats_dir: PathBuf, hook: AfterSyncHook) {
        AFTER_SYNC_HOOKS.lock().unwrap().insert(chats_dir, hook);
    }

    #[cfg(test)]
    fn run_after_sync_hook(parent: &Path, temp: &Path, target: &Path) {
        let hook = AFTER_SYNC_HOOKS.lock().unwrap().remove(parent);
        if let Some(hook) = hook {
            hook(parent, temp, target);
        }
    }

    struct ChatDirectory {
        absolute: PathBuf,
        project: Dir,
        chats: Dir,
    }

    fn validate_ai_chat_filename(filename: &str) -> Result<&str, AppError> {
        if filename.is_empty() || filename.len() > MAX_AI_CHAT_FILENAME_BYTES {
            return Err(AppError::InvalidInput(format!(
                "AI chat filename must be 1..={MAX_AI_CHAT_FILENAME_BYTES} bytes"
            )));
        }
        if filename.contains('/')
            || filename.contains('\\')
            || filename.contains('\0')
            || filename.chars().any(char::is_control)
        {
            return Err(AppError::PathNotAllowed(format!(
                "AI chat filename contains a disallowed character: {filename:?}"
            )));
        }
        if filename == "." || filename == ".." {
            return Err(AppError::PathNotAllowed(format!(
                "AI chat filename cannot be a dot segment: {filename}"
            )));
        }
        let mut components = Path::new(filename).components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            return Err(AppError::PathNotAllowed(format!(
                "AI chat filename must be one path component: {filename}"
            )));
        }
        let stem = filename.strip_suffix(".md").ok_or_else(|| {
            AppError::InvalidInput("AI chat filename must have a .md extension".to_string())
        })?;
        if stem.trim().is_empty() {
            return Err(AppError::InvalidInput(
                "AI chat filename must have a nonempty stem".to_string(),
            ));
        }
        Ok(stem)
    }

    fn canonical_ai_chat_project(project_dir: &str) -> Result<PathBuf, AppError> {
        if project_dir.trim().is_empty() {
            return Err(AppError::InvalidInput(
                "project_dir is required".to_string(),
            ));
        }
        if project_dir.contains('\0') {
            return Err(AppError::PathNotAllowed(
                "project_dir contains a null byte".to_string(),
            ));
        }

        let project = PathBuf::from(project_dir);
        if project
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(AppError::PathNotAllowed(format!(
                "project_dir contains path traversal: {project_dir}"
            )));
        }

        let metadata = match fs::metadata(&project) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(AppError::FileNotFound(format!(
                    "project dir does not exist: {}",
                    project.display()
                )))
            }
            Err(error) => return Err(AppError::Io(error)),
        };
        if !metadata.is_dir() {
            return Err(AppError::NotADirectory(project.display().to_string()));
        }
        Ok(fs::canonicalize(project)?)
    }

    fn reject_existing_chat_dir_escape(path: &Path, project: &Path) -> Result<(), AppError> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                let resolved = fs::canonicalize(path).map_err(|error| {
                    AppError::PathNotAllowed(format!(
                        "AI chat directory symlink cannot be resolved: {}: {error}",
                        path.display()
                    ))
                })?;
                if !resolved.starts_with(project) {
                    return Err(AppError::PathNotAllowed(format!(
                        "AI chat directory escapes project: {} -> {}",
                        path.display(),
                        resolved.display()
                    )));
                }
                Ok(())
            }
            Ok(_) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AppError::Io(error)),
        }
    }

    fn canonical_ai_chats_dir(project: &Path) -> Result<ChatDirectory, AppError> {
        let novelist_dir = project.join(".novelist");
        let chats_dir = novelist_dir.join("chats");
        reject_existing_chat_dir_escape(&novelist_dir, project)?;
        reject_existing_chat_dir_escape(&chats_dir, project)?;

        let project_cap = Dir::open_ambient_dir(project, ambient_authority())?;
        project_cap
            .create_dir_all(CHATS_RELATIVE)
            .map_err(|error| chat_directory_error("create", &chats_dir, error))?;
        let chats_cap = project_cap
            .open_dir(CHATS_RELATIVE)
            .map_err(|error| chat_directory_error("open", &chats_dir, error))?;

        let canonical = fs::canonicalize(&chats_dir)?;
        if !canonical.starts_with(project) {
            return Err(AppError::PathNotAllowed(format!(
                "AI chats directory escapes project: {}",
                canonical.display()
            )));
        }

        let current = project_cap
            .open_dir(CHATS_RELATIVE)
            .map_err(|error| chat_directory_error("reopen", &chats_dir, error))?;
        ensure_same_identity(
            &chats_cap.dir_metadata()?,
            &current.dir_metadata()?,
            "AI chats directory changed while opening",
        )?;

        Ok(ChatDirectory {
            absolute: canonical,
            project: project_cap,
            chats: chats_cap,
        })
    }

    fn chat_directory_error(action: &str, path: &Path, error: std::io::Error) -> AppError {
        AppError::PathNotAllowed(format!(
            "cannot {action} AI chats directory {}: {error}",
            path.display()
        ))
    }

    #[cfg(unix)]
    fn metadata_matches(left: &CapMetadata, right: &CapMetadata) -> Result<bool, AppError> {
        Ok(left.dev() == right.dev() && left.ino() == right.ino())
    }

    #[cfg(windows)]
    fn metadata_matches(left: &CapMetadata, right: &CapMetadata) -> Result<bool, AppError> {
        let left_volume = left.volume_serial_number().ok_or_else(|| {
            AppError::Custom("AI chat file identity has no volume serial number".to_string())
        })?;
        let right_volume = right.volume_serial_number().ok_or_else(|| {
            AppError::Custom("AI chat file identity has no volume serial number".to_string())
        })?;
        let left_index = left.file_index().ok_or_else(|| {
            AppError::Custom("AI chat file identity has no file index".to_string())
        })?;
        let right_index = right.file_index().ok_or_else(|| {
            AppError::Custom("AI chat file identity has no file index".to_string())
        })?;
        Ok(left_volume == right_volume && left_index == right_index)
    }

    #[cfg(not(any(unix, windows)))]
    fn metadata_matches(_left: &CapMetadata, _right: &CapMetadata) -> Result<bool, AppError> {
        Err(AppError::Custom(
            "AI chat file identity is unsupported on this platform".to_string(),
        ))
    }

    fn ensure_same_identity(
        expected: &CapMetadata,
        actual: &CapMetadata,
        message: &str,
    ) -> Result<(), AppError> {
        if metadata_matches(expected, actual)? {
            Ok(())
        } else {
            Err(AppError::PathNotAllowed(message.to_string()))
        }
    }

    fn ai_chat_dir_lock(chats_dir: &Path) -> Result<Arc<AsyncMutex<()>>, AppError> {
        let mut locks = AI_CHAT_DIR_LOCKS.lock().map_err(|error| {
            AppError::Custom(format!("AI chat lock registry poisoned: {error}"))
        })?;
        Ok(locks
            .entry(chats_dir.to_path_buf())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone())
    }

    fn allocate_ai_chat_temp(chats: &Dir) -> Result<(cap_std::fs::File, String), AppError> {
        let pid = std::process::id();
        let mut last_error = None;
        for _ in 0..MAX_AI_CHAT_TEMP_ATTEMPTS {
            let counter = AI_CHAT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let temp_name = format!(".ai-chat.{pid}.{counter}{AI_CHAT_TEMP_SUFFIX}");
            let mut options = CapOpenOptions::new();
            options.write(true).create_new(true);
            match chats.open_with(&temp_name, &options) {
                Ok(file) => return Ok((file, temp_name)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    last_error = Some(error);
                }
                Err(error) => {
                    return Err(AppError::Custom(format!(
                        "open AI chat temp {temp_name}: {error}"
                    )))
                }
            }
        }
        Err(AppError::Custom(format!(
            "failed to allocate AI chat temp after {MAX_AI_CHAT_TEMP_ATTEMPTS} attempts: {}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "unknown error".to_string())
        )))
    }

    fn with_ai_chat_temp_cleanup(chats: &Dir, temp_name: &str, error: AppError) -> AppError {
        match chats.remove_file(temp_name) {
            Ok(()) => error,
            Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => error,
            Err(cleanup_error) => AppError::Custom(format!(
                "{error}; cleanup AI chat temp {temp_name}: {cleanup_error}"
            )),
        }
    }

    fn reopen_current_chats(storage: &ChatDirectory) -> Result<Dir, AppError> {
        let current = storage
            .project
            .open_dir(CHATS_RELATIVE)
            .map_err(|error| chat_directory_error("reopen", &storage.absolute, error))?;
        ensure_same_identity(
            &storage.chats.dir_metadata()?,
            &current.dir_metadata()?,
            "AI chats directory identity changed during save",
        )?;
        Ok(current)
    }

    fn save_ai_chat_locked(
        storage: ChatDirectory,
        filename: &str,
        stem: &str,
        body: &[u8],
    ) -> Result<String, AppError> {
        let (mut file, temp_name) = allocate_ai_chat_temp(&storage.chats)?;
        let write_result = (|| -> Result<CapMetadata, AppError> {
            file.write_all(body)?;
            file.flush()?;
            file.sync_all()?;
            Ok(file.metadata()?)
        })();
        drop(file);
        let temp_metadata = match write_result {
            Ok(metadata) => metadata,
            Err(error) => return Err(with_ai_chat_temp_cleanup(&storage.chats, &temp_name, error)),
        };

        #[cfg(test)]
        {
            let first_target = storage.absolute.join(filename);
            run_after_sync_hook(
                &storage.absolute,
                &storage.absolute.join(&temp_name),
                &first_target,
            );
        }

        for collision_index in 1..=MAX_AI_CHAT_COLLISION_INDEX {
            let candidate_name = if collision_index == 1 {
                filename.to_string()
            } else {
                format!("{stem} {collision_index}.md")
            };
            let current = match reopen_current_chats(&storage) {
                Ok(current) => current,
                Err(error) => {
                    return Err(with_ai_chat_temp_cleanup(&storage.chats, &temp_name, error))
                }
            };
            let current_temp_metadata = match current.metadata(&temp_name) {
                Ok(metadata) => metadata,
                Err(error) => {
                    let error = AppError::PathNotAllowed(format!(
                        "AI chat temp is no longer reachable through validated chats directory: {error}"
                    ));
                    return Err(with_ai_chat_temp_cleanup(&storage.chats, &temp_name, error));
                }
            };
            if let Err(error) = ensure_same_identity(
                &temp_metadata,
                &current_temp_metadata,
                "AI chat temp identity changed during save",
            ) {
                return Err(with_ai_chat_temp_cleanup(&storage.chats, &temp_name, error));
            }

            match current.hard_link(&temp_name, &current, &candidate_name) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(with_ai_chat_temp_cleanup(
                        &storage.chats,
                        &temp_name,
                        AppError::Custom(format!("install AI chat {candidate_name}: {error}")),
                    ))
                }
            }

            let post_install = (|| -> Result<(), AppError> {
                let post_current = reopen_current_chats(&storage)?;
                let installed_metadata = post_current.metadata(&candidate_name).map_err(|error| {
                    AppError::PathNotAllowed(format!(
                        "installed AI chat is no longer reachable through validated chats directory: {error}"
                    ))
                })?;
                ensure_same_identity(
                    &temp_metadata,
                    &installed_metadata,
                    "installed AI chat identity changed during save",
                )
            })();
            if let Err(error) = post_install {
                let _ = current.remove_file(&candidate_name);
                return Err(with_ai_chat_temp_cleanup(&storage.chats, &temp_name, error));
            }

            if let Err(error) = current.remove_file(&temp_name) {
                let _ = current.remove_file(&candidate_name);
                return Err(AppError::Custom(format!(
                    "cleanup AI chat temp {temp_name}: {error}"
                )));
            }
            return Ok(storage
                .absolute
                .join(candidate_name)
                .to_string_lossy()
                .to_string());
        }
        Err(with_ai_chat_temp_cleanup(
            &storage.chats,
            &temp_name,
            AppError::Custom(format!("AI chat collision limit reached for {filename}")),
        ))
    }

    pub(super) async fn save(
        project_dir: String,
        filename: String,
        body: String,
    ) -> Result<String, AppError> {
        let stem = validate_ai_chat_filename(&filename)?.to_string();
        let project = canonical_ai_chat_project(&project_dir)?;
        let chats = canonical_ai_chats_dir(&project)?;
        let lock = ai_chat_dir_lock(&chats.absolute)?;
        let _guard = lock.lock().await;

        tokio::task::spawn_blocking(move || {
            save_ai_chat_locked(chats, &filename, &stem, body.as_bytes())
        })
        .await
        .map_err(|error| AppError::Custom(format!("AI chat writer task failed: {error}")))?
    }
}

#[tauri::command]
#[specta::specta]
pub async fn save_ai_chat(
    project_dir: String,
    filename: String,
    body: String,
) -> Result<String, AppError> {
    ai_chat_save::save(project_dir, filename, body).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_ai_sessions(
    project_dir: String,
    kind: AiSessionKind,
) -> Result<Vec<AiSessionFile>, AppError> {
    let Some(storage) = open_sessions_dir(&project_dir, false)? else {
        return Ok(Vec::new());
    };
    tokio::task::spawn_blocking(move || {
        let prefix = format!("{}-", kind.prefix());
        let mut out = Vec::new();
        for entry in storage.dir.entries()? {
            let entry = entry?;
            // `file_type` does not follow symlinks, so links are skipped.
            if !entry.file_type().is_ok_and(|file_type| file_type.is_file()) {
                continue;
            }
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            if !name.starts_with(&prefix) || !name.ends_with(".json") {
                continue;
            }
            let id = name[prefix.len()..name.len() - ".json".len()].to_string();
            if validate_id(&id).is_err() {
                continue;
            }
            let updated_at = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.into_std().duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64);
            out.push(AiSessionFile {
                id,
                kind,
                path: storage.absolute.join(name).to_string_lossy().to_string(),
                updated_at,
            });
        }
        out.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(out)
    })
    .await
    .map_err(|error| AppError::Custom(format!("AI session listing failed: {error}")))?
}

#[tauri::command]
#[specta::specta]
pub async fn read_ai_session(
    project_dir: String,
    kind: AiSessionKind,
    id: String,
) -> Result<Option<String>, AppError> {
    let name = session_file_name(kind, &id)?;
    let Some(storage) = open_sessions_dir(&project_dir, false)? else {
        return Ok(None);
    };
    read_bytes_confined(&storage, &name, MAX_AI_FILE_BYTES)
        .await?
        .map(utf8_file)
        .transpose()
}

#[tauri::command]
#[specta::specta]
pub async fn write_ai_session(
    project_dir: String,
    kind: AiSessionKind,
    id: String,
    body_json: String,
) -> Result<(), AppError> {
    // Validate JSON early so corrupted session files do not get produced by
    // accidental callers.
    serde_json::from_str::<serde_json::Value>(&body_json)
        .map_err(|e| AppError::InvalidInput(format!("Invalid AI session JSON: {e}")))?;
    let name = session_file_name(kind, &id)?;
    let storage = open_sessions_dir(&project_dir, true)?
        .expect("create=true always returns the sessions directory");
    atomic_write_bytes_confined(&storage, &name, body_json.as_bytes()).await
}

fn read_asset_file(path: &Path, root: &Path, kind: &str) -> Option<AiPromptAsset> {
    if !path.is_file() || path.file_name()?.to_str()?.starts_with('.') {
        return None;
    }
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    if ext != "md" {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    let rel = path.strip_prefix(root).ok()?.to_string_lossy().to_string();
    let name = path.file_stem()?.to_string_lossy().to_string();
    Some(AiPromptAsset {
        id: rel.replace('\\', "/"),
        kind: kind.to_string(),
        path: path.to_string_lossy().to_string(),
        name,
        content,
    })
}

fn collect_markdown_files(dir: &Path, root: &Path, kind: &str) -> Vec<AiPromptAsset> {
    let mut out = Vec::new();
    if !dir.exists() {
        return out;
    }
    let mut stack = vec![dir.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let Ok(entries) = fs::read_dir(&cur) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if let Some(asset) = read_asset_file(&path, root, kind) {
                out.push(asset);
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

#[tauri::command]
#[specta::specta]
pub async fn list_ai_prompt_assets(project_dir: String) -> Result<AiPromptAssets, AppError> {
    let Some(ai) = open_ai_dir(&project_dir, false)? else {
        return Ok(AiPromptAssets {
            skills: Vec::new(),
            memory: None,
        });
    };
    let memory = read_bytes_confined(&ai, MEMORY_FILE, MAX_AI_FILE_BYTES)
        .await?
        .map(utf8_file)
        .transpose()?
        .map(|content| AiPromptAsset {
            id: MEMORY_FILE.to_string(),
            kind: "memory".to_string(),
            path: ai.absolute.join(MEMORY_FILE).to_string_lossy().to_string(),
            name: "memory".to_string(),
            content,
        });
    let root = ai.absolute;
    let skills = tokio::task::spawn_blocking(move || {
        collect_markdown_files(&root.join("skills"), &root, "skill")
    })
    .await
    .map_err(|error| AppError::Custom(format!("AI prompt listing failed: {error}")))?;
    Ok(AiPromptAssets { skills, memory })
}

#[tauri::command]
#[specta::specta]
pub async fn write_ai_memory(project_dir: String, body: String) -> Result<(), AppError> {
    let ai = open_ai_dir(&project_dir, true)?.expect("create=true always returns the AI directory");
    atomic_write_bytes_confined(&ai, MEMORY_FILE, body.as_bytes()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;
    use tempfile::tempdir;
    use tokio::sync::Barrier;

    fn assert_no_chat_temps(chats_dir: &Path) {
        let temps: Vec<_> = fs::read_dir(chats_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("novelist-tmp"))
            .collect();
        assert!(temps.is_empty(), "unexpected temp files: {temps:?}");
    }

    #[tokio::test]
    async fn save_ai_chat_creates_fresh_dir_and_round_trips_cjk_markdown() {
        let dir = tempdir().unwrap();
        let body = "# 第一章\n\n落霞与孤鹜齐飞。\n对話の続き。\n";

        let saved = save_ai_chat(
            dir.path().to_string_lossy().to_string(),
            "新 对话.md".into(),
            body.into(),
        )
        .await
        .unwrap();

        let expected = dir
            .path()
            .canonicalize()
            .unwrap()
            .join(".novelist")
            .join("chats")
            .join("新 对话.md");
        assert_eq!(PathBuf::from(&saved), expected);
        assert!(Path::new(&saved).is_absolute());
        assert_eq!(fs::read_to_string(&saved).unwrap(), body);
        assert_no_chat_temps(expected.parent().unwrap());
    }

    #[tokio::test]
    async fn save_ai_chat_bumps_repeated_collisions_without_overwriting() {
        let dir = tempdir().unwrap();
        let project = dir.path().to_string_lossy().to_string();

        let first = save_ai_chat(project.clone(), "chat.md".into(), "first".into())
            .await
            .unwrap();
        let second = save_ai_chat(project.clone(), "chat.md".into(), "second".into())
            .await
            .unwrap();
        let third = save_ai_chat(project, "chat.md".into(), "third".into())
            .await
            .unwrap();

        assert_eq!(Path::new(&first).file_name().unwrap(), "chat.md");
        assert_eq!(Path::new(&second).file_name().unwrap(), "chat 2.md");
        assert_eq!(Path::new(&third).file_name().unwrap(), "chat 3.md");
        assert_eq!(fs::read_to_string(first).unwrap(), "first");
        assert_eq!(fs::read_to_string(second).unwrap(), "second");
        assert_eq!(fs::read_to_string(third).unwrap(), "third");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn save_ai_chat_serializes_concurrent_collision_selection() {
        let dir = tempdir().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        let barrier = Arc::new(Barrier::new(8));
        let mut tasks = Vec::new();

        for index in 0..8 {
            let project = project.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                barrier.wait().await;
                let body = format!("并发内容 {index}");
                let path = save_ai_chat(project, "并发.md".into(), body.clone())
                    .await
                    .unwrap();
                (path, body)
            }));
        }

        let mut paths = HashSet::new();
        for task in tasks {
            let (path, body) = task.await.unwrap();
            assert!(paths.insert(path.clone()), "duplicate target: {path}");
            assert_eq!(fs::read_to_string(path).unwrap(), body);
        }
        assert_eq!(paths.len(), 8);
    }

    #[tokio::test]
    async fn save_ai_chat_retries_when_final_target_appears_after_temp_sync() {
        let dir = tempdir().unwrap();
        let project = dir.path().canonicalize().unwrap();
        let chats = project.join(".novelist").join("chats");
        let first_target = chats.join("chat.md");
        ai_chat_save::install_after_sync_hook(
            chats.clone(),
            Arc::new(|_, _, target| fs::write(target, "external writer").unwrap()),
        );

        let saved = save_ai_chat(
            project.to_string_lossy().to_string(),
            "chat.md".into(),
            "novelist body".into(),
        )
        .await
        .unwrap();

        assert_eq!(
            fs::read_to_string(&first_target).unwrap(),
            "external writer"
        );
        assert_eq!(Path::new(&saved).file_name().unwrap(), "chat 2.md");
        assert_eq!(fs::read_to_string(saved).unwrap(), "novelist body");
        assert_no_chat_temps(&chats);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn save_ai_chat_fails_closed_when_chats_directory_is_swapped() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let project = project.canonicalize().unwrap();
        let chats = project.join(".novelist").join("chats");
        let detached = project.join(".novelist").join("detached-chats");
        fs::write(outside.join("chat.md"), "outside sentinel").unwrap();

        let outside_for_hook = outside.clone();
        let detached_for_hook = detached.clone();
        ai_chat_save::install_after_sync_hook(
            chats.clone(),
            Arc::new(move |parent, temp, _| {
                fs::rename(parent, &detached_for_hook).unwrap();
                std::os::unix::fs::symlink(&outside_for_hook, parent).unwrap();
                let temp_name = temp.file_name().unwrap();
                fs::write(outside_for_hook.join(temp_name), "attacker temp").unwrap();
            }),
        );

        let error = save_ai_chat(
            project.to_string_lossy().to_string(),
            "chat.md".into(),
            "novelist body".into(),
        )
        .await
        .unwrap_err();

        assert!(
            matches!(error, AppError::PathNotAllowed(_) | AppError::Custom(_)),
            "unexpected error: {error:?}"
        );
        assert_eq!(
            fs::read_to_string(outside.join("chat.md")).unwrap(),
            "outside sentinel"
        );
        assert!(!detached.join("chat.md").exists());
        assert_no_chat_temps(&detached);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn save_ai_chat_pins_chats_directory_against_windows_replacement() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let project = project.canonicalize().unwrap();
        let chats = project.join(".novelist").join("chats");
        let detached = project.join(".novelist").join("detached-chats");

        ai_chat_save::install_after_sync_hook(
            chats.clone(),
            Arc::new(move |parent, _, _| {
                fs::rename(parent, &detached).unwrap_err();
            }),
        );

        let saved = save_ai_chat(
            project.to_string_lossy().to_string(),
            "chat.md".into(),
            "novelist body".into(),
        )
        .await
        .unwrap();

        assert_eq!(fs::read_to_string(saved).unwrap(), "novelist body");
        assert_no_chat_temps(&chats);
    }

    #[tokio::test]
    async fn save_ai_chat_rejects_nonexistent_and_file_projects() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("missing");
        let file = dir.path().join("project.md");
        fs::write(&file, "not a directory").unwrap();

        let missing_err = save_ai_chat(
            missing.to_string_lossy().to_string(),
            "chat.md".into(),
            "body".into(),
        )
        .await
        .unwrap_err();
        assert!(matches!(missing_err, AppError::FileNotFound(_)));

        let file_err = save_ai_chat(
            file.to_string_lossy().to_string(),
            "chat.md".into(),
            "body".into(),
        )
        .await
        .unwrap_err();
        assert!(matches!(file_err, AppError::NotADirectory(_)));
    }

    #[tokio::test]
    async fn save_ai_chat_rejects_invalid_project_paths() {
        let dir = tempdir().unwrap();
        let file_name = dir.path().file_name().unwrap();
        let traversal = dir.path().join("..").join(file_name);

        for project in [
            String::new(),
            "bad\0project".to_string(),
            traversal.to_string_lossy().to_string(),
        ] {
            assert!(save_ai_chat(project, "chat.md".into(), "body".into())
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn save_ai_chat_rejects_unsafe_filenames() {
        let dir = tempdir().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        let absolute = dir.path().join("absolute.md").to_string_lossy().to_string();
        let overlong = format!(
            "{}.md",
            "a".repeat(ai_chat_save::MAX_AI_CHAT_FILENAME_BYTES)
        );
        let invalid = [
            "".to_string(),
            ".".to_string(),
            "..".to_string(),
            ".md".to_string(),
            "nested/chat.md".to_string(),
            "nested\\chat.md".to_string(),
            "../chat.md".to_string(),
            absolute,
            "bad\0name.md".to_string(),
            "bad\nname.md".to_string(),
            "chat.txt".to_string(),
            "chat.MD".to_string(),
            overlong,
        ];

        for filename in invalid {
            assert!(
                save_ai_chat(project.clone(), filename.clone(), "body".into())
                    .await
                    .is_err(),
                "accepted unsafe filename {filename:?}"
            );
        }
    }

    #[tokio::test]
    async fn save_ai_chat_accepts_cjk_filename_with_spaces() {
        let dir = tempdir().unwrap();
        let saved = save_ai_chat(
            dir.path().to_string_lossy().to_string(),
            "第一章 会话.md".into(),
            "正文".into(),
        )
        .await
        .unwrap();

        assert_eq!(Path::new(&saved).file_name().unwrap(), "第一章 会话.md");
        assert_eq!(fs::read_to_string(saved).unwrap(), "正文");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn save_ai_chat_rejects_symlinked_metadata_escape() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let metadata = project.join(".novelist");
        std::os::unix::fs::symlink(&outside, &metadata).unwrap();
        let err = save_ai_chat(
            project.to_string_lossy().to_string(),
            "chat.md".into(),
            "body".into(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::PathNotAllowed(_)));
        assert!(!outside.join("chats").exists());

        fs::remove_file(&metadata).unwrap();
        fs::create_dir(&metadata).unwrap();
        std::os::unix::fs::symlink(&outside, metadata.join("chats")).unwrap();
        let err = save_ai_chat(
            project.to_string_lossy().to_string(),
            "chat.md".into(),
            "body".into(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::PathNotAllowed(_)));
        assert!(!outside.join("chat.md").exists());
    }

    #[tokio::test]
    async fn rejects_path_traversal_ids() {
        let dir = tempdir().unwrap();
        let err = write_ai_session(
            dir.path().to_string_lossy().to_string(),
            AiSessionKind::Talk,
            "../bad".into(),
            "{}".into(),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("illegal"));
    }

    #[tokio::test]
    async fn write_read_list_session_roundtrip() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        write_ai_session(
            root.clone(),
            AiSessionKind::Talk,
            "abc_123".into(),
            "{\"x\":\"第一章\"}".into(),
        )
        .await
        .unwrap();
        let list = list_ai_sessions(root.clone(), AiSessionKind::Talk)
            .await
            .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "abc_123");
        let body = read_ai_session(root, AiSessionKind::Talk, "abc_123".into())
            .await
            .unwrap();
        assert_eq!(body.as_deref(), Some("{\"x\":\"第一章\"}"));
        let sessions = dir.path().join(".novelist/ai/sessions");
        assert!(sessions.join("talk-abc_123.json").is_file());
        assert!(fs::read_dir(&sessions).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("novelist-tmp")));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_session_saves_never_interleave() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let bodies: Vec<String> = (0..8)
            .map(|index| format!("{{\"turns\":\"{}\"}}", "字".repeat(20_000 + index)))
            .collect();
        let mut saves = tokio::task::JoinSet::new();
        for body in bodies.clone() {
            let root = root.clone();
            saves.spawn(async move {
                write_ai_session(root, AiSessionKind::Talk, "same".into(), body).await
            });
        }
        while let Some(result) = saves.join_next().await {
            result.unwrap().unwrap();
        }
        let stored = read_ai_session(root, AiSessionKind::Talk, "same".into())
            .await
            .unwrap()
            .unwrap();
        assert!(bodies.contains(&stored), "session bytes were interleaved");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_ai_folders_cannot_redirect_writes() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("project");
        let outside = dir.path().join("outside");
        fs::create_dir_all(project.join(".novelist")).unwrap();
        fs::create_dir_all(outside.join("sessions")).unwrap();
        fs::write(outside.join("sessions/talk-victim.json"), "{}").unwrap();
        std::os::unix::fs::symlink(&outside, project.join(".novelist/ai")).unwrap();
        let root = project.to_string_lossy().to_string();

        let write = write_ai_session(root.clone(), AiSessionKind::Talk, "x".into(), "{}".into())
            .await
            .unwrap_err();
        assert!(matches!(write, AppError::PathNotAllowed(_)), "{write:?}");
        let memory = write_ai_memory(root, "secret".into()).await.unwrap_err();
        assert!(matches!(memory, AppError::PathNotAllowed(_)), "{memory:?}");
        assert_eq!(
            fs::read_to_string(outside.join("sessions/talk-victim.json")).unwrap(),
            "{}"
        );
        assert!(!outside.join("memory.md").exists());
        assert!(!outside.join("sessions/talk-x.json").exists());

        // A symlinked sessions folder inside a real ai folder is rejected too.
        fs::remove_file(project.join(".novelist/ai")).unwrap();
        fs::create_dir(project.join(".novelist/ai")).unwrap();
        std::os::unix::fs::symlink(
            outside.join("sessions"),
            project.join(".novelist/ai/sessions"),
        )
        .unwrap();
        let error = write_ai_session(
            project.to_string_lossy().to_string(),
            AiSessionKind::Talk,
            "victim".into(),
            "{\"overwritten\":true}".into(),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::PathNotAllowed(_)), "{error:?}");
        assert_eq!(
            fs::read_to_string(outside.join("sessions/talk-victim.json")).unwrap(),
            "{}"
        );
    }

    #[tokio::test]
    async fn prompt_assets_skip_hidden_and_unsupported() {
        let dir = tempdir().unwrap();
        let root = dir.path().join(".novelist").join("ai");
        let skills = root.join("skills");
        fs::create_dir_all(skills.join("line-editor")).unwrap();
        fs::write(skills.join("line-editor").join("SKILL.md"), "skill").unwrap();
        fs::write(skills.join(".hidden.md"), "hidden").unwrap();
        fs::write(skills.join("notes.txt"), "ignored").unwrap();
        fs::write(root.join("memory.md"), "memory").unwrap();

        let assets = list_ai_prompt_assets(dir.path().to_string_lossy().to_string())
            .await
            .unwrap();
        assert_eq!(assets.skills.len(), 1);
        assert_eq!(assets.skills[0].name, "SKILL");
        assert_eq!(assets.skills[0].id, "skills/line-editor/SKILL.md");
        assert_eq!(assets.memory.as_ref().unwrap().content, "memory");
    }

    #[tokio::test]
    async fn write_memory_overwrites_memory_md() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        write_ai_memory(root.clone(), "first".into()).await.unwrap();
        write_ai_memory(root.clone(), "second".into())
            .await
            .unwrap();
        let assets = list_ai_prompt_assets(root).await.unwrap();
        assert_eq!(assets.memory.unwrap().content, "second");
    }
}
