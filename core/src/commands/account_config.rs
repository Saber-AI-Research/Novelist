use crate::services::account_config;
use crate::AppError;

#[tauri::command]
pub async fn account_config_get_secret(key: String) -> Result<Option<String>, AppError> {
    account_config::get_secret(&key).await
}

#[tauri::command]
pub async fn account_config_set_secret(key: String, value: Option<String>) -> Result<(), AppError> {
    account_config::set_secret(&key, value.as_deref()).await
}

#[tauri::command]
pub async fn account_config_journal(
    value: Option<String>,
    clear: bool,
) -> Result<Option<String>, AppError> {
    account_config::journal(value, clear).await
}

#[cfg(feature = "sync")]
#[tauri::command]
pub async fn account_config_webdav(
    include_secrets: bool,
) -> Result<Option<crate::services::cloud::CloudConfiguration>, AppError> {
    crate::services::cloud::capture_configuration(include_secrets).await
}

#[cfg(feature = "sync")]
#[tauri::command]
pub async fn account_config_restore_webdav(
    configuration: Option<crate::services::cloud::CloudConfiguration>,
    preserve_password: Option<bool>,
) -> Result<(), AppError> {
    crate::services::cloud::restore_configuration(configuration, preserve_password.unwrap_or(false))
        .await
}

#[cfg(feature = "sync")]
#[tauri::command]
pub async fn account_config_remove_restored_webdav() -> Result<(), AppError> {
    crate::services::cloud::remove_restored_configuration().await
}
