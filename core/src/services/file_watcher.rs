use crate::commands::image_host::WindowImageCapabilities;
use crate::error::AppError;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use specta::Type;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::{Emitter, Manager};

// ── Rename-ignore set (self-trigger suppression for rename_item) ────
//
// `register_rename_ignore(old, new)` is called by `rename_item` right before
// the underlying `tokio::fs::rename`. The next filesystem event for either
// path is consumed without being forwarded to listeners. This prevents the
// frontend from receiving `file-changed` / `file-created` for a rename we
// initiated ourselves (which would otherwise cause the open editor to reload
// and lose its state).

/// A rename's own events arrive within the 200 ms debounce window. Entries for
/// a rename that failed, or whose events never arrive (destination outside the
/// watched folder), expire instead of swallowing a later real event.
const RENAME_IGNORE_TTL: Duration = Duration::from_secs(5);

static RENAME_IGNORED: std::sync::LazyLock<tokio::sync::Mutex<HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));

/// Register both old and new paths as expected rename targets. The next FS
/// event for either path within the TTL is consumed without forwarding.
pub async fn register_rename_ignore(old_path: String, new_path: String) {
    let now = Instant::now();
    let mut set = RENAME_IGNORED.lock().await;
    set.retain(|_, registered| registered.elapsed() < RENAME_IGNORE_TTL);
    set.insert(old_path, now);
    set.insert(new_path, now);
}

/// Withdraw a registration whose rename failed, so no real event is hidden.
pub async fn clear_rename_ignore(old_path: &str, new_path: &str) {
    let mut set = RENAME_IGNORED.lock().await;
    set.remove(old_path);
    set.remove(new_path);
}

/// Returns true and removes the entry if `path` was registered as a
/// self-initiated rename target within the TTL; otherwise returns false.
async fn take_rename_ignored(path: &str) -> bool {
    RENAME_IGNORED
        .lock()
        .await
        .remove(path)
        .is_some_and(|registered| registered.elapsed() < RENAME_IGNORE_TTL)
}

// ── Tracked file ────────────────────────────────────────────────────

struct TrackedFile {
    /// Original path registered by the frontend. Event payloads use this form
    /// even when the internal key is canonicalized for alias coalescing.
    path: PathBuf,
    /// All frontend display paths registered for this canonical file. This lets
    /// unregister remove a deleted symlink/alias path after canonicalize fails.
    aliases: HashMap<PathBuf, HashSet<String>>,
    /// Poll delivery cursors. Detection commits the disk state once, then each
    /// owning window drains its own cursor so one poller cannot consume another.
    pending_poll_owners: HashSet<String>,
    hash: blake3::Hash,
    mtime: SystemTime,
    deleted: bool,
}

// ── Ignore set (self-trigger suppression) ───────────────────────────

struct ExpectedWrite {
    hash: blake3::Hash,
    registered_at: Instant,
    owner: Option<String>,
}

struct IgnoreSet {
    entries: HashMap<PathBuf, ExpectedWrite>,
}

impl IgnoreSet {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    fn register(&mut self, path: &Path, expected_hash: blake3::Hash, owner: Option<&str>) {
        self.entries.insert(
            path.to_path_buf(),
            ExpectedWrite {
                hash: expected_hash,
                registered_at: Instant::now(),
                owner: owner.map(str::to_string),
            },
        );
    }

    fn take_owner(&mut self, path: &Path, observed_hash: blake3::Hash) -> Option<String> {
        let expected = self.entries.remove(path)?;
        if expected.registered_at.elapsed() < Duration::from_secs(2)
            && expected.hash == observed_hash
        {
            expected.owner
        } else {
            None
        }
    }
}

// ── Event payload ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Type)]
pub struct FileChangedPayload {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct ExternalFileChangePayload {
    /// Canonical path used as the stable identity for watcher and poll dedupe.
    pub identity: String,
    /// Every currently registered frontend path for this identity.
    pub paths: Vec<String>,
}

#[derive(Debug)]
struct PendingFsEvent {
    path: PathBuf,
    refresh_dir: Option<PathBuf>,
}

fn is_temp_write_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.ends_with(".novelist-tmp"))
        .unwrap_or(false)
}

fn refresh_dir_for_path(path: &Path, watching_dir: &Path) -> Option<PathBuf> {
    if is_temp_write_path(path) {
        return None;
    }
    if path == watching_dir {
        return Some(path.to_path_buf());
    }
    path.parent().map(Path::to_path_buf)
}

/// macOS FSEvents (and symlinked watch roots in general) report fully
/// canonicalized paths — e.g. a project opened as `/var/folders/…` or
/// `~/iCloud…` comes back as `/private/var/folders/…` with every symlink
/// resolved. The frontend, however, registers open files and lists the
/// sidebar using the *original* (non-canonical) path it passed to
/// `start_file_watcher`. If we forward the canonical path verbatim, the
/// `tracked_files` lookup misses (→ no editor reload) and the sidebar
/// `refreshFolder` finds no matching node (→ no tree refresh).
///
/// This rewrites an event path that sits under `canonical_dir` back onto the
/// `original_dir` prefix so it matches what the frontend knows. Paths that
/// don't share the canonical prefix (or when the two roots are identical) are
/// returned untouched.
fn normalize_event_path(path: PathBuf, canonical_dir: &Path, original_dir: &Path) -> PathBuf {
    if canonical_dir == original_dir {
        return path;
    }
    match path.strip_prefix(canonical_dir) {
        Ok(rest) => original_dir.join(rest),
        Err(_) => path,
    }
}

// ── Shared state ────────────────────────────────────────────────────

pub struct FileWatcherState {
    inner: Mutex<FileWatcherInner>,
}

struct FileWatcherInner {
    watchers: HashMap<String, RecommendedWatcher>,
    tracked_files: HashMap<PathBuf, TrackedFile>,
    ignore_set: IgnoreSet,
    #[allow(dead_code)]
    watching_dirs: HashMap<String, PathBuf>,
    /// Handles to cancel each window's debounce processor task.
    cancel_txs: HashMap<String, tokio::sync::oneshot::Sender<()>>,
}

impl FileWatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(FileWatcherInner {
                watchers: HashMap::new(),
                tracked_files: HashMap::new(),
                ignore_set: IgnoreSet::new(),
                watching_dirs: HashMap::new(),
                cancel_txs: HashMap::new(),
            }),
        }
    }
}

// ── Helper: compute blake3 hash of a file ───────────────────────────

fn hash_file(path: &Path) -> Result<blake3::Hash, AppError> {
    let bytes = std::fs::read(path)?;
    Ok(blake3::hash(&bytes))
}

fn tracking_key(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn external_change_payload_for_owner(
    key: &Path,
    entry: &TrackedFile,
    owner: &str,
) -> Option<ExternalFileChangePayload> {
    let mut paths = entry
        .aliases
        .iter()
        .filter(|(_, owners)| owners.contains(owner))
        .map(|(path, _)| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    (!paths.is_empty()).then(|| ExternalFileChangePayload {
        identity: key.to_string_lossy().to_string(),
        paths,
    })
}

fn tracked_owners(entry: &TrackedFile) -> HashSet<String> {
    entry
        .aliases
        .values()
        .flat_map(|owners| owners.iter().cloned())
        .collect()
}

fn revalidate_aliases(key: &Path, entry: &mut TrackedFile) {
    entry
        .aliases
        .retain(|alias, _| !alias.exists() || tracking_key(alias) == key);
    let owners = tracked_owners(entry);
    entry
        .pending_poll_owners
        .retain(|owner| owners.contains(owner));
}

fn commit_notify_change(
    inner: &mut FileWatcherInner,
    key: &Path,
    old_hash: blake3::Hash,
    new_hash: blake3::Hash,
    new_mtime: SystemTime,
) -> Vec<(String, ExternalFileChangePayload)> {
    if inner.tracked_files.get(key).map(|entry| entry.hash) != Some(old_hash) {
        return Vec::new();
    }
    let saving_owner = inner.ignore_set.take_owner(key, new_hash);
    let Some(entry) = inner.tracked_files.get_mut(key) else {
        return Vec::new();
    };
    revalidate_aliases(key, entry);
    entry.hash = new_hash;
    // The on-disk mtime of the hashed bytes, so the poll's stat gate matches.
    entry.mtime = new_mtime;
    entry.deleted = false;
    entry.pending_poll_owners = tracked_owners(entry);
    if let Some(owner) = saving_owner {
        entry.pending_poll_owners.remove(&owner);
    }
    let mut owners = entry
        .pending_poll_owners
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    owners.sort();
    owners
        .into_iter()
        .filter_map(|owner| {
            external_change_payload_for_owner(key, entry, &owner).map(|payload| (owner, payload))
        })
        .collect()
}

/// Delivery seam for watcher batches; production emits Tauri events.
trait WatchEmitter {
    fn directory_changed(&self, owner: &str, payload: &FileChangedPayload);
    /// Returns whether the payload reached the window.
    fn file_changed(&self, owner: &str, payload: &ExternalFileChangePayload) -> bool;
}

impl<R: tauri::Runtime> WatchEmitter for tauri::AppHandle<R> {
    fn directory_changed(&self, owner: &str, payload: &FileChangedPayload) {
        let _ = self.emit_to(owner, "directory-changed", payload);
    }

    fn file_changed(&self, owner: &str, payload: &ExternalFileChangePayload) -> bool {
        self.emit_to(owner, "file-changed", payload).is_ok()
    }
}

/// The notify watcher for one window: watches the canonical root and rewrites
/// event paths back onto the prefix the frontend uses.
fn create_watcher(
    dir: &Path,
    canonical_dir: &Path,
    tx: tokio::sync::mpsc::UnboundedSender<PendingFsEvent>,
) -> Result<RecommendedWatcher, AppError> {
    let dir_for_events = dir.to_path_buf();
    let canonical_for_events = canonical_dir.to_path_buf();
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                // Content changes refresh open tracked files; structural
                // changes refresh the sidebar tree. Windows' watcher often
                // reports rename/delete as Modify(Name) with one or more
                // paths, so keep the filter broad here and debounce below.
                match event.kind {
                    notify::EventKind::Any
                    | notify::EventKind::Modify(_)
                    | notify::EventKind::Create(_)
                    | notify::EventKind::Remove(_) => {
                        for path in event.paths {
                            let path =
                                normalize_event_path(path, &canonical_for_events, &dir_for_events);
                            let refresh_dir = refresh_dir_for_path(&path, &dir_for_events);
                            let _ = tx.send(PendingFsEvent { path, refresh_dir });
                        }
                    }
                    _ => {}
                }
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| AppError::Custom(format!("Failed to create file watcher: {e}")))?;

    // Watch the CANONICAL path, not the original. macOS FSEvents reports
    // fully-resolved paths; notify's backend drops events whose path doesn't
    // sit under the watched prefix. If we watch a symlinked root (e.g. a
    // project under /tmp, /var, an external mount, or iCloud "Desktop &
    // Documents" where ~/Documents is a symlink), every event arrives in
    // canonical form and is silently discarded → the open file never reloads
    // on external edits. Watching the canonical dir makes the prefixes match;
    // `normalize_event_path` then rewrites delivered paths back onto the
    // original prefix the frontend knows. (When the two are equal this is a
    // no-op, so non-symlinked /Users projects are unaffected.)
    watcher
        .watch(canonical_dir, RecursiveMode::Recursive)
        .map_err(|e| AppError::Custom(format!("Failed to watch directory: {e}")))?;
    Ok(watcher)
}

/// Wait for the first event, then collect the rest of its 200 ms burst.
/// `None` once the window's watcher is cancelled or dropped.
async fn next_watch_batch(
    rx: &mut tokio::sync::mpsc::UnboundedReceiver<PendingFsEvent>,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
) -> Option<Vec<PendingFsEvent>> {
    let first = tokio::select! {
        event = rx.recv() => event?,
        _ = &mut *cancel_rx => return None,
    };
    let mut events = vec![first];
    let debounce = tokio::time::sleep(Duration::from_millis(200));
    tokio::pin!(debounce);
    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Some(event) => events.push(event),
                None => break,
            },
            _ = &mut debounce => break,
        }
    }
    Some(events)
}

/// Handle one debounced batch from `owner`'s watcher: drop self-initiated
/// renames, refresh the owner's sidebar folders, then hash tracked files off
/// the lock and the async workers and dispatch real content changes to every
/// window tracking them, except the window whose own save produced them.
async fn process_watch_batch(
    events: Vec<PendingFsEvent>,
    owner: &str,
    state: &FileWatcherState,
    emitter: &impl WatchEmitter,
) {
    // Notify may emit a rename as Modify/Create events on either old or new
    // path depending on the platform (FSEvents vs inotify vs
    // ReadDirectoryChangesW), so filter every path conservatively.
    let mut filtered_paths: HashSet<PathBuf> = HashSet::new();
    let mut refresh_dirs: HashSet<PathBuf> = HashSet::new();
    for event in events {
        if take_rename_ignored(&event.path.to_string_lossy()).await {
            continue;
        }
        if let Some(dir) = event.refresh_dir {
            refresh_dirs.insert(dir);
        }
        filtered_paths.insert(event.path);
    }
    for dir in refresh_dirs {
        let payload = FileChangedPayload {
            path: dir.to_string_lossy().to_string(),
        };
        emitter.directory_changed(owner, &payload);
    }

    // Canonicalizing and stat-ing are blocking filesystem calls.
    let keys: Vec<PathBuf> = tokio::task::spawn_blocking(move || {
        filtered_paths
            .iter()
            .map(|path| tracking_key(path))
            .filter(|key| key.is_file())
            .collect()
    })
    .await
    .unwrap_or_default();
    // Phase 1: under the lock, pick out tracked files and snapshot their hash.
    let candidates: Vec<(PathBuf, blake3::Hash)> = {
        let Ok(guard) = state.inner.lock() else {
            return;
        };
        keys.into_iter()
            .filter_map(|key| {
                guard
                    .tracked_files
                    .get(&key)
                    .map(|t| t.hash)
                    .map(|hash| (key, hash))
            })
            .collect()
    };
    if candidates.is_empty() {
        return;
    }
    // Phase 2: read mtime, then hash, off-lock. Reading the mtime first means a
    // write racing the hash leaves a newer mtime for the poll to notice.
    let observed: Vec<(PathBuf, blake3::Hash, blake3::Hash, SystemTime)> =
        tokio::task::spawn_blocking(move || {
            candidates
                .into_iter()
                .filter_map(|(key, old_hash)| {
                    let mtime = std::fs::metadata(&key)
                        .and_then(|meta| meta.modified())
                        .ok()?;
                    let new_hash = hash_file(&key).ok()?;
                    Some((key, old_hash, new_hash, mtime))
                })
                .collect()
        })
        .await
        .unwrap_or_default();

    // Phase 3: re-lock briefly to commit and emit. Files unregistered or
    // changed in the meantime are skipped by the hash comparison.
    let Ok(mut guard) = state.inner.lock() else {
        return;
    };
    for (key, old_hash, new_hash, mtime) in observed {
        if new_hash == old_hash {
            // Same bytes (touch, identical save): adopt the mtime so the poll
            // does not re-read and re-hash this file every second.
            if let Some(entry) = guard
                .tracked_files
                .get_mut(&key)
                .filter(|entry| entry.hash == old_hash && !entry.deleted)
            {
                entry.mtime = mtime;
            }
            continue;
        }
        let dispatches = commit_notify_change(&mut guard, &key, old_hash, new_hash, mtime);
        for (dispatch_owner, payload) in dispatches {
            if emitter.file_changed(&dispatch_owner, &payload)
                && guard
                    .tracked_files
                    .get(&key)
                    .is_some_and(|entry| entry.hash == new_hash)
            {
                if let Some(entry) = guard.tracked_files.get_mut(&key) {
                    entry.pending_poll_owners.remove(&dispatch_owner);
                }
            }
        }
    }
}

// ── Tauri commands ──────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn start_file_watcher(
    dir_path: String,
    window: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, FileWatcherState>,
    image_capabilities: tauri::State<'_, WindowImageCapabilities>,
) -> Result<(), AppError> {
    let dir = PathBuf::from(&dir_path);
    if !dir.is_dir() {
        return Err(AppError::NotADirectory(dir_path));
    }

    // Channel for raw notify events -> debounce processor
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PendingFsEvent>();
    // FSEvents resolves symlinks and reports canonical paths; remember both so
    // we can rewrite event paths back onto the prefix the frontend uses.
    let canonical_dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    let watcher = create_watcher(&dir, &canonical_dir, tx)?;
    let owner = window.label().to_string();
    image_capabilities.replace_project(&owner, &canonical_dir)?;

    // Cancellation channel for the processor task
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();

    {
        let mut guard = state
            .inner
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        guard.watchers.insert(owner.clone(), watcher);
        guard.watching_dirs.insert(owner.clone(), dir);
        if let Some(previous) = guard.cancel_txs.insert(owner.clone(), cancel_tx) {
            let _ = previous.send(());
        }
    }

    // Ends when `stop_file_watcher_inner` cancels it or drops the watcher
    // (explicit stop, project switch, or window destruction).
    let app = app_handle.clone();
    tokio::spawn(async move {
        while let Some(events) = next_watch_batch(&mut rx, &mut cancel_rx).await {
            process_watch_batch(events, &owner, &app.state::<FileWatcherState>(), &app).await;
        }
    });

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn stop_file_watcher(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileWatcherState>,
    image_capabilities: tauri::State<'_, WindowImageCapabilities>,
) -> Result<(), AppError> {
    image_capabilities.clear_owner(window.label());
    stop_file_watcher_inner(window.label(), &state)
}

/// Release everything a window owns: its notify watcher, debounce task, poll
/// cursors and tracked aliases. Also runs when the window is destroyed.
pub(crate) fn stop_file_watcher_inner(
    owner: &str,
    state: &FileWatcherState,
) -> Result<(), AppError> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|e| AppError::Custom(e.to_string()))?;
    guard.watchers.remove(owner);
    guard.watching_dirs.remove(owner);
    if let Some(tx) = guard.cancel_txs.remove(owner) {
        let _ = tx.send(());
    }
    guard.tracked_files.retain(|_, entry| {
        entry.pending_poll_owners.remove(owner);
        entry.aliases.retain(|_, owners| {
            owners.remove(owner);
            !owners.is_empty()
        });
        !entry.aliases.is_empty()
    });
    if guard.tracked_files.is_empty() {
        guard.ignore_set = IgnoreSet::new();
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn register_open_file(
    path: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileWatcherState>,
    image_capabilities: tauri::State<'_, WindowImageCapabilities>,
) -> Result<(), AppError> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(AppError::FileNotFound(path));
    }

    image_capabilities.register_document(window.label(), &p)?;
    if let Err(error) = register_open_file_inner(&path, window.label(), &state) {
        let _ = image_capabilities.unregister_document(window.label(), &p);
        return Err(error);
    }
    Ok(())
}

fn register_open_file_inner(
    path: &str,
    owner: &str,
    state: &FileWatcherState,
) -> Result<(), AppError> {
    let p = PathBuf::from(path);
    if !p.is_file() {
        return Err(AppError::FileNotFound(path.to_string()));
    }
    let hash = hash_file(&p)?;
    let mtime = std::fs::metadata(&p)?.modified()?;
    let key = tracking_key(&p);
    let mut guard = state
        .inner
        .lock()
        .map_err(|error| AppError::Custom(error.to_string()))?;
    guard
        .tracked_files
        .entry(key)
        .and_modify(|entry| {
            entry
                .aliases
                .entry(p.clone())
                .or_default()
                .insert(owner.to_string());
        })
        .or_insert(TrackedFile {
            path: p.clone(),
            aliases: HashMap::from([(p, HashSet::from([owner.to_string()]))]),
            pending_poll_owners: HashSet::new(),
            hash,
            mtime,
            deleted: false,
        });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn unregister_open_file(
    path: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FileWatcherState>,
    image_capabilities: tauri::State<'_, WindowImageCapabilities>,
) -> Result<(), AppError> {
    unregister_open_file_inner(&path, window.label(), &state)?;
    image_capabilities.unregister_document(window.label(), Path::new(&path))
}

fn unregister_open_file_inner(
    path: &str,
    owner: &str,
    state: &FileWatcherState,
) -> Result<(), AppError> {
    let p = PathBuf::from(&path);
    let key = tracking_key(&p);
    let mut guard = state
        .inner
        .lock()
        .map_err(|e| AppError::Custom(e.to_string()))?;
    if let Some(entry) = guard.tracked_files.get_mut(&key) {
        if let Some(owners) = entry.aliases.get_mut(&p) {
            owners.remove(owner);
            if owners.is_empty() {
                entry.aliases.remove(&p);
            }
        }
        entry.pending_poll_owners.remove(owner);
        if entry.aliases.is_empty() {
            guard.tracked_files.remove(&key);
        }
        return Ok(());
    }

    let fallback_key = guard
        .tracked_files
        .iter_mut()
        .find_map(|(entry_key, entry)| {
            if entry.path == p || entry.aliases.contains_key(&p) {
                if let Some(owners) = entry.aliases.get_mut(&p) {
                    owners.remove(owner);
                    if owners.is_empty() {
                        entry.aliases.remove(&p);
                    }
                }
                entry.pending_poll_owners.remove(owner);
                return entry.aliases.is_empty().then(|| entry_key.clone());
            }
            None
        });
    if let Some(entry_key) = fallback_key {
        guard.tracked_files.remove(&entry_key);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn register_write_ignore(_path: String) -> Result<(), AppError> {
    // Legacy pre-write hook retained for generated API compatibility. The Rust
    // write command registers the exact encoded BLAKE3 hash before its rename.
    Ok(())
}

/// The tracked identity an expected write for `path` is recorded under.
/// `key` is `tracking_key(path)`, computed before taking the lock.
fn expected_write_key(inner: &FileWatcherInner, path: &Path, key: PathBuf) -> PathBuf {
    if inner.tracked_files.contains_key(&key) {
        return key;
    }
    inner
        .tracked_files
        .iter()
        .find_map(|(entry_key, entry)| {
            (entry.path == path || entry.aliases.contains_key(path)).then(|| entry_key.clone())
        })
        .unwrap_or(key)
}

pub(crate) fn register_expected_write_inner(
    path: &str,
    expected_hash: blake3::Hash,
    state: &FileWatcherState,
    owner: Option<&str>,
) -> Result<(), AppError> {
    let key = tracking_key(Path::new(path));
    let mut guard = state
        .inner
        .lock()
        .map_err(|e| AppError::Custom(e.to_string()))?;
    let ignore_key = expected_write_key(&guard, Path::new(path), key);
    guard.ignore_set.register(&ignore_key, expected_hash, owner);
    Ok(())
}

pub(crate) fn clear_expected_write_inner(
    path: &str,
    state: &FileWatcherState,
) -> Result<(), AppError> {
    let key = tracking_key(Path::new(path));
    let mut guard = state
        .inner
        .lock()
        .map_err(|e| AppError::Custom(e.to_string()))?;
    let ignore_key = expected_write_key(&guard, Path::new(path), key);
    guard.ignore_set.entries.remove(&ignore_key);
    Ok(())
}

#[cfg(test)]
pub(crate) fn expected_write_registered(path: &str, state: &FileWatcherState) -> bool {
    let key = tracking_key(Path::new(path));
    let guard = state.inner.lock().unwrap();
    let ignore_key = expected_write_key(&guard, Path::new(path), key);
    guard.ignore_set.entries.contains_key(&ignore_key)
}

/// Poison the state lock so every later watcher call fails.
#[cfg(test)]
pub(crate) fn poison_for_test(state: &FileWatcherState) {
    std::thread::scope(|scope| {
        let _ = scope
            .spawn(|| {
                let _guard = state.inner.lock().unwrap();
                panic!("poison watcher state for test");
            })
            .join();
    });
}

/// Install a real notify watcher, cancel channel and tracked file for `owner`,
/// as `start_file_watcher` does, without a Tauri window.
#[cfg(test)]
pub(crate) fn install_watcher_for_test(
    state: &FileWatcherState,
    owner: &str,
    dir: &Path,
    file: &Path,
) -> tokio::sync::oneshot::Receiver<()> {
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let watcher = create_watcher(dir, &dir.canonicalize().unwrap(), tx).unwrap();
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut guard = state.inner.lock().unwrap();
        guard.watchers.insert(owner.to_string(), watcher);
        guard
            .watching_dirs
            .insert(owner.to_string(), dir.to_path_buf());
        guard.cancel_txs.insert(owner.to_string(), cancel_tx);
    }
    register_open_file_inner(&file.to_string_lossy(), owner, state).unwrap();
    cancel_rx
}

/// Whether `owner` still holds a watcher, debounce task or tracked alias.
#[cfg(test)]
pub(crate) fn owns_watcher_resources(state: &FileWatcherState, owner: &str) -> bool {
    let guard = state.inner.lock().unwrap();
    guard.watchers.contains_key(owner)
        || guard.watching_dirs.contains_key(owner)
        || guard.cancel_txs.contains_key(owner)
        || guard
            .tracked_files
            .values()
            .any(|entry| entry.aliases.values().any(|owners| owners.contains(owner)))
}

/// Polling fallback for external-edit detection.
///
/// The notify watcher only covers a single recursively-watched project dir, so
/// it misses files opened in single-file mode (no project → no watcher) and can
/// miss events on symlinked roots or when the OS coalesces/drops FSEvents. This
/// command re-checks every *tracked open file* directly and returns the paths
/// whose content changed on disk, so the frontend can reload them on a short
/// interval regardless of watcher coverage.
///
/// Cheap by design: an mtime stat gates the blake3 hash, so unchanged files
/// cost one `stat` each. Only the saving window's self-write is suppressed, and
/// only when its exact encoded hash matches; other owners still receive it.
#[tauri::command]
#[specta::specta]
pub async fn poll_external_changes(
    window: tauri::WebviewWindow,
) -> Result<Vec<ExternalFileChangePayload>, AppError> {
    // Stat and hash are blocking reads; keep them off the async workers.
    let app = window.app_handle().clone();
    let owner = window.label().to_string();
    tokio::task::spawn_blocking(move || {
        poll_external_changes_inner(&app.state::<FileWatcherState>(), &owner)
    })
    .await
    .map_err(|error| AppError::Custom(format!("watcher poll worker: {error}")))?
}

fn poll_external_changes_inner(
    state: &FileWatcherState,
    owner: &str,
) -> Result<Vec<ExternalFileChangePayload>, AppError> {
    // Snapshot tracked (path, mtime, deleted) under the lock; release before IO.
    let snapshot: Vec<(PathBuf, SystemTime, bool)> = {
        let mut guard = state
            .inner
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        guard.tracked_files.retain(|key, entry| {
            revalidate_aliases(key, entry);
            !entry.aliases.is_empty()
        });
        guard
            .tracked_files
            .iter()
            .map(|(p, t)| (p.clone(), t.mtime, t.deleted))
            .collect()
    };

    // Off-lock: stat-gate, then hash only the files whose mtime moved.
    let mut candidates: Vec<(PathBuf, blake3::Hash, SystemTime)> = Vec::new();
    let mut deleted_candidates: Vec<PathBuf> = Vec::new();
    for (path, old_mtime, was_deleted) in snapshot {
        let Ok(meta) = std::fs::metadata(&path) else {
            if !was_deleted {
                deleted_candidates.push(path);
            }
            continue;
        };
        let new_mtime = meta.modified().unwrap_or(old_mtime);
        if new_mtime == old_mtime && !was_deleted {
            continue;
        }
        let Ok(new_hash) = hash_file(&path) else {
            continue;
        };
        candidates.push((path, new_hash, new_mtime));
    }

    // Re-lock briefly: commit new hash/mtime, suppress self-writes, collect the
    // genuinely-changed paths to report.
    let mut guard = state
        .inner
        .lock()
        .map_err(|e| AppError::Custom(e.to_string()))?;
    guard.tracked_files.retain(|key, entry| {
        revalidate_aliases(key, entry);
        !entry.aliases.is_empty()
    });
    for path in deleted_candidates {
        let Some(entry) = guard.tracked_files.get_mut(&path) else {
            continue;
        };
        if entry.deleted {
            continue;
        }
        entry.deleted = true;
        entry.pending_poll_owners = tracked_owners(entry);
    }
    for (path, new_hash, new_mtime) in candidates {
        let Some(current) = guard.tracked_files.get_mut(&path) else {
            continue;
        };
        // Bytes already committed (touch, identical save, or notify got there
        // first): adopt the mtime so the next poll skips the hash again.
        if current.hash == new_hash && !current.deleted {
            current.mtime = new_mtime;
            continue;
        }
        let saving_owner = guard.ignore_set.take_owner(&path, new_hash);
        let Some(entry) = guard.tracked_files.get_mut(&path) else {
            continue;
        };
        entry.hash = new_hash;
        entry.mtime = new_mtime;
        entry.deleted = false;
        entry.pending_poll_owners = tracked_owners(entry);
        if let Some(owner) = saving_owner {
            entry.pending_poll_owners.remove(&owner);
        }
    }

    let mut changed = BTreeMap::new();
    for (key, entry) in &mut guard.tracked_files {
        if !entry.pending_poll_owners.remove(owner) {
            continue;
        }
        if let Some(payload) = external_change_payload_for_owner(key, entry, owner) {
            changed.insert(key.clone(), payload);
        }
    }
    Ok(changed.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    const TEST_OWNER: &str = "test-window";

    /// Records what the batch processor would emit to each window.
    #[derive(Default)]
    struct RecordingEmitter {
        directories: Mutex<Vec<(String, String)>>,
        files: Mutex<Vec<(String, ExternalFileChangePayload)>>,
    }

    impl WatchEmitter for RecordingEmitter {
        fn directory_changed(&self, owner: &str, payload: &FileChangedPayload) {
            self.directories
                .lock()
                .unwrap()
                .push((owner.to_string(), payload.path.clone()));
        }

        fn file_changed(&self, owner: &str, payload: &ExternalFileChangePayload) -> bool {
            self.files
                .lock()
                .unwrap()
                .push((owner.to_string(), payload.clone()));
            true
        }
    }

    fn fs_event(path: &Path, watching_dir: &Path) -> PendingFsEvent {
        PendingFsEvent {
            path: path.to_path_buf(),
            refresh_dir: refresh_dir_for_path(path, watching_dir),
        }
    }

    fn disk_mtime(path: &Path) -> SystemTime {
        fs::metadata(path).unwrap().modified().unwrap()
    }

    /// End-to-end probe of the production watcher pipeline: `create_watcher`
    /// (recursive notify watch on the CANONICAL dir, events normalized back to
    /// the original prefix) → `next_watch_batch` (200 ms debounce) →
    /// `process_watch_batch` (hash diff + owner-scoped dispatch).
    ///
    /// Critically, the watch root is a SYMLINK and all writes go through the
    /// symlinked path — exactly the macOS case (project under /tmp, /var, an
    /// external mount, or iCloud "Desktop & Documents") that made external
    /// edits silently require a manual reload. Before the fix (watching the
    /// symlinked path), FSEvents delivered canonical paths that notify dropped,
    /// so ZERO edits were detected. Guards that regression.
    ///
    /// Unix-only: it builds a symlink via `std::os::unix::fs::symlink`, and the
    /// canonical-path/FSEvents issue it guards is a Unix concern (Windows uses
    /// ReadDirectoryChangesW with different path semantics).
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_watcher_detects_rapid_external_edits() {
        let tmp = TempDir::new().unwrap();
        let real_dir = tmp.path().join("real");
        fs::create_dir(&real_dir).unwrap();
        // The symlinked root the frontend passed in, owned by this test's TempDir.
        let original_dir = tmp.path().join("link");
        std::os::unix::fs::symlink(&real_dir, &original_dir).unwrap();
        let canonical_dir = original_dir.canonicalize().unwrap();
        assert_ne!(canonical_dir, original_dir, "test needs a real symlink");

        // The file path the frontend tracks is the ORIGINAL (symlinked) form.
        let file = original_dir.join("note.md");
        fs::write(&file, "v0").unwrap();
        let state = FileWatcherState::new();
        track(&state, &file);
        let emitter = RecordingEmitter::default();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let _watcher = create_watcher(&original_dir, &canonical_dir, tx).unwrap();
        let (_cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();

        // A loaded machine can take seconds to start the FSEvents stream, and
        // writes made before it is live are never reported. Touch an untracked
        // probe until the watcher delivers something, then start the burst.
        let probe = original_dir.join("probe.txt");
        let ready_deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        for attempt in 0u32.. {
            assert!(
                tokio::time::Instant::now() < ready_deadline,
                "watcher never became live"
            );
            fs::write(&probe, attempt.to_string()).unwrap();
            if let Ok(batch) = tokio::time::timeout(
                Duration::from_millis(500),
                next_watch_batch(&mut rx, &mut cancel_rx),
            )
            .await
            {
                let batch = batch.expect("watcher channel closed");
                process_watch_batch(batch, TEST_OWNER, &state, &emitter).await;
                break;
            }
        }

        let writer = {
            let file = file.clone();
            tokio::spawn(async move {
                // 20 rapid in-place edits, faster than the debounce window, so
                // many coalesce; only the LAST state must be detected.
                for i in 1..=20u32 {
                    fs::write(&file, format!("v{i}")).unwrap();
                    tokio::time::sleep(Duration::from_millis(30)).await;
                }
            })
        };
        let key = tracking_key(&file);
        let final_hash = blake3::hash(b"v20");
        // Under heavy parallel test load FSEvents can be slow to deliver, and a
        // batch hashed between a write's truncate and its data can leave the
        // last edit to the 1 s poll — production's safety net. Run the poll
        // only after the watcher itself reported a change through the symlinked
        // root (the regression this test guards), once the writer is done.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        while state.inner.lock().unwrap().tracked_files[&key].hash != final_hash {
            assert!(
                tokio::time::Instant::now() < deadline,
                "final external content not detected — auto-reload would never fire"
            );
            match tokio::time::timeout(
                Duration::from_secs(2),
                next_watch_batch(&mut rx, &mut cancel_rx),
            )
            .await
            {
                Ok(batch) => {
                    let batch = batch.expect("watcher channel closed");
                    process_watch_batch(batch, TEST_OWNER, &state, &emitter).await;
                }
                Err(_) if writer.is_finished() && !emitter.files.lock().unwrap().is_empty() => {
                    poll_external_changes_inner(&state, TEST_OWNER).unwrap();
                }
                Err(_) => {}
            }
        }
        writer.await.unwrap();

        let files = emitter.files.lock().unwrap();
        assert!(!files.is_empty());
        let expected = expected_external_change(&key, &[&file]);
        for (owner, payload) in files.iter() {
            assert_eq!(owner, TEST_OWNER);
            assert_eq!(serde_json::to_value(payload).unwrap(), expected);
        }
        // Sidebar refreshes use the frontend's (symlinked) prefix.
        assert!(emitter
            .directories
            .lock()
            .unwrap()
            .iter()
            .any(|(owner, dir)| owner == TEST_OWNER && Path::new(dir) == original_dir));
    }

    #[tokio::test]
    async fn test_watch_batch_dispatches_external_edit_and_stores_disk_mtime() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("note.md");
        fs::write(&file, "v0").unwrap();
        let state = FileWatcherState::new();
        track_for_owner(&state, &file, "window-a");
        track_for_owner(&state, &file, "window-b");
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&file, "external").unwrap();
        let emitter = RecordingEmitter::default();

        process_watch_batch(
            vec![fs_event(&file, dir.path())],
            "window-a",
            &state,
            &emitter,
        )
        .await;

        let owners: Vec<String> = emitter
            .files
            .lock()
            .unwrap()
            .iter()
            .map(|(owner, _)| owner.clone())
            .collect();
        assert_eq!(owners, ["window-a", "window-b"]);
        // Only the watching window refreshes its sidebar.
        assert_eq!(
            *emitter.directories.lock().unwrap(),
            [(
                "window-a".to_string(),
                dir.path().to_string_lossy().to_string()
            )]
        );
        // The baseline keeps the file's real mtime, so the one-second poll's
        // stat gate skips the file instead of re-reading and re-hashing it.
        let key = tracking_key(&file);
        assert_eq!(
            state.inner.lock().unwrap().tracked_files[&key].mtime,
            disk_mtime(&file)
        );
        for owner in ["window-a", "window-b"] {
            assert!(poll_external_changes_inner(&state, owner)
                .unwrap()
                .is_empty());
        }
    }

    #[tokio::test]
    async fn test_watch_batch_adopts_mtime_when_bytes_are_unchanged() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("touched.md");
        fs::write(&file, "same").unwrap();
        let state = FileWatcherState::new();
        track(&state, &file);
        let key = tracking_key(&file);
        state
            .inner
            .lock()
            .unwrap()
            .tracked_files
            .get_mut(&key)
            .unwrap()
            .mtime = SystemTime::UNIX_EPOCH;
        let emitter = RecordingEmitter::default();

        process_watch_batch(
            vec![fs_event(&file, dir.path())],
            TEST_OWNER,
            &state,
            &emitter,
        )
        .await;

        assert!(emitter.files.lock().unwrap().is_empty());
        assert_eq!(
            state.inner.lock().unwrap().tracked_files[&key].mtime,
            disk_mtime(&file)
        );
    }

    #[tokio::test]
    async fn test_watch_batch_suppresses_only_the_saving_window() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("shared.md");
        fs::write(&file, "v0").unwrap();
        let state = FileWatcherState::new();
        track_for_owner(&state, &file, "window-a");
        track_for_owner(&state, &file, "window-b");
        save_test_file(dir.path(), &file, &state, Some("window-a"), false).await;
        let emitter = RecordingEmitter::default();

        process_watch_batch(
            vec![fs_event(&file, dir.path())],
            "window-a",
            &state,
            &emitter,
        )
        .await;

        let owners: Vec<String> = emitter
            .files
            .lock()
            .unwrap()
            .iter()
            .map(|(owner, _)| owner.clone())
            .collect();
        assert_eq!(owners, ["window-b"]);
    }

    #[tokio::test]
    async fn test_watch_batch_consumes_registered_rename_events_once() {
        let dir = TempDir::new().unwrap();
        let old = dir.path().join("old.md");
        let new = dir.path().join("new.md");
        fs::write(&new, "v0").unwrap();
        let state = FileWatcherState::new();
        track(&state, &new);
        register_rename_ignore(
            old.to_string_lossy().to_string(),
            new.to_string_lossy().to_string(),
        )
        .await;
        fs::write(&new, "v1").unwrap();
        let emitter = RecordingEmitter::default();

        let rename_events = vec![fs_event(&old, dir.path()), fs_event(&new, dir.path())];
        process_watch_batch(rename_events, TEST_OWNER, &state, &emitter).await;
        assert!(emitter.directories.lock().unwrap().is_empty());
        assert!(emitter.files.lock().unwrap().is_empty());

        // The registration is consumed: a later real edit is delivered.
        process_watch_batch(
            vec![fs_event(&new, dir.path())],
            TEST_OWNER,
            &state,
            &emitter,
        )
        .await;
        assert_eq!(emitter.files.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn test_stopping_a_window_ends_its_watch_loop() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("open.md");
        fs::write(&file, "v0").unwrap();
        let state = FileWatcherState::new();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let watcher = create_watcher(dir.path(), &dir.path().canonicalize().unwrap(), tx).unwrap();
        let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
        {
            let mut guard = state.inner.lock().unwrap();
            guard.watchers.insert("closed".into(), watcher);
            guard.cancel_txs.insert("closed".into(), cancel_tx);
        }
        track_for_owner(&state, &file, "closed");

        stop_file_watcher_inner("closed", &state).unwrap();

        let batch = tokio::time::timeout(
            Duration::from_secs(5),
            next_watch_batch(&mut rx, &mut cancel_rx),
        )
        .await
        .expect("stopped watch loop must end");
        assert!(batch.is_none());
        assert!(!owns_watcher_resources(&state, "closed"));
    }

    #[test]
    fn test_stopping_one_window_keeps_other_windows_watching() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("chapter.md");
        fs::write(&file, "text").unwrap();
        let state = FileWatcherState::new();
        let mut closed = install_watcher_for_test(&state, "closed", dir.path(), &file);
        let mut open = install_watcher_for_test(&state, "open", dir.path(), &file);

        stop_file_watcher_inner("closed", &state).unwrap();

        assert_eq!(closed.try_recv(), Ok(()));
        assert!(!owns_watcher_resources(&state, "closed"));
        assert!(owns_watcher_resources(&state, "open"));
        assert!(open.try_recv().is_err());
    }

    fn track(state: &FileWatcherState, path: &Path) {
        track_for_owner(state, path, TEST_OWNER);
    }

    fn track_for_owner(state: &FileWatcherState, path: &Path, owner: &str) {
        register_open_file_inner(&path.to_string_lossy(), owner, state).unwrap();
    }

    fn expected_external_change(identity: &Path, paths: &[&Path]) -> serde_json::Value {
        let mut paths = paths
            .iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        paths.sort();
        serde_json::json!({
            "identity": identity.to_string_lossy().to_string(),
            "paths": paths,
        })
    }

    async fn save_test_file(
        project: &Path,
        file: &Path,
        state: &FileWatcherState,
        owner: Option<&str>,
        conditional: bool,
    ) {
        let enc = crate::commands::file::EncodingState::new();
        if conditional {
            let result = crate::commands::file::write_file_if_unchanged_inner(
                &project.to_string_lossy(),
                &file.to_string_lossy(),
                Some("v0"),
                "saved by app",
                &enc,
                state,
                owner,
            )
            .await
            .unwrap();
            assert_eq!(
                result,
                crate::commands::file::WriteFileIfUnchangedResult::Written
            );
        } else {
            crate::commands::file::write_file_with_watcher_inner(
                &file.to_string_lossy(),
                "saved by app",
                &enc,
                state,
                owner,
            )
            .await
            .unwrap();
        }
        // Make poll coverage independent of the filesystem's timestamp resolution.
        state
            .inner
            .lock()
            .unwrap()
            .tracked_files
            .get_mut(&tracking_key(file))
            .unwrap()
            .mtime = SystemTime::UNIX_EPOCH;
    }

    /// The polling fallback reports an open file edited on disk — the mechanism
    /// that makes single-file-mode and symlinked-project tabs auto-reload even
    /// when the notify watcher never fires.
    #[test]
    fn test_poll_detects_external_edit() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("note.md");
        fs::write(&file, "v0").unwrap();
        let state = FileWatcherState::new();
        track(&state, &file);

        // No change yet → nothing reported.
        assert!(poll_external_changes_inner(&state, TEST_OWNER)
            .unwrap()
            .is_empty());

        // External edit (distinct mtime — filesystems are second/ms-granular).
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&file, "external edit").unwrap();

        let changed = poll_external_changes_inner(&state, TEST_OWNER).unwrap();
        assert_eq!(
            changed,
            vec![ExternalFileChangePayload {
                identity: tracking_key(&file).to_string_lossy().to_string(),
                paths: vec![file.to_string_lossy().to_string()],
            }]
        );

        // A second poll with no further change reports nothing (hash committed).
        assert!(poll_external_changes_inner(&state, TEST_OWNER)
            .unwrap()
            .is_empty());
    }

    /// A self-write registered in the ignore set must NOT be reported as an
    /// external change — otherwise saving would reload the editor under the
    /// user, resetting cursor/scroll.
    #[test]
    fn test_poll_suppresses_self_write() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("note.md");
        fs::write(&file, "v0").unwrap();
        let state = FileWatcherState::new();
        track(&state, &file);

        // Simulate the app's own save: register the ignore, then change bytes.
        state.inner.lock().unwrap().ignore_set.register(
            &tracking_key(&file),
            blake3::hash(b"saved by app"),
            Some(TEST_OWNER),
        );
        fs::write(&file, "saved by app").unwrap();
        // Force the hash path regardless of filesystem timestamp resolution.
        state
            .inner
            .lock()
            .unwrap()
            .tracked_files
            .get_mut(&tracking_key(&file))
            .unwrap()
            .mtime = SystemTime::UNIX_EPOCH;

        // Suppressed (within the 2s ignore window) — and the new hash is
        // committed, so the next poll stays quiet too.
        assert!(poll_external_changes_inner(&state, TEST_OWNER)
            .unwrap()
            .is_empty());
        assert_eq!(
            state.inner.lock().unwrap().tracked_files[&tracking_key(&file)].hash,
            blake3::hash(b"saved by app"),
            "the poll must have re-hashed the self-write"
        );
        assert!(poll_external_changes_inner(&state, TEST_OWNER)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_poll_delivers_one_change_cursor_to_each_window_owner() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("shared.md");
        fs::write(&file, "v0").unwrap();
        let state = FileWatcherState::new();
        track_for_owner(&state, &file, "window-a");
        track_for_owner(&state, &file, "window-b");

        std::thread::sleep(Duration::from_millis(20));
        fs::write(&file, "v1").unwrap();

        let a = poll_external_changes_inner(&state, "window-a").unwrap();
        assert_eq!(a.len(), 1);
        assert!(poll_external_changes_inner(&state, "window-a")
            .unwrap()
            .is_empty());
        let b = poll_external_changes_inner(&state, "window-b").unwrap();
        assert_eq!(b, a);
        assert!(poll_external_changes_inner(&state, "window-b")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_unregister_one_window_keeps_shared_path_for_other_owner() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("shared.md");
        fs::write(&file, "v0").unwrap();
        let state = FileWatcherState::new();
        track_for_owner(&state, &file, "window-a");
        track_for_owner(&state, &file, "window-b");
        unregister_open_file_inner(&file.to_string_lossy(), "window-a", &state).unwrap();

        std::thread::sleep(Duration::from_millis(20));
        fs::write(&file, "v1").unwrap();

        assert!(poll_external_changes_inner(&state, "window-a")
            .unwrap()
            .is_empty());
        assert_eq!(
            poll_external_changes_inner(&state, "window-b")
                .unwrap()
                .len(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_registering_second_alias_preserves_existing_detection_baseline() {
        let dir = TempDir::new().unwrap();
        let real_dir = dir.path().join("real");
        fs::create_dir(&real_dir).unwrap();
        let alias_dir = dir.path().join("alias");
        std::os::unix::fs::symlink(&real_dir, &alias_dir).unwrap();
        let real_file = real_dir.join("chapter.md");
        let alias_file = alias_dir.join("chapter.md");
        fs::write(&real_file, "v0").unwrap();
        let state = FileWatcherState::new();
        track_for_owner(&state, &real_file, "window-a");
        let original_hash = state
            .inner
            .lock()
            .unwrap()
            .tracked_files
            .get(&tracking_key(&real_file))
            .unwrap()
            .hash;

        std::thread::sleep(Duration::from_millis(20));
        fs::write(&real_file, "v1").unwrap();
        track_for_owner(&state, &alias_file, "window-b");

        assert_eq!(
            state
                .inner
                .lock()
                .unwrap()
                .tracked_files
                .get(&tracking_key(&real_file))
                .unwrap()
                .hash,
            original_hash
        );
        assert_eq!(
            poll_external_changes_inner(&state, "window-a")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            poll_external_changes_inner(&state, "window-b")
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn test_rust_write_suppresses_exact_hash_but_not_immediate_external_hash() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("write.md");
        fs::write(&file, "v0").unwrap();
        let state = FileWatcherState::new();
        track(&state, &file);

        crate::commands::file::write_file_with_watcher_inner(
            &file.to_string_lossy(),
            "saved by app",
            &crate::commands::file::EncodingState::new(),
            &state,
            Some(TEST_OWNER),
        )
        .await
        .unwrap();
        assert!(poll_external_changes_inner(&state, TEST_OWNER)
            .unwrap()
            .is_empty());

        std::thread::sleep(Duration::from_millis(20));
        fs::write(&file, "external immediately after save").unwrap();
        assert_eq!(
            poll_external_changes_inner(&state, TEST_OWNER)
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn test_poll_app_save_suppresses_only_saving_owner() {
        for conditional in [false, true] {
            for owners in [["window-a", "window-b"], ["window-b", "window-a"]] {
                let dir = TempDir::new().unwrap();
                let file = dir.path().join("shared.md");
                fs::write(&file, "v0").unwrap();
                let state = FileWatcherState::new();
                track_for_owner(&state, &file, "window-a");
                track_for_owner(&state, &file, "window-b");
                save_test_file(dir.path(), &file, &state, Some("window-a"), conditional).await;

                for owner in owners {
                    let changed = poll_external_changes_inner(&state, owner).unwrap();
                    if owner == "window-a" {
                        assert!(changed.is_empty());
                    } else {
                        assert_eq!(
                            changed,
                            vec![ExternalFileChangePayload {
                                identity: tracking_key(&file).to_string_lossy().to_string(),
                                paths: vec![file.to_string_lossy().to_string()],
                            }]
                        );
                    }
                    assert!(poll_external_changes_inner(&state, owner)
                        .unwrap()
                        .is_empty());
                }
            }
        }
    }

    #[tokio::test]
    async fn test_notify_app_save_suppresses_only_saving_owner() {
        for conditional in [false, true] {
            let dir = TempDir::new().unwrap();
            let file = dir.path().join("shared.md");
            fs::write(&file, "v0").unwrap();
            let state = FileWatcherState::new();
            track_for_owner(&state, &file, "window-a");
            track_for_owner(&state, &file, "window-b");
            save_test_file(dir.path(), &file, &state, Some("window-a"), conditional).await;
            let key = tracking_key(&file);

            let dispatches = commit_notify_change(
                &mut state.inner.lock().unwrap(),
                &key,
                blake3::hash(b"v0"),
                blake3::hash(b"saved by app"),
                SystemTime::now(),
            );
            assert_eq!(
                dispatches,
                vec![(
                    "window-b".to_string(),
                    ExternalFileChangePayload {
                        identity: key.to_string_lossy().to_string(),
                        paths: vec![file.to_string_lossy().to_string()],
                    },
                )]
            );
            // Failed notify delivery keeps only the other window's poll cursor.
            assert!(poll_external_changes_inner(&state, "window-a")
                .unwrap()
                .is_empty());
            assert_eq!(
                poll_external_changes_inner(&state, "window-b")
                    .unwrap()
                    .len(),
                1
            );
            assert!(poll_external_changes_inner(&state, "window-b")
                .unwrap()
                .is_empty());
        }
    }

    #[tokio::test]
    async fn test_background_app_save_never_suppresses_any_owner() {
        for conditional in [false, true] {
            for notify in [false, true] {
                let dir = TempDir::new().unwrap();
                let file = dir.path().join("shared.md");
                fs::write(&file, "v0").unwrap();
                let state = FileWatcherState::new();
                track_for_owner(&state, &file, "window-a");
                track_for_owner(&state, &file, "window-b");
                save_test_file(dir.path(), &file, &state, None, conditional).await;
                if notify {
                    let dispatches = commit_notify_change(
                        &mut state.inner.lock().unwrap(),
                        &tracking_key(&file),
                        blake3::hash(b"v0"),
                        blake3::hash(b"saved by app"),
                        SystemTime::now(),
                    );
                    assert_eq!(
                        dispatches
                            .iter()
                            .map(|(owner, _)| owner.as_str())
                            .collect::<Vec<_>>(),
                        vec!["window-a", "window-b"]
                    );
                }
                for owner in ["window-a", "window-b"] {
                    assert_eq!(poll_external_changes_inner(&state, owner).unwrap().len(), 1);
                    assert!(poll_external_changes_inner(&state, owner)
                        .unwrap()
                        .is_empty());
                }
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_symlink_save_preserves_link_and_owner_scoped_delivery() {
        for notify in [false, true] {
            let dir = TempDir::new().unwrap();
            let target_dir = dir.path().join("targets");
            fs::create_dir(&target_dir).unwrap();
            let target = target_dir.join("chapter.md");
            let alias = dir.path().join("linked.md");
            fs::write(&target, "v0").unwrap();
            std::os::unix::fs::symlink("targets/chapter.md", &alias).unwrap();
            let state = FileWatcherState::new();
            track_for_owner(&state, &alias, "window-a");
            track_for_owner(&state, &target, "window-b");
            let key = tracking_key(&target);
            save_test_file(dir.path(), &alias, &state, Some("window-a"), false).await;

            assert!(alias.is_symlink());
            assert_eq!(
                fs::read_link(&alias).unwrap(),
                PathBuf::from("targets/chapter.md")
            );
            assert_eq!(fs::read_to_string(&target).unwrap(), "saved by app");
            assert_eq!(tracking_key(&alias), key);
            assert_eq!(state.inner.lock().unwrap().tracked_files.len(), 1);
            if notify {
                let dispatches = commit_notify_change(
                    &mut state.inner.lock().unwrap(),
                    &key,
                    blake3::hash(b"v0"),
                    blake3::hash(b"saved by app"),
                    SystemTime::now(),
                );
                assert_eq!(dispatches.len(), 1);
                assert_eq!(dispatches[0].0, "window-b");
                assert_eq!(
                    dispatches[0].1.paths,
                    vec![target.to_string_lossy().to_string()]
                );
            }
            assert!(poll_external_changes_inner(&state, "window-a")
                .unwrap()
                .is_empty());
            assert_eq!(
                poll_external_changes_inner(&state, "window-b")
                    .unwrap()
                    .len(),
                1
            );
        }
    }

    #[test]
    fn test_stale_notify_snapshot_cannot_overwrite_newer_hash() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("race.md");
        fs::write(&file, "v0").unwrap();
        let state = FileWatcherState::new();
        track(&state, &file);
        let key = tracking_key(&file);
        let old_hash = blake3::hash(b"v0");
        let newer_hash = blake3::hash(b"v2");
        {
            state
                .inner
                .lock()
                .unwrap()
                .tracked_files
                .get_mut(&key)
                .unwrap()
                .hash = newer_hash;
        }

        let result = commit_notify_change(
            &mut state.inner.lock().unwrap(),
            &key,
            old_hash,
            blake3::hash(b"v1"),
            SystemTime::now(),
        );
        assert!(result.is_empty());
        assert_eq!(
            state.inner.lock().unwrap().tracked_files[&key].hash,
            newer_hash
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_notify_builds_one_owner_scoped_dispatch_per_window() {
        let dir = TempDir::new().unwrap();
        let real_dir = dir.path().join("real");
        fs::create_dir(&real_dir).unwrap();
        let alias_a_dir = dir.path().join("alias-a");
        let alias_b_dir = dir.path().join("alias-b");
        std::os::unix::fs::symlink(&real_dir, &alias_a_dir).unwrap();
        std::os::unix::fs::symlink(&real_dir, &alias_b_dir).unwrap();
        let real_file = real_dir.join("shared.md");
        let alias_a = alias_a_dir.join("shared.md");
        let alias_b = alias_b_dir.join("shared.md");
        fs::write(&real_file, "v0").unwrap();
        let state = FileWatcherState::new();
        track_for_owner(&state, &alias_a, "window-a");
        track_for_owner(&state, &alias_b, "window-b");
        let key = tracking_key(&real_file);

        let dispatches = commit_notify_change(
            &mut state.inner.lock().unwrap(),
            &key,
            blake3::hash(b"v0"),
            blake3::hash(b"v1"),
            SystemTime::now(),
        );

        assert_eq!(dispatches.len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn test_poll_drops_symlink_alias_retargeted_to_another_identity() {
        let dir = TempDir::new().unwrap();
        let real_a = dir.path().join("real-a");
        let real_b = dir.path().join("real-b");
        fs::create_dir(&real_a).unwrap();
        fs::create_dir(&real_b).unwrap();
        let alias_dir = dir.path().join("alias");
        std::os::unix::fs::symlink(&real_a, &alias_dir).unwrap();
        let real_a_file = real_a.join("chapter.md");
        let real_b_file = real_b.join("chapter.md");
        let alias_file = alias_dir.join("chapter.md");
        fs::write(&real_a_file, "a0").unwrap();
        fs::write(&real_b_file, "b0").unwrap();
        let state = FileWatcherState::new();
        track(&state, &alias_file);

        fs::remove_file(&alias_dir).unwrap();
        std::os::unix::fs::symlink(&real_b, &alias_dir).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&real_a_file, "a1").unwrap();

        assert!(poll_external_changes_inner(&state, TEST_OWNER)
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn test_conditional_write_conflict_does_not_register_watcher_ignore() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("conflict.md");
        fs::write(&file, "disk content").unwrap();
        let watcher_state = FileWatcherState::new();
        track(&watcher_state, &file);

        let result = crate::commands::file::write_file_if_unchanged_inner(
            &dir.path().to_string_lossy(),
            &file.to_string_lossy(),
            Some("stale content"),
            "replacement",
            &crate::commands::file::EncodingState::new(),
            &watcher_state,
            Some(TEST_OWNER),
        )
        .await
        .unwrap();
        assert_eq!(
            result,
            crate::commands::file::WriteFileIfUnchangedResult::Conflict
        );
        assert!(!Path::new(&format!("{}.novelist-tmp", file.display())).exists());

        std::thread::sleep(Duration::from_millis(20));
        fs::write(&file, "external edit").unwrap();
        assert_eq!(
            poll_external_changes_inner(&watcher_state, TEST_OWNER).unwrap(),
            vec![ExternalFileChangePayload {
                identity: tracking_key(&file).to_string_lossy().to_string(),
                paths: vec![file.to_string_lossy().to_string()],
            }]
        );
    }

    #[test]
    fn test_poll_reports_external_deletion_once_and_keeps_buffer_addressable() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("deleted.md");
        fs::write(&file, "v0").unwrap();
        let state = FileWatcherState::new();
        track(&state, &file);
        let identity = tracking_key(&file);

        fs::remove_file(&file).unwrap();

        let changed = poll_external_changes_inner(&state, TEST_OWNER).unwrap();
        assert_eq!(
            changed,
            vec![ExternalFileChangePayload {
                identity: identity.to_string_lossy().to_string(),
                paths: vec![file.to_string_lossy().to_string()],
            }]
        );
        assert!(poll_external_changes_inner(&state, TEST_OWNER)
            .unwrap()
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn test_poll_dispatches_all_symlink_aliases_as_one_canonical_change_with_cjk_name() {
        let tmp = TempDir::new().unwrap();
        let real_dir = tmp.path().join("真实 项目");
        fs::create_dir(&real_dir).unwrap();
        let alias_dir = tmp.path().join("别名 项目");
        std::os::unix::fs::symlink(&real_dir, &alias_dir).unwrap();

        let real_file = real_dir.join("章节.md");
        let alias_file = alias_dir.join("章节.md");
        fs::write(&real_file, "v0").unwrap();

        let state = FileWatcherState::new();
        track(&state, &real_file);
        track(&state, &alias_file);

        std::thread::sleep(Duration::from_millis(20));
        fs::write(&real_file, "v1").unwrap();

        let changed = poll_external_changes_inner(&state, TEST_OWNER).unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(
            serde_json::to_value(&changed[0]).unwrap(),
            expected_external_change(&tracking_key(&real_file), &[&real_file, &alias_file]),
        );
        assert!(poll_external_changes_inner(&state, TEST_OWNER)
            .unwrap()
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn test_poll_aliases_converge_to_latest_rapid_write_once() {
        let tmp = TempDir::new().unwrap();
        let real_dir = tmp.path().join("rapid-real");
        fs::create_dir(&real_dir).unwrap();
        let alias_dir = tmp.path().join("rapid-alias");
        std::os::unix::fs::symlink(&real_dir, &alias_dir).unwrap();

        let real_file = real_dir.join("章节.md");
        let alias_file = alias_dir.join("章节.md");
        fs::write(&real_file, "v0").unwrap();
        let state = FileWatcherState::new();
        track(&state, &alias_file);
        track(&state, &real_file);

        for version in 1..=20 {
            std::thread::sleep(Duration::from_millis(2));
            fs::write(&alias_file, format!("v{version}")).unwrap();
        }

        let changed = poll_external_changes_inner(&state, TEST_OWNER).unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(
            serde_json::to_value(&changed[0]).unwrap(),
            expected_external_change(&tracking_key(&real_file), &[&real_file, &alias_file]),
        );
        assert_eq!(fs::read_to_string(&real_file).unwrap(), "v20");
        assert!(poll_external_changes_inner(&state, TEST_OWNER)
            .unwrap()
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn test_poll_reports_alias_deletion_once_for_every_active_owner() {
        let tmp = TempDir::new().unwrap();
        let real_dir = tmp.path().join("delete-real");
        fs::create_dir(&real_dir).unwrap();
        let alias_dir = tmp.path().join("delete-alias");
        std::os::unix::fs::symlink(&real_dir, &alias_dir).unwrap();

        let real_file = real_dir.join("chapter.md");
        let alias_file = alias_dir.join("chapter.md");
        fs::write(&real_file, "v0").unwrap();
        let identity = tracking_key(&real_file);
        let state = FileWatcherState::new();
        track(&state, &real_file);
        track(&state, &alias_file);

        fs::remove_file(&real_file).unwrap();

        let changed = poll_external_changes_inner(&state, TEST_OWNER).unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(
            serde_json::to_value(&changed[0]).unwrap(),
            expected_external_change(&identity, &[&real_file, &alias_file]),
        );
        assert!(poll_external_changes_inner(&state, TEST_OWNER)
            .unwrap()
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn test_unregister_one_alias_keeps_only_remaining_owner_in_change() {
        let tmp = TempDir::new().unwrap();
        let real_dir = tmp.path().join("remove-real");
        fs::create_dir(&real_dir).unwrap();
        let alias_dir = tmp.path().join("remove-alias");
        std::os::unix::fs::symlink(&real_dir, &alias_dir).unwrap();

        let real_file = real_dir.join("chapter.md");
        let alias_file = alias_dir.join("chapter.md");
        fs::write(&real_file, "v0").unwrap();
        let state = FileWatcherState::new();
        track(&state, &real_file);
        track(&state, &alias_file);
        unregister_open_file_inner(&alias_file.to_string_lossy(), TEST_OWNER, &state).unwrap();

        std::thread::sleep(Duration::from_millis(20));
        fs::write(&real_file, "v1").unwrap();

        let changed = poll_external_changes_inner(&state, TEST_OWNER).unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(
            serde_json::to_value(&changed[0]).unwrap(),
            expected_external_change(&tracking_key(&real_file), &[&real_file]),
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_renamed_symlink_alias_replaces_stale_owner_path() {
        let tmp = TempDir::new().unwrap();
        let real_dir = tmp.path().join("rename-real");
        fs::create_dir(&real_dir).unwrap();
        let old_alias_dir = tmp.path().join("rename-alias-old");
        let new_alias_dir = tmp.path().join("rename-alias-new");
        std::os::unix::fs::symlink(&real_dir, &old_alias_dir).unwrap();

        let real_file = real_dir.join("chapter.md");
        let old_alias_file = old_alias_dir.join("chapter.md");
        fs::write(&real_file, "v0").unwrap();
        let state = FileWatcherState::new();
        track(&state, &real_file);
        track(&state, &old_alias_file);

        fs::rename(&old_alias_dir, &new_alias_dir).unwrap();
        let new_alias_file = new_alias_dir.join("chapter.md");
        unregister_open_file_inner(&old_alias_file.to_string_lossy(), TEST_OWNER, &state).unwrap();
        track(&state, &new_alias_file);
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&new_alias_file, "v1").unwrap();

        let changed = poll_external_changes_inner(&state, TEST_OWNER).unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(
            serde_json::to_value(&changed[0]).unwrap(),
            expected_external_change(&tracking_key(&real_file), &[&real_file, &new_alias_file]),
        );
    }

    #[test]
    fn test_case_aliases_share_change_when_host_filesystem_canonicalizes_case() {
        let tmp = TempDir::new().unwrap();
        let canonical_spelling = tmp.path().join("CaseAlias.md");
        let alternate_spelling = tmp.path().join("casealias.md");
        fs::write(&canonical_spelling, "v0").unwrap();

        if !alternate_spelling.is_file()
            || tracking_key(&canonical_spelling) != tracking_key(&alternate_spelling)
        {
            return;
        }

        let state = FileWatcherState::new();
        track(&state, &canonical_spelling);
        track(&state, &alternate_spelling);
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&alternate_spelling, "v1").unwrap();

        let changed = poll_external_changes_inner(&state, TEST_OWNER).unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(
            serde_json::to_value(&changed[0]).unwrap(),
            expected_external_change(
                &tracking_key(&canonical_spelling),
                &[&canonical_spelling, &alternate_spelling],
            ),
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_unregister_deleted_symlink_alias_removes_canonical_tracked_entry() {
        let tmp = TempDir::new().unwrap();
        let real_dir = tmp.path().join("real project");
        fs::create_dir(&real_dir).unwrap();
        let alias_dir = tmp.path().join("alias project");
        std::os::unix::fs::symlink(&real_dir, &alias_dir).unwrap();

        let real_file = real_dir.join("chapter.md");
        let alias_file = alias_dir.join("chapter.md");
        fs::write(&real_file, "v0").unwrap();

        let state = FileWatcherState::new();
        track(&state, &alias_file);
        assert_eq!(state.inner.lock().unwrap().tracked_files.len(), 1);

        fs::remove_file(&real_file).unwrap();
        unregister_open_file_inner(&alias_file.to_string_lossy(), TEST_OWNER, &state).unwrap();

        assert!(
            state.inner.lock().unwrap().tracked_files.is_empty(),
            "unregister by deleted alias path must remove the stored canonical key"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_register_write_ignore_deleted_symlink_alias_suppresses_recreated_self_write() {
        let tmp = TempDir::new().unwrap();
        let real_dir = tmp.path().join("real project");
        fs::create_dir(&real_dir).unwrap();
        let alias_dir = tmp.path().join("alias project");
        std::os::unix::fs::symlink(&real_dir, &alias_dir).unwrap();

        let real_file = real_dir.join("chapter.md");
        let alias_file = alias_dir.join("chapter.md");
        fs::write(&real_file, "v0").unwrap();

        let state = FileWatcherState::new();
        track(&state, &alias_file);
        let canonical_key = tracking_key(&alias_file);

        fs::remove_file(&real_file).unwrap();
        assert_eq!(
            poll_external_changes_inner(&state, TEST_OWNER).unwrap(),
            vec![ExternalFileChangePayload {
                identity: canonical_key.to_string_lossy().to_string(),
                paths: vec![alias_file.to_string_lossy().to_string()],
            }]
        );

        register_expected_write_inner(
            &alias_file.to_string_lossy(),
            blake3::hash(b"saved by app after recreation"),
            &state,
            Some(TEST_OWNER),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&alias_file, "saved by app after recreation").unwrap();

        assert!(poll_external_changes_inner(&state, TEST_OWNER)
            .unwrap()
            .is_empty());
        let guard = state.inner.lock().unwrap();
        let entry = guard.tracked_files.get(&canonical_key).unwrap();
        assert_eq!(entry.hash, blake3::hash(b"saved by app after recreation"));
        assert!(!entry.deleted);
    }

    #[test]
    fn test_hash_file() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("test.txt");
        fs::write(&file, "hello world").unwrap();
        let h1 = hash_file(&file).unwrap();
        let h2 = hash_file(&file).unwrap();
        assert_eq!(h1, h2);

        fs::write(&file, "changed").unwrap();
        let h3 = hash_file(&file).unwrap();
        assert_ne!(h1, h3);
    }

    #[test]
    fn test_ignore_set() {
        let mut set = IgnoreSet::new();
        let p = PathBuf::from("/tmp/test.md");
        let expected = blake3::hash(b"expected");
        assert_eq!(set.take_owner(&p, expected), None);

        set.register(&p, expected, Some(TEST_OWNER));
        assert_eq!(set.take_owner(&p, blake3::hash(b"external")), None);
        assert_eq!(set.take_owner(&p, expected), None);
        set.register(&p, expected, Some(TEST_OWNER));
        assert_eq!(set.take_owner(&p, expected).as_deref(), Some(TEST_OWNER));
        assert_eq!(set.take_owner(&p, expected), None);

        set.register(&p, expected, None);
        assert_eq!(set.take_owner(&p, expected), None);
        set.register(&p, expected, Some(TEST_OWNER));
        set.entries.get_mut(&p).unwrap().registered_at = Instant::now() - Duration::from_secs(3);
        assert_eq!(set.take_owner(&p, expected), None);
    }

    #[test]
    fn test_file_watcher_state_new() {
        let state = FileWatcherState::new();
        let guard = state.inner.lock().unwrap();
        assert!(guard.watchers.is_empty());
        assert!(guard.tracked_files.is_empty());
        assert!(guard.watching_dirs.is_empty());
    }

    #[test]
    fn test_stop_file_watcher_clears_tracking_state() {
        let state = FileWatcherState::new();
        let path = PathBuf::from("/tmp/open.md");
        let (tx, _rx) = tokio::sync::oneshot::channel();
        {
            let mut guard = state.inner.lock().unwrap();
            guard
                .watching_dirs
                .insert(TEST_OWNER.to_string(), PathBuf::from("/tmp"));
            guard.cancel_txs.insert(TEST_OWNER.to_string(), tx);
            guard
                .ignore_set
                .register(&path, blake3::hash(b"content"), Some(TEST_OWNER));
            guard.tracked_files.insert(
                path.clone(),
                TrackedFile {
                    path: path.clone(),
                    aliases: HashMap::from([(
                        path.clone(),
                        HashSet::from([TEST_OWNER.to_string()]),
                    )]),
                    pending_poll_owners: HashSet::from([TEST_OWNER.to_string()]),
                    hash: blake3::hash(b"content"),
                    mtime: SystemTime::now(),
                    deleted: false,
                },
            );
        }

        stop_file_watcher_inner(TEST_OWNER, &state).unwrap();

        let mut guard = state.inner.lock().unwrap();
        assert!(guard.watchers.is_empty());
        assert!(guard.watching_dirs.is_empty());
        assert!(guard.cancel_txs.is_empty());
        assert!(guard.tracked_files.is_empty());
        assert_eq!(
            guard.ignore_set.take_owner(&path, blake3::hash(b"content")),
            None
        );
    }

    #[test]
    fn test_refresh_dir_for_file_path() {
        let root = PathBuf::from("/tmp/novelist");
        let file = root.join("sub").join("a.md");
        assert_eq!(refresh_dir_for_path(&file, &root), Some(root.join("sub")));
    }

    #[test]
    fn test_refresh_dir_for_watching_root() {
        let root = PathBuf::from("/tmp/novelist");
        assert_eq!(refresh_dir_for_path(&root, &root), Some(root.clone()));
    }

    #[test]
    fn test_normalize_event_path_rewrites_canonical_prefix() {
        // FSEvents canonical form (/private/var) -> frontend form (/var).
        let original = PathBuf::from("/var/folders/x/project");
        let canonical = PathBuf::from("/private/var/folders/x/project");
        let event = canonical.join("sub").join("a.md");
        assert_eq!(
            normalize_event_path(event, &canonical, &original),
            original.join("sub").join("a.md"),
        );
    }

    #[test]
    fn test_normalize_event_path_noop_when_roots_match() {
        let dir = PathBuf::from("/Users/me/project");
        let event = dir.join("a.md");
        assert_eq!(normalize_event_path(event.clone(), &dir, &dir), event,);
    }

    #[test]
    fn test_normalize_event_path_passes_through_unrelated_paths() {
        let original = PathBuf::from("/var/folders/x/project");
        let canonical = PathBuf::from("/private/var/folders/x/project");
        let outside = PathBuf::from("/somewhere/else/a.md");
        assert_eq!(
            normalize_event_path(outside.clone(), &canonical, &original),
            outside,
        );
    }

    #[test]
    fn test_refresh_dir_ignores_atomic_write_temp_file() {
        let root = PathBuf::from("/tmp/novelist");
        let temp = root.join("a.md.novelist-tmp");
        assert_eq!(refresh_dir_for_path(&temp, &root), None);
    }

    fn rename_paths(dir: &TempDir) -> (String, String) {
        (
            dir.path().join("old.md").to_string_lossy().to_string(),
            dir.path().join("new.md").to_string_lossy().to_string(),
        )
    }

    #[tokio::test]
    async fn test_register_rename_ignore_suppresses_both_paths_once() {
        let dir = TempDir::new().unwrap();
        let (old, new) = rename_paths(&dir);
        register_rename_ignore(old.clone(), new.clone()).await;
        assert!(take_rename_ignored(&old).await);
        assert!(take_rename_ignored(&new).await);
        // Second take returns false (already consumed)
        assert!(!take_rename_ignored(&old).await);
    }

    #[tokio::test]
    async fn test_failed_rename_clears_its_ignore_entries() {
        let dir = TempDir::new().unwrap();
        let (old, new) = rename_paths(&dir);
        register_rename_ignore(old.clone(), new.clone()).await;
        clear_rename_ignore(&old, &new).await;
        assert!(!take_rename_ignored(&old).await);
        assert!(!take_rename_ignored(&new).await);
    }

    #[tokio::test]
    async fn test_rename_ignore_entries_expire() {
        let dir = TempDir::new().unwrap();
        let (old, new) = rename_paths(&dir);
        register_rename_ignore(old.clone(), new.clone()).await;
        let expired = Instant::now() - RENAME_IGNORE_TTL - Duration::from_secs(1);
        RENAME_IGNORED.lock().await.insert(old.clone(), expired);
        // A stale entry never swallows a later real event.
        assert!(!take_rename_ignored(&old).await);
        assert!(take_rename_ignored(&new).await);
    }
}
