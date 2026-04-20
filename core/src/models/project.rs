use crate::models::settings::{NewFileConfig, PluginsConfig, ViewConfig};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct ProjectConfig {
    pub project: ProjectMeta,
    #[serde(default)]
    pub outline: OutlineConfig,
    #[serde(default)]
    pub writing: WritingConfig,
    /// Sidebar/file-tree view preferences. Overrides global `~/.novelist/settings.json`.
    #[serde(default, skip_serializing_if = "is_default_view")]
    pub view: ViewConfig,
    /// New-file template preferences. Overrides global.
    #[serde(default, skip_serializing_if = "is_default_new_file", rename = "new_file")]
    pub new_file: NewFileConfig,
    /// Per-plugin enable flags (deltas from the global default map).
    #[serde(default, skip_serializing_if = "is_default_plugins")]
    pub plugins: PluginsConfig,
}

fn is_default_view(v: &ViewConfig) -> bool {
    v == &ViewConfig::default()
}
fn is_default_new_file(v: &NewFileConfig) -> bool {
    v == &NewFileConfig::default()
}
fn is_default_plugins(v: &PluginsConfig) -> bool {
    v.enabled.is_empty()
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct ProjectMeta {
    pub name: String,
    #[serde(rename = "type", default = "default_project_type")]
    pub project_type: String,
    #[serde(default = "default_version")]
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, Type)]
pub struct OutlineConfig {
    #[serde(default)]
    pub order: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct WritingConfig {
    #[serde(default = "default_daily_goal")]
    pub daily_goal: u32,
    #[serde(default = "default_auto_save_minutes")]
    pub auto_save_minutes: u32,
}

impl Default for WritingConfig {
    fn default() -> Self {
        Self {
            daily_goal: default_daily_goal(),
            auto_save_minutes: default_auto_save_minutes(),
        }
    }
}

fn default_project_type() -> String {
    "novel".to_string()
}
fn default_version() -> String {
    "0.1.0".to_string()
}
fn default_daily_goal() -> u32 {
    2000
}
fn default_auto_save_minutes() -> u32 {
    5
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_full_config_deserialize() {
        let toml_str = r#"
[project]
name = "My Novel"
type = "novel"
version = "1.0.0"

[outline]
order = ["chapter1.md", "chapter2.md"]

[writing]
daily_goal = 3000
auto_save_minutes = 10
"#;
        let config: ProjectConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.project.name, "My Novel");
        assert_eq!(config.project.project_type, "novel");
        assert_eq!(config.project.version, "1.0.0");
        assert_eq!(config.outline.order, vec!["chapter1.md", "chapter2.md"]);
        assert_eq!(config.writing.daily_goal, 3000);
        assert_eq!(config.writing.auto_save_minutes, 10);
    }

    #[test]
    fn test_minimal_config_defaults() {
        let toml_str = r#"
[project]
name = "Minimal"
"#;
        let config: ProjectConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.project.name, "Minimal");
        assert_eq!(config.project.project_type, "novel");
        assert_eq!(config.project.version, "0.1.0");
        assert!(config.outline.order.is_empty());
        assert_eq!(config.writing.daily_goal, 2000);
        assert_eq!(config.writing.auto_save_minutes, 5);
    }

    #[test]
    fn test_serialize_roundtrip() {
        let config = ProjectConfig {
            project: ProjectMeta {
                name: "Test".to_string(),
                project_type: "novel".to_string(),
                version: "0.1.0".to_string(),
            },
            outline: OutlineConfig {
                order: vec!["a.md".to_string()],
            },
            writing: WritingConfig {
                daily_goal: 1500,
                auto_save_minutes: 3,
            },
            view: Default::default(),
            new_file: Default::default(),
            plugins: Default::default(),
        };

        let serialized = toml::to_string(&config).unwrap();
        let deserialized: ProjectConfig = toml::from_str(&serialized).unwrap();
        assert_eq!(deserialized.project.name, "Test");
        assert_eq!(deserialized.writing.daily_goal, 1500);
        assert_eq!(deserialized.outline.order, vec!["a.md"]);
    }

    #[test]
    fn test_writing_config_default() {
        let wc = WritingConfig::default();
        assert_eq!(wc.daily_goal, 2000);
        assert_eq!(wc.auto_save_minutes, 5);
    }

    #[test]
    fn test_partial_writing_config() {
        let toml_str = r#"
[project]
name = "Partial"

[writing]
daily_goal = 500
"#;
        let config: ProjectConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.writing.daily_goal, 500);
        assert_eq!(config.writing.auto_save_minutes, 5); // default
    }

    #[test]
    fn test_legacy_project_toml_deserializes_with_empty_overlay() {
        // A pre-migration project.toml without view/new_file/plugins must still parse.
        let toml_str = r#"
[project]
name = "Legacy"

[writing]
daily_goal = 1000
"#;
        let config: ProjectConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.view, crate::models::settings::ViewConfig::default());
        assert_eq!(config.new_file, crate::models::settings::NewFileConfig::default());
        assert!(config.plugins.enabled.is_empty());
    }

    #[test]
    fn test_project_toml_roundtrip_with_overlay() {
        let toml_str = r#"
[project]
name = "With Overlay"

[view]
sort_mode = "numeric-asc"
show_hidden_files = true

[new_file]
template = "第{N}章"
auto_rename_from_h1 = false

[plugins]
enabled = { mindmap = false }
"#;
        let config: ProjectConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.view.sort_mode.as_deref(), Some("numeric-asc"));
        assert_eq!(config.view.show_hidden_files, Some(true));
        assert_eq!(config.new_file.template.as_deref(), Some("第{N}章"));
        assert_eq!(config.new_file.auto_rename_from_h1, Some(false));
        // detect_from_folder is None (not in TOML) — correct
        assert_eq!(config.new_file.detect_from_folder, None);
        assert_eq!(config.plugins.enabled.get("mindmap"), Some(&false));

        // Round-trip: serialize then parse again — sections must survive.
        let serialized = toml::to_string(&config).unwrap();
        let back: ProjectConfig = toml::from_str(&serialized).unwrap();
        assert_eq!(back.view.show_hidden_files, Some(true));
        assert_eq!(back.new_file.template.as_deref(), Some("第{N}章"));
        assert_eq!(back.plugins.enabled.get("mindmap"), Some(&false));
    }

    #[test]
    fn test_empty_overlay_sections_omitted_from_serialized_toml() {
        // If no overlay is set, don't write empty sections to disk.
        let config = ProjectConfig {
            project: ProjectMeta {
                name: "Bare".into(),
                project_type: "novel".into(),
                version: "0.1.0".into(),
            },
            outline: OutlineConfig::default(),
            writing: WritingConfig::default(),
            view: Default::default(),
            new_file: Default::default(),
            plugins: Default::default(),
        };
        let serialized = toml::to_string(&config).unwrap();
        assert!(
            !serialized.contains("[view]"),
            "empty view section should not be serialized"
        );
        assert!(
            !serialized.contains("[new_file]"),
            "empty new_file section should not be serialized"
        );
        assert!(
            !serialized.contains("[plugins]"),
            "empty plugins section should not be serialized"
        );
    }

    #[test]
    fn test_custom_project_type() {
        let toml_str = r#"
[project]
name = "My Blog"
type = "blog"
"#;
        let config: ProjectConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.project.project_type, "blog");
    }
}
