//! Effective settings commands.
//!
//! Global defaults live in `~/.novelist/settings.json`; per-project overrides
//! live in `<project>/.novelist/project.toml`'s `[view] / [new_file] /
//! [plugins]` sections. `get_effective_settings` merges them (project wins);
//! `write_project_settings` / `write_global_settings` each patch one file.
//!
//! Section granularity: frontend passes `Option<Section>` — `Some(..)` means
//! "replace this section", `None` means "leave it alone". To delete an
//! override, pass `Some(Section::default())` (all fields None / empty map).

use crate::error::AppError;
use crate::models::project::ProjectConfig;
use crate::models::settings::{
    resolve, EffectiveSettings, GlobalSettings, NewFileConfig, PluginsConfig, ResolvedSnapshot,
    SnapshotConfig, ViewConfig,
};
use crate::services::sidecar::{atomic_write_bytes, atomic_write_json, read_json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

static SETTINGS_WRITE_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(test)]
struct MissingGlobalSettingsPause {
    path: PathBuf,
    entered: tokio::sync::oneshot::Sender<()>,
    release: tokio::sync::oneshot::Receiver<()>,
}

#[cfg(test)]
static MISSING_GLOBAL_SETTINGS_PAUSE: AsyncMutex<Option<MissingGlobalSettingsPause>> =
    AsyncMutex::const_new(None);

#[cfg(test)]
async fn pause_after_missing_global_settings(path: &Path) {
    let pause = {
        let mut hook = MISSING_GLOBAL_SETTINGS_PAUSE.lock().await;
        if hook.as_ref().is_some_and(|pause| pause.path == path) {
            hook.take()
        } else {
            None
        }
    };
    if let Some(pause) = pause {
        let _ = pause.entered.send(());
        let _ = pause.release.await;
    }
}

async fn acquire_settings_guard(identity: PathBuf) -> Result<OwnedMutexGuard<()>, AppError> {
    let mutex = {
        let mut locks = SETTINGS_WRITE_LOCKS
            .lock()
            .map_err(|_| AppError::Custom("Settings write-lock registry poisoned".into()))?;
        locks
            .entry(identity)
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    };
    Ok(mutex.lock_owned().await)
}

/// Serializes project settings with replacement/restore transactions. Callers
/// doing blocking work must move this guard into that work so cancellation of
/// the awaiting command cannot release it before the filesystem write finishes.
pub(crate) async fn acquire_project_settings_guard(
    project_dir: &Path,
) -> Result<OwnedMutexGuard<()>, AppError> {
    acquire_settings_guard(tokio::fs::canonicalize(project_dir).await?).await
}

fn global_settings_path() -> PathBuf {
    // `NOVELIST_SETTINGS_DATA_DIR` is a test seam (used by unit tests that need
    // per-test isolation and can't rely on `portable::init()` having run).
    // Production code goes through `portable::novelist_home`.
    #[cfg(test)]
    {
        if let Ok(p) = std::env::var("NOVELIST_SETTINGS_DATA_DIR") {
            if !p.is_empty() {
                return PathBuf::from(p).join("settings.json");
            }
        }
    }
    crate::services::portable::novelist_home().join("settings.json")
}

pub(crate) async fn read_global_settings() -> GlobalSettings {
    let path = global_settings_path();
    if !path.exists() {
        return GlobalSettings::default();
    }
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => GlobalSettings::default(),
    }
}

/// Own the entire read-modify-write transaction, not a caller's stale settings
/// snapshot. Only a genuinely absent file may start from defaults.
pub(crate) async fn update_global_settings<F>(update: F) -> Result<(), AppError>
where
    F: FnOnce(&mut GlobalSettings) -> Result<(), AppError> + Send + 'static,
{
    let path = global_settings_path();
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Global settings path has no parent".into()))?;
    tokio::fs::create_dir_all(parent).await?;
    let path = match tokio::fs::canonicalize(&path).await {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            #[cfg(test)]
            pause_after_missing_global_settings(&path).await;
            // A dangling symlink is not an absent settings file.
            match tokio::fs::symlink_metadata(&path).await {
                Err(missing) if missing.kind() == std::io::ErrorKind::NotFound => {}
                // Another first-use transaction may have committed after
                // canonicalize observed a missing file. Reuse its identity.
                Ok(metadata) if metadata.is_file() => {}
                Err(other) => return Err(other.into()),
                Ok(_) => return Err(error.into()),
            }
            tokio::fs::canonicalize(parent).await?.join("settings.json")
        }
        Err(error) => return Err(error.into()),
    };
    let guard = acquire_settings_guard(path.clone()).await?;
    // Atomic writes use blocking filesystem work. Keep ownership in a task
    // that finishes even if the invoking command is cancelled mid-write.
    tokio::spawn(async move {
        let _guard = guard;
        let mut current = read_json::<GlobalSettings>(&path)
            .await?
            .unwrap_or_default();
        update(&mut current)?;
        atomic_write_json(&path, &current).await
    })
    .await
    .map_err(|error| AppError::Custom(format!("Settings transaction failed: {error}")))?
}

async fn read_project_config_if_any(dir_path: &str) -> Option<ProjectConfig> {
    read_project_config(Path::new(dir_path)).await.ok()
}

async fn read_project_config(dir_path: &Path) -> Result<ProjectConfig, AppError> {
    let cfg_path = dir_path.join(".novelist").join("project.toml");
    let content = tokio::fs::read_to_string(&cfg_path)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::FileNotFound(cfg_path.display().to_string())
            } else {
                AppError::Io(error)
            }
        })?;
    Ok(toml::from_str(&content)?)
}

/// Return raw global defaults from `~/.novelist/settings.json` without
/// merging in any project overlay. Used by the frontend to compute plugin
/// delta overrides (only entries differing from global are persisted).
#[tauri::command]
#[specta::specta]
pub async fn get_global_settings() -> Result<GlobalSettings, AppError> {
    Ok(read_global_settings().await)
}

/// Internal helper used by the snapshot service to resolve `max_count` /
/// `min_interval_minutes` for a specific project directory. Not a Tauri
/// command — the retention engine calls it directly.
pub async fn get_resolved_snapshot_config(project_dir: &str) -> ResolvedSnapshot {
    let global = read_global_settings().await;
    let project_snap = read_project_config_if_any(project_dir)
        .await
        .and_then(|p| p.snapshot);
    resolve(&global, None, None, None, project_snap.as_ref()).snapshot
}

/// Return effective settings, merging global defaults with an optional
/// project overlay. `dir_path = None` returns global-only (scratch mode).
#[tauri::command]
#[specta::specta]
pub async fn get_effective_settings(
    dir_path: Option<String>,
) -> Result<EffectiveSettings, AppError> {
    let global = read_global_settings().await;
    let (view, new_file, plugins, snapshot): (
        Option<ViewConfig>,
        Option<NewFileConfig>,
        Option<PluginsConfig>,
        Option<SnapshotConfig>,
    ) = match dir_path {
        Some(d) => {
            let project = read_project_config_if_any(&d).await;
            match project {
                Some(p) => (Some(p.view), Some(p.new_file), Some(p.plugins), p.snapshot),
                None => (None, None, None, None),
            }
        }
        None => (None, None, None, None),
    };
    Ok(resolve(
        &global,
        view.as_ref(),
        new_file.as_ref(),
        plugins.as_ref(),
        snapshot.as_ref(),
    ))
}

/// Patch the global `~/.novelist/settings.json`. Only the `Some(..)` sections
/// are replaced; unspecified sections keep their current value on disk.
#[tauri::command]
#[specta::specta]
pub async fn write_global_settings(
    view: Option<ViewConfig>,
    new_file: Option<NewFileConfig>,
    plugins: Option<PluginsConfig>,
    snapshot: Option<SnapshotConfig>,
) -> Result<(), AppError> {
    update_global_settings(move |current| {
        if let Some(v) = view {
            current.view = v;
        }
        if let Some(n) = new_file {
            current.new_file = n;
        }
        if let Some(p) = plugins {
            current.plugins = p;
        }
        if let Some(s) = snapshot {
            current.snapshot = s;
        }
        Ok(())
    })
    .await
}

/// Patch `<dir>/.novelist/project.toml`. Only the provided sections are replaced.
/// Requires that a `project.toml` already exists (i.e. `dir` is a Novelist project).
#[tauri::command]
#[specta::specta]
pub async fn write_project_settings(
    dir_path: String,
    view: Option<ViewConfig>,
    new_file: Option<NewFileConfig>,
    plugins: Option<PluginsConfig>,
    snapshot: Option<SnapshotConfig>,
) -> Result<(), AppError> {
    let project = tokio::fs::canonicalize(&dir_path).await?;
    let guard = acquire_settings_guard(project.clone()).await?;
    tokio::spawn(async move {
        let _guard = guard;
        let mut config = read_project_config(&project).await?;
        if let Some(v) = view {
            config.view = v;
        }
        if let Some(n) = new_file {
            config.new_file = n;
        }
        if let Some(p) = plugins {
            config.plugins = p;
        }
        if let Some(s) = snapshot {
            config.snapshot = Some(s);
        }
        let serialized = toml::to_string(&config)?;
        atomic_write_bytes(
            &project.join(".novelist").join("project.toml"),
            serialized.as_bytes(),
        )
        .await
    })
    .await
    .map_err(|error| AppError::Custom(format!("Settings transaction failed: {error}")))?
}

#[cfg(test)]
pub(crate) struct SettingsDataDirGuard(Option<std::ffi::OsString>);

#[cfg(test)]
impl SettingsDataDirGuard {
    /// Call only under `#[serial(settings_data_dir)]`, shared with all tests
    /// that change the process-wide settings data-directory seam.
    pub(crate) fn set(path: &Path) -> Self {
        let old = std::env::var_os("NOVELIST_SETTINGS_DATA_DIR");
        unsafe { std::env::set_var("NOVELIST_SETTINGS_DATA_DIR", path) };
        Self(old)
    }
}

#[cfg(test)]
impl Drop for SettingsDataDirGuard {
    fn drop(&mut self) {
        match self.0.take() {
            Some(old) => unsafe { std::env::set_var("NOVELIST_SETTINGS_DATA_DIR", old) },
            None => unsafe { std::env::remove_var("NOVELIST_SETTINGS_DATA_DIR") },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use tempfile::TempDir;

    fn write_minimal_project(dir: &TempDir, overlay_toml: &str) {
        let novelist_dir = dir.path().join(".novelist");
        std::fs::create_dir(&novelist_dir).unwrap();
        let content = format!("[project]\nname = \"T\"\n\n{overlay_toml}");
        std::fs::write(novelist_dir.join("project.toml"), content).unwrap();
    }

    #[tokio::test]
    async fn write_project_settings_patches_view_and_leaves_new_file_untouched() {
        let dir = TempDir::new().unwrap();
        write_minimal_project(
            &dir,
            r#"[new_file]
template = "Chapter {N}"
"#,
        );
        let dir_str = dir.path().to_string_lossy().to_string();

        write_project_settings(
            dir_str.clone(),
            Some(ViewConfig {
                sort_mode: Some("name-desc".into()),
                show_hidden_files: Some(true),
                wrap_file_names: None,
                sidebar_font_size: None,
            }),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        let config = read_project_config_if_any(&dir_str).await.unwrap();
        assert_eq!(config.view.sort_mode.as_deref(), Some("name-desc"));
        assert_eq!(config.view.show_hidden_files, Some(true));
        assert_eq!(
            config.new_file.template.as_deref(),
            Some("Chapter {N}"),
            "existing new_file template must be preserved"
        );
    }

    #[tokio::test]
    #[serial(settings_data_dir)]
    async fn get_effective_settings_merges_global_with_project_overlay() {
        let global_tmp = TempDir::new().unwrap();
        let _settings_dir = SettingsDataDirGuard::set(global_tmp.path());

        let dir = TempDir::new().unwrap();
        write_minimal_project(
            &dir,
            r#"[view]
show_hidden_files = true
"#,
        );
        // Can't write ~/.novelist/settings.json in tests — exercise directly via
        // resolve() in the settings model (covered in models/settings.rs tests).
        // This test checks that project overlay flows through the command.
        let eff = get_effective_settings(Some(dir.path().to_string_lossy().into()))
            .await
            .unwrap();
        assert!(eff.view.show_hidden_files);
        assert!(eff.is_project_scoped);
    }

    #[tokio::test]
    #[serial(settings_data_dir)]
    async fn get_effective_settings_scratch_mode_is_not_project_scoped() {
        let global_tmp = TempDir::new().unwrap();
        let _settings_dir = SettingsDataDirGuard::set(global_tmp.path());

        let eff = get_effective_settings(None).await.unwrap();
        assert!(!eff.is_project_scoped);
    }

    #[tokio::test]
    async fn write_project_settings_errors_without_project_toml() {
        let dir = TempDir::new().unwrap();
        let res = write_project_settings(
            dir.path().to_string_lossy().to_string(),
            Some(ViewConfig::default()),
            None,
            None,
            None,
        )
        .await;
        assert!(matches!(res, Err(AppError::FileNotFound(_))));
    }

    #[tokio::test]
    async fn write_project_settings_roundtrip_survives_existing_fields() {
        // Verifies the whole-config roundtrip: patching [view] must not clobber
        // [project] or [writing].
        let dir = TempDir::new().unwrap();
        let novelist_dir = dir.path().join(".novelist");
        std::fs::create_dir(&novelist_dir).unwrap();
        std::fs::write(
            novelist_dir.join("project.toml"),
            r#"[project]
name = "Preserve Me"
type = "novel"
version = "0.1.0"

[writing]
daily_goal = 1234
auto_save_minutes = 7
"#,
        )
        .unwrap();

        let dir_str = dir.path().to_string_lossy().to_string();
        write_project_settings(
            dir_str.clone(),
            Some(ViewConfig {
                sort_mode: Some("mtime-desc".into()),
                show_hidden_files: None,
                wrap_file_names: Some(true),
                sidebar_font_size: None,
            }),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        let config = read_project_config_if_any(&dir_str).await.unwrap();
        assert_eq!(config.project.name, "Preserve Me");
        assert_eq!(config.writing.daily_goal, 1234);
        assert_eq!(config.writing.auto_save_minutes, 7);
        assert_eq!(config.view.sort_mode.as_deref(), Some("mtime-desc"));
        assert_eq!(config.view.wrap_file_names, Some(true));
    }

    #[tokio::test]
    #[serial(settings_data_dir)]
    async fn concurrent_global_commands_preserve_every_changed_section() {
        use crate::commands::{export, image_host, publish};
        use crate::models::image_host::ImageHostSettings;
        use crate::models::publish::{ChannelConfig, PlatformConfig, PublishSettings};

        let dir = TempDir::new().unwrap();
        let _settings_dir = SettingsDataDirGuard::set(dir.path());
        std::fs::write(dir.path().join("settings.json"), b"{}").unwrap();
        let publish_settings = PublishSettings {
            channels: vec![ChannelConfig {
                id: "medium-test".into(),
                name: "Test publication".into(),
                config: PlatformConfig::Medium {
                    token: "test-only".into(),
                },
            }],
        };
        let image_settings = ImageHostSettings {
            auto_on_paste: true,
            ..Default::default()
        };
        let (view, new_file, publish, image, pandoc) = tokio::join!(
            write_global_settings(
                Some(ViewConfig {
                    show_hidden_files: Some(true),
                    ..Default::default()
                }),
                None,
                None,
                None,
            ),
            write_global_settings(
                None,
                Some(NewFileConfig {
                    template: Some("Chapter {N}".into()),
                    ..Default::default()
                }),
                None,
                None,
            ),
            publish::set_publish_settings(publish_settings.clone()),
            image_host::set_image_host_settings(image_settings.clone()),
            export::set_pandoc_path(Some(" /test/pandoc ".into())),
        );
        view.unwrap();
        new_file.unwrap();
        publish.unwrap();
        image.unwrap();
        pandoc.unwrap();

        let saved = read_json::<GlobalSettings>(&dir.path().join("settings.json"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.view.show_hidden_files, Some(true));
        assert_eq!(saved.new_file.template.as_deref(), Some("Chapter {N}"));
        assert_eq!(saved.publish, publish_settings);
        assert_eq!(saved.image_hosts, image_settings);
        assert_eq!(saved.pandoc_path.as_deref(), Some("/test/pandoc"));
    }

    #[tokio::test]
    #[serial(settings_data_dir)]
    async fn malformed_global_settings_reject_all_mutations_without_changing_bytes() {
        let dir = TempDir::new().unwrap();
        let _settings_dir = SettingsDataDirGuard::set(dir.path());
        let path = dir.path().join("settings.json");
        let original = b"{\"publish\":{\"channels\":[unknown-provider-data";
        std::fs::write(&path, original).unwrap();

        assert!(matches!(
            write_global_settings(Some(ViewConfig::default()), None, None, None).await,
            Err(AppError::Json(_))
        ));
        assert!(matches!(
            crate::commands::publish::set_publish_settings(Default::default()).await,
            Err(AppError::Json(_))
        ));
        assert!(matches!(
            crate::commands::image_host::set_image_host_settings(Default::default()).await,
            Err(AppError::Json(_))
        ));
        assert!(matches!(
            crate::commands::export::set_pandoc_path(Some("/test/pandoc".into())).await,
            Err(AppError::Json(_))
        ));
        assert_eq!(std::fs::read(path).unwrap(), original);
    }

    #[tokio::test]
    #[serial(settings_data_dir)]
    async fn rejected_global_update_preserves_original_bytes() {
        let dir = TempDir::new().unwrap();
        let _settings_dir = SettingsDataDirGuard::set(dir.path());
        let path = dir.path().join("settings.json");
        let original = b"{ \"pandoc_path\": \"/original/pandoc\" }\n";
        std::fs::write(&path, original).unwrap();

        let error = update_global_settings(|current| {
            current.pandoc_path = Some("/must-not-persist".into());
            Err(AppError::InvalidInput("rejected update".into()))
        })
        .await
        .unwrap_err();

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert_eq!(std::fs::read(path).unwrap(), original);
    }

    #[tokio::test]
    async fn failed_serialization_preserves_original_bytes() {
        struct Unserializable;
        impl serde::Serialize for Unserializable {
            fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
            where
                S: serde::Serializer,
            {
                Err(serde::ser::Error::custom("serialization rejected"))
            }
        }
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        let original = b"{ \"pandoc_path\": \"/original/pandoc\" }\n";
        std::fs::write(&path, original).unwrap();

        assert!(matches!(
            atomic_write_json(&path, &Unserializable).await,
            Err(AppError::Json(_))
        ));
        assert_eq!(std::fs::read(path).unwrap(), original);
    }

    #[tokio::test]
    #[serial(settings_data_dir)]
    async fn failed_global_write_preserves_original_bytes() {
        let dir = TempDir::new().unwrap();
        let home = dir.path().join("home");
        let retained_home = dir.path().join("retained-home");
        std::fs::create_dir(&home).unwrap();
        let _settings_dir = SettingsDataDirGuard::set(&home);
        let original = b"{ \"pandoc_path\": \"/original/pandoc\" }\n";
        std::fs::write(home.join("settings.json"), original).unwrap();
        let home_to_block = home.clone();
        let retained = retained_home.clone();

        let result = update_global_settings(move |current| {
            current.pandoc_path = Some("/must-not-persist".into());
            // Force a filesystem error after the valid read, without relying
            // on platform-specific permissions or process privileges.
            std::fs::rename(&home_to_block, &retained)?;
            std::fs::write(&home_to_block, b"not a directory")?;
            Ok(())
        })
        .await;

        std::fs::remove_file(&home).unwrap();
        std::fs::rename(&retained_home, &home).unwrap();
        assert!(result.is_err());
        assert_eq!(std::fs::read(home.join("settings.json")).unwrap(), original);
    }

    #[tokio::test]
    async fn malformed_project_settings_preserve_original_bytes() {
        let dir = TempDir::new().unwrap();
        write_minimal_project(&dir, "[view\nmalformed");
        let path = dir.path().join(".novelist/project.toml");
        let original = std::fs::read(&path).unwrap();

        let result = write_project_settings(
            dir.path().to_string_lossy().into_owned(),
            Some(ViewConfig::default()),
            None,
            None,
            None,
        )
        .await;

        assert!(matches!(result, Err(AppError::TomlParse(_))));
        assert_eq!(std::fs::read(path).unwrap(), original);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_project_alias_updates_preserve_both_sections() {
        let dir = TempDir::new().unwrap();
        write_minimal_project(&dir, "");
        let alias_dir = TempDir::new().unwrap();
        let alias = alias_dir.path().join("project-link");
        std::os::unix::fs::symlink(dir.path(), &alias).unwrap();

        let (view, new_file) = tokio::join!(
            write_project_settings(
                dir.path().to_string_lossy().into_owned(),
                Some(ViewConfig {
                    show_hidden_files: Some(true),
                    ..Default::default()
                }),
                None,
                None,
                None,
            ),
            write_project_settings(
                alias.to_string_lossy().into_owned(),
                None,
                Some(NewFileConfig {
                    template: Some("Chapter {N}".into()),
                    ..Default::default()
                }),
                None,
                None,
            ),
        );
        view.unwrap();
        new_file.unwrap();
        let saved = read_project_config(dir.path()).await.unwrap();
        assert_eq!(saved.view.show_hidden_files, Some(true));
        assert_eq!(saved.new_file.template.as_deref(), Some("Chapter {N}"));
    }

    #[tokio::test]
    async fn held_project_transaction_does_not_block_other_projects() {
        let held_project = TempDir::new().unwrap();
        let other_project = TempDir::new().unwrap();
        write_minimal_project(&other_project, "");
        let _held = acquire_project_settings_guard(held_project.path())
            .await
            .unwrap();

        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            write_project_settings(
                other_project.path().to_string_lossy().into_owned(),
                Some(ViewConfig {
                    show_hidden_files: Some(true),
                    ..Default::default()
                }),
                None,
                None,
                None,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            read_project_config(other_project.path())
                .await
                .unwrap()
                .view
                .show_hidden_files,
            Some(true)
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial(settings_data_dir)]
    async fn aliased_global_paths_share_transaction_ownership() {
        let dir = TempDir::new().unwrap();
        let home = dir.path().join("home");
        let alias = dir.path().join("home-link");
        std::fs::create_dir(&home).unwrap();
        std::os::unix::fs::symlink(&home, &alias).unwrap();
        let _settings_dir = SettingsDataDirGuard::set(&home);
        std::fs::write(home.join("settings.json"), b"{}").unwrap();
        let (entered, wait_entered) = tokio::sync::oneshot::channel();
        let (release, wait_release) = std::sync::mpsc::channel();
        let first = tokio::spawn(update_global_settings(move |current| {
            current.view.show_hidden_files = Some(true);
            entered.send(()).unwrap();
            wait_release
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            Ok(())
        }));
        wait_entered.await.unwrap();
        let _alias_dir = SettingsDataDirGuard::set(&alias);
        // The second transaction must observe the first one's pending update
        // even though it addresses the same file via a symlinked home.
        let second = update_global_settings(|current| {
            assert_eq!(current.view.show_hidden_files, Some(true));
            current.new_file.template = Some("Chapter {N}".into());
            Ok(())
        });
        tokio::pin!(second);
        let early_result =
            tokio::time::timeout(std::time::Duration::from_millis(100), second.as_mut()).await;
        release.send(()).unwrap();
        assert!(
            early_result.is_err(),
            "alias update completed before the transaction released its guard"
        );
        second.await.unwrap();
        first.await.unwrap().unwrap();
        let saved = read_json::<GlobalSettings>(&home.join("settings.json"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.view.show_hidden_files, Some(true));
        assert_eq!(saved.new_file.template.as_deref(), Some("Chapter {N}"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial(settings_data_dir)]
    async fn cancelling_command_keeps_started_transaction_owned_until_commit() {
        let dir = TempDir::new().unwrap();
        let _settings_dir = SettingsDataDirGuard::set(dir.path());
        std::fs::write(dir.path().join("settings.json"), b"{}").unwrap();
        let (entered, wait_entered) = tokio::sync::oneshot::channel();
        let (release, wait_release) = std::sync::mpsc::channel();
        let first = tokio::spawn(update_global_settings(move |current| {
            current.view.show_hidden_files = Some(true);
            entered.send(()).unwrap();
            wait_release
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            Ok(())
        }));
        wait_entered.await.unwrap();
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        release.send(()).unwrap();
        update_global_settings(|current| {
            assert_eq!(current.view.show_hidden_files, Some(true));
            current.new_file.template = Some("Chapter {N}".into());
            Ok(())
        })
        .await
        .unwrap();
        let saved = read_json::<GlobalSettings>(&dir.path().join("settings.json"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(saved.view.show_hidden_files, Some(true));
        assert_eq!(saved.new_file.template.as_deref(), Some("Chapter {N}"));
    }

    #[tokio::test]
    #[serial(settings_data_dir)]
    async fn first_use_write_survives_another_commit_during_path_resolution() {
        let dir = TempDir::new().unwrap();
        let _settings_dir = SettingsDataDirGuard::set(dir.path());
        let path = dir.path().join("settings.json");
        let (entered, wait_entered) = tokio::sync::oneshot::channel();
        let (release, wait_release) = tokio::sync::oneshot::channel();
        *MISSING_GLOBAL_SETTINGS_PAUSE.lock().await = Some(MissingGlobalSettingsPause {
            path: path.clone(),
            entered,
            release: wait_release,
        });
        let paused = tokio::spawn(write_global_settings(
            Some(ViewConfig {
                show_hidden_files: Some(true),
                ..Default::default()
            }),
            None,
            None,
            None,
        ));
        wait_entered.await.unwrap();
        // Commit between the paused writer's canonicalize(NotFound) and
        // symlink_metadata, so that the latter observes a regular file.
        let committed = crate::commands::export::set_pandoc_path(Some("/test/pandoc".into())).await;
        release.send(()).unwrap();
        committed.unwrap();
        paused.await.unwrap().unwrap();

        let saved = read_json::<GlobalSettings>(&path).await.unwrap().unwrap();
        assert_eq!(saved.view.show_hidden_files, Some(true));
        assert_eq!(saved.pandoc_path.as_deref(), Some("/test/pandoc"));
    }
}
