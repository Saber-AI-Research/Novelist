//! Settings layer shared by the global `~/.novelist/settings.json` and the
//! per-project `<project>/.novelist/project.toml` overlay.
//!
//! Each section uses `Option<T>` for individual fields so we can tell
//! "unset" apart from "explicitly false/empty". Project values override
//! global values field-by-field during resolve.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;

// Defaults mirror the pre-migration frontend behavior.
pub const DEFAULT_SORT_MODE: &str = "numeric-asc";
pub const DEFAULT_TEMPLATE: &str = "Untitled {N}";
pub const DEFAULT_SHOW_HIDDEN: bool = false;
pub const DEFAULT_DETECT_FROM_FOLDER: bool = true;
pub const DEFAULT_AUTO_RENAME_FROM_H1: bool = true;

/// Sidebar / file-tree view preferences.
#[derive(Debug, Default, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct ViewConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_hidden_files: Option<bool>,
}

/// New-file template preferences.
#[derive(Debug, Default, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct NewFileConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detect_from_folder: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_rename_from_h1: Option<bool>,
    /// User-pinned default location for new files. Absolute path. When set,
    /// Cmd+N always creates here regardless of the recent activity pointer.
    /// `None` means "follow the last-used tracker."
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_dir: Option<String>,
    /// Live pointer: directory of the most recently created file. Updated
    /// after every successful create (header button, Cmd+N, per-folder
    /// context menu). Seeded to the project root on first open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_dir: Option<String>,
}

/// Per-plugin enable flags. Project-level map stores only entries that
/// differ from the global default.
#[derive(Debug, Default, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct PluginsConfig {
    #[serde(default)]
    pub enabled: HashMap<String, bool>,
}

/// Shape written to `~/.novelist/settings.json`.
#[derive(Debug, Default, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct GlobalSettings {
    #[serde(default)]
    pub view: ViewConfig,
    #[serde(default)]
    pub new_file: NewFileConfig,
    #[serde(default)]
    pub plugins: PluginsConfig,
}

/// Fully resolved settings handed to the frontend — no `Option`s.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct ResolvedView {
    pub sort_mode: String,
    pub show_hidden_files: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct ResolvedNewFile {
    pub template: String,
    pub detect_from_folder: bool,
    pub auto_rename_from_h1: bool,
    /// Pinned default directory (`None` means no pin — use last-used instead).
    pub default_dir: Option<String>,
    /// Last-used directory (`None` means not yet recorded — caller uses project root).
    pub last_used_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct ResolvedPlugins {
    pub enabled: HashMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct EffectiveSettings {
    pub view: ResolvedView,
    pub new_file: ResolvedNewFile,
    pub plugins: ResolvedPlugins,
    /// True when a project is open — lets the UI show project-vs-global affordances.
    pub is_project_scoped: bool,
}

/// Merge global defaults with optional project overrides. Field-level override:
/// project values win when present; otherwise global; otherwise the baked-in default.
pub fn resolve(
    global: &GlobalSettings,
    project_view: Option<&ViewConfig>,
    project_new_file: Option<&NewFileConfig>,
    project_plugins: Option<&PluginsConfig>,
) -> EffectiveSettings {
    let view = ResolvedView {
        sort_mode: project_view
            .and_then(|v| v.sort_mode.clone())
            .or_else(|| global.view.sort_mode.clone())
            .unwrap_or_else(|| DEFAULT_SORT_MODE.to_string()),
        show_hidden_files: project_view
            .and_then(|v| v.show_hidden_files)
            .or(global.view.show_hidden_files)
            .unwrap_or(DEFAULT_SHOW_HIDDEN),
    };
    let new_file = ResolvedNewFile {
        template: project_new_file
            .and_then(|n| n.template.clone())
            .or_else(|| global.new_file.template.clone())
            .unwrap_or_else(|| DEFAULT_TEMPLATE.to_string()),
        detect_from_folder: project_new_file
            .and_then(|n| n.detect_from_folder)
            .or(global.new_file.detect_from_folder)
            .unwrap_or(DEFAULT_DETECT_FROM_FOLDER),
        auto_rename_from_h1: project_new_file
            .and_then(|n| n.auto_rename_from_h1)
            .or(global.new_file.auto_rename_from_h1)
            .unwrap_or(DEFAULT_AUTO_RENAME_FROM_H1),
        // Pinned default: project wins, then global, then None.
        default_dir: project_new_file
            .and_then(|n| n.default_dir.clone())
            .or_else(|| global.new_file.default_dir.clone()),
        // Last-used is per-project by nature, but global fallback keeps
        // scratch mode working.
        last_used_dir: project_new_file
            .and_then(|n| n.last_used_dir.clone())
            .or_else(|| global.new_file.last_used_dir.clone()),
    };

    // Plugins: project deltas merge on top of global map.
    let mut enabled = global.plugins.enabled.clone();
    if let Some(p) = project_plugins {
        for (k, v) in &p.enabled {
            enabled.insert(k.clone(), *v);
        }
    }

    EffectiveSettings {
        view,
        new_file,
        plugins: ResolvedPlugins { enabled },
        is_project_scoped: project_view.is_some()
            || project_new_file.is_some()
            || project_plugins.is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_global_falls_back_to_defaults() {
        let global = GlobalSettings::default();
        let eff = resolve(&global, None, None, None);
        assert_eq!(eff.view.sort_mode, DEFAULT_SORT_MODE);
        assert_eq!(eff.view.show_hidden_files, DEFAULT_SHOW_HIDDEN);
        assert_eq!(eff.new_file.template, DEFAULT_TEMPLATE);
        assert!(eff.new_file.detect_from_folder);
        assert!(eff.new_file.auto_rename_from_h1);
        assert!(eff.plugins.enabled.is_empty());
        assert!(!eff.is_project_scoped);
    }

    #[test]
    fn global_values_override_defaults() {
        let global = GlobalSettings {
            view: ViewConfig {
                sort_mode: Some("name-asc".into()),
                show_hidden_files: Some(true),
            },
            new_file: NewFileConfig {
                template: Some("第{N}章".into()),
                detect_from_folder: Some(false),
                auto_rename_from_h1: None,
                default_dir: None,
                last_used_dir: None,
            },
            plugins: PluginsConfig::default(),
        };
        let eff = resolve(&global, None, None, None);
        assert_eq!(eff.view.sort_mode, "name-asc");
        assert!(eff.view.show_hidden_files);
        assert_eq!(eff.new_file.template, "第{N}章");
        assert!(!eff.new_file.detect_from_folder);
        assert!(eff.new_file.auto_rename_from_h1); // falls through to baked default
    }

    #[test]
    fn project_view_wins_field_by_field() {
        let global = GlobalSettings {
            view: ViewConfig {
                sort_mode: Some("name-asc".into()),
                show_hidden_files: Some(false),
            },
            ..Default::default()
        };
        let project_view = ViewConfig {
            // only overrides show_hidden_files; sort_mode inherited from global
            sort_mode: None,
            show_hidden_files: Some(true),
        };
        let eff = resolve(&global, Some(&project_view), None, None);
        assert_eq!(eff.view.sort_mode, "name-asc");
        assert!(eff.view.show_hidden_files);
        assert!(eff.is_project_scoped);
    }

    #[test]
    fn new_file_dir_fields_resolve_project_over_global_over_none() {
        let global = GlobalSettings {
            new_file: NewFileConfig {
                default_dir: Some("/glob/pin".into()),
                last_used_dir: Some("/glob/last".into()),
                ..Default::default()
            },
            ..Default::default()
        };

        // No project overlay — fall through to global.
        let eff = resolve(&global, None, None, None);
        assert_eq!(eff.new_file.default_dir.as_deref(), Some("/glob/pin"));
        assert_eq!(eff.new_file.last_used_dir.as_deref(), Some("/glob/last"));

        // Project overrides last_used_dir only; default_dir inherited.
        let proj = NewFileConfig {
            last_used_dir: Some("/proj/chapters".into()),
            ..Default::default()
        };
        let eff = resolve(&global, None, Some(&proj), None);
        assert_eq!(eff.new_file.default_dir.as_deref(), Some("/glob/pin"));
        assert_eq!(eff.new_file.last_used_dir.as_deref(), Some("/proj/chapters"));
    }

    #[test]
    fn plugins_project_delta_merges_with_global_map() {
        let mut global_map = HashMap::new();
        global_map.insert("canvas".to_string(), true);
        global_map.insert("mindmap".to_string(), true);
        global_map.insert("kanban".to_string(), true);
        let global = GlobalSettings {
            plugins: PluginsConfig { enabled: global_map },
            ..Default::default()
        };
        let mut project_map = HashMap::new();
        project_map.insert("mindmap".to_string(), false); // disable in this project
        let project_plugins = PluginsConfig { enabled: project_map };

        let eff = resolve(&global, None, None, Some(&project_plugins));
        assert_eq!(eff.plugins.enabled.get("canvas"), Some(&true));
        assert_eq!(eff.plugins.enabled.get("mindmap"), Some(&false));
        assert_eq!(eff.plugins.enabled.get("kanban"), Some(&true));
    }

    #[test]
    fn global_settings_json_round_trip() {
        let mut plugins = HashMap::new();
        plugins.insert("canvas".to_string(), true);
        let original = GlobalSettings {
            view: ViewConfig {
                sort_mode: Some("mtime-desc".into()),
                show_hidden_files: Some(true),
            },
            new_file: NewFileConfig {
                template: Some("Chapter {N}".into()),
                detect_from_folder: Some(true),
                auto_rename_from_h1: Some(true),
                default_dir: Some("/tmp/fixed".into()),
                last_used_dir: Some("/tmp/last".into()),
            },
            plugins: PluginsConfig { enabled: plugins },
        };
        let json = serde_json::to_string(&original).unwrap();
        let back: GlobalSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, original);
    }

    #[test]
    fn empty_global_settings_json_deserializes() {
        // An empty file should produce defaults, not fail.
        let back: GlobalSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(back, GlobalSettings::default());
    }
}
