//! Mobile project library.
//!
//! iOS and Android have no "open any folder": projects live in the library
//! root (`portable::library()`). Bytes chosen in the system picker are first
//! staged into `<app cache>/imports/` — the frontend never hands over
//! `content://` URIs or foreign paths — and only staged files can be imported.
//! Exports land directly in `<app cache>/exports/`, the only directory the
//! native share bridge accepts. New projects reuse
//! `create_project_from_template` with the library root as parent.

use crate::error::AppError;
use crate::services::portable::{self, LibraryLayout};
use crate::services::project_files::is_project_content_path;
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// Largest file the picker may stage, and largest document exported alone.
const MAX_STAGED_FILE_BYTES: u64 = 64 * 1024 * 1024;
/// Applied to project imports and exports alike, so every export imports back.
const ARCHIVE_LIMITS: ArchiveLimits = ArchiveLimits {
    entries: 20_000,
    bytes: 512 * 1024 * 1024,
};
const IMPORTS_DIR: &str = "imports";
const EXPORTS_DIR: &str = "exports";
/// Hidden, so neither the library listing nor the Files app shows a project
/// that is still being assembled.
const PROJECT_STAGING_PREFIX: &str = ".novelist-import-";
/// Disposable staging and export files older than this are removed by the
/// next stage or export.
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
/// Byte budget for generated names, leaving room for bump and date suffixes
/// below the 255-byte APFS / ext4 component limit.
const MAX_NAME_BYTES: usize = 180;
const MAX_NAME_BUMPS: u32 = 9999;
const MAX_PROJECT_TOML_BYTES: u64 = 256 * 1024;
/// In-flight atomic-write files (`*.novelist-tmp`, `.x.novelist-tmp-…`).
const TEMP_MARKER: &str = ".novelist-tmp";

/// `.novelist/` entries that travel with a project: sync identity, project
/// metadata and per-project user data. Credentials, caches, settings and
/// in-flight transaction journals stay behind.
const METADATA_FILES: &[&str] = &[
    "project.toml",
    "sync-identity.json",
    "literary-study.json",
    "book-translation.json",
];
const METADATA_DIRS: &[&str] = &[
    "ai",
    "chats",
    "drafts",
    "naming",
    "publish",
    "publish-assets",
    "templates",
];

/// Formats `export_library_document` accepts.
pub const DOCUMENT_EXPORT_FORMATS: [&str; 2] = ["markdown", "html"];

/// Already-compressed formats are stored instead of deflated again.
const STORED_EXTENSIONS: &[&str] = &[
    "avif", "epub", "gif", "heic", "jpeg", "jpg", "m4a", "mov", "mp3", "mp4", "pdf", "png", "webp",
    "zip",
];

#[derive(Clone, Copy)]
struct ArchiveLimits {
    entries: usize,
    bytes: u64,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct LibraryProject {
    pub path: String,
    /// `[project].name` from `.novelist/project.toml`, else the folder name.
    pub name: String,
    /// Unix epoch milliseconds of the project folder's last change.
    pub modified_at: Option<i64>,
}

/// Absolute path of the project library; the parent directory for
/// `create_project_from_template` on mobile.
#[tauri::command]
#[specta::specta]
pub async fn get_library_path() -> Result<String, AppError> {
    Ok(path_string(portable::library_root()?))
}

/// Library projects, most recently changed first.
#[tauri::command]
#[specta::specta]
pub async fn list_library_projects() -> Result<Vec<LibraryProject>, AppError> {
    let root = portable::library_root()?;
    blocking(move || list_projects_in(root)).await
}

/// Copy picker bytes (base64, at most 64 MiB decoded) into a fresh,
/// cache-confined staging folder. Returns the staged path for
/// `import_library_file` / `import_library_project`.
#[tauri::command]
#[specta::specta]
pub async fn stage_import_file(name: String, base64_data: String) -> Result<String, AppError> {
    let layout = portable::library()?;
    blocking(move || {
        let bytes = decode_import_bytes(&base64_data, MAX_STAGED_FILE_BYTES)?;
        drop(base64_data);
        stage_bytes_in(&layout.cache_root().join(IMPORTS_DIR), &name, &bytes)
            .map(|path| path_string(&path))
    })
    .await
}

/// Copy a staged Markdown / text / Novelist document into a folder of a
/// library project, bumping `name 2.md` on collision. Returns the new path.
#[tauri::command]
#[specta::specta]
pub async fn import_library_file(
    staged_path: String,
    project_dir: String,
) -> Result<String, AppError> {
    let layout = portable::library()?;
    blocking(move || import_file_in(layout, &staged_path, &project_dir)).await
}

/// Unpack a staged project ZIP into a new library project. Nothing appears in
/// the library unless the whole archive was extracted. Returns the project path.
#[tauri::command]
#[specta::specta]
pub async fn import_library_project(archive_path: String) -> Result<String, AppError> {
    let layout = portable::library()?;
    blocking(move || import_project_in(layout, &archive_path, ARCHIVE_LIMITS)).await
}

/// ZIP a library project (content, assets, project identity and metadata;
/// never credentials or caches) into the share-able exports directory.
#[tauri::command]
#[specta::specta]
pub async fn export_library_project(project_dir: String) -> Result<String, AppError> {
    let layout = portable::library()?;
    let archive = blocking(move || export_project_in(layout, &project_dir)).await?;
    Ok(path_string(&archive))
}

/// Export one library document as `markdown` (the original bytes) or `html`
/// (CommonMark rendered and sanitized into a standalone page; not a Pandoc
/// equivalent) into the share-able exports directory.
#[tauri::command]
#[specta::specta]
pub async fn export_library_document(
    file_path: String,
    format: String,
) -> Result<String, AppError> {
    let layout = portable::library()?;
    let exported = blocking(move || export_document_in(layout, &file_path, &format)).await?;
    Ok(path_string(&exported))
}

async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|error| AppError::Custom(format!("Project library task failed: {error}")))?
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

// ── listing ──────────────────────────────────────────────────────────────────

fn list_projects_in(root: &Path) -> Result<Vec<LibraryProject>, AppError> {
    let mut projects = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        // `DirEntry::file_type` does not follow links: linked folders are not projects.
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let folder = entry.file_name();
        let Some(folder) = folder.to_str() else {
            continue;
        };
        if folder.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let modified_at = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .and_then(|age| i64::try_from(age.as_millis()).ok());
        let name = project_display_name(&path).unwrap_or_else(|| folder.to_owned());
        projects.push(LibraryProject {
            path: path_string(&path),
            name,
            modified_at,
        });
    }
    projects.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(projects)
}

fn project_display_name(project: &Path) -> Option<String> {
    #[derive(Deserialize)]
    struct ProjectToml {
        project: ProjectName,
    }
    #[derive(Deserialize)]
    struct ProjectName {
        name: String,
    }
    let path = project.join(".novelist").join("project.toml");
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_PROJECT_TOML_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(&path).ok()?;
    let config: ProjectToml = toml::from_str(&text).ok()?;
    let name = config.project.name.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

// ── names ────────────────────────────────────────────────────────────────────

/// A single visible file or folder name: the last component of whatever the
/// picker reports, with control and reserved characters replaced and leading
/// dots removed. CJK and other Unicode text is kept.
fn safe_name(raw: &str, fallback: &str) -> String {
    let last = raw.rsplit(['/', '\\']).next().unwrap_or_default();
    let replaced: String = last
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = replaced
        .trim()
        .trim_start_matches('.')
        .trim_end_matches(['.', ' '])
        .trim();
    let name = if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    };
    if name.len() <= MAX_NAME_BYTES {
        return name.to_owned();
    }
    let (stem, extension) = match split_extension(name) {
        (stem, extension) if extension.len() <= 16 => (stem, extension),
        _ => (name, ""),
    };
    let mut end = MAX_NAME_BYTES - extension.len();
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{extension}", stem[..end].trim_end())
}

/// `("第一章", ".md")`; dot-files and extension-less names keep everything in the stem.
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(index) if index > 0 => name.split_at(index),
        _ => (name, ""),
    }
}

fn bumped(name: &str, attempt: u32) -> String {
    if attempt == 1 {
        return name.to_owned();
    }
    let (stem, extension) = split_extension(name);
    format!("{stem} {attempt}{extension}")
}

// ── staging ──────────────────────────────────────────────────────────────────

fn decode_import_bytes(data: &str, max: u64) -> Result<Vec<u8>, AppError> {
    use base64::Engine;
    let too_large = || {
        AppError::InvalidInput(format!(
            "Imported files are limited to {} MiB",
            max.div_ceil(1024 * 1024)
        ))
    };
    // Four base64 characters carry three bytes: refuse before allocating.
    if data.len() as u64 > max.div_ceil(3) * 4 {
        return Err(too_large());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| AppError::InvalidInput(format!("Invalid base64: {error}")))?;
    if bytes.len() as u64 > max {
        return Err(too_large());
    }
    Ok(bytes)
}

/// Every staged file gets its own fresh folder, so nothing is overwritten.
fn stage_bytes_in(imports: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, AppError> {
    let file_name = safe_name(name, "Imported file");
    std::fs::create_dir_all(imports)?;
    prune_stale(imports, |_| true);
    let folder = tempfile::Builder::new()
        .prefix("stage-")
        .tempdir_in(imports)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(folder.path().join(&file_name))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    Ok(folder.keep().join(file_name))
}

/// Canonical path of a file staged by [`stage_bytes_in`]; anything else,
/// including links out of the staging area, is refused.
fn staged_file(layout: &LibraryLayout, staged: &str) -> Result<PathBuf, AppError> {
    let not_staged = || AppError::PathNotAllowed(format!("Not a staged import: {staged}"));
    let imports =
        std::fs::canonicalize(layout.cache_root().join(IMPORTS_DIR)).map_err(|_| not_staged())?;
    let path = std::fs::canonicalize(staged).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::FileNotFound(staged.to_owned())
        } else {
            AppError::Io(error)
        }
    })?;
    if !path
        .strip_prefix(&imports)
        .is_ok_and(|relative| relative.components().count() == 2)
    {
        return Err(not_staged());
    }
    let metadata = std::fs::metadata(&path)?;
    if !metadata.is_file() {
        return Err(not_staged());
    }
    if metadata.len() > MAX_STAGED_FILE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "Staged import is too large: {staged}"
        )));
    }
    Ok(path)
}

/// Best effort: the OS also purges the cache directory.
fn discard_staged(path: &Path) {
    let _ = std::fs::remove_file(path);
    if let Some(folder) = path.parent() {
        let _ = std::fs::remove_dir(folder);
    }
}

fn prune_stale(dir: &Path, owned: impl Fn(&str) -> bool) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        if !entry.file_name().to_str().is_some_and(&owned) {
            continue;
        }
        // `DirEntry::metadata` does not follow links.
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > STALE_AFTER);
        if stale {
            let path = entry.path();
            let _ = if metadata.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
        }
    }
}

// ── library paths ────────────────────────────────────────────────────────────

/// Canonical form of an existing, visible `path` strictly inside the library,
/// with its depth below the library root (1 = a project folder). Hidden
/// entries (`.novelist`, imports in progress) are not library content.
fn library_entry(layout: &LibraryLayout, path: &str) -> Result<(PathBuf, usize), AppError> {
    let canonical = std::fs::canonicalize(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::FileNotFound(path.to_owned())
        } else {
            AppError::Io(error)
        }
    })?;
    let depth = canonical
        .strip_prefix(layout.canonical_library_root())
        .ok()
        .filter(|relative| {
            !relative
                .components()
                .any(|component| component.as_os_str().as_encoded_bytes().starts_with(b"."))
        })
        .map_or(0, |relative| relative.components().count());
    if depth == 0 {
        return Err(AppError::PathNotAllowed(format!(
            "Not inside the project library: {path}"
        )));
    }
    Ok((canonical, depth))
}

// ── single-file import ───────────────────────────────────────────────────────

fn import_file_in(
    layout: &LibraryLayout,
    staged: &str,
    project_dir: &str,
) -> Result<String, AppError> {
    let source = staged_file(layout, staged)?;
    let name = source
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| AppError::PathNotAllowed(format!("Not a staged import: {staged}")))?;
    if !is_project_content_path(Path::new(name)) {
        return Err(AppError::InvalidInput(format!(
            "Only Markdown, text and Novelist documents can be imported into a project: {name}"
        )));
    }
    let (target_dir, _) = library_entry(layout, project_dir)?;
    if !target_dir.is_dir() {
        return Err(AppError::NotADirectory(project_dir.to_owned()));
    }
    let bytes = std::fs::read(&source)?;
    let published = publish_file_noclobber(&target_dir, name, &bytes)?;
    discard_staged(&source);
    // Answer under the configured library root the frontend keys state by.
    let imported = path_string(&target_dir.join(published));
    Ok(layout.configured_path(&imported).into_owned())
}

/// Stage durable bytes next to the target, then publish under the first free
/// `name`, `name 2`, … — publication itself decides collisions.
fn publish_file_noclobber(dir: &Path, name: &str, bytes: &[u8]) -> Result<String, AppError> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(".novelist-import-").suffix(TEMP_MARKER);
    // tempfile stages 0600; published documents get the usual 0666 minus umask.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o666));
    }
    let mut staged = builder.tempfile_in(dir)?;
    staged.write_all(bytes)?;
    staged.flush()?;
    staged.as_file().sync_all()?;
    let mut temporary = staged.into_temp_path();
    for attempt in 1..=MAX_NAME_BUMPS {
        let candidate = bumped(name, attempt);
        match temporary.persist_noclobber(dir.join(&candidate)) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                temporary = error.path;
            }
            Err(error) => return Err(error.error.into()),
        }
    }
    Err(AppError::Custom(format!("Too many files named {name}")))
}

// ── project import ───────────────────────────────────────────────────────────

/// Fresh hidden folder inside `root` (same filesystem, so publication is a
/// rename). Removed on drop unless published by [`publish_library_project`].
pub(crate) fn library_staging_dir(root: &Path) -> Result<tempfile::TempDir, AppError> {
    prune_stale(root, |name| name.starts_with(PROJECT_STAGING_PREFIX));
    let staged = tempfile::Builder::new()
        .prefix(PROJECT_STAGING_PREFIX)
        .tempdir_in(root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(staged.path(), std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(staged)
}

/// Move a fully prepared `staged` folder to `root/<name>`, using the first
/// free name among `preferred_name`, `preferred_name 2`, … Existing folders
/// are never replaced; on failure `staged` is removed.
pub(crate) fn publish_library_project(
    root: &Path,
    staged: tempfile::TempDir,
    preferred_name: &str,
) -> Result<PathBuf, AppError> {
    let base = safe_name(preferred_name, "Project");
    for attempt in 1..=MAX_NAME_BUMPS {
        let target = root.join(if attempt == 1 {
            base.clone()
        } else {
            format!("{base} {attempt}")
        });
        if publish_dir_noclobber(staged.path(), &target)? {
            let _ = staged.keep();
            return Ok(target);
        }
    }
    Err(AppError::Custom(format!("Too many projects named {base}")))
}

/// `Ok(false)` when `target` is taken.
#[cfg(unix)]
fn publish_dir_noclobber(staged: &Path, target: &Path) -> std::io::Result<bool> {
    // Reserve the name first: `rename` would replace an existing empty folder.
    match std::fs::create_dir(target) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => return Err(error),
    }
    // Replacing our own still-empty reservation publishes the tree in one step.
    std::fs::rename(staged, target).inspect_err(|_| {
        let _ = std::fs::remove_dir(target);
    })?;
    Ok(true)
}

/// Windows `rename` never replaces an existing folder.
#[cfg(not(unix))]
fn publish_dir_noclobber(staged: &Path, target: &Path) -> std::io::Result<bool> {
    if std::fs::symlink_metadata(target).is_ok() {
        return Ok(false);
    }
    match std::fs::rename(staged, target) {
        Ok(()) => Ok(true),
        Err(_) if std::fs::symlink_metadata(target).is_ok() => Ok(false),
        Err(error) => Err(error),
    }
}

fn import_project_in(
    layout: &LibraryLayout,
    archive_path: &str,
    limits: ArchiveLimits,
) -> Result<String, AppError> {
    let archive = staged_file(layout, archive_path)?;
    let fallback = archive
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("Project")
        .to_owned();
    let root = layout.library_root();
    let staged = library_staging_dir(root)?;
    let wrapper = extract_project_archive(&archive, staged.path(), limits)?;
    let project = publish_library_project(root, staged, wrapper.as_deref().unwrap_or(&fallback))?;
    discard_staged(&archive);
    Ok(path_string(&project))
}

struct ArchiveEntry {
    index: usize,
    name: String,
    parts: Vec<String>,
    is_dir: bool,
}

/// Extract the portable project files of `archive` into the empty `dest`.
/// Returns the archive's single wrapping folder name, if it has one.
fn extract_project_archive(
    archive: &Path,
    dest: &Path,
    limits: ArchiveLimits,
) -> Result<Option<String>, AppError> {
    let mut zip = ZipArchive::new(File::open(archive)?).map_err(invalid_archive)?;
    let entries = archive_entries(&mut zip, limits)?;

    // Ignore Finder litter when looking for a wrapping folder.
    let considered = || {
        entries.iter().filter(|entry| {
            let first = entry.parts[0].as_str();
            first != "__MACOSX" && (first == ".novelist" || !first.starts_with('.'))
        })
    };
    let wrapper = considered()
        .next()
        .map(|entry| entry.parts[0].clone())
        .filter(|first| {
            !first.starts_with('.')
                && considered().all(|entry| {
                    entry.parts[0] == *first && (entry.is_dir || entry.parts.len() > 1)
                })
        });

    let mut written = 0u64;
    let mut files = 0usize;
    for entry in &entries {
        let parts = match &wrapper {
            Some(wrapper) if entry.parts[0] == *wrapper => &entry.parts[1..],
            Some(_) => continue,
            None => &entry.parts[..],
        };
        if parts.is_empty() || !archive_includes(parts, entry.is_dir) {
            continue;
        }
        let target = parts
            .iter()
            .fold(dest.to_path_buf(), |path, part| path.join(part));
        if entry.is_dir {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    AppError::InvalidInput(format!(
                        "Project archive contains a duplicate entry: {}",
                        entry.name
                    ))
                } else {
                    AppError::Io(error)
                }
            })?;
        let mut reader = zip.by_index(entry.index).map_err(invalid_archive)?;
        let remaining = limits.bytes - written;
        // Count real bytes: declared sizes are attacker-controlled.
        let copied = std::io::copy(&mut Read::by_ref(&mut reader).take(remaining + 1), &mut out)?;
        if copied > remaining {
            return Err(archive_too_large());
        }
        written += copied;
        out.sync_all()?;
        files += 1;
    }
    if files == 0 {
        return Err(AppError::InvalidInput(
            "The archive contains no project files".into(),
        ));
    }
    Ok(wrapper)
}

/// Validate every entry before extracting anything.
fn archive_entries<R: Read + Seek>(
    zip: &mut ZipArchive<R>,
    limits: ArchiveLimits,
) -> Result<Vec<ArchiveEntry>, AppError> {
    if zip.len() > limits.entries {
        return Err(AppError::InvalidInput(format!(
            "Project archive has too many entries: {}",
            zip.len()
        )));
    }
    let mut entries = Vec::with_capacity(zip.len());
    let mut declared = 0u64;
    for index in 0..zip.len() {
        let entry = zip.by_index_raw(index).map_err(invalid_archive)?;
        // Archivers that omit the UTF-8 flag still mostly write UTF-8 names
        // (macOS, Linux); anything else falls back to the decoded name.
        let name = String::from_utf8(entry.name_raw().to_vec())
            .unwrap_or_else(|_| entry.name().to_owned());
        let unsafe_path =
            || AppError::InvalidInput(format!("Project archive contains an unsafe path: {name}"));
        if entry.enclosed_name().is_none() {
            return Err(unsafe_path());
        }
        if entry.is_symlink() {
            return Err(AppError::InvalidInput(format!(
                "Project archive contains a symbolic link: {name}"
            )));
        }
        let normalized = name.replace('\\', "/");
        if normalized.starts_with('/') {
            return Err(unsafe_path());
        }
        let trimmed = normalized.strip_suffix('/').unwrap_or(&normalized);
        let parts: Vec<String> = trimmed.split('/').map(str::to_owned).collect();
        if parts.iter().any(|part| {
            part.is_empty() || part == "." || part == ".." || part.chars().any(char::is_control)
        }) {
            return Err(unsafe_path());
        }
        declared = declared.saturating_add(entry.size());
        if declared > limits.bytes {
            return Err(archive_too_large());
        }
        let is_dir = entry.is_dir();
        drop(entry);
        entries.push(ArchiveEntry {
            index,
            name,
            parts,
            is_dir,
        });
    }
    Ok(entries)
}

/// Whether a project-relative path travels in a project archive (both ways):
/// visible files and folders, plus the `.novelist` metadata allow-list.
fn archive_includes<S: AsRef<str>>(parts: &[S], is_dir: bool) -> bool {
    let Some((first, rest)) = parts.split_first() else {
        return false;
    };
    if parts.iter().any(|part| part.as_ref().contains(TEMP_MARKER)) {
        return false;
    }
    match first.as_ref() {
        "__MACOSX" => false,
        ".novelist" => match rest.split_first() {
            None => is_dir,
            Some((name, [])) if is_dir => METADATA_DIRS.contains(&name.as_ref()),
            Some((name, [])) => METADATA_FILES.contains(&name.as_ref()),
            Some((name, inner)) => {
                METADATA_DIRS.contains(&name.as_ref())
                    && inner.iter().all(|part| !part.as_ref().starts_with('.'))
            }
        },
        _ => parts.iter().all(|part| !part.as_ref().starts_with('.')),
    }
}

fn invalid_archive(error: zip::result::ZipError) -> AppError {
    AppError::InvalidInput(format!("Invalid project archive: {error}"))
}

fn archive_too_large() -> AppError {
    AppError::InvalidInput(format!(
        "Projects are limited to {} MiB uncompressed",
        ARCHIVE_LIMITS.bytes / (1024 * 1024)
    ))
}

// ── exports ──────────────────────────────────────────────────────────────────

fn export_temp(exports: &Path) -> Result<tempfile::NamedTempFile, AppError> {
    std::fs::create_dir_all(exports)?;
    prune_stale(exports, |_| true);
    Ok(tempfile::Builder::new()
        .prefix(".export-")
        .suffix(".tmp")
        .tempfile_in(exports)?)
}

/// Publish under `<stem>-<YYYYMMDD-HHMMSS>[ n].<extension>`, never replacing
/// an export that may still be in a share sheet.
fn publish_export(
    exports: &Path,
    stem: &str,
    extension: &str,
    mut temporary: tempfile::NamedTempFile,
) -> Result<PathBuf, AppError> {
    temporary.as_file().sync_all()?;
    let base = format!("{stem}-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    for attempt in 1..=MAX_NAME_BUMPS {
        let target = exports.join(if attempt == 1 {
            format!("{base}.{extension}")
        } else {
            format!("{base} {attempt}.{extension}")
        });
        match temporary.persist_noclobber(&target) {
            Ok(_) => return Ok(target),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                temporary = error.file;
            }
            Err(error) => return Err(error.error.into()),
        }
    }
    Err(AppError::Custom(format!("Too many exports named {base}")))
}

struct ExportEntry {
    relative: String,
    is_dir: bool,
}

fn export_project_in(layout: &LibraryLayout, project_dir: &str) -> Result<PathBuf, AppError> {
    let (project, depth) = library_entry(layout, project_dir)?;
    if depth != 1 || !project.is_dir() {
        return Err(AppError::InvalidInput(format!(
            "Not a library project: {project_dir}"
        )));
    }
    let folder = project
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| AppError::InvalidInput(format!("Not a library project: {project_dir}")))?
        .to_owned();
    let entries = export_entries(&project, ARCHIVE_LIMITS)?;
    if entries.iter().all(|entry| entry.is_dir) {
        return Err(AppError::InvalidInput(
            "The project has no files to export".into(),
        ));
    }
    let exports = layout.cache_root().join(EXPORTS_DIR);
    let mut temporary = export_temp(&exports)?;
    write_project_zip(&project, &folder, &entries, temporary.as_file_mut())?;
    publish_export(&exports, &safe_name(&folder, "Project"), "zip", temporary)
}

fn export_entries(project: &Path, limits: ArchiveLimits) -> Result<Vec<ExportEntry>, AppError> {
    fn utf8_parts(relative: &Path) -> Option<Vec<&str>> {
        relative
            .components()
            .map(|component| match component {
                Component::Normal(name) => name.to_str(),
                _ => None,
            })
            .collect()
    }
    let walker = walkdir::WalkDir::new(project)
        .follow_links(false)
        .min_depth(1)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            let relative = entry.path().strip_prefix(project).unwrap_or(entry.path());
            // Undecodable names are kept here so the loop below reports them.
            utf8_parts(relative)
                .is_none_or(|parts| archive_includes(&parts[..], entry.file_type().is_dir()))
        });
    let mut entries = Vec::new();
    let mut total = 0u64;
    for entry in walker {
        let entry = entry.map_err(|error| AppError::Io(error.into()))?;
        let relative = entry.path().strip_prefix(project).unwrap_or(entry.path());
        let parts = utf8_parts(relative).ok_or_else(|| {
            AppError::InvalidInput(format!(
                "Project contains a name that is not valid UTF-8: {}",
                relative.display()
            ))
        })?;
        let relative = parts.join("/");
        let file_type = entry.file_type();
        if file_type.is_symlink() {
            return Err(AppError::PathNotAllowed(format!(
                "Project export does not follow symlinks: {relative}"
            )));
        }
        if !file_type.is_dir() && !file_type.is_file() {
            continue;
        }
        if file_type.is_file() {
            let metadata = entry
                .metadata()
                .map_err(|error| AppError::Io(error.into()))?;
            total = total.saturating_add(metadata.len());
            if total > limits.bytes {
                return Err(archive_too_large());
            }
        }
        if entries.len() >= limits.entries {
            return Err(AppError::InvalidInput(
                "The project has too many files to export".into(),
            ));
        }
        entries.push(ExportEntry {
            relative,
            is_dir: file_type.is_dir(),
        });
    }
    Ok(entries)
}

fn write_project_zip(
    project: &Path,
    folder: &str,
    entries: &[ExportEntry],
    out: &mut File,
) -> Result<(), AppError> {
    let failed =
        |error: zip::result::ZipError| AppError::Custom(format!("Project export failed: {error}"));
    // Confined reads: a file swapped for a link after the walk cannot pull
    // anything from outside the project into the archive.
    let root = cap_std::fs::Dir::open_ambient_dir(project, cap_std::ambient_authority())?;
    let mut read = cap_std::fs::OpenOptions::new();
    read.read(true).follow(FollowSymlinks::No);
    let mut zip = ZipWriter::new(out);
    let mut written = 0u64;
    for entry in entries {
        let name = format!("{folder}/{}", entry.relative);
        if entry.is_dir {
            zip.add_directory(name, SimpleFileOptions::default().unix_permissions(0o755))
                .map_err(failed)?;
            continue;
        }
        let stored = Path::new(&entry.relative)
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|extension| {
                STORED_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
            });
        let options = SimpleFileOptions::default()
            .compression_method(if stored {
                CompressionMethod::Stored
            } else {
                CompressionMethod::Deflated
            })
            .unix_permissions(0o644);
        zip.start_file(name, options).map_err(failed)?;
        let mut source = root.open_with(&entry.relative, &read)?;
        let remaining = ARCHIVE_LIMITS.bytes - written;
        let copied = std::io::copy(&mut Read::by_ref(&mut source).take(remaining + 1), &mut zip)?;
        if copied > remaining {
            return Err(archive_too_large());
        }
        written += copied;
    }
    zip.finish().map_err(failed)?;
    Ok(())
}

fn export_document_in(
    layout: &LibraryLayout,
    file_path: &str,
    format: &str,
) -> Result<PathBuf, AppError> {
    let (source, depth) = library_entry(layout, file_path)?;
    let metadata = std::fs::metadata(&source)?;
    if depth < 2 || !metadata.is_file() {
        return Err(AppError::InvalidInput(format!(
            "Not a library document: {file_path}"
        )));
    }
    let file_name = source
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default();
    let (stem, extension) = split_extension(file_name);
    if !matches!(
        extension.to_ascii_lowercase().as_str(),
        ".md" | ".markdown" | ".txt"
    ) {
        return Err(AppError::InvalidInput(format!(
            "Only Markdown and text documents can be exported: {file_name}"
        )));
    }
    if metadata.len() > MAX_STAGED_FILE_BYTES {
        return Err(AppError::InvalidInput(format!(
            "Document is too large to export: {file_name}"
        )));
    }
    let bytes = std::fs::read(&source)?;
    let (output, extension) = match format {
        "markdown" => (bytes, "md"),
        "html" => {
            let (_, text) = crate::commands::file::decode_bytes(&bytes);
            (
                standalone_html(stem, &markdown_to_safe_html(&text)).into_bytes(),
                "html",
            )
        }
        other => {
            return Err(AppError::InvalidInput(format!(
                "Unsupported document export format: {other} (supported: {})",
                DOCUMENT_EXPORT_FORMATS.join(", ")
            )))
        }
    };
    let exports = layout.cache_root().join(EXPORTS_DIR);
    let mut temporary = export_temp(&exports)?;
    temporary.write_all(&output)?;
    publish_export(&exports, &safe_name(stem, "Document"), extension, temporary)
}

fn markdown_to_safe_html(markdown: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS;
    let mut rendered = String::with_capacity(markdown.len() + markdown.len() / 2);
    html::push_html(&mut rendered, Parser::new_ext(markdown, options));
    ammonia::clean(&rendered)
}

fn escape_html(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(c),
        }
    }
    escaped
}

fn standalone_html(title: &str, body: &str) -> String {
    const STYLE: &str = "body{max-width:42em;margin:2em auto;padding:0 1em;line-height:1.75;\
font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Hiragino Sans GB\",\
\"Noto Sans CJK SC\",\"Microsoft YaHei\",sans-serif}img{max-width:100%}\
table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:.3em .6em}\
pre{overflow-x:auto}blockquote{margin-left:0;padding-left:1em;border-left:3px solid #ccc;color:#555}";
    format!(
        "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
<title>{}</title>\n<style>{STYLE}</style>\n</head>\n<body>\n{body}</body>\n</html>\n",
        escape_html(title)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    fn layout(tmp: &TempDir, container: &str) -> LibraryLayout {
        let root = tmp.path().join(container);
        LibraryLayout::prepare(
            root.join("Documents/Projects"),
            root.join("Library/Caches/com.novelist.app"),
        )
        .unwrap()
    }

    fn stage(layout: &LibraryLayout, name: &str, bytes: &[u8]) -> String {
        path_string(&stage_bytes_in(&layout.cache_root().join(IMPORTS_DIR), name, bytes).unwrap())
    }

    fn zip_bytes(build: impl FnOnce(&mut ZipWriter<std::io::Cursor<Vec<u8>>>)) -> Vec<u8> {
        let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        build(&mut zip);
        zip.finish().unwrap().into_inner()
    }

    fn add(zip: &mut ZipWriter<std::io::Cursor<Vec<u8>>>, name: &str, bytes: &[u8]) {
        zip.start_file(name, SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// Relative path → bytes for every file under `root`.
    fn tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
        walkdir::WalkDir::new(root)
            .into_iter()
            .map(Result::unwrap)
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| {
                let relative = entry.path().strip_prefix(root).unwrap();
                (
                    relative.to_string_lossy().replace('\\', "/"),
                    std::fs::read(entry.path()).unwrap(),
                )
            })
            .collect()
    }

    fn zip_names(path: &Path) -> Vec<String> {
        let mut zip = ZipArchive::new(File::open(path).unwrap()).unwrap();
        (0..zip.len())
            .map(|index| zip.by_index(index).unwrap().name().to_owned())
            .collect()
    }

    const IDENTITY: &[u8] = br#"{"schema_version":1,"project_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#;

    fn write(root: &Path, relative: &str, bytes: &[u8]) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn staging_keeps_each_upload_separate_and_confined() {
        let tmp = TempDir::new().unwrap();
        let layout = layout(&tmp, "A");
        let first = stage(&layout, "../../Documents/第一章.md", b"one");
        let second = stage(&layout, "第一章.md", b"two");

        let imports = std::fs::canonicalize(layout.cache_root().join(IMPORTS_DIR)).unwrap();
        for (staged, bytes) in [(&first, b"one"), (&second, b"two")] {
            let path = staged_file(&layout, staged).unwrap();
            assert!(path.starts_with(&imports), "{staged}");
            assert_eq!(path.file_name().unwrap(), "第一章.md");
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        assert_ne!(first, second);
        assert_eq!(safe_name("..", "Imported file"), "Imported file");
        assert_eq!(safe_name("C:\\Users\\me\\.secret", "x"), "secret");
    }

    #[test]
    fn oversized_uploads_are_refused_before_and_after_decoding() {
        use base64::Engine;
        let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        assert_eq!(
            decode_import_bytes(&encode(b"0123456789"), 10).unwrap(),
            b"0123456789"
        );
        assert!(decode_import_bytes(&encode(b"0123456789A"), 10).is_err());
        assert!(decode_import_bytes(&"A".repeat(10_000), 10).is_err());
        assert!(decode_import_bytes("not base64!", 100).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn only_files_staged_by_the_app_can_be_imported() {
        let tmp = TempDir::new().unwrap();
        let layout = layout(&tmp, "A");
        let outside = tmp.path().join("secret.md");
        std::fs::write(&outside, "secret").unwrap();
        let loose = layout.cache_root().join("loose.md");
        std::fs::write(&loose, "loose").unwrap();
        let link_dir = layout.cache_root().join(IMPORTS_DIR).join("stage-link");
        std::fs::create_dir_all(&link_dir).unwrap();
        std::os::unix::fs::symlink(&outside, link_dir.join("secret.md")).unwrap();

        for candidate in [&outside, &loose, &link_dir.join("secret.md")] {
            let error = staged_file(&layout, candidate.to_str().unwrap()).unwrap_err();
            assert!(
                matches!(error, AppError::PathNotAllowed(_)),
                "{candidate:?}: {error}"
            );
        }
    }

    #[test]
    fn importing_a_document_bumps_collisions_and_consumes_the_staged_copy() {
        let tmp = TempDir::new().unwrap();
        let layout = layout(&tmp, "A");
        let project = layout.library_root().join("我的小说");
        write(&project, "第一章.md", b"existing");

        let staged = stage(&layout, "第一章.md", "新的 第一章".as_bytes());
        let imported = import_file_in(&layout, &staged, project.to_str().unwrap()).unwrap();

        assert_eq!(imported, path_string(&project.join("第一章 2.md")));
        assert_eq!(std::fs::read_to_string(&imported).unwrap(), "新的 第一章");
        assert_eq!(
            std::fs::read(project.join("第一章.md")).unwrap(),
            b"existing"
        );
        assert!(!Path::new(&staged).exists());
        assert_eq!(names(&project), ["第一章 2.md", "第一章.md"]);
    }

    /// Android reports `/data/user/0/…` for `/data/data/…` and iOS `/var/…` for
    /// `/private/var/…`; the frontend keys workspace state relative to the
    /// configured root it got from `get_library_path`.
    #[cfg(unix)]
    #[test]
    fn canonical_spellings_come_back_under_the_configured_library_root() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir(tmp.path().join("data")).unwrap();
        let alias = tmp.path().join("user-0");
        std::os::unix::fs::symlink(tmp.path().join("data"), &alias).unwrap();
        let layout =
            LibraryLayout::prepare(alias.join("Projects"), tmp.path().join("cache")).unwrap();
        let configured = layout.library_root().to_path_buf();
        let canonical = layout.canonical_library_root().to_path_buf();
        assert_ne!(configured, canonical);
        std::fs::create_dir(canonical.join("书")).unwrap();

        let staged = stage(&layout, "第一章.md", "正文".as_bytes());
        let canonical_project = canonical.join("书");
        let imported =
            import_file_in(&layout, &staged, canonical_project.to_str().unwrap()).unwrap();
        assert_eq!(
            imported,
            path_string(&configured.join("书").join("第一章.md"))
        );
        let relative = Path::new(&imported).strip_prefix(&configured).unwrap();
        assert_eq!(relative, Path::new("书/第一章.md"));

        let project = canonical_project.to_str().unwrap();
        let expected = path_string(&configured.join("书"));
        assert_eq!(layout.configured_path(project), expected);
        let listed = list_projects_in(layout.library_root()).unwrap();
        assert_eq!(listed[0].path, expected);
        // Not inside the library: unchanged.
        let outside = tmp.path().join("cache").to_string_lossy().into_owned();
        assert_eq!(layout.configured_path(&outside), outside);
    }

    #[test]
    fn document_imports_are_limited_to_documents_inside_the_library() {
        let tmp = TempDir::new().unwrap();
        let layout = layout(&tmp, "A");
        let project = layout.library_root().join("书");
        std::fs::create_dir_all(&project).unwrap();
        let outside = tmp.path().join("elsewhere");
        std::fs::create_dir_all(&outside).unwrap();

        let script = stage(&layout, "run.sh", b"#!/bin/sh");
        assert!(matches!(
            import_file_in(&layout, &script, project.to_str().unwrap()),
            Err(AppError::InvalidInput(_))
        ));
        let note = stage(&layout, "note.txt", b"note");
        for target in [&outside, &layout.library_root().to_path_buf()] {
            assert!(matches!(
                import_file_in(&layout, &note, target.to_str().unwrap()),
                Err(AppError::PathNotAllowed(_))
            ));
        }
        assert!(
            Path::new(&note).exists(),
            "a refused import keeps the staged file"
        );
        assert!(names(&outside).is_empty());
    }

    #[test]
    fn project_roundtrip_keeps_cjk_names_identity_and_assets_but_not_secrets() {
        let tmp = TempDir::new().unwrap();
        let device = layout(&tmp, "A");
        let project = device.library_root().join("长夜 小说");
        let kept: &[(&str, &[u8])] = &[
            ("第一卷/第一章.md", "# 第一章\n\n「你好」".as_bytes()),
            ("素材/封面.png", b"\x89PNG\r\n\x1a\nimage"),
            ("notes.txt", b"plain"),
            (
                ".novelist/project.toml",
                "[project]\nname = \"长夜\"\n".as_bytes(),
            ),
            (".novelist/sync-identity.json", IDENTITY),
            (".novelist/drafts/第一卷__第一章.md.draft.md", b"draft"),
            (".novelist/publish-assets/cover.png", b"cover"),
        ];
        for (relative, bytes) in kept {
            write(&project, relative, bytes);
        }
        let dropped: &[(&str, &[u8])] = &[
            (".novelist/credentials.json", b"token"),
            (".novelist/settings.json", b"{}"),
            (".novelist/sync-config.json", b"{\"password\":\"x\"}"),
            (".novelist/cache/index.bin", b"cache"),
            (".novelist/rename-migrations/j.json", b"{}"),
            (".git/config", b"[core]"),
            (".DS_Store", b"finder"),
            ("第一卷/.第一章.md.novelist-tmp-1", b"partial"),
            ("第一卷/第二章.md.novelist-tmp", b"partial"),
        ];
        for (relative, bytes) in dropped {
            write(&project, relative, bytes);
        }
        std::fs::create_dir_all(project.join("空文件夹")).unwrap();

        let exported = export_project_in(&device, project.to_str().unwrap()).unwrap();
        let exports = std::fs::canonicalize(device.cache_root().join(EXPORTS_DIR)).unwrap();
        assert_eq!(
            std::fs::canonicalize(exported.parent().unwrap()).unwrap(),
            exports
        );
        let file_name = exported.file_name().unwrap().to_str().unwrap();
        assert!(
            file_name.starts_with("长夜 小说-") && file_name.ends_with(".zip"),
            "{file_name}"
        );
        let entries = zip_names(&exported);
        assert!(
            entries.iter().all(|name| name.starts_with("长夜 小说/")),
            "{entries:?}"
        );
        for secret in [
            "credentials",
            "settings.json",
            "sync-config",
            "cache",
            ".git",
            "novelist-tmp",
        ] {
            assert!(
                !entries.iter().any(|name| name.contains(secret)),
                "{secret}: {entries:?}"
            );
        }

        // Another device: the archive arrives through the picker.
        let other = layout(&tmp, "B");
        let staged = stage(&other, file_name, &std::fs::read(&exported).unwrap());
        let imported = import_project_in(&other, &staged, ARCHIVE_LIMITS).unwrap();
        assert_eq!(
            imported,
            path_string(&other.library_root().join("长夜 小说"))
        );
        let expected: BTreeMap<String, Vec<u8>> = kept
            .iter()
            .map(|(relative, bytes)| (relative.to_string(), bytes.to_vec()))
            .collect();
        assert_eq!(tree(Path::new(&imported)), expected);
        assert!(Path::new(&imported).join("空文件夹").is_dir());
        assert!(!Path::new(&staged).exists());

        // Importing the same archive again never touches the first copy.
        let again = stage(&other, file_name, &std::fs::read(&exported).unwrap());
        let second = import_project_in(&other, &again, ARCHIVE_LIMITS).unwrap();
        assert_eq!(
            second,
            path_string(&other.library_root().join("长夜 小说 2"))
        );
        assert_eq!(names(other.library_root()), ["长夜 小说", "长夜 小说 2"]);
        let listed = list_projects_in(other.library_root()).unwrap();
        assert!(
            listed.iter().all(|project| project.name == "长夜"),
            "{listed:?}"
        );
    }

    fn assert_import_refused(archive: Vec<u8>, limits: ArchiveLimits) -> AppError {
        let tmp = TempDir::new().unwrap();
        let layout = layout(&tmp, "A");
        let staged = stage(&layout, "project.zip", &archive);
        let error = import_project_in(&layout, &staged, limits).unwrap_err();
        // No project, no half-extracted staging folder.
        assert!(names(layout.library_root()).is_empty(), "{error}");
        assert!(names(tmp.path()).iter().all(|name| name == "A"));
        error
    }

    #[test]
    fn traversal_entries_abort_the_whole_import() {
        for evil in [
            "书/../../escape.md",
            "/etc/evil.md",
            "书\\..\\..\\escape.md",
        ] {
            let archive = zip_bytes(|zip| {
                add(zip, "书/第一章.md", b"first");
                add(zip, evil, b"evil");
            });
            let error = assert_import_refused(archive, ARCHIVE_LIMITS);
            assert!(error.to_string().contains("unsafe path"), "{evil}: {error}");
        }
    }

    #[test]
    fn symlink_entries_abort_the_whole_import() {
        let archive = zip_bytes(|zip| {
            add(zip, "书/第一章.md", b"first");
            zip.add_symlink("书/link", "/etc/passwd", SimpleFileOptions::default())
                .unwrap();
        });
        let error = assert_import_refused(archive, ARCHIVE_LIMITS);
        assert!(error.to_string().contains("symbolic link"), "{error}");
    }

    #[test]
    fn oversized_and_duplicate_archives_leave_nothing_behind() {
        let big = zip_bytes(|zip| {
            add(zip, "书/a.md", &[b'a'; 64]);
            add(zip, "书/b.md", &[b'b'; 64]);
        });
        assert_import_refused(
            big.clone(),
            ArchiveLimits {
                entries: 10,
                bytes: 100,
            },
        );
        assert_import_refused(
            big,
            ArchiveLimits {
                entries: 1,
                bytes: 1 << 20,
            },
        );

        let duplicate = zip_bytes(|zip| {
            add(zip, "书/a.md", b"one");
            // Writers refuse identical names; this one collides once normalized.
            add(zip, "书\\a.md", b"two");
        });
        let error = assert_import_refused(duplicate, ARCHIVE_LIMITS);
        assert!(error.to_string().contains("duplicate"), "{error}");
    }

    #[test]
    fn unwrapped_archives_are_named_after_the_file_and_drop_credentials() {
        let tmp = TempDir::new().unwrap();
        let layout = layout(&tmp, "A");
        let archive = zip_bytes(|zip| {
            add(zip, "第一章.md", b"chapter");
            add(zip, ".novelist/project.toml", b"[project]\nname = \"x\"\n");
            add(zip, ".novelist/credentials.json", b"token");
            add(zip, "__MACOSX/._第一章.md", b"finder");
        });
        let staged = stage(&layout, "旧稿.zip", &archive);
        let project = import_project_in(&layout, &staged, ARCHIVE_LIMITS).unwrap();
        assert_eq!(project, path_string(&layout.library_root().join("旧稿")));
        assert_eq!(
            tree(Path::new(&project)).into_keys().collect::<Vec<_>>(),
            [".novelist/project.toml", "第一章.md"]
        );
    }

    #[test]
    fn document_export_preserves_markdown_bytes_and_renders_safe_html() {
        let tmp = TempDir::new().unwrap();
        let layout = layout(&tmp, "A");
        let project = layout.library_root().join("书");
        let markdown = "---\ntitle: x\n---\n# 第一章 <雪>\n\n「你好」<script>alert(1)</script>\n";
        write(&project, "a<b>&\"c\".md", markdown.as_bytes());
        let file = project.join("a<b>&\"c\".md");

        let exported = export_document_in(&layout, file.to_str().unwrap(), "markdown").unwrap();
        assert_eq!(std::fs::read(&exported).unwrap(), markdown.as_bytes());
        assert_eq!(exported.extension().unwrap(), "md");

        let html_path = export_document_in(&layout, file.to_str().unwrap(), "html").unwrap();
        let html = std::fs::read_to_string(&html_path).unwrap();
        assert!(
            html.contains("<title>a&lt;b&gt;&amp;&quot;c&quot;</title>"),
            "{html}"
        );
        assert!(
            html.contains("第一章 &lt;雪&gt;") && html.contains("「你好」"),
            "{html}"
        );
        assert!(
            !html.contains("<script") && !html.contains("title: x"),
            "{html}"
        );
        let exports = std::fs::canonicalize(layout.cache_root().join(EXPORTS_DIR)).unwrap();
        assert_eq!(
            std::fs::canonicalize(html_path.parent().unwrap()).unwrap(),
            exports
        );

        let outside = tmp.path().join("outside.md");
        std::fs::write(&outside, "x").unwrap();
        assert!(matches!(
            export_document_in(&layout, outside.to_str().unwrap(), "markdown"),
            Err(AppError::PathNotAllowed(_))
        ));
        assert!(export_document_in(&layout, file.to_str().unwrap(), "docx").is_err());
    }

    #[test]
    fn listing_shows_projects_but_not_imports_in_progress() {
        let tmp = TempDir::new().unwrap();
        let layout = layout(&tmp, "A");
        let root = layout.library_root();
        write(
            &root.join("folder-name"),
            ".novelist/project.toml",
            "[project]\nname = \"显示名\"\n".as_bytes(),
        );
        std::fs::create_dir(root.join("散稿")).unwrap();
        std::fs::write(root.join("loose.md"), "x").unwrap();
        let _staging = library_staging_dir(root).unwrap();

        let mut listed: Vec<(String, String)> = list_projects_in(root)
            .unwrap()
            .into_iter()
            .map(|project| (project.name, project.path))
            .collect();
        listed.sort();
        assert_eq!(
            listed,
            [
                ("散稿".to_owned(), path_string(&root.join("散稿"))),
                ("显示名".to_owned(), path_string(&root.join("folder-name"))),
            ]
        );
    }
}
