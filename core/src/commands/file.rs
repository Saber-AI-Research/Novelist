use crate::error::AppError;
use crate::models::file_state::FileEntry;
use crate::services::rename_migration::{
    acquire_draft_transaction_guard, collect_planned_mappings, load_matching_journal,
    load_pending_move_journal, migrate_rename_sidecars_guarded, reconcile_project_draft_sidecars,
    remove_rename_journal, write_rename_journal, RenameItemResult, RenameMigrationResult,
    RenameMigrationStatus,
};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;

use walkdir::WalkDir;

/// Shared state tracking the original encoding of files opened via `read_file`.
/// When `write_file` is called for a path in this map, content is re-encoded
/// to the original encoding before writing to disk.
pub struct EncodingState {
    /// Maps canonical file path -> encoding name (e.g. "GBK", "Big5", "Shift_JIS").
    /// UTF-8 files are NOT stored here; absence means UTF-8.
    pub(crate) encodings: Mutex<HashMap<String, &'static str>>,
}

impl EncodingState {
    pub fn new() -> Self {
        Self {
            encodings: Mutex::new(HashMap::new()),
        }
    }
}

static TEXT_WRITE_LOCKS: Lazy<Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn text_write_lock_key(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }

    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    match (parent.canonicalize(), path.file_name()) {
        (Ok(canonical_parent), Some(file_name)) => canonical_parent.join(file_name),
        _ => path.to_path_buf(),
    }
}

fn text_write_lock(path: &Path) -> Result<Arc<AsyncMutex<()>>, AppError> {
    let key = text_write_lock_key(path);
    let mut locks = TEXT_WRITE_LOCKS
        .lock()
        .map_err(|e| AppError::Custom(format!("Lock poisoned: {e}")))?;
    Ok(locks
        .entry(key)
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone())
}

/// Move every encoding entry under a renamed/moved path. Handles both a single
/// file (`old_canonical == key`) and descendants of a directory.
pub fn migrate_encoding_state_tree(
    state: &EncodingState,
    old_canonical: &Path,
    new_canonical: &Path,
) {
    let mut map = state.encodings.lock().expect("encodings lock");
    let mut updates = Vec::new();

    for (key, enc) in map.iter() {
        let key_path = PathBuf::from(key);
        let next_path = if key_path == old_canonical {
            Some(new_canonical.to_path_buf())
        } else if key_path.starts_with(old_canonical) {
            key_path
                .strip_prefix(old_canonical)
                .ok()
                .map(|suffix| new_canonical.join(suffix))
        } else {
            None
        };

        if let Some(next_path) = next_path {
            updates.push((key.clone(), next_path.to_string_lossy().to_string(), *enc));
        }
    }

    for (old_key, new_key, enc) in updates {
        map.remove(&old_key);
        map.insert(new_key, enc);
    }
}

/// Detect encoding from raw bytes. Returns the `encoding_rs::Encoding` label
/// and the decoded UTF-8 string.
pub(crate) fn decode_bytes(bytes: &[u8]) -> (Option<&'static str>, String) {
    // 1. Check for BOM
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        // UTF-8 BOM -- strip it and decode as UTF-8
        let text = String::from_utf8_lossy(&bytes[3..]).into_owned();
        return (None, text);
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        // UTF-16 LE BOM
        let (decoded, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        return (Some("UTF-16LE"), decoded.into_owned());
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        // UTF-16 BE BOM
        let (decoded, _, _) = encoding_rs::UTF_16BE.decode(bytes);
        return (Some("UTF-16BE"), decoded.into_owned());
    }

    // 2. Try UTF-8 first (fast path for the common case)
    if std::str::from_utf8(bytes).is_ok() {
        let text = unsafe { String::from_utf8_unchecked(bytes.to_vec()) };
        return (None, text);
    }

    // 3. Use chardetng for encoding detection
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
    detector.feed(bytes, true);
    let encoding = detector.guess(None, chardetng::Utf8Detection::Allow);
    let encoding_name = encoding.name();

    // Decode using the detected encoding
    let (decoded, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        tracing::warn!(
            "Encoding detection chose {} but decoding had replacement characters",
            encoding_name
        );
    }

    // If detected as UTF-8, treat as UTF-8 (no re-encoding needed)
    if encoding == encoding_rs::UTF_8 {
        (None, decoded.into_owned())
    } else {
        tracing::info!("Detected non-UTF-8 encoding: {}", encoding_name);
        (Some(encoding_name), decoded.into_owned())
    }
}

/// Encode a UTF-8 string back to the specified encoding.
fn encode_string(content: &str, encoding_name: &str) -> Result<Vec<u8>, AppError> {
    let encoding = encoding_rs::Encoding::for_label(encoding_name.as_bytes())
        .ok_or_else(|| AppError::Custom(format!("Unknown encoding: {}", encoding_name)))?;
    let (encoded, _, had_errors) = encoding.encode(content);
    if had_errors {
        tracing::warn!("Re-encoding to {} had unmappable characters", encoding_name);
    }
    Ok(encoded.into_owned())
}

fn validate_path(path: &str) -> Result<PathBuf, AppError> {
    if path.contains('\0') {
        return Err(AppError::PathNotAllowed(path.to_string()));
    }

    let p = PathBuf::from(path);

    // Block path traversal via ".." components
    for component in p.components() {
        if let std::path::Component::ParentDir = component {
            return Err(AppError::PathNotAllowed(format!(
                "Path traversal not allowed: {}",
                path
            )));
        }
    }

    #[cfg(unix)]
    {
        let blocked = ["/etc", "/System", "/usr", "/bin", "/sbin"];
        if p.is_absolute() && blocked.iter().any(|b| p.starts_with(b)) {
            return Err(AppError::PathNotAllowed(path.to_string()));
        }
    }

    #[cfg(windows)]
    {
        let lower = path.to_lowercase();
        let blocked = ["\\windows", "\\system32", "\\program files"];
        if blocked.iter().any(|b| lower.contains(b)) {
            return Err(AppError::PathNotAllowed(path.to_string()));
        }
    }

    Ok(p)
}

fn sanitize_filename(name: &str) -> Result<String, AppError> {
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains('\0') {
        return Err(AppError::InvalidInput(format!(
            "Invalid filename: {}",
            name
        )));
    }
    if name.is_empty() {
        return Err(AppError::InvalidInput(
            "Filename cannot be empty".to_string(),
        ));
    }
    Ok(name.to_string())
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SearchMatch {
    pub file_path: String,
    pub file_name: String,
    pub line_number: usize,
    pub line_text: String,
    pub match_start: usize,
    pub match_end: usize,
}

fn utf16_offset_at_byte(s: &str, byte_idx: usize) -> usize {
    s.get(..byte_idx)
        .map(|prefix| prefix.encode_utf16().count())
        .unwrap_or_else(|| s.encode_utf16().count())
}

fn fold_with_original_byte_map(s: &str) -> (String, Vec<usize>) {
    let mut folded = String::new();
    let mut map = Vec::new();

    for (byte_idx, ch) in s.char_indices() {
        for folded_ch in ch.to_lowercase() {
            let mut buf = [0u8; 4];
            let folded_part = folded_ch.encode_utf8(&mut buf);
            folded.push_str(folded_part);
            map.extend(std::iter::repeat_n(byte_idx, folded_part.len()));
        }
    }
    map.push(s.len());

    (folded, map)
}

fn original_byte_for_folded_byte(map: &[usize], folded_byte_idx: usize) -> usize {
    map.get(folded_byte_idx)
        .copied()
        .unwrap_or_else(|| map.last().copied().unwrap_or(0))
}

fn next_char_boundary(s: &str, byte_idx: usize) -> usize {
    if byte_idx >= s.len() {
        return s.len();
    }
    let mut idx = byte_idx + 1;
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

/// Internal: read a file with encoding detection, updating the encoding state.
pub(crate) async fn read_file_inner(
    path: &str,
    enc_state: &EncodingState,
) -> Result<String, AppError> {
    let p = validate_path(path)?;
    if !p.exists() {
        return Err(AppError::FileNotFound(path.to_string()));
    }

    // Read raw bytes so we can detect encoding
    let bytes = tokio::fs::read(&p).await?;
    decode_file_bytes(&p, &bytes, enc_state)
}

pub(crate) fn decode_file_bytes(
    path: &Path,
    bytes: &[u8],
    enc_state: &EncodingState,
) -> Result<String, AppError> {
    let (detected_encoding, content) = decode_bytes(bytes);

    // Store or clear encoding for this path
    let canonical = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string();
    {
        let mut map = enc_state
            .encodings
            .lock()
            .map_err(|e| AppError::Custom(format!("Lock poisoned: {}", e)))?;
        if let Some(enc) = detected_encoding {
            tracing::info!("Stored encoding {} for {}", enc, canonical);
            map.insert(canonical, enc);
        } else {
            map.remove(&canonical);
        }
    }

    Ok(content)
}

#[tauri::command]
#[specta::specta]
pub async fn read_file(
    path: String,
    encoding_state: tauri::State<'_, EncodingState>,
) -> Result<String, AppError> {
    read_file_inner(&path, &encoding_state).await
}

fn ensure_text_write_parent_exists(p: &Path) -> Result<(), AppError> {
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AppError::FileNotFound(format!(
                "Parent directory does not exist: {}",
                parent.display()
            )));
        }
    }
    Ok(())
}

/// Write a file while the caller holds this path's text-write lock.
async fn write_file_locked(
    p: &Path,
    content: &str,
    enc_state: &EncodingState,
    file_watcher_state: Option<&crate::services::file_watcher::FileWatcherState>,
) -> Result<(), AppError> {
    tracing::info!(
        "[write_file] path={}, content_bytes={}, content_lines={}",
        p.display(),
        content.len(),
        content.lines().count()
    );

    // Preserve the explicit missing-parent error used by the public writer.
    ensure_text_write_parent_exists(p)?;

    // Check if this file was originally read in a non-UTF-8 encoding
    let canonical = p
        .canonicalize()
        .unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .to_string();
    let encoding_name = {
        let map = enc_state
            .encodings
            .lock()
            .map_err(|e| AppError::Custom(format!("Lock poisoned: {}", e)))?;
        map.get(&canonical).copied()
    };

    let bytes: Vec<u8> = if let Some(enc) = encoding_name {
        tracing::info!("[write_file] Re-encoding to {} for {}", enc, canonical);
        encode_string(content, enc)?
    } else {
        content.as_bytes().to_vec()
    };

    let temp_path = format!("{}.novelist-tmp", p.display());
    tokio::fs::write(&temp_path, &bytes)
        .await
        .map_err(|e| AppError::Custom(format!("write {}: {}", temp_path, e)))?;
    if let Some(watcher_state) = file_watcher_state {
        crate::services::file_watcher::register_expected_write_inner(
            &p.to_string_lossy(),
            blake3::hash(&bytes),
            watcher_state,
        )?;
    }
    if let Err(error) = tokio::fs::rename(&temp_path, &p).await {
        if let Some(watcher_state) = file_watcher_state {
            let _ = crate::services::file_watcher::clear_expected_write_inner(
                &p.to_string_lossy(),
                watcher_state,
            );
        }
        return Err(AppError::Custom(format!(
            "rename {} -> {}: {}",
            temp_path,
            p.display(),
            error
        )));
    }
    Ok(())
}

/// Internal: write a file, re-encoding to original encoding if needed.
#[cfg(test)]
pub(crate) async fn write_file_inner(
    path: &str,
    content: &str,
    enc_state: &EncodingState,
) -> Result<(), AppError> {
    let p = validate_path(path)?;
    let mutex = text_write_lock(&p)?;
    let _guard = mutex.lock().await;
    write_file_locked(&p, content, enc_state, None).await
}

pub(crate) async fn write_file_with_watcher_inner(
    path: &str,
    content: &str,
    enc_state: &EncodingState,
    file_watcher_state: &crate::services::file_watcher::FileWatcherState,
) -> Result<(), AppError> {
    let p = validate_path(path)?;
    let mutex = text_write_lock(&p)?;
    let _guard = mutex.lock().await;
    write_file_locked(&p, content, enc_state, Some(file_watcher_state)).await
}

#[tauri::command]
#[specta::specta]
pub async fn write_file(
    path: String,
    content: String,
    encoding_state: tauri::State<'_, EncodingState>,
    file_watcher_state: tauri::State<'_, crate::services::file_watcher::FileWatcherState>,
) -> Result<(), AppError> {
    write_file_with_watcher_inner(&path, &content, &encoding_state, &file_watcher_state).await
}

#[derive(Debug, Clone, Copy, Serialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WriteFileIfUnchangedResult {
    Written,
    Conflict,
}

fn resolve_project_scoped_text_target(project_dir: &str, path: &str) -> Result<PathBuf, AppError> {
    let project = validate_path(project_dir)?;
    let canonical_project = project.canonicalize().map_err(|_| {
        AppError::InvalidInput("Active project root is not an existing directory".into())
    })?;
    if !canonical_project.is_dir() {
        return Err(AppError::InvalidInput(
            "Active project root is not a directory".into(),
        ));
    }

    let requested = validate_path(path)?;
    let effective_target = if requested.exists() {
        requested.canonicalize().map_err(|_| {
            AppError::InvalidInput("Conditional write target cannot be resolved".into())
        })?
    } else {
        ensure_text_write_parent_exists(&requested)?;
        let parent = requested
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or_else(|| AppError::InvalidInput("Conditional write target has no parent".into()))?
            .canonicalize()
            .map_err(|_| {
                AppError::InvalidInput("Conditional write parent cannot be resolved".into())
            })?;
        if !parent.is_dir() {
            return Err(AppError::InvalidInput(
                "Conditional write parent is not a directory".into(),
            ));
        }
        let file_name = requested.file_name().ok_or_else(|| {
            AppError::InvalidInput("Conditional write target has no filename".into())
        })?;
        parent.join(file_name)
    };

    if !effective_target.starts_with(&canonical_project) {
        return Err(AppError::InvalidInput(
            "Conditional write target resolves outside active project".into(),
        ));
    }
    Ok(effective_target)
}

/// Compare and write within the process-wide lock shared by Novelist text
/// writers. External processes can still race the final rename, so this is a
/// best-effort immediate conflict check rather than a cross-process CAS.
pub(crate) async fn write_file_if_unchanged_inner(
    project_dir: &str,
    path: &str,
    expected_content: Option<&str>,
    content: &str,
    enc_state: &EncodingState,
    file_watcher_state: &crate::services::file_watcher::FileWatcherState,
) -> Result<WriteFileIfUnchangedResult, AppError> {
    let p = resolve_project_scoped_text_target(project_dir, path)?;
    let effective_path = p.to_string_lossy().to_string();
    let mutex = text_write_lock(&p)?;
    let _guard = mutex.lock().await;
    ensure_text_write_parent_exists(&p)?;

    let matches_expected = match expected_content {
        None => !p.exists(),
        Some(_) if !p.exists() => false,
        Some(expected) => read_file_inner(&effective_path, enc_state).await? == expected,
    };
    if !matches_expected {
        return Ok(WriteFileIfUnchangedResult::Conflict);
    }

    write_file_locked(&p, content, enc_state, Some(file_watcher_state)).await?;
    Ok(WriteFileIfUnchangedResult::Written)
}

#[tauri::command]
#[specta::specta]
pub async fn write_file_if_unchanged(
    project_dir: String,
    path: String,
    expected_content: Option<String>,
    content: String,
    encoding_state: tauri::State<'_, EncodingState>,
    file_watcher_state: tauri::State<'_, crate::services::file_watcher::FileWatcherState>,
) -> Result<WriteFileIfUnchangedResult, AppError> {
    write_file_if_unchanged_inner(
        &project_dir,
        &path,
        expected_content.as_deref(),
        &content,
        &encoding_state,
        &file_watcher_state,
    )
    .await
}

/// Returns the detected encoding for a file that was previously read via `read_file`.
/// Returns `"UTF-8"` if the file is UTF-8 (or was never read).
#[tauri::command]
#[specta::specta]
pub async fn get_file_encoding(
    path: String,
    encoding_state: tauri::State<'_, EncodingState>,
) -> Result<String, AppError> {
    let p = validate_path(&path)?;
    let canonical = p
        .canonicalize()
        .unwrap_or_else(|_| p.clone())
        .to_string_lossy()
        .to_string();
    let map = encoding_state
        .encodings
        .lock()
        .map_err(|e| AppError::Custom(format!("Lock poisoned: {}", e)))?;
    Ok(map.get(&canonical).copied().unwrap_or("UTF-8").to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn list_directory(
    path: String,
    show_hidden: Option<bool>,
) -> Result<Vec<FileEntry>, AppError> {
    let p = validate_path(&path)?;
    if !p.is_dir() {
        return Err(AppError::NotADirectory(path));
    }
    if p.join(".novelist/drafts").is_dir() {
        reconcile_project_draft_sidecars(&p).await?;
    }

    let show_hidden = show_hidden.unwrap_or(false);
    let mut entries = Vec::new();
    let mut read_dir = tokio::fs::read_dir(&path).await?;

    while let Some(entry) = read_dir.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();

        // Hidden filter: skip every dotfile (including `.novelist`) unless
        // `show_hidden`. Users who want to see or edit project config turn
        // the toggle on from the sidebar view menu.
        if !show_hidden && name.starts_with('.') {
            continue;
        }

        let metadata = entry.metadata().await?;
        let mtime = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        let ctime = metadata
            .created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        entries.push(FileEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            mtime,
            ctime,
        });
    }

    Ok(entries)
}

#[tauri::command]
#[specta::specta]
pub async fn create_file(parent_dir: String, filename: String) -> Result<String, AppError> {
    let parent = validate_path(&parent_dir)?;
    let safe_name = sanitize_filename(&filename)?;
    let mut file_path = parent.join(&safe_name);

    if file_path.exists() {
        // Auto-generate unique name: "file.md" → "file 2.md" → "file 3.md"
        let p = std::path::Path::new(&safe_name);
        let stem = p
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let ext = p
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mut counter = 2u32;
        loop {
            file_path = parent.join(format!("{stem} {counter}{ext}"));
            if !file_path.exists() {
                break;
            }
            counter += 1;
        }
    }

    tokio::fs::write(&file_path, "").await?;
    Ok(file_path.to_string_lossy().to_string())
}

/// Create a scratch file in ~/.cache/novelist/ for single-file mode.
/// Filename pattern: `novelist_scratch_<unix_millis>.md`
/// This pattern is checked by the frontend to detect unsaved scratch files.
/// Returns the absolute path of the created file.
#[tauri::command]
#[specta::specta]
pub async fn create_scratch_file() -> Result<String, AppError> {
    let cache_dir = dirs::cache_dir()
        .ok_or_else(|| AppError::Custom("Cannot determine cache directory".into()))?
        .join("novelist");
    tokio::fs::create_dir_all(&cache_dir).await?;

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let file_name = format!("novelist_scratch_{}.md", ts);
    let file_path = cache_dir.join(&file_name);

    tokio::fs::write(&file_path, "").await?;
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn create_directory(parent_dir: String, name: String) -> Result<String, AppError> {
    let parent = validate_path(&parent_dir)?;
    let safe_name = sanitize_filename(&name)?;
    let mut dir_path = parent.join(&safe_name);

    if dir_path.exists() {
        // Auto-generate unique name: "folder" → "folder 2" → "folder 3"
        let mut counter = 2u32;
        loop {
            dir_path = parent.join(format!("{safe_name} {counter}"));
            if !dir_path.exists() {
                break;
            }
            counter += 1;
        }
    }

    tokio::fs::create_dir(&dir_path).await?;
    Ok(dir_path.to_string_lossy().to_string())
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct FileRenamedPayload {
    pub old_path: String,
    pub new_path: String,
    pub migration: Option<crate::services::rename_migration::RenameMigrationResult>,
}

/// Emit a global Tauri event so other windows can update their tab state.
#[tauri::command]
#[specta::specta]
pub async fn broadcast_file_renamed(
    old_path: String,
    new_path: String,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    use tauri::Emitter;
    app.emit(
        "file-renamed",
        legacy_file_renamed_payload(&old_path, &new_path),
    )
    .map_err(|e| AppError::Custom(format!("emit failed: {e}")))?;
    Ok(())
}

fn legacy_file_renamed_payload(old_path: &str, new_path: &str) -> FileRenamedPayload {
    FileRenamedPayload {
        old_path: old_path.to_string(),
        new_path: new_path.to_string(),
        migration: None,
    }
}

fn emit_file_renamed<F>(
    old_path: &str,
    result: &RenameItemResult,
    mut emit: F,
) -> Result<(), AppError>
where
    F: FnMut(FileRenamedPayload) -> Result<(), AppError>,
{
    emit(FileRenamedPayload {
        old_path: old_path.to_string(),
        new_path: result.new_path.clone(),
        migration: Some(result.migration.clone()),
    })
}

fn emit_file_renamed_soft<F>(old_path: &str, result: &mut RenameItemResult, emit: F)
where
    F: FnMut(FileRenamedPayload) -> Result<(), AppError>,
{
    record_rename_step("emit-file-renamed");
    if let Err(err) = emit_file_renamed(old_path, result, emit) {
        result.migration.status = RenameMigrationStatus::UserFileRenamedWithMetadataErrors;
        result
            .migration
            .errors
            .push(format!("broadcast file-renamed failed: {err}"));
    }
}

#[cfg(test)]
fn rename_op_log() -> &'static Mutex<Vec<&'static str>> {
    static LOG: std::sync::OnceLock<Mutex<Vec<&'static str>>> = std::sync::OnceLock::new();
    LOG.get_or_init(|| Mutex::new(Vec::new()))
}

#[cfg(test)]
fn rename_op_log_owner() -> &'static Mutex<Option<std::thread::ThreadId>> {
    static OWNER: std::sync::OnceLock<Mutex<Option<std::thread::ThreadId>>> =
        std::sync::OnceLock::new();
    OWNER.get_or_init(|| Mutex::new(None))
}

#[cfg(test)]
fn reset_rename_op_log() {
    rename_op_log().lock().unwrap().clear();
    *rename_op_log_owner().lock().unwrap() = Some(std::thread::current().id());
}

#[cfg(test)]
fn take_rename_op_log() -> Vec<&'static str> {
    *rename_op_log_owner().lock().unwrap() = None;
    std::mem::take(&mut *rename_op_log().lock().unwrap())
}

#[cfg(test)]
fn record_rename_step(step: &'static str) {
    if *rename_op_log_owner().lock().unwrap() != Some(std::thread::current().id()) {
        return;
    }
    rename_op_log().lock().unwrap().push(step);
}

#[cfg(not(test))]
fn record_rename_step(_step: &'static str) {}

/// Rename a file or folder in place.
/// When `allow_collision_bump` is Some(true), appends " 2", " 3", … on collision.
/// Defaults to error-on-collision when None or Some(false).
#[tauri::command]
#[specta::specta]
pub async fn rename_item(
    project_dir: String,
    old_path: String,
    new_name: String,
    allow_collision_bump: Option<bool>,
    encoding_state: tauri::State<'_, EncodingState>,
    app: tauri::AppHandle,
) -> Result<RenameItemResult, AppError> {
    let result = rename_item_inner(
        project_dir,
        old_path.clone(),
        new_name,
        allow_collision_bump,
        &encoding_state,
    )
    .await?;
    let mut result = result;
    use tauri::Emitter;
    emit_file_renamed_soft(&old_path, &mut result, |payload| {
        app.emit("file-renamed", payload)
            .map_err(|e| AppError::Custom(format!("emit failed: {e}")))
    });
    Ok(result)
}

pub(crate) async fn rename_item_inner(
    project_dir: String,
    old_path: String,
    new_name: String,
    allow_collision_bump: Option<bool>,
    encoding_state: &EncodingState,
) -> Result<RenameItemResult, AppError> {
    let project_dir = validate_project_dir(&project_dir)?;
    let old = validate_path(&old_path)?;
    let safe_name = sanitize_filename(&new_name)?;
    let parent = old
        .parent()
        .ok_or_else(|| AppError::Custom("Cannot determine parent directory".to_string()))?;
    let mut new_path = parent.join(&safe_name);
    ensure_rename_paths_inside_project(&project_dir, &old, &new_path)?;
    let _draft_guard = acquire_draft_transaction_guard(&project_dir).await?;

    if !old.exists() {
        if new_path.exists() {
            let journal = match load_matching_journal(&project_dir, &old, &new_path).await {
                Ok(Some(journal)) => journal,
                Ok(None) => return Err(AppError::FileNotFound(old_path)),
                Err(err) => {
                    return Ok(RenameItemResult {
                        new_path: new_path.to_string_lossy().to_string(),
                        migration: RenameMigrationResult {
                            status: RenameMigrationStatus::UserFileRenamedWithMetadataErrors,
                            migrated: 0,
                            conflicts: 0,
                            errors: vec![format!(
                                "rename journal invalid after filesystem rename: old={} final={} error={}",
                                old.display(),
                                new_path.display(),
                                err
                            )],
                        },
                    })
                }
            };
            let mut migration =
                migrate_rename_sidecars_guarded(&project_dir, &journal.journal.mappings, true)
                    .await;
            if matches!(migration.status, RenameMigrationStatus::IdempotentRetry) {
                if let Err(err) = remove_rename_journal(&journal.path).await {
                    migration.status = RenameMigrationStatus::UserFileRenamedWithMetadataErrors;
                    migration.errors.push(format!(
                        "remove rename journal failed: path={} error={}",
                        journal.path.display(),
                        err
                    ));
                }
            }
            return Ok(RenameItemResult {
                new_path: new_path.to_string_lossy().to_string(),
                migration,
            });
        }
        return Err(AppError::FileNotFound(old_path));
    }

    if new_path.exists() && new_path != old {
        if allow_collision_bump.unwrap_or(false) {
            let p = std::path::Path::new(&safe_name);
            let stem = p
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let ext = p
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let mut counter = 2u32;
            loop {
                new_path = parent.join(format!("{stem} {counter}{ext}"));
                if !new_path.exists() || new_path == old {
                    break;
                }
                counter += 1;
            }
        } else {
            return Err(AppError::Custom(format!(
                "Already exists: {}",
                new_path.display()
            )));
        }
    }

    let mappings = collect_planned_mappings(&old, &new_path)?;
    let journal = write_rename_journal(&project_dir, &old, &new_path, &mappings).await?;

    // Canonicalize the OLD path BEFORE the rename -- after the rename, the old
    // file no longer exists and canonicalize would fail.
    let old_canon = old
        .canonicalize()
        .ok()
        .map(|p| p.to_string_lossy().to_string());
    // Suppress the imminent file-watcher events for the old and new paths so
    // the frontend doesn't reload the file (which would lose editor state).
    crate::services::file_watcher::register_rename_ignore(
        old.to_string_lossy().to_string(),
        new_path.to_string_lossy().to_string(),
    )
    .await;
    record_rename_step("watcher-ignore");
    record_rename_step("filesystem-rename");
    tokio::fs::rename(&old, &new_path).await?;
    record_rename_step("metadata-migration");
    let mut migration = migrate_rename_sidecars_guarded(&project_dir, &mappings, false).await;
    if matches!(migration.status, RenameMigrationStatus::FullSuccess) {
        if let Err(err) = remove_rename_journal(&journal.path).await {
            migration.status = RenameMigrationStatus::UserFileRenamedWithMetadataErrors;
            migration.errors.push(format!(
                "remove rename journal failed: path={} error={}",
                journal.path.display(),
                err
            ));
        }
    }
    // Canonicalize the NEW path AFTER the rename so the target exists.
    let new_canon = new_path
        .canonicalize()
        .ok()
        .map(|p| p.to_string_lossy().to_string());
    if let (Some(o), Some(n)) = (old_canon, new_canon) {
        migrate_encoding_state_tree(encoding_state, Path::new(&o), Path::new(&n));
    }
    Ok(RenameItemResult {
        new_path: new_path.to_string_lossy().to_string(),
        migration,
    })
}

fn validate_project_dir(project_dir: &str) -> Result<PathBuf, AppError> {
    let project = validate_path(project_dir)?;
    if !project.is_dir() {
        return Err(AppError::NotADirectory(project_dir.to_string()));
    }
    Ok(project)
}

fn canonicalize_existing_or_planned_path(path: &Path) -> Result<PathBuf, AppError> {
    match path.canonicalize() {
        Ok(canonical) => Ok(canonical),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or_else(|| {
                AppError::PathNotAllowed(format!("path has no parent: {}", path.display()))
            })?;
            let file_name = path.file_name().ok_or_else(|| {
                AppError::PathNotAllowed(format!("path has no file name: {}", path.display()))
            })?;
            Ok(parent.canonicalize().map_err(AppError::Io)?.join(file_name))
        }
        Err(error) => Err(AppError::Io(error)),
    }
}

fn ensure_rename_paths_inside_project(
    project_dir: &Path,
    old_path: &Path,
    final_path: &Path,
) -> Result<(), AppError> {
    let canonical_project = project_dir.canonicalize().map_err(AppError::Io)?;
    for path in [old_path, final_path] {
        let canonical = canonicalize_existing_or_planned_path(path)?;
        if !canonical.starts_with(&canonical_project) {
            return Err(AppError::PathNotAllowed(format!(
                "rename path outside project: project={} path={}",
                project_dir.display(),
                path.display()
            )));
        }
    }
    Ok(())
}

/// Move a file or folder into `target_dir`. Auto-numbers on collision
/// ("a.md" -> "a 2.md"). Rejects moving a folder into its own descendant.
#[tauri::command]
#[specta::specta]
pub async fn move_item(
    project_dir: String,
    source_path: String,
    target_dir: String,
    encoding_state: tauri::State<'_, EncodingState>,
    app: tauri::AppHandle,
) -> Result<RenameItemResult, AppError> {
    let mut result = move_item_inner(
        project_dir,
        source_path.clone(),
        target_dir,
        &encoding_state,
    )
    .await?;
    use tauri::Emitter;
    emit_file_renamed_soft(&source_path, &mut result, |payload| {
        app.emit("file-renamed", payload)
            .map_err(|e| AppError::Custom(format!("emit failed: {e}")))
    });
    Ok(result)
}

pub(crate) async fn move_item_inner(
    project_dir: String,
    source_path: String,
    target_dir: String,
    encoding_state: &EncodingState,
) -> Result<RenameItemResult, AppError> {
    let project_dir = validate_project_dir(&project_dir)?;
    let source = validate_path(&source_path)?;
    let target = validate_path(&target_dir)?;
    let _draft_guard = acquire_draft_transaction_guard(&project_dir).await?;

    if !source.exists() {
        if let Some(journal) = load_pending_move_journal(&project_dir, &source, &target).await? {
            if !journal.journal.final_path.exists() {
                return Err(AppError::FileNotFound(source_path));
            }
            let mut migration =
                migrate_rename_sidecars_guarded(&project_dir, &journal.journal.mappings, true)
                    .await;
            if matches!(migration.status, RenameMigrationStatus::IdempotentRetry) {
                if let Err(err) = remove_rename_journal(&journal.path).await {
                    migration.status = RenameMigrationStatus::UserFileRenamedWithMetadataErrors;
                    migration.errors.push(format!(
                        "remove rename journal failed: path={} error={}",
                        journal.path.display(),
                        err
                    ));
                }
            }
            return Ok(RenameItemResult {
                new_path: journal.journal.final_path.to_string_lossy().to_string(),
                migration,
            });
        }
        return Err(AppError::FileNotFound(source_path));
    }
    if !target.is_dir() {
        return Err(AppError::NotADirectory(target_dir));
    }
    ensure_rename_paths_inside_project(&project_dir, &source, &target)?;

    // Reject moving a folder into its own descendant.
    // Canonicalize both so symlinks and trailing slashes don't spoof the check.
    let src_canon = tokio::fs::canonicalize(&source).await?;
    let tgt_canon = tokio::fs::canonicalize(&target).await?;
    if tgt_canon.starts_with(&src_canon) {
        return Err(AppError::InvalidInput(
            "Cannot move a folder into its own descendant".to_string(),
        ));
    }

    // Reject no-op: source is already directly inside target.
    // Use canonicalized paths so trailing slashes / symlinks don't spoof the check.
    if src_canon.parent().map(|p| p == tgt_canon).unwrap_or(false) {
        return Err(AppError::InvalidInput(
            "Source is already in the target directory".to_string(),
        ));
    }

    let file_name = source
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("Source has no file name".to_string()))?;
    let mut dest = target.join(file_name);

    // Auto-number on collision: "foo.md" -> "foo 2.md" -> "foo 3.md".
    if dest.exists() {
        let stem = dest
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let ext = dest
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mut counter = 2u32;
        loop {
            dest = target.join(format!("{stem} {counter}{ext}"));
            if !dest.exists() {
                break;
            }
            counter += 1;
        }
    }
    ensure_rename_paths_inside_project(&project_dir, &source, &dest)?;
    let mappings = collect_planned_mappings(&source, &dest)?;
    let journal = write_rename_journal(&project_dir, &source, &dest, &mappings).await?;

    let old_canon = source
        .canonicalize()
        .ok()
        .map(|p| p.to_string_lossy().to_string());

    crate::services::file_watcher::register_rename_ignore(
        source.to_string_lossy().to_string(),
        dest.to_string_lossy().to_string(),
    )
    .await;
    tokio::fs::rename(&source, &dest).await?;
    let mut migration = migrate_rename_sidecars_guarded(&project_dir, &mappings, false).await;
    if matches!(migration.status, RenameMigrationStatus::FullSuccess) {
        if let Err(err) = remove_rename_journal(&journal.path).await {
            migration.status = RenameMigrationStatus::UserFileRenamedWithMetadataErrors;
            migration.errors.push(format!(
                "remove rename journal failed: path={} error={}",
                journal.path.display(),
                err
            ));
        }
    }
    let new_canon = dest
        .canonicalize()
        .ok()
        .map(|p| p.to_string_lossy().to_string());
    if let (Some(o), Some(n)) = (old_canon, new_canon) {
        migrate_encoding_state_tree(encoding_state, Path::new(&o), Path::new(&n));
    }
    Ok(RenameItemResult {
        new_path: dest.to_string_lossy().to_string(),
        migration,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn delete_item(path: String) -> Result<(), AppError> {
    let p = validate_path(&path)?;
    if !p.exists() {
        return Err(AppError::FileNotFound(path));
    }
    if p.is_symlink() {
        // Remove the symlink itself, not its target
        tokio::fs::remove_file(&p).await?;
    } else if p.is_dir() {
        tokio::fs::remove_dir_all(&p).await?;
    } else {
        tokio::fs::remove_file(&p).await?;
    }
    Ok(())
}

/// Reveal a file or folder in the platform's file manager (Finder on macOS).
#[tauri::command]
#[specta::specta]
pub async fn reveal_in_file_manager(path: String) -> Result<(), AppError> {
    let p = validate_path(&path)?;
    if !p.exists() {
        return Err(AppError::FileNotFound(path));
    }
    #[cfg(target_os = "macos")]
    {
        tokio::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .status()
            .await?;
    }
    #[cfg(target_os = "windows")]
    {
        tokio::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .status()
            .await?;
    }
    #[cfg(target_os = "linux")]
    {
        // Open the parent directory; most Linux file managers don't support select
        let parent = p.parent().unwrap_or(&p);
        tokio::process::Command::new("xdg-open")
            .arg(parent.to_string_lossy().as_ref())
            .status()
            .await?;
    }
    Ok(())
}

/// Duplicate a file. Returns the path of the new copy.
#[tauri::command]
#[specta::specta]
pub async fn duplicate_file(path: String) -> Result<String, AppError> {
    let p = validate_path(&path)?;
    if !p.exists() {
        return Err(AppError::FileNotFound(path));
    }
    if p.is_dir() {
        return Err(AppError::InvalidInput(
            "Cannot duplicate a directory".to_string(),
        ));
    }

    let parent = p
        .parent()
        .ok_or_else(|| AppError::Custom("Cannot determine parent directory".to_string()))?;
    let stem = p
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    // Find a unique name: "file copy.md", "file copy 2.md", etc.
    let mut new_path = parent.join(format!("{stem} copy{ext}"));
    let mut counter = 2u32;
    while new_path.exists() {
        new_path = parent.join(format!("{stem} copy {counter}{ext}"));
        counter += 1;
    }

    tokio::fs::copy(&p, &new_path).await?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn search_in_project(
    dir_path: String,
    query: String,
) -> Result<Vec<SearchMatch>, AppError> {
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let query_lower = query.to_lowercase();
    if query_lower.is_empty() {
        return Ok(Vec::new());
    }
    let extensions = ["md", "markdown", "txt", "json", "jsonl", "csv"];
    let max_matches = 200usize;
    let mut matches = Vec::new();
    let root_path = Path::new(&dir_path);

    for entry in WalkDir::new(&dir_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();
        let relative_path = path.strip_prefix(root_path).unwrap_or(path);
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !extensions.contains(&ext) {
            continue;
        }

        // Skip hidden directories/files
        if relative_path
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        {
            // Allow .novelist but skip other hidden dirs
            let has_hidden = relative_path.components().any(|c| {
                let s = c.as_os_str().to_string_lossy();
                s.starts_with('.') && s != ".novelist"
            });
            if has_hidden {
                continue;
            }
        }

        let file_path_str = path.to_string_lossy().to_string();
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let content = match tokio::fs::read_to_string(path).await {
            Ok(c) => c,
            Err(_) => continue,
        };

        for (line_idx, line) in content.lines().enumerate() {
            let (line_lower, folded_to_original) = fold_with_original_byte_map(line);
            let mut search_start = 0;
            while let Some(pos) = line_lower[search_start..].find(&query_lower) {
                let folded_start = search_start + pos;
                let folded_end = folded_start + query_lower.len();
                let original_start =
                    original_byte_for_folded_byte(&folded_to_original, folded_start);
                let original_end = original_byte_for_folded_byte(&folded_to_original, folded_end);
                matches.push(SearchMatch {
                    file_path: file_path_str.clone(),
                    file_name: file_name.clone(),
                    line_number: line_idx + 1,
                    line_text: line.to_string(),
                    match_start: utf16_offset_at_byte(line, original_start),
                    match_end: utf16_offset_at_byte(line, original_end),
                });
                if matches.len() >= max_matches {
                    return Ok(matches);
                }
                search_start = next_char_boundary(&line_lower, folded_start);
            }
        }
    }

    Ok(matches)
}

/// Write raw bytes (passed as base64) to a file. Used by the frontend to save
/// pasted/dropped images without UTF-8 encoding corruption.
#[tauri::command]
#[specta::specta]
pub async fn write_binary_file(path: String, base64_data: String) -> Result<(), AppError> {
    use base64::Engine;
    let p = validate_path(&path)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| AppError::InvalidInput(format!("Invalid base64: {}", e)))?;

    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AppError::FileNotFound(format!(
                "Parent directory does not exist: {}",
                parent.display()
            )));
        }
    }

    // Atomic write: temp file then rename
    let temp_path = format!("{}.novelist-tmp", p.display());
    tokio::fs::write(&temp_path, &bytes)
        .await
        .map_err(|e| AppError::Custom(format!("write {}: {}", temp_path, e)))?;
    tokio::fs::rename(&temp_path, &p)
        .await
        .map_err(|e| AppError::Custom(format!("rename {} -> {}: {}", temp_path, p.display(), e)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Helper: create a fresh EncodingState for testing.
    fn enc() -> EncodingState {
        EncodingState::new()
    }

    fn sidecar_for(project: &Path, subdir: &str, file: &Path, suffix: &str) -> PathBuf {
        let key = crate::services::sidecar::document_key(project, file).unwrap();
        crate::services::sidecar::sidecar_path(project, subdir, &key, suffix).unwrap()
    }

    fn write_with_parent(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[tokio::test]
    async fn test_read_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("test.md");
        fs::write(&file_path, "# Hello\n\nWorld").unwrap();
        let content = read_file_inner(&file_path.to_string_lossy(), &enc())
            .await
            .unwrap();
        assert_eq!(content, "# Hello\n\nWorld");
    }

    #[tokio::test]
    async fn test_read_file_not_found() {
        let result = read_file_inner("/nonexistent/path.md", &enc()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_write_file_atomic() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("output.md");
        write_file_inner(&file_path.to_string_lossy(), "# New Content", &enc())
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
        let entries = list_directory(dir.path().to_string_lossy().to_string(), None)
            .await
            .unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(entries.len(), 3);
        assert!(names.contains(&"chapters"));
        assert!(names.contains(&"a.md"));
        assert!(names.contains(&"b.md"));
        assert!(!names.contains(&".hidden"));
        assert!(entries
            .iter()
            .find(|e| e.name == "chapters")
            .map(|e| e.is_dir)
            .unwrap_or(false));
        assert!(
            entries.iter().any(|e| e.mtime.is_some()),
            "at least one entry should have mtime"
        );
    }

    #[tokio::test]
    async fn test_project_root_listing_reconciles_claimed_legacy_drafts_and_retains_orphans() {
        use crate::services::sidecar::{document_key, sidecar_path};

        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let file = project.join("chapters/第一章.md");
        let recovery = PathBuf::from(format!("{}.~recovery", file.display()));
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "# 第一章").unwrap();
        let drafts = project.join(".novelist/drafts");
        fs::create_dir_all(&drafts).unwrap();
        let legacy = drafts.join("chapters__第一章.md.draft.md");
        let legacy_recovery = drafts.join("chapters__第一章.md.~recovery.draft.md");
        let orphan = drafts.join("orphan__missing.md.draft.md");
        fs::write(&legacy, "legacy note").unwrap();
        fs::write(&legacy_recovery, "legacy recovery").unwrap();
        fs::write(&orphan, "ownerless note").unwrap();

        list_directory(project.display().to_string(), None)
            .await
            .unwrap();

        let canonical = sidecar_path(
            project,
            "drafts",
            &document_key(project, &file).unwrap(),
            ".draft.md",
        )
        .unwrap();
        let canonical_recovery = sidecar_path(
            project,
            "drafts",
            &document_key(project, &recovery).unwrap(),
            ".draft.md",
        )
        .unwrap();
        assert_eq!(fs::read_to_string(canonical).unwrap(), "legacy note");
        assert_eq!(
            fs::read_to_string(canonical_recovery).unwrap(),
            "legacy recovery"
        );
        assert!(!legacy.exists());
        assert!(!legacy_recovery.exists());
        assert_eq!(fs::read_to_string(orphan).unwrap(), "ownerless note");
    }

    #[tokio::test]
    async fn test_list_directory_returns_unsorted() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("z.md"), "").unwrap();
        fs::write(dir.path().join("a.md"), "").unwrap();
        let result = list_directory(dir.path().to_string_lossy().to_string(), None)
            .await
            .unwrap();
        let names: Vec<&str> = result.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names.len(), 2);
        assert!(names.contains(&"a.md"));
        assert!(names.contains(&"z.md"));
    }

    #[tokio::test]
    async fn test_list_directory_hides_dot_novelist_by_default() {
        // `.novelist` used to be exempt from the hidden filter. We now hide
        // every dotfile unless show_hidden=true — keeps the sidebar clean;
        // users toggle visibility via the view menu.
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join(".novelist")).unwrap();
        fs::write(dir.path().join(".other_hidden"), "").unwrap();
        fs::write(dir.path().join("visible.md"), "").unwrap();

        let hidden = list_directory(dir.path().to_string_lossy().to_string(), None)
            .await
            .unwrap();
        let hidden_names: Vec<&str> = hidden.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(hidden_names, vec!["visible.md"]);

        let shown = list_directory(dir.path().to_string_lossy().to_string(), Some(true))
            .await
            .unwrap();
        let shown_names: Vec<&str> = shown.iter().map(|e| e.name.as_str()).collect();
        assert!(shown_names.contains(&".novelist"));
        assert!(shown_names.contains(&".other_hidden"));
        assert!(shown_names.contains(&"visible.md"));
    }

    #[tokio::test]
    async fn test_list_directory_not_found() {
        let result = list_directory("/nonexistent/dir".to_string(), None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_list_directory_not_a_dir() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("file.txt");
        fs::write(&file_path, "").unwrap();
        let result = list_directory(file_path.to_string_lossy().to_string(), None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_search_in_project_returns_utf16_offsets() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("chapter.md"), "前缀你好 emoji🙂结尾\n").unwrap();

        let matches = search_in_project(dir.path().to_string_lossy().to_string(), "你好".into())
            .await
            .unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].match_start, 2);
        assert_eq!(matches[0].match_end, 4);
    }

    #[tokio::test]
    async fn test_search_in_project_is_case_insensitive_for_unicode() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("chapter.md"), "前缀Éclair\n").unwrap();

        let matches = search_in_project(dir.path().to_string_lossy().to_string(), "é".into())
            .await
            .unwrap();

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].match_start, 2);
        assert_eq!(matches[0].match_end, 3);
    }

    #[tokio::test]
    async fn test_list_directory_show_hidden_true_includes_dotfiles() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("visible.md"), "").unwrap();
        fs::write(dir.path().join(".hidden"), "").unwrap();
        fs::create_dir(dir.path().join(".DS_Store_dir")).unwrap();
        fs::create_dir(dir.path().join(".novelist")).unwrap();

        let entries = list_directory(dir.path().to_string_lossy().to_string(), Some(true))
            .await
            .unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"visible.md"));
        assert!(names.contains(&".hidden"));
        assert!(names.contains(&".DS_Store_dir"));
        assert!(names.contains(&".novelist"));
    }

    #[tokio::test]
    async fn test_list_directory_show_hidden_false_is_default() {
        // Omitting the flag (None) must behave exactly like show_hidden=false
        // for backward compatibility.
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.md"), "").unwrap();
        fs::write(dir.path().join(".hidden"), "").unwrap();
        let none_entries = list_directory(dir.path().to_string_lossy().to_string(), None)
            .await
            .unwrap();
        let false_entries = list_directory(dir.path().to_string_lossy().to_string(), Some(false))
            .await
            .unwrap();
        let n: Vec<&str> = none_entries.iter().map(|e| e.name.as_str()).collect();
        let f: Vec<&str> = false_entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(n, f);
        assert!(!n.contains(&".hidden"));
    }

    #[tokio::test]
    async fn test_create_file() {
        let dir = TempDir::new().unwrap();
        let result = create_file(
            dir.path().to_string_lossy().to_string(),
            "new.md".to_string(),
        )
        .await
        .unwrap();
        assert!(result.ends_with("new.md"));
        assert!(Path::new(&result).exists());
        assert_eq!(fs::read_to_string(&result).unwrap(), "");
    }

    #[tokio::test]
    async fn test_create_file_already_exists() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("exists.md"), "content").unwrap();
        let result = create_file(
            dir.path().to_string_lossy().to_string(),
            "exists.md".to_string(),
        )
        .await
        .unwrap();
        assert!(result.ends_with("exists 2.md"));
        assert!(Path::new(&result).exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("exists.md")).unwrap(),
            "content"
        );
    }

    #[tokio::test]
    async fn test_create_directory() {
        let dir = TempDir::new().unwrap();
        let result = create_directory(
            dir.path().to_string_lossy().to_string(),
            "chapters".to_string(),
        )
        .await
        .unwrap();
        assert!(Path::new(&result).is_dir());
    }

    #[tokio::test]
    async fn test_create_directory_already_exists() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("chapters")).unwrap();
        let result = create_directory(
            dir.path().to_string_lossy().to_string(),
            "chapters".to_string(),
        )
        .await
        .unwrap();
        assert!(result.ends_with("chapters 2"));
        assert!(Path::new(&result).is_dir());
        assert!(dir.path().join("chapters").is_dir());
    }

    #[tokio::test]
    async fn test_rename_item() {
        let dir = TempDir::new().unwrap();
        let old_path = dir.path().join("old.md");
        fs::write(&old_path, "content").unwrap();
        let state = enc();
        let new_path = rename_item_inner(
            dir.path().to_string_lossy().to_string(),
            old_path.to_string_lossy().to_string(),
            "new.md".to_string(),
            None,
            &state,
        )
        .await
        .unwrap();
        assert!(!old_path.exists());
        assert!(Path::new(&new_path.new_path).exists());
        assert_eq!(fs::read_to_string(&new_path.new_path).unwrap(), "content");
        assert!(
            load_matching_journal(dir.path(), &old_path, Path::new(&new_path.new_path))
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn test_rename_item_uses_explicit_project_root_for_nested_file() {
        use crate::services::sidecar::{document_key, sidecar_path};

        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let nested = project.join("chapters/deep");
        fs::create_dir_all(&nested).unwrap();
        let old_path = nested.join("old.md");
        let new_path = nested.join("new.md");
        fs::write(&old_path, "content").unwrap();

        let old_key = document_key(project, &old_path).unwrap();
        let old_sidecar = sidecar_path(project, "publish", &old_key, ".json").unwrap();
        fs::create_dir_all(old_sidecar.parent().unwrap()).unwrap();
        fs::write(&old_sidecar, "publish").unwrap();

        let result = rename_item_inner(
            project.to_string_lossy().to_string(),
            old_path.to_string_lossy().to_string(),
            "new.md".to_string(),
            None,
            &enc(),
        )
        .await
        .unwrap();

        assert_eq!(result.new_path, new_path.to_string_lossy());
        assert!(project.join(".novelist/publish").is_dir());
        assert!(
            !nested.join(".novelist").exists(),
            "nested file rename must not infer the file parent as project root"
        );
        let new_key = document_key(project, &new_path).unwrap();
        assert!(sidecar_path(project, "publish", &new_key, ".json")
            .unwrap()
            .exists());
    }

    #[tokio::test]
    async fn test_rename_empty_folder_succeeds_with_empty_journal_mappings() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old_path = project.join("empty-folder");
        let new_path = project.join("renamed-folder");
        fs::create_dir(&old_path).unwrap();

        let result = rename_item_inner(
            project.to_string_lossy().to_string(),
            old_path.to_string_lossy().to_string(),
            "renamed-folder".to_string(),
            None,
            &enc(),
        )
        .await
        .unwrap();

        assert_eq!(result.migration.status, RenameMigrationStatus::FullSuccess);
        assert_eq!(result.migration.migrated, 0);
        assert!(!old_path.exists());
        assert!(new_path.is_dir());
        assert!(load_matching_journal(project, &old_path, &new_path)
            .await
            .unwrap()
            .is_none());
        assert!(!old_path.join(".novelist").exists());
        assert!(!new_path.join(".novelist").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_rename_symlink_only_folder_succeeds_with_empty_journal_mappings() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old_path = project.join("links-only");
        let new_path = project.join("links-renamed");
        fs::create_dir(&old_path).unwrap();
        std::os::unix::fs::symlink(project, old_path.join("project-link")).unwrap();

        let result = rename_item_inner(
            project.to_string_lossy().to_string(),
            old_path.to_string_lossy().to_string(),
            "links-renamed".to_string(),
            None,
            &enc(),
        )
        .await
        .unwrap();

        assert_eq!(result.migration.status, RenameMigrationStatus::FullSuccess);
        assert_eq!(result.migration.migrated, 0);
        assert!(!old_path.exists());
        assert!(new_path.is_dir());
        assert!(new_path.join("project-link").exists());
        assert!(load_matching_journal(project, &old_path, &new_path)
            .await
            .unwrap()
            .is_none());
        assert!(!old_path.join(".novelist").exists());
        assert!(!new_path.join(".novelist").exists());
    }

    #[tokio::test]
    async fn test_rename_item_rejects_paths_outside_explicit_project_root() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().join("project");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let old_path = outside.join("old.md");
        fs::write(&old_path, "content").unwrap();

        let result = rename_item_inner(
            project.to_string_lossy().to_string(),
            old_path.to_string_lossy().to_string(),
            "new.md".to_string(),
            None,
            &enc(),
        )
        .await;

        assert!(matches!(result, Err(AppError::PathNotAllowed(_))));
        assert!(old_path.exists());
    }

    #[tokio::test]
    async fn test_rename_item_holds_draft_lock_before_filesystem_rename() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_path_buf();
        let old_path = project.join("old.md");
        let new_path = project.join("new.md");
        fs::write(&old_path, "content").unwrap();
        let guard = crate::services::rename_migration::acquire_draft_transaction_guard(&project)
            .await
            .unwrap();
        let mut rename = tokio::spawn({
            let project = project.clone();
            let old_path = old_path.clone();
            async move {
                let encoding_state = enc();
                rename_item_inner(
                    project.to_string_lossy().to_string(),
                    old_path.to_string_lossy().to_string(),
                    "new.md".to_string(),
                    None,
                    &encoding_state,
                )
                .await
            }
        });

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut rename)
                .await
                .is_err()
        );
        assert!(old_path.exists(), "rename ran before acquiring draft lock");
        assert!(!new_path.exists());
        drop(guard);
        let result = rename.await.unwrap().unwrap();
        assert_eq!(result.migration.status, RenameMigrationStatus::FullSuccess);
        assert!(!old_path.exists());
        assert!(new_path.exists());
    }

    #[test]
    fn test_emit_file_renamed_payload_uses_final_migration_result() {
        let result = RenameItemResult {
            new_path: "/project/new.md".to_string(),
            migration: crate::services::rename_migration::RenameMigrationResult {
                status: RenameMigrationStatus::UserFileRenamedWithMetadataErrors,
                migrated: 1,
                conflicts: 1,
                errors: vec!["metadata failed after rename".to_string()],
            },
        };
        let mut seen = None;

        emit_file_renamed("/project/old.md", &result, |payload| {
            seen = Some(payload);
            Ok(())
        })
        .unwrap();

        let payload = seen.unwrap();
        assert_eq!(payload.old_path, "/project/old.md");
        assert_eq!(payload.new_path, "/project/new.md");
        assert_eq!(
            payload.migration.unwrap().status,
            RenameMigrationStatus::UserFileRenamedWithMetadataErrors
        );
    }

    #[test]
    fn test_emit_file_renamed_soft_failure_returns_ok_with_metadata_error() {
        let mut result = RenameItemResult {
            new_path: "/project/new.md".to_string(),
            migration: crate::services::rename_migration::RenameMigrationResult::success(
                0, 0, false,
            ),
        };

        emit_file_renamed_soft("/project/old.md", &mut result, |_| {
            Err(AppError::Custom("window closed".to_string()))
        });

        assert_eq!(result.new_path, "/project/new.md");
        assert_eq!(
            result.migration.status,
            RenameMigrationStatus::UserFileRenamedWithMetadataErrors
        );
        assert!(result
            .migration
            .errors
            .iter()
            .any(|error| error.contains("broadcast file-renamed failed")));
        assert!(result
            .migration
            .errors
            .iter()
            .all(|error| !error.contains("content")));
    }

    #[test]
    fn test_legacy_broadcast_payload_has_no_migration_result() {
        let payload = legacy_file_renamed_payload("/project/old.md", "/project/new.md");

        assert_eq!(payload.old_path, "/project/old.md");
        assert_eq!(payload.new_path, "/project/new.md");
        assert!(payload.migration.is_none());
    }

    #[tokio::test]
    async fn test_rename_item_retains_journal_on_metadata_error() {
        use crate::services::sidecar::{conflict_copy_path, document_key, sidecar_path};

        let dir = TempDir::new().unwrap();
        let old_path = dir.path().join("old.md");
        let new_path = dir.path().join("new.md");
        fs::write(&old_path, "content").unwrap();
        let old_key = document_key(dir.path(), &old_path).unwrap();
        let new_key = document_key(dir.path(), &new_path).unwrap();
        let old_sidecar = sidecar_path(dir.path(), "publish", &old_key, ".json").unwrap();
        let new_sidecar = sidecar_path(dir.path(), "publish", &new_key, ".json").unwrap();
        fs::create_dir_all(old_sidecar.parent().unwrap()).unwrap();
        fs::write(&old_sidecar, "older").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::write(&new_sidecar, "newer").unwrap();
        let marker = crate::services::rename_migration::test_conflict_marker(
            &new_sidecar,
            &old_sidecar,
            b"older",
            b"newer",
        );
        fs::write(
            conflict_copy_path(&new_sidecar, &marker).unwrap(),
            "mismatch",
        )
        .unwrap();

        let result = rename_item_inner(
            dir.path().to_string_lossy().to_string(),
            old_path.to_string_lossy().to_string(),
            "new.md".to_string(),
            None,
            &enc(),
        )
        .await
        .unwrap();

        assert_eq!(
            result.migration.status,
            RenameMigrationStatus::UserFileRenamedWithMetadataErrors
        );
        assert!(Path::new(&result.new_path).exists());
        assert!(load_matching_journal(dir.path(), &old_path, &new_path)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn test_rename_item_command_retry_converges_and_removes_journal() {
        use crate::services::sidecar::conflict_copy_path;

        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let old_path = project.join("old.md");
        let new_path = project.join("new.md");
        fs::write(&old_path, "content").unwrap();
        write_with_parent(
            &sidecar_for(project, "drafts", &old_path, ".draft.md"),
            "draft",
        );
        write_with_parent(
            &sidecar_for(project, "naming", &old_path, ".json"),
            r#"{"status":"clean","documentKey":"old.md"}"#,
        );
        let old_publish = sidecar_for(project, "publish", &old_path, ".json");
        let new_publish = sidecar_for(project, "publish", &new_path, ".json");
        write_with_parent(&old_publish, "older");
        std::thread::sleep(std::time::Duration::from_millis(5));
        write_with_parent(&new_publish, "newer");
        let marker = crate::services::rename_migration::test_conflict_marker(
            &new_publish,
            &old_publish,
            b"older",
            b"newer",
        );
        let conflict = conflict_copy_path(&new_publish, &marker).unwrap();
        write_with_parent(&conflict, "mismatch");

        let first = rename_item_inner(
            project.to_string_lossy().to_string(),
            old_path.to_string_lossy().to_string(),
            "new.md".to_string(),
            None,
            &enc(),
        )
        .await
        .unwrap();

        assert_eq!(
            first.migration.status,
            RenameMigrationStatus::UserFileRenamedWithMetadataErrors
        );
        assert!(!old_path.exists());
        assert!(new_path.exists());
        assert!(load_matching_journal(project, &old_path, &new_path)
            .await
            .unwrap()
            .is_some());

        fs::remove_file(&conflict).unwrap();
        fs::write(&new_publish, "older").unwrap();
        let retry = rename_item_inner(
            project.to_string_lossy().to_string(),
            old_path.to_string_lossy().to_string(),
            "new.md".to_string(),
            None,
            &enc(),
        )
        .await
        .unwrap();

        assert_eq!(
            retry.migration.status,
            RenameMigrationStatus::IdempotentRetry
        );
        assert_eq!(retry.migration.conflicts, 0);
        assert!(load_matching_journal(project, &old_path, &new_path)
            .await
            .unwrap()
            .is_none());
        assert!(!old_publish.exists());
        assert_eq!(fs::read_to_string(&new_publish).unwrap(), "older");
        assert!(sidecar_for(project, "drafts", &new_path, ".draft.md").exists());
        assert!(sidecar_for(project, "naming", &new_path, ".json").exists());
    }

    #[tokio::test]
    async fn test_rename_item_chain_preserves_edited_sidecars_through_second_command() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let a = project.join("a.md");
        let b = project.join("b.md");
        let c = project.join("c.md");
        fs::write(&a, "content").unwrap();
        write_with_parent(&sidecar_for(project, "drafts", &a, ".draft.md"), "draft-a");
        write_with_parent(
            &sidecar_for(
                project,
                "drafts",
                &PathBuf::from(format!("{}.~recovery", a.display())),
                ".draft.md",
            ),
            "recovery-a",
        );
        write_with_parent(&sidecar_for(project, "publish", &a, ".json"), "publish-a");
        write_with_parent(
            &sidecar_for(project, "naming", &a, ".json"),
            r#"{"status":"detached","documentKey":"a.md"}"#,
        );

        rename_item_inner(
            project.to_string_lossy().to_string(),
            a.to_string_lossy().to_string(),
            "b.md".to_string(),
            None,
            &enc(),
        )
        .await
        .unwrap();

        write_with_parent(
            &sidecar_for(project, "drafts", &b, ".draft.md"),
            "draft-b-edited",
        );
        write_with_parent(
            &sidecar_for(
                project,
                "drafts",
                &PathBuf::from(format!("{}.~recovery", b.display())),
                ".draft.md",
            ),
            "recovery-b-edited",
        );
        write_with_parent(
            &sidecar_for(project, "publish", &b, ".json"),
            "publish-b-edited",
        );
        write_with_parent(
            &sidecar_for(project, "naming", &b, ".json"),
            r#"{"status":"detached","documentKey":"b.md"}"#,
        );

        let result = rename_item_inner(
            project.to_string_lossy().to_string(),
            b.to_string_lossy().to_string(),
            "c.md".to_string(),
            None,
            &enc(),
        )
        .await
        .unwrap();

        assert_eq!(result.migration.status, RenameMigrationStatus::FullSuccess);
        assert_eq!(
            fs::read_to_string(sidecar_for(project, "drafts", &c, ".draft.md")).unwrap(),
            "draft-b-edited"
        );
        assert_eq!(
            fs::read_to_string(sidecar_for(
                project,
                "drafts",
                &PathBuf::from(format!("{}.~recovery", c.display())),
                ".draft.md",
            ))
            .unwrap(),
            "recovery-b-edited"
        );
        assert_eq!(
            fs::read_to_string(sidecar_for(project, "publish", &c, ".json")).unwrap(),
            "publish-b-edited"
        );
        let naming: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(sidecar_for(project, "naming", &c, ".json")).unwrap(),
        )
        .unwrap();
        assert_eq!(naming["status"], "detached");
        assert_eq!(
            naming["documentKey"],
            crate::services::sidecar::document_key(project, &c).unwrap()
        );
        for obsolete in [&a, &b] {
            assert!(!sidecar_for(project, "drafts", obsolete, ".draft.md").exists());
            assert!(!sidecar_for(
                project,
                "drafts",
                &PathBuf::from(format!("{}.~recovery", obsolete.display())),
                ".draft.md",
            )
            .exists());
            assert!(!sidecar_for(project, "publish", obsolete, ".json").exists());
            assert!(!sidecar_for(project, "naming", obsolete, ".json").exists());
        }
    }

    #[tokio::test]
    async fn test_rename_operation_order_is_watcher_then_rename_then_migrate_then_emit() {
        let dir = TempDir::new().unwrap();
        let old_path = dir.path().join("old.md");
        fs::write(&old_path, "content").unwrap();
        reset_rename_op_log();

        let mut result = rename_item_inner(
            dir.path().to_string_lossy().to_string(),
            old_path.to_string_lossy().to_string(),
            "new.md".to_string(),
            None,
            &enc(),
        )
        .await
        .unwrap();
        emit_file_renamed_soft(&old_path.to_string_lossy(), &mut result, |_| Ok(()));

        assert_eq!(
            take_rename_op_log(),
            vec![
                "watcher-ignore",
                "filesystem-rename",
                "metadata-migration",
                "emit-file-renamed"
            ]
        );
    }

    #[tokio::test]
    async fn test_rename_item_not_found() {
        let dir = TempDir::new().unwrap();
        let state = enc();
        let result = rename_item_inner(
            dir.path().to_string_lossy().to_string(),
            "/nonexistent.md".to_string(),
            "new.md".to_string(),
            None,
            &state,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_rename_item_missing_old_with_existing_destination_requires_journal() {
        let dir = TempDir::new().unwrap();
        let old_path = dir.path().join("old.md");
        fs::write(dir.path().join("new.md"), "content").unwrap();
        let state = enc();

        let result = rename_item_inner(
            dir.path().to_string_lossy().to_string(),
            old_path.to_string_lossy().to_string(),
            "new.md".to_string(),
            None,
            &state,
        )
        .await;

        assert!(matches!(result, Err(AppError::FileNotFound(_))));
    }

    #[tokio::test]
    async fn test_rename_item_target_exists() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.md"), "").unwrap();
        fs::write(dir.path().join("b.md"), "").unwrap();
        let state = enc();
        let result = rename_item_inner(
            dir.path().to_string_lossy().to_string(),
            dir.path().join("a.md").to_string_lossy().to_string(),
            "b.md".to_string(),
            None,
            &state,
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_rename_item_bumps_on_collision() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("orig.md");
        let conflict = dir.path().join("target.md");
        let conflict2 = dir.path().join("target 2.md");
        fs::write(&src, "x").unwrap();
        fs::write(&conflict, "y").unwrap();
        fs::write(&conflict2, "z").unwrap();
        let state = enc();
        let result = rename_item_inner(
            dir.path().to_string_lossy().to_string(),
            src.to_string_lossy().to_string(),
            "target.md".to_string(),
            Some(true),
            &state,
        )
        .await
        .unwrap();
        assert!(result.new_path.ends_with("target 3.md"));
        assert!(!src.exists());
    }

    #[tokio::test]
    async fn test_rename_item_errors_on_collision_when_disabled() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("orig.md");
        let conflict = dir.path().join("target.md");
        fs::write(&src, "x").unwrap();
        fs::write(&conflict, "y").unwrap();
        let state = enc();
        let result = rename_item_inner(
            dir.path().to_string_lossy().to_string(),
            src.to_string_lossy().to_string(),
            "target.md".to_string(),
            Some(false),
            &state,
        )
        .await;
        assert!(result.is_err());
        assert!(src.exists());
    }

    #[tokio::test]
    async fn test_move_item_basic() {
        let dir = TempDir::new().unwrap();
        let src_file = dir.path().join("a.md");
        fs::write(&src_file, "hello").unwrap();
        let subdir = dir.path().join("sub");
        fs::create_dir(&subdir).unwrap();

        let result = move_item_inner(
            dir.path().to_string_lossy().to_string(),
            src_file.to_string_lossy().to_string(),
            subdir.to_string_lossy().to_string(),
            &enc(),
        )
        .await
        .unwrap();
        let new_path = result.new_path;

        assert!(!src_file.exists());
        assert!(Path::new(&new_path).exists());
        assert_eq!(fs::read_to_string(&new_path).unwrap(), "hello");
        assert!(Path::new(&new_path).ends_with(Path::new("sub/a.md")));
    }

    #[tokio::test]
    async fn test_move_item_collision_auto_numbers() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("a.md");
        fs::write(&src, "src").unwrap();
        let subdir = dir.path().join("sub");
        fs::create_dir(&subdir).unwrap();
        fs::write(subdir.join("a.md"), "existing").unwrap();

        let result = move_item_inner(
            dir.path().to_string_lossy().to_string(),
            src.to_string_lossy().to_string(),
            subdir.to_string_lossy().to_string(),
            &enc(),
        )
        .await
        .unwrap();
        let new_path = result.new_path;

        assert!(new_path.ends_with("a 2.md"));
        assert_eq!(fs::read_to_string(subdir.join("a.md")).unwrap(), "existing");
        assert_eq!(fs::read_to_string(&new_path).unwrap(), "src");
    }

    #[tokio::test]
    async fn test_concurrent_move_collision_selection_never_overwrites() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let first_dir = project.join("first");
        let second_dir = project.join("second");
        let target = project.join("target");
        fs::create_dir_all(&first_dir).unwrap();
        fs::create_dir_all(&second_dir).unwrap();
        fs::create_dir_all(&target).unwrap();
        let first = first_dir.join("chapter.md");
        let second = second_dir.join("chapter.md");
        fs::write(&first, "first").unwrap();
        fs::write(&second, "second").unwrap();
        let state = enc();

        let (first_result, second_result) = tokio::join!(
            move_item_inner(
                project.to_string_lossy().to_string(),
                first.to_string_lossy().to_string(),
                target.to_string_lossy().to_string(),
                &state,
            ),
            move_item_inner(
                project.to_string_lossy().to_string(),
                second.to_string_lossy().to_string(),
                target.to_string_lossy().to_string(),
                &state,
            ),
        );

        let mut paths = vec![
            first_result.unwrap().new_path,
            second_result.unwrap().new_path,
        ];
        paths.sort();
        assert_eq!(
            paths,
            vec![
                target.join("chapter 2.md").to_string_lossy().to_string(),
                target.join("chapter.md").to_string_lossy().to_string(),
            ]
        );
        let mut contents = paths
            .iter()
            .map(|path| fs::read_to_string(path).unwrap())
            .collect::<Vec<_>>();
        contents.sort();
        assert_eq!(contents, vec!["first", "second"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_move_item_rejects_symlinked_target_outside_project() {
        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let source = project.path().join("chapter.md");
        let linked_target = project.path().join("outside-link");
        fs::write(&source, "chapter").unwrap();
        std::os::unix::fs::symlink(outside.path(), &linked_target).unwrap();

        let result = move_item_inner(
            project.path().to_string_lossy().to_string(),
            source.to_string_lossy().to_string(),
            linked_target.to_string_lossy().to_string(),
            &enc(),
        )
        .await;

        assert!(matches!(result, Err(AppError::PathNotAllowed(_))));
        assert_eq!(fs::read_to_string(&source).unwrap(), "chapter");
        assert!(!outside.path().join("chapter.md").exists());
    }

    #[tokio::test]
    async fn test_move_item_migrates_all_document_sidecars() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let src = project.join("chapter.md");
        let recovery = PathBuf::from(format!("{}.~recovery", src.display()));
        let target = project.join("drafts");
        fs::write(&src, "chapter").unwrap();
        fs::create_dir(&target).unwrap();
        write_with_parent(
            &sidecar_for(project, "drafts", &src, ".draft.md"),
            "draft note",
        );
        write_with_parent(
            &sidecar_for(project, "drafts", &recovery, ".draft.md"),
            "recovery note",
        );
        write_with_parent(
            &sidecar_for(project, "naming", &src, ".json"),
            r#"{"status":"managed","documentKey":"chapter.md"}"#,
        );
        write_with_parent(
            &sidecar_for(project, "publish", &src, ".json"),
            r#"{"remote":{"id":"post-1"}}"#,
        );

        let result = move_item_inner(
            project.to_string_lossy().to_string(),
            src.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
            &enc(),
        )
        .await
        .unwrap();
        let moved = PathBuf::from(&result.new_path);
        let moved_recovery = PathBuf::from(format!("{}.~recovery", moved.display()));

        assert_eq!(result.migration.status, RenameMigrationStatus::FullSuccess);
        assert_eq!(fs::read_to_string(&moved).unwrap(), "chapter");
        assert_eq!(
            fs::read_to_string(sidecar_for(project, "drafts", &moved, ".draft.md")).unwrap(),
            "draft note"
        );
        assert_eq!(
            fs::read_to_string(sidecar_for(project, "drafts", &moved_recovery, ".draft.md"))
                .unwrap(),
            "recovery note"
        );
        assert!(sidecar_for(project, "naming", &moved, ".json").exists());
        assert!(sidecar_for(project, "publish", &moved, ".json").exists());
        assert!(!sidecar_for(project, "drafts", &src, ".draft.md").exists());
        assert!(!sidecar_for(project, "publish", &src, ".json").exists());
        assert!(load_matching_journal(project, &src, &moved)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn test_move_directory_migrates_descendant_sidecars() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let source_dir = project.join("old");
        let nested = source_dir.join("nested");
        let first = source_dir.join("a.md");
        let second = nested.join("b.md");
        let target = project.join("archive");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(&first, "a").unwrap();
        fs::write(&second, "b").unwrap();
        write_with_parent(
            &sidecar_for(project, "drafts", &first, ".draft.md"),
            "draft-a",
        );
        write_with_parent(
            &sidecar_for(project, "publish", &second, ".json"),
            "publish-b",
        );

        let result = move_item_inner(
            project.to_string_lossy().to_string(),
            source_dir.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
            &enc(),
        )
        .await
        .unwrap();
        let moved_dir = PathBuf::from(&result.new_path);
        let moved_first = moved_dir.join("a.md");
        let moved_second = moved_dir.join("nested/b.md");

        assert_eq!(result.migration.status, RenameMigrationStatus::FullSuccess);
        assert_eq!(
            fs::read_to_string(sidecar_for(project, "drafts", &moved_first, ".draft.md")).unwrap(),
            "draft-a"
        );
        assert_eq!(
            fs::read_to_string(sidecar_for(project, "publish", &moved_second, ".json")).unwrap(),
            "publish-b"
        );
        assert!(!sidecar_for(project, "drafts", &first, ".draft.md").exists());
        assert!(!sidecar_for(project, "publish", &second, ".json").exists());
    }

    #[tokio::test]
    async fn test_move_item_retry_uses_journaled_collision_destination() {
        use crate::services::sidecar::conflict_copy_path;

        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let src = project.join("chapter.md");
        let target = project.join("archive");
        let moved = target.join("chapter 2.md");
        fs::create_dir(&target).unwrap();
        fs::write(&src, "chapter").unwrap();
        fs::write(target.join("chapter.md"), "occupied").unwrap();
        let old_publish = sidecar_for(project, "publish", &src, ".json");
        let new_publish = sidecar_for(project, "publish", &moved, ".json");
        write_with_parent(&old_publish, "older");
        std::thread::sleep(std::time::Duration::from_millis(5));
        write_with_parent(&new_publish, "newer");
        let marker = crate::services::rename_migration::test_conflict_marker(
            &new_publish,
            &old_publish,
            b"older",
            b"newer",
        );
        let conflict = conflict_copy_path(&new_publish, &marker).unwrap();
        write_with_parent(&conflict, "mismatch");

        let first = move_item_inner(
            project.to_string_lossy().to_string(),
            src.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
            &enc(),
        )
        .await
        .unwrap();

        assert_eq!(first.new_path, moved.to_string_lossy());
        assert_eq!(
            first.migration.status,
            RenameMigrationStatus::UserFileRenamedWithMetadataErrors
        );
        assert!(load_matching_journal(project, &src, &moved)
            .await
            .unwrap()
            .is_some());

        fs::remove_file(&conflict).unwrap();
        fs::write(&new_publish, "older").unwrap();
        let retry = move_item_inner(
            project.to_string_lossy().to_string(),
            src.to_string_lossy().to_string(),
            target.to_string_lossy().to_string(),
            &enc(),
        )
        .await
        .unwrap();

        assert_eq!(retry.new_path, moved.to_string_lossy());
        assert_eq!(
            retry.migration.status,
            RenameMigrationStatus::IdempotentRetry
        );
        assert!(load_matching_journal(project, &src, &moved)
            .await
            .unwrap()
            .is_none());
        assert!(!old_publish.exists());
        assert_eq!(fs::read_to_string(new_publish).unwrap(), "older");
    }

    #[tokio::test]
    async fn test_move_item_into_own_descendant_fails() {
        let dir = TempDir::new().unwrap();
        let parent = dir.path().join("parent");
        fs::create_dir(&parent).unwrap();
        let child = parent.join("child");
        fs::create_dir(&child).unwrap();

        let result = move_item_inner(
            dir.path().to_string_lossy().to_string(),
            parent.to_string_lossy().to_string(),
            child.to_string_lossy().to_string(),
            &enc(),
        )
        .await;
        assert!(result.is_err());
        assert!(parent.exists());
        assert!(child.exists());
    }

    #[tokio::test]
    async fn test_move_item_target_not_a_directory() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("a.md");
        fs::write(&src, "").unwrap();
        let not_dir = dir.path().join("b.md");
        fs::write(&not_dir, "").unwrap();

        let result = move_item_inner(
            dir.path().to_string_lossy().to_string(),
            src.to_string_lossy().to_string(),
            not_dir.to_string_lossy().to_string(),
            &enc(),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_move_item_into_own_parent_fails() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("a.md");
        fs::write(&src, "content").unwrap();

        let result = move_item_inner(
            dir.path().to_string_lossy().to_string(),
            src.to_string_lossy().to_string(),
            dir.path().to_string_lossy().to_string(),
            &enc(),
        )
        .await;
        assert!(result.is_err(), "moving into own parent should fail");
        assert!(src.exists(), "source must not have been renamed");
        assert_eq!(fs::read_to_string(&src).unwrap(), "content");
    }

    #[tokio::test]
    async fn test_move_item_extensionless_filename_collision() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("Makefile");
        fs::write(&src, "src").unwrap();
        let subdir = dir.path().join("sub");
        fs::create_dir(&subdir).unwrap();
        fs::write(subdir.join("Makefile"), "existing").unwrap();

        let result = move_item_inner(
            dir.path().to_string_lossy().to_string(),
            src.to_string_lossy().to_string(),
            subdir.to_string_lossy().to_string(),
            &enc(),
        )
        .await
        .unwrap();
        let new_path = result.new_path;

        assert!(new_path.ends_with("Makefile 2"));
        assert_eq!(
            fs::read_to_string(subdir.join("Makefile")).unwrap(),
            "existing"
        );
        assert_eq!(fs::read_to_string(&new_path).unwrap(), "src");
    }

    #[tokio::test]
    async fn test_delete_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("delete_me.md");
        fs::write(&file, "content").unwrap();
        delete_item(file.to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(!file.exists());
    }

    #[tokio::test]
    async fn test_delete_directory() {
        let dir = TempDir::new().unwrap();
        let sub = dir.path().join("subdir");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("file.md"), "").unwrap();
        delete_item(sub.to_string_lossy().to_string())
            .await
            .unwrap();
        assert!(!sub.exists());
    }

    #[tokio::test]
    async fn test_delete_item_not_found() {
        let result = delete_item("/nonexistent.md".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_write_file_creates_new() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("new.md");
        write_file_inner(&file_path.to_string_lossy(), "# Title\n\nBody", &enc())
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(&file_path).unwrap(), "# Title\n\nBody");
    }

    #[tokio::test]
    async fn test_write_file_missing_parent_returns_file_not_found() {
        // Regression: tokio::fs::write used to surface a pathless ENOENT when
        // the parent dir was gone (project folder moved/deleted while tab
        // still open). We now catch that case explicitly with the parent path.
        let dir = TempDir::new().unwrap();
        let missing_parent = dir.path().join("does-not-exist");
        let file_path = missing_parent.join("file.md");
        let err = write_file_inner(&file_path.to_string_lossy(), "x", &enc())
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(
            matches!(err, AppError::FileNotFound(_)),
            "expected FileNotFound, got: {msg}"
        );
        assert!(
            msg.contains("Parent directory does not exist"),
            "message should name the problem: {msg}"
        );
        assert!(
            msg.contains(&missing_parent.to_string_lossy().to_string()),
            "message should include the missing parent path: {msg}"
        );
    }

    #[tokio::test]
    async fn test_write_file_overwrites() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("existing.md");
        fs::write(&file_path, "old content").unwrap();
        write_file_inner(&file_path.to_string_lossy(), "new content", &enc())
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(&file_path).unwrap(), "new content");
    }

    #[test]
    fn test_write_file_if_unchanged_result_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&WriteFileIfUnchangedResult::Written).unwrap(),
            "\"written\""
        );
        assert_eq!(
            serde_json::to_string(&WriteFileIfUnchangedResult::Conflict).unwrap(),
            "\"conflict\""
        );
    }

    #[tokio::test]
    async fn test_write_file_if_unchanged_modifies_matching_cjk_text() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("第一章.md");
        let original = "# 第一章\n\n旧内容。";
        let updated = "# 第一章\n\n新内容。";
        fs::write(&file_path, original).unwrap();

        let result = write_file_if_unchanged_inner(
            &dir.path().to_string_lossy(),
            &file_path.to_string_lossy(),
            Some(original),
            updated,
            &enc(),
            &crate::services::file_watcher::FileWatcherState::new(),
        )
        .await
        .unwrap();

        assert_eq!(result, WriteFileIfUnchangedResult::Written);
        assert_eq!(fs::read_to_string(&file_path).unwrap(), updated);
    }

    #[tokio::test]
    async fn test_write_file_if_unchanged_conflict_preserves_exact_bytes_and_no_temp() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("chapter.md");
        let original = "# 第一章\n\n磁盘上的内容。".as_bytes().to_vec();
        fs::write(&file_path, &original).unwrap();

        let result = write_file_if_unchanged_inner(
            &dir.path().to_string_lossy(),
            &file_path.to_string_lossy(),
            Some("# 第一章\n\n过期内容。"),
            "replacement",
            &enc(),
            &crate::services::file_watcher::FileWatcherState::new(),
        )
        .await
        .unwrap();

        assert_eq!(result, WriteFileIfUnchangedResult::Conflict);
        assert_eq!(fs::read(&file_path).unwrap(), original);
        assert!(!Path::new(&format!("{}.novelist-tmp", file_path.display())).exists());
    }

    #[tokio::test]
    async fn test_write_file_if_unchanged_none_creates_absent_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("new.md");

        let result = write_file_if_unchanged_inner(
            &dir.path().to_string_lossy(),
            &file_path.to_string_lossy(),
            None,
            "新文件",
            &enc(),
            &crate::services::file_watcher::FileWatcherState::new(),
        )
        .await
        .unwrap();

        assert_eq!(result, WriteFileIfUnchangedResult::Written);
        assert_eq!(fs::read_to_string(&file_path).unwrap(), "新文件");
    }

    #[tokio::test]
    async fn test_write_file_if_unchanged_none_conflicts_with_existing_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("existing.md");
        fs::write(&file_path, "present").unwrap();

        let result = write_file_if_unchanged_inner(
            &dir.path().to_string_lossy(),
            &file_path.to_string_lossy(),
            None,
            "replacement",
            &enc(),
            &crate::services::file_watcher::FileWatcherState::new(),
        )
        .await
        .unwrap();

        assert_eq!(result, WriteFileIfUnchangedResult::Conflict);
        assert_eq!(fs::read_to_string(&file_path).unwrap(), "present");
    }

    #[tokio::test]
    async fn test_write_file_if_unchanged_none_conflicts_with_empty_existing_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("empty.md");
        fs::write(&file_path, []).unwrap();

        let result = write_file_if_unchanged_inner(
            &dir.path().to_string_lossy(),
            &file_path.to_string_lossy(),
            None,
            "replacement",
            &enc(),
            &crate::services::file_watcher::FileWatcherState::new(),
        )
        .await
        .unwrap();

        assert_eq!(result, WriteFileIfUnchangedResult::Conflict);
        assert_eq!(fs::read(&file_path).unwrap(), Vec::<u8>::new());
    }

    async fn assert_conditional_write_preserves_remembered_encoding(
        encoding: &'static encoding_rs::Encoding,
        original: &str,
        updated: &str,
    ) {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join(format!("{}.txt", encoding.name()));
        let (original_bytes, _, original_had_errors) = encoding.encode(original);
        assert!(!original_had_errors);
        fs::write(&file_path, &*original_bytes).unwrap();

        let state = enc();
        let decoded = read_file_inner(&file_path.to_string_lossy(), &state)
            .await
            .unwrap();
        assert_eq!(decoded, original);

        let result = write_file_if_unchanged_inner(
            &dir.path().to_string_lossy(),
            &file_path.to_string_lossy(),
            Some(original),
            updated,
            &state,
            &crate::services::file_watcher::FileWatcherState::new(),
        )
        .await
        .unwrap();
        let (expected_bytes, _, updated_had_errors) = encoding.encode(updated);
        assert!(!updated_had_errors);

        assert_eq!(result, WriteFileIfUnchangedResult::Written);
        assert_eq!(fs::read(&file_path).unwrap(), &*expected_bytes);
    }

    #[tokio::test]
    async fn test_write_file_if_unchanged_preserves_remembered_gbk() {
        assert_conditional_write_preserves_remembered_encoding(
            encoding_rs::GBK,
            "第一章\n落霞与孤鹜齐飞，秋水共长天一色。",
            "第二章\n海上生明月，天涯共此时。",
        )
        .await;
    }

    #[tokio::test]
    async fn test_write_file_if_unchanged_preserves_remembered_big5() {
        assert_conditional_write_preserves_remembered_encoding(
            encoding_rs::BIG5,
            "測試文字",
            "更新文字",
        )
        .await;
    }

    #[tokio::test]
    async fn test_write_file_if_unchanged_preserves_remembered_shift_jis() {
        assert_conditional_write_preserves_remembered_encoding(
            encoding_rs::SHIFT_JIS,
            "こんにちは世界",
            "さようなら世界",
        )
        .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_normal_and_conditional_text_writes_share_one_path_lock() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("serialized.md");
        fs::write(&file_path, "v0").unwrap();

        let lock = text_write_lock(&file_path).unwrap();
        let guard = lock.lock().await;
        let path = file_path.to_string_lossy().to_string();
        let normal_state = std::sync::Arc::new(enc());
        let normal_path = path.clone();
        let normal =
            tokio::spawn(
                async move { write_file_inner(&normal_path, "normal", &normal_state).await },
            );
        let conditional_state = std::sync::Arc::new(enc());
        let watcher_state =
            std::sync::Arc::new(crate::services::file_watcher::FileWatcherState::new());
        let conditional_path = path.clone();
        let project_dir = dir.path().to_string_lossy().to_string();
        let conditional = tokio::spawn(async move {
            write_file_if_unchanged_inner(
                &project_dir,
                &conditional_path,
                Some("v0"),
                "conditional",
                &conditional_state,
                &watcher_state,
            )
            .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(
            !normal.is_finished(),
            "normal write bypassed the shared lock"
        );
        assert!(
            !conditional.is_finished(),
            "conditional write bypassed the shared lock"
        );
        assert_eq!(fs::read_to_string(&file_path).unwrap(), "v0");

        drop(guard);
        normal.await.unwrap().unwrap();
        let conditional_result = conditional.await.unwrap().unwrap();
        assert!(matches!(
            conditional_result,
            WriteFileIfUnchangedResult::Written | WriteFileIfUnchangedResult::Conflict
        ));
        assert_eq!(fs::read_to_string(&file_path).unwrap(), "normal");
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_symlink_alias_uses_same_text_write_lock() {
        let dir = TempDir::new().unwrap();
        let real_path = dir.path().join("real.md");
        let alias_path = dir.path().join("alias.md");
        fs::write(&real_path, "current").unwrap();
        std::os::unix::fs::symlink(&real_path, &alias_path).unwrap();

        let lock = text_write_lock(&real_path).unwrap();
        let guard = lock.lock().await;
        let alias = alias_path.to_string_lossy().to_string();
        let state = std::sync::Arc::new(enc());
        let watcher_state =
            std::sync::Arc::new(crate::services::file_watcher::FileWatcherState::new());
        let project_dir = dir.path().to_string_lossy().to_string();
        let conditional = tokio::spawn(async move {
            write_file_if_unchanged_inner(
                &project_dir,
                &alias,
                Some("stale"),
                "replacement",
                &state,
                &watcher_state,
            )
            .await
        });

        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(
            !conditional.is_finished(),
            "resolvable symlink alias bypassed the canonical target lock"
        );
        drop(guard);

        assert_eq!(
            conditional.await.unwrap().unwrap(),
            WriteFileIfUnchangedResult::Conflict
        );
        assert!(alias_path.is_symlink());
        assert_eq!(fs::read_to_string(&real_path).unwrap(), "current");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_write_file_if_unchanged_rejects_existing_symlink_escape() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().join("project");
        let external = dir.path().join("external.md");
        let alias = project.join("linked.md");
        fs::create_dir(&project).unwrap();
        fs::write(&external, "外部原文").unwrap();
        std::os::unix::fs::symlink(&external, &alias).unwrap();

        let err = write_file_if_unchanged_inner(
            &project.to_string_lossy(),
            &alias.to_string_lossy(),
            Some("外部原文"),
            "不得写入",
            &enc(),
            &crate::services::file_watcher::FileWatcherState::new(),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::InvalidInput(_)));
        assert_eq!(fs::read_to_string(&external).unwrap(), "外部原文");
        assert!(alias.is_symlink());
        assert!(!Path::new(&format!("{}.novelist-tmp", external.display())).exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_write_file_if_unchanged_updates_approved_in_project_symlink_target() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().join("project");
        let real = project.join("real.md");
        let alias = project.join("linked.md");
        fs::create_dir(&project).unwrap();
        fs::write(&real, "项目内原文").unwrap();
        std::os::unix::fs::symlink(&real, &alias).unwrap();

        let result = write_file_if_unchanged_inner(
            &project.to_string_lossy(),
            &alias.to_string_lossy(),
            Some("项目内原文"),
            "项目内更新",
            &enc(),
            &crate::services::file_watcher::FileWatcherState::new(),
        )
        .await
        .unwrap();

        assert_eq!(result, WriteFileIfUnchangedResult::Written);
        assert!(alias.is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "项目内更新");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_write_file_if_unchanged_rejects_symlinked_creation_parent_escape() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().join("project");
        let external_dir = dir.path().join("external");
        let linked_parent = project.join("linked-parent");
        let requested = linked_parent.join("new.md");
        let external_target = external_dir.join("new.md");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&external_dir).unwrap();
        std::os::unix::fs::symlink(&external_dir, &linked_parent).unwrap();

        let err = write_file_if_unchanged_inner(
            &project.to_string_lossy(),
            &requested.to_string_lossy(),
            None,
            "不得创建",
            &enc(),
            &crate::services::file_watcher::FileWatcherState::new(),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(!external_target.exists());
        assert!(!Path::new(&format!("{}.novelist-tmp", external_target.display())).exists());
    }

    #[tokio::test]
    async fn test_write_file_if_unchanged_error_leaves_no_partial_target() {
        let dir = TempDir::new().unwrap();
        let missing_parent = dir.path().join("missing");
        let file_path = missing_parent.join("chapter.md");

        let err = write_file_if_unchanged_inner(
            &dir.path().to_string_lossy(),
            &file_path.to_string_lossy(),
            None,
            "content",
            &enc(),
            &crate::services::file_watcher::FileWatcherState::new(),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::FileNotFound(_)));
        assert!(!file_path.exists());
        assert!(!missing_parent.exists());
        assert!(!Path::new(&format!("{}.novelist-tmp", file_path.display())).exists());
    }

    #[tokio::test]
    async fn test_write_file_if_unchanged_missing_parent_errors_before_conflict() {
        let dir = TempDir::new().unwrap();
        let missing_parent = dir.path().join("missing");
        let file_path = missing_parent.join("chapter.md");

        let err = write_file_if_unchanged_inner(
            &dir.path().to_string_lossy(),
            &file_path.to_string_lossy(),
            Some("expected old content"),
            "new content",
            &enc(),
            &crate::services::file_watcher::FileWatcherState::new(),
        )
        .await
        .unwrap_err();

        assert!(matches!(err, AppError::FileNotFound(_)));
        assert!(!file_path.exists());
        assert!(!missing_parent.exists());
        assert!(!Path::new(&format!("{}.novelist-tmp", file_path.display())).exists());
    }

    #[tokio::test]
    async fn test_read_file_utf8_cjk() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("cjk.md");
        let content = "# 第一章\n\n落霞与孤鹜齐飞，秋水共长天一色。";
        fs::write(&file_path, content).unwrap();
        let result = read_file_inner(&file_path.to_string_lossy(), &enc())
            .await
            .unwrap();
        assert_eq!(result, content);
    }

    #[tokio::test]
    async fn test_read_gbk_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("gbk.txt");
        // Encode "你好世界" in GBK
        let text = "你好世界";
        let (encoded, _, _) = encoding_rs::GBK.encode(text);
        fs::write(&file_path, &*encoded).unwrap();

        let state = enc();
        let result = read_file_inner(&file_path.to_string_lossy(), &state)
            .await
            .unwrap();
        assert_eq!(result, text);

        // Verify encoding was stored
        let canonical = file_path
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let map = state.encodings.lock().unwrap();
        assert!(
            map.contains_key(&canonical),
            "Encoding state should track GBK file"
        );
    }

    #[tokio::test]
    async fn test_read_big5_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("big5.txt");
        // Encode traditional Chinese in Big5
        let text = "測試文字";
        let (encoded, _, _) = encoding_rs::BIG5.encode(text);
        fs::write(&file_path, &*encoded).unwrap();

        let state = enc();
        let result = read_file_inner(&file_path.to_string_lossy(), &state)
            .await
            .unwrap();
        assert_eq!(result, text);
    }

    #[tokio::test]
    async fn test_read_shift_jis_file() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("sjis.txt");
        // Encode Japanese text in Shift_JIS
        let text = "こんにちは世界";
        let (encoded, _, _) = encoding_rs::SHIFT_JIS.encode(text);
        fs::write(&file_path, &*encoded).unwrap();

        let state = enc();
        let result = read_file_inner(&file_path.to_string_lossy(), &state)
            .await
            .unwrap();
        assert_eq!(result, text);
    }

    #[tokio::test]
    async fn test_roundtrip_gbk() {
        // Read a GBK file, then write it back, verify raw bytes match original
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("roundtrip_gbk.txt");
        let text = "第一章\n落霞与孤鹜齐飞，秋水共长天一色。";
        let (original_bytes, _, _) = encoding_rs::GBK.encode(text);
        fs::write(&file_path, &*original_bytes).unwrap();

        let state = enc();
        let content = read_file_inner(&file_path.to_string_lossy(), &state)
            .await
            .unwrap();
        assert_eq!(content, text);

        // Write back via write_file_inner (should re-encode to GBK)
        write_file_inner(&file_path.to_string_lossy(), &content, &state)
            .await
            .unwrap();

        // Verify raw bytes on disk are GBK, not UTF-8
        let raw = fs::read(&file_path).unwrap();
        assert_eq!(raw, &*original_bytes, "Written bytes should be GBK-encoded");
    }

    #[tokio::test]
    async fn test_new_file_written_as_utf8() {
        // A file that was never read should be written as UTF-8
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("new_utf8.md");
        let text = "新文件内容";

        let state = enc();
        write_file_inner(&file_path.to_string_lossy(), text, &state)
            .await
            .unwrap();

        let raw = fs::read(&file_path).unwrap();
        assert_eq!(raw, text.as_bytes(), "New files should be UTF-8");
    }

    #[tokio::test]
    async fn test_utf8_bom_stripped() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("bom.md");
        // UTF-8 BOM + content
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("Hello BOM".as_bytes());
        fs::write(&file_path, &bytes).unwrap();

        let state = enc();
        let result = read_file_inner(&file_path.to_string_lossy(), &state)
            .await
            .unwrap();
        assert_eq!(result, "Hello BOM", "UTF-8 BOM should be stripped");
    }

    #[test]
    fn test_decode_bytes_pure_ascii() {
        let bytes = b"Hello, World!";
        let (enc, text) = decode_bytes(bytes);
        assert!(enc.is_none());
        assert_eq!(text, "Hello, World!");
    }

    #[test]
    fn test_decode_bytes_utf8() {
        let bytes = "日本語テスト".as_bytes();
        let (enc, text) = decode_bytes(bytes);
        assert!(enc.is_none());
        assert_eq!(text, "日本語テスト");
    }

    #[test]
    fn test_encode_string_gbk() {
        let encoded = encode_string("你好", "GBK").unwrap();
        let (decoded, _, _) = encoding_rs::GBK.decode(&encoded);
        assert_eq!(decoded, "你好");
    }

    #[tokio::test]
    async fn test_rename_migrates_encoding_state() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("orig.md");
        fs::write(&src, "x").unwrap();
        let canonical_old = src.canonicalize().unwrap().to_string_lossy().to_string();

        let state = EncodingState::new();
        state
            .encodings
            .lock()
            .unwrap()
            .insert(canonical_old.clone(), "GBK");

        let old_copy = canonical_old.clone();
        let new_name = "renamed.md".to_string();
        // We call the migration helper directly (bypass State injection in tests).
        // Compute what the new canonical path will be.
        let new_path_raw = dir.path().join(&new_name);

        // Simulate rename
        tokio::fs::rename(&src, &new_path_raw).await.unwrap();

        let canonical_new = new_path_raw
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string();

        migrate_encoding_state_tree(&state, Path::new(&old_copy), Path::new(&canonical_new));

        let map = state.encodings.lock().unwrap();
        assert!(!map.contains_key(&old_copy));
        assert_eq!(map.get(&canonical_new), Some(&"GBK"));
    }

    #[tokio::test]
    async fn test_move_item_migrates_encoding_state() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("gbk.md");
        fs::write(&src, "x").unwrap();
        let subdir = dir.path().join("sub");
        fs::create_dir(&subdir).unwrap();
        let canonical_old = src.canonicalize().unwrap().to_string_lossy().to_string();

        let state = EncodingState::new();
        state
            .encodings
            .lock()
            .unwrap()
            .insert(canonical_old.clone(), "GBK");

        let result = move_item_inner(
            dir.path().to_string_lossy().to_string(),
            src.to_string_lossy().to_string(),
            subdir.to_string_lossy().to_string(),
            &state,
        )
        .await
        .unwrap();
        let new_path = result.new_path;
        let canonical_new = Path::new(&new_path)
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string();

        let map = state.encodings.lock().unwrap();
        assert!(!map.contains_key(&canonical_old));
        assert_eq!(map.get(&canonical_new), Some(&"GBK"));
    }

    #[test]
    fn test_migrate_encoding_state_tree_moves_descendants() {
        let dir = TempDir::new().unwrap();
        let old_root = dir.path().join("old");
        let new_root = dir.path().join("new");
        fs::create_dir_all(old_root.join("nested")).unwrap();
        let child = old_root.join("nested").join("chapter.md");
        fs::write(&child, "x").unwrap();

        let state = EncodingState::new();
        let old_child = child.to_string_lossy().to_string();
        state
            .encodings
            .lock()
            .unwrap()
            .insert(old_child.clone(), "Big5");

        let new_child = new_root.join("nested").join("chapter.md");
        migrate_encoding_state_tree(&state, &old_root, &new_root);

        let map = state.encodings.lock().unwrap();
        assert!(!map.contains_key(&old_child));
        assert_eq!(
            map.get(&new_child.to_string_lossy().to_string()),
            Some(&"Big5")
        );
    }
}

#[cfg(test)]
mod large_file_tests {
    use super::*;
    use std::io::Write;

    #[tokio::test]
    async fn test_read_large_file_150k_lines() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("large.md");
        {
            let mut f = std::fs::File::create(&path).unwrap();
            for i in 1..=150000 {
                writeln!(f, "Line {} of 150000", i).unwrap();
            }
        }
        let file_size = std::fs::metadata(&path).unwrap().len();
        println!(
            "File size: {} bytes ({:.1} MB)",
            file_size,
            file_size as f64 / 1e6
        );

        let state = super::EncodingState::new();
        let content = read_file_inner(&path.to_string_lossy(), &state)
            .await
            .unwrap();
        let line_count = content.lines().count();
        println!("Read {} lines, {} bytes", line_count, content.len());
        assert_eq!(
            line_count, 150000,
            "Line count mismatch: expected 150000, got {}",
            line_count
        );

        let last_line = content.lines().last().unwrap();
        assert_eq!(
            last_line, "Line 150000 of 150000",
            "Last line wrong: {}",
            last_line
        );
        println!("Last line: {}", last_line);
        println!("readFile returns all 150000 lines");
    }
}
