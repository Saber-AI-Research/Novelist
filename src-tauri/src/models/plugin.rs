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
    #[serde(default)]
    pub permissions: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub permissions: Vec<String>,
    pub active: bool,
    pub ui: Option<PluginUiConfig>,
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
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"active\":true"));
        assert!(json.contains("\"permissions\":[\"read\",\"write\"]"));
    }
}
