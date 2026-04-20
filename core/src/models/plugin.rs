use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct PluginManifest {
    pub plugin: PluginMeta,
    pub ui: Option<PluginUiConfig>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct PluginUiConfig {
    #[serde(rename = "type")]
    pub ui_type: String,
    pub entry: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub file_extensions: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct PluginMeta {
    pub id: String,
    pub name: String,
    pub version: String,
    /// Free-form permission tokens declared by the plugin manifest.
    ///
    /// QuickJS sandbox tiers use `read` / `write` / `fs` / `net`
    /// (see `services::plugin_host::permissions::check_tier`). The
    /// IPC plugin bridge gates `ai.*` and `claude.*` methods on
    /// `ai:http` and `ai:claude-cli` respectively (see
    /// `app/lib/services/plugin-panel-bridge.ts`).
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub permissions: Vec<String>,
    pub active: bool,
    pub ui: Option<PluginUiConfig>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub icon: Option<String>,
    pub builtin: bool,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct RegisteredCommandInfo {
    pub plugin_id: String,
    pub command_id: String,
    pub label: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_manifest_deserialize() {
        let toml_str = r#"
[plugin]
id = "word-counter"
name = "Word Counter"
version = "1.0.0"
permissions = ["read"]
"#;
        let manifest: PluginManifest = toml::from_str(toml_str).unwrap();
        assert_eq!(manifest.plugin.id, "word-counter");
        assert_eq!(manifest.plugin.name, "Word Counter");
        assert_eq!(manifest.plugin.permissions, vec!["read"]);
    }

    #[test]
    fn test_manifest_accepts_ai_bridge_tokens() {
        let toml_str = r#"
[plugin]
id = "yolo"
name = "YOLO"
version = "0.1.0"
permissions = ["read", "write", "ui", "ai:http"]
"#;
        let manifest: PluginManifest = toml::from_str(toml_str).unwrap();
        assert!(manifest.plugin.permissions.contains(&"ai:http".to_string()));

        let toml_str = r#"
[plugin]
id = "claudian"
name = "Claudian"
version = "0.1.0"
permissions = ["read", "write", "ui", "ai:claude-cli"]
"#;
        let manifest: PluginManifest = toml::from_str(toml_str).unwrap();
        assert!(manifest
            .plugin
            .permissions
            .contains(&"ai:claude-cli".to_string()));
    }

    #[test]
    fn test_manifest_no_permissions() {
        let toml_str = r#"
[plugin]
id = "simple"
name = "Simple"
version = "0.1.0"
"#;
        let manifest: PluginManifest = toml::from_str(toml_str).unwrap();
        assert!(manifest.plugin.permissions.is_empty());
    }

    #[test]
    fn test_plugin_info_serialize() {
        let info = PluginInfo {
            id: "test".to_string(),
            name: "Test".to_string(),
            version: "1.0".to_string(),
            permissions: vec!["read".to_string(), "write".to_string()],
            active: true,
            ui: None,
            description: None,
            author: None,
            icon: None,
            builtin: false,
            enabled: true,
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"active\":true"));
        assert!(json.contains("\"permissions\":[\"read\",\"write\"]"));
    }
}
