use crate::error::AppError;
use crate::services::snapshots::{self, SnapshotMeta};

#[tauri::command]
#[specta::specta]
pub async fn create_snapshot(project_dir: String, name: String) -> Result<SnapshotMeta, AppError> {
    snapshots::create_snapshot(&project_dir, &name).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_snapshots(project_dir: String) -> Result<Vec<SnapshotMeta>, AppError> {
    snapshots::list_snapshots(&project_dir).await
}

#[tauri::command]
#[specta::specta]
pub async fn restore_snapshot(project_dir: String, snapshot_id: String) -> Result<(), AppError> {
    snapshots::restore_snapshot(&project_dir, &snapshot_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_snapshot(project_dir: String, snapshot_id: String) -> Result<(), AppError> {
    snapshots::delete_snapshot(&project_dir, &snapshot_id).await
}
