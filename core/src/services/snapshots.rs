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

/// Returns `~/.novelist/snapshots/{blake3_hash_of_project_dir}/`
pub fn snapshots_dir(project_dir: &str) -> PathBuf {
    let hash = blake3::hash(project_dir.as_bytes()).to_hex();
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".novelist")
        .join("snapshots")
        .join(hash.to_string())
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

fn is_snapshot_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("md" | "markdown" | "txt" | "json" | "jsonl" | "csv")
    )
}

/// Seam for wall-clock time so tests can inject a fixed timestamp.
#[cfg(not(test))]
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Test-injectable clock. Defaults to real time; tests override via `set_test_clock`.
#[cfg(test)]
mod test_clock {
    use std::cell::Cell;
    thread_local! {
        static OVERRIDE: Cell<Option<u64>> = Cell::new(None);
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
async fn delete_local(snap_dir: &PathBuf) {
    let _ = tokio::fs::remove_dir_all(snap_dir).await;
}

/// Sweep any `*.pending` directories left by a crashed previous run.
async fn cleanup_pending_dirs(base: &PathBuf) {
    if let Ok(mut rd) = tokio::fs::read_dir(base).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            let p = e.path();
            if p.is_dir() {
                if p.to_string_lossy().ends_with(".pending") {
                    let _ = tokio::fs::remove_dir_all(&p).await;
                }
            }
        }
    }
}

/// Copy project files into `dest_files_dir`, returning (file_count, total_bytes).
async fn copy_project_files(
    project_dir: &str,
    dest_files_dir: &PathBuf,
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

/// Create a named snapshot with retention enforcement.
///
/// Flow:
///  1. Resolve max_count / min_interval_minutes for this project.
///  2. Sweep stale `.pending` dirs.
///  3. List existing snapshots (newest-first).
///  4. Determine whether the newest snapshot is within the interval (rule B).
///  5. Copy files into a `.pending` staging dir.
///  6. Atomic rename `.pending` → final snap dir.
///  7. Delete the victim (rule B) or prune the oldest (cap rule).
pub async fn create_snapshot(project_dir: &str, name: &str) -> Result<SnapshotMeta, AppError> {
    let cfg = get_resolved_snapshot_config(project_dir).await;
    let max_count = cfg.max_count;
    let min_interval_secs = cfg.min_interval_minutes as u64 * 60;

    let base = snapshots_dir(project_dir);
    tokio::fs::create_dir_all(&base).await?;

    cleanup_pending_dirs(&base).await;

    let mut existing = list_snapshots(project_dir).await?; // newest-first

    // Rule B: should we replace the newest snapshot?
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
        None // interval = 0 → never replace
    };

    // Stage into a .pending dir first (crash-safe).
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

    // Atomic rename: .pending → final
    let final_dir = base.join(&snap_id);
    tokio::fs::rename(&pending_dir, &final_dir).await?;

    // Now safe to delete victim or prune cap.
    if let Some(v) = victim {
        delete_local(&base.join(&v.id)).await;
        #[cfg(feature = "sync")]
        try_delete_snapshot_remote(project_dir, &v.id).await;
        // Remove victim from the existing list so cap math is correct.
        existing.retain(|s| s.id != v.id);
    } else {
        // Cap pruning: existing.len() + 1 (the new one) > max_count → prune oldest.
        let new_count = existing.len() + 1;
        if new_count > max_count as usize {
            let to_prune = new_count - max_count as usize;
            // existing is newest-first; oldest are at the end.
            for old in existing.iter().rev().take(to_prune) {
                delete_local(&base.join(&old.id)).await;
                #[cfg(feature = "sync")]
                try_delete_snapshot_remote(project_dir, &old.id).await;
            }
        }
    }

    // Upload to WebDAV (best-effort, non-fatal).
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
        // Ignore .pending dirs (incomplete) and non-dirs.
        if !p.is_dir() || p.to_string_lossy().ends_with(".pending") {
            continue;
        }
        let meta_path = p.join("metadata.json");
        if meta_path.exists() {
            let content = tokio::fs::read_to_string(&meta_path).await?;
            if let Ok(m) = serde_json::from_str::<SnapshotMeta>(&content) {
                snapshots.push(m);
            }
        }
    }

    snapshots.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
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
    use tempfile::TempDir;

    fn write_file(dir: &Path, name: &str, content: &str) {
        std::fs::write(dir.join(name), content).unwrap();
    }

    // ── original tests (unchanged behaviour) ─────────────────────────────────

    #[tokio::test]
    async fn test_snapshots_dir_is_deterministic() {
        let d1 = snapshots_dir("/home/user/novel");
        let d2 = snapshots_dir("/home/user/novel");
        assert_eq!(d1, d2);
    }

    #[tokio::test]
    async fn test_create_and_list_snapshot() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        write_file(dir.path(), "chapter1.md", "# Chapter 1");
        write_file(dir.path(), "notes.txt", "Some notes");
        std::fs::write(dir.path().join("image.png"), [0u8; 100]).unwrap();

        let meta = create_snapshot(&project, "First draft").await.unwrap();
        assert_eq!(meta.name, "First draft");
        assert_eq!(meta.file_count, 2);
        assert!(meta.id.starts_with("snap-"));

        let list = list_snapshots(&project).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, meta.id);
    }

    #[tokio::test]
    async fn test_restore_snapshot() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        write_file(dir.path(), "chapter1.md", "Original");
        let meta = create_snapshot(&project, "Before edit").await.unwrap();
        write_file(dir.path(), "chapter1.md", "Modified");
        restore_snapshot(&project, &meta.id).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("chapter1.md")).unwrap(),
            "Original"
        );
    }

    #[tokio::test]
    async fn test_delete_snapshot() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        write_file(dir.path(), "test.md", "content");
        let meta = create_snapshot(&project, "temp").await.unwrap();
        assert_eq!(list_snapshots(&project).await.unwrap().len(), 1);
        delete_snapshot(&project, &meta.id).await.unwrap();
        assert_eq!(list_snapshots(&project).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn test_list_empty() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        assert!(list_snapshots(&project).await.unwrap().is_empty());
    }

    // ── retention tests ───────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_create_within_interval_replaces_newest() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        write_file(dir.path(), "ch1.md", "v1");

        // First snapshot at t=1000
        set_test_clock(1000);
        let first = create_snapshot(&project, "first").await.unwrap();
        assert_eq!(first.timestamp, 1000);

        // Second snapshot at t=1001 (within 60-min default interval)
        set_test_clock(1001);
        let second = create_snapshot(&project, "second").await.unwrap();
        assert_eq!(second.timestamp, 1001);

        let list = list_snapshots(&project).await.unwrap();
        assert_eq!(list.len(), 1, "replace: count must stay at 1");
        assert_eq!(list[0].id, second.id, "newer snapshot must survive");

        // Verify the first snap dir is gone
        let base = snapshots_dir(&project);
        assert!(!base.join(&first.id).exists(), "victim dir must be deleted");
        clear_test_clock();
    }

    #[tokio::test]
    async fn test_create_outside_interval_appends() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        write_file(dir.path(), "ch1.md", "v1");

        set_test_clock(1000);
        create_snapshot(&project, "first").await.unwrap();

        // 3601 seconds later — outside 60-min default window
        set_test_clock(1000 + 3601);
        create_snapshot(&project, "second").await.unwrap();

        let list = list_snapshots(&project).await.unwrap();
        assert_eq!(list.len(), 2);
        clear_test_clock();
    }

    #[tokio::test]
    async fn test_prune_at_cap() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        write_file(dir.path(), "ch1.md", "v");

        // Write a project.toml with max_count = 3 so we don't hit the 100 default
        let novelist_dir = dir.path().join(".novelist");
        std::fs::create_dir_all(&novelist_dir).unwrap();
        std::fs::write(
            novelist_dir.join("project.toml"),
            "[project]\nname = \"T\"\n\n[snapshot]\nmax_count = 3\nmin_interval_minutes = 0\n",
        )
        .unwrap();

        // Create 5 snapshots spaced 3600s apart (interval = 0, so each appends)
        for i in 0u64..5 {
            set_test_clock(1000 + i * 3600);
            create_snapshot(&project, &format!("snap{i}")).await.unwrap();
        }

        let list = list_snapshots(&project).await.unwrap();
        assert_eq!(list.len(), 3, "should prune to cap=3");
        // Newest 3 should survive
        assert_eq!(list[0].timestamp, 1000 + 4 * 3600);
        assert_eq!(list[1].timestamp, 1000 + 3 * 3600);
        assert_eq!(list[2].timestamp, 1000 + 2 * 3600);
        clear_test_clock();
    }

    #[tokio::test]
    async fn test_replace_does_not_trigger_prune() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        write_file(dir.path(), "ch1.md", "v");

        let novelist_dir = dir.path().join(".novelist");
        std::fs::create_dir_all(&novelist_dir).unwrap();
        std::fs::write(
            novelist_dir.join("project.toml"),
            "[project]\nname = \"T\"\n\n[snapshot]\nmax_count = 3\n",
        )
        .unwrap();

        // Fill to cap with 3 snapshots (far apart)
        for i in 0u64..3 {
            set_test_clock(1000 + i * 7200);
            create_snapshot(&project, &format!("s{i}")).await.unwrap();
        }
        assert_eq!(list_snapshots(&project).await.unwrap().len(), 3);

        // 4th snapshot within 60-min interval of #3 → replace, NOT prune
        set_test_clock(1000 + 2 * 7200 + 30);
        create_snapshot(&project, "replace").await.unwrap();

        let list = list_snapshots(&project).await.unwrap();
        assert_eq!(list.len(), 3, "replace must not add beyond cap");
        clear_test_clock();
    }

    #[tokio::test]
    async fn test_min_interval_zero_never_replaces() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        write_file(dir.path(), "ch1.md", "v");

        let novelist_dir = dir.path().join(".novelist");
        std::fs::create_dir_all(&novelist_dir).unwrap();
        std::fs::write(
            novelist_dir.join("project.toml"),
            "[project]\nname = \"T\"\n\n[snapshot]\nmin_interval_minutes = 0\n",
        )
        .unwrap();

        set_test_clock(1000);
        create_snapshot(&project, "first").await.unwrap();
        set_test_clock(1001);
        create_snapshot(&project, "second").await.unwrap();

        // interval=0 means every create appends; both should survive
        assert_eq!(list_snapshots(&project).await.unwrap().len(), 2);
        clear_test_clock();
    }

    #[tokio::test]
    async fn test_pending_dir_cleaned_on_next_create() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().to_string_lossy().to_string();
        write_file(dir.path(), "ch1.md", "v");

        // Manually plant a stale .pending dir
        let base = snapshots_dir(&project);
        tokio::fs::create_dir_all(&base).await.unwrap();
        let stale = base.join("snap-999.pending");
        tokio::fs::create_dir_all(&stale).await.unwrap();

        set_test_clock(2000);
        create_snapshot(&project, "after crash").await.unwrap();

        // Stale pending dir must be gone
        assert!(!stale.exists(), "stale .pending must be cleaned up");
        // The real snapshot must exist
        assert_eq!(list_snapshots(&project).await.unwrap().len(), 1);
        clear_test_clock();
    }
}
