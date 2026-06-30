use crate::error::AppError;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use specta::Type;
use std::collections::{HashMap, HashSet};
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

static RENAME_IGNORED: once_cell::sync::Lazy<
    tokio::sync::Mutex<std::collections::HashSet<String>>,
> = once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(std::collections::HashSet::new()));

/// Register both old and new paths as expected rename targets. The next FS
/// event for either path is consumed without forwarding to listeners.
pub async fn register_rename_ignore(old_path: String, new_path: String) {
    let mut set = RENAME_IGNORED.lock().await;
    set.insert(old_path);
    set.insert(new_path);
}

/// Returns true and removes the entry if `path` was registered as a
/// self-initiated rename target; otherwise returns false.
pub async fn take_rename_ignored(path: &str) -> bool {
    let mut set = RENAME_IGNORED.lock().await;
    set.remove(path)
}

// ── Tracked file ────────────────────────────────────────────────────

struct TrackedFile {
    #[allow(dead_code)]
    path: PathBuf,
    hash: blake3::Hash,
    #[allow(dead_code)]
    mtime: SystemTime,
}

// ── Ignore set (self-trigger suppression) ───────────────────────────

struct IgnoreSet {
    entries: HashMap<PathBuf, Instant>,
}

impl IgnoreSet {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    fn register(&mut self, path: &Path) {
        self.entries.insert(path.to_path_buf(), Instant::now());
    }

    fn should_ignore(&mut self, path: &Path) -> bool {
        if let Some(time) = self.entries.get(path) {
            if time.elapsed() < Duration::from_secs(2) {
                return true;
            }
            self.entries.remove(&path.to_path_buf());
        }
        false
    }
}

// ── Event payload ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Type)]
pub struct FileChangedPayload {
    pub path: String,
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
    watcher: Option<RecommendedWatcher>,
    tracked_files: HashMap<PathBuf, TrackedFile>,
    ignore_set: IgnoreSet,
    #[allow(dead_code)]
    watching_dir: Option<PathBuf>,
    /// Handle to cancel the debounce processor task
    cancel_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl FileWatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(FileWatcherInner {
                watcher: None,
                tracked_files: HashMap::new(),
                ignore_set: IgnoreSet::new(),
                watching_dir: None,
                cancel_tx: None,
            }),
        }
    }
}

// ── Helper: compute blake3 hash of a file ───────────────────────────

fn hash_file(path: &Path) -> Result<blake3::Hash, AppError> {
    let bytes = std::fs::read(path)?;
    Ok(blake3::hash(&bytes))
}

// ── Tauri commands ──────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn start_file_watcher(
    dir_path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, FileWatcherState>,
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

    // Create the notify watcher that sends paths into the channel
    let dir_for_events = dir.clone();
    let canonical_for_events = canonical_dir.clone();
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
        .watch(&canonical_dir, RecursiveMode::Recursive)
        .map_err(|e| AppError::Custom(format!("Failed to watch directory: {e}")))?;

    // Cancellation channel for the processor task
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();

    {
        let mut guard = state
            .inner
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        guard.watcher = Some(watcher);
        guard.watching_dir = Some(dir);
        guard.cancel_tx = Some(cancel_tx);
    }

    // Spawn debounce processor: collects events for 200ms then processes unique paths
    let app = app_handle.clone();
    tokio::spawn(async move {
        loop {
            // Wait for the first event or cancellation
            let first = tokio::select! {
                path = rx.recv() => match path {
                    Some(p) => p,
                    None => break, // channel closed
                },
                _ = &mut cancel_rx => break,
            };

            // Collect more events during the debounce window
            let mut events = Vec::new();
            events.push(first);

            let debounce = tokio::time::sleep(Duration::from_millis(200));
            tokio::pin!(debounce);

            loop {
                tokio::select! {
                    path = rx.recv() => match path {
                        Some(p) => { events.push(p); },
                        None => break,
                    },
                    _ = &mut debounce => break,
                }
            }

            // Suppress paths that were registered as self-initiated rename
            // targets. We do this BEFORE acquiring the sync mutex because
            // `take_rename_ignored` is async. Notify may emit a rename as
            // Modify/Create events on either old or new path depending on the
            // platform (FSEvents vs inotify vs ReadDirectoryChangesW), so we
            // filter every path conservatively.
            let mut filtered_paths: HashSet<PathBuf> = HashSet::new();
            let mut refresh_dirs: HashSet<PathBuf> = HashSet::new();
            for event in events {
                let key = event.path.to_string_lossy().to_string();
                if take_rename_ignored(&key).await {
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
                let _ = app.emit("directory-changed", &payload);
            }

            // Phase 1: under the lock, pick out tracked, non-ignored files and
            // snapshot their known hash. We do NOT hash on disk here — that's a
            // blocking read that would stall this Tokio worker and serialize
            // against register/unregister/stop while the lock is held.
            let watcher_state = app.state::<FileWatcherState>();
            let candidates: Vec<(PathBuf, blake3::Hash)> = {
                let mut guard = match watcher_state.inner.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                filtered_paths
                    .into_iter()
                    .filter(|p| p.is_file())
                    .filter_map(|p| {
                        if guard.ignore_set.should_ignore(&p) {
                            return None;
                        }
                        guard.tracked_files.get(&p).map(|t| (p, t.hash))
                    })
                    .collect()
            };

            // Phase 2: hash each candidate off-lock; keep the ones that changed.
            let changed: Vec<(PathBuf, blake3::Hash)> = candidates
                .into_iter()
                .filter_map(|(path, old_hash)| match hash_file(&path) {
                    Ok(new_hash) if new_hash != old_hash => Some((path, new_hash)),
                    _ => None,
                })
                .collect();

            // Phase 3: re-lock briefly to commit new hashes and emit events. Skip
            // any file unregistered in the meantime.
            if !changed.is_empty() {
                if let Ok(mut guard) = watcher_state.inner.lock() {
                    for (path, new_hash) in changed {
                        if let Some(entry) = guard.tracked_files.get_mut(&path) {
                            entry.hash = new_hash;
                            entry.mtime = SystemTime::now();
                            let payload = FileChangedPayload {
                                path: path.to_string_lossy().to_string(),
                            };
                            let _ = app.emit("file-changed", &payload);
                        }
                    }
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn stop_file_watcher(state: tauri::State<'_, FileWatcherState>) -> Result<(), AppError> {
    stop_file_watcher_inner(&state)
}

fn stop_file_watcher_inner(state: &FileWatcherState) -> Result<(), AppError> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|e| AppError::Custom(e.to_string()))?;
    // Drop the watcher to stop OS-level watching and clear per-project open
    // file state. The frontend re-registers open files after a new project is
    // opened.
    guard.watcher = None;
    guard.watching_dir = None;
    guard.tracked_files.clear();
    guard.ignore_set = IgnoreSet::new();
    // Signal the processor task to stop
    if let Some(tx) = guard.cancel_tx.take() {
        let _ = tx.send(());
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn register_open_file(
    path: String,
    state: tauri::State<'_, FileWatcherState>,
) -> Result<(), AppError> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(AppError::FileNotFound(path));
    }

    let hash = hash_file(&p)?;
    let mtime = std::fs::metadata(&p)?.modified()?;

    let mut guard = state
        .inner
        .lock()
        .map_err(|e| AppError::Custom(e.to_string()))?;
    guard.tracked_files.insert(
        p.clone(),
        TrackedFile {
            path: p,
            hash,
            mtime,
        },
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn unregister_open_file(
    path: String,
    state: tauri::State<'_, FileWatcherState>,
) -> Result<(), AppError> {
    let p = PathBuf::from(&path);
    let mut guard = state
        .inner
        .lock()
        .map_err(|e| AppError::Custom(e.to_string()))?;
    guard.tracked_files.remove(&p);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn register_write_ignore(
    path: String,
    state: tauri::State<'_, FileWatcherState>,
) -> Result<(), AppError> {
    let p = PathBuf::from(&path);
    let mut guard = state
        .inner
        .lock()
        .map_err(|e| AppError::Custom(e.to_string()))?;
    guard.ignore_set.register(&p);
    Ok(())
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
/// cost one `stat` each. Self-writes are absorbed via the same 2s `ignore_set`
/// the watcher uses — as long as the poll interval is shorter than that window,
/// a save is hashed-and-suppressed (its new hash committed) before the window
/// expires, so it never surfaces as a spurious external change.
#[tauri::command]
#[specta::specta]
pub async fn poll_external_changes(
    state: tauri::State<'_, FileWatcherState>,
) -> Result<Vec<String>, AppError> {
    poll_external_changes_inner(&state)
}

fn poll_external_changes_inner(state: &FileWatcherState) -> Result<Vec<String>, AppError> {
    // Snapshot tracked (path, hash, mtime) under the lock; release before IO.
    let snapshot: Vec<(PathBuf, blake3::Hash, SystemTime)> = {
        let guard = state
            .inner
            .lock()
            .map_err(|e| AppError::Custom(e.to_string()))?;
        guard
            .tracked_files
            .iter()
            .map(|(p, t)| (p.clone(), t.hash, t.mtime))
            .collect()
    };

    // Off-lock: stat-gate, then hash only the files whose mtime moved.
    let mut candidates: Vec<(PathBuf, blake3::Hash, SystemTime)> = Vec::new();
    for (path, _old_hash, old_mtime) in snapshot {
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let new_mtime = meta.modified().unwrap_or(old_mtime);
        if new_mtime == old_mtime {
            continue;
        }
        let Ok(new_hash) = hash_file(&path) else { continue };
        candidates.push((path, new_hash, new_mtime));
    }
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    // Re-lock briefly: commit new hash/mtime, suppress self-writes, collect the
    // genuinely-changed paths to report.
    let mut changed = Vec::new();
    let mut guard = state
        .inner
        .lock()
        .map_err(|e| AppError::Custom(e.to_string()))?;
    for (path, new_hash, new_mtime) in candidates {
        let content_changed = {
            let Some(entry) = guard.tracked_files.get_mut(&path) else { continue };
            let changed = new_hash != entry.hash;
            entry.hash = new_hash;
            entry.mtime = new_mtime;
            changed
        };
        if !content_changed {
            continue; // mtime moved but bytes identical (e.g. touch)
        }
        if guard.ignore_set.should_ignore(&path) {
            continue; // our own recent write
        }
        changed.push(path.to_string_lossy().to_string());
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// End-to-end probe of the OS watcher + debounce + hash pipeline (minus the
    /// Tauri emit). Mirrors `start_file_watcher`: recursive notify watch on the
    /// CANONICAL dir → 200ms debounce → `normalize_event_path` back to the
    /// original prefix → blake3 diff.
    ///
    /// Critically, the watch root (`original_dir`) is a SYMLINK and all writes
    /// go through the symlinked path — exactly the macOS case (project under
    /// /tmp, /var, an external mount, or iCloud "Desktop & Documents") that made
    /// external edits silently require a manual reload. Before the fix (watching
    /// the symlinked path), FSEvents delivered canonical paths that notify
    /// dropped, so ZERO edits were detected. Guards that regression.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_watcher_detects_rapid_external_edits() {
        let tmp = TempDir::new().unwrap();
        let real_dir = tmp.path().canonicalize().unwrap();
        // A symlink that points at the real project dir, used as the watch root
        // and for every write — i.e. the path the frontend passed in.
        let original_dir = tmp.path().parent().unwrap().join("novelist-link");
        let _ = fs::remove_file(&original_dir);
        std::os::unix::fs::symlink(&real_dir, &original_dir).unwrap();

        // Production: watch the canonical dir, normalize events back to original.
        let canonical_dir = original_dir.canonicalize().unwrap();
        assert_ne!(canonical_dir, original_dir, "test needs a real symlink");

        let dir = canonical_dir.clone();
        // The file path the frontend tracks is the ORIGINAL (symlinked) form.
        let file = original_dir.join("note.md");
        fs::write(&file, "v0").unwrap();
        let mut tracked = blake3::hash(b"v0");

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();
        let canonical_for_events = canonical_dir.clone();
        let original_for_events = original_dir.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: Result<notify::Event, notify::Error>| {
                if let Ok(event) = res {
                    if let notify::EventKind::Any
                    | notify::EventKind::Modify(_)
                    | notify::EventKind::Create(_)
                    | notify::EventKind::Remove(_) = event.kind
                    {
                        for path in event.paths {
                            // Same rewrite as production: canonical → original.
                            let path = normalize_event_path(
                                path,
                                &canonical_for_events,
                                &original_for_events,
                            );
                            let _ = tx.send(path);
                        }
                    }
                }
            },
            notify::Config::default(),
        )
        .unwrap();
        watcher.watch(&dir, RecursiveMode::Recursive).unwrap();

        // Collected detections (path, new content).
        let detections = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let det = detections.clone();
        let file_for_task = file.clone();
        let processor = tokio::spawn(async move {
            loop {
                let first = match tokio::time::timeout(Duration::from_millis(1500), rx.recv()).await
                {
                    Ok(Some(p)) => p,
                    _ => break, // idle past timeout → burst done
                };
                let mut paths: HashSet<PathBuf> = HashSet::new();
                paths.insert(first);
                let debounce = tokio::time::sleep(Duration::from_millis(200));
                tokio::pin!(debounce);
                loop {
                    tokio::select! {
                        p = rx.recv() => match p { Some(p) => { paths.insert(p); }, None => break },
                        _ = &mut debounce => break,
                    }
                }
                for p in paths {
                    if p != file_for_task || !p.is_file() {
                        continue;
                    }
                    if let Ok(new_hash) = hash_file(&p) {
                        if new_hash != tracked {
                            tracked = new_hash;
                            let content = fs::read_to_string(&p).unwrap_or_default();
                            det.lock().unwrap().push(content);
                        }
                    }
                }
            }
        });

        // Let the FSEvents stream warm up before the first write.
        tokio::time::sleep(Duration::from_millis(300)).await;

        // 20 rapid in-place edits, ~30ms apart (faster than the debounce window
        // so many coalesce — we only require the LAST state to be detected).
        for i in 1..=20u32 {
            fs::write(&file, format!("v{i}")).unwrap();
            tokio::time::sleep(Duration::from_millis(30)).await;
        }

        // Wait for the processor to drain and idle out.
        let _ = tokio::time::timeout(Duration::from_secs(3), processor).await;

        let seen = detections.lock().unwrap().clone();
        assert!(
            !seen.is_empty(),
            "watcher detected ZERO external edits — auto-reload would never fire"
        );
        assert_eq!(
            seen.last().map(String::as_str),
            Some("v20"),
            "final external content not detected; saw sequence: {seen:?}"
        );
    }

    fn track(state: &FileWatcherState, path: &Path) {
        let hash = hash_file(path).unwrap();
        let mtime = fs::metadata(path).unwrap().modified().unwrap();
        state.inner.lock().unwrap().tracked_files.insert(
            path.to_path_buf(),
            TrackedFile {
                path: path.to_path_buf(),
                hash,
                mtime,
            },
        );
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
        assert!(poll_external_changes_inner(&state).unwrap().is_empty());

        // External edit (distinct mtime — filesystems are second/ms-granular).
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&file, "external edit").unwrap();

        let changed = poll_external_changes_inner(&state).unwrap();
        assert_eq!(changed, vec![file.to_string_lossy().to_string()]);

        // A second poll with no further change reports nothing (hash committed).
        assert!(poll_external_changes_inner(&state).unwrap().is_empty());
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
        state.inner.lock().unwrap().ignore_set.register(&file);
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&file, "saved by app").unwrap();

        // Suppressed (within the 2s ignore window) — and the new hash is
        // committed, so the next poll stays quiet too.
        assert!(poll_external_changes_inner(&state).unwrap().is_empty());
        assert!(poll_external_changes_inner(&state).unwrap().is_empty());
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
        assert!(!set.should_ignore(&p));

        set.register(&p);
        assert!(set.should_ignore(&p));
    }

    #[test]
    fn test_file_watcher_state_new() {
        let state = FileWatcherState::new();
        let guard = state.inner.lock().unwrap();
        assert!(guard.watcher.is_none());
        assert!(guard.tracked_files.is_empty());
        assert!(guard.watching_dir.is_none());
    }

    #[test]
    fn test_stop_file_watcher_clears_tracking_state() {
        let state = FileWatcherState::new();
        let path = PathBuf::from("/tmp/open.md");
        let (tx, _rx) = tokio::sync::oneshot::channel();
        {
            let mut guard = state.inner.lock().unwrap();
            guard.watching_dir = Some(PathBuf::from("/tmp"));
            guard.cancel_tx = Some(tx);
            guard.ignore_set.register(&path);
            guard.tracked_files.insert(
                path.clone(),
                TrackedFile {
                    path: path.clone(),
                    hash: blake3::hash(b"content"),
                    mtime: SystemTime::now(),
                },
            );
        }

        stop_file_watcher_inner(&state).unwrap();

        let mut guard = state.inner.lock().unwrap();
        assert!(guard.watcher.is_none());
        assert!(guard.watching_dir.is_none());
        assert!(guard.cancel_tx.is_none());
        assert!(guard.tracked_files.is_empty());
        assert!(!guard.ignore_set.should_ignore(&path));
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
        assert_eq!(
            normalize_event_path(event.clone(), &dir, &dir),
            event,
        );
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

    #[tokio::test]
    async fn test_register_rename_ignore_suppresses_both_paths() {
        let old = "/tmp/test_register_rename_ignore_foo.md".to_string();
        let new = "/tmp/test_register_rename_ignore_bar.md".to_string();
        register_rename_ignore(old.clone(), new.clone()).await;
        assert!(take_rename_ignored(&old).await);
        assert!(take_rename_ignored(&new).await);
        // Second take returns false (already consumed)
        assert!(!take_rename_ignored(&old).await);
    }

    #[tokio::test]
    async fn test_register_rename_ignore_unknown_path_returns_false() {
        let unknown = "/tmp/test_register_rename_ignore_unknown_xyz.md".to_string();
        // Ensure clean state if a previous test leaked (shared static).
        let _ = take_rename_ignored(&unknown).await;
        assert!(!take_rename_ignored(&unknown).await);
    }
}
