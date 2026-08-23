use crate::commands::settings::get_resolved_snapshot_config;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

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
    if !id.starts_with("snap-") || !id["snap-".len()..].chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::InvalidInput(format!(
            "Invalid snapshot ID: {}",
            id
        )));
    }
    Ok(())
}

/// Allowed extensions for snapshot
fn is_snapshot_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("md" | "markdown" | "txt" | "json" | "jsonl" | "csv")
    )
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

/// Delete a snapshot's local directory (best-effort; ignores missing).
async fn delete_local(snap_dir: &Path) {
    let _ = tokio::fs::remove_dir_all(snap_dir).await;
}

/// Sweep any `*.pending` directories left behind by a crashed previous run.
async fn cleanup_pending_dirs(base: &Path) {
    if let Ok(mut rd) = tokio::fs::read_dir(base).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            let p = e.path();
            if p.is_dir() && p.to_string_lossy().ends_with(".pending") {
                let _ = tokio::fs::remove_dir_all(&p).await;
            }
        }
    }
}

/// Copy the project's snapshot-eligible files into `dest_files_dir`.
/// Returns `(file_count, total_bytes)`.
async fn copy_project_files(
    project_dir: &str,
    dest_files_dir: &Path,
) -> Result<(usize, u64), AppError> {
    let mut file_count: usize = 0;
    let mut total_bytes: u64 = 0;

    for entry in WalkDir::new(project_dir).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();

        if !path.is_file() || !is_snapshot_file(path) {
            continue;
        }

        let relative = path
            .strip_prefix(project_dir)
            .map_err(|e| AppError::Custom(e.to_string()))?;

        // Skip hidden directories (like .novelist, .git, etc.)
        if relative
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        {
            continue;
        }
        let dest = dest_files_dir.join(relative);

        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let content = tokio::fs::read(path).await?;
        total_bytes += content.len() as u64;
        tokio::fs::write(&dest, &content).await?;
        file_count += 1;
    }
    Ok((file_count, total_bytes))
}

/// Create a named snapshot of the project's text files, enforcing retention.
///
/// Flow:
///  1. Resolve `max_count` / `min_interval_minutes` for this project.
///  2. Sweep stale `.pending` dirs left by a crashed run.
///  3. List existing snapshots (newest-first).
///  4. Rule B — if the newest snapshot is inside the interval, it becomes the
///     victim and is replaced rather than appended to.
///  5. Copy files into a `.pending` staging dir, then atomically rename it
///     into place, so a crash never leaves a half-written snapshot.
///  6. Delete the victim (rule B) or prune the oldest over the count cap.
pub async fn create_snapshot(project_dir: &str, name: &str) -> Result<SnapshotMeta, AppError> {
    let cfg = get_resolved_snapshot_config(project_dir).await;
    let max_count = cfg.max_count;
    let min_interval_secs = cfg.min_interval_minutes as u64 * 60;

    let base = snapshots_dir(project_dir);
    tokio::fs::create_dir_all(&base).await?;

    cleanup_pending_dirs(&base).await;

    let mut existing = list_snapshots(project_dir).await?; // newest-first

    // Rule B: replace the newest snapshot when it is still inside the window.
    // `min_interval_minutes = 0` disables replacement entirely.
    let now = now_secs();
    let victim: Option<SnapshotMeta> = if min_interval_secs > 0 {
        existing.first().and_then(|newest| {
            if now.saturating_sub(newest.timestamp) < min_interval_secs {
                Some(newest.clone())
            } else {
                None
            }
        })
    } else {
        None
    };

    // Stage into a `.pending` dir first so the final rename is atomic.
    let snap_id = format!("snap-{}", now);
    let pending_dir = base.join(format!("{}.pending", snap_id));
    let pending_files = pending_dir.join("files");
    tokio::fs::create_dir_all(&pending_files).await?;

    let (file_count, total_bytes) = copy_project_files(project_dir, &pending_files).await?;

    let meta = SnapshotMeta {
        id: snap_id.clone(),
        name: name.to_string(),
        timestamp: now,
        file_count,
        total_bytes,
    };
    let meta_json = serde_json::to_string_pretty(&meta)?;
    tokio::fs::write(pending_dir.join("metadata.json"), &meta_json).await?;

    let final_dir = base.join(&snap_id);
    tokio::fs::rename(&pending_dir, &final_dir).await?;

    // Only now — with the new snapshot durably in place — retire old ones.
    if let Some(v) = victim {
        delete_local(&base.join(&v.id)).await;
        #[cfg(feature = "sync")]
        try_delete_snapshot_remote(project_dir, &v.id).await;
        // A replacement keeps the count flat, so cap math must not see the victim.
        existing.retain(|s| s.id != v.id);
    } else {
        let new_count = existing.len() + 1;
        if new_count > max_count as usize {
            let to_prune = new_count - max_count as usize;
            // `existing` is newest-first, so the oldest sit at the tail.
            for old in existing.iter().rev().take(to_prune) {
                delete_local(&base.join(&old.id)).await;
                #[cfg(feature = "sync")]
                try_delete_snapshot_remote(project_dir, &old.id).await;
            }
        }
    }

    // WebDAV mirroring is best-effort — a failed upload never fails the snapshot.
    #[cfg(feature = "sync")]
    try_upload_snapshot(project_dir, &meta).await;

    Ok(meta)
}

/// List all snapshots for a project, sorted newest first.
pub async fn list_snapshots(project_dir: &str) -> Result<Vec<SnapshotMeta>, AppError> {
    let base = snapshots_dir(project_dir);
    if !base.exists() {
        return Ok(vec![]);
    }

    let mut snapshots = Vec::new();
    let mut entries = tokio::fs::read_dir(&base).await?;

    while let Some(entry) = entries.next_entry().await? {
        let p = entry.path();
        // `.pending` dirs are half-written stages, not snapshots.
        if !p.is_dir() || p.to_string_lossy().ends_with(".pending") {
            continue;
        }
        let meta_path = p.join("metadata.json");
        if meta_path.exists() {
            let content = tokio::fs::read_to_string(&meta_path).await?;
            if let Ok(meta) = serde_json::from_str::<SnapshotMeta>(&content) {
                snapshots.push(meta);
            }
        }
    }

    // Sort newest first
    snapshots.sort_by_key(|s| std::cmp::Reverse(s.timestamp));
    Ok(snapshots)
}

/// Restore a snapshot by overwriting project files with snapshot files.
pub async fn restore_snapshot(project_dir: &str, snapshot_id: &str) -> Result<(), AppError> {
    validate_snapshot_id(snapshot_id)?;
    let snap_dir = snapshots_dir(project_dir).join(snapshot_id);
    let files_dir = snap_dir.join("files");

    if !files_dir.exists() {
        return Err(AppError::Custom(format!(
            "Snapshot not found: {}",
            snapshot_id
        )));
    }

    let project_path = Path::new(project_dir);

    for entry in WalkDir::new(&files_dir).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let relative = path
            .strip_prefix(&files_dir)
            .map_err(|e| AppError::Custom(e.to_string()))?;
        let dest = project_path.join(relative);

        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let content = tokio::fs::read(path).await?;
        tokio::fs::write(&dest, &content).await?;
    }

    Ok(())
}

/// Delete a snapshot directory.
pub async fn delete_snapshot(project_dir: &str, snapshot_id: &str) -> Result<(), AppError> {
    validate_snapshot_id(snapshot_id)?;
    let snap_dir = snapshots_dir(project_dir).join(snapshot_id);
    if snap_dir.exists() {
        tokio::fs::remove_dir_all(&snap_dir).await?;
    }
    #[cfg(feature = "sync")]
    try_delete_snapshot_remote(project_dir, snapshot_id).await;
    Ok(())
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

    fn release(saved: Isolated) {
        for (key, value) in SEAMS
            .iter()
            .zip([saved.snapshots, saved.settings, saved.sync])
        {
            match value {
                Some(v) => unsafe { std::env::set_var(key, v) },
                None => unsafe { std::env::remove_var(key) },
            }
        }
        clear_test_clock();
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
}
