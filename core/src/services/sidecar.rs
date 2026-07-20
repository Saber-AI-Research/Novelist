//! Atomic sidecar storage primitives shared by draft, auto-name, and
//! publish lifecycle callers. See `docs/design-docs/file-lifecycle.md`.

use crate::error::AppError;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions as CapOpenOptions};
use serde::{de::DeserializeOwned, Serialize};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const TEMP_SUFFIX: &str = ".novelist-tmp";
pub(crate) const MAX_DRAFT_NOTE_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_MANAGED_NAME_SIDECAR_BYTES: usize = 256 * 1024;
pub(crate) const MAX_PUBLISH_SIDECAR_BYTES: usize = 4 * 1024 * 1024;
const MAX_CHANNEL_ID_LEN: usize = 128;
const MAX_MARKER_LEN: usize = 64;
const MAX_SUBDIR_LEN: usize = 64;
const MAX_KEY_LEN: usize = 140;
const MAX_SUFFIX_LEN: usize = 32;
const MAX_TEMP_ATTEMPTS: usize = 32;
const KEY_HASH_HEX_LEN: usize = 32;
const KEY_HASH_SEP: &str = "~";

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(all(test, unix))]
static CONFINED_READ_SWAP_TARGET: std::sync::OnceLock<std::sync::Mutex<Option<PathBuf>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
static CONFINED_REMOVE_FAILURE: std::sync::OnceLock<std::sync::Mutex<Option<(PathBuf, usize)>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
pub(crate) fn set_confined_remove_failure_after(storage_path: PathBuf, successes: usize) {
    *CONFINED_REMOVE_FAILURE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap() = Some((storage_path, successes));
}

#[cfg(test)]
fn run_confined_remove_failure_hook(storage_path: &Path) -> Result<(), AppError> {
    let mut hook = CONFINED_REMOVE_FAILURE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap();
    let Some((expected_path, remaining)) = hook.as_mut() else {
        return Ok(());
    };
    if expected_path != storage_path {
        return Ok(());
    }
    if *remaining > 0 {
        *remaining -= 1;
        return Ok(());
    }
    *hook = None;
    Err(AppError::Io(std::io::Error::other(
        "injected confined remove failure",
    )))
}

#[cfg(all(test, unix))]
fn set_confined_read_swap_target(target: PathBuf) {
    *CONFINED_READ_SWAP_TARGET
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap() = Some(target);
}

#[cfg(all(test, unix))]
fn run_confined_read_swap_hook(storage_path: &Path, file_name: &str) {
    let Some(target) = CONFINED_READ_SWAP_TARGET
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap()
        .take()
    else {
        return;
    };
    let path = storage_path.join(file_name);
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(target, path).unwrap();
}

pub(crate) struct ConfinedMetadataDir {
    pub(crate) dir: Dir,
    pub(crate) absolute: PathBuf,
}

pub(crate) fn open_confined_metadata_dir(
    project_dir: &Path,
    subdir: &str,
    create: bool,
) -> Result<Option<ConfinedMetadataDir>, AppError> {
    validate_subdir(subdir)?;
    let canonical_project = std::fs::canonicalize(project_dir).map_err(AppError::Io)?;
    let project =
        Dir::open_ambient_dir(&canonical_project, ambient_authority()).map_err(AppError::Io)?;
    let novelist = Path::new(".novelist");
    if !ensure_confined_directory_component(&project, novelist, create)? {
        return Ok(None);
    }
    let novelist_dir = project.open_dir_nofollow(novelist).map_err(|error| {
        AppError::PathNotAllowed(format!(
            "Cannot open confined metadata directory {}: {error}",
            canonical_project.join(novelist).display()
        ))
    })?;
    let relative = novelist.join(subdir);
    if !ensure_confined_directory_component(&novelist_dir, Path::new(subdir), create)? {
        return Ok(None);
    }
    let dir = novelist_dir
        .open_dir_nofollow(Path::new(subdir))
        .map_err(|error| {
            AppError::PathNotAllowed(format!(
                "Cannot open confined metadata directory {}: {error}",
                canonical_project.join(&relative).display()
            ))
        })?;
    let after = novelist_dir
        .symlink_metadata(Path::new(subdir))
        .map_err(AppError::Io)?;
    if after.file_type().is_symlink() || !after.is_dir() {
        return Err(AppError::PathNotAllowed(format!(
            "Metadata directory is not a regular directory: {}",
            canonical_project.join(&relative).display()
        )));
    }
    let absolute =
        std::fs::canonicalize(canonical_project.join(&relative)).map_err(AppError::Io)?;
    if !absolute.starts_with(&canonical_project) {
        return Err(AppError::PathNotAllowed(format!(
            "Metadata directory escapes project: {}",
            absolute.display()
        )));
    }
    Ok(Some(ConfinedMetadataDir { dir, absolute }))
}

fn ensure_confined_directory_component(
    project: &Dir,
    relative: &Path,
    create: bool,
) -> Result<bool, AppError> {
    match project.symlink_metadata(relative) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(AppError::PathNotAllowed(format!(
                    "Metadata directory must not be a symlink: {}",
                    relative.display()
                )));
            }
            if !metadata.is_dir() {
                return Err(AppError::NotADirectory(relative.display().to_string()));
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            project.create_dir(relative).map_err(|create_error| {
                AppError::PathNotAllowed(format!(
                    "Cannot create metadata directory {}: {create_error}",
                    relative.display()
                ))
            })?;
            Ok(true)
        }
        Err(error) => Err(AppError::Io(error)),
    }
}

pub(crate) async fn read_json_confined<T>(
    storage: &ConfinedMetadataDir,
    file_name: &str,
    max_bytes: usize,
) -> Result<Option<T>, AppError>
where
    T: DeserializeOwned,
{
    let bytes = read_bytes_confined(storage, file_name, max_bytes).await?;
    bytes
        .map(|bytes| serde_json::from_slice(&bytes).map_err(AppError::Json))
        .transpose()
}

pub(crate) async fn read_bytes_confined(
    storage: &ConfinedMetadataDir,
    file_name: &str,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, AppError> {
    validate_filename_component(file_name, "metadata filename")?;
    let read_limit = max_bytes.checked_add(1).ok_or_else(|| {
        AppError::InvalidInput(
            "Confined metadata read limit must be less than usize::MAX".to_string(),
        )
    })?;
    let read_limit = u64::try_from(read_limit).map_err(|_| {
        AppError::InvalidInput("Confined metadata read limit does not fit in u64".to_string())
    })?;
    let dir = storage.dir.try_clone().map_err(AppError::Io)?;
    #[cfg(all(test, unix))]
    let storage_path = storage.absolute.clone();
    let file_name = file_name.to_string();
    tokio::task::spawn_blocking(move || {
        match dir.symlink_metadata(&file_name) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(AppError::PathNotAllowed(format!(
                    "Metadata file must not be a symlink: {file_name}"
                )))
            }
            Ok(metadata) if !metadata.is_file() => {
                return Err(AppError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("Metadata path is not a regular file: {file_name}"),
                )))
            }
            Ok(metadata) => ensure_byte_limit(&file_name, metadata.len(), max_bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(AppError::Io(error)),
        }
        #[cfg(all(test, unix))]
        run_confined_read_swap_hook(&storage_path, &file_name);
        let mut options = CapOpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let file = match dir.open_with(&file_name, &options) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(AppError::PathNotAllowed(format!(
                    "Cannot open confined metadata file {file_name}: {error}"
                )))
            }
        };
        let metadata = file.metadata().map_err(AppError::Io)?;
        if !metadata.is_file() {
            return Err(AppError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("Metadata path is not a regular file: {file_name}"),
            )));
        }
        ensure_byte_limit(&file_name, metadata.len(), max_bytes)?;
        let capacity = usize::try_from(metadata.len())
            .unwrap_or(max_bytes)
            .min(max_bytes);
        let mut bytes = Vec::with_capacity(capacity);
        file.take(read_limit)
            .read_to_end(&mut bytes)
            .map_err(AppError::Io)?;
        if bytes.len() > max_bytes {
            return Err(byte_limit_error(&file_name, bytes.len() as u64, max_bytes));
        }
        Ok(Some(bytes))
    })
    .await
    .map_err(|error| AppError::Custom(format!("spawn_blocking join: {error}")))?
}

pub(crate) async fn file_exists_confined(
    storage: &ConfinedMetadataDir,
    file_name: &str,
) -> Result<bool, AppError> {
    validate_filename_component(file_name, "metadata filename")?;
    let dir = storage.dir.try_clone().map_err(AppError::Io)?;
    let file_name = file_name.to_string();
    tokio::task::spawn_blocking(move || match dir.symlink_metadata(&file_name) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(AppError::PathNotAllowed(
            format!("Metadata file must not be a symlink: {file_name}"),
        )),
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("Metadata path is not a regular file: {file_name}"),
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(AppError::Io(error)),
    })
    .await
    .map_err(|error| AppError::Custom(format!("spawn_blocking join: {error}")))?
}

fn ensure_byte_limit(file_name: &str, actual: u64, max_bytes: usize) -> Result<(), AppError> {
    let max_bytes_u64 = u64::try_from(max_bytes).unwrap_or(u64::MAX);
    if actual > max_bytes_u64 {
        return Err(byte_limit_error(file_name, actual, max_bytes));
    }
    Ok(())
}

fn byte_limit_error(file_name: &str, actual: u64, max_bytes: usize) -> AppError {
    AppError::InvalidInput(format!(
        "Confined metadata file {file_name} is {actual} bytes; limit is {max_bytes}"
    ))
}
pub(crate) async fn atomic_write_json_confined<T>(
    storage: &ConfinedMetadataDir,
    file_name: &str,
    value: &T,
    max_bytes: usize,
) -> Result<(), AppError>
where
    T: Serialize + ?Sized,
{
    let bytes = serde_json::to_vec_pretty(value)?;
    if bytes.len() > max_bytes {
        return Err(byte_limit_error(file_name, bytes.len() as u64, max_bytes));
    }
    atomic_write_bytes_confined(storage, file_name, &bytes).await
}

pub(crate) async fn atomic_write_bytes_confined(
    storage: &ConfinedMetadataDir,
    file_name: &str,
    bytes: &[u8],
) -> Result<(), AppError> {
    validate_filename_component(file_name, "metadata filename")?;
    let dir = storage.dir.try_clone().map_err(AppError::Io)?;
    let file_name = file_name.to_string();
    let bytes = bytes.to_vec();
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        match dir.symlink_metadata(&file_name) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(AppError::PathNotAllowed(format!(
                    "Metadata file must not be a symlink: {file_name}"
                )))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(AppError::Io(error)),
        }
        let pid = std::process::id();
        let mut last_error = None;
        for _ in 0..MAX_TEMP_ATTEMPTS {
            let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let temp_name = format!(".{file_name}.{pid}.{counter}{TEMP_SUFFIX}");
            let mut options = CapOpenOptions::new();
            options.write(true).create_new(true);
            let mut file = match dir.open_with(&temp_name, &options) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    last_error = Some(error);
                    continue;
                }
                Err(error) => return Err(AppError::Io(error)),
            };
            let write_result = (|| -> Result<(), AppError> {
                file.write_all(&bytes).map_err(AppError::Io)?;
                file.flush().map_err(AppError::Io)?;
                file.sync_all().map_err(AppError::Io)
            })();
            drop(file);
            if let Err(error) = write_result {
                let _ = dir.remove_file(&temp_name);
                return Err(error);
            }
            if let Err(error) = dir.rename(&temp_name, &dir, &file_name) {
                let _ = dir.remove_file(&temp_name);
                return Err(AppError::Io(error));
            }
            return Ok(());
        }
        Err(AppError::Custom(format!(
            "failed to allocate confined metadata temp for {file_name}: {}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "unknown error".to_string())
        )))
    })
    .await
    .map_err(|error| AppError::Custom(format!("spawn_blocking join: {error}")))?
}

pub(crate) async fn remove_file_confined(
    storage: &ConfinedMetadataDir,
    file_name: &str,
) -> Result<(), AppError> {
    validate_filename_component(file_name, "metadata filename")?;
    let dir = storage.dir.try_clone().map_err(AppError::Io)?;
    #[cfg(test)]
    let storage_path = storage.absolute.clone();
    let file_name = file_name.to_string();
    tokio::task::spawn_blocking(move || {
        #[cfg(test)]
        run_confined_remove_failure_hook(&storage_path)?;
        match dir.remove_file(&file_name) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AppError::Io(error)),
        }
    })
    .await
    .map_err(|error| AppError::Custom(format!("spawn_blocking join: {error}")))?
}

pub(crate) async fn modified_key_confined(
    storage: &ConfinedMetadataDir,
    file_name: &str,
) -> Result<Option<(u64, u32)>, AppError> {
    validate_filename_component(file_name, "metadata filename")?;
    let dir = storage.dir.try_clone().map_err(AppError::Io)?;
    let file_name = file_name.to_string();
    tokio::task::spawn_blocking(move || {
        let mut options = CapOpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let file = match dir.open_with(&file_name, &options) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(AppError::PathNotAllowed(format!(
                    "Cannot open confined metadata file {file_name}: {error}"
                )))
            }
        };
        let metadata = file.metadata().map_err(AppError::Io)?;
        if !metadata.is_file() {
            return Err(AppError::PathNotAllowed(format!(
                "Metadata path is not a regular file: {file_name}"
            )));
        }
        let key = metadata
            .modified()
            .ok()
            .and_then(|time| time.into_std().duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| (duration.as_secs(), duration.subsec_nanos()))
            .unwrap_or((0, 0));
        Ok(Some(key))
    })
    .await
    .map_err(|error| AppError::Custom(format!("spawn_blocking join: {error}")))?
}

/// Canonical, collision-resistant, byte-bounded sidecar key for a document.
///
/// - Each path segment is percent-encoded (`%`, `/`, `\`, control chars,
///   `\0`, and Windows-forbidden chars `<>:"|?*` become `%XX`).
/// - Encoded segments are joined with `%2F` so nested paths and files whose
///   name literally contains the join sequence can never collide:
///   `a/b.md` -> `a%2Fb.md`, whereas a hypothetical single file named
///   `a%2Fb.md` on disk would round-trip as `a%252Fb.md`.
/// - CJK/spaces round-trip verbatim.
/// - Windows separators are normalised to `/` before encoding.
/// - `..` components, absolute paths outside `project_dir`, empty inputs,
///   and null bytes are rejected before any encoding happens.
/// - If the encoded key would exceed [`MAX_KEY_LEN`] bytes (a conservative
///   140-byte budget chosen so `<key>.conflict-<64B marker>.<32B suffix>`
///   stays under the universal 255-byte component ceiling), it is rewritten
///   as `<safe-truncated-front>~<32-hex-blake3>` where the readable prefix
///   is truncated on a UTF-8 code-point boundary *and* backed off past any
///   incomplete `%XX` escape. The hash is BLAKE3 of the full encoded key,
///   truncated to 128 bits, which is deterministic and collision-resistant
///   at project-file scale.
pub fn document_key(project_dir: &Path, file_path: &Path) -> Result<String, AppError> {
    let project = normalize_separators(project_dir);
    let file = normalize_separators(file_path);

    if file.as_os_str().is_empty() {
        return Err(AppError::InvalidInput("Empty document path".to_string()));
    }
    if file.to_string_lossy().contains('\0') {
        return Err(AppError::PathNotAllowed(
            "Document path contains a null byte".to_string(),
        ));
    }
    for component in file.components() {
        if matches!(component, Component::ParentDir) {
            return Err(AppError::PathNotAllowed(format!(
                "Path traversal not allowed: {}",
                file_path.display()
            )));
        }
    }

    let relative: PathBuf = if file.is_absolute() {
        file.strip_prefix(&project)
            .map_err(|_| {
                AppError::PathNotAllowed(format!(
                    "Path is outside project: {}",
                    file_path.display()
                ))
            })?
            .to_path_buf()
    } else {
        file.clone()
    };

    if relative.as_os_str().is_empty() {
        return Err(AppError::InvalidInput(
            "Document path resolves to project root".to_string(),
        ));
    }

    let mut segments: Vec<String> = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => {
                let text = part.to_string_lossy().to_string();
                if !text.is_empty() {
                    segments.push(encode_segment(&text));
                }
            }
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(AppError::PathNotAllowed(format!(
                    "Path traversal not allowed: {}",
                    file_path.display()
                )));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::PathNotAllowed(format!(
                    "Path is outside project: {}",
                    file_path.display()
                )));
            }
        }
    }

    if segments.is_empty() {
        return Err(AppError::InvalidInput(
            "Document path resolves to project root".to_string(),
        ));
    }

    if let Some(first) = segments.first_mut() {
        if first.starts_with('.') {
            first.replace_range(..1, "%2E");
        }
    }
    let full_key = segments.join("%2F");
    if full_key.len() <= MAX_KEY_LEN {
        return Ok(full_key);
    }
    Ok(bounded_key(&full_key))
}

fn bounded_key(full_key: &str) -> String {
    let prefix_budget = MAX_KEY_LEN - KEY_HASH_SEP.len() - KEY_HASH_HEX_LEN;
    let readable = safe_truncate_for_key(full_key, prefix_budget);
    let digest = blake3::hash(full_key.as_bytes()).to_hex();
    let hash_short = &digest.as_str()[..KEY_HASH_HEX_LEN];
    format!("{}{}{}", readable, KEY_HASH_SEP, hash_short)
}

fn safe_truncate_for_key(s: &str, budget: usize) -> &str {
    if s.len() <= budget {
        return s;
    }
    let mut end = budget;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let bytes = s.as_bytes();
    for lookback in 1..=2usize {
        if end >= lookback && bytes[end - lookback] == b'%' {
            end -= lookback;
            break;
        }
    }
    &s[..end]
}

fn normalize_separators(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if s.contains('\\') {
        PathBuf::from(s.replace('\\', "/"))
    } else {
        path.to_path_buf()
    }
}

fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for ch in segment.chars() {
        match ch {
            '%' => out.push_str("%25"),
            '/' => out.push_str("%2F"),
            '\\' => out.push_str("%5C"),
            '\0' => out.push_str("%00"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            ':' => out.push_str("%3A"),
            '"' => out.push_str("%22"),
            '|' => out.push_str("%7C"),
            '?' => out.push_str("%3F"),
            '*' => out.push_str("%2A"),
            c if c.is_control() => {
                let mut buf = [0u8; 4];
                for byte in c.encode_utf8(&mut buf).bytes() {
                    out.push_str(&format!("%{:02X}", byte));
                }
            }
            c => out.push(c),
        }
    }
    out
}

/// Compute an on-disk sidecar path: `<project_dir>/.novelist/<subdir>/<key><suffix>`.
///
/// `subdir`, `key`, and `suffix` are validated against a strict grammar so
/// no combination of them can escape `<project_dir>/.novelist/`. Callers
/// should pass keys produced by [`document_key`] and constant literal
/// subdir/suffix values.
pub fn sidecar_path(
    project_dir: &Path,
    subdir: &str,
    key: &str,
    suffix: &str,
) -> Result<PathBuf, AppError> {
    validate_subdir(subdir)?;
    validate_key(key)?;
    validate_suffix(suffix)?;

    let file_name = format!("{}{}", key, suffix);
    validate_filename_component(&file_name, "sidecar filename")?;

    Ok(project_dir.join(".novelist").join(subdir).join(file_name))
}

/// Resolve an existing legacy sidecar filename without applying the canonical
/// key-length grammar. Legacy callers already flattened path separators; the
/// complete filename is still required to be one filesystem component.
pub(crate) fn legacy_sidecar_path(
    project_dir: &Path,
    subdir: &str,
    legacy_key: &str,
    suffix: &str,
) -> Result<Option<PathBuf>, AppError> {
    validate_subdir(subdir)?;
    validate_suffix(suffix)?;
    let file_name = format!("{legacy_key}{suffix}");
    if legacy_component_len(&file_name) > 255 {
        return Ok(None);
    }
    validate_filename_component(&file_name, "legacy sidecar filename")?;
    Ok(Some(
        project_dir.join(".novelist").join(subdir).join(file_name),
    ))
}

#[cfg(windows)]
fn legacy_component_len(value: &str) -> usize {
    windows_component_len(value)
}

#[cfg(not(windows))]
fn legacy_component_len(value: &str) -> usize {
    value.len()
}

#[cfg(any(windows, test))]
fn windows_component_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn validate_subdir(subdir: &str) -> Result<(), AppError> {
    if subdir.is_empty() {
        return Err(AppError::InvalidInput(
            "Sidecar subdir must not be empty".to_string(),
        ));
    }
    if subdir.len() > MAX_SUBDIR_LEN {
        return Err(AppError::InvalidInput(format!(
            "Sidecar subdir exceeds {} characters",
            MAX_SUBDIR_LEN
        )));
    }
    if subdir == "." || subdir == ".." {
        return Err(AppError::PathNotAllowed(format!(
            "Sidecar subdir must not be '.' or '..': {}",
            subdir
        )));
    }
    if subdir.contains("..") {
        return Err(AppError::PathNotAllowed(
            "Sidecar subdir must not contain '..'".to_string(),
        ));
    }
    for ch in subdir.chars() {
        if ch == '/' || ch == '\\' || ch == '\0' {
            return Err(AppError::PathNotAllowed(format!(
                "Sidecar subdir contains disallowed character: {:?}",
                ch
            )));
        }
        if ch.is_whitespace() || ch.is_control() {
            return Err(AppError::PathNotAllowed(
                "Sidecar subdir must not contain whitespace or control characters".to_string(),
            ));
        }
        let safe = ch.is_ascii_alphanumeric() || ch == '-' || ch == '_';
        if !safe {
            return Err(AppError::PathNotAllowed(format!(
                "Sidecar subdir contains disallowed character: {:?}",
                ch
            )));
        }
    }
    Ok(())
}

fn validate_key(key: &str) -> Result<(), AppError> {
    if key.is_empty() {
        return Err(AppError::InvalidInput(
            "Sidecar key must not be empty".to_string(),
        ));
    }
    if key.len() > MAX_KEY_LEN {
        return Err(AppError::InvalidInput(format!(
            "Sidecar key exceeds {} bytes",
            MAX_KEY_LEN
        )));
    }
    if key == "." || key == ".." {
        return Err(AppError::PathNotAllowed(format!(
            "Sidecar key must not be '.' or '..': {}",
            key
        )));
    }
    if key.starts_with('.') {
        return Err(AppError::PathNotAllowed(
            "Sidecar key must not start with '.'".to_string(),
        ));
    }
    for ch in key.chars() {
        if ch == '/' || ch == '\\' || ch == '\0' {
            return Err(AppError::PathNotAllowed(format!(
                "Sidecar key contains disallowed character: {:?}",
                ch
            )));
        }
        if ch.is_control() {
            return Err(AppError::PathNotAllowed(
                "Sidecar key must not contain control characters".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_suffix(suffix: &str) -> Result<(), AppError> {
    if suffix.is_empty() {
        return Err(AppError::InvalidInput(
            "Sidecar suffix must not be empty".to_string(),
        ));
    }
    if suffix.len() > MAX_SUFFIX_LEN {
        return Err(AppError::InvalidInput(format!(
            "Sidecar suffix exceeds {} characters",
            MAX_SUFFIX_LEN
        )));
    }
    if !suffix.starts_with('.') {
        return Err(AppError::InvalidInput(
            "Sidecar suffix must start with '.'".to_string(),
        ));
    }
    if suffix.contains("..") {
        return Err(AppError::PathNotAllowed(
            "Sidecar suffix must not contain '..'".to_string(),
        ));
    }
    for ch in suffix.chars() {
        if ch == '/' || ch == '\\' || ch == '\0' {
            return Err(AppError::PathNotAllowed(format!(
                "Sidecar suffix contains disallowed character: {:?}",
                ch
            )));
        }
        if ch.is_whitespace() || ch.is_control() {
            return Err(AppError::PathNotAllowed(
                "Sidecar suffix must not contain whitespace or control characters".to_string(),
            ));
        }
        let safe = ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.';
        if !safe {
            return Err(AppError::PathNotAllowed(format!(
                "Sidecar suffix contains disallowed character: {:?}",
                ch
            )));
        }
    }
    Ok(())
}

fn validate_filename_component(name: &str, kind: &str) -> Result<(), AppError> {
    let path = Path::new(name);
    let mut count = 0;
    for component in path.components() {
        count += 1;
        if !matches!(component, Component::Normal(_)) {
            return Err(AppError::PathNotAllowed(format!(
                "{} produced non-normal path component: {}",
                kind, name
            )));
        }
    }
    if count != 1 {
        return Err(AppError::PathNotAllowed(format!(
            "{} produced multi-segment path: {}",
            kind, name
        )));
    }
    Ok(())
}

/// Deterministic conflict-copy path: `foo.json` + marker `m` ->
/// `foo.conflict-m.json`. `marker` must match `^[A-Za-z0-9-]{1,64}$` so no
/// caller can smuggle a parent-directory escape through it.
pub fn conflict_copy_path(original: &Path, marker: &str) -> Result<PathBuf, AppError> {
    validate_marker(marker)?;
    let parent = original.parent().unwrap_or_else(|| Path::new(""));
    let stem = original
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = original
        .extension()
        .map(|e| e.to_string_lossy().to_string());

    let new_name = match ext {
        Some(ext) if !ext.is_empty() => format!("{stem}.conflict-{marker}.{ext}"),
        _ => format!("{stem}.conflict-{marker}"),
    };
    Ok(parent.join(new_name))
}

fn validate_marker(marker: &str) -> Result<(), AppError> {
    if marker.is_empty() {
        return Err(AppError::InvalidInput(
            "Conflict marker must not be empty".to_string(),
        ));
    }
    if marker.len() > MAX_MARKER_LEN {
        return Err(AppError::InvalidInput(format!(
            "Conflict marker exceeds {} characters",
            MAX_MARKER_LEN
        )));
    }
    for ch in marker.chars() {
        let safe = ch.is_ascii_alphanumeric() || ch == '-';
        if !safe {
            return Err(AppError::PathNotAllowed(format!(
                "Conflict marker contains disallowed character: {:?}",
                ch
            )));
        }
    }
    Ok(())
}

/// Validate a channel id for use as a sidecar map key / filename fragment.
/// Non-empty, `<= 128` chars, ASCII alphanumeric plus `-` `_` `.`, not `.`
/// or `..`, no whitespace/control/path-separator/null-byte characters.
pub fn validate_channel_id(id: &str) -> Result<(), AppError> {
    if id.is_empty() {
        return Err(AppError::InvalidInput(
            "Channel id must not be empty".to_string(),
        ));
    }
    if id.len() > MAX_CHANNEL_ID_LEN {
        return Err(AppError::InvalidInput(format!(
            "Channel id exceeds {} characters",
            MAX_CHANNEL_ID_LEN
        )));
    }
    if id == "." || id == ".." {
        return Err(AppError::InvalidInput(
            "Channel id must not be '.' or '..'".to_string(),
        ));
    }
    for ch in id.chars() {
        if ch == '\0' || ch == '/' || ch == '\\' {
            return Err(AppError::InvalidInput(format!(
                "Channel id contains disallowed character: {:?}",
                ch
            )));
        }
        if ch.is_whitespace() || ch.is_control() {
            return Err(AppError::InvalidInput(
                "Channel id must not contain whitespace or control characters".to_string(),
            ));
        }
        let safe = ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.';
        if !safe {
            return Err(AppError::InvalidInput(format!(
                "Channel id contains disallowed character: {:?}",
                ch
            )));
        }
    }
    Ok(())
}

/// Atomically write JSON via a `create_new`-guarded sibling temp + rename.
///
/// Durability sequence per write: allocate a unique temp path via a
/// `create_new(true)` open (retries with a fresh counter on `AlreadyExists`
/// so a stale `*.novelist-tmp` is never overwritten), `write_all` the JSON,
/// `flush` then `sync_all` on the file, drop the handle, and `rename` onto
/// the target. If any step fails the temp file is removed so no artefact
/// leaks. Replacement of an existing target is atomic on both Unix and
/// Windows: modern `std::fs::rename` uses `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`
/// on Windows and POSIX `rename(2)` on Unix, both of which replace the
/// destination without an unlink-then-create window.
pub async fn atomic_write_json<T>(path: &Path, value: &T) -> Result<(), AppError>
where
    T: Serialize + ?Sized,
{
    let bytes = serde_json::to_vec_pretty(value)?;
    atomic_write_bytes(path, &bytes).await
}

/// Atomically write arbitrary bytes via a `create_new`-guarded sibling temp + rename.
pub async fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                AppError::Custom(format!("create_dir_all {}: {}", parent.display(), e))
            })?;
        }
    }

    let target = path.to_path_buf();
    let parent = target
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let file_name = target
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("Sidecar target has no file name".to_string()))?
        .to_string_lossy()
        .to_string();
    let bytes = bytes.to_vec();

    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        let pid = std::process::id();
        let (mut file, temp_path) = allocate_temp(&parent, &file_name, pid)?;

        let write_result = (|| -> Result<(), AppError> {
            file.write_all(&bytes).map_err(AppError::Io)?;
            file.flush().map_err(AppError::Io)?;
            file.sync_all().map_err(AppError::Io)?;
            Ok(())
        })();
        drop(file);

        if let Err(e) = write_result {
            let _ = std::fs::remove_file(&temp_path);
            return Err(e);
        }

        if let Err(e) = std::fs::rename(&temp_path, &target) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(AppError::Custom(format!(
                "rename {} -> {}: {}",
                temp_path.display(),
                target.display(),
                e
            )));
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Custom(format!("spawn_blocking join: {}", e)))??;

    Ok(())
}

fn allocate_temp(
    parent: &Path,
    file_name: &str,
    pid: u32,
) -> Result<(std::fs::File, PathBuf), AppError> {
    let mut last_err: Option<std::io::Error> = None;
    for _ in 0..MAX_TEMP_ATTEMPTS {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = format!(".{}.{}.{}{}", file_name, pid, counter, TEMP_SUFFIX);
        let candidate = parent.join(&name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((file, candidate)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                last_err = Some(e);
                continue;
            }
            Err(e) => {
                return Err(AppError::Custom(format!(
                    "open temp {}: {}",
                    candidate.display(),
                    e
                )));
            }
        }
    }
    Err(AppError::Custom(format!(
        "failed to allocate unique temp file for {} after {} attempts: {}",
        file_name,
        MAX_TEMP_ATTEMPTS,
        last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    )))
}

/// Read a JSON sidecar. Missing file -> `Ok(None)`. Malformed JSON returns a
/// typed error and the file is left in place for downstream recovery.
pub async fn read_json<T>(path: &Path) -> Result<Option<T>, AppError>
where
    T: DeserializeOwned,
{
    let bytes = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AppError::Io(e)),
    };
    let value = serde_json::from_slice::<T>(&bytes)?;
    Ok(Some(value))
}

/// Idempotent sidecar delete: a missing file is a no-op.
pub async fn delete_sidecar(path: &Path) -> Result<(), AppError> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::Io(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::path::PathBuf;
    use tempfile::TempDir;

    #[test]
    fn document_key_top_level_file() {
        let project = PathBuf::from("/proj");
        let file = PathBuf::from("/proj/chapter1.md");
        assert_eq!(document_key(&project, &file).unwrap(), "chapter1.md");
    }

    #[test]
    fn document_key_nested_uses_percent_encoded_slash() {
        let project = PathBuf::from("/proj");
        let file = PathBuf::from("/proj/chapters/ch1.md");
        assert_eq!(document_key(&project, &file).unwrap(), "chapters%2Fch1.md");
    }

    #[test]
    fn document_key_preserves_cjk_and_spaces() {
        let project = PathBuf::from("/tmp/小说 项目");
        let file = PathBuf::from("/tmp/小说 项目/章节/第一章.md");
        assert_eq!(document_key(&project, &file).unwrap(), "章节%2F第一章.md");
    }

    #[test]
    fn document_key_encodes_leading_dot_for_hidden_root_component() {
        let project = PathBuf::from("/proj");
        let file = PathBuf::from("/proj/.hidden.md");
        let key = document_key(&project, &file).unwrap();

        assert_eq!(key, "%2Ehidden.md");
        assert_eq!(
            sidecar_path(&project, "drafts", &key, ".draft.md").unwrap(),
            PathBuf::from("/proj/.novelist/drafts/%2Ehidden.md.draft.md")
        );
    }

    #[test]
    fn document_key_avoids_flat_vs_nested_collision() {
        let project = PathBuf::from("/proj");
        let nested = document_key(&project, &PathBuf::from("/proj/a/b.md")).unwrap();
        let flat = document_key(&project, &PathBuf::from("/proj/a__b.md")).unwrap();
        assert_ne!(
            nested, flat,
            "nested 'a/b.md' and flat 'a__b.md' must produce distinct keys"
        );
        assert_eq!(nested, "a%2Fb.md");
        assert_eq!(flat, "a__b.md");
    }

    #[test]
    fn document_key_escapes_literal_percent_before_join() {
        let project = PathBuf::from("/proj");
        let with_percent = document_key(&project, &PathBuf::from("/proj/a%2Fb.md")).unwrap();
        let nested = document_key(&project, &PathBuf::from("/proj/a/b.md")).unwrap();
        assert_ne!(
            with_percent, nested,
            "literal '%2F' in a filename must NOT collide with the nested join"
        );
        assert_eq!(with_percent, "a%252Fb.md");
        assert_eq!(nested, "a%2Fb.md");
    }

    #[test]
    fn document_key_relative_path_treated_as_project_relative() {
        let project = PathBuf::from("/proj");
        let file = PathBuf::from("chapters/ch1.md");
        assert_eq!(document_key(&project, &file).unwrap(), "chapters%2Fch1.md");
    }

    #[test]
    fn document_key_normalizes_windows_backslashes() {
        let project = PathBuf::from("/proj");
        let absolute = PathBuf::from("/proj\\chapters\\ch1.md");
        assert_eq!(
            document_key(&project, &absolute).unwrap(),
            "chapters%2Fch1.md"
        );
        let relative = PathBuf::from("chapters\\ch1.md");
        assert_eq!(
            document_key(&project, &relative).unwrap(),
            "chapters%2Fch1.md"
        );
    }

    #[test]
    fn document_key_rejects_parent_traversal() {
        let project = PathBuf::from("/proj");
        let err = document_key(&project, &PathBuf::from("../outside.md")).unwrap_err();
        assert!(matches!(err, AppError::PathNotAllowed(_)));
    }

    #[test]
    fn document_key_rejects_absolute_path_outside_project() {
        let project = PathBuf::from("/proj");
        let err = document_key(&project, &PathBuf::from("/other/scratch.md")).unwrap_err();
        assert!(matches!(err, AppError::PathNotAllowed(_)));
    }

    #[test]
    fn document_key_rejects_empty_path() {
        let project = PathBuf::from("/proj");
        let err = document_key(&project, &PathBuf::from("")).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn document_key_rejects_project_root_itself() {
        let project = PathBuf::from("/proj");
        let err = document_key(&project, &PathBuf::from("/proj")).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn document_key_rejects_null_byte() {
        let project = PathBuf::from("/proj");
        let err = document_key(&project, &PathBuf::from("chap\0ter.md")).unwrap_err();
        assert!(matches!(err, AppError::PathNotAllowed(_)));
    }

    #[test]
    fn document_key_encodes_windows_forbidden_chars() {
        let project = PathBuf::from("/proj");
        let key = document_key(&project, &PathBuf::from("/proj/a:b<c>d|e?f*g.md")).unwrap();
        assert!(!key.contains(':'));
        assert!(!key.contains('<'));
        assert!(!key.contains('>'));
        assert!(!key.contains('|'));
        assert!(!key.contains('?'));
        assert!(!key.contains('*'));
        assert!(key.contains("%3A"));
        assert!(key.contains("%3C"));
        assert!(key.contains("%3E"));
        assert!(key.contains("%7C"));
        assert!(key.contains("%3F"));
        assert!(key.contains("%2A"));
    }

    #[test]
    fn document_key_never_contains_slash_or_dotdot() {
        let project = PathBuf::from("/proj");
        let key = document_key(&project, &PathBuf::from("/proj/a/b/c.md")).unwrap();
        assert!(!key.contains('/'));
        assert!(!key.contains('\\'));
        assert!(!key.contains(".."));
    }

    #[test]
    fn document_key_short_input_stays_readable_and_unhashed() {
        let project = PathBuf::from("/proj");
        let key = document_key(&project, &PathBuf::from("/proj/chapters/ch1.md")).unwrap();
        assert_eq!(key, "chapters%2Fch1.md");
        assert!(!key.contains(KEY_HASH_SEP));
        assert!(key.len() <= MAX_KEY_LEN);
    }

    #[test]
    fn document_key_bounds_deep_ascii_path() {
        let project = PathBuf::from("/proj");
        let mut path_str = String::from("/proj");
        for i in 0..50u32 {
            path_str.push_str(&format!("/dir-segment-{:03}", i));
        }
        path_str.push_str("/chapter-final.md");
        let file = PathBuf::from(&path_str);

        let key = document_key(&project, &file).unwrap();
        assert!(
            key.len() <= MAX_KEY_LEN,
            "bounded key length {} exceeds MAX_KEY_LEN {}",
            key.len(),
            MAX_KEY_LEN
        );
        assert!(
            key.contains(KEY_HASH_SEP),
            "long path key must include the hash separator, got: {}",
            key
        );
    }

    #[test]
    fn document_key_bounds_long_cjk_filename() {
        let project = PathBuf::from("/proj");
        let long_name: String = "第".to_string().repeat(120);
        let file = PathBuf::from(format!("/proj/{long_name}.md"));

        let key = document_key(&project, &file).unwrap();
        assert!(
            key.len() <= MAX_KEY_LEN,
            "long CJK filename key length {} exceeds MAX_KEY_LEN {}",
            key.len(),
            MAX_KEY_LEN
        );
        assert!(key.contains(KEY_HASH_SEP));
    }

    #[test]
    fn document_key_bounded_keys_with_same_prefix_but_different_tail_are_distinct() {
        let project = PathBuf::from("/proj");
        let mut base = String::from("/proj");
        for i in 0..30u32 {
            base.push_str(&format!("/dir-segment-{:03}", i));
        }
        let file_x = PathBuf::from(format!("{base}/tail-x.md"));
        let file_y = PathBuf::from(format!("{base}/tail-y.md"));

        let key_x = document_key(&project, &file_x).unwrap();
        let key_y = document_key(&project, &file_y).unwrap();
        assert!(key_x.len() <= MAX_KEY_LEN);
        assert!(key_y.len() <= MAX_KEY_LEN);
        assert!(key_x.contains(KEY_HASH_SEP));
        assert!(key_y.contains(KEY_HASH_SEP));
        assert_ne!(
            key_x, key_y,
            "long paths sharing a prefix but with different tails must yield distinct keys"
        );
    }

    #[test]
    fn document_key_bounded_is_deterministic() {
        let project = PathBuf::from("/proj");
        let long_name: String = "第一章".to_string().repeat(80);
        let file = PathBuf::from(format!("/proj/{long_name}.md"));

        let a = document_key(&project, &file).unwrap();
        let b = document_key(&project, &file).unwrap();
        assert_eq!(a, b);
        assert!(a.contains(KEY_HASH_SEP));
    }

    #[test]
    fn document_key_bounded_never_ends_readable_portion_with_incomplete_percent_escape() {
        let project = PathBuf::from("/proj");
        let name: String = "<".to_string().repeat(80);
        let file = PathBuf::from(format!("/proj/{name}.md"));

        let key = document_key(&project, &file).unwrap();
        assert!(key.contains(KEY_HASH_SEP));
        let hash_pos = key.rfind(KEY_HASH_SEP).unwrap();
        let readable = &key[..hash_pos];
        assert!(
            !readable.ends_with('%'),
            "readable prefix ends with orphan '%' — would split a percent escape: {readable}"
        );
        if readable.len() >= 2 {
            let bytes = readable.as_bytes();
            let end = bytes.len();
            assert!(
                bytes[end - 2] != b'%',
                "readable prefix ends with incomplete '%X' escape: {readable}"
            );
        }
    }

    #[test]
    fn document_key_bounded_never_splits_utf8_codepoint() {
        let project = PathBuf::from("/proj");
        let long_name: String = "章".to_string().repeat(80);
        let file = PathBuf::from(format!("/proj/{long_name}"));

        let key = document_key(&project, &file).unwrap();
        assert!(key.contains(KEY_HASH_SEP));
        let hash_pos = key.rfind(KEY_HASH_SEP).unwrap();
        let readable = &key[..hash_pos];
        assert!(std::str::from_utf8(readable.as_bytes()).is_ok());
    }

    #[tokio::test]
    async fn sidecar_path_with_bounded_key_writes_and_stays_under_component_limit() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_path_buf();
        tokio::fs::create_dir_all(&project).await.unwrap();
        let long_name: String = "第".to_string().repeat(120);
        let file = project.join(format!("{long_name}.md"));

        let key = document_key(&project, &file).unwrap();
        assert!(key.len() <= MAX_KEY_LEN);

        let sidecar = sidecar_path(&project, "publish", &key, ".json").unwrap();
        let component_bytes = sidecar.file_name().unwrap().to_string_lossy().len();
        assert!(
            component_bytes <= 255,
            "final component byte length {} exceeds 255-byte cross-platform limit",
            component_bytes
        );

        atomic_write_json(&sidecar, &serde_json::json!({"k": "v"}))
            .await
            .unwrap();
        assert!(sidecar.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial_test::serial]
    async fn confined_read_rejects_final_component_swapped_to_symlink_before_open() {
        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let storage = open_confined_metadata_dir(project.path(), "drafts", true)
            .unwrap()
            .unwrap();
        atomic_write_bytes_confined(&storage, "chapter.md.draft.md", b"inside")
            .await
            .unwrap();
        let outside_file = outside.path().join("outside.md");
        std::fs::write(&outside_file, b"external sentinel").unwrap();
        set_confined_read_swap_target(outside_file.clone());

        let error = read_bytes_confined(&storage, "chapter.md.draft.md", 1024)
            .await
            .unwrap_err();

        assert!(
            matches!(error, AppError::PathNotAllowed(_)),
            "unexpected error: {error:?}"
        );
        assert_eq!(std::fs::read(outside_file).unwrap(), b"external sentinel");
    }

    #[tokio::test]
    async fn confined_bytes_read_accepts_exact_utf8_byte_cap() {
        let project = TempDir::new().unwrap();
        let storage = open_confined_metadata_dir(project.path(), "drafts", true)
            .unwrap()
            .unwrap();
        let content = "人物动机".as_bytes();
        atomic_write_bytes_confined(&storage, "第一章.md.draft.md", content)
            .await
            .unwrap();

        let bytes = read_bytes_confined(&storage, "第一章.md.draft.md", content.len())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(bytes, content);
    }

    #[tokio::test]
    async fn confined_bytes_read_rejects_cap_plus_one() {
        let project = TempDir::new().unwrap();
        let storage = open_confined_metadata_dir(project.path(), "drafts", true)
            .unwrap()
            .unwrap();
        atomic_write_bytes_confined(&storage, "chapter.md.draft.md", b"12345")
            .await
            .unwrap();

        let error = read_bytes_confined(&storage, "chapter.md.draft.md", 4)
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert!(error.to_string().contains("limit is 4"));
    }

    #[tokio::test]
    async fn confined_json_read_enforces_caller_byte_cap() {
        let project = TempDir::new().unwrap();
        let storage = open_confined_metadata_dir(project.path(), "publish", true)
            .unwrap()
            .unwrap();
        let json = r#"{"title":"第一章"}"#.as_bytes();
        atomic_write_bytes_confined(&storage, "chapter.md.json", json)
            .await
            .unwrap();

        let value: serde_json::Value = read_json_confined(&storage, "chapter.md.json", json.len())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(value["title"], "第一章");

        let error =
            read_json_confined::<serde_json::Value>(&storage, "chapter.md.json", json.len() - 1)
                .await
                .unwrap_err();
        assert!(matches!(error, AppError::InvalidInput(_)));
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial_test::serial]
    async fn confined_read_rejects_oversize_from_metadata_before_open() {
        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let storage = open_confined_metadata_dir(project.path(), "drafts", true)
            .unwrap()
            .unwrap();
        atomic_write_bytes_confined(&storage, "chapter.md.draft.md", b"12345")
            .await
            .unwrap();
        let outside_file = outside.path().join("outside.md");
        std::fs::write(&outside_file, b"external sentinel").unwrap();
        set_confined_read_swap_target(outside_file.clone());

        let error = read_bytes_confined(&storage, "chapter.md.draft.md", 4)
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        let pending_swap = CONFINED_READ_SWAP_TARGET
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .take();
        assert!(
            pending_swap.is_some(),
            "oversized metadata should be rejected before the open hook runs"
        );
        assert_eq!(std::fs::read(outside_file).unwrap(), b"external sentinel");
    }

    #[tokio::test]
    async fn confined_exists_uses_metadata_without_reading_file() {
        let project = TempDir::new().unwrap();
        let storage = open_confined_metadata_dir(project.path(), "drafts", true)
            .unwrap()
            .unwrap();
        let path = storage.absolute.join("chapter.md.draft.md");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(128 * 1024 * 1024)
            .unwrap();

        assert!(file_exists_confined(&storage, "chapter.md.draft.md")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn confined_json_write_rejects_payload_over_reader_cap() {
        let project = TempDir::new().unwrap();
        let storage = open_confined_metadata_dir(project.path(), "publish", true)
            .unwrap()
            .unwrap();
        let value = serde_json::json!({"title": "第一章"});

        let error = atomic_write_json_confined(&storage, "chapter.md.json", &value, 4)
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert!(!storage.absolute.join("chapter.md.json").exists());
    }

    #[test]
    fn sidecar_path_layout_matches_dot_novelist_convention() {
        let project = PathBuf::from("/proj");
        let p = sidecar_path(&project, "publish", "章节%2F第一章.md", ".json").unwrap();
        assert_eq!(
            p,
            PathBuf::from("/proj/.novelist/publish/章节%2F第一章.md.json")
        );
    }

    #[test]
    fn sidecar_path_rejects_empty_subdir() {
        let err = sidecar_path(&PathBuf::from("/proj"), "", "k", ".json").unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn sidecar_path_rejects_subdir_with_slash() {
        let err = sidecar_path(&PathBuf::from("/proj"), "a/b", "k", ".json").unwrap_err();
        assert!(matches!(err, AppError::PathNotAllowed(_)));
    }

    #[test]
    fn sidecar_path_rejects_subdir_with_backslash() {
        let err = sidecar_path(&PathBuf::from("/proj"), "a\\b", "k", ".json").unwrap_err();
        assert!(matches!(err, AppError::PathNotAllowed(_)));
    }

    #[test]
    fn sidecar_path_rejects_subdir_traversal() {
        assert!(matches!(
            sidecar_path(&PathBuf::from("/proj"), "..", "k", ".json").unwrap_err(),
            AppError::PathNotAllowed(_)
        ));
        assert!(matches!(
            sidecar_path(&PathBuf::from("/proj"), ".", "k", ".json").unwrap_err(),
            AppError::PathNotAllowed(_)
        ));
    }

    #[test]
    fn sidecar_path_rejects_subdir_absolute_prefix() {
        let err = sidecar_path(&PathBuf::from("/proj"), "/etc", "k", ".json").unwrap_err();
        assert!(matches!(err, AppError::PathNotAllowed(_)));
    }

    #[test]
    fn sidecar_path_rejects_empty_key() {
        let err = sidecar_path(&PathBuf::from("/proj"), "publish", "", ".json").unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn sidecar_path_rejects_key_with_slash() {
        assert!(matches!(
            sidecar_path(&PathBuf::from("/proj"), "publish", "a/b", ".json").unwrap_err(),
            AppError::PathNotAllowed(_)
        ));
        assert!(matches!(
            sidecar_path(&PathBuf::from("/proj"), "publish", "a\\b", ".json").unwrap_err(),
            AppError::PathNotAllowed(_)
        ));
    }

    #[test]
    fn sidecar_path_rejects_key_traversal_and_leading_dot() {
        assert!(matches!(
            sidecar_path(&PathBuf::from("/proj"), "publish", "..", ".json").unwrap_err(),
            AppError::PathNotAllowed(_)
        ));
        assert!(matches!(
            sidecar_path(&PathBuf::from("/proj"), "publish", ".", ".json").unwrap_err(),
            AppError::PathNotAllowed(_)
        ));
        assert!(matches!(
            sidecar_path(&PathBuf::from("/proj"), "publish", ".hidden", ".json").unwrap_err(),
            AppError::PathNotAllowed(_)
        ));
    }

    #[test]
    fn sidecar_path_rejects_empty_or_unsafe_suffix() {
        assert!(matches!(
            sidecar_path(&PathBuf::from("/proj"), "publish", "k", "").unwrap_err(),
            AppError::InvalidInput(_)
        ));
        assert!(matches!(
            sidecar_path(&PathBuf::from("/proj"), "publish", "k", "json").unwrap_err(),
            AppError::InvalidInput(_)
        ));
        assert!(matches!(
            sidecar_path(&PathBuf::from("/proj"), "publish", "k", "./..").unwrap_err(),
            AppError::PathNotAllowed(_)
        ));
        assert!(matches!(
            sidecar_path(&PathBuf::from("/proj"), "publish", "k", "./x").unwrap_err(),
            AppError::PathNotAllowed(_)
        ));
        assert!(matches!(
            sidecar_path(&PathBuf::from("/proj"), "publish", "k", ".ja\\son").unwrap_err(),
            AppError::PathNotAllowed(_)
        ));
    }

    #[test]
    fn sidecar_path_cannot_escape_dot_novelist() {
        let project = PathBuf::from("/proj");
        let expected_prefix = project.join(".novelist");
        let ok = sidecar_path(&project, "publish", "safe_key.md", ".json").unwrap();
        assert!(
            ok.starts_with(&expected_prefix),
            "{:?} must live under {:?}",
            ok,
            expected_prefix
        );
    }

    #[test]
    fn conflict_copy_path_preserves_extension_and_is_deterministic() {
        let original = PathBuf::from("/proj/.novelist/publish/ch1.md.json");
        let a = conflict_copy_path(&original, "20260716T045100Z").unwrap();
        let b = conflict_copy_path(&original, "20260716T045100Z").unwrap();
        assert_eq!(a, b);
        assert_eq!(
            a,
            PathBuf::from("/proj/.novelist/publish/ch1.md.conflict-20260716T045100Z.json")
        );
    }

    #[test]
    fn conflict_copy_path_handles_extensionless_file() {
        let original = PathBuf::from("/proj/.novelist/publish/README");
        assert_eq!(
            conflict_copy_path(&original, "marker").unwrap(),
            PathBuf::from("/proj/.novelist/publish/README.conflict-marker")
        );
    }

    #[test]
    fn conflict_copy_path_rejects_marker_with_slash() {
        let original = PathBuf::from("/proj/.novelist/publish/ch1.json");
        assert!(matches!(
            conflict_copy_path(&original, "a/b").unwrap_err(),
            AppError::PathNotAllowed(_)
        ));
        assert!(matches!(
            conflict_copy_path(&original, "a\\b").unwrap_err(),
            AppError::PathNotAllowed(_)
        ));
    }

    #[test]
    fn conflict_copy_path_rejects_marker_traversal() {
        let original = PathBuf::from("/proj/.novelist/publish/ch1.json");
        assert!(matches!(
            conflict_copy_path(&original, "..").unwrap_err(),
            AppError::PathNotAllowed(_)
        ));
    }

    #[test]
    fn conflict_copy_path_rejects_marker_control_or_whitespace() {
        let original = PathBuf::from("/proj/.novelist/publish/ch1.json");
        assert!(conflict_copy_path(&original, "a b").is_err());
        assert!(conflict_copy_path(&original, "a\tb").is_err());
        assert!(conflict_copy_path(&original, "a\nb").is_err());
        assert!(conflict_copy_path(&original, "a\0b").is_err());
    }

    #[test]
    fn conflict_copy_path_rejects_empty_or_too_long_marker() {
        let original = PathBuf::from("/proj/.novelist/publish/ch1.json");
        assert!(matches!(
            conflict_copy_path(&original, "").unwrap_err(),
            AppError::InvalidInput(_)
        ));
        let long = "a".repeat(MAX_MARKER_LEN + 1);
        assert!(matches!(
            conflict_copy_path(&original, &long).unwrap_err(),
            AppError::InvalidInput(_)
        ));
    }

    #[test]
    fn conflict_copy_path_never_escapes_original_parent() {
        let original = PathBuf::from("/proj/.novelist/publish/ch1.md.json");
        let expected_parent = original.parent().unwrap().to_path_buf();
        let out = conflict_copy_path(&original, "20260716T045100Z").unwrap();
        assert_eq!(out.parent().unwrap(), expected_parent);
    }

    #[test]
    fn validate_channel_id_accepts_uuid_and_slug() {
        validate_channel_id("a1b2c3d4-e5f6-7890-abcd-ef1234567890").unwrap();
        validate_channel_id("ghost-personal_1").unwrap();
    }

    #[test]
    fn validate_channel_id_rejects_empty() {
        let err = validate_channel_id("").unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn validate_channel_id_rejects_path_separators() {
        assert!(validate_channel_id("a/b").is_err());
        assert!(validate_channel_id("a\\b").is_err());
    }

    #[test]
    fn validate_channel_id_rejects_traversal() {
        assert!(validate_channel_id(".").is_err());
        assert!(validate_channel_id("..").is_err());
    }

    #[test]
    fn validate_channel_id_rejects_null_byte() {
        assert!(validate_channel_id("a\0b").is_err());
    }

    #[test]
    fn validate_channel_id_rejects_whitespace_and_control() {
        assert!(validate_channel_id(" leading").is_err());
        assert!(validate_channel_id("trailing ").is_err());
        assert!(validate_channel_id("has space").is_err());
        assert!(validate_channel_id("has\tab").is_err());
        assert!(validate_channel_id("has\nnewline").is_err());
    }

    #[test]
    fn validate_channel_id_rejects_too_long() {
        let long = "a".repeat(MAX_CHANNEL_ID_LEN + 1);
        assert!(validate_channel_id(&long).is_err());
    }

    #[test]
    fn validate_channel_id_rejects_non_ascii() {
        assert!(validate_channel_id("频道1").is_err());
    }

    #[derive(Debug, Deserialize, Serialize, PartialEq)]
    struct Fixture {
        title: String,
        count: u32,
    }

    fn dot_novelist_publish(root: &Path) -> PathBuf {
        root.join(".novelist").join("publish").join("entry.json")
    }

    #[tokio::test]
    async fn atomic_write_bytes_replaces_target_and_leaves_no_temp_artifact() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join(".novelist").join("raw").join("a.bin");

        atomic_write_bytes(&target, b"first").await.unwrap();
        atomic_write_bytes(&target, b"second").await.unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"second");
        let parent = target.parent().unwrap();
        let temps: Vec<_> = std::fs::read_dir(parent)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .filter(|name| name.contains("novelist-tmp"))
            .collect();
        assert!(temps.is_empty(), "unexpected temp files: {temps:?}");
    }

    #[tokio::test]
    async fn atomic_write_json_round_trip() {
        let dir = TempDir::new().unwrap();
        let path = dot_novelist_publish(dir.path());
        let value = Fixture {
            title: "第一章".into(),
            count: 3,
        };
        atomic_write_json(&path, &value).await.unwrap();
        let back: Option<Fixture> = read_json(&path).await.unwrap();
        assert_eq!(back, Some(value));
    }

    #[tokio::test]
    async fn atomic_write_json_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(".novelist/deep/nested/entry.json");
        atomic_write_json(&path, &serde_json::json!({"k": "v"}))
            .await
            .unwrap();
        assert!(path.exists());
    }

    #[tokio::test]
    async fn atomic_write_json_leaves_no_temp_artifact_on_success() {
        let dir = TempDir::new().unwrap();
        let path = dot_novelist_publish(dir.path());
        atomic_write_json(&path, &serde_json::json!({"k": 1}))
            .await
            .unwrap();
        let parent = path.parent().unwrap();
        let mut entries = tokio::fs::read_dir(parent).await.unwrap();
        while let Some(e) = entries.next_entry().await.unwrap() {
            let name = e.file_name().to_string_lossy().to_string();
            assert!(
                !name.ends_with(TEMP_SUFFIX),
                "unexpected temp artifact: {name}"
            );
        }
    }

    #[tokio::test]
    async fn atomic_write_json_cleans_temp_when_rename_target_is_a_directory() {
        let dir = TempDir::new().unwrap();
        let target = dot_novelist_publish(dir.path());
        tokio::fs::create_dir_all(&target).await.unwrap();
        let err = atomic_write_json(&target, &serde_json::json!({"k": 1}))
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("rename"), "expected rename error, got: {msg}");
        let parent = target.parent().unwrap();
        let mut entries = tokio::fs::read_dir(parent).await.unwrap();
        while let Some(e) = entries.next_entry().await.unwrap() {
            let name = e.file_name().to_string_lossy().to_string();
            assert!(
                !name.ends_with(TEMP_SUFFIX),
                "temp artifact leaked after rename failure: {name}"
            );
        }
    }

    #[tokio::test]
    async fn atomic_write_json_never_overwrites_pre_existing_temp_candidate() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("entry.json");
        let pid = std::process::id();
        let mut squatters = Vec::new();
        let start = TEMP_COUNTER.load(Ordering::Relaxed);
        for offset in 0..3u64 {
            let name = format!(
                ".{}.{}.{}{}",
                "entry.json",
                pid,
                start + offset,
                TEMP_SUFFIX
            );
            let candidate = dir.path().join(&name);
            tokio::fs::write(&candidate, format!("stale-{offset}"))
                .await
                .unwrap();
            squatters.push(candidate);
        }

        atomic_write_json(&path, &serde_json::json!({"v": "fresh"}))
            .await
            .unwrap();

        assert!(path.exists());
        for (offset, squatter) in squatters.iter().enumerate() {
            assert!(squatter.exists(), "squatter {offset} was overwritten");
            let content = tokio::fs::read_to_string(squatter).await.unwrap();
            assert_eq!(content, format!("stale-{offset}"));
        }
    }

    #[tokio::test]
    async fn atomic_write_json_replaces_existing_target_atomically() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("entry.json");
        atomic_write_json(&path, &serde_json::json!({"v": 1}))
            .await
            .unwrap();
        let first_read = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(first_read.contains("\"v\": 1"));

        atomic_write_json(&path, &serde_json::json!({"v": 2}))
            .await
            .unwrap();
        let second_read = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(second_read.contains("\"v\": 2"));

        let mut count = 0usize;
        let mut entries = tokio::fs::read_dir(dir.path()).await.unwrap();
        while let Some(e) = entries.next_entry().await.unwrap() {
            count += 1;
            assert!(!e.file_name().to_string_lossy().ends_with(TEMP_SUFFIX));
        }
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn atomic_write_json_uses_sync_all_before_rename() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("entry.json");
        atomic_write_json(&path, &serde_json::json!({"k": "durable"}))
            .await
            .unwrap();
        let raw = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(raw.contains("\"k\": \"durable\""));
    }

    #[tokio::test]
    async fn read_json_missing_file_returns_none() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nope.json");
        let back: Option<Fixture> = read_json(&path).await.unwrap();
        assert!(back.is_none());
    }

    #[tokio::test]
    async fn read_json_malformed_returns_error_and_retains_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("corrupt.json");
        tokio::fs::write(&path, b"{not valid json").await.unwrap();

        let err = read_json::<Fixture>(&path).await.unwrap_err();
        assert!(
            matches!(err, AppError::Json(_)),
            "expected Json error, got {err:?}"
        );
        assert!(path.exists(), "corrupt sidecar must not be deleted");
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"{not valid json");
    }

    #[tokio::test]
    async fn delete_sidecar_is_idempotent() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nope.json");
        delete_sidecar(&path).await.unwrap();

        tokio::fs::write(&path, b"{}").await.unwrap();
        delete_sidecar(&path).await.unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn windows_legacy_component_budget_counts_utf16_units_not_utf8_bytes() {
        let file_name = format!("{}.draft.md", "第".repeat(100));
        assert!(file_name.len() > 255);
        assert!(windows_component_len(&file_name) <= 255);

        #[cfg(windows)]
        assert!(legacy_sidecar_path(
            Path::new(r"C:\project"),
            "drafts",
            &"第".repeat(100),
            ".draft.md"
        )
        .unwrap()
        .is_some());
    }

    #[tokio::test]
    async fn cjk_round_trip_from_plan_scenario() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().join("小说 项目");
        tokio::fs::create_dir_all(&project).await.unwrap();
        let file_path = project.join("章节").join("第一章.md");

        let key = document_key(&project, &file_path).unwrap();
        assert_eq!(key, "章节%2F第一章.md");

        let sidecar = sidecar_path(&project, "publish", &key, ".json").unwrap();
        let payload = Fixture {
            title: "第一章".into(),
            count: 1,
        };

        atomic_write_json(&sidecar, &payload).await.unwrap();
        let read_back: Fixture = read_json(&sidecar).await.unwrap().unwrap();
        assert_eq!(read_back, payload);

        let updated = Fixture {
            title: "第一章".into(),
            count: 2,
        };
        atomic_write_json(&sidecar, &updated).await.unwrap();
        let read_updated: Fixture = read_json(&sidecar).await.unwrap().unwrap();
        assert_eq!(read_updated, updated);

        let mut count = 0usize;
        let mut entries = tokio::fs::read_dir(sidecar.parent().unwrap())
            .await
            .unwrap();
        while let Some(e) = entries.next_entry().await.unwrap() {
            let name = e.file_name().to_string_lossy().to_string();
            assert!(!name.ends_with(TEMP_SUFFIX));
            count += 1;
        }
        assert_eq!(count, 1);
    }
}
