use crate::services::sync::{self, SyncConfig, SyncStatus};
use crate::services::webdav;
use crate::AppError;
use serde::Serialize;
use specta::Type;

#[derive(Debug, Serialize, Type)]
pub struct SyncConfigMasked {
    pub enabled: bool,
    pub webdav_url: String,
    pub username: String,
    pub password: String,
    pub interval_minutes: u32,
}

impl From<SyncConfig> for SyncConfigMasked {
    fn from(c: SyncConfig) -> Self {
        Self {
            enabled: c.enabled,
            webdav_url: c.webdav_url,
            username: c.username,
            password: "****".to_string(),
            interval_minutes: c.interval_minutes,
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_sync_config(project_dir: String) -> Result<SyncConfigMasked, AppError> {
    let config = sync::read_sync_config(&project_dir)?;
    Ok(config.into())
}

#[tauri::command]
#[specta::specta]
pub async fn save_sync_config(project_dir: String, config: SyncConfig) -> Result<(), AppError> {
    sync::save_sync_config_to_disk(&project_dir, &config)
}

#[tauri::command]
#[specta::specta]
pub async fn sync_now(project_dir: String) -> Result<SyncStatus, AppError> {
    sync::perform_sync(&project_dir).await
}

#[tauri::command]
#[specta::specta]
pub async fn test_sync_connection(
    webdav_url: String,
    username: String,
    password: String,
) -> Result<bool, AppError> {
    let client = reqwest::Client::new();
    let auth = webdav::WebDavAuth { username, password };
    webdav::test_connection(&client, &webdav_url, &auth).await
}
