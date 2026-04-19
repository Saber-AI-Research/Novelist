use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use std::time::SystemTime;

#[derive(Debug, Serialize, Deserialize, Clone, Type)]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened: String,
    /// `true` keeps the project above all unpinned ones. Optional in the
    /// persisted JSON so pre-existing files deserialize cleanly.
    #[serde(default)]
    pub pinned: bool,
    /// Manual rank within the pinned / unpinned group. Smaller = earlier.
    /// `None` falls back to `last_opened` order. Optional for back-compat.
    #[serde(default)]
    pub sort_order: Option<i64>,
}

fn recent_projects_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("~"))
        .join(".novelist")
        .join("recent-projects.json")
}

/// Canonical sort used by `get_recent_projects`:
/// 1. Pinned above unpinned.
/// 2. Within each group, ascending `sort_order` (ones without a rank land last).
/// 3. As a stable tiebreaker, descending `last_opened` (most recent first).
pub fn sort_projects(projects: &mut [RecentProject]) {
    projects.sort_by(|a, b| {
        // Pinned first.
        b.pinned.cmp(&a.pinned)
            // Then by sort_order ASC; None sorts after Some.
            .then_with(|| match (a.sort_order, b.sort_order) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
            // Then by last_opened DESC (most recent first) as tiebreaker.
            .then_with(|| b.last_opened.cmp(&a.last_opened))
    });
}

async fn read_projects() -> Vec<RecentProject> {
    let path = recent_projects_path();
    if !path.exists() {
        return vec![];
    }
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => vec![],
    }
}

async fn write_projects(projects: &[RecentProject]) -> Result<(), AppError> {
    let path = recent_projects_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let json = serde_json::to_string_pretty(projects)?;
    tokio::fs::write(&path, json).await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_recent_projects() -> Result<Vec<RecentProject>, AppError> {
    let mut projects = read_projects().await;
    let before_len = projects.len();

    // Filter out projects whose directories no longer exist.
    projects.retain(|p| std::path::Path::new(&p.path).exists());

    sort_projects(&mut projects);

    if projects.len() != before_len {
        let _ = write_projects(&projects).await;
    }

    Ok(projects)
}

#[tauri::command]
#[specta::specta]
pub async fn add_recent_project(path: String, name: String) -> Result<(), AppError> {
    let mut projects = read_projects().await;

    // Preserve pin / sort_order if the project already exists.
    let existing_pin = projects.iter().find(|p| p.path == path).map(|p| (p.pinned, p.sort_order));
    projects.retain(|p| p.path != path);

    let timestamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();

    projects.insert(
        0,
        RecentProject {
            path,
            name,
            last_opened: timestamp,
            pinned: existing_pin.map(|p| p.0).unwrap_or(false),
            sort_order: existing_pin.and_then(|p| p.1),
        },
    );

    // Cap history at 20 entries, but never drop pinned projects.
    if projects.len() > 20 {
        let mut kept: Vec<RecentProject> = Vec::with_capacity(20);
        let mut unpinned_count = 0usize;
        for p in projects.into_iter() {
            if p.pinned {
                kept.push(p);
            } else if unpinned_count < 20 - kept.iter().filter(|q| q.pinned).count() {
                unpinned_count += 1;
                kept.push(p);
            }
            if kept.len() >= 20 { break; }
        }
        projects = kept;
    }

    sort_projects(&mut projects);
    write_projects(&projects).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_recent_project(path: String) -> Result<(), AppError> {
    let mut projects = read_projects().await;
    projects.retain(|p| p.path != path);
    write_projects(&projects).await
}

/// Pin or unpin a single project. Pinned projects always sort above unpinned.
#[tauri::command]
#[specta::specta]
pub async fn set_project_pinned(path: String, pinned: bool) -> Result<(), AppError> {
    let mut projects = read_projects().await;
    let mut found = false;
    for p in projects.iter_mut() {
        if p.path == path {
            p.pinned = pinned;
            found = true;
            break;
        }
    }
    if !found {
        return Err(AppError::Custom(format!("Project not in recents: {path}")));
    }
    sort_projects(&mut projects);
    write_projects(&projects).await
}

/// Reorder recent projects by the given path list. Each path's index in
/// `ordered_paths` becomes its new `sort_order`. Paths not in the list keep
/// their existing `sort_order`.
#[tauri::command]
#[specta::specta]
pub async fn reorder_recent_projects(ordered_paths: Vec<String>) -> Result<(), AppError> {
    let mut projects = read_projects().await;
    for (idx, path) in ordered_paths.iter().enumerate() {
        for p in projects.iter_mut() {
            if &p.path == path {
                p.sort_order = Some(idx as i64);
                break;
            }
        }
    }
    sort_projects(&mut projects);
    write_projects(&projects).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(path: &str, name: &str, ts: &str) -> RecentProject {
        RecentProject {
            path: path.into(),
            name: name.into(),
            last_opened: ts.into(),
            pinned: false,
            sort_order: None,
        }
    }

    #[test]
    fn sort_puts_pinned_first() {
        let mut projects = vec![
            mk("/a", "A", "100"),
            RecentProject { pinned: true, ..mk("/b", "B", "50") },
            mk("/c", "C", "200"),
        ];
        sort_projects(&mut projects);
        assert_eq!(projects[0].path, "/b", "pinned should come first");
        // Then /c (last_opened=200) before /a (last_opened=100).
        assert_eq!(projects[1].path, "/c");
        assert_eq!(projects[2].path, "/a");
    }

    #[test]
    fn sort_order_overrides_last_opened_within_a_group() {
        let mut projects = vec![
            RecentProject { sort_order: Some(2), ..mk("/a", "A", "300") },
            RecentProject { sort_order: Some(0), ..mk("/b", "B", "100") },
            RecentProject { sort_order: Some(1), ..mk("/c", "C", "200") },
        ];
        sort_projects(&mut projects);
        assert_eq!(projects[0].path, "/b");
        assert_eq!(projects[1].path, "/c");
        assert_eq!(projects[2].path, "/a");
    }

    #[test]
    fn projects_without_sort_order_sort_after_those_with_it() {
        let mut projects = vec![
            mk("/a", "A", "999"),
            RecentProject { sort_order: Some(0), ..mk("/b", "B", "10") },
        ];
        sort_projects(&mut projects);
        assert_eq!(projects[0].path, "/b", "explicit sort_order wins");
        assert_eq!(projects[1].path, "/a");
    }

    #[test]
    fn deserializes_legacy_json_without_new_fields() {
        let legacy = r#"[{"path":"/x","name":"X","last_opened":"100"}]"#;
        let projects: Vec<RecentProject> = serde_json::from_str(legacy).unwrap();
        assert_eq!(projects.len(), 1);
        assert!(!projects[0].pinned);
        assert_eq!(projects[0].sort_order, None);
    }

    #[test]
    fn add_preserves_existing_pin_state_on_reopen() {
        // Simulate the add_recent_project code path on the in-memory list.
        let mut projects = vec![
            RecentProject { pinned: true, sort_order: Some(3), ..mk("/a", "Old Name", "100") },
        ];
        let existing_pin = projects.iter().find(|p| p.path == "/a").map(|p| (p.pinned, p.sort_order));
        projects.retain(|p| p.path != "/a");
        projects.insert(
            0,
            RecentProject {
                path: "/a".into(),
                name: "New Name".into(),
                last_opened: "999".into(),
                pinned: existing_pin.map(|p| p.0).unwrap_or(false),
                sort_order: existing_pin.and_then(|p| p.1),
            },
        );
        assert!(projects[0].pinned, "pinned state must survive re-open");
        assert_eq!(projects[0].sort_order, Some(3));
        assert_eq!(projects[0].name, "New Name");
    }

    #[test]
    fn pin_filter_skips_unknown_project() {
        let mut projects = vec![mk("/a", "A", "100")];
        // Simulate the set_project_pinned loop for a missing path.
        let mut found = false;
        for p in projects.iter_mut() {
            if p.path == "/missing" {
                p.pinned = true;
                found = true;
            }
        }
        assert!(!found);
    }
}
