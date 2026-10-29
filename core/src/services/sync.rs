use crate::services::cloud;
use crate::services::project_files::is_project_content_path;
use crate::services::webdav::{self, WebDavAuth};
use crate::AppError;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::SystemTime;

#[derive(Serialize, Deserialize, Clone, Type, Debug)]
pub struct SyncConfig {
    pub enabled: bool,
    pub webdav_url: String,
    pub username: String,
    pub password: String,
    pub interval_minutes: u32,
    /// Explicitly leave an unidentifiable legacy `novelist/{name}` tree untouched.
    #[serde(default)]
    pub legacy_remote_acknowledged: bool,
    /// Credentials come from this device's cloud account (`services::cloud`).
    /// `webdav_url`/`username` then name the account the project was linked
    /// to, and `password` stays empty.
    #[serde(default)]
    pub cloud_account: bool,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            webdav_url: String::new(),
            username: String::new(),
            password: String::new(),
            interval_minutes: 30,
            legacy_remote_acknowledged: false,
            cloud_account: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Type, Debug)]
pub struct SyncStatus {
    pub last_sync: Option<String>,
    /// Files whose new content or deletion was propagated to the remote.
    pub files_uploaded: u32,
    /// Files whose new content or deletion was propagated to this project.
    pub files_downloaded: u32,
    pub errors: Vec<String>,
    pub in_progress: bool,
    /// Set when another device already moved this project's legacy
    /// `novelist/{name}` tree into `novelist-sync/{id}`. Joining that namespace
    /// requires an explicit `adopt_sync_identity` call with this ID.
    pub adoptable_project_id: Option<String>,
    /// Files both sides changed since their last common version. Both copies
    /// were left untouched; each needs `resolve_conflict`.
    pub conflicts: Vec<String>,
}

/// Per-file common content established only by a successful transfer or equality.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SyncState {
    pub last_sync_iso: Option<String>,
    /// Map of relative path -> last known modification time (as seconds since epoch)
    pub file_mod_times: HashMap<String, u64>,
    /// Legacy timestamps are retained, but cannot safely resolve two-sided edits.
    #[serde(default)]
    pub common_hashes: HashMap<String, String>,
    /// Strong remote ETag received together with each common version. A listing
    /// that still reports it proves the remote bytes equal the baseline.
    #[serde(default)]
    pub remote_etags: HashMap<String, String>,
    /// Baselines are meaningful only for this project identity and remote account.
    #[serde(default)]
    pub remote_binding: Option<String>,
}

pub(crate) const LOCAL_IDENTITY_PATH: &str = ".novelist/sync-identity.json";
const IDENTITY_FILE: &str = "sync-identity.json";
pub(crate) const MAX_IDENTITY_BYTES: usize = 1024;
/// Remote collection holding one `{project_id}` namespace per project.
pub(crate) const REMOTE_ROOT: &str = "novelist-sync";
/// Identity cards naming the namespace that continues a legacy
/// `novelist/{name}` tree. Created with `If-None-Match: *`, so exactly one
/// device decides; every other copy must explicitly adopt that identity.
const LEGACY_CLAIMS_DIR: &str = "novelist-sync/legacy-claims";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SyncIdentity {
    schema_version: u32,
    project_id: String,
}

/// Project IDs are exactly 64 lowercase hexadecimal characters.
pub(crate) fn is_project_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_identity(bytes: &[u8]) -> Result<SyncIdentity, AppError> {
    if bytes.len() > MAX_IDENTITY_BYTES {
        return Err(AppError::InvalidInput(
            "Sync project identity exceeds its size limit".into(),
        ));
    }
    let identity: SyncIdentity = serde_json::from_slice(bytes).map_err(|_| {
        AppError::InvalidInput("Invalid sync project identity; restore the project's original .novelist/sync-identity.json instead of replacing its ID".into())
    })?;
    if identity.schema_version != 1 || !is_project_id(&identity.project_id) {
        return Err(AppError::InvalidInput(
            "Invalid or unsupported sync project identity".into(),
        ));
    }
    Ok(identity)
}

/// The project ID a remote identity card names.
pub(crate) fn parse_project_id(bytes: &[u8]) -> Result<String, AppError> {
    parse_identity(bytes).map(|identity| identity.project_id)
}

/// The ID in a local project's identity card, if it has one.
pub(crate) fn local_project_id(project: &Path) -> Result<Option<String>, AppError> {
    let root = Dir::open_ambient_dir(project, ambient_authority())?;
    Ok(read_local_identity(&root)?.map(|(identity, _)| identity.project_id))
}

/// The project's sync ID, creating its identity card if it has none yet (an
/// existing card is never replaced). The same ID the first sync would publish.
pub(crate) fn ensure_project_identity(project: &Path) -> Result<String, AppError> {
    let root = Dir::open_ambient_dir(project, ambient_authority())?;
    Ok(project_identity(&root)?.0.project_id)
}

/// Give a new, still empty project copy an existing identity. An existing card
/// is never replaced: a project that already has another ID is rejected.
pub(crate) fn write_project_identity(project: &Path, project_id: &str) -> Result<(), AppError> {
    if !is_project_id(project_id) {
        return Err(AppError::InvalidInput(
            "Invalid or unsupported sync project identity".into(),
        ));
    }
    let identity = SyncIdentity {
        schema_version: 1,
        project_id: project_id.to_owned(),
    };
    let root = Dir::open_ambient_dir(project, ambient_authority())?;
    let parent = webdav::confined_parent(&root, Path::new(LOCAL_IDENTITY_PATH), true)?;
    publish_identity(&parent, &serde_json::to_vec_pretty(&identity)?, false)?;
    match read_local_identity(&root)? {
        Some((stored, _)) if stored == identity => Ok(()),
        _ => Err(AppError::Custom(
            "This folder already has a different sync identity; it was not changed".into(),
        )),
    }
}

fn read_local_identity(root: &Dir) -> Result<Option<(SyncIdentity, Vec<u8>)>, AppError> {
    let parent = match webdav::confined_parent(root, Path::new(LOCAL_IDENTITY_PATH), false) {
        Ok(parent) => parent,
        Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None)
        }
        Err(error) => return Err(error),
    };
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = match parent.open_with(IDENTITY_FILE, &options) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !file.metadata()?.is_file() {
        return Err(AppError::InvalidInput(
            "Sync project identity is not a regular file".into(),
        ));
    }
    let mut bytes = Vec::new();
    file.take((MAX_IDENTITY_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    Ok(Some((parse_identity(&bytes)?, bytes)))
}

fn project_identity(root: &Dir) -> Result<(SyncIdentity, Vec<u8>), AppError> {
    if let Some(identity) = read_local_identity(root)? {
        return Ok(identity);
    }
    // tempfile already supplies OS-seeded random names. Hash only that random
    // name, never an absolute project path, so moving/copying the sidecar keeps ID.
    let entropy = tempfile::Builder::new().rand_bytes(32).tempfile()?;
    let identity = SyncIdentity {
        schema_version: 1,
        project_id: hash(entropy.path().file_name().unwrap().as_encoded_bytes()),
    };
    let parent = webdav::confined_parent(root, Path::new(LOCAL_IDENTITY_PATH), true)?;
    publish_identity(&parent, &serde_json::to_vec_pretty(&identity)?, false)?;
    read_local_identity(root)?.ok_or_else(|| {
        AppError::Custom("Sync project identity disappeared while being created".into())
    })
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Stage the complete card, fsync it, then publish it in one step, so a crash
/// leaves at most an ignored temporary file, never a partial identity. Creation
/// never replaces an existing card: the hard link fails with `AlreadyExists`.
/// Only an explicit adoption (`replace`) swaps the card, by atomic rename.
fn publish_identity(parent: &Dir, bytes: &[u8], replace: bool) -> Result<(), AppError> {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = format!(".sync-identity-{}-{counter}.tmp", std::process::id());
    let mut options = cap_std::fs::OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    let staged = (|| -> Result<(), AppError> {
        let mut file = parent.open_with(&temp, &options)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    })();
    let result = staged.and_then(|()| {
        if replace {
            return Ok(parent.rename(&temp, parent, IDENTITY_FILE)?);
        }
        match parent.hard_link(&temp, parent, IDENTITY_FILE) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            // Filesystems without hard links (FAT/exFAT): rename only while no
            // card exists. Syncs of one project are serialized in-process.
            Err(_) => match parent.symlink_metadata(IDENTITY_FILE) {
                Ok(_) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(parent.rename(&temp, parent, IDENTITY_FILE)?)
                }
                Err(error) => Err(error.into()),
            },
        }
    });
    // Already gone after a rename; removes the staged copy otherwise.
    let _ = parent.remove_file(&temp);
    result
}

/// Get the sync data directory for a project: ~/.novelist/sync/{key-hash}/,
/// keyed by the project storage key (path on desktop, library-relative path
/// on mobile, so iOS app-container relocation keeps config and baselines).
fn sync_dir_for_project(project_dir: &str) -> Result<PathBuf, AppError> {
    let key = crate::services::portable::project_storage_key(project_dir);
    let hash = blake3::hash(key.as_bytes()).to_hex();
    let dir = data_root().join("sync").join(&hash[..16]);
    Ok(dir)
}

pub(crate) fn data_root() -> PathBuf {
    // `NOVELIST_SYNC_DATA_DIR` is a test seam (used by unit tests that need
    // per-test isolation and can't rely on `portable::init()` having run).
    // Production code goes through `portable::novelist_home`.
    #[cfg(test)]
    {
        if let Ok(p) = std::env::var("NOVELIST_SYNC_DATA_DIR") {
            if !p.is_empty() {
                return PathBuf::from(p);
            }
        }
    }
    crate::services::portable::novelist_home().to_path_buf()
}

/// Read sync config from disk
pub fn read_sync_config(project_dir: &str) -> Result<SyncConfig, AppError> {
    let dir = sync_dir_for_project(project_dir)?;
    let path = dir.join("config.json");
    if !path.exists() {
        return Ok(SyncConfig::default());
    }
    let data = std::fs::read_to_string(&path)?;
    let config: SyncConfig = serde_json::from_str(&data)?;
    Ok(config)
}

/// Save sync config to disk
pub fn save_sync_config_to_disk(project_dir: &str, config: &SyncConfig) -> Result<(), AppError> {
    if !config.webdav_url.is_empty() {
        webdav::remote_url(&config.webdav_url, "")?;
    }
    let dir = sync_dir_for_project(project_dir)?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("config.json");
    let data = serde_json::to_string_pretty(config)?;
    atomic_write_state(&path, data.as_bytes())?;
    Ok(())
}

/// Read sync state from disk
fn read_sync_state(project_dir: &str) -> Result<SyncState, AppError> {
    let dir = sync_dir_for_project(project_dir)?;
    let path = dir.join("sync-state.json");
    if !path.exists() {
        return Ok(SyncState::default());
    }
    let data = std::fs::read_to_string(&path)?;
    let state: SyncState = serde_json::from_str(&data)?;
    Ok(state)
}

/// Write sync state to disk
fn write_sync_state(project_dir: &str, state: &SyncState) -> Result<(), AppError> {
    let dir = sync_dir_for_project(project_dir)?;
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("sync-state.json");
    let data = serde_json::to_string_pretty(state)?;
    atomic_write_state(&path, data.as_bytes())?;
    Ok(())
}

/// Last completed sync of a project, if any.
pub(crate) fn last_sync(project_dir: &str) -> Result<Option<String>, AppError> {
    Ok(read_sync_state(project_dir)?.last_sync_iso)
}

fn ignore_missing(result: std::io::Result<()>) -> Result<(), AppError> {
    match result {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

/// A folder's app-data sync directory (config, baselines, recovery copies),
/// resolved while the folder still exists under that name: its storage key
/// may depend on resolving the path, which fails once the folder is renamed.
pub(crate) struct SyncData(PathBuf);

impl SyncData {
    pub(crate) fn of(project_dir: &str) -> Result<Self, AppError> {
        Ok(Self(sync_dir_for_project(project_dir)?))
    }

    /// Move the config and baselines to the key of `to_project`, replacing
    /// whatever an earlier folder at that path left behind. Both exist after
    /// a completed sync; a missing one is an error, never a silently unlinked
    /// project.
    pub(crate) fn relocate(self, to_project: &str) -> Result<(), AppError> {
        let to = sync_dir_for_project(to_project)?;
        if self.0 == to {
            return Ok(());
        }
        std::fs::create_dir_all(&to)?;
        for name in ["config.json", "sync-state.json"] {
            std::fs::rename(self.0.join(name), to.join(name))?;
        }
        self.discard()
    }

    /// Forget the sync data of a folder that never became a project.
    pub(crate) fn discard(self) -> Result<(), AppError> {
        ignore_missing(std::fs::remove_dir_all(&self.0))
    }
}

/// Apply `edit` to every stored project sync config; a config is rewritten
/// (atomically) only when `edit` reports a change. Returns how many changed.
fn rewrite_sync_configs(mut edit: impl FnMut(&mut SyncConfig) -> bool) -> Result<u32, AppError> {
    let entries = match std::fs::read_dir(data_root().join("sync")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.into()),
    };
    let mut changed = 0;
    for entry in entries {
        let path = entry?.path().join("config.json");
        let Ok(data) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut config) = serde_json::from_str::<SyncConfig>(&data) else {
            continue;
        };
        if edit(&mut config) {
            atomic_write_state(&path, serde_json::to_string_pretty(&config)?.as_bytes())?;
            changed += 1;
        }
    }
    Ok(changed)
}

/// Turn sync off for every project linked to the cloud account. Their files,
/// baselines and remote copies stay; returns how many were unlinked.
pub(crate) fn unlink_cloud_projects() -> Result<u32, AppError> {
    rewrite_sync_configs(|config| {
        if !config.cloud_account {
            return false;
        }
        config.cloud_account = false;
        config.enabled = false;
        config.password.clear();
        true
    })
}

/// Move per-project WebDAV passwords out of plaintext configs when an account
/// connects. Projects using exactly that endpoint and user become linked to
/// it (the baseline binding, which covers URL, user and project ID, is
/// unchanged). With `strip_others` (mobile, where no plaintext password may
/// remain), every other stored password is removed and that project's sync
/// turned off until it is linked.
pub(crate) fn adopt_inline_credentials(
    endpoint: &str,
    username: &str,
    strip_others: bool,
) -> Result<u32, AppError> {
    rewrite_sync_configs(|config| {
        if config.cloud_account {
            return false;
        }
        if config.webdav_url == endpoint && config.username == username {
            config.cloud_account = true;
            config.password.clear();
            return true;
        }
        if strip_others && !config.password.is_empty() {
            config.password.clear();
            config.enabled = false;
            return true;
        }
        false
    })
}

pub(crate) fn atomic_write_state(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Missing sync state parent".into()))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path)
        .map_err(|error| AppError::Io(error.error))?;
    Ok(())
}

fn content_directory(relative: &str) -> bool {
    relative == ".novelist" || relative.split('/').all(|part| !part.starts_with('.'))
}

/// Returns the syncable files plus content entries skipped because their names
/// cannot be represented remotely (non-UTF-8, control characters).
fn collect_local_files(root: &Dir) -> Result<(BTreeSet<String>, Vec<String>), AppError> {
    fn walk(
        dir: &Dir,
        prefix: &str,
        files: &mut BTreeSet<String>,
        skipped: &mut Vec<String>,
    ) -> Result<(), AppError> {
        for entry in dir.entries()? {
            let entry = entry?;
            let file_name = entry.file_name();
            let display = file_name.to_string_lossy();
            let relative = if prefix.is_empty() {
                display.into_owned()
            } else {
                format!("{prefix}/{display}")
            };
            let kind = entry.file_type()?;
            let content = if kind.is_dir() {
                content_directory(&relative)
            } else if kind.is_file() {
                is_project_content_path(Path::new(&relative))
            } else {
                kind.is_symlink()
                    && (is_project_content_path(Path::new(&relative))
                        || content_directory(&relative))
            };
            // Filter first: non-content names such as macOS `Icon\r` never matter.
            if !content {
                continue;
            }
            let Some(name) = file_name.to_str() else {
                skipped.push(relative);
                continue;
            };
            if webdav::validate_remote_path(&relative).is_err() {
                skipped.push(relative);
                continue;
            }
            if kind.is_symlink() {
                return Err(AppError::PathNotAllowed(format!(
                    "Project sync does not follow symlinks: {relative}"
                )));
            }
            if kind.is_dir() {
                walk(&dir.open_dir_nofollow(name)?, &relative, files, skipped)?;
            } else {
                files.insert(relative);
            }
        }
        Ok(())
    }
    let mut files = BTreeSet::new();
    let mut skipped = Vec::new();
    walk(root, "", &mut files, &mut skipped)?;
    Ok((files, skipped))
}

/// Remote content files with the strong ETag each listing entry reported.
async fn collect_remote_files(
    client: &Client,
    base_url: &str,
    remote_base: &str,
    auth: &WebDavAuth,
) -> Result<BTreeMap<String, Option<String>>, AppError> {
    let mut files = BTreeMap::new();
    let mut pending = vec![String::new()];
    let mut visited = HashSet::new();
    while let Some(prefix) = pending.pop() {
        if !visited.insert(prefix.clone()) {
            continue;
        }
        let remote = if prefix.is_empty() {
            remote_base.to_string()
        } else {
            format!("{remote_base}/{prefix}")
        };
        let collection = webdav::remote_url(base_url, &remote)?;
        for entry in webdav::list_remote(client, base_url, &remote, auth).await? {
            let child = webdav::relative_href(&collection, &entry.href)?;
            if child.is_empty() {
                continue;
            }
            // Depth:1 responses may only describe this collection's children.
            if child.contains('/') {
                return Err(AppError::InvalidInput(
                    "WebDAV listing escaped requested depth".into(),
                ));
            }
            let relative = if prefix.is_empty() {
                child
            } else {
                format!("{prefix}/{child}")
            };
            if entry.is_collection && content_directory(&relative) {
                pending.push(relative);
            } else if !entry.is_collection && is_project_content_path(Path::new(&relative)) {
                files.insert(relative, entry.etag);
            }
        }
    }
    Ok(files)
}

static SYNC_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

async fn sync_guard(project: &Path) -> Result<tokio::sync::OwnedMutexGuard<()>, AppError> {
    let mutex = {
        let mut locks = SYNC_LOCKS
            .lock()
            .map_err(|_| AppError::Custom("Sync lock poisoned".into()))?;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(project).and_then(Weak::upgrade) {
            lock
        } else {
            let lock = Arc::new(tokio::sync::Mutex::new(()));
            locks.insert(project.to_path_buf(), Arc::downgrade(&lock));
            lock
        }
    };
    Ok(mutex.lock_owned().await)
}

fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn optional_local(root: &Dir, relative: &str) -> Result<Option<Vec<u8>>, AppError> {
    match webdav::read_confined(root, Path::new(relative)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn assert_local_unchanged(
    root: &Dir,
    relative: &str,
    expected: Option<&str>,
) -> Result<(), AppError> {
    let actual = optional_local(root, relative)?.as_deref().map(hash);
    if actual.as_deref() != expected {
        return Err(AppError::Custom(
            "Conflict: local file changed during transfer".into(),
        ));
    }
    Ok(())
}

fn file_name_of(relative: &str) -> Result<&str, AppError> {
    Path::new(relative)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::InvalidInput("Invalid sync filename".into()))
}

/// Stage and compare before the atomic rename, using a pinned parent capability.
fn commit_download(
    root: &Dir,
    relative: &str,
    bytes: &[u8],
    expected: Option<&str>,
) -> Result<(), AppError> {
    let parent = webdav::confined_parent(root, Path::new(relative), true)?;
    let name = file_name_of(relative)?;
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = format!(".novelist-sync-{}-{counter}.tmp", std::process::id());
    let mut options = cap_std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = parent.open_with(&temp, &options)?;
    let result = (|| -> Result<(), AppError> {
        file.write_all(bytes)?;
        file.sync_all()?;
        assert_local_unchanged(root, relative, expected)?;
        // Also compare through the pinned parent if its ambient path moved.
        assert_local_unchanged(&parent, name, expected)?;
        parent.rename(&temp, &parent, name)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = parent.remove_file(&temp);
    }
    result
}

/// Apply a deletion made on the other device. A recoverable copy goes to the
/// app-data `deleted/` folder first; the file is removed only while its bytes
/// still equal the common version that the remote deletion observed.
fn retire_local(
    root: &Dir,
    relative: &str,
    bytes: &[u8],
    expected: &str,
    deleted_dir: &Path,
) -> Result<(), AppError> {
    let copy = deleted_dir.join(relative);
    std::fs::create_dir_all(
        copy.parent()
            .ok_or_else(|| AppError::InvalidInput("Invalid sync filename".into()))?,
    )?;
    atomic_write_state(&copy, bytes)?;
    let parent = webdav::confined_parent(root, Path::new(relative), false)?;
    let name = file_name_of(relative)?;
    assert_local_unchanged(root, relative, Some(expected))?;
    assert_local_unchanged(&parent, name, Some(expected))?;
    parent.remove_file(name)?;
    Ok(())
}

/// iCloud Drive replaces an evicted file with `.<name>.icloud`. That file was
/// not deleted, so its absence must not propagate as a deletion.
fn evicted_by_icloud(root: &Dir, relative: &str) -> Result<bool, AppError> {
    let name = file_name_of(relative)?;
    let parent = match webdav::confined_parent(root, Path::new(relative), false) {
        Ok(parent) => parent,
        Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(false)
        }
        Err(error) => return Err(error),
    };
    match parent.symlink_metadata(format!(".{name}.icloud")) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

async fn ensure_remote_parents(
    client: &Client,
    base_url: &str,
    remote_path: &str,
    auth: &WebDavAuth,
) -> Result<(), AppError> {
    for (index, _) in remote_path.match_indices('/') {
        webdav::create_collection(client, base_url, &remote_path[..index], auth).await?;
    }
    Ok(())
}

async fn fetch_identity(
    client: &Client,
    config: &SyncConfig,
    remote_path: &str,
    auth: &WebDavAuth,
) -> Result<Option<SyncIdentity>, AppError> {
    webdav::get_file_if_exists(
        client,
        &config.webdav_url,
        remote_path,
        auth,
        MAX_IDENTITY_BYTES,
    )
    .await?
    .map(|file| parse_identity(&file.bytes))
    .transpose()
}

async fn remote_identity(
    client: &Client,
    config: &SyncConfig,
    remote_base: &str,
    auth: &WebDavAuth,
) -> Result<Option<SyncIdentity>, AppError> {
    fetch_identity(
        client,
        config,
        &format!("{remote_base}/{LOCAL_IDENTITY_PATH}"),
        auth,
    )
    .await
}

fn legacy_claim_path(project_name: &str) -> String {
    format!("{LEGACY_CLAIMS_DIR}/{project_name}.json")
}

/// Direct children of a collection, or `None` when it does not exist.
async fn remote_children(
    client: &Client,
    config: &SyncConfig,
    remote_path: &str,
    auth: &WebDavAuth,
) -> Result<Option<Vec<(String, bool)>>, AppError> {
    let Some(entries) =
        webdav::list_remote_if_exists(client, &config.webdav_url, remote_path, auth).await?
    else {
        return Ok(None);
    };
    let collection = webdav::remote_url(&config.webdav_url, remote_path)?;
    let mut children = Vec::new();
    for entry in entries {
        let child = webdav::relative_href(&collection, &entry.href)?;
        if child.is_empty() {
            continue;
        }
        if child.contains('/') {
            return Err(AppError::InvalidInput(
                "WebDAV listing escaped requested depth".into(),
            ));
        }
        children.push((child, entry.is_collection));
    }
    Ok(Some(children))
}

/// Missing, or holding nothing but an empty `.novelist` collection.
async fn namespace_is_empty(
    client: &Client,
    config: &SyncConfig,
    remote_base: &str,
    auth: &WebDavAuth,
) -> Result<bool, AppError> {
    let children = remote_children(client, config, remote_base, auth)
        .await?
        .unwrap_or_default();
    Ok(match children.as_slice() {
        [] => true,
        [(name, true)] if name == ".novelist" => {
            remote_children(client, config, &format!("{remote_base}/.novelist"), auth)
                .await?
                .is_none_or(|children| children.is_empty())
        }
        _ => false,
    })
}

async fn legacy_remote_has_data(
    client: &Client,
    config: &SyncConfig,
    project_name: &str,
    auth: &WebDavAuth,
) -> Result<bool, AppError> {
    let root = remote_children(client, config, "", auth)
        .await?
        .unwrap_or_default();
    if !root
        .iter()
        .any(|(name, collection)| name == "novelist" && *collection)
    {
        return Ok(false);
    }
    let projects = remote_children(client, config, "novelist", auth)
        .await?
        .unwrap_or_default();
    if !projects
        .iter()
        .any(|(name, collection)| name == project_name && *collection)
    {
        return Ok(false);
    }
    Ok(
        remote_children(client, config, &format!("novelist/{project_name}"), auth)
            .await?
            .is_some_and(|children| !children.is_empty()),
    )
}

enum NamespaceState {
    Ready,
    /// Another device already continues this legacy project under that ID.
    MigratedElsewhere(String),
}

async fn ensure_remote_identity(
    client: &Client,
    config: &SyncConfig,
    remote_base: &str,
    project_name: &str,
    identity: &SyncIdentity,
    bytes: &[u8],
    auth: &WebDavAuth,
) -> Result<NamespaceState, AppError> {
    if let Some(remote) = remote_identity(client, config, remote_base, auth).await? {
        if remote != *identity {
            return Err(AppError::Custom("Sync identity conflict: remote namespace belongs to a different project; no project files were transferred".into()));
        }
        return Ok(NamespaceState::Ready);
    }
    // An existing namespace without its identity must never be claimed, even
    // when some filenames or bytes happen to match this local project.
    if !namespace_is_empty(client, config, remote_base, auth).await? {
        return Err(AppError::Custom("Sync identity is missing from a non-empty remote namespace. Restore its original .novelist/sync-identity.json from a trusted backup or select the correct project copy; existing remote data was left untouched".into()));
    }
    // This identity was never published. When another device already continues
    // the legacy tree, starting a second namespace would silently split the
    // devices; joining it must be an explicit choice.
    let claim_path = legacy_claim_path(project_name);
    match fetch_identity(client, config, &claim_path, auth).await? {
        Some(claim) if claim == *identity => {}
        Some(claim) => return Ok(NamespaceState::MigratedElsewhere(claim.project_id)),
        None if legacy_remote_has_data(client, config, project_name, auth).await? => {
            if !config.legacy_remote_acknowledged {
                return Err(AppError::Custom(format!(
                    "Legacy WebDAV data exists at novelist/{project_name}, but its project identity cannot be verified. No legacy files were imported, overwritten or deleted. Back up that folder with a WebDAV client, manually copy/reconcile the files belonging to this project into the local project, then enable the legacy-remote acknowledgement in sync settings to start the isolated {remote_base} namespace. Other devices then join that namespace from their sync settings instead of starting their own."
                )));
            }
            ensure_remote_parents(client, &config.webdav_url, &claim_path, auth).await?;
            let published = webdav::put_bytes(
                client,
                &config.webdav_url,
                &claim_path,
                bytes.to_vec(),
                auth,
                webdav::PutCondition::Absent,
            )
            .await;
            // Exactly one device wins the claim; any other one must adopt it.
            match fetch_identity(client, config, &claim_path, auth).await? {
                Some(claim) if claim == *identity => {}
                Some(claim) => return Ok(NamespaceState::MigratedElsewhere(claim.project_id)),
                None => {
                    published?;
                    return Err(AppError::Custom(
                        "Legacy migration claim disappeared while being created".into(),
                    ));
                }
            }
        }
        None => {}
    }
    let remote_path = format!("{remote_base}/{LOCAL_IDENTITY_PATH}");
    ensure_remote_parents(client, &config.webdav_url, &remote_path, auth).await?;
    webdav::put_bytes(
        client,
        &config.webdav_url,
        &remote_path,
        bytes.to_vec(),
        auth,
        webdav::PutCondition::Absent,
    )
    .await?;
    if remote_identity(client, config, remote_base, auth)
        .await?
        .as_ref()
        != Some(identity)
    {
        return Err(AppError::Custom(
            "Sync identity conflict: remote identity changed while being created".into(),
        ));
    }
    Ok(NamespaceState::Ready)
}

enum Transfer {
    Unchanged,
    Uploaded,
    Downloaded,
    DeletedRemote,
    DeletedLocal,
    /// Both sides changed since the common version; neither was touched.
    Conflict,
}

/// Version both sides hold after a file is reconciled.
struct Common {
    hash: String,
    etag: Option<String>,
}

struct RemoteVersion {
    hash: String,
    etag: Option<String>,
    /// `None` when the listing ETag proved the remote equals the baseline.
    bytes: Option<Vec<u8>>,
}

struct SyncSession<'a> {
    root: &'a Dir,
    project: &'a Path,
    client: &'a Client,
    config: &'a SyncConfig,
    remote_base: &'a str,
    identity_hash: &'a str,
    auth: &'a WebDavAuth,
    deleted_dir: &'a Path,
}

async fn settings_guard(
    project: &Path,
    relative: &str,
) -> Result<Option<tokio::sync::OwnedMutexGuard<()>>, AppError> {
    if matches!(
        relative,
        ".novelist/project.toml"
            | ".novelist/literary-study.json"
            | ".novelist/book-translation.json"
    ) {
        Ok(Some(
            crate::commands::settings::acquire_project_settings_guard(project).await?,
        ))
    } else {
        Ok(None)
    }
}

/// Three-way reconciliation against the common version (`baseline`). A side
/// that still equals the baseline takes the other side's change, including a
/// deletion; an edit wins over a deletion; two different edits conflict.
async fn sync_file(
    session: &SyncSession<'_>,
    relative: &str,
    remote_listing: Option<Option<&str>>,
    baseline: Option<&str>,
    baseline_etag: Option<&str>,
) -> Result<(Transfer, Option<Common>), AppError> {
    let SyncSession {
        root,
        project,
        client,
        config,
        remote_base,
        identity_hash,
        auth,
        deleted_dir,
    } = *session;
    let local = optional_local(root, relative)?;
    let local_hash = local.as_deref().map(hash);
    let remote_path = format!("{remote_base}/{relative}");
    let remote = match (remote_listing, baseline) {
        (None, _) => None,
        // The listing still reports the validator received with the baseline,
        // so the remote bytes are the baseline: skip the download.
        (Some(Some(etag)), Some(common)) if baseline_etag == Some(etag) => Some(RemoteVersion {
            hash: common.to_owned(),
            etag: Some(etag.to_owned()),
            bytes: None,
        }),
        (Some(_), _) => {
            let file = webdav::get_file(client, &config.webdav_url, &remote_path, auth).await?;
            Some(RemoteVersion {
                hash: hash(&file.bytes),
                etag: file.etag,
                bytes: Some(file.bytes),
            })
        }
    };
    assert_local_unchanged(root, LOCAL_IDENTITY_PATH, Some(identity_hash))?;
    if let (Some(local_hash), Some(remote)) = (local_hash.as_deref(), remote.as_ref()) {
        if local_hash == remote.hash {
            assert_local_unchanged(root, relative, Some(local_hash))?;
            let common = Common {
                hash: local_hash.to_owned(),
                etag: remote.etag.clone(),
            };
            return Ok((Transfer::Unchanged, Some(common)));
        }
    }
    match (local, local_hash, remote) {
        // Gone on both sides: retire the baseline.
        (None, _, None) => Ok((Transfer::Unchanged, None)),
        // Deleted remotely and unchanged here since the common version.
        (Some(bytes), Some(local_hash), None) if baseline == Some(local_hash.as_str()) => {
            let _settings_guard = settings_guard(project, relative).await?;
            assert_local_unchanged(root, LOCAL_IDENTITY_PATH, Some(identity_hash))?;
            retire_local(root, relative, &bytes, &local_hash, deleted_dir)?;
            Ok((Transfer::DeletedLocal, None))
        }
        // Deleted here and unchanged remotely since the common version.
        (None, _, Some(remote)) if baseline == Some(remote.hash.as_str()) => {
            if evicted_by_icloud(root, relative)? {
                return Err(AppError::Custom("File is evicted to iCloud Drive, not deleted; download it locally before syncing".into()));
            }
            let etag = remote.etag.as_deref().ok_or_else(|| {
                AppError::Custom("Cannot safely delete remote file without a strong ETag".into())
            })?;
            assert_local_unchanged(root, relative, None)?;
            assert_local_unchanged(root, LOCAL_IDENTITY_PATH, Some(identity_hash))?;
            webdav::delete_file_if_match(client, &config.webdav_url, &remote_path, auth, etag)
                .await?;
            Ok((Transfer::DeletedRemote, None))
        }
        // New here, edited here after a remote deletion, or edited only here.
        (Some(bytes), Some(local_hash), remote)
            if remote.is_none()
                || remote.as_ref().map(|version| version.hash.as_str()) == baseline =>
        {
            let condition = match remote.as_ref() {
                None => webdav::PutCondition::Absent,
                Some(version) => {
                    webdav::PutCondition::Matches(version.etag.as_deref().ok_or_else(|| {
                        AppError::Custom(
                            "Cannot safely replace remote file without a strong ETag".into(),
                        )
                    })?)
                }
            };
            ensure_remote_parents(client, &config.webdav_url, &remote_path, auth).await?;
            assert_local_unchanged(root, relative, Some(&local_hash))?;
            assert_local_unchanged(root, LOCAL_IDENTITY_PATH, Some(identity_hash))?;
            let etag = webdav::put_bytes(
                client,
                &config.webdav_url,
                &remote_path,
                bytes,
                auth,
                condition,
            )
            .await?;
            assert_local_unchanged(root, relative, Some(&local_hash))?;
            Ok((
                Transfer::Uploaded,
                Some(Common {
                    hash: local_hash,
                    etag,
                }),
            ))
        }
        // New remotely, edited remotely after a local deletion, or edited only remotely.
        (_, local_hash, Some(remote))
            if local_hash.is_none() || local_hash.as_deref() == baseline =>
        {
            let bytes = remote
                .bytes
                .ok_or_else(|| AppError::Custom("Remote content was not downloaded".into()))?;
            let _settings_guard = settings_guard(project, relative).await?;
            assert_local_unchanged(root, LOCAL_IDENTITY_PATH, Some(identity_hash))?;
            commit_download(root, relative, &bytes, local_hash.as_deref())?;
            Ok((
                Transfer::Downloaded,
                Some(Common {
                    hash: remote.hash,
                    etag: remote.etag,
                }),
            ))
        }
        _ => Ok((Transfer::Conflict, None)),
    }
}

const CONFLICT_MESSAGE: &str = "Conflict: local and remote differ without a common unchanged version; both copies were left untouched. Choose which version to keep";

/// A client that never follows redirects, so credentials stay with the
/// configured host.
pub(crate) fn webdav_client() -> Result<Client, AppError> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(webdav::REQUEST_TIMEOUT)
        .timeout(webdav::REQUEST_TIMEOUT)
        .build()
        .map_err(|_| AppError::Custom("Cannot create WebDAV client".into()))
}

/// Credentials a project's sync sends. A project linked to the cloud account
/// only receives the password stored for exactly the account it was linked
/// to, together with the account lease that must be held while it is used.
/// `held`: a lease the caller already holds (a download); taking a second one
/// could wait forever behind a pending account change.
pub(crate) async fn project_auth(
    config: &SyncConfig,
    held: Option<&cloud::AccountLease>,
) -> Result<(WebDavAuth, Option<cloud::AccountLease>), AppError> {
    if !config.cloud_account {
        let auth = WebDavAuth {
            username: config.username.clone(),
            password: config.password.clone(),
        };
        return Ok((auth, None));
    }
    if let Some(lease) = held {
        if lease.endpoint() != config.webdav_url || lease.auth().username != config.username {
            return Err(AppError::Custom(
                "This project is linked to another cloud account".into(),
            ));
        }
        return Ok((lease.auth().clone(), None));
    }
    let lease = cloud::lease_account(Some((&config.webdav_url, &config.username))).await?;
    Ok((lease.auth().clone(), Some(lease)))
}

async fn webdav_session(
    config: &SyncConfig,
    held: Option<&cloud::AccountLease>,
) -> Result<(Client, WebDavAuth, Option<cloud::AccountLease>), AppError> {
    webdav::remote_url(&config.webdav_url, "")?;
    let client = webdav_client()?;
    let (auth, lease) = project_auth(config, held).await?;
    Ok((client, auth, lease))
}

/// Baselines are meaningful only for one project identity on one account.
fn remote_binding(config: &SyncConfig, project_id: &str) -> Result<String, AppError> {
    let remote_url =
        webdav::remote_url(&config.webdav_url, &format!("{REMOTE_ROOT}/{project_id}"))?;
    Ok(hash(&serde_json::to_vec(&(
        remote_url.as_str(),
        &config.username,
        project_id,
    ))?))
}

fn project_name(project: &Path) -> Result<&str, AppError> {
    project
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::InvalidInput("Project name is not UTF-8".into()))
}

/// One canonical-project lock covers discovery, transfers, and baseline persistence.
pub async fn perform_sync(project_dir: &str) -> Result<SyncStatus, AppError> {
    perform_sync_with(project_dir, None).await
}

/// `held`: the cloud-account lease of a caller that already holds one (see
/// `project_auth`). A linked project's sync stops between files once the
/// account is being changed, keeping the baselines it completed.
pub(crate) async fn perform_sync_with(
    project_dir: &str,
    held: Option<&cloud::AccountLease>,
) -> Result<SyncStatus, AppError> {
    let project = std::fs::canonicalize(project_dir)?;
    let _guard = sync_guard(&project).await?;
    let config = read_sync_config(project_dir)?;
    let mut state = read_sync_state(project_dir)?;
    let mut status = SyncStatus {
        last_sync: state.last_sync_iso.clone(),
        files_uploaded: 0,
        files_downloaded: 0,
        errors: Vec::new(),
        in_progress: false,
        adoptable_project_id: None,
        conflicts: Vec::new(),
    };
    if !config.enabled {
        status.errors.push("Sync is not enabled".into());
        return Ok(status);
    }
    let (client, auth, owned) = webdav_session(&config, held).await?;
    let lease = owned.as_ref().or(held);
    let account_revoked = || lease.is_some_and(cloud::AccountLease::revoked);
    let project_name = project_name(&project)?;
    let root = Dir::open_ambient_dir(&project, ambient_authority())?;
    let (identity, identity_bytes) = project_identity(&root)?;
    let identity_hash = hash(&identity_bytes);
    let remote_base = format!("novelist-sync/{}", identity.project_id);
    let (local_files, skipped) = collect_local_files(&root)?;
    status.errors.extend(
        skipped.iter().map(|relative| {
            format!("Skipped {relative:?}: this filename cannot be synced to WebDAV")
        }),
    );
    match ensure_remote_identity(
        &client,
        &config,
        &remote_base,
        project_name,
        &identity,
        &identity_bytes,
        &auth,
    )
    .await
    {
        Ok(NamespaceState::Ready) => {}
        Ok(NamespaceState::MigratedElsewhere(project_id)) => {
            status.errors.push(format!(
                "Project identity: another device already moved the legacy WebDAV folder novelist/{project_name} to novelist-sync/{project_id}. This copy has a different sync identity, so syncing it would start a separate remote folder and the devices would stop exchanging changes. Join the existing namespace in sync settings. If this is a different project that only shares the folder name, rename the project folder instead."
            ));
            status.adoptable_project_id = Some(project_id);
            return Ok(status);
        }
        Err(error) => {
            status.errors.push(format!("Project identity: {error}"));
            return Ok(status);
        }
    }
    let binding = remote_binding(&config, &identity.project_id)?;
    if state.remote_binding.as_deref() != Some(&binding) {
        state.common_hashes.clear();
        state.remote_etags.clear();
        state.file_mod_times.clear();
        state.remote_binding = Some(binding);
    }
    if account_revoked() {
        status.errors.push(cloud::account_changed().to_string());
        return Ok(status);
    }
    let remote_files =
        match collect_remote_files(&client, &config.webdav_url, &remote_base, &auth).await {
            Ok(files) => files,
            Err(error) => {
                status.errors.push(format!("Remote discovery: {error}"));
                return Ok(status);
            }
        };
    let deleted_dir = sync_dir_for_project(project_dir)?
        .join("deleted")
        .join(run_id());
    let session = SyncSession {
        root: &root,
        project: &project,
        client: &client,
        config: &config,
        remote_base: &remote_base,
        identity_hash: &identity_hash,
        auth: &auth,
        deleted_dir: &deleted_dir,
    };
    let paths: BTreeSet<&String> = local_files.iter().chain(remote_files.keys()).collect();
    // Set when this run ends early; completed baselines are still saved.
    let mut stopped = false;
    for relative in paths {
        if account_revoked() {
            status.errors.push(cloud::account_changed().to_string());
            stopped = true;
            break;
        }
        if let Err(error) = assert_local_unchanged(&root, LOCAL_IDENTITY_PATH, Some(&identity_hash))
        {
            status.errors.push(format!("Project identity: {error}"));
            stopped = true;
            break;
        }
        let result = sync_file(
            &session,
            relative,
            remote_files.get(relative).map(Option::as_deref),
            state.common_hashes.get(relative).map(String::as_str),
            state.remote_etags.get(relative).map(String::as_str),
        )
        .await;
        match result {
            Ok((Transfer::Conflict, _)) => {
                status.conflicts.push(relative.clone());
                status
                    .errors
                    .push(format!("Sync {relative}: {CONFLICT_MESSAGE}"));
            }
            Ok((transfer, common)) => {
                if let Err(error) =
                    assert_local_unchanged(&root, LOCAL_IDENTITY_PATH, Some(&identity_hash))
                {
                    status.errors.push(format!("Project identity: {error}"));
                    stopped = true;
                    break;
                }
                match common {
                    Some(Common { hash, etag }) => {
                        state.common_hashes.insert(relative.clone(), hash);
                        match etag {
                            Some(etag) => state.remote_etags.insert(relative.clone(), etag),
                            None => state.remote_etags.remove(relative),
                        };
                    }
                    None => {
                        state.common_hashes.remove(relative);
                        state.remote_etags.remove(relative);
                    }
                }
                // Never rescan local content to bless edits made during another transfer.
                state.file_mod_times.remove(relative);
                match transfer {
                    Transfer::Uploaded | Transfer::DeletedRemote => status.files_uploaded += 1,
                    Transfer::Downloaded | Transfer::DeletedLocal => status.files_downloaded += 1,
                    Transfer::Unchanged | Transfer::Conflict => {}
                }
            }
            Err(error) => status.errors.push(format!("Sync {relative}: {error}")),
        }
    }
    // Each completed transfer established its baseline; keep those even when a
    // later identity check, request or account change ends this run.
    write_sync_state(project_dir, &state)?;
    if stopped {
        return Ok(status);
    }
    if account_revoked() {
        status.errors.push(cloud::account_changed().to_string());
        return Ok(status);
    }
    if let Err(error) = assert_local_unchanged(&root, LOCAL_IDENTITY_PATH, Some(&identity_hash)) {
        status.errors.push(format!("Project identity: {error}"));
        return Ok(status);
    }
    match remote_identity(&client, &config, &remote_base, &auth).await {
        Ok(Some(remote)) if remote == identity => {}
        Ok(_) => {
            status
                .errors
                .push("Sync identity conflict: remote project identity changed during sync".into());
            return Ok(status);
        }
        Err(error) => {
            status.errors.push(format!("Project identity: {error}"));
            return Ok(status);
        }
    }
    let now = chrono_now_iso();
    state.last_sync_iso = Some(now.clone());
    write_sync_state(project_dir, &state)?;
    status.last_sync = Some(now);
    Ok(status)
}

/// Explicitly join the namespace another device created for this project's
/// legacy tree. Only a local identity that was never published may be
/// replaced; the claim and the namespace's own card must both name `project_id`.
pub async fn adopt_legacy_identity(project_dir: &str, project_id: &str) -> Result<(), AppError> {
    let project = std::fs::canonicalize(project_dir)?;
    let _guard = sync_guard(&project).await?;
    let config = read_sync_config(project_dir)?;
    let (client, auth, _lease) = webdav_session(&config, None).await?;
    let project_name = project_name(&project)?;
    let root = Dir::open_ambient_dir(&project, ambient_authority())?;
    if let Some((local, _)) = read_local_identity(&root)? {
        if local.project_id == project_id {
            return Ok(());
        }
        let local_base = format!("novelist-sync/{}", local.project_id);
        if remote_identity(&client, &config, &local_base, &auth)
            .await?
            .is_some()
            || !namespace_is_empty(&client, &config, &local_base, &auth).await?
        {
            return Err(AppError::Custom(
                "This copy's sync identity already owns remote data; it was not replaced".into(),
            ));
        }
    }
    let claim = fetch_identity(&client, &config, &legacy_claim_path(project_name), &auth)
        .await?
        .ok_or_else(|| {
            AppError::Custom(format!(
                "No device has migrated novelist/{project_name}; nothing to join"
            ))
        })?;
    if claim.project_id != project_id {
        return Err(AppError::Custom(
            "The migrated sync namespace changed; run sync again and review it before joining"
                .into(),
        ));
    }
    let base = format!("novelist-sync/{}", claim.project_id);
    if remote_identity(&client, &config, &base, &auth)
        .await?
        .as_ref()
        != Some(&claim)
    {
        return Err(AppError::Custom(
            "The migrated sync namespace has no matching identity; nothing was changed".into(),
        ));
    }
    let parent = webdav::confined_parent(&root, Path::new(LOCAL_IDENTITY_PATH), true)?;
    publish_identity(&parent, &serde_json::to_vec_pretty(&claim)?, true)
}

/// How to settle a file reported in `SyncStatus.conflicts`.
#[derive(Deserialize, Serialize, Type, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConflictResolution {
    /// Upload this device's copy over the remote one.
    #[serde(rename = "keep_local")]
    Local,
    /// Replace this device's copy with the remote one.
    #[serde(rename = "keep_remote")]
    Remote,
    /// Save the remote copy as a new file next to it, then upload this
    /// device's copy; the next sync shares both.
    #[serde(rename = "keep_both")]
    Both,
}

fn run_id() -> String {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string()
}

fn save_backup(dir: &Path, relative: &str, bytes: &[u8]) -> Result<(), AppError> {
    let path = dir.join(relative);
    std::fs::create_dir_all(
        path.parent()
            .ok_or_else(|| AppError::InvalidInput("Invalid sync filename".into()))?,
    )?;
    atomic_write_state(&path, bytes)
}

/// Store the remote version under a new, unused name beside the original.
fn save_remote_copy(root: &Dir, relative: &str, bytes: &[u8]) -> Result<String, AppError> {
    let path = Path::new(relative);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or_else(|| AppError::InvalidInput("Invalid sync filename".into()))?;
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .ok_or_else(|| AppError::InvalidInput("Invalid sync filename".into()))?;
    let stamp = chrono_now_iso().replace(':', "").replace('T', " ");
    let stamp = stamp.trim_end_matches('Z');
    for attempt in 1..=100 {
        let suffix = if attempt == 1 {
            String::new()
        } else {
            format!(" {attempt}")
        };
        let name = format!("{stem} (remote {stamp}{suffix}).{extension}");
        let copy = match relative.rsplit_once('/') {
            Some((directory, _)) => format!("{directory}/{name}"),
            None => name,
        };
        if optional_local(root, &copy)?.is_some() {
            continue;
        }
        // `None` makes the commit fail rather than replace a file created meanwhile.
        commit_download(root, &copy, bytes, None)?;
        return Ok(copy);
    }
    Err(AppError::Custom(
        "No free name for the remote copy; rename the file first".into(),
    ))
}

/// Settle one conflicted file by explicit choice. The side being replaced is
/// first copied into app data (`conflicts/`), and every write is conditional
/// on exactly the versions just read: local bytes by hash, the remote by its
/// strong ETag. Returns the project-relative path of a kept remote copy.
pub async fn resolve_conflict(
    project_dir: &str,
    relative: &str,
    resolution: ConflictResolution,
) -> Result<Option<String>, AppError> {
    if relative.is_empty()
        || webdav::validate_remote_path(relative).is_err()
        || !is_project_content_path(Path::new(relative))
    {
        return Err(AppError::InvalidInput("Not a syncable project file".into()));
    }
    if resolution == ConflictResolution::Both && relative.starts_with(".novelist/") {
        return Err(AppError::InvalidInput(
            "Project settings cannot be kept twice; keep one version".into(),
        ));
    }
    let project = std::fs::canonicalize(project_dir)?;
    let _guard = sync_guard(&project).await?;
    let config = read_sync_config(project_dir)?;
    if !config.enabled {
        return Err(AppError::Custom("Sync is not enabled".into()));
    }
    let (client, auth, lease) = webdav_session(&config, None).await?;
    let root = Dir::open_ambient_dir(&project, ambient_authority())?;
    let (identity, identity_bytes) = read_local_identity(&root)?
        .ok_or_else(|| AppError::Custom("This project has never been synced".into()))?;
    let identity_hash = hash(&identity_bytes);
    let remote_base = format!("{REMOTE_ROOT}/{}", identity.project_id);
    if remote_identity(&client, &config, &remote_base, &auth)
        .await?
        .as_ref()
        != Some(&identity)
    {
        return Err(AppError::Custom(
            "Sync identity conflict: the remote folder no longer belongs to this project; nothing was changed".into(),
        ));
    }
    let mut state = read_sync_state(project_dir)?;
    if state.remote_binding != Some(remote_binding(&config, &identity.project_id)?) {
        return Err(AppError::Custom(
            "Sync this project with the current account before resolving conflicts".into(),
        ));
    }
    let remote_path = format!("{remote_base}/{relative}");
    let remote = webdav::get_file_if_exists(
        &client,
        &config.webdav_url,
        &remote_path,
        &auth,
        webdav::MAX_FILE_BYTES,
    )
    .await?;
    // A change of account stops here, before anything is written.
    if lease.as_ref().is_some_and(cloud::AccountLease::revoked) {
        return Err(cloud::account_changed());
    }
    let local = optional_local(&root, relative)?;
    let local_hash = local.as_deref().map(hash);
    let backup = sync_dir_for_project(project_dir)?
        .join("conflicts")
        .join(run_id());
    let mut copy = None;
    let common = match (local, local_hash, remote) {
        // Already identical: only the baseline was missing.
        (Some(_), Some(local_hash), Some(remote)) if local_hash == hash(&remote.bytes) => Common {
            hash: local_hash,
            etag: remote.etag,
        },
        (local, local_hash, Some(remote)) if resolution == ConflictResolution::Remote => {
            if let Some(bytes) = &local {
                save_backup(&backup.join("local"), relative, bytes)?;
            }
            let _settings_guard = settings_guard(&project, relative).await?;
            assert_local_unchanged(&root, LOCAL_IDENTITY_PATH, Some(&identity_hash))?;
            commit_download(&root, relative, &remote.bytes, local_hash.as_deref())?;
            Common {
                hash: hash(&remote.bytes),
                etag: remote.etag,
            }
        }
        (_, _, None) if resolution == ConflictResolution::Remote => {
            return Err(AppError::Custom(
                "The remote copy no longer exists; keep this device's copy instead".into(),
            ))
        }
        (Some(bytes), Some(local_hash), remote) => {
            let condition = match &remote {
                None => webdav::PutCondition::Absent,
                Some(file) => {
                    save_backup(&backup.join("remote"), relative, &file.bytes)?;
                    if resolution == ConflictResolution::Both {
                        copy = Some(save_remote_copy(&root, relative, &file.bytes)?);
                    }
                    webdav::PutCondition::Matches(file.etag.as_deref().ok_or_else(|| {
                        AppError::Custom(
                            "Cannot safely replace remote file without a strong ETag".into(),
                        )
                    })?)
                }
            };
            ensure_remote_parents(&client, &config.webdav_url, &remote_path, &auth).await?;
            assert_local_unchanged(&root, relative, Some(&local_hash))?;
            assert_local_unchanged(&root, LOCAL_IDENTITY_PATH, Some(&identity_hash))?;
            let etag = webdav::put_bytes(
                &client,
                &config.webdav_url,
                &remote_path,
                bytes,
                &auth,
                condition,
            )
            .await?;
            Common {
                hash: local_hash,
                etag,
            }
        }
        _ => {
            return Err(AppError::Custom(
                "This device's copy no longer exists; keep the remote copy instead".into(),
            ))
        }
    };
    state.common_hashes.insert(relative.to_owned(), common.hash);
    match common.etag {
        Some(etag) => state.remote_etags.insert(relative.to_owned(), etag),
        None => state.remote_etags.remove(relative),
    };
    state.file_mod_times.remove(relative);
    write_sync_state(project_dir, &state)?;
    Ok(copy)
}

/// Get current time as ISO 8601 string (without external chrono crate)
#[allow(clippy::manual_is_multiple_of)]
fn chrono_now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Convert epoch to ISO 8601 manually
    let secs_per_day = 86400u64;
    let mut days = now / secs_per_day;
    let day_secs = now % secs_per_day;
    let hours = day_secs / 3600;
    let minutes = (day_secs % 3600) / 60;
    let seconds = day_secs % 60;

    let mut year = 1970u64;
    loop {
        let days_in_year =
            if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) {
                366
            } else {
                365
            };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }
    let is_leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let month_days = [
        31,
        if is_leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 0usize;
    while month < 12 && days >= month_days[month] {
        days -= month_days[month];
        month += 1;
    }
    let day = days + 1;
    month += 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::webdav::test_server::DavServer;
    use serial_test::serial;

    struct SyncFixture {
        _data: tempfile::TempDir,
        _project: tempfile::TempDir,
        old_data: Option<std::ffi::OsString>,
        project: String,
        server: DavServer,
        remote_base: String,
    }

    impl SyncFixture {
        fn new() -> Self {
            let data = tempfile::tempdir().unwrap();
            let project_dir = tempfile::tempdir().unwrap();
            let project = project_dir
                .path()
                .canonicalize()
                .unwrap()
                .to_str()
                .unwrap()
                .to_string();
            let old_data = std::env::var_os("NOVELIST_SYNC_DATA_DIR");
            unsafe {
                std::env::set_var("NOVELIST_SYNC_DATA_DIR", data.path());
            }
            let server = DavServer::start();
            let config = SyncConfig {
                enabled: true,
                webdav_url: server.url.clone(),
                username: "test".into(),
                password: "not-a-credential".into(),
                interval_minutes: 30,
                legacy_remote_acknowledged: false,
                cloud_account: false,
            };
            save_sync_config_to_disk(&project, &config).unwrap();
            let root = Dir::open_ambient_dir(&project, ambient_authority()).unwrap();
            let (identity, bytes) = project_identity(&root).unwrap();
            let remote_base = format!("novelist-sync/{}", identity.project_id);
            let fixture = Self {
                _data: data,
                _project: project_dir,
                old_data,
                project,
                server,
                remote_base,
            };
            fixture.remote_write(LOCAL_IDENTITY_PATH, &bytes);
            fixture
        }

        fn remote_path(&self, relative: &str) -> String {
            webdav::remote_url(
                &self.server.url,
                &format!("{}/{relative}", self.remote_base),
            )
            .unwrap()
            .path()
            .to_string()
        }

        fn local_write(&self, relative: &str, bytes: &[u8]) {
            let path = Path::new(&self.project).join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }

        fn remote_write(&self, relative: &str, bytes: &[u8]) {
            self.remote_write_at(&self.remote_base, relative, bytes);
        }

        fn remote_write_at(&self, base: &str, relative: &str, bytes: &[u8]) {
            let path = webdav::remote_url(&self.server.url, &format!("{base}/{relative}"))
                .unwrap()
                .path()
                .to_string();
            let mut state = self.server.state.lock().unwrap();
            for (index, _) in path.match_indices('/').skip(1) {
                state.collections.insert(path[..index].to_string());
            }
            state.files.insert(path, bytes.to_vec());
        }

        fn configure_project(&self, path: &Path) -> String {
            std::fs::create_dir_all(path).unwrap();
            let project = path.canonicalize().unwrap().to_str().unwrap().to_string();
            save_sync_config_to_disk(&project, &read_sync_config(&self.project).unwrap()).unwrap();
            project
        }

        fn project_base(project: &str) -> String {
            let root = Dir::open_ambient_dir(project, ambient_authority()).unwrap();
            format!(
                "novelist-sync/{}",
                project_identity(&root).unwrap().0.project_id
            )
        }

        fn remove_remote_identity(&self) {
            self.server
                .state
                .lock()
                .unwrap()
                .files
                .remove(&self.remote_path(LOCAL_IDENTITY_PATH));
        }
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn same_name_projects_use_distinct_remote_identities() {
        let fixture = SyncFixture::new();
        let first = fixture.configure_project(&fixture._project.path().join("one/Novel"));
        let second = fixture.configure_project(&fixture._project.path().join("two/Novel"));
        std::fs::write(Path::new(&first).join("chapter.md"), b"first project").unwrap();
        std::fs::write(Path::new(&second).join("chapter.md"), b"second project").unwrap();
        for project in [&first, &second] {
            let status = perform_sync(project).await.unwrap();
            assert!(status.errors.is_empty(), "{:?}", status.errors);
            assert_eq!((status.files_uploaded, status.files_downloaded), (1, 0));
        }
        let first_base = SyncFixture::project_base(&first);
        let second_base = SyncFixture::project_base(&second);
        assert_ne!(first_base, second_base);
        fixture.remote_write_at(&first_base, "first-only.md", b"only first");
        let status = perform_sync(&second).await.unwrap();
        assert!(status.errors.is_empty(), "{:?}", status.errors);
        assert!(!Path::new(&second).join("first-only.md").exists());
        let state = fixture.server.state.lock().unwrap();
        for (base, expected) in [
            (&first_base, b"first project".as_slice()),
            (&second_base, b"second project".as_slice()),
        ] {
            let path =
                webdav::remote_url(&fixture.server.url, &format!("{base}/chapter.md")).unwrap();
            assert_eq!(state.files[path.path()], expected);
        }
        assert!(
            state
                .requests
                .iter()
                .filter(|request| request.method == "PUT"
                    && request.path.ends_with(LOCAL_IDENTITY_PATH))
                .all(
                    |request| request.headers.get("if-none-match").map(String::as_str) == Some("*")
                )
        );
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn copied_project_keeps_identity_and_syncs_both_directions() {
        let fixture = SyncFixture::new();
        fixture.local_write("chapter.md", b"baseline");
        assert!(perform_sync(&fixture.project)
            .await
            .unwrap()
            .errors
            .is_empty());
        let destination = tempfile::tempdir().unwrap();
        let copied = fixture.configure_project(&destination.path().join("renamed-project"));
        std::fs::create_dir_all(Path::new(&copied).join(".novelist")).unwrap();
        std::fs::copy(
            Path::new(&fixture.project).join(LOCAL_IDENTITY_PATH),
            Path::new(&copied).join(LOCAL_IDENTITY_PATH),
        )
        .unwrap();
        std::fs::write(Path::new(&copied).join("chapter.md"), b"baseline").unwrap();
        assert_eq!(SyncFixture::project_base(&copied), fixture.remote_base);
        assert!(perform_sync(&copied).await.unwrap().errors.is_empty());
        std::fs::write(Path::new(&copied).join("chapter.md"), b"copied device edit").unwrap();
        fixture.remote_write("remote-only.md", b"from original device");
        let status = perform_sync(&copied).await.unwrap();
        assert!(status.errors.is_empty(), "{:?}", status.errors);
        assert_eq!((status.files_uploaded, status.files_downloaded), (1, 1));
        assert_eq!(
            std::fs::read(Path::new(&copied).join("remote-only.md")).unwrap(),
            b"from original device"
        );
        assert_eq!(
            fixture.server.state.lock().unwrap().files[&fixture.remote_path("chapter.md")],
            b"copied device edit"
        );
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn legacy_data_requires_explicit_manual_migration_and_is_never_modified() {
        let fixture = SyncFixture::new();
        fixture.remove_remote_identity();
        let legacy_base = format!(
            "novelist/{}",
            Path::new(&fixture.project)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
        );
        fixture.remote_write_at(&legacy_base, "old-only.md", b"legacy content");
        fixture.local_write("chapter.md", b"local content");
        let identity =
            std::fs::read(Path::new(&fixture.project).join(LOCAL_IDENTITY_PATH)).unwrap();
        for _ in 0..2 {
            let status = perform_sync(&fixture.project).await.unwrap();
            assert_eq!((status.files_uploaded, status.files_downloaded), (0, 0));
            assert!(status
                .errors
                .iter()
                .any(|error| error.contains("Legacy WebDAV data")
                    && error.contains("Back up")
                    && error.contains("acknowledgement")));
            assert!(!Path::new(&fixture.project).join("old-only.md").exists());
            assert!(!fixture
                .server
                .state
                .lock()
                .unwrap()
                .files
                .contains_key(&fixture.remote_path(LOCAL_IDENTITY_PATH)));
            assert!(read_sync_state(&fixture.project)
                .unwrap()
                .last_sync_iso
                .is_none());
        }
        // The user reviews and explicitly copies the correct legacy data locally.
        fixture.local_write("old-only.md", b"legacy content");
        let mut config = read_sync_config(&fixture.project).unwrap();
        config.legacy_remote_acknowledged = true;
        save_sync_config_to_disk(&fixture.project, &config).unwrap();
        let status = perform_sync(&fixture.project).await.unwrap();
        assert!(status.errors.is_empty(), "{:?}", status.errors);
        assert_eq!((status.files_uploaded, status.files_downloaded), (2, 0));
        assert_eq!(
            std::fs::read(Path::new(&fixture.project).join(LOCAL_IDENTITY_PATH)).unwrap(),
            identity
        );
        let legacy_path =
            webdav::remote_url(&fixture.server.url, &format!("{legacy_base}/old-only.md")).unwrap();
        let state = fixture.server.state.lock().unwrap();
        assert_eq!(state.files[legacy_path.path()], b"legacy content");
        assert_eq!(
            state.files[&fixture.remote_path("old-only.md")],
            b"legacy content"
        );
        assert!(!state.requests.iter().any(|request| request
            .path
            .starts_with(legacy_path.path().rsplit_once('/').unwrap().0)
            && matches!(request.method.as_str(), "GET" | "PUT" | "DELETE")));
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn empty_legacy_collection_does_not_require_acknowledgement() {
        let fixture = SyncFixture::new();
        fixture.remove_remote_identity();
        let legacy_base = format!(
            "novelist/{}",
            Path::new(&fixture.project)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
        );
        fixture.remote_write_at(&legacy_base, "placeholder.md", b"");
        let placeholder = webdav::remote_url(
            &fixture.server.url,
            &format!("{legacy_base}/placeholder.md"),
        )
        .unwrap();
        fixture
            .server
            .state
            .lock()
            .unwrap()
            .files
            .remove(placeholder.path());
        fixture.local_write("chapter.md", b"new project");
        let status = perform_sync(&fixture.project).await.unwrap();
        assert!(status.errors.is_empty(), "{:?}", status.errors);
        assert_eq!(status.files_uploaded, 1);
        assert!(
            !read_sync_config(&fixture.project)
                .unwrap()
                .legacy_remote_acknowledged
        );
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn remote_identity_conflict_and_missing_marker_fail_closed() {
        let fixture = SyncFixture::new();
        fixture.local_write("local.md", b"local");
        fixture.remote_write("remote.md", b"remote");
        let mut conflicting = parse_identity(
            &std::fs::read(Path::new(&fixture.project).join(LOCAL_IDENTITY_PATH)).unwrap(),
        )
        .unwrap();
        let replacement = if conflicting.project_id.starts_with('0') {
            "1"
        } else {
            "0"
        };
        conflicting.project_id.replace_range(..1, replacement);
        fixture.remote_write(
            LOCAL_IDENTITY_PATH,
            &serde_json::to_vec(&conflicting).unwrap(),
        );
        for missing in [false, true] {
            if missing {
                fixture.remove_remote_identity();
            }
            fixture.server.state.lock().unwrap().requests.clear();
            let before = fixture.server.state.lock().unwrap().files.clone();
            let status = perform_sync(&fixture.project).await.unwrap();
            assert_eq!((status.files_uploaded, status.files_downloaded), (0, 0));
            assert!(!status.errors.is_empty());
            assert!(!Path::new(&fixture.project).join("remote.md").exists());
            let state = fixture.server.state.lock().unwrap();
            assert_eq!(state.files, before);
            assert!(!state
                .requests
                .iter()
                .any(|request| matches!(request.method.as_str(), "PUT" | "DELETE")));
        }
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn identity_sidecars_are_bounded_and_contain_no_credentials() {
        let fixture = SyncFixture::new();
        let local = std::fs::read(Path::new(&fixture.project).join(LOCAL_IDENTITY_PATH)).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&local).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 2);
        assert!(json.get("project_id").is_some());
        assert!(!String::from_utf8_lossy(&local).contains("not-a-credential"));
        assert_eq!(
            fixture.server.state.lock().unwrap().files[&fixture.remote_path(LOCAL_IDENTITY_PATH)],
            local
        );
        fixture.remote_write(LOCAL_IDENTITY_PATH, &vec![b' '; MAX_IDENTITY_BYTES + 1]);
        fixture.local_write("chapter.md", b"must not upload");
        let status = perform_sync(&fixture.project).await.unwrap();
        assert!(status
            .errors
            .iter()
            .any(|error| error.contains("size limit")));
        assert_eq!((status.files_uploaded, status.files_downloaded), (0, 0));
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn legacy_baselines_cannot_authorize_new_namespace_overwrites() {
        let fixture = SyncFixture::new();
        fixture.local_write("chapter.md", b"local version");
        fixture.remote_write("chapter.md", b"remote version");
        let mut legacy = SyncState::default();
        legacy
            .common_hashes
            .insert("chapter.md".into(), hash(b"remote version"));
        write_sync_state(&fixture.project, &legacy).unwrap();
        let status = perform_sync(&fixture.project).await.unwrap();
        assert!(status.errors.iter().any(|error| error.contains("Conflict")));
        assert_eq!((status.files_uploaded, status.files_downloaded), (0, 0));
        assert_eq!(
            fixture.server.state.lock().unwrap().files[&fixture.remote_path("chapter.md")],
            b"remote version"
        );
        assert!(read_sync_state(&fixture.project)
            .unwrap()
            .common_hashes
            .is_empty());
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn local_identity_changed_during_get_blocks_download_and_baseline_commit() {
        let fixture = SyncFixture::new();
        fixture.local_write("chapter.md", b"baseline");
        assert!(perform_sync(&fixture.project)
            .await
            .unwrap()
            .errors
            .is_empty());
        let baseline = read_sync_state(&fixture.project).unwrap().common_hashes;
        fixture.remote_write("chapter.md", b"remote edit");
        let identity_path = Path::new(&fixture.project).join(LOCAL_IDENTITY_PATH);
        let mut identity = parse_identity(&std::fs::read(&identity_path).unwrap()).unwrap();
        let replacement = if identity.project_id.starts_with('0') {
            "1"
        } else {
            "0"
        };
        identity.project_id.replace_range(..1, replacement);
        fixture.server.state.lock().unwrap().edit_local = Some((
            "GET".into(),
            fixture.remote_path("chapter.md"),
            identity_path,
            serde_json::to_vec(&identity).unwrap(),
        ));
        let status = perform_sync(&fixture.project).await.unwrap();
        assert!(!status.errors.is_empty());
        assert_eq!((status.files_uploaded, status.files_downloaded), (0, 0));
        assert_eq!(
            std::fs::read(Path::new(&fixture.project).join("chapter.md")).unwrap(),
            b"baseline"
        );
        assert_eq!(
            read_sync_state(&fixture.project).unwrap().common_hashes,
            baseline
        );
    }

    #[test]
    fn legacy_sync_config_defaults_to_unacknowledged() {
        let config: SyncConfig = serde_json::from_str(r#"{"enabled":true,"webdav_url":"https://example.com","username":"user","password":"secret","interval_minutes":30}"#).unwrap();
        assert!(!config.legacy_remote_acknowledged);
    }

    #[cfg(unix)]
    #[test]
    fn identity_creation_never_follows_symlinks_or_replaces_invalid_identity() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), project.path().join(".novelist")).unwrap();
        let root = Dir::open_ambient_dir(project.path(), ambient_authority()).unwrap();
        assert!(project_identity(&root).is_err());
        assert!(!outside.path().join("sync-identity.json").exists());
        std::fs::remove_file(project.path().join(".novelist")).unwrap();
        std::fs::create_dir(project.path().join(".novelist")).unwrap();
        std::fs::write(outside.path().join("sync-identity.json"), b"outside").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("sync-identity.json"),
            project.path().join(LOCAL_IDENTITY_PATH),
        )
        .unwrap();
        assert!(project_identity(&root).is_err());
        assert_eq!(
            std::fs::read(outside.path().join("sync-identity.json")).unwrap(),
            b"outside"
        );
        std::fs::remove_file(project.path().join(LOCAL_IDENTITY_PATH)).unwrap();
        std::fs::write(
            project.path().join(LOCAL_IDENTITY_PATH),
            b"damaged identity",
        )
        .unwrap();
        assert!(project_identity(&root).is_err());
        assert_eq!(
            std::fs::read(project.path().join(LOCAL_IDENTITY_PATH)).unwrap(),
            b"damaged identity"
        );
    }

    impl Drop for SyncFixture {
        fn drop(&mut self) {
            unsafe {
                if let Some(old) = &self.old_data {
                    std::env::set_var("NOVELIST_SYNC_DATA_DIR", old);
                } else {
                    std::env::remove_var("NOVELIST_SYNC_DATA_DIR");
                }
            }
        }
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn unresolved_conflict_survives_two_sync_passes_and_preserves_both_sides() {
        let fixture = SyncFixture::new();
        fixture.local_write("chapter.md", b"baseline");
        fixture.remote_write("chapter.md", b"baseline");
        assert!(perform_sync(&fixture.project)
            .await
            .unwrap()
            .errors
            .is_empty());
        let baseline = read_sync_state(&fixture.project).unwrap().common_hashes;
        fixture.local_write("chapter.md", b"local edit");
        fixture.remote_write("chapter.md", b"remote edit");
        for _ in 0..2 {
            let status = perform_sync(&fixture.project).await.unwrap();
            assert_eq!(status.files_uploaded, 0);
            assert_eq!(status.files_downloaded, 0);
            assert!(status
                .errors
                .iter()
                .any(|error| error.contains("Conflict") && error.contains("chapter.md")));
            assert_eq!(
                std::fs::read(Path::new(&fixture.project).join("chapter.md")).unwrap(),
                b"local edit"
            );
            assert_eq!(
                fixture.server.state.lock().unwrap().files[&fixture.remote_path("chapter.md")],
                b"remote edit"
            );
            assert_eq!(
                read_sync_state(&fixture.project).unwrap().common_hashes,
                baseline
            );
        }
        // Explicitly making the two versions equal resolves the conflict.
        fixture.local_write("chapter.md", b"remote edit");
        assert!(perform_sync(&fixture.project)
            .await
            .unwrap()
            .errors
            .is_empty());
        assert_eq!(
            read_sync_state(&fixture.project).unwrap().common_hashes["chapter.md"],
            hash(b"remote edit")
        );
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn nested_cjk_product_documents_and_metadata_sync_both_directions() {
        let fixture = SyncFixture::new();
        fixture.local_write("卷一/角色#%/人物.canvas", b"canvas");
        fixture.local_write(".novelist/project.toml", b"name = 'novel'");
        fixture.local_write(".novelist/credentials.json", b"never upload");
        fixture.remote_write("卷二/章节#%/第一章.litstudy", b"study");
        fixture.remote_write("卷二/章节#%/计划.kanban", b"board");
        fixture.remote_write(".novelist/literary-study.json", b"{}");
        fixture.remote_write(".novelist/publish.json", b"never download");
        let first = perform_sync(&fixture.project).await.unwrap();
        assert!(first.errors.is_empty(), "{:?}", first.errors);
        assert_eq!(first.files_uploaded, 2);
        assert_eq!(first.files_downloaded, 3);
        assert_eq!(
            std::fs::read(Path::new(&fixture.project).join("卷二/章节#%/第一章.litstudy")).unwrap(),
            b"study"
        );
        assert!(!Path::new(&fixture.project)
            .join(".novelist/publish.json")
            .exists());
        assert!(!fixture
            .server
            .state
            .lock()
            .unwrap()
            .files
            .contains_key(&fixture.remote_path(".novelist/credentials.json")));
        let second = perform_sync(&fixture.project).await.unwrap();
        assert!(second.errors.is_empty(), "{:?}", second.errors);
        assert_eq!((second.files_uploaded, second.files_downloaded), (0, 0));
        fixture.local_write("卷一/角色#%/人物.canvas", b"edited canvas");
        fixture.remote_write("卷二/章节#%/第一章.litstudy", b"edited study");
        let third = perform_sync(&fixture.project).await.unwrap();
        assert!(third.errors.is_empty(), "{:?}", third.errors);
        assert_eq!((third.files_uploaded, third.files_downloaded), (1, 1));
        assert_eq!(
            std::fs::read(Path::new(&fixture.project).join("卷二/章节#%/第一章.litstudy")).unwrap(),
            b"edited study"
        );
        assert_eq!(
            fixture.server.state.lock().unwrap().files
                [&fixture.remote_path("卷一/角色#%/人物.canvas")],
            b"edited canvas"
        );
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn failed_transfer_preserves_baseline_and_retries_without_blessing_local_edits() {
        let fixture = SyncFixture::new();
        fixture.local_write("chapter.md", b"baseline");
        fixture.remote_write("chapter.md", b"baseline");
        perform_sync(&fixture.project).await.unwrap();
        fixture.local_write("chapter.md", b"to upload");
        let remote = fixture.remote_path("chapter.md");
        fixture
            .server
            .state
            .lock()
            .unwrap()
            .fail
            .insert(("PUT".into(), remote.clone()));
        for _ in 0..2 {
            assert!(!perform_sync(&fixture.project)
                .await
                .unwrap()
                .errors
                .is_empty());
            assert_eq!(
                read_sync_state(&fixture.project).unwrap().common_hashes["chapter.md"],
                hash(b"baseline")
            );
            assert_eq!(
                fixture.server.state.lock().unwrap().files[&remote],
                b"baseline"
            );
        }
        fixture.server.state.lock().unwrap().fail.clear();
        fixture.server.state.lock().unwrap().edit_local = Some((
            "PUT".into(),
            remote.clone(),
            Path::new(&fixture.project).join("chapter.md"),
            b"edited during transfer".to_vec(),
        ));
        assert!(!perform_sync(&fixture.project)
            .await
            .unwrap()
            .errors
            .is_empty());
        assert_eq!(
            read_sync_state(&fixture.project).unwrap().common_hashes["chapter.md"],
            hash(b"baseline")
        );
        assert_eq!(
            fixture.server.state.lock().unwrap().files[&remote],
            b"to upload"
        );
        assert_eq!(
            std::fs::read(Path::new(&fixture.project).join("chapter.md")).unwrap(),
            b"edited during transfer"
        );
        assert!(!perform_sync(&fixture.project)
            .await
            .unwrap()
            .errors
            .is_empty());
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn download_does_not_overwrite_an_edit_made_during_get() {
        let fixture = SyncFixture::new();
        fixture.local_write("chapter.md", b"baseline");
        fixture.remote_write("chapter.md", b"baseline");
        perform_sync(&fixture.project).await.unwrap();
        fixture.remote_write("chapter.md", b"remote edit");
        fixture.server.state.lock().unwrap().edit_local = Some((
            "GET".into(),
            fixture.remote_path("chapter.md"),
            Path::new(&fixture.project).join("chapter.md"),
            b"late local edit".to_vec(),
        ));
        assert!(!perform_sync(&fixture.project)
            .await
            .unwrap()
            .errors
            .is_empty());
        assert_eq!(
            std::fs::read(Path::new(&fixture.project).join("chapter.md")).unwrap(),
            b"late local edit"
        );
        assert_eq!(
            read_sync_state(&fixture.project).unwrap().common_hashes["chapter.md"],
            hash(b"baseline")
        );
    }

    #[cfg(unix)]
    #[test]
    fn local_discovery_and_download_reject_symlink_ancestors() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("chapter.md"), b"outside").unwrap();
        std::os::unix::fs::symlink(outside.path(), project.path().join("linked")).unwrap();
        let root = Dir::open_ambient_dir(project.path(), ambient_authority()).unwrap();
        assert!(collect_local_files(&root).is_err());
        assert!(commit_download(&root, "linked/chapter.md", b"remote", None).is_err());
        assert_eq!(
            std::fs::read(outside.path().join("chapter.md")).unwrap(),
            b"outside"
        );
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn stalled_sync_request_times_out_and_releases_project_lock() {
        let fixture = SyncFixture::new();
        fixture.local_write("chapter.md", b"baseline");
        fixture.remote_write("chapter.md", b"baseline");
        let remote = fixture.remote_path("chapter.md");
        fixture
            .server
            .state
            .lock()
            .unwrap()
            .stall
            .insert(("GET".into(), remote));
        let status =
            tokio::time::timeout(webdav::REQUEST_TIMEOUT * 3, perform_sync(&fixture.project))
                .await
                .expect("stalled request must finish before outer watchdog")
                .unwrap();
        assert!(!status.errors.is_empty());
        assert!(read_sync_state(&fixture.project)
            .unwrap()
            .common_hashes
            .is_empty());
        fixture.server.state.lock().unwrap().stall.clear();
        let retried =
            tokio::time::timeout(webdav::REQUEST_TIMEOUT * 3, perform_sync(&fixture.project))
                .await
                .expect("sync lock must be usable after timeout")
                .unwrap();
        assert!(retried.errors.is_empty(), "{:?}", retried.errors);
        assert_eq!(
            read_sync_state(&fixture.project).unwrap().common_hashes["chapter.md"],
            hash(b"baseline")
        );
    }

    fn remote_has(fixture: &SyncFixture, relative: &str) -> bool {
        fixture
            .server
            .state
            .lock()
            .unwrap()
            .files
            .contains_key(&fixture.remote_path(relative))
    }

    fn acknowledge_legacy(project: &str) {
        let mut config = read_sync_config(project).unwrap();
        config.legacy_remote_acknowledged = true;
        save_sync_config_to_disk(project, &config).unwrap();
    }

    async fn clean_sync(project: &str) -> SyncStatus {
        let status = perform_sync(project).await.unwrap();
        assert!(status.errors.is_empty(), "{:?}", status.errors);
        status
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn local_deletion_removes_the_unchanged_remote_copy() {
        let fixture = SyncFixture::new();
        fixture.local_write("chapter.md", b"baseline");
        fixture.local_write("keep.md", b"keep");
        clean_sync(&fixture.project).await;
        std::fs::remove_file(Path::new(&fixture.project).join("chapter.md")).unwrap();

        let status = clean_sync(&fixture.project).await;
        assert_eq!((status.files_uploaded, status.files_downloaded), (1, 0));
        assert!(!remote_has(&fixture, "chapter.md"));
        assert!(remote_has(&fixture, "keep.md"));
        {
            let state = fixture.server.state.lock().unwrap();
            let delete = state
                .requests
                .iter()
                .find(|request| request.method == "DELETE")
                .unwrap();
            // Conditional on the version the baseline recorded.
            assert_eq!(
                delete.headers["if-match"],
                format!("\"{}\"", hash(b"baseline"))
            );
        }
        let saved = read_sync_state(&fixture.project).unwrap();
        assert!(!saved.common_hashes.contains_key("chapter.md"));
        assert!(!saved.remote_etags.contains_key("chapter.md"));
        // Nothing comes back on later syncs.
        let status = clean_sync(&fixture.project).await;
        assert_eq!((status.files_uploaded, status.files_downloaded), (0, 0));
        assert!(!Path::new(&fixture.project).join("chapter.md").exists());
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn remote_deletion_retires_the_unchanged_local_copy_recoverably() {
        let fixture = SyncFixture::new();
        fixture.local_write("卷一/chapter.md", b"baseline");
        clean_sync(&fixture.project).await;
        fixture
            .server
            .state
            .lock()
            .unwrap()
            .files
            .remove(&fixture.remote_path("卷一/chapter.md"));

        let status = clean_sync(&fixture.project).await;
        assert_eq!((status.files_uploaded, status.files_downloaded), (0, 1));
        assert!(!Path::new(&fixture.project).join("卷一/chapter.md").exists());
        assert!(!read_sync_state(&fixture.project)
            .unwrap()
            .common_hashes
            .contains_key("卷一/chapter.md"));
        let deleted = sync_dir_for_project(&fixture.project)
            .unwrap()
            .join("deleted");
        let runs: Vec<_> = std::fs::read_dir(&deleted)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(runs.len(), 1);
        assert_eq!(
            std::fs::read(runs[0].join("卷一/chapter.md")).unwrap(),
            b"baseline"
        );
        assert!(!remote_has(&fixture, "卷一/chapter.md"));
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn edits_win_over_deletions_on_the_other_side() {
        let fixture = SyncFixture::new();
        fixture.local_write("a.md", b"a0");
        fixture.local_write("b.md", b"b0");
        clean_sync(&fixture.project).await;
        // a: edited here, deleted remotely. b: edited remotely, deleted here.
        fixture.local_write("a.md", b"a1");
        fixture
            .server
            .state
            .lock()
            .unwrap()
            .files
            .remove(&fixture.remote_path("a.md"));
        fixture.remote_write("b.md", b"b1");
        std::fs::remove_file(Path::new(&fixture.project).join("b.md")).unwrap();

        let status = clean_sync(&fixture.project).await;
        assert_eq!((status.files_uploaded, status.files_downloaded), (1, 1));
        assert_eq!(
            fixture.server.state.lock().unwrap().files[&fixture.remote_path("a.md")],
            b"a1"
        );
        assert_eq!(
            std::fs::read(Path::new(&fixture.project).join("b.md")).unwrap(),
            b"b1"
        );
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn rename_propagates_to_another_device_without_resurrecting_the_old_name() {
        let fixture = SyncFixture::new();
        let device_a = fixture.project.clone();
        fixture.local_write("Untitled 1.md", "# 第一章\n".as_bytes());
        clean_sync(&device_a).await;
        let destination = tempfile::tempdir().unwrap();
        let device_b = fixture.configure_project(&destination.path().join("novel"));
        std::fs::create_dir_all(Path::new(&device_b).join(".novelist")).unwrap();
        std::fs::copy(
            Path::new(&device_a).join(LOCAL_IDENTITY_PATH),
            Path::new(&device_b).join(LOCAL_IDENTITY_PATH),
        )
        .unwrap();
        std::fs::write(Path::new(&device_b).join("Untitled 1.md"), "# 第一章\n").unwrap();
        clean_sync(&device_b).await;

        // Managed-name rename from the first heading on device A.
        std::fs::rename(
            Path::new(&device_a).join("Untitled 1.md"),
            Path::new(&device_a).join("第一章.md"),
        )
        .unwrap();
        let status = clean_sync(&device_a).await;
        assert_eq!((status.files_uploaded, status.files_downloaded), (2, 0));
        assert!(!remote_has(&fixture, "Untitled 1.md"));
        assert!(remote_has(&fixture, "第一章.md"));

        let status = clean_sync(&device_b).await;
        assert_eq!((status.files_uploaded, status.files_downloaded), (0, 2));
        assert!(!Path::new(&device_b).join("Untitled 1.md").exists());
        assert_eq!(
            std::fs::read_to_string(Path::new(&device_b).join("第一章.md")).unwrap(),
            "# 第一章\n"
        );
        for device in [&device_a, &device_b] {
            let status = clean_sync(device).await;
            assert_eq!((status.files_uploaded, status.files_downloaded), (0, 0));
            assert!(!Path::new(device).join("Untitled 1.md").exists());
        }
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn baselines_from_completed_transfers_survive_a_late_identity_failure() {
        let fixture = SyncFixture::new();
        fixture.local_write("a.md", b"a");
        // The opening identity GET succeeds; the closing one fails.
        fixture
            .server
            .state
            .lock()
            .unwrap()
            .fail_after
            .insert(("GET".into(), fixture.remote_path(LOCAL_IDENTITY_PATH)), 1);
        let status = perform_sync(&fixture.project).await.unwrap();
        assert!(
            status
                .errors
                .iter()
                .any(|error| error.contains("Project identity")),
            "{:?}",
            status.errors
        );
        assert_eq!(status.files_uploaded, 1);
        let saved = read_sync_state(&fixture.project).unwrap();
        assert_eq!(saved.common_hashes["a.md"], hash(b"a"));
        assert!(saved.last_sync_iso.is_none());

        // A later local edit uploads against that baseline instead of conflicting.
        fixture.server.state.lock().unwrap().fail_after.clear();
        fixture.local_write("a.md", b"a2");
        let status = clean_sync(&fixture.project).await;
        assert_eq!(status.files_uploaded, 1);
        assert_eq!(
            fixture.server.state.lock().unwrap().files[&fixture.remote_path("a.md")],
            b"a2"
        );
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn baselines_before_a_mid_run_identity_change_are_kept() {
        let fixture = SyncFixture::new();
        fixture.local_write("a.md", b"a");
        fixture.local_write("b.md", b"b");
        let identity_path = Path::new(&fixture.project).join(LOCAL_IDENTITY_PATH);
        let mut changed = parse_identity(&std::fs::read(&identity_path).unwrap()).unwrap();
        changed.project_id = "0".repeat(64);
        fixture.server.state.lock().unwrap().edit_local = Some((
            "PUT".into(),
            fixture.remote_path("b.md"),
            identity_path,
            serde_json::to_vec(&changed).unwrap(),
        ));
        let status = perform_sync(&fixture.project).await.unwrap();
        assert!(
            status
                .errors
                .iter()
                .any(|error| error.contains("Project identity")),
            "{:?}",
            status.errors
        );
        let saved = read_sync_state(&fixture.project).unwrap();
        assert_eq!(saved.common_hashes.get("a.md"), Some(&hash(b"a")));
        assert!(!saved.common_hashes.contains_key("b.md"));
    }

    // Windows cannot create control-character file names, so the case cannot
    // occur there.
    #[cfg(unix)]
    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn unsyncable_filenames_are_skipped_without_stopping_sync() {
        let fixture = SyncFixture::new();
        fixture.local_write("good.md", b"good");
        // macOS folder-icon file: not project content, so silently ignored.
        fixture.local_write("Icon\r", b"");
        fixture.local_write("bad\u{1}name.md", b"bad");
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::ffi::OsStrExt;
            let name = std::ffi::OsStr::from_bytes(b"gbk-\xd5\xc2.md");
            std::fs::write(Path::new(&fixture.project).join(name), b"gbk").unwrap();
        }
        let status = perform_sync(&fixture.project).await.unwrap();
        assert_eq!(status.files_uploaded, 1);
        assert!(remote_has(&fixture, "good.md"));
        let expected_skips = if cfg!(target_os = "linux") { 2 } else { 1 };
        assert_eq!(status.errors.len(), expected_skips, "{:?}", status.errors);
        assert!(status
            .errors
            .iter()
            .all(|error| error.starts_with("Skipped")));
        assert!(status.errors.iter().any(|error| error.contains("bad")));
        assert!(status.last_sync.is_some());
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn unchanged_remote_files_are_not_downloaded_again() {
        let fixture = SyncFixture::new();
        fixture.local_write("chapter.md", b"local");
        fixture.remote_write("remote.md", b"remote");
        let status = clean_sync(&fixture.project).await;
        assert_eq!((status.files_uploaded, status.files_downloaded), (1, 1));
        fixture.server.state.lock().unwrap().requests.clear();

        let status = clean_sync(&fixture.project).await;
        assert_eq!((status.files_uploaded, status.files_downloaded), (0, 0));
        let gets = |fixture: &SyncFixture, relative: &str| {
            let path = fixture.remote_path(relative);
            fixture
                .server
                .state
                .lock()
                .unwrap()
                .requests
                .iter()
                .filter(|request| request.method == "GET" && request.path == path)
                .count()
        };
        assert_eq!(gets(&fixture, "chapter.md"), 0);
        assert_eq!(gets(&fixture, "remote.md"), 0);

        // A changed listing ETag is downloaded again.
        fixture.remote_write("remote.md", b"remote edit");
        let status = clean_sync(&fixture.project).await;
        assert_eq!((status.files_uploaded, status.files_downloaded), (0, 1));
        assert_eq!(gets(&fixture, "remote.md"), 1);
        assert_eq!(
            std::fs::read(Path::new(&fixture.project).join("remote.md")).unwrap(),
            b"remote edit"
        );
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn second_device_must_adopt_the_namespace_that_migrated_its_legacy_tree() {
        let fixture = SyncFixture::new();
        let parent_a = tempfile::tempdir().unwrap();
        let parent_b = tempfile::tempdir().unwrap();
        let device_a = fixture.configure_project(&parent_a.path().join("Novel"));
        let device_b = fixture.configure_project(&parent_b.path().join("Novel"));
        fixture.remote_write_at("novelist/Novel", "chapter.md", b"legacy");
        std::fs::write(Path::new(&device_a).join("chapter.md"), b"legacy").unwrap();
        std::fs::write(Path::new(&device_b).join("chapter.md"), b"legacy").unwrap();
        std::fs::write(Path::new(&device_b).join("notes.md"), b"from device b").unwrap();

        // Device A acknowledges the legacy tree and migrates first.
        acknowledge_legacy(&device_a);
        assert_eq!(clean_sync(&device_a).await.files_uploaded, 1);
        let base_a = SyncFixture::project_base(&device_a);
        let id_a = base_a.strip_prefix("novelist-sync/").unwrap().to_string();

        // Device B is stopped and offered A's namespace, even after acknowledging.
        acknowledge_legacy(&device_b);
        let base_b = SyncFixture::project_base(&device_b);
        assert_ne!(base_a, base_b);
        for _ in 0..2 {
            let status = perform_sync(&device_b).await.unwrap();
            assert_eq!(status.adoptable_project_id.as_deref(), Some(id_a.as_str()));
            assert_eq!((status.files_uploaded, status.files_downloaded), (0, 0));
            assert!(
                status
                    .errors
                    .iter()
                    .any(|error| error.contains("another device")),
                "{:?}",
                status.errors
            );
            let state = fixture.server.state.lock().unwrap();
            assert!(!state.files.keys().any(|path| path.contains(&base_b)));
        }

        // Joining is explicit; a copy whose identity already owns data refuses.
        assert!(adopt_legacy_identity(&device_a, &"0".repeat(64))
            .await
            .is_err());
        assert!(adopt_legacy_identity(&device_b, &"0".repeat(64))
            .await
            .is_err());
        adopt_legacy_identity(&device_b, &id_a).await.unwrap();
        assert_eq!(SyncFixture::project_base(&device_b), base_a);

        let status = clean_sync(&device_b).await;
        assert!(status.adoptable_project_id.is_none());
        assert_eq!((status.files_uploaded, status.files_downloaded), (1, 0));
        let status = clean_sync(&device_a).await;
        assert_eq!((status.files_uploaded, status.files_downloaded), (0, 1));
        assert_eq!(
            std::fs::read(Path::new(&device_a).join("notes.md")).unwrap(),
            b"from device b"
        );
    }

    #[test]
    fn identity_creation_is_atomic_and_never_replaces_an_existing_card() {
        let project = tempfile::tempdir().unwrap();
        let sidecar = project.path().join(".novelist");
        std::fs::create_dir(&sidecar).unwrap();
        // An interrupted creation leaves only a staged file, never a partial card,
        // so the next attempt is not blocked by "restore the original identity".
        std::fs::write(sidecar.join(".sync-identity-1-0.tmp"), b"{\"schema_ver").unwrap();
        let root = Dir::open_ambient_dir(project.path(), ambient_authority()).unwrap();
        let (identity, bytes) = project_identity(&root).unwrap();
        assert_eq!(
            std::fs::read(project.path().join(LOCAL_IDENTITY_PATH)).unwrap(),
            bytes
        );

        let other = SyncIdentity {
            schema_version: 1,
            project_id: "0".repeat(64),
        };
        let parent = webdav::confined_parent(&root, Path::new(LOCAL_IDENTITY_PATH), false).unwrap();
        publish_identity(&parent, &serde_json::to_vec_pretty(&other).unwrap(), false).unwrap();
        assert_eq!(project_identity(&root).unwrap().0, identity);
        let staged: Vec<String> = std::fs::read_dir(&sidecar)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.starts_with(".sync-identity-") && name != ".sync-identity-1-0.tmp")
            .collect();
        assert!(staged.is_empty(), "{staged:?}");
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn icloud_evicted_files_are_not_propagated_as_deletions() {
        let fixture = SyncFixture::new();
        fixture.local_write("chapter.md", b"baseline");
        clean_sync(&fixture.project).await;
        std::fs::remove_file(Path::new(&fixture.project).join("chapter.md")).unwrap();
        fixture.local_write(".chapter.md.icloud", b"placeholder");

        let status = perform_sync(&fixture.project).await.unwrap();
        assert!(
            status.errors.iter().any(|error| error.contains("iCloud")),
            "{:?}",
            status.errors
        );
        assert!(remote_has(&fixture, "chapter.md"));
        assert_eq!(
            read_sync_state(&fixture.project).unwrap().common_hashes["chapter.md"],
            hash(b"baseline")
        );
    }

    #[cfg(unix)]
    #[test]
    #[serial(sync_data_dir)]
    fn sync_config_holding_the_password_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = SyncFixture::new();
        let path = sync_dir_for_project(&fixture.project)
            .unwrap()
            .join("config.json");
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
