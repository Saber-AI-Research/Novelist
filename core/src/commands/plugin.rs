use crate::error::AppError;
use crate::models::plugin::{PluginInfo, PluginManifest, RegisteredCommandInfo};
use crate::services::plugin_host::sandbox::PluginHostState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{Manager, State};

/// Known built-in plugin IDs that ship with Novelist.
const BUILTIN_PLUGIN_IDS: &[&str] = &["canvas", "mindmap", "kanban"];

fn novelist_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("~"))
        .join(".novelist")
}

fn plugins_dir() -> PathBuf {
    novelist_dir().join("plugins")
}

fn plugin_settings_path() -> PathBuf {
    novelist_dir().join("plugin-settings.json")
}

// --- Plugin Settings Persistence ---

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct PluginSettings {
    /// Map of plugin_id -> enabled (true/false).
    enabled: HashMap<String, bool>,
}

async fn read_plugin_settings() -> PluginSettings {
    let path = plugin_settings_path();
    if !path.exists() {
        return PluginSettings::default();
    }
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => PluginSettings::default(),
    }
}

async fn write_plugin_settings(settings: &PluginSettings) -> Result<(), AppError> {
    let dir = novelist_dir();
    if !dir.exists() {
        tokio::fs::create_dir_all(&dir).await?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| AppError::Custom(format!("Failed to serialize plugin settings: {e}")))?;
    tokio::fs::write(plugin_settings_path(), json).await?;
    Ok(())
}

// --- Bundled Plugin Installation ---

/// Install bundled plugins to ~/.novelist/plugins/ if they don't already exist.
/// Bundled plugin assets are embedded via include_dir at compile time.
///
/// Startup-perf caveat: this used to re-read three manifests on every boot.
/// Now we cache a hash of the bundled version tuple in
/// `~/.novelist/plugins/.bundled-version` and skip the full scan when it
/// matches — the fast path touches one file instead of six.
async fn ensure_bundled_plugins(app_handle: &tauri::AppHandle) -> Result<(), AppError> {
    let target = plugins_dir();
    if !target.exists() {
        tokio::fs::create_dir_all(&target).await?;
    }

    // Bundled plugins are shipped in the Tauri resource directory under "bundled-plugins/"
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| AppError::Custom(format!("Failed to get resource dir: {e}")))?;
    let bundled_dir = resource_dir.join("bundled-plugins");

    if !bundled_dir.exists() {
        return Ok(());
    }

    // Compute the bundled-version fingerprint once. Used to skip redundant
    // manifest scans on warm starts.
    let version_cache_path = target.join(".bundled-version");
    let fingerprint = compute_bundled_fingerprint(&bundled_dir).await;

    if let Some(fp) = fingerprint.as_deref() {
        if let Ok(cached) = tokio::fs::read_to_string(&version_cache_path).await {
            if cached.trim() == fp {
                // Fast path — versions match, nothing to do.
                return Ok(());
            }
        }
    }

    for plugin_id in BUILTIN_PLUGIN_IDS {
        let src = bundled_dir.join(plugin_id);
        let dest = target.join(plugin_id);
        if !src.exists() {
            continue;
        }
        // Only install if the destination doesn't exist yet
        if dest.exists() {
            // Check if bundled version is newer
            let src_manifest = src.join("manifest.toml");
            let dest_manifest = dest.join("manifest.toml");
            if src_manifest.exists() && dest_manifest.exists() {
                if let (Ok(src_content), Ok(dest_content)) = (
                    tokio::fs::read_to_string(&src_manifest).await,
                    tokio::fs::read_to_string(&dest_manifest).await,
                ) {
                    if let (Ok(src_m), Ok(dest_m)) = (
                        toml::from_str::<PluginManifest>(&src_content),
                        toml::from_str::<PluginManifest>(&dest_content),
                    ) {
                        if src_m.plugin.version == dest_m.plugin.version {
                            continue;
                        }
                        // Bundled version differs, update it
                    }
                }
            } else {
                continue;
            }
        }
        copy_dir_recursive(&src, &dest).await?;
    }

    // Write the fingerprint so the next boot can hit the fast path.
    if let Some(fp) = fingerprint {
        let _ = tokio::fs::write(&version_cache_path, fp).await;
    }

    Ok(())
}

/// Produce a stable fingerprint of "which versions of the bundled plugins
/// are currently shipping." Reads one manifest.toml per bundled plugin and
/// joins the plugin_id/version pairs. Returns None if any read fails (in
/// which case we fall back to the legacy full-scan path, same as before).
async fn compute_bundled_fingerprint(bundled_dir: &PathBuf) -> Option<String> {
    let mut parts = Vec::with_capacity(BUILTIN_PLUGIN_IDS.len());
    for plugin_id in BUILTIN_PLUGIN_IDS {
        let manifest_path = bundled_dir.join(plugin_id).join("manifest.toml");
        if !manifest_path.exists() {
            continue;
        }
        let content = tokio::fs::read_to_string(&manifest_path).await.ok()?;
        let manifest: PluginManifest = toml::from_str(&content).ok()?;
        parts.push(format!("{}={}", plugin_id, manifest.plugin.version));
    }
    if parts.is_empty() {
        return None;
    }
    parts.sort();
    Some(parts.join("|"))
}

async fn copy_dir_recursive(src: &PathBuf, dest: &PathBuf) -> Result<(), AppError> {
    if !dest.exists() {
        tokio::fs::create_dir_all(dest).await?;
    }
    let mut entries = tokio::fs::read_dir(src).await?;
    while let Some(entry) = entries.next_entry().await? {
        let src_path = entry.path();
        let file_name = entry.file_name();
        let dest_path = dest.join(&file_name);

        // Skip node_modules, dist, .DS_Store
        let name = file_name.to_string_lossy();
        if name == "node_modules" || name == ".DS_Store" || name == "target" {
            continue;
        }

        if src_path.is_dir() {
            Box::pin(copy_dir_recursive(&src_path, &dest_path)).await?;
        } else {
            tokio::fs::copy(&src_path, &dest_path).await?;
        }
    }
    Ok(())
}

/// Scan ~/.novelist/plugins/ and return info for each plugin found.
#[tauri::command]
#[specta::specta]
pub async fn list_plugins(
    state: State<'_, PluginHostState>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<PluginInfo>, AppError> {
    // Ensure bundled plugins are installed
    ensure_bundled_plugins(&app_handle).await.ok();

    let dir = plugins_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }

    let settings = read_plugin_settings().await;
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
        let plugin_id = &manifest.plugin.id;
        let is_builtin = BUILTIN_PLUGIN_IDS.contains(&plugin_id.as_str());
        let is_active = loaded_ids.contains(plugin_id);
        // Default: builtin plugins are disabled, user plugins are disabled
        let is_enabled = settings.enabled.get(plugin_id).copied().unwrap_or(false);

        plugins.push(PluginInfo {
            id: manifest.plugin.id,
            name: manifest.plugin.name,
            version: manifest.plugin.version,
            permissions: manifest.plugin.permissions,
            active: is_active,
            ui: manifest.ui,
            description: manifest.plugin.description,
            author: manifest.plugin.author,
            icon: manifest.plugin.icon,
            builtin: is_builtin,
            enabled: is_enabled,
        });
    }

    // Sort: builtin first, then by name
    plugins.sort_by(|a, b| b.builtin.cmp(&a.builtin).then(a.name.cmp(&b.name)));

    Ok(plugins)
}

/// Enable or disable a plugin (persists to settings file).
/// When enabling, also loads the plugin. When disabling, unloads it.
#[tauri::command]
#[specta::specta]
pub async fn set_plugin_enabled(
    plugin_id: String,
    enabled: bool,
    state: State<'_, PluginHostState>,
) -> Result<(), AppError> {
    // Persist the setting
    let mut settings = read_plugin_settings().await;
    settings.enabled.insert(plugin_id.clone(), enabled);
    write_plugin_settings(&settings).await?;

    if enabled {
        // Load the plugin
        let plugin_dir = plugins_dir().join(&plugin_id);
        let manifest_path = plugin_dir.join("manifest.toml");
        let index_path = plugin_dir.join("index.js");

        if manifest_path.exists() && index_path.exists() {
            let manifest_content = tokio::fs::read_to_string(&manifest_path).await?;
            let manifest: PluginManifest = toml::from_str(&manifest_content)?;
            let source = tokio::fs::read_to_string(&index_path).await?;
            state
                .load_plugin(manifest, &source)
                .map_err(AppError::Custom)?;
        }
    } else {
        // Unload the plugin
        state.unload_plugin(&plugin_id).ok();
    }

    Ok(())
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

/// Unload then re-load a plugin from disk. Used to pick up edits to
/// `manifest.toml` / `index.js` without restarting the app.
#[tauri::command]
#[specta::specta]
pub async fn reload_plugin(
    plugin_id: String,
    state: State<'_, PluginHostState>,
) -> Result<(), AppError> {
    state.unload_plugin(&plugin_id).ok();

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

/// Return the absolute path of ~/.novelist/plugins/, creating it if missing.
#[tauri::command]
#[specta::specta]
pub async fn get_plugins_dir() -> Result<String, AppError> {
    let dir = plugins_dir();
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir.to_string_lossy().to_string())
}

/// Create a minimal plugin at ~/.novelist/plugins/<id>/ with manifest.toml + index.js.
/// ID must match `[a-z0-9][a-z0-9-]*`. display_name defaults to id.
#[tauri::command]
#[specta::specta]
pub async fn scaffold_plugin(
    id: String,
    display_name: Option<String>,
) -> Result<String, AppError> {
    // Manual validation (no regex dep): non-empty, starts with [a-z0-9], remaining chars [a-z0-9-].
    let valid = !id.is_empty()
        && id
            .chars()
            .next()
            .map(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            .unwrap_or(false)
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(AppError::InvalidInput(format!(
            "Plugin ID must match [a-z0-9][a-z0-9-]*, got '{id}'"
        )));
    }

    let plugins = plugins_dir();
    tokio::fs::create_dir_all(&plugins).await?;
    let dir = plugins.join(&id);
    if dir.exists() {
        return Err(AppError::InvalidInput(format!(
            "Plugin directory already exists: {}",
            dir.display()
        )));
    }

    let name = display_name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| id.clone());

    let manifest = format!(
        "id = \"{id}\"\n\
         name = \"{name}\"\n\
         version = \"0.1.0\"\n\
         author = \"\"\n\
         description = \"\"\n\
         permissions = []\n\
         entry = \"index.js\"\n"
    );
    let index_js = "// Minimal Novelist plugin - runs in QuickJS sandbox.\n\
export default {\n\
  activate(ctx) {\n\
    // ctx.registerCommand({ id: \"example\", title: \"Example\", run: () => {} });\n\
  }\n\
};\n";

    // Write to <id>.tmp then rename, so a partial failure doesn't leave a half-baked dir.
    let tmp = plugins.join(format!("{id}.tmp"));
    if tmp.exists() {
        tokio::fs::remove_dir_all(&tmp).await?;
    }
    tokio::fs::create_dir_all(&tmp).await?;
    tokio::fs::write(tmp.join("manifest.toml"), manifest).await?;
    tokio::fs::write(tmp.join("index.js"), index_js).await?;
    tokio::fs::rename(&tmp, &dir).await?;

    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::TempDir;

    // Tests that mutate HOME must not run concurrently (env is process-global).
    static HOME_MUTEX: Mutex<()> = Mutex::new(());

    // These tests mutate HOME to isolate the plugins_dir(). Run sequentially by
    // serializing through a single process mutex (tokio tests already serialize
    // when each test sets+restores HOME in a scoped manner).

    #[tokio::test]
    async fn test_scaffold_plugin_creates_files() {
        let _guard = HOME_MUTEX.lock().unwrap();
        let tmp = TempDir::new().unwrap();
        let old = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());

        let result = scaffold_plugin(
            "sentence-counter".to_string(),
            Some("Sentence Counter".into()),
        )
        .await
        .unwrap();
        assert!(result.ends_with("/.novelist/plugins/sentence-counter"));
        let dir = std::path::PathBuf::from(&result);
        assert!(dir.join("manifest.toml").is_file());
        assert!(dir.join("index.js").is_file());
        let manifest = std::fs::read_to_string(dir.join("manifest.toml")).unwrap();
        assert!(manifest.contains("id = \"sentence-counter\""));
        assert!(manifest.contains("name = \"Sentence Counter\""));

        if let Some(h) = old {
            std::env::set_var("HOME", h);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[tokio::test]
    async fn test_scaffold_plugin_rejects_invalid_id() {
        for bad in ["", "Foo", "foo bar", "_foo", "foo/bar", "-foo"] {
            let result = scaffold_plugin(bad.to_string(), None).await;
            assert!(result.is_err(), "expected error for id '{bad}'");
        }
    }

    #[tokio::test]
    async fn test_scaffold_plugin_rejects_duplicate() {
        let _guard = HOME_MUTEX.lock().unwrap();
        let tmp = TempDir::new().unwrap();
        let old = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());

        scaffold_plugin("dup".to_string(), None).await.unwrap();
        let second = scaffold_plugin("dup".to_string(), None).await;
        assert!(second.is_err());

        if let Some(h) = old {
            std::env::set_var("HOME", h);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[tokio::test]
    async fn test_scaffold_plugin_defaults_display_name_to_id() {
        let _guard = HOME_MUTEX.lock().unwrap();
        let tmp = TempDir::new().unwrap();
        let old = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());

        let result = scaffold_plugin("foo".to_string(), None).await.unwrap();
        let manifest =
            std::fs::read_to_string(std::path::Path::new(&result).join("manifest.toml")).unwrap();
        assert!(manifest.contains("name = \"foo\""));

        if let Some(h) = old {
            std::env::set_var("HOME", h);
        } else {
            std::env::remove_var("HOME");
        }
    }
}
