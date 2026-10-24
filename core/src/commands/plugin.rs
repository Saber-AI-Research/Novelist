use crate::error::AppError;
use crate::models::plugin::{PluginInfo, PluginManifest, PluginMeta, RegisteredCommandInfo};
use crate::services::atomic_file::atomic_write_sync;
use crate::services::plugin_host::sandbox::PluginHostState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};

fn novelist_dir() -> PathBuf {
    // `NOVELIST_PLUGIN_DATA_DIR` is a test seam (used by unit tests that need
    // per-test isolation). Production code goes through `portable::novelist_home`.
    #[cfg(test)]
    {
        if let Ok(p) = std::env::var("NOVELIST_PLUGIN_DATA_DIR") {
            if !p.is_empty() {
                return PathBuf::from(p);
            }
        }
    }
    crate::services::portable::novelist_home().to_path_buf()
}

fn plugins_dir() -> PathBuf {
    novelist_dir().join("plugins")
}

fn plugin_settings_path() -> PathBuf {
    novelist_dir().join("plugin-settings.json")
}

// --- Plugin identity ---

/// Plugin ids double as folder names under `plugins_dir()` and as host keys:
/// `[a-z0-9][a-z0-9-]*`, so an id can never name a path outside that folder.
fn validate_plugin_id(id: &str) -> Result<(), AppError> {
    let valid = id
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if valid {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!(
            "Plugin ID must match [a-z0-9][a-z0-9-]*, got '{id}'"
        )))
    }
}

/// `ui.entry` is joined to the plugin folder to build the iframe URL, so it
/// must be a relative path of plain components that stays inside that folder.
fn validate_ui_entry(entry: &str) -> Result<(), AppError> {
    let escapes = entry.is_empty()
        || entry.contains(['\\', ':', '\0'])
        || entry
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..");
    if escapes {
        return Err(AppError::InvalidInput(format!(
            "Plugin ui.entry must be a relative path inside the plugin folder, got '{entry}'"
        )));
    }
    Ok(())
}

/// A manifest may only describe the folder it lives in: a plugin cannot claim
/// another plugin's (or a built-in's) id, nor point its UI outside its folder.
fn validate_manifest(manifest: &PluginManifest, folder: &str) -> Result<(), AppError> {
    if manifest.plugin.id != folder {
        return Err(AppError::InvalidInput(format!(
            "Plugin manifest id '{}' must match its folder name '{folder}'",
            manifest.plugin.id
        )));
    }
    if let Some(ui) = &manifest.ui {
        validate_ui_entry(&ui.entry)?;
    }
    Ok(())
}

async fn read_plugin_manifest(plugin_dir: &Path, folder: &str) -> Result<PluginManifest, AppError> {
    let manifest_path = plugin_dir.join("manifest.toml");
    let content = match tokio::fs::read_to_string(&manifest_path).await {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::FileNotFound(format!(
                "Plugin manifest not found: {}",
                manifest_path.display()
            )))
        }
        Err(error) => return Err(error.into()),
    };
    let manifest: PluginManifest = toml::from_str(&content)?;
    validate_manifest(&manifest, folder)?;
    Ok(manifest)
}

/// Read a plugin's validated manifest and, when it has one, its QuickJS entry.
async fn read_plugin_from_disk(
    plugin_id: &str,
) -> Result<(PluginManifest, Option<String>), AppError> {
    validate_plugin_id(plugin_id)?;
    let plugin_dir = plugins_dir().join(plugin_id);
    let manifest = read_plugin_manifest(&plugin_dir, plugin_id).await?;
    let source = match tokio::fs::read_to_string(plugin_dir.join("index.js")).await {
        Ok(source) => Some(source),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    Ok((manifest, source))
}

/// Plugin JS runs on its own thread with a host-side timeout; never block an
/// async runtime worker while waiting for it.
async fn on_plugin_host<T: Send + 'static>(
    state: &PluginHostState,
    work: impl FnOnce(&PluginHostState) -> Result<T, String> + Send + 'static,
) -> Result<T, AppError> {
    let host = state.clone();
    tokio::task::spawn_blocking(move || work(&host))
        .await
        .map_err(|error| AppError::Custom(format!("Plugin host task failed: {error}")))?
        .map_err(AppError::Custom)
}

// --- Plugin Settings Persistence ---

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct PluginSettings {
    /// Map of plugin_id -> enabled (true/false).
    enabled: HashMap<String, bool>,
}

/// Serializes plugin-settings read-modify-write transactions.
static PLUGIN_SETTINGS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn read_plugin_settings() -> PluginSettings {
    let path = plugin_settings_path();
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|error| {
            // Writes are atomic, so this is outside damage; the next toggle
            // rewrites a valid file.
            tracing::warn!(target: "novelist::plugins", ?path, %error, "unreadable plugin settings; treating every plugin as disabled");
            PluginSettings::default()
        }),
        Err(_) => PluginSettings::default(),
    }
}

async fn update_plugin_settings(
    update: impl FnOnce(&mut PluginSettings) + Send + 'static,
) -> Result<(), AppError> {
    // The transaction owns the lock in its own task, so a cancelled caller can
    // never release it while a write is still landing.
    tokio::spawn(async move {
        let _guard = PLUGIN_SETTINGS_LOCK.lock().await;
        let mut settings = read_plugin_settings().await;
        update(&mut settings);
        let bytes = serde_json::to_vec_pretty(&settings)?;
        let path = plugin_settings_path();
        tokio::task::spawn_blocking(move || atomic_write_sync(&path, &bytes))
            .await
            .map_err(|error| AppError::Custom(format!("Plugin settings write failed: {error}")))?
    })
    .await
    .map_err(|error| AppError::Custom(format!("Plugin settings transaction failed: {error}")))?
}

// --- Bundled Plugin Installation ---

/// Plugin folders shipped in the app's resources. Only these are installed by
/// the app or reported as built-in; a manifest cannot claim that status.
async fn bundled_plugin_ids(bundled_dir: &Path) -> HashSet<String> {
    let mut ids = HashSet::new();
    let Ok(mut entries) = tokio::fs::read_dir(bundled_dir).await else {
        return ids;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if validate_plugin_id(&name).is_ok() && entry.path().join("manifest.toml").is_file() {
            ids.insert(name);
        }
    }
    ids
}

fn bundled_plugins_dir(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    app_handle
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("bundled-plugins"))
}

/// Install or update bundled plugins in ~/.novelist/plugins/.
///
/// Startup-perf caveat: this used to re-read every manifest on every boot.
/// Now we cache a fingerprint of the bundled version tuple in
/// `~/.novelist/plugins/.bundled-version` and skip the scan when it matches.
async fn ensure_bundled_plugins(
    bundled_dir: &Path,
    bundled: &HashSet<String>,
) -> Result<(), AppError> {
    let target = plugins_dir();
    tokio::fs::create_dir_all(&target).await?;
    remove_interrupted_installs(&target).await;
    if bundled.is_empty() {
        return Ok(());
    }

    let version_cache_path = target.join(".bundled-version");
    let fingerprint = compute_bundled_fingerprint(bundled_dir, bundled).await;
    if let Some(fp) = fingerprint.as_deref() {
        if let Ok(cached) = tokio::fs::read_to_string(&version_cache_path).await {
            if cached.trim() == fp {
                // Fast path — versions match, nothing to do.
                return Ok(());
            }
        }
    }

    for plugin_id in bundled {
        let src = bundled_dir.join(plugin_id);
        let Ok(src_manifest) = read_plugin_manifest(&src, plugin_id).await else {
            continue;
        };
        // A missing or damaged installation is replaced; an intact one only
        // when the bundled version differs.
        let installed = read_plugin_manifest(&target.join(plugin_id), plugin_id).await;
        if installed.is_ok_and(|installed| installed.plugin.version == src_manifest.plugin.version)
        {
            continue;
        }
        install_bundled_plugin(&src, &target, plugin_id).await?;
    }

    // Write the fingerprint so the next boot can hit the fast path.
    if let Some(fp) = fingerprint {
        let _ = tokio::task::spawn_blocking(move || {
            atomic_write_sync(&version_cache_path, fp.as_bytes())
        })
        .await;
    }

    Ok(())
}

const STAGING_MARKER: &str = ".staging-";
const RETIRED_MARKER: &str = ".retired-";

/// Replace `plugins/<plugin_id>` with a complete copy of `src`. The copy is
/// staged beside the destination and renamed into place, so an interrupted
/// update never leaves a half-copied plugin whose manifest already carries the
/// new version. After a crash between the two renames the plugin is simply
/// missing and is reinstalled on the next start.
async fn install_bundled_plugin(
    src: &Path,
    plugins: &Path,
    plugin_id: &str,
) -> Result<(), AppError> {
    let nonce = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let staging = plugins.join(format!(".{plugin_id}{STAGING_MARKER}{nonce}"));
    if let Err(error) = copy_dir_recursive(src, &staging).await {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(error);
    }
    let dest = plugins.join(plugin_id);
    let retired = plugins.join(format!(".{plugin_id}{RETIRED_MARKER}{nonce}"));
    let had_previous = match tokio::fs::rename(&dest, &retired).await {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(error.into());
        }
    };
    if let Err(error) = tokio::fs::rename(&staging, &dest).await {
        if had_previous {
            let _ = tokio::fs::rename(&retired, &dest).await;
        }
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(error.into());
    }
    if had_previous {
        let _ = tokio::fs::remove_dir_all(&retired).await;
    }
    Ok(())
}

/// Remove staging/retired folders left behind by an interrupted install.
async fn remove_interrupted_installs(plugins: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(plugins).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') && (name.contains(STAGING_MARKER) || name.contains(RETIRED_MARKER))
        {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
}

/// Produce a stable fingerprint of "which versions of the bundled plugins
/// are currently shipping." Returns None if any manifest fails to read (in
/// which case every bundled plugin is checked individually).
async fn compute_bundled_fingerprint(
    bundled_dir: &Path,
    bundled: &HashSet<String>,
) -> Option<String> {
    let mut parts = Vec::with_capacity(bundled.len());
    for plugin_id in bundled {
        let manifest = read_plugin_manifest(&bundled_dir.join(plugin_id), plugin_id)
            .await
            .ok()?;
        parts.push(format!("{}={}", plugin_id, manifest.plugin.version));
    }
    if parts.is_empty() {
        return None;
    }
    parts.sort();
    Some(parts.join("|"))
}

async fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), AppError> {
    tokio::fs::create_dir_all(dest).await?;
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
    let bundled = match bundled_plugins_dir(&app_handle) {
        Some(bundled_dir) => {
            let bundled = bundled_plugin_ids(&bundled_dir).await;
            if let Err(error) = ensure_bundled_plugins(&bundled_dir, &bundled).await {
                tracing::warn!(target: "novelist::plugins", %error, "failed to install bundled plugins");
            }
            bundled
        }
        None => HashSet::new(),
    };
    scan_plugins(state.inner(), &bundled).await
}

async fn scan_plugins(
    state: &PluginHostState,
    bundled: &HashSet<String>,
) -> Result<Vec<PluginInfo>, AppError> {
    let dir = plugins_dir();
    if !dir.exists() {
        return Ok(vec![]);
    }

    let settings = read_plugin_settings().await;
    let loaded_ids: HashSet<String> = state
        .list_loaded_plugins()
        .into_iter()
        .map(|p| p.id)
        .collect();

    let mut plugins = Vec::new();

    let mut entries = tokio::fs::read_dir(&dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(folder) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if validate_plugin_id(&folder).is_err() {
            // Hidden staging folders and non-conforming names are not plugins.
            if !folder.starts_with('.') {
                tracing::warn!(target: "novelist::plugins", folder, "skipping plugin folder with an invalid id");
            }
            continue;
        }
        let manifest = match read_plugin_manifest(&path, &folder).await {
            Ok(manifest) => manifest,
            Err(AppError::FileNotFound(_)) => continue,
            Err(error) => {
                tracing::warn!(target: "novelist::plugins", folder, %error, "skipping invalid plugin");
                continue;
            }
        };
        let is_builtin = bundled.contains(&folder);
        let is_active = loaded_ids.contains(&folder);
        // Default: builtin plugins are disabled, user plugins are disabled
        let is_enabled = settings.enabled.get(&folder).copied().unwrap_or(false);

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
/// Enabling loads the plugin's QuickJS entry first; a plugin that fails to
/// start stays disabled. Disabling unloads it.
#[tauri::command]
#[specta::specta]
pub async fn set_plugin_enabled(
    plugin_id: String,
    enabled: bool,
    state: State<'_, PluginHostState>,
) -> Result<(), AppError> {
    set_plugin_enabled_inner(plugin_id, enabled, state.inner()).await
}

async fn set_plugin_enabled_inner(
    plugin_id: String,
    enabled: bool,
    state: &PluginHostState,
) -> Result<(), AppError> {
    validate_plugin_id(&plugin_id)?;
    if enabled {
        let (manifest, source) = read_plugin_from_disk(&plugin_id).await?;
        if let Some(source) = source {
            on_plugin_host(state, move |host| host.load_plugin(manifest, source)).await?;
        }
    }
    let persisted_id = plugin_id.clone();
    update_plugin_settings(move |settings| {
        settings.enabled.insert(persisted_id, enabled);
    })
    .await?;
    if !enabled {
        state.unload_plugin(&plugin_id);
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
    load_plugin_from_disk(&plugin_id, state.inner()).await
}

async fn load_plugin_from_disk(plugin_id: &str, state: &PluginHostState) -> Result<(), AppError> {
    let (manifest, source) = read_plugin_from_disk(plugin_id).await?;
    let source = source.ok_or_else(|| {
        AppError::FileNotFound(format!(
            "Plugin entry point not found: {}",
            plugins_dir().join(plugin_id).join("index.js").display()
        ))
    })?;
    on_plugin_host(state, move |host| host.load_plugin(manifest, source)).await
}

/// Unload (deactivate) a plugin.
#[tauri::command]
#[specta::specta]
pub async fn unload_plugin(
    plugin_id: String,
    state: State<'_, PluginHostState>,
) -> Result<(), AppError> {
    state.unload_plugin(&plugin_id);
    Ok(())
}

/// Replace a plugin from disk only after the new instance loads successfully.
/// Failed edits leave the previous plugin and its commands available.
#[tauri::command]
#[specta::specta]
pub async fn reload_plugin(
    plugin_id: String,
    state: State<'_, PluginHostState>,
) -> Result<(), AppError> {
    load_plugin(plugin_id, state).await
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
    let replacements = on_plugin_host(state.inner(), move |host| {
        host.invoke_command(&plugin_id, &command_id)
    })
    .await?;

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
pub async fn scaffold_plugin(id: String, display_name: Option<String>) -> Result<String, AppError> {
    validate_plugin_id(&id)?;

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

    let tmp = plugins.join(format!("{id}.tmp"));
    let manifest = PluginManifest {
        plugin: PluginMeta {
            id,
            name,
            version: "0.1.0".to_string(),
            permissions: vec!["read".to_string(), "write".to_string()],
            description: Some("Uppercase the selected text".to_string()),
            author: None,
            icon: None,
        },
        ui: None,
    };
    let manifest = toml::to_string_pretty(&manifest)?;
    let index_js = r#"// Novelist plugins run as plain scripts in the QuickJS sandbox.
novelist.registerCommand("uppercase-selection", "Uppercase Selection", function() {
  const selection = novelist.getSelection();
  if (selection.from === selection.to) return;
  const text = novelist.getDocument().slice(selection.from, selection.to);
  novelist.replaceSelection(text.toUpperCase());
});
"#;

    // Write to <id>.tmp then rename, so a partial failure doesn't leave a half-baked dir.
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
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::TempDir;

    // Tests that mutate NOVELIST_PLUGIN_DATA_DIR must not run concurrently
    // (env is process-global). DATA_DIR_MUTEX is intentionally held across
    // .await so the entire test body runs serialized — tokio may move the
    // task across threads, but std::Mutex is Send so this is sound in
    // practice for test-only serialization.
    static DATA_DIR_MUTEX: Mutex<()> = Mutex::new(());

    fn set_data_dir(p: &Path) -> Option<std::ffi::OsString> {
        let old = std::env::var_os("NOVELIST_PLUGIN_DATA_DIR");
        unsafe {
            std::env::set_var("NOVELIST_PLUGIN_DATA_DIR", p);
        }
        old
    }

    fn restore_data_dir(old: Option<std::ffi::OsString>) {
        if let Some(v) = old {
            unsafe {
                std::env::set_var("NOVELIST_PLUGIN_DATA_DIR", v);
            }
        } else {
            unsafe {
                std::env::remove_var("NOVELIST_PLUGIN_DATA_DIR");
            }
        }
    }

    fn lock_data_dir() -> std::sync::MutexGuard<'static, ()> {
        DATA_DIR_MUTEX.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[tokio::test]
    async fn test_scaffold_plugin_creates_files() {
        let _guard = lock_data_dir();
        let tmp = TempDir::new().unwrap();
        let old = set_data_dir(tmp.path());

        let result = scaffold_plugin(
            "sentence-counter".to_string(),
            Some("Sentence Counter".into()),
        )
        .await
        .unwrap();
        assert!(Path::new(&result).ends_with(Path::new("plugins/sentence-counter")));
        let dir = std::path::PathBuf::from(&result);
        assert!(dir.join("manifest.toml").is_file());
        assert!(dir.join("index.js").is_file());
        let manifest = std::fs::read_to_string(dir.join("manifest.toml")).unwrap();
        let manifest: PluginManifest = toml::from_str(&manifest).unwrap();
        assert_eq!(manifest.plugin.id, "sentence-counter");
        assert_eq!(manifest.plugin.name, "Sentence Counter");
        assert_eq!(manifest.plugin.permissions, vec!["read", "write"]);

        restore_data_dir(old);
    }

    #[tokio::test]
    async fn test_scaffold_plugin_lists_loads_and_invokes_with_escaped_names() {
        let _guard = lock_data_dir();
        let tmp = TempDir::new().unwrap();
        let old = set_data_dir(tmp.path());
        let host = PluginHostState::new();

        for (index, name) in [
            "Quoted \"plugin\"\n中文\\路径",
            "Line\r\nbreak\t雪",
            "插件😀\u{2028}name\u{2029}",
        ]
        .iter()
        .enumerate()
        {
            let id = format!("sample-{index}");
            let result = scaffold_plugin(id.clone(), Some((*name).to_string()))
                .await
                .unwrap();
            let manifest =
                std::fs::read_to_string(Path::new(&result).join("manifest.toml")).unwrap();
            let manifest: PluginManifest = toml::from_str(&manifest).unwrap();
            assert_eq!(manifest.plugin.name, *name);

            let plugins = scan_plugins(&host, &HashSet::new()).await.unwrap();
            let plugin = plugins.iter().find(|plugin| plugin.id == id).unwrap();
            assert_eq!(plugin.name, *name);
            assert!(!plugin.active);

            load_plugin_from_disk(&id, &host).await.unwrap();
            let commands = host.get_registered_commands();
            let commands: Vec<_> = commands.iter().filter(|cmd| cmd.plugin_id == id).collect();
            assert_eq!(commands.len(), 1);
            assert_eq!(commands[0].command_id, "uppercase-selection");

            host.set_document_state("😀 hello 世界".to_string(), 3, 8, 3);
            let replacements = host.invoke_command(&id, "uppercase-selection").unwrap();
            assert_eq!(replacements.len(), 1);
            assert_eq!(replacements[0].from, 3);
            assert_eq!(replacements[0].to, 8);
            assert_eq!(replacements[0].text, "HELLO");

            host.set_document_state("hello".to_string(), 2, 2, 1);
            assert!(host
                .invoke_command(&id, "uppercase-selection")
                .unwrap()
                .is_empty());
            let plugins = scan_plugins(&host, &HashSet::new()).await.unwrap();
            assert!(
                plugins
                    .iter()
                    .find(|plugin| plugin.id == id)
                    .unwrap()
                    .active
            );
        }

        restore_data_dir(old);
    }

    #[tokio::test]
    async fn test_reload_plugin_from_disk_preserves_then_replaces_commands() {
        let _guard = lock_data_dir();
        let tmp = TempDir::new().unwrap();
        let old = set_data_dir(tmp.path());
        let host = PluginHostState::new();
        let dir = scaffold_plugin("reload-me".to_string(), None)
            .await
            .unwrap();
        let entry = Path::new(&dir).join("index.js");
        std::fs::write(
            &entry,
            r#"novelist.registerCommand("replace", "Original", function() {
  novelist.replaceSelection("original");
});
novelist.registerCommand("obsolete", "Obsolete", function() {});"#,
        )
        .unwrap();
        host.set_document_state("draft".to_string(), 0, 5, 1);
        load_plugin_from_disk("reload-me", &host).await.unwrap();

        for source in [
            "this is not valid javascript {{{",
            r#"novelist.registerCommand("partial", "Partial", function() {});
throw new Error("broken activation");"#,
        ] {
            std::fs::write(&entry, source).unwrap();
            assert!(load_plugin_from_disk("reload-me", &host).await.is_err());
            let plugins = host.list_loaded_plugins();
            assert_eq!(plugins.len(), 1);
            assert!(plugins[0].active);
            let mut commands: Vec<_> = host
                .get_registered_commands()
                .into_iter()
                .map(|cmd| cmd.command_id)
                .collect();
            commands.sort();
            assert_eq!(commands, vec!["obsolete", "replace"]);
            let replacements = host.invoke_command("reload-me", "replace").unwrap();
            assert_eq!(replacements.len(), 1);
            assert_eq!(replacements[0].text, "original");
        }

        std::fs::write(
            &entry,
            r#"novelist.registerCommand("replace", "Updated", function() {
  novelist.replaceSelection("updated");
});
novelist.registerCommand("new-command", "New", function() {
  novelist.replaceSelection("new");
});"#,
        )
        .unwrap();
        load_plugin_from_disk("reload-me", &host).await.unwrap();
        assert_eq!(host.list_loaded_plugins().len(), 1);
        let mut commands: Vec<_> = host
            .get_registered_commands()
            .into_iter()
            .map(|cmd| (cmd.command_id, cmd.label))
            .collect();
        commands.sort();
        assert_eq!(
            commands,
            vec![
                ("new-command".to_string(), "New".to_string()),
                ("replace".to_string(), "Updated".to_string()),
            ]
        );
        let replacements = host.invoke_command("reload-me", "replace").unwrap();
        assert_eq!(replacements.len(), 1);
        assert_eq!(replacements[0].text, "updated");
        let replacements = host.invoke_command("reload-me", "new-command").unwrap();
        assert_eq!(replacements.len(), 1);
        assert_eq!(replacements[0].text, "new");

        restore_data_dir(old);
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
        let _guard = lock_data_dir();
        let tmp = TempDir::new().unwrap();
        let old = set_data_dir(tmp.path());

        scaffold_plugin("dup".to_string(), None).await.unwrap();
        let second = scaffold_plugin("dup".to_string(), None).await;
        assert!(second.is_err());

        restore_data_dir(old);
    }

    #[tokio::test]
    async fn test_scaffold_plugin_defaults_display_name_to_id() {
        let _guard = lock_data_dir();
        let tmp = TempDir::new().unwrap();
        let old = set_data_dir(tmp.path());

        let result = scaffold_plugin("foo".to_string(), None).await.unwrap();
        let manifest =
            std::fs::read_to_string(std::path::Path::new(&result).join("manifest.toml")).unwrap();
        assert!(manifest.contains("name = \"foo\""));

        restore_data_dir(old);
    }

    fn write_plugin(
        plugins: &Path,
        folder: &str,
        manifest: &str,
        index_js: Option<&str>,
    ) -> PathBuf {
        let dir = plugins.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("manifest.toml"), manifest).unwrap();
        if let Some(source) = index_js {
            std::fs::write(dir.join("index.js"), source).unwrap();
        }
        dir
    }

    /// TOML literal strings keep `entry` verbatim (backslashes included).
    fn manifest_toml(id: &str, version: &str, entry: Option<&str>) -> String {
        let mut toml = format!(
            "[plugin]\nid = '{id}'\nname = '{id}'\nversion = '{version}'\npermissions = ['read', 'ai:http']\n"
        );
        if let Some(entry) = entry {
            toml.push_str(&format!(
                "\n[ui]\ntype = 'file-handler'\nentry = '{entry}'\nfile_extensions = ['.novtrans']\n"
            ));
        }
        toml
    }

    #[test]
    fn plugin_ids_cannot_name_paths() {
        for good in ["canvas", "book-translation", "0day", "a-1"] {
            assert!(validate_plugin_id(good).is_ok(), "{good}");
        }
        for bad in [
            "", "..", "../x", "/abs", "a/b", "a\\b", ".hidden", "-x", "Foo", "a_b", "a.b", "插件",
        ] {
            assert!(validate_plugin_id(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn plugin_ids_that_escape_the_plugins_folder_never_load() {
        let _guard = lock_data_dir();
        let tmp = TempDir::new().unwrap();
        let old = set_data_dir(tmp.path());
        std::fs::create_dir_all(plugins_dir()).unwrap();
        let outside = write_plugin(
            tmp.path(),
            "outside",
            &manifest_toml("outside", "1.0.0", None),
            Some(r#"novelist.registerCommand("x", "X", function() {});"#),
        );
        let host = PluginHostState::new();

        let absolute = outside.to_string_lossy().to_string();
        for id in ["../outside", absolute.as_str()] {
            assert!(
                matches!(
                    load_plugin_from_disk(id, &host).await,
                    Err(AppError::InvalidInput(_))
                ),
                "{id}"
            );
            assert!(
                matches!(
                    set_plugin_enabled_inner(id.to_string(), true, &host).await,
                    Err(AppError::InvalidInput(_))
                ),
                "{id}"
            );
        }
        assert!(host.list_loaded_plugins().is_empty());
        assert!(!plugin_settings_path().exists());

        restore_data_dir(old);
    }

    #[tokio::test]
    async fn manifests_cannot_claim_another_id_or_point_their_ui_outside_their_folder() {
        let _guard = lock_data_dir();
        let tmp = TempDir::new().unwrap();
        let old = set_data_dir(tmp.path());
        let plugins = plugins_dir();
        // A third-party folder impersonating the privileged built-in.
        write_plugin(
            &plugins,
            "evil",
            &manifest_toml("book-translation", "9.9.9", Some("index.html")),
            Some(r#"novelist.registerCommand("steal", "Steal", function() {});"#),
        );
        for (folder, entry) in [
            ("dotdot", "../evil/ui.html"),
            ("absolute", "/etc/ui.html"),
            ("backslash", "..\\evil\\ui.html"),
            ("drive", "C:/ui.html"),
            ("current", "./index.html"),
            ("empty", ""),
        ] {
            write_plugin(
                &plugins,
                folder,
                &manifest_toml(folder, "1.0.0", Some(entry)),
                None,
            );
        }
        write_plugin(
            &plugins,
            "nested-entry",
            &manifest_toml("nested-entry", "1.0.0", Some("dist/index.html")),
            None,
        );
        let host = PluginHostState::new();
        let bundled = HashSet::from(["book-translation".to_string()]);

        let ids: Vec<String> = scan_plugins(&host, &bundled)
            .await
            .unwrap()
            .into_iter()
            .map(|plugin| plugin.id)
            .collect();
        assert_eq!(ids, vec!["nested-entry"]);
        assert!(matches!(
            load_plugin_from_disk("evil", &host).await,
            Err(AppError::InvalidInput(_))
        ));
        assert!(host.get_registered_commands().is_empty());
        assert!(set_plugin_enabled_inner("dotdot".into(), true, &host)
            .await
            .is_err());
        assert!(read_plugin_settings().await.enabled.is_empty());

        restore_data_dir(old);
    }

    #[tokio::test]
    async fn builtin_status_comes_from_bundled_resources_not_from_manifests() {
        let _guard = lock_data_dir();
        let tmp = TempDir::new().unwrap();
        let old = set_data_dir(tmp.path());
        let bundled_dir = tmp.path().join("resources/bundled-plugins");
        write_plugin(
            &bundled_dir,
            "canvas",
            &manifest_toml("canvas", "1.0.0", Some("index.html")),
            None,
        );
        write_plugin(
            &bundled_dir,
            "Bad_Name",
            &manifest_toml("Bad_Name", "1.0.0", None),
            None,
        );
        std::fs::create_dir_all(bundled_dir.join("no-manifest")).unwrap();
        let plugins = plugins_dir();
        write_plugin(
            &plugins,
            "canvas",
            &manifest_toml("canvas", "1.0.0", Some("index.html")),
            None,
        );
        write_plugin(
            &plugins,
            "community",
            &manifest_toml("community", "1.0.0", Some("index.html")),
            None,
        );
        let host = PluginHostState::new();

        let bundled = bundled_plugin_ids(&bundled_dir).await;
        assert_eq!(bundled, HashSet::from(["canvas".to_string()]));
        let scanned = scan_plugins(&host, &bundled).await.unwrap();
        let builtin: HashMap<_, _> = scanned.iter().map(|p| (p.id.as_str(), p.builtin)).collect();
        assert_eq!(
            builtin,
            HashMap::from([("canvas", true), ("community", false)])
        );
        assert!(scan_plugins(&host, &HashSet::new())
            .await
            .unwrap()
            .iter()
            .all(|plugin| !plugin.builtin));

        restore_data_dir(old);
    }

    #[tokio::test]
    async fn concurrent_toggles_persist_every_plugin_atomically() {
        let _guard = lock_data_dir();
        let tmp = TempDir::new().unwrap();
        let old = set_data_dir(tmp.path());
        let plugins = plugins_dir();
        let ids: Vec<String> = (0..16).map(|index| format!("panel-{index}")).collect();
        for id in &ids {
            write_plugin(
                &plugins,
                id,
                &manifest_toml(id, "1.0.0", Some("index.html")),
                None,
            );
        }
        let host = PluginHostState::new();

        let toggles: Vec<_> = ids
            .iter()
            .map(|id| {
                let host = host.clone();
                let id = id.clone();
                tokio::spawn(async move { set_plugin_enabled_inner(id, true, &host).await })
            })
            .collect();
        for toggle in toggles {
            toggle.await.unwrap().unwrap();
        }

        let raw = std::fs::read_to_string(plugin_settings_path()).unwrap();
        let settings: PluginSettings = serde_json::from_str(&raw).unwrap();
        for id in &ids {
            assert_eq!(settings.enabled.get(id), Some(&true), "{id}");
        }
        let leftovers: Vec<String> = std::fs::read_dir(novelist_dir())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("novelist-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");

        restore_data_dir(old);
    }

    #[tokio::test]
    async fn enabling_a_plugin_that_fails_to_start_keeps_it_disabled() {
        let _guard = lock_data_dir();
        let tmp = TempDir::new().unwrap();
        let old = set_data_dir(tmp.path());
        write_plugin(
            &plugins_dir(),
            "broken",
            &manifest_toml("broken", "1.0.0", None),
            Some("this is not valid javascript {{{"),
        );
        let host = PluginHostState::new();

        assert!(set_plugin_enabled_inner("broken".into(), true, &host)
            .await
            .is_err());
        assert_eq!(read_plugin_settings().await.enabled.get("broken"), None);
        assert!(host.list_loaded_plugins().is_empty());

        restore_data_dir(old);
    }

    #[tokio::test]
    async fn bundled_updates_replace_the_whole_folder_and_clear_interrupted_installs() {
        let _guard = lock_data_dir();
        let tmp = TempDir::new().unwrap();
        let old = set_data_dir(tmp.path());
        let bundled_dir = tmp.path().join("resources/bundled-plugins");
        let canvas = write_plugin(
            &bundled_dir,
            "canvas",
            &manifest_toml("canvas", "2.0.0", Some("index.html")),
            None,
        );
        std::fs::write(canvas.join("index.html"), "<!doctype html>v2").unwrap();
        write_plugin(
            &bundled_dir,
            "kanban",
            &manifest_toml("kanban", "1.0.0", Some("index.html")),
            None,
        );
        let plugins = plugins_dir();
        // Outdated install carrying an asset the new version no longer ships.
        let installed = write_plugin(
            &plugins,
            "canvas",
            &manifest_toml("canvas", "1.0.0", Some("index.html")),
            None,
        );
        std::fs::create_dir_all(installed.join("assets")).unwrap();
        std::fs::write(installed.join("assets/stale.js"), "stale").unwrap();
        // Damaged install without a manifest, and leftovers of an interrupted update.
        std::fs::create_dir_all(plugins.join("kanban/assets")).unwrap();
        std::fs::create_dir_all(plugins.join(".canvas.staging-1-2")).unwrap();
        std::fs::create_dir_all(plugins.join(".canvas.retired-1-2")).unwrap();

        let bundled = bundled_plugin_ids(&bundled_dir).await;
        ensure_bundled_plugins(&bundled_dir, &bundled)
            .await
            .unwrap();

        let canvas = read_plugin_manifest(&plugins.join("canvas"), "canvas")
            .await
            .unwrap();
        assert_eq!(canvas.plugin.version, "2.0.0");
        assert_eq!(
            std::fs::read_to_string(plugins.join("canvas/index.html")).unwrap(),
            "<!doctype html>v2"
        );
        assert!(!plugins.join("canvas/assets/stale.js").exists());
        assert!(read_plugin_manifest(&plugins.join("kanban"), "kanban")
            .await
            .is_ok());
        let mut hidden: Vec<String> = std::fs::read_dir(&plugins)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with('.'))
            .collect();
        hidden.sort();
        assert_eq!(hidden, vec![".bundled-version"]);

        restore_data_dir(old);
    }
}
