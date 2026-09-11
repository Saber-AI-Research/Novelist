use crate::commands::settings::{acquire_project_settings_guard, get_resolved_snapshot_config};
use crate::error::AppError;
use crate::services::project_files::is_project_content_path;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, File, OpenOptions};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use tokio::sync::{Mutex, OwnedMutexGuard};

static SNAPSHOT_LOCKS: LazyLock<StdMutex<HashMap<PathBuf, Arc<Mutex<()>>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));
static UNIQUE_COUNTER: AtomicU64 = AtomicU64::new(0);

async fn acquire_snapshot_guard(
    project_dir: &Path,
) -> Result<(PathBuf, OwnedMutexGuard<()>), AppError> {
    let canonical = snapshot_project_identity(project_dir)?;
    let mutex = SNAPSHOT_LOCKS
        .lock()
        .expect("snapshot lock registry poisoned")
        .entry(canonical.clone())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone();
    Ok((canonical, mutex.lock_owned().await))
}

fn snapshot_project_identity(project_dir: &Path) -> Result<PathBuf, AppError> {
    match std::fs::canonicalize(project_dir) {
        Ok(canonical) => {
            if !std::fs::metadata(&canonical)?.is_dir() {
                return Err(AppError::NotADirectory(canonical.display().to_string()));
            }
            return Ok(canonical);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let absolute = if project_dir.is_absolute() {
        project_dir.to_owned()
    } else {
        std::env::current_dir()?.join(project_dir)
    };
    let mut canonical = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => canonical.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                canonical.pop();
            }
            Component::Normal(name) => {
                canonical.push(name);
                match std::fs::symlink_metadata(&canonical) {
                    Ok(_) => {
                        // A dangling link errors here rather than becoming a
                        // missing directory; existing aliases share one key.
                        canonical = std::fs::canonicalize(&canonical)?;
                        if !std::fs::metadata(&canonical)?.is_dir() {
                            return Err(AppError::NotADirectory(canonical.display().to_string()));
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
    }
    Ok(canonical)
}

fn open_project_root(canonical: &Path, create: bool) -> Result<Dir, AppError> {
    let mut anchor = PathBuf::new();
    let mut components = canonical.components().peekable();
    while let Some(Component::Prefix(_) | Component::RootDir) = components.peek() {
        anchor.push(components.next().unwrap().as_os_str());
    }
    if anchor.as_os_str().is_empty() {
        return Err(AppError::PathNotAllowed(canonical.display().to_string()));
    }
    let mut dir = Dir::open_ambient_dir(anchor, ambient_authority())?;
    for component in components {
        let Component::Normal(name) = component else {
            return Err(AppError::PathNotAllowed(canonical.display().to_string()));
        };
        dir = open_child_dir(&dir, name, create)?;
    }
    Ok(dir)
}

#[cfg(feature = "sync")]
use crate::services::snapshot_webdav::{try_delete_snapshot_remote, try_upload_snapshot};

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct SnapshotMeta {
    pub id: String,
    pub name: String,
    pub timestamp: u64,
    pub file_count: usize,
    pub total_bytes: u64,
}

/// Returns `<novelist_home>/snapshots/{blake3_hash_of_project_dir}/`,
/// where `novelist_home` is `~/.novelist/` in standard mode or
/// `<exe_dir>/data/` in portable mode.
pub fn snapshots_dir(project_dir: &str) -> PathBuf {
    let hash = blake3::hash(project_dir.as_bytes()).to_hex();
    data_root().join("snapshots").join(hash.to_string())
}

fn data_root() -> PathBuf {
    // `NOVELIST_SNAPSHOTS_DATA_DIR` is a test seam (used by unit tests that need
    // per-test isolation and can't rely on `portable::init()` having run).
    // Production code goes through `portable::novelist_home`.
    #[cfg(test)]
    {
        if let Ok(p) = std::env::var("NOVELIST_SNAPSHOTS_DATA_DIR") {
            if !p.is_empty() {
                return PathBuf::from(p);
            }
        }
    }
    crate::services::portable::novelist_home().to_path_buf()
}

fn validate_snapshot_id(id: &str) -> Result<(), AppError> {
    let valid = id.strip_prefix("snap-").is_some_and(|suffix| {
        let mut parts = suffix.split('-');
        let digits = |part: &str| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit());
        parts.next().is_some_and(digits)
            && parts.next().map(digits).unwrap_or(true)
            && parts.next().is_none()
    });
    if !valid {
        return Err(AppError::InvalidInput(format!("Invalid snapshot ID: {id}")));
    }
    Ok(())
}

// A time-seeded monotonic suffix avoids reusing a retired ID after a restart.
// Exclusive directory creation still arbitrates a collision on disk.
fn unique_number() -> Result<u64, AppError> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| AppError::Custom(error.to_string()))?
        .as_nanos();
    let clock = u64::try_from(nanos).map_err(|error| AppError::Custom(error.to_string()))?;
    let previous = UNIQUE_COUNTER
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |previous| {
            previous.checked_add(1).map(|next| next.max(clock))
        })
        .map_err(|_| AppError::Custom("Snapshot ID counter exhausted".into()))?;
    Ok((previous + 1).max(clock))
}

fn open_child_dir(parent: &Dir, name: &OsStr, create: bool) -> Result<Dir, AppError> {
    match parent.symlink_metadata(name) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(AppError::PathNotAllowed(format!(
                "Snapshot directory must be a regular directory: {}",
                name.to_string_lossy()
            )));
        }
        Ok(_) => {}
        Err(error) if create && error.kind() == std::io::ErrorKind::NotFound => {
            match parent.create_dir(name) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) => return Err(error.into()),
    }
    // Single-component opens are essential: no intermediate symlink may resolve.
    parent.open_dir_nofollow(name).map_err(AppError::Io)
}

fn open_base(project_dir: &str, create: bool) -> Result<Option<Dir>, AppError> {
    let root_path = data_root();
    if create {
        std::fs::create_dir_all(&root_path)?;
    }
    let result = (|| {
        let root = Dir::open_ambient_dir(&root_path, ambient_authority())?;
        let snapshots = open_child_dir(&root, OsStr::new("snapshots"), create)?;
        let base_path = snapshots_dir(project_dir);
        let namespace = base_path
            .file_name()
            .expect("snapshot path has a namespace");
        open_child_dir(&snapshots, namespace, create)
    })();
    match result {
        Ok(dir) => Ok(Some(dir)),
        Err(AppError::Io(error)) if !create && error.kind() == std::io::ErrorKind::NotFound => {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

fn open_parent(root: &Dir, relative: &Path, create: bool) -> Result<(Dir, OsString), AppError> {
    let mut dir = root.try_clone()?;
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(name) = component else {
            return Err(AppError::PathNotAllowed(relative.display().to_string()));
        };
        if components.peek().is_none() {
            return Ok((dir, name.to_owned()));
        }
        dir = open_child_dir(&dir, name, create)?;
    }
    Err(AppError::InvalidInput("Empty snapshot path".into()))
}

fn check_regular_file(dir: &Dir, name: &OsStr, allow_missing: bool) -> Result<(), AppError> {
    match dir.symlink_metadata(name) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(AppError::PathNotAllowed(format!(
                "Snapshot file must be a regular file: {}",
                name.to_string_lossy()
            )))
        }
        Ok(_) => Ok(()),
        Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn open_source(dir: &Dir, name: &OsStr) -> Result<File, AppError> {
    check_regular_file(dir, name, false)?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = dir.open_with(name, &options)?;
    if !file.metadata()?.is_file() {
        return Err(AppError::PathNotAllowed(
            name.to_string_lossy().into_owned(),
        ));
    }
    Ok(file)
}

fn collect_content(dir: &Dir, relative: &Path, paths: &mut Vec<PathBuf>) -> Result<(), AppError> {
    for entry in dir.entries()? {
        let entry = entry?;
        let name = entry.file_name();
        let path = relative.join(&name);
        if name.to_string_lossy().starts_with('.') {
            if relative.as_os_str().is_empty() && name == ".novelist" {
                let metadata_dir = open_child_dir(dir, &name, false)?;
                // Never enumerate credentials, caches, or other hidden metadata.
                for name in ["project.toml", "literary-study.json"] {
                    match metadata_dir.symlink_metadata(name) {
                        Ok(_) => {
                            check_regular_file(&metadata_dir, OsStr::new(name), false)?;
                            let path = path.join(name);
                            if is_project_content_path(&path) {
                                paths.push(path);
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.into()),
                    }
                }
            }
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(AppError::PathNotAllowed(format!(
                "Snapshot source is a symlink: {}",
                path.display()
            )));
        }
        if kind.is_dir() {
            collect_content(&open_child_dir(dir, &name, false)?, &path, paths)?;
        } else if is_project_content_path(&path) {
            check_regular_file(dir, &name, false)?;
            paths.push(path);
        }
    }
    Ok(())
}

fn content_paths(dir: &Dir) -> Result<Vec<PathBuf>, AppError> {
    let mut paths = Vec::new();
    collect_content(dir, Path::new(""), &mut paths)?;
    paths.sort();
    Ok(paths)
}

fn copy_project_files(source: &Dir, destination: &Dir) -> Result<(usize, u64), AppError> {
    let paths = content_paths(source)?;
    let mut total_bytes = 0;
    for relative in &paths {
        let (parent, name) = open_parent(source, relative, false)?;
        let mut input = open_source(&parent, &name)?;
        let (parent, name) = open_parent(destination, relative, true)?;
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut output = parent.open_with(&name, &options)?;
        total_bytes += std::io::copy(&mut input, &mut output)?;
        output.flush()?;
        output.sync_all()?;
    }
    Ok((paths.len(), total_bytes))
}

/// Wall-clock seam. Production reads the system clock; tests override it via
/// `set_test_clock` so retention windows can be exercised deterministically.
#[cfg(not(test))]
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod test_clock {
    use std::cell::Cell;
    thread_local! {
        static OVERRIDE: Cell<Option<u64>> = const { Cell::new(None) };
    }
    pub fn now_secs() -> u64 {
        OVERRIDE.with(|c| {
            c.get().unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
            })
        })
    }
    pub fn set(ts: u64) {
        OVERRIDE.with(|c| c.set(Some(ts)));
    }
    pub fn clear() {
        OVERRIDE.with(|c| c.set(None));
    }
}

#[cfg(test)]
pub use test_clock::now_secs;
#[cfg(test)]
pub use test_clock::{clear as clear_test_clock, set as set_test_clock};

fn delete_local(base: &Dir, id: &str) -> Result<(), AppError> {
    match base.symlink_metadata(id) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => Err(
            AppError::PathNotAllowed(format!("Snapshot is not a regular directory: {id}")),
        ),
        Ok(_) => base.remove_dir_all(id).map_err(AppError::Io),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

// Only called while holding the project snapshot guard. Active stages therefore
// cannot be mistaken for crash debris, including after caller cancellation.
fn cleanup_pending_dirs(base: &Dir) -> Result<(), AppError> {
    for entry in base.entries()? {
        let entry = entry?;
        let name = entry.file_name();
        if let Some(name) = name.to_str() {
            if name
                .strip_suffix(".pending")
                .is_some_and(|id| validate_snapshot_id(id).is_ok())
            {
                delete_local(base, name)?;
            }
        }
    }
    Ok(())
}

fn list_snapshots_locked(base: &Dir) -> Result<Vec<SnapshotMeta>, AppError> {
    let mut snapshots = Vec::new();
    for entry in base.entries()? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(id) = name.to_str() else { continue };
        if validate_snapshot_id(id).is_err() {
            continue;
        }
        let snapshot = open_child_dir(base, &name, false)?;
        let meta: SnapshotMeta =
            serde_json::from_reader(open_source(&snapshot, OsStr::new("metadata.json"))?)?;
        if meta.id != id {
            return Err(AppError::InvalidInput(format!(
                "Snapshot metadata ID does not match directory: {id}"
            )));
        }
        snapshots.push(meta);
    }
    snapshots.sort_by(|a, b| b.timestamp.cmp(&a.timestamp).then_with(|| b.id.cmp(&a.id)));
    Ok(snapshots)
}

fn allocate_pending(base: &Dir, now: u64) -> Result<(String, String, Dir), AppError> {
    for _ in 0..32 {
        let id = format!("snap-{now}-{:020}", unique_number()?);
        match base.symlink_metadata(&id) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let pending_name = format!("{id}.pending");
        match base.create_dir(&pending_name) {
            Ok(()) => {
                let pending = open_child_dir(base, OsStr::new(&pending_name), false)?;
                return Ok((id, pending_name, pending));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(AppError::Custom(
        "Failed to allocate a unique snapshot directory".into(),
    ))
}

fn create_snapshot_locked(
    project_dir: &str,
    canonical: &Path,
    name: String,
    now: u64,
    max_count: usize,
    min_interval_secs: u64,
) -> Result<(SnapshotMeta, Vec<String>), AppError> {
    let base = open_base(project_dir, true)?
        .ok_or_else(|| AppError::Custom("Missing snapshot directory".into()))?;
    cleanup_pending_dirs(&base)?;
    let existing = list_snapshots_locked(&base)?;
    let victim = existing.first().filter(|newest| {
        min_interval_secs > 0 && now.saturating_sub(newest.timestamp) < min_interval_secs
    });
    let (id, pending_name, pending) = allocate_pending(&base, now)?;
    let result = (|| {
        let source = open_project_root(canonical, false)?;
        let files = open_child_dir(&pending, OsStr::new("files"), true)?;
        let (file_count, total_bytes) = copy_project_files(&source, &files)?;
        let meta = SnapshotMeta {
            id: id.clone(),
            name,
            timestamp: now,
            file_count,
            total_bytes,
        };
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut output = pending.open_with("metadata.json", &options)?;
        serde_json::to_writer_pretty(&mut output, &meta)?;
        output.flush()?;
        output.sync_all()?;
        drop(output);
        // The immutable snapshot becomes visible only when all bytes are ready.
        base.rename(&pending_name, &base, &id)?;
        Ok::<_, AppError>(meta)
    })();
    let meta = match result {
        Ok(meta) => meta,
        Err(error) => {
            if let Err(cleanup_error) = delete_local(&base, &pending_name) {
                tracing::warn!("snapshot stage cleanup failed: {cleanup_error}");
            }
            return Err(error);
        }
    };

    // No existing snapshot is retired until the replacement is complete.
    let retired: Vec<String> = if let Some(victim) = victim {
        vec![victim.id.clone()]
    } else {
        existing
            .iter()
            .rev()
            .take((existing.len() + 1).saturating_sub(max_count))
            .map(|old| old.id.clone())
            .collect()
    };
    for id in &retired {
        delete_local(&base, id)?;
    }
    Ok((meta, retired))
}

/// Serialize creation, crash cleanup, retention and mirroring for this project.
/// The detached worker retains its guard if the command's caller is cancelled.
pub async fn create_snapshot(project_dir: &str, name: &str) -> Result<SnapshotMeta, AppError> {
    let (canonical, guard) = acquire_snapshot_guard(Path::new(project_dir)).await?;
    let now = now_secs();
    let project_dir = project_dir.to_owned();
    let name = name.to_owned();
    tokio::spawn(async move {
        let settings_guard = acquire_project_settings_guard(&canonical).await?;
        let _guard = guard;
        let cfg = get_resolved_snapshot_config(&project_dir).await;
        let local_project = project_dir.clone();
        let (meta, retired) = tokio::task::spawn_blocking(move || {
            let _settings_guard = settings_guard;
            create_snapshot_locked(
                &local_project,
                &canonical,
                name,
                now,
                cfg.max_count as usize,
                u64::from(cfg.min_interval_minutes) * 60,
            )
        })
        .await
        .map_err(|error| AppError::Custom(format!("snapshot worker: {error}")))??;
        // The snapshot stays immutable and present throughout the complete upload.
        // Remote deletion follows publication, before another create can retire it.
        #[cfg(feature = "sync")]
        {
            try_upload_snapshot(&project_dir, &meta).await;
            for id in &retired {
                try_delete_snapshot_remote(&project_dir, id).await;
            }
        }
        #[cfg(not(feature = "sync"))]
        let _ = retired;
        Ok(meta)
    })
    .await
    .map_err(|error| AppError::Custom(format!("snapshot worker: {error}")))?
}

/// List uses the same guard; creation calls the non-reentrant internal helper.
pub async fn list_snapshots(project_dir: &str) -> Result<Vec<SnapshotMeta>, AppError> {
    let (_, guard) = acquire_snapshot_guard(Path::new(project_dir)).await?;
    let project_dir = project_dir.to_owned();
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        match open_base(&project_dir, false)? {
            Some(base) => list_snapshots_locked(&base),
            None => Ok(Vec::new()),
        }
    })
    .await
    .map_err(|error| AppError::Custom(format!("snapshot worker: {error}")))?
}

struct StagedRestore {
    parent: Arc<Dir>,
    target: OsString,
    temporary: String,
}

impl Drop for StagedRestore {
    fn drop(&mut self) {
        let _ = self.parent.remove_file(&self.temporary);
    }
}

fn stage_restore_file(
    parent: Arc<Dir>,
    target: OsString,
    source: &mut impl std::io::Read,
) -> Result<StagedRestore, AppError> {
    check_regular_file(&parent, &target, true)?;
    for _ in 0..32 {
        let temporary = format!(".novelist-restore-{}.tmp", unique_number()?);
        let mut options = OpenOptions::new();
        options
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        let mut output = match parent.open_with(&temporary, &options) {
            Ok(output) => output,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        };
        let staged = StagedRestore {
            parent,
            target,
            temporary,
        };
        let result = (|| {
            std::io::copy(source, &mut output)?;
            output.flush()?;
            output.sync_all()
        })();
        drop(output);
        result?;
        return Ok(staged);
    }
    Err(AppError::Custom(
        "Failed to allocate restore temporary file".into(),
    ))
}

fn restore_snapshot_locked(
    project_dir: &str,
    project: &Dir,
    snapshot_id: &str,
) -> Result<(), AppError> {
    let base =
        open_base(project_dir, false)?.ok_or_else(|| AppError::FileNotFound(snapshot_id.into()))?;
    let snapshot = open_child_dir(&base, OsStr::new(snapshot_id), false)?;
    let files = open_child_dir(&snapshot, OsStr::new("files"), false)?;
    let paths = content_paths(&files)?;
    let mut staged = Vec::with_capacity(paths.len());
    // Pin one capability per destination directory, not one descriptor per file.
    let mut parents: HashMap<PathBuf, Arc<Dir>> = HashMap::new();
    // Complete every read and temporary write before touching an original file.
    for relative in paths {
        let (parent, name) = open_parent(&files, &relative, false)?;
        let mut source = open_source(&parent, &name)?;
        let parent_path = relative
            .parent()
            .ok_or_else(|| AppError::PathNotAllowed(relative.display().to_string()))?;
        let parent = if let Some(parent) = parents.get(parent_path) {
            Arc::clone(parent)
        } else {
            let (parent, _) = open_parent(project, &relative, true)?;
            let parent = Arc::new(parent);
            parents.insert(parent_path.to_owned(), Arc::clone(&parent));
            parent
        };
        staged.push(stage_restore_file(parent, name, &mut source)?);
    }
    for file in &staged {
        check_regular_file(&file.parent, &file.target, true)?;
    }
    for file in &staged {
        // Rename never dereferences the final component, even if swapped after
        // checking it. Both names resolve through the pinned parent capability.
        check_regular_file(&file.parent, &file.target, true)?;
        file.parent
            .rename(&file.temporary, &file.parent, &file.target)?;
    }
    Ok(())
}

/// Lock order is snapshot, then project settings; keep both inside the blocking
/// worker so cancellation cannot let project.toml updates interleave with restore.
/// Each file replacement is atomic; a later commit error is reported, not hidden.
pub async fn restore_snapshot(project_dir: &str, snapshot_id: &str) -> Result<(), AppError> {
    validate_snapshot_id(snapshot_id)?;
    let (canonical, snapshot_guard) = acquire_snapshot_guard(Path::new(project_dir)).await?;
    // Recreate a deleted root component-by-component under pinned capabilities,
    // before asking settings for its canonical-existing-project guard.
    let (canonical, snapshot_guard, project) = tokio::task::spawn_blocking(move || {
        let project = open_project_root(&canonical, true)?;
        Ok::<_, AppError>((canonical, snapshot_guard, project))
    })
    .await
    .map_err(|error| AppError::Custom(format!("snapshot worker: {error}")))??;
    let settings_guard = acquire_project_settings_guard(&canonical).await?;
    let project_dir = project_dir.to_owned();
    let snapshot_id = snapshot_id.to_owned();
    tokio::task::spawn_blocking(move || {
        let _snapshot_guard = snapshot_guard;
        let _settings_guard = settings_guard;
        restore_snapshot_locked(&project_dir, &project, &snapshot_id)
    })
    .await
    .map_err(|error| AppError::Custom(format!("snapshot worker: {error}")))?
}

pub async fn delete_snapshot(project_dir: &str, snapshot_id: &str) -> Result<(), AppError> {
    validate_snapshot_id(snapshot_id)?;
    let (_, guard) = acquire_snapshot_guard(Path::new(project_dir)).await?;
    let project_dir = project_dir.to_owned();
    let snapshot_id = snapshot_id.to_owned();
    tokio::spawn(async move {
        let _guard = guard;
        let local_project = project_dir.clone();
        let local_id = snapshot_id.clone();
        tokio::task::spawn_blocking(move || {
            if let Some(base) = open_base(&local_project, false)? {
                delete_local(&base, &local_id)?;
            }
            Ok::<_, AppError>(())
        })
        .await
        .map_err(|error| AppError::Custom(format!("snapshot worker: {error}")))??;
        #[cfg(feature = "sync")]
        try_delete_snapshot_remote(&project_dir, &snapshot_id).await;
        Ok(())
    })
    .await
    .map_err(|error| AppError::Custom(format!("snapshot worker: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use tempfile::TempDir;

    /// `create_snapshot` now consults three on-disk stores: the snapshot
    /// directory, global settings (retention policy) and the sync config
    /// (WebDAV mirroring). All three must point at a scratch dir or the test
    /// reads the developer's real `~/.novelist` — and `portable::init()` has
    /// never run in a unit-test process, so falling through there panics.
    struct Isolated {
        snapshots: Option<std::ffi::OsString>,
        settings: Option<std::ffi::OsString>,
        sync: Option<std::ffi::OsString>,
    }

    const SEAMS: [&str; 3] = [
        "NOVELIST_SNAPSHOTS_DATA_DIR",
        "NOVELIST_SETTINGS_DATA_DIR",
        "NOVELIST_SYNC_DATA_DIR",
    ];

    fn isolate(data_dir: &Path) -> Isolated {
        let saved: Vec<Option<std::ffi::OsString>> = SEAMS.iter().map(std::env::var_os).collect();
        for key in SEAMS {
            unsafe { std::env::set_var(key, data_dir) };
        }
        let mut it = saved.into_iter();
        Isolated {
            snapshots: it.next().unwrap(),
            settings: it.next().unwrap(),
            sync: it.next().unwrap(),
        }
    }

    impl Drop for Isolated {
        fn drop(&mut self) {
            for (key, value) in SEAMS.iter().zip([
                self.snapshots.take(),
                self.settings.take(),
                self.sync.take(),
            ]) {
                match value {
                    Some(value) => unsafe { std::env::set_var(key, value) },
                    None => unsafe { std::env::remove_var(key) },
                }
            }
            clear_test_clock();
        }
    }

    fn release(saved: Isolated) {
        drop(saved);
    }

    fn write_project_toml(project: &Path, snapshot_toml: &str) {
        let novelist_dir = project.join(".novelist");
        std::fs::create_dir_all(&novelist_dir).unwrap();
        std::fs::write(
            novelist_dir.join("project.toml"),
            format!(
                "[project]\nname = \"T\"\ntype = \"novel\"\nversion = \"0.1.0\"\n\n{snapshot_toml}"
            ),
        )
        .unwrap();
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn test_snapshots_dir_is_deterministic() {
        let tmp = TempDir::new().unwrap();
        let saved = isolate(tmp.path());
        let d1 = snapshots_dir("/home/user/novel");
        let d2 = snapshots_dir("/home/user/novel");
        assert_eq!(d1, d2);
        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn test_create_and_list_snapshot() {
        let data_tmp = TempDir::new().unwrap();
        let saved = isolate(data_tmp.path());

        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();

        // Create some files
        std::fs::write(dir.path().join("chapter1.md"), "# Chapter 1").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "Some notes").unwrap();
        std::fs::write(dir.path().join("image.png"), [0u8; 100]).unwrap();

        let meta = create_snapshot(&project, "First draft").await.unwrap();
        assert_eq!(meta.name, "First draft");
        assert_eq!(meta.file_count, 2);
        assert!(meta.id.starts_with("snap-"));

        let list = list_snapshots(&project).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, meta.id);

        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn test_restore_snapshot() {
        let data_tmp = TempDir::new().unwrap();
        let saved = isolate(data_tmp.path());

        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();

        std::fs::write(dir.path().join("chapter1.md"), "Original").unwrap();
        let meta = create_snapshot(&project, "Before edit").await.unwrap();

        // Modify the file
        std::fs::write(dir.path().join("chapter1.md"), "Modified").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("chapter1.md")).unwrap(),
            "Modified"
        );

        // Restore
        restore_snapshot(&project, &meta.id).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("chapter1.md")).unwrap(),
            "Original"
        );

        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn test_delete_snapshot() {
        let data_tmp = TempDir::new().unwrap();
        let saved = isolate(data_tmp.path());

        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();

        std::fs::write(dir.path().join("test.md"), "content").unwrap();
        let meta = create_snapshot(&project, "temp").await.unwrap();

        let list = list_snapshots(&project).await.unwrap();
        assert_eq!(list.len(), 1);

        delete_snapshot(&project, &meta.id).await.unwrap();

        let list = list_snapshots(&project).await.unwrap();
        assert_eq!(list.len(), 0);

        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn test_list_empty() {
        let data_tmp = TempDir::new().unwrap();
        let saved = isolate(data_tmp.path());

        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        let list = list_snapshots(&project).await.unwrap();
        assert!(list.is_empty());

        release(saved);
    }

    // ── retention ────────────────────────────────────────────────────────────

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn create_within_interval_replaces_newest() {
        let data_tmp = TempDir::new().unwrap();
        let saved = isolate(data_tmp.path());

        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("ch1.md"), "v1").unwrap();

        set_test_clock(1000);
        let first = create_snapshot(&project, "first").await.unwrap();
        assert_eq!(first.timestamp, 1000);

        // One second later — well inside the 60-minute default window.
        set_test_clock(1001);
        let second = create_snapshot(&project, "second").await.unwrap();

        let list = list_snapshots(&project).await.unwrap();
        assert_eq!(list.len(), 1, "replace must keep the count flat");
        assert_eq!(list[0].id, second.id, "the newer snapshot survives");
        assert!(
            !snapshots_dir(&project).join(&first.id).exists(),
            "victim dir must be deleted"
        );

        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn create_outside_interval_appends() {
        let data_tmp = TempDir::new().unwrap();
        let saved = isolate(data_tmp.path());

        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("ch1.md"), "v1").unwrap();

        set_test_clock(1000);
        create_snapshot(&project, "first").await.unwrap();
        set_test_clock(1000 + 3601); // just past the 60-minute window
        create_snapshot(&project, "second").await.unwrap();

        assert_eq!(list_snapshots(&project).await.unwrap().len(), 2);

        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn prune_keeps_newest_up_to_cap() {
        let data_tmp = TempDir::new().unwrap();
        let saved = isolate(data_tmp.path());

        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("ch1.md"), "v").unwrap();
        write_project_toml(
            dir.path(),
            "[snapshot]\nmax_count = 3\nmin_interval_minutes = 0\n",
        );

        // interval = 0 disables replacement, so each create appends.
        for i in 0u64..5 {
            set_test_clock(1000 + i * 3600);
            create_snapshot(&project, &format!("snap{i}"))
                .await
                .unwrap();
        }

        let list = list_snapshots(&project).await.unwrap();
        assert_eq!(list.len(), 3, "should prune down to cap = 3");
        assert_eq!(list[0].timestamp, 1000 + 4 * 3600);
        assert_eq!(list[1].timestamp, 1000 + 3 * 3600);
        assert_eq!(list[2].timestamp, 1000 + 2 * 3600);

        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn replace_does_not_trigger_prune() {
        let data_tmp = TempDir::new().unwrap();
        let saved = isolate(data_tmp.path());

        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("ch1.md"), "v").unwrap();
        write_project_toml(dir.path(), "[snapshot]\nmax_count = 3\n");

        for i in 0u64..3 {
            set_test_clock(1000 + i * 7200);
            create_snapshot(&project, &format!("s{i}")).await.unwrap();
        }
        assert_eq!(list_snapshots(&project).await.unwrap().len(), 3);

        // Inside the window of #3 → replaces it rather than pushing past the cap.
        set_test_clock(1000 + 2 * 7200 + 30);
        create_snapshot(&project, "replace").await.unwrap();

        assert_eq!(list_snapshots(&project).await.unwrap().len(), 3);

        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn min_interval_zero_never_replaces() {
        let data_tmp = TempDir::new().unwrap();
        let saved = isolate(data_tmp.path());

        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("ch1.md"), "v").unwrap();
        write_project_toml(dir.path(), "[snapshot]\nmin_interval_minutes = 0\n");

        set_test_clock(1000);
        create_snapshot(&project, "first").await.unwrap();
        set_test_clock(1001);
        create_snapshot(&project, "second").await.unwrap();

        assert_eq!(list_snapshots(&project).await.unwrap().len(), 2);

        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn stale_pending_dir_is_swept_and_never_listed() {
        let data_tmp = TempDir::new().unwrap();
        let saved = isolate(data_tmp.path());

        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("ch1.md"), "v").unwrap();

        // Plant the debris a crash mid-snapshot would leave behind.
        let base = snapshots_dir(&project);
        tokio::fs::create_dir_all(&base).await.unwrap();
        let stale = base.join("snap-999.pending");
        tokio::fs::create_dir_all(stale.join("files"))
            .await
            .unwrap();
        tokio::fs::write(stale.join("metadata.json"), "{}")
            .await
            .unwrap();

        assert!(
            list_snapshots(&project).await.unwrap().is_empty(),
            ".pending dirs must never surface as snapshots"
        );

        set_test_clock(2000);
        create_snapshot(&project, "after crash").await.unwrap();

        assert!(!stale.exists(), "stale .pending must be swept");
        assert_eq!(list_snapshots(&project).await.unwrap().len(), 1);

        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn concurrent_creates_complete_independent_snapshots() {
        let data = TempDir::new().unwrap();
        let saved = isolate(data.path());
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_str().unwrap();
        write_project_toml(dir.path(), "[snapshot]\nmin_interval_minutes = 0\n");
        std::fs::write(dir.path().join("book.md"), "complete manuscript").unwrap();
        set_test_clock(2000);
        let results = tokio::join!(
            create_snapshot(project, "first"),
            create_snapshot(project, "second"),
            create_snapshot(project, "third"),
            create_snapshot(project, "fourth"),
        );
        let snapshots = [
            results.0.unwrap(),
            results.1.unwrap(),
            results.2.unwrap(),
            results.3.unwrap(),
        ];
        let listed = list_snapshots(project).await.unwrap();
        assert_eq!(listed.len(), snapshots.len());
        for snapshot in &snapshots {
            assert_eq!(
                listed.iter().filter(|item| item.id == snapshot.id).count(),
                1
            );
            let base = snapshots_dir(project).join(&snapshot.id);
            let metadata: SnapshotMeta =
                serde_json::from_slice(&std::fs::read(base.join("metadata.json")).unwrap())
                    .unwrap();
            assert_eq!(metadata.name, snapshot.name);
            assert_eq!(metadata.file_count, 2);
            assert_eq!(
                std::fs::read(base.join("files/book.md")).unwrap(),
                b"complete manuscript"
            );
            assert_eq!(
                std::fs::read(base.join("files/.novelist/project.toml")).unwrap(),
                std::fs::read(dir.path().join(".novelist/project.toml")).unwrap()
            );
        }
        assert!(std::fs::read_dir(snapshots_dir(project))
            .unwrap()
            .all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".pending")
            }));
        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn same_second_creates_preserve_each_version_without_replacement() {
        let data = TempDir::new().unwrap();
        let saved = isolate(data.path());
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_str().unwrap();
        write_project_toml(dir.path(), "[snapshot]\nmin_interval_minutes = 0\n");
        set_test_clock(3000);
        std::fs::write(dir.path().join("book.md"), "first version").unwrap();
        let first = create_snapshot(project, "first").await.unwrap();
        std::fs::write(dir.path().join("book.md"), "second version").unwrap();
        let second = create_snapshot(project, "second").await.unwrap();
        assert_ne!(first.id, second.id);
        let listed = list_snapshots(project).await.unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            [second.id.as_str(), first.id.as_str()]
        );
        restore_snapshot(project, &first.id).await.unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("book.md")).unwrap(),
            b"first version"
        );
        restore_snapshot(project, &second.id).await.unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("book.md")).unwrap(),
            b"second version"
        );
        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn same_second_replacement_retires_only_previous_snapshot() {
        let data = TempDir::new().unwrap();
        let saved = isolate(data.path());
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_str().unwrap();
        set_test_clock(4000);
        std::fs::write(dir.path().join("book.md"), "old").unwrap();
        let first = create_snapshot(project, "first").await.unwrap();
        std::fs::write(dir.path().join("book.md"), "new").unwrap();
        let second = create_snapshot(project, "second").await.unwrap();
        assert_ne!(first.id, second.id);
        let listed = list_snapshots(project).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, second.id);
        assert!(!snapshots_dir(project).join(first.id).exists());
        assert_eq!(
            std::fs::read(snapshots_dir(project).join(second.id).join("files/book.md")).unwrap(),
            b"new"
        );
        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn project_documents_and_required_metadata_roundtrip_without_secrets() {
        let data = TempDir::new().unwrap();
        let saved = isolate(data.path());
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_str().unwrap();
        write_project_toml(dir.path(), "[snapshot]\nmin_interval_minutes = 0\n");
        let config = std::fs::read(dir.path().join(".novelist/project.toml")).unwrap();
        let documents = [
            "book.md",
            "book.markdown",
            "book.txt",
            "book.json",
            "book.jsonl",
            "book.csv",
            "book.litstudy",
            "planning/map.canvas",
            "planning/tasks.kanban",
            ".novelist/literary-study.json",
        ];
        for path in documents {
            let full = dir.path().join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, format!("original {path}")).unwrap();
        }
        for path in [
            ".novelist/credentials.json",
            ".novelist/cache/secret.json",
            ".git/config.json",
            "planning/.private/notes.md",
            "image.png",
        ] {
            let full = dir.path().join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, "excluded").unwrap();
        }
        let snapshot = create_snapshot(project, "all document formats")
            .await
            .unwrap();
        let files = snapshots_dir(project).join(&snapshot.id).join("files");
        assert_eq!(snapshot.file_count, documents.len() + 1);
        for path in documents {
            std::fs::write(dir.path().join(path), "edited").unwrap();
        }
        std::fs::write(dir.path().join(".novelist/project.toml"), "edited").unwrap();
        restore_snapshot(project, &snapshot.id).await.unwrap();
        for path in documents {
            assert_eq!(
                std::fs::read_to_string(dir.path().join(path)).unwrap(),
                format!("original {path}")
            );
        }
        assert_eq!(
            std::fs::read(dir.path().join(".novelist/project.toml")).unwrap(),
            config
        );
        for path in [
            ".novelist/credentials.json",
            ".novelist/cache",
            ".git",
            "planning/.private",
            "image.png",
        ] {
            assert!(
                !files.join(path).exists(),
                "excluded path was copied: {path}"
            );
        }
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".novelist/credentials.json")).unwrap(),
            "excluded"
        );
        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn legacy_snapshot_ids_remain_listable_restorable_and_deletable() {
        let data = TempDir::new().unwrap();
        let saved = isolate(data.path());
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_str().unwrap();
        let snapshot = snapshots_dir(project).join("snap-123");
        std::fs::create_dir_all(snapshot.join("files")).unwrap();
        std::fs::write(snapshot.join("files/book.md"), "legacy bytes").unwrap();
        let meta = SnapshotMeta {
            id: "snap-123".into(),
            name: "legacy".into(),
            timestamp: 123,
            file_count: 1,
            total_bytes: 12,
        };
        std::fs::write(
            snapshot.join("metadata.json"),
            serde_json::to_vec(&meta).unwrap(),
        )
        .unwrap();
        assert_eq!(list_snapshots(project).await.unwrap()[0].id, "snap-123");
        restore_snapshot(project, "snap-123").await.unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("book.md")).unwrap(),
            b"legacy bytes"
        );
        delete_snapshot(project, "snap-123").await.unwrap();
        assert!(list_snapshots(project).await.unwrap().is_empty());
        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn restore_preflight_failure_preserves_every_original_file() {
        let data = TempDir::new().unwrap();
        let saved = isolate(data.path());
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("a.md"), "snapshot a").unwrap();
        std::fs::write(dir.path().join("z.md"), "snapshot z").unwrap();
        let snapshot = create_snapshot(project, "before conflict").await.unwrap();
        std::fs::write(dir.path().join("a.md"), "current a").unwrap();
        std::fs::remove_file(dir.path().join("z.md")).unwrap();
        std::fs::create_dir(dir.path().join("z.md")).unwrap();
        std::fs::write(dir.path().join("z.md/keep.txt"), "keep").unwrap();
        assert!(restore_snapshot(project, &snapshot.id).await.is_err());
        assert_eq!(
            std::fs::read(dir.path().join("a.md")).unwrap(),
            b"current a"
        );
        assert_eq!(
            std::fs::read(dir.path().join("z.md/keep.txt")).unwrap(),
            b"keep"
        );
        assert!(std::fs::read_dir(dir.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".novelist-restore-")));
        release(saved);
    }

    #[test]
    fn failed_restore_read_does_not_truncate_target_or_leave_temporary_bytes() {
        struct FailingReader(bool);
        impl std::io::Read for FailingReader {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                if self.0 {
                    return Err(std::io::Error::other("source read failure"));
                }
                self.0 = true;
                bytes[0] = b'x';
                Ok(1)
            }
        }
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("book.md"), "original bytes").unwrap();
        let parent = Dir::open_ambient_dir(dir.path(), ambient_authority()).unwrap();
        assert!(stage_restore_file(
            Arc::new(parent),
            OsString::from("book.md"),
            &mut FailingReader(false)
        )
        .is_err());
        assert_eq!(
            std::fs::read(dir.path().join("book.md")).unwrap(),
            b"original bytes"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn failed_snapshot_source_symlink_keeps_previous_snapshot() {
        let data = TempDir::new().unwrap();
        let saved = isolate(data.path());
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let project = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("book.md"), "saved bytes").unwrap();
        let snapshot = create_snapshot(project, "complete").await.unwrap();
        std::fs::write(outside.path().join("private.md"), "outside secret").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("private.md"),
            dir.path().join("leak.md"),
        )
        .unwrap();
        assert!(create_snapshot(project, "must fail").await.is_err());
        let listed = list_snapshots(project).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, snapshot.id);
        assert_eq!(
            std::fs::read(
                snapshots_dir(project)
                    .join(snapshot.id)
                    .join("files/book.md")
            )
            .unwrap(),
            b"saved bytes"
        );
        assert!(std::fs::read_dir(snapshots_dir(project))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".pending")));
        assert_eq!(
            std::fs::read(outside.path().join("private.md")).unwrap(),
            b"outside secret"
        );
        release(saved);
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn restore_rejects_target_symlink_without_touching_outside_bytes() {
        let data = TempDir::new().unwrap();
        let saved = isolate(data.path());
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let project = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("book.md"), "snapshot").unwrap();
        let snapshot = create_snapshot(project, "safe").await.unwrap();
        std::fs::write(outside.path().join("book.md"), "outside bytes").unwrap();
        std::fs::remove_file(dir.path().join("book.md")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("book.md"), dir.path().join("book.md"))
            .unwrap();
        assert!(restore_snapshot(project, &snapshot.id).await.is_err());
        assert_eq!(
            std::fs::read(outside.path().join("book.md")).unwrap(),
            b"outside bytes"
        );
        assert!(std::fs::symlink_metadata(dir.path().join("book.md"))
            .unwrap()
            .file_type()
            .is_symlink());
        release(saved);
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn restore_rejects_parent_symlink_without_writing_outside_project() {
        let data = TempDir::new().unwrap();
        let saved = isolate(data.path());
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let project = dir.path().to_str().unwrap();
        std::fs::create_dir(dir.path().join("chapters")).unwrap();
        std::fs::write(dir.path().join("chapters/book.md"), "snapshot").unwrap();
        let snapshot = create_snapshot(project, "safe").await.unwrap();
        std::fs::remove_dir_all(dir.path().join("chapters")).unwrap();
        std::fs::write(outside.path().join("book.md"), "outside bytes").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("chapters")).unwrap();
        assert!(restore_snapshot(project, &snapshot.id).await.is_err());
        assert_eq!(
            std::fs::read(outside.path().join("book.md")).unwrap(),
            b"outside bytes"
        );
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 1);
        release(saved);
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn restore_rejects_snapshot_source_symlink_before_replacing_files() {
        let data = TempDir::new().unwrap();
        let saved = isolate(data.path());
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let project = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("book.md"), "snapshot").unwrap();
        let snapshot = create_snapshot(project, "safe").await.unwrap();
        std::fs::write(dir.path().join("book.md"), "current bytes").unwrap();
        std::fs::write(outside.path().join("private.md"), "outside secret").unwrap();
        let source = snapshots_dir(project)
            .join(&snapshot.id)
            .join("files/book.md");
        std::fs::remove_file(&source).unwrap();
        std::os::unix::fs::symlink(outside.path().join("private.md"), source).unwrap();
        assert!(restore_snapshot(project, &snapshot.id).await.is_err());
        assert_eq!(
            std::fs::read(dir.path().join("book.md")).unwrap(),
            b"current bytes"
        );
        assert_eq!(
            std::fs::read(outside.path().join("private.md")).unwrap(),
            b"outside secret"
        );
        release(saved);
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn restore_rejects_snapshot_root_symlink_without_importing_outside_files() {
        let data = TempDir::new().unwrap();
        let saved = isolate(data.path());
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let project = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("book.md"), "snapshot").unwrap();
        let snapshot = create_snapshot(project, "safe").await.unwrap();
        std::fs::write(dir.path().join("book.md"), "current bytes").unwrap();
        std::fs::write(outside.path().join("book.md"), "outside secret").unwrap();
        let files = snapshots_dir(project).join(&snapshot.id).join("files");
        std::fs::remove_dir_all(&files).unwrap();
        std::os::unix::fs::symlink(outside.path(), files).unwrap();
        assert!(restore_snapshot(project, &snapshot.id).await.is_err());
        assert_eq!(
            std::fs::read(dir.path().join("book.md")).unwrap(),
            b"current bytes"
        );
        assert_eq!(
            std::fs::read(outside.path().join("book.md")).unwrap(),
            b"outside secret"
        );
        release(saved);
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn many_files_in_one_directory_restore_under_descriptor_limit() {
        const CHILD_ENV: &str = "NOVELIST_SNAPSHOT_FD_TEST_CHILD";
        if std::env::var_os(CHILD_ENV).is_none() {
            // Apply the low limit in an isolated process; changing this test
            // runner's limit would interfere with concurrently executing tests.
            let test_name = format!(
                "{}::many_files_in_one_directory_restore_under_descriptor_limit",
                module_path!().split_once("::").unwrap().1
            );
            let output = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg("ulimit -n 128 && exec \"$@\"")
                .arg("snapshot-fd-test")
                .arg(std::env::current_exe().unwrap())
                .args(["--exact", &test_name, "--nocapture"])
                .env(CHILD_ENV, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "bounded-descriptor restore failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let data = TempDir::new().unwrap();
        let saved = isolate(data.path());
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_str().unwrap();
        for index in 0..256 {
            std::fs::write(
                dir.path().join(format!("chapter-{index}.md")),
                format!("original {index}"),
            )
            .unwrap();
        }
        let snapshot = create_snapshot(project, "many chapters").await.unwrap();
        assert_eq!(snapshot.file_count, 256);
        for index in 0..256 {
            std::fs::write(dir.path().join(format!("chapter-{index}.md")), "edited").unwrap();
        }
        restore_snapshot(project, &snapshot.id).await.unwrap();
        for index in 0..256 {
            assert_eq!(
                std::fs::read_to_string(dir.path().join(format!("chapter-{index}.md"))).unwrap(),
                format!("original {index}")
            );
        }
        release(saved);
    }

    #[tokio::test]
    #[serial(snapshots_data_dir, settings_data_dir, sync_data_dir)]
    async fn missing_project_root_keeps_snapshot_list_restore_and_delete_available() {
        let data = TempDir::new().unwrap();
        let saved = isolate(data.path());
        let parent = TempDir::new().unwrap();
        let root = parent.path().join("missing-parent/project");
        std::fs::create_dir_all(&root).unwrap();
        let project = root.to_str().unwrap();
        write_project_toml(&root, "[snapshot]\nmin_interval_minutes = 0\n");
        std::fs::write(root.join("book.md"), "recoverable manuscript").unwrap();
        let snapshot = create_snapshot(project, "before deletion").await.unwrap();
        std::fs::remove_dir_all(parent.path().join("missing-parent")).unwrap();
        assert_eq!(list_snapshots(project).await.unwrap()[0].id, snapshot.id);
        assert!(create_snapshot(project, "missing source").await.is_err());
        assert!(!root.exists(), "creation must not invent an empty project");
        restore_snapshot(project, &snapshot.id).await.unwrap();
        assert_eq!(
            std::fs::read(root.join("book.md")).unwrap(),
            b"recoverable manuscript"
        );
        assert!(root.join(".novelist/project.toml").is_file());
        std::fs::remove_dir_all(parent.path().join("missing-parent")).unwrap();
        delete_snapshot(project, &snapshot.id).await.unwrap();
        assert!(list_snapshots(project).await.unwrap().is_empty());
        assert!(!root.exists(), "list/delete must not recreate the project");
        release(saved);
    }
}
