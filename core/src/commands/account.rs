use crate::error::AppError;
use crate::services::account::{self, AccountSummary};
use serde_json::Value;

// Registered directly with Tauri. Opaque JSON intentionally stays outside the
// generated Specta bindings; account-native.ts owns this small IPC surface.
#[tauri::command]
pub async fn account_status() -> Result<Option<AccountSummary>, AppError> {
    account::status().await
}

#[tauri::command]
pub async fn account_authenticate(
    endpoint: String,
    username: String,
    password: String,
    device_name: String,
    register: bool,
) -> Result<AccountSummary, AppError> {
    account::authenticate(endpoint, username, password, device_name, register).await
}

#[tauri::command]
pub async fn account_request(method: String, path: String, body: Option<Value>) -> Result<Value, AppError> {
    account::request(method, path, body).await
}

#[tauri::command]
pub async fn account_forget() -> Result<(), AppError> {
    account::forget().await
}

#[tauri::command]
pub async fn account_recovery_key(value: Option<String>) -> Result<Option<String>, AppError> {
    account::recovery_key(value).await
}

#[tauri::command]
pub async fn account_load_state() -> Result<Option<String>, AppError> {
    account::load_state().await
}

#[tauri::command]
pub async fn account_save_state(value: String) -> Result<(), AppError> {
    account::save_state(value).await
}
