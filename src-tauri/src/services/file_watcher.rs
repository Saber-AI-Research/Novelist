use crate::error::AppError;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::{Emitter, Manager};

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
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();

    // Create the notify watcher that sends paths into the channel
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                // Only care about modify/create events
                match event.kind {
                    notify::EventKind::Modify(_) | notify::EventKind::Create(_) => {
                        for path in event.paths {
                            let _ = tx.send(path);
                        }
                    }
                    _ => {}
                }
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| AppError::Custom(format!("Failed to create file watcher: {e}")))?;

    watcher
        .watch(&dir, RecursiveMode::Recursive)
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
            let mut paths = HashSet::new();
            paths.insert(first);

            let debounce = tokio::time::sleep(Duration::from_millis(200));
            tokio::pin!(debounce);

            loop {
                tokio::select! {
                    path = rx.recv() => match path {
                        Some(p) => { paths.insert(p); },
                        None => break,
                    },
                    _ = &mut debounce => break,
                }
            }

            // Process collected paths
            let watcher_state = app.state::<FileWatcherState>();
            let mut guard = match watcher_state.inner.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };

            for path in paths {
                if !path.is_file() {
                    continue;
                }

                if guard.ignore_set.should_ignore(&path) {
                    continue;
                }

                let tracked = match guard.tracked_files.get(&path) {
                    Some(t) => t,
                    None => continue,
                };

                let new_hash = match hash_file(&path) {
                    Ok(h) => h,
                    Err(_) => continue,
                };

                if new_hash != tracked.hash {
                    let payload = FileChangedPayload {
                        path: path.to_string_lossy().to_string(),
                    };
                    let _ = app.emit("file-changed", &payload);

                    if let Some(entry) = guard.tracked_files.get_mut(&path) {
                        entry.hash = new_hash;
                        entry.mtime = SystemTime::now();
                    }
                }
            }
        }
    });

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn stop_file_watcher(
    state: tauri::State<'_, FileWatcherState>,
) -> Result<(), AppError> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|e| AppError::Custom(e.to_string()))?;
    // Drop the watcher to stop OS-level watching
    guard.watcher = None;
    guard.watching_dir = None;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

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
}
