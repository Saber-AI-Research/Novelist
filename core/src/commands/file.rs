use crate::error::AppError;
use crate::models::file_state::FileEntry;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

#[cfg(test)]
use std::path::Path;
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

/// Move the encoding entry from `old_canonical` to `new_canonical`. No-op when
/// the old key is not present (file was UTF-8).
pub fn migrate_encoding_state(state: &EncodingState, old_canonical: &str, new_canonical: &str) {
    let mut map = state.encodings.lock().expect("encodings lock");
    if let Some(enc) = map.remove(old_canonical) {
        map.insert(new_canonical.to_string(), enc);
    }
}

/// Detect encoding from raw bytes. Returns the `encoding_rs::Encoding` label
/// and the decoded UTF-8 string.
fn decode_bytes(bytes: &[u8]) -> (Option<&'static str>, String) {
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
    let (detected_encoding, content) = decode_bytes(&bytes);

    // Store or clear encoding for this path
    let canonical = p
        .canonicalize()
        .unwrap_or_else(|_| p.clone())
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

/// Internal: write a file, re-encoding to original encoding if needed.
pub(crate) async fn write_file_inner(
    path: &str,
    content: &str,
    enc_state: &EncodingState,
) -> Result<(), AppError> {
    let p = validate_path(path)?;
    tracing::info!(
        "[write_file] path={}, content_bytes={}, content_lines={}",
        p.display(),
        content.len(),
        content.lines().count()
    );

    // Parent directory must exist before we attempt the atomic write.
    // Without this check, tokio::fs::write surfaces a generic ENOENT with no
    // path, which is what produced "IO error: No such file or directory
    // (os error 2)" in the wild when a project folder was moved/deleted while
    // a tab was still open.
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AppError::FileNotFound(format!(
                "Parent directory does not exist: {}",
                parent.display()
            )));
        }
    }

    // Check if this file was originally read in a non-UTF-8 encoding
    let canonical = p
        .canonicalize()
        .unwrap_or_else(|_| p.clone())
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
    tokio::fs::rename(&temp_path, &p)
        .await
        .map_err(|e| AppError::Custom(format!("rename {} -> {}: {}", temp_path, p.display(), e)))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn write_file(
    path: String,
    content: String,
    encoding_state: tauri::State<'_, EncodingState>,
) -> Result<(), AppError> {
    write_file_inner(&path, &content, &encoding_state).await
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
        entries.push(FileEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            mtime,
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
    app.emit("file-renamed", FileRenamedPayload { old_path, new_path })
        .map_err(|e| AppError::Custom(format!("emit failed: {e}")))?;
    Ok(())
}

/// Rename a file or folder in place.
/// When `allow_collision_bump` is Some(true), appends " 2", " 3", … on collision.
/// Defaults to error-on-collision when None or Some(false).
#[tauri::command]
#[specta::specta]
pub async fn rename_item(
    old_path: String,
    new_name: String,
    allow_collision_bump: Option<bool>,
    encoding_state: tauri::State<'_, EncodingState>,
) -> Result<String, AppError> {
    rename_item_inner(old_path, new_name, allow_collision_bump, &encoding_state).await
}

pub(crate) async fn rename_item_inner(
    old_path: String,
    new_name: String,
    allow_collision_bump: Option<bool>,
    encoding_state: &EncodingState,
) -> Result<String, AppError> {
    let old = validate_path(&old_path)?;
    if !old.exists() {
        return Err(AppError::FileNotFound(old_path));
    }
    let safe_name = sanitize_filename(&new_name)?;
    let parent = old
        .parent()
        .ok_or_else(|| AppError::Custom("Cannot determine parent directory".to_string()))?;
    let mut new_path = parent.join(&safe_name);

    if new_path.exists() && new_path != old {
        if allow_collision_bump.unwrap_or(false) {
            let p = std::path::Path::new(&safe_name);
            let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
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

    // Canonicalize the OLD path BEFORE the rename -- after the rename, the old
    // file no longer exists and canonicalize would fail.
    let old_canon = old.canonicalize().ok().map(|p| p.to_string_lossy().to_string());
    // Suppress the imminent file-watcher events for the old and new paths so
    // the frontend doesn't reload the file (which would lose editor state).
    crate::services::file_watcher::register_rename_ignore(
        old.to_string_lossy().to_string(),
        new_path.to_string_lossy().to_string(),
    )
    .await;
    tokio::fs::rename(&old, &new_path).await?;
    // Canonicalize the NEW path AFTER the rename so the target exists.
    let new_canon = new_path.canonicalize().ok().map(|p| p.to_string_lossy().to_string());
    if let (Some(o), Some(n)) = (old_canon, new_canon) {
        migrate_encoding_state(encoding_state, &o, &n);
    }
    Ok(new_path.to_string_lossy().to_string())
}

/// Move a file or folder into `target_dir`. Auto-numbers on collision
/// ("a.md" -> "a 2.md"). Rejects moving a folder into its own descendant.
#[tauri::command]
#[specta::specta]
pub async fn move_item(source_path: String, target_dir: String) -> Result<String, AppError> {
    let source = validate_path(&source_path)?;
    let target = validate_path(&target_dir)?;

    if !source.exists() {
        return Err(AppError::FileNotFound(source_path));
    }
    if !target.is_dir() {
        return Err(AppError::NotADirectory(target_dir));
    }

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

    // Source & target are both inside the project tree (frontend guarantees this via
    // validate_path). Same filesystem -> plain rename is enough.
    tokio::fs::rename(&source, &dest).await?;
    Ok(dest.to_string_lossy().to_string())
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
    let extensions = ["md", "markdown", "txt", "json", "jsonl", "csv"];
    let max_matches = 200usize;
    let mut matches = Vec::new();

    for entry in WalkDir::new(&dir_path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !extensions.contains(&ext) {
            continue;
        }

        // Skip hidden directories/files
        if path
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        {
            // Allow .novelist but skip other hidden dirs
            let has_hidden = path.components().any(|c| {
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
            let line_lower = line.to_lowercase();
            let mut search_start = 0;
            while let Some(pos) = line_lower[search_start..].find(&query_lower) {
                let abs_pos = search_start + pos;
                matches.push(SearchMatch {
                    file_path: file_path_str.clone(),
                    file_name: file_name.clone(),
                    line_number: line_idx + 1,
                    line_text: line.to_string(),
                    match_start: abs_pos,
                    match_end: abs_pos + query.len(),
                });
                if matches.len() >= max_matches {
                    return Ok(matches);
                }
                search_start = abs_pos + 1;
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

/// Read an image file and return it as a data URI (e.g. `data:image/png;base64,...`).
/// Used by the WYSIWYG editor to render local images without the asset protocol.
#[tauri::command]
#[specta::specta]
pub async fn read_image_data_uri(path: String) -> Result<String, AppError> {
    use tokio::fs;

    let p = validate_path(&path)?;
    if !p.exists() {
        return Err(AppError::FileNotFound(path));
    }

    let bytes = fs::read(&p).await?;

    // Determine MIME type from extension
    let mime = match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    };

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
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
        assert!(
            entries
                .iter()
                .find(|e| e.name == "chapters")
                .map(|e| e.is_dir)
                .unwrap_or(false)
        );
        assert!(
            entries.iter().any(|e| e.mtime.is_some()),
            "at least one entry should have mtime"
        );
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
        let none_entries =
            list_directory(dir.path().to_string_lossy().to_string(), None)
                .await
                .unwrap();
        let false_entries =
            list_directory(dir.path().to_string_lossy().to_string(), Some(false))
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
            old_path.to_string_lossy().to_string(),
            "new.md".to_string(),
            None,
            &state,
        )
            .await
            .unwrap();
        assert!(!old_path.exists());
        assert!(Path::new(&new_path).exists());
        assert_eq!(fs::read_to_string(&new_path).unwrap(), "content");
    }

    #[tokio::test]
    async fn test_rename_item_not_found() {
        let state = enc();
        let result = rename_item_inner(
            "/nonexistent.md".to_string(),
            "new.md".to_string(),
            None,
            &state,
        ).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_rename_item_target_exists() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.md"), "").unwrap();
        fs::write(dir.path().join("b.md"), "").unwrap();
        let state = enc();
        let result = rename_item_inner(
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
            src.to_string_lossy().to_string(),
            "target.md".to_string(),
            Some(true),
            &state,
        ).await.unwrap();
        assert!(result.ends_with("target 3.md"));
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
            src.to_string_lossy().to_string(),
            "target.md".to_string(),
            Some(false),
            &state,
        ).await;
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

        let new_path = move_item(
            src_file.to_string_lossy().to_string(),
            subdir.to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        assert!(!src_file.exists());
        assert!(Path::new(&new_path).exists());
        assert_eq!(fs::read_to_string(&new_path).unwrap(), "hello");
        assert!(new_path.ends_with("sub/a.md"));
    }

    #[tokio::test]
    async fn test_move_item_collision_auto_numbers() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("a.md");
        fs::write(&src, "src").unwrap();
        let subdir = dir.path().join("sub");
        fs::create_dir(&subdir).unwrap();
        fs::write(subdir.join("a.md"), "existing").unwrap();

        let new_path = move_item(
            src.to_string_lossy().to_string(),
            subdir.to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        assert!(new_path.ends_with("a 2.md"));
        assert_eq!(fs::read_to_string(subdir.join("a.md")).unwrap(), "existing");
        assert_eq!(fs::read_to_string(&new_path).unwrap(), "src");
    }

    #[tokio::test]
    async fn test_move_item_into_own_descendant_fails() {
        let dir = TempDir::new().unwrap();
        let parent = dir.path().join("parent");
        fs::create_dir(&parent).unwrap();
        let child = parent.join("child");
        fs::create_dir(&child).unwrap();

        let result = move_item(
            parent.to_string_lossy().to_string(),
            child.to_string_lossy().to_string(),
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

        let result = move_item(
            src.to_string_lossy().to_string(),
            not_dir.to_string_lossy().to_string(),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_move_item_into_own_parent_fails() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("a.md");
        fs::write(&src, "content").unwrap();

        let result = move_item(
            src.to_string_lossy().to_string(),
            dir.path().to_string_lossy().to_string(),
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

        let new_path = move_item(
            src.to_string_lossy().to_string(),
            subdir.to_string_lossy().to_string(),
        )
        .await
        .unwrap();

        assert!(new_path.ends_with("Makefile 2"));
        assert_eq!(fs::read_to_string(subdir.join("Makefile")).unwrap(), "existing");
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

        let canonical_new = new_path_raw.canonicalize().unwrap().to_string_lossy().to_string();

        migrate_encoding_state(&state, &old_copy, &canonical_new);

        let map = state.encodings.lock().unwrap();
        assert!(!map.contains_key(&old_copy));
        assert_eq!(map.get(&canonical_new), Some(&"GBK"));
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
