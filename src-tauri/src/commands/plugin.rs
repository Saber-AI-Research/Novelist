use crate::error::AppError;
use crate::models::plugin::{PluginInfo, PluginManifest, RegisteredCommandInfo};
use crate::services::plugin_host::sandbox::PluginHostState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use tauri::State;

fn plugins_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("~"))
        .join(".novelist")
        .join("plugins")
}

/// Scan ~/.novelist/plugins/ and return info for each plugin found.
#[tauri::command]
#[specta::specta]
pub async fn list_plugins(state: State<'_, PluginHostState>) -> Result<Vec<PluginInfo>, AppError> {
    let dir = plugins_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }

    let loaded = state.list_loaded_plugins();
    let loaded_ids: std::collections::HashSet<String> =
        loaded.iter().map(|p| p.id.clone()).collect();

    let mut plugins = Vec::new();

    let mut entries = tokio::fs::read_dir(&dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.toml");
        if !manifest_path.exists() {
            continue;
        }
        let content = match tokio::fs::read_to_string(&manifest_path).await {
            Ok(c) => c,
            Err(_) => continue,
        };
        let manifest: PluginManifest = match toml::from_str(&content) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_active = loaded_ids.contains(&manifest.plugin.id);
        plugins.push(PluginInfo {
            id: manifest.plugin.id,
            name: manifest.plugin.name,
            version: manifest.plugin.version,
            permissions: manifest.plugin.permissions,
            active: is_active,
            ui: manifest.ui,
        });
    }

    Ok(plugins)
}

/// Load and activate a plugin by its ID.
#[tauri::command]
#[specta::specta]
pub async fn load_plugin(
    plugin_id: String,
    state: State<'_, PluginHostState>,
) -> Result<(), AppError> {
    let plugin_dir = plugins_dir().join(&plugin_id);
    let manifest_path = plugin_dir.join("manifest.toml");
    let index_path = plugin_dir.join("index.js");

    if !manifest_path.exists() {
        return Err(AppError::FileNotFound(format!(
            "Plugin manifest not found: {}",
            manifest_path.display()
        )));
    }
    if !index_path.exists() {
        return Err(AppError::FileNotFound(format!(
            "Plugin entry point not found: {}",
            index_path.display()
        )));
    }

    let manifest_content = tokio::fs::read_to_string(&manifest_path).await?;
    let manifest: PluginManifest = toml::from_str(&manifest_content)?;

    let source = tokio::fs::read_to_string(&index_path).await?;

    state
        .load_plugin(manifest, &source)
        .map_err(AppError::Custom)?;

    Ok(())
}

/// Unload (deactivate) a plugin.
#[tauri::command]
#[specta::specta]
pub async fn unload_plugin(
    plugin_id: String,
    state: State<'_, PluginHostState>,
) -> Result<(), AppError> {
    state.unload_plugin(&plugin_id).map_err(AppError::Custom)?;
    Ok(())
}

/// Get all commands registered by active plugins.
#[tauri::command]
#[specta::specta]
pub async fn get_plugin_commands(
    state: State<'_, PluginHostState>,
) -> Result<Vec<RegisteredCommandInfo>, AppError> {
    Ok(state.get_registered_commands())
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct PluginReplacementResult {
    pub from: usize,
    pub to: usize,
    pub text: String,
}

/// Execute a registered plugin command. Returns any text replacements the plugin wants to make.
#[tauri::command]
#[specta::specta]
pub async fn invoke_plugin_command(
    plugin_id: String,
    command_id: String,
    state: State<'_, PluginHostState>,
) -> Result<Vec<PluginReplacementResult>, AppError> {
    let replacements = state
        .invoke_command(&plugin_id, &command_id)
        .map_err(AppError::Custom)?;

    Ok(replacements
        .into_iter()
        .map(|r| PluginReplacementResult {
            from: r.from,
            to: r.to,
            text: r.text,
        })
        .collect())
}

/// Update the document state that plugins can read.
#[tauri::command]
#[specta::specta]
pub async fn set_plugin_document_state(
    content: String,
    selection_from: u32,
    selection_to: u32,
    word_count: u32,
    state: State<'_, PluginHostState>,
) -> Result<(), AppError> {
    state.set_document_state(
        content,
        selection_from as usize,
        selection_to as usize,
        word_count as usize,
    );
    Ok(())
}
