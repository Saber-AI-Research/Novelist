use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct ProjectConfig {
    pub project: ProjectMeta,
    #[serde(default)]
    pub outline: OutlineConfig,
    #[serde(default)]
    pub writing: WritingConfig,
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
