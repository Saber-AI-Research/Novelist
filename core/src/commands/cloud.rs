//! IPC for the device's cloud account (`services::cloud`). No command
//! accepts a stored password back from, or returns one to, the WebView.

use crate::commands::sync::blocking;
use crate::services::cloud::{
    self, CloudAccountStatus, CloudAccountSummary, CloudDisconnect, CloudDownload,
    CloudProjectBinding, CloudProjectList,
};
use crate::services::portable;
use crate::AppError;
use std::path::PathBuf;

#[tauri::command]
#[specta::specta]
pub async fn get_cloud_account() -> Result<CloudAccountSummary, AppError> {
    blocking(cloud::get_account).await
}

/// Re-test the stored credential against the server.
#[tauri::command]
#[specta::specta]
pub async fn check_cloud_account() -> Result<CloudAccountStatus, AppError> {
    cloud::check_account().await
}

/// Validates the URL and authenticates before anything is stored.
#[tauri::command]
#[specta::specta]
pub async fn connect_cloud_account(
    endpoint: String,
    username: String,
    password: String,
) -> Result<CloudAccountSummary, AppError> {
    cloud::connect(&endpoint, &username, password).await
}

/// Forgets the account on this device; no local or remote file is deleted.
#[tauri::command]
#[specta::specta]
pub async fn disconnect_cloud_account() -> Result<CloudDisconnect, AppError> {
    cloud::disconnect().await
}

#[tauri::command]
#[specta::specta]
pub async fn list_cloud_projects() -> Result<CloudProjectList, AppError> {
    let library = portable::library_root().ok();
    cloud::list_projects(library).await
}

/// Mobile downloads into the project library (`parent_dir` must be `null`);
/// desktop has no library and needs a destination folder chosen by the user.
#[tauri::command]
#[specta::specta]
pub async fn download_cloud_project(
    project_id: String,
    parent_dir: Option<String>,
) -> Result<CloudDownload, AppError> {
    let parent: PathBuf = match (portable::library_root(), parent_dir) {
        (Ok(library), None) => library.to_path_buf(),
        (Ok(_), Some(_)) => {
            return Err(AppError::InvalidInput(
                "Cloud projects are downloaded into the project library".into(),
            ))
        }
        (Err(_), Some(parent)) => PathBuf::from(parent),
        (Err(_), None) => {
            return Err(AppError::InvalidInput(
                "Choose a folder to download the project into".into(),
            ))
        }
    };
    cloud::download_project(&project_id, &parent).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_cloud_project_binding(
    project_dir: String,
) -> Result<CloudProjectBinding, AppError> {
    blocking(move || cloud::project_binding(&project_dir)).await
}

/// Link a project to the connected account and turn its sync on.
#[tauri::command]
#[specta::specta]
pub async fn bind_cloud_project(
    project_dir: String,
    interval_minutes: u32,
) -> Result<CloudProjectBinding, AppError> {
    cloud::bind_project(&project_dir, interval_minutes).await
}

#[tauri::command]
#[specta::specta]
pub async fn unbind_cloud_project(project_dir: String) -> Result<CloudProjectBinding, AppError> {
    cloud::unbind_project(&project_dir).await
}
