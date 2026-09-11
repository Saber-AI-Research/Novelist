use crate::services::project_files::is_project_content_path;
use crate::services::webdav::{self, WebDavAuth};
use crate::AppError;
use cap_fs_ext::DirExt;
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Write;
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
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            webdav_url: String::new(),
            username: String::new(),
            password: String::new(),
            interval_minutes: 30,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Type, Debug)]
pub struct SyncStatus {
    pub last_sync: Option<String>,
    pub files_uploaded: u32,
    pub files_downloaded: u32,
    pub errors: Vec<String>,
    pub in_progress: bool,
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
}

/// Get the sync data directory for a project: ~/.novelist/sync/{project-hash}/
fn sync_dir_for_project(project_dir: &str) -> Result<PathBuf, AppError> {
    let hash = blake3::hash(project_dir.as_bytes()).to_hex();
    let dir = data_root().join("sync").join(&hash[..16]);
    Ok(dir)
}

fn data_root() -> PathBuf {
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

fn atomic_write_state(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
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

fn collect_local_files(root: &Dir) -> Result<BTreeSet<String>, AppError> {
    fn walk(dir: &Dir, prefix: &str, files: &mut BTreeSet<String>) -> Result<(), AppError> {
        for entry in dir.entries()? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| AppError::InvalidInput("Project filename is not UTF-8".into()))?;
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            webdav::validate_remote_path(&relative)?;
            let kind = entry.file_type()?;
            if kind.is_symlink()
                && (is_project_content_path(Path::new(&relative)) || content_directory(&relative))
            {
                return Err(AppError::PathNotAllowed(format!(
                    "Project sync does not follow symlinks: {relative}"
                )));
            }
            if kind.is_dir() && content_directory(&relative) {
                walk(&dir.open_dir_nofollow(&name)?, &relative, files)?;
            } else if kind.is_file() && is_project_content_path(Path::new(&relative)) {
                files.insert(relative);
            }
        }
        Ok(())
    }
    let mut files = BTreeSet::new();
    walk(root, "", &mut files)?;
    Ok(files)
}

async fn collect_remote_files(
    client: &Client,
    base_url: &str,
    remote_base: &str,
    auth: &WebDavAuth,
) -> Result<BTreeSet<String>, AppError> {
    let mut files = BTreeSet::new();
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
                files.insert(relative);
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

static DOWNLOAD_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Stage and compare before the atomic rename, using a pinned parent capability.
fn commit_download(
    root: &Dir,
    relative: &str,
    bytes: &[u8],
    expected: Option<&str>,
) -> Result<(), AppError> {
    let path = Path::new(relative);
    let parent = webdav::confined_parent(root, path, true)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::InvalidInput("Invalid sync filename".into()))?;
    let counter = DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
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

enum Transfer {
    Unchanged,
    Uploaded,
    Downloaded,
}

struct SyncSession<'a> {
    root: &'a Dir,
    project: &'a Path,
    client: &'a Client,
    config: &'a SyncConfig,
    remote_base: &'a str,
    auth: &'a WebDavAuth,
}

async fn sync_file(
    session: &SyncSession<'_>,
    relative: &str,
    remote_exists: bool,
    common_hash: Option<&str>,
) -> Result<(String, Transfer), AppError> {
    let SyncSession {
        root,
        project,
        client,
        config,
        remote_base,
        auth,
    } = *session;
    let local = optional_local(root, relative)?;
    let local_hash = local.as_deref().map(hash);
    let remote_path = format!("{remote_base}/{relative}");
    let remote = if remote_exists {
        Some(webdav::get_file(client, &config.webdav_url, &remote_path, auth).await?)
    } else {
        None
    };
    let remote_hash = remote.as_ref().map(|file| hash(&file.bytes));
    if let Some(common) = local_hash
        .as_ref()
        .filter(|local| Some(*local) == remote_hash.as_ref())
    {
        assert_local_unchanged(root, relative, Some(common))?;
        return Ok((common.clone(), Transfer::Unchanged));
    }
    let upload = match (local.as_ref(), remote.as_ref()) {
        (Some(_), None) => true,
        (None, Some(_)) => false,
        (Some(_), Some(_)) if common_hash.is_some() && remote_hash.as_deref() == common_hash => true,
        (Some(_), Some(_)) if common_hash.is_some() && local_hash.as_deref() == common_hash => false,
        _ => return Err(AppError::Custom("Conflict: local and remote differ without a common unchanged version; resolve explicitly".into())),
    };
    if upload {
        let condition = match remote.as_ref() {
            None => webdav::PutCondition::Absent,
            Some(file) => webdav::PutCondition::Matches(file.etag.as_deref().ok_or_else(|| {
                AppError::Custom("Cannot safely replace remote file without a strong ETag".into())
            })?),
        };
        ensure_remote_parents(client, &config.webdav_url, &remote_path, auth).await?;
        assert_local_unchanged(root, relative, local_hash.as_deref())?;
        webdav::put_bytes(
            client,
            &config.webdav_url,
            &remote_path,
            local.unwrap(),
            auth,
            condition,
        )
        .await?;
        assert_local_unchanged(root, relative, local_hash.as_deref())?;
        Ok((local_hash.unwrap(), Transfer::Uploaded))
    } else {
        let _settings_guard = if matches!(
            relative,
            ".novelist/project.toml" | ".novelist/literary-study.json"
        ) {
            Some(crate::commands::settings::acquire_project_settings_guard(project).await?)
        } else {
            None
        };
        commit_download(
            root,
            relative,
            &remote.unwrap().bytes,
            local_hash.as_deref(),
        )?;
        Ok((remote_hash.unwrap(), Transfer::Downloaded))
    }
}

/// One canonical-project lock covers discovery, transfers, and baseline persistence.
pub async fn perform_sync(project_dir: &str) -> Result<SyncStatus, AppError> {
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
    };
    if !config.enabled {
        status.errors.push("Sync is not enabled".into());
        return Ok(status);
    }
    webdav::remote_url(&config.webdav_url, "")?;
    let auth = WebDavAuth {
        username: config.username.clone(),
        password: config.password.clone(),
    };
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(webdav::REQUEST_TIMEOUT)
        .timeout(webdav::REQUEST_TIMEOUT)
        .build()
        .map_err(|_| AppError::Custom("Cannot create WebDAV client".into()))?;
    let project_name = project
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::InvalidInput("Project name is not UTF-8".into()))?;
    let remote_base = format!("novelist/{project_name}");
    let root = Dir::open_ambient_dir(&project, ambient_authority())?;
    let local_files = collect_local_files(&root)?;
    ensure_remote_parents(
        &client,
        &config.webdav_url,
        &format!("{remote_base}/file"),
        &auth,
    )
    .await?;
    let remote_files =
        match collect_remote_files(&client, &config.webdav_url, &remote_base, &auth).await {
            Ok(files) => files,
            Err(error) => {
                status.errors.push(format!("Remote discovery: {error}"));
                return Ok(status);
            }
        };
    let session = SyncSession {
        root: &root,
        project: &project,
        client: &client,
        config: &config,
        remote_base: &remote_base,
        auth: &auth,
    };
    for relative in local_files.union(&remote_files) {
        match sync_file(
            &session,
            relative,
            remote_files.contains(relative),
            state.common_hashes.get(relative).map(String::as_str),
        )
        .await
        {
            Ok((common_hash, transfer)) => {
                state.common_hashes.insert(relative.clone(), common_hash);
                // Never rescan local content to bless edits made during another transfer.
                state.file_mod_times.remove(relative);
                match transfer {
                    Transfer::Uploaded => status.files_uploaded += 1,
                    Transfer::Downloaded => status.files_downloaded += 1,
                    Transfer::Unchanged => {}
                }
            }
            Err(error) => status.errors.push(format!("Sync {relative}: {error}")),
        }
    }
    let now = chrono_now_iso();
    state.last_sync_iso = Some(now.clone());
    write_sync_state(project_dir, &state)?;
    status.last_sync = Some(now);
    Ok(status)
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
            };
            save_sync_config_to_disk(&project, &config).unwrap();
            let remote_base = format!(
                "novelist/{}",
                Path::new(&project).file_name().unwrap().to_str().unwrap()
            );
            Self {
                _data: data,
                _project: project_dir,
                old_data,
                project,
                server,
                remote_base,
            }
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
            let path = self.remote_path(relative);
            let mut state = self.server.state.lock().unwrap();
            for (index, _) in path.match_indices('/').skip(1) {
                state.collections.insert(path[..index].to_string());
            }
            state.files.insert(path, bytes.to_vec());
        }
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
}
