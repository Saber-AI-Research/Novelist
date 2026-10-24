use crate::error::AppError;
use crate::services::atomic_file::atomic_write_sync;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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
    crate::services::portable::novelist_home().join("recent-projects.json")
}

/// Canonical sort used by `get_recent_projects`:
/// 1. Pinned above unpinned.
/// 2. Within each group, ascending `sort_order` (ones without a rank land last).
/// 3. As a stable tiebreaker, descending `last_opened` (most recent first).
pub fn sort_projects(projects: &mut [RecentProject]) {
    projects.sort_by(|a, b| {
        // Pinned first.
        b.pinned
            .cmp(&a.pinned)
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

/// Reads the recent-projects list from `file`. A missing file is an empty list.
///
/// An unparseable file is never treated as empty in place: the next write would
/// overwrite it and silently lose every pin and manual order. It is moved aside
/// to `<file>.corrupt-<unix-nanos>.bak` first, so the welcome screen keeps
/// working with an empty list while the original bytes stay recoverable. If the
/// file cannot be moved aside (or cannot be read at all), the error is returned
/// and callers write nothing.
async fn read_projects(file: &Path) -> Result<Vec<RecentProject>, AppError> {
    let bytes = match tokio::fs::read(file).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let parse_error = match serde_json::from_slice(&bytes) {
        Ok(projects) => return Ok(projects),
        Err(error) => error,
    };
    let mut backup = file.as_os_str().to_owned();
    backup.push(format!(
        ".corrupt-{}.bak",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let backup = PathBuf::from(backup);
    match tokio::fs::rename(file, &backup).await {
        Ok(()) => tracing::warn!(
            error = %parse_error,
            backup = %backup.display(),
            "recent projects list was unreadable; preserved it and started a new list"
        ),
        // A concurrent call already moved the same corrupt file aside.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(Vec::new())
}

async fn write_projects(file: &Path, projects: &[RecentProject]) -> Result<(), AppError> {
    let json = serde_json::to_vec_pretty(projects)?;
    let file = file.to_path_buf();
    tokio::task::spawn_blocking(move || atomic_write_sync(&file, &json))
        .await
        .map_err(|error| AppError::Custom(format!("Recent projects write failed: {error}")))?
}

#[tauri::command]
#[specta::specta]
pub async fn get_recent_projects(app: tauri::AppHandle) -> Result<Vec<RecentProject>, AppError> {
    // Fast path: read + sort, no per-project `Path::exists()` stat.
    // Previously this did a blocking stat per entry on every boot (dozens of
    // syscalls for users with many projects), blocking App.svelte's onMount.
    let file = recent_projects_path();
    let mut projects = read_projects(&file).await?;
    sort_projects(&mut projects);

    // Fire-and-forget cleanup: verify each path exists off the critical
    // path, then rewrite + emit "recent-projects-updated" if anything
    // changed. The UI listens for that event and refreshes its list.
    let projects_clone = projects.clone();
    tokio::spawn(async move {
        let before_len = projects_clone.len();
        let mut filtered = projects_clone;
        filtered.retain(|p| std::path::Path::new(&p.path).exists());
        if filtered.len() != before_len {
            sort_projects(&mut filtered);
            if write_projects(&file, &filtered).await.is_ok() {
                use tauri::Emitter;
                let _ = app.emit("recent-projects-updated", &filtered);
            }
        }
    });

    Ok(projects)
}

#[tauri::command]
#[specta::specta]
pub async fn add_recent_project(path: String, name: String) -> Result<(), AppError> {
    add_project_in(&recent_projects_path(), path, name).await
}

async fn add_project_in(file: &Path, path: String, name: String) -> Result<(), AppError> {
    let mut projects = read_projects(file).await?;

    // Preserve pin / sort_order if the project already exists.
    let existing_pin = projects
        .iter()
        .find(|p| p.path == path)
        .map(|p| (p.pinned, p.sort_order));
    projects.retain(|p| p.path != path);

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
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
            if kept.len() >= 20 {
                break;
            }
        }
        projects = kept;
    }

    sort_projects(&mut projects);
    write_projects(file, &projects).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_recent_project(path: String) -> Result<(), AppError> {
    remove_project_in(&recent_projects_path(), &path).await
}

async fn remove_project_in(file: &Path, path: &str) -> Result<(), AppError> {
    let mut projects = read_projects(file).await?;
    projects.retain(|p| p.path != path);
    write_projects(file, &projects).await
}

/// Pin or unpin a single project. Pinned projects always sort above unpinned.
#[tauri::command]
#[specta::specta]
pub async fn set_project_pinned(path: String, pinned: bool) -> Result<(), AppError> {
    set_pinned_in(&recent_projects_path(), &path, pinned).await
}

async fn set_pinned_in(file: &Path, path: &str, pinned: bool) -> Result<(), AppError> {
    let mut projects = read_projects(file).await?;
    let Some(project) = projects.iter_mut().find(|p| p.path == path) else {
        return Err(AppError::Custom(format!("Project not in recents: {path}")));
    };
    project.pinned = pinned;
    sort_projects(&mut projects);
    write_projects(file, &projects).await
}

/// Reorder recent projects by the given path list. Each path's index in
/// `ordered_paths` becomes its new `sort_order`. Paths not in the list keep
/// their existing `sort_order`.
#[tauri::command]
#[specta::specta]
pub async fn reorder_recent_projects(ordered_paths: Vec<String>) -> Result<(), AppError> {
    reorder_in(&recent_projects_path(), &ordered_paths).await
}

async fn reorder_in(file: &Path, ordered_paths: &[String]) -> Result<(), AppError> {
    let mut projects = read_projects(file).await?;
    for (idx, path) in ordered_paths.iter().enumerate() {
        if let Some(project) = projects.iter_mut().find(|p| &p.path == path) {
            project.sort_order = Some(idx as i64);
        }
    }
    sort_projects(&mut projects);
    write_projects(file, &projects).await
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
            RecentProject {
                pinned: true,
                ..mk("/b", "B", "50")
            },
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
            RecentProject {
                sort_order: Some(2),
                ..mk("/a", "A", "300")
            },
            RecentProject {
                sort_order: Some(0),
                ..mk("/b", "B", "100")
            },
            RecentProject {
                sort_order: Some(1),
                ..mk("/c", "C", "200")
            },
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
            RecentProject {
                sort_order: Some(0),
                ..mk("/b", "B", "10")
            },
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

    fn recents_file(dir: &tempfile::TempDir) -> PathBuf {
        dir.path()
            .join("novelist-home")
            .join("recent-projects.json")
    }

    fn file_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn reopening_a_project_keeps_its_pin_and_rank() {
        let dir = tempfile::tempdir().unwrap();
        let file = recents_file(&dir);
        add_project_in(&file, "/书/甲".into(), "旧名字".into())
            .await
            .unwrap();
        add_project_in(&file, "/b".into(), "B".into())
            .await
            .unwrap();
        set_pinned_in(&file, "/书/甲", true).await.unwrap();
        reorder_in(&file, &["/书/甲".to_string()]).await.unwrap();

        add_project_in(&file, "/书/甲".into(), "新名字".into())
            .await
            .unwrap();

        let projects = read_projects(&file).await.unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].path, "/书/甲");
        assert!(projects[0].pinned, "pinned state must survive re-open");
        assert_eq!(projects[0].sort_order, Some(0));
        assert_eq!(projects[0].name, "新名字");
        assert_eq!(projects[1].path, "/b");
        // Atomic writes leave no staging files next to the list.
        assert_eq!(file_names(file.parent().unwrap()), ["recent-projects.json"]);
    }

    #[tokio::test]
    async fn pinning_an_unknown_project_fails_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let file = recents_file(&dir);
        add_project_in(&file, "/a".into(), "A".into())
            .await
            .unwrap();
        let before = std::fs::read(&file).unwrap();

        let error = set_pinned_in(&file, "/missing", true).await.unwrap_err();

        assert!(error.to_string().contains("/missing"), "{error}");
        assert_eq!(std::fs::read(&file).unwrap(), before);
    }

    #[tokio::test]
    async fn capping_and_removing_history_keeps_pinned_projects() {
        let dir = tempfile::tempdir().unwrap();
        let file = recents_file(&dir);
        add_project_in(&file, "/pinned".into(), "Pinned".into())
            .await
            .unwrap();
        set_pinned_in(&file, "/pinned", true).await.unwrap();
        for index in 0..25 {
            add_project_in(&file, format!("/p{index}"), format!("P{index}"))
                .await
                .unwrap();
        }

        let projects = read_projects(&file).await.unwrap();
        assert_eq!(projects.len(), 20);
        assert_eq!(projects[0].path, "/pinned");
        assert!(projects.iter().any(|p| p.path == "/p24"));
        assert!(!projects.iter().any(|p| p.path == "/p5"));

        remove_project_in(&file, "/p24").await.unwrap();
        let projects = read_projects(&file).await.unwrap();
        assert_eq!(projects.len(), 19);
        assert!(!projects.iter().any(|p| p.path == "/p24"));
    }

    #[tokio::test]
    async fn corrupt_list_is_preserved_instead_of_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let file = recents_file(&dir);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let corrupt = r#"[{"path":"/书/甲","name":"甲","last_opened":"1""#.as_bytes();
        std::fs::write(&file, corrupt).unwrap();

        add_project_in(&file, "/new".into(), "New".into())
            .await
            .unwrap();

        let projects = read_projects(&file).await.unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].path, "/new");
        let backups: Vec<String> = file_names(file.parent().unwrap())
            .into_iter()
            .filter(|name| {
                name.starts_with("recent-projects.json.corrupt-") && name.ends_with(".bak")
            })
            .collect();
        assert_eq!(backups.len(), 1, "{backups:?}");
        assert_eq!(
            std::fs::read(file.parent().unwrap().join(&backups[0])).unwrap(),
            corrupt
        );
    }

    #[tokio::test]
    async fn unreadable_list_is_an_error_not_an_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let file = recents_file(&dir);
        std::fs::create_dir_all(&file).unwrap();

        assert!(add_project_in(&file, "/a".into(), "A".into())
            .await
            .is_err());
        assert!(file.is_dir(), "nothing may replace an unreadable list");
    }
}
