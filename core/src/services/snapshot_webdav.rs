//! WebDAV backup helpers for snapshots.
//!
//! Remote path scheme:
//!   `{webdav_url}/novelist-snapshots/{slug}-{hash8}/`
//!       project.json          ← identity card, written once on first upload
//!       snap-{ts}/
//!           metadata.json
//!           files/…
//!
//! Failures are logged; metadata.json is a completion marker published only last.

use crate::services::project_files::is_project_content_path;
use crate::services::snapshots::{snapshots_dir, SnapshotMeta};
use crate::services::sync::read_sync_config;
use crate::services::webdav::{self, create_collection, delete_remote, WebDavAuth};
use crate::AppError;
use cap_fs_ext::DirExt;
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::Path;

// ── slug / hash helpers ───────────────────────────────────────────────────────

/// Sanitize project folder name for use in a WebDAV path segment.
/// Replaces illegal chars and whitespace with `_`.  Keeps CJK.
/// Falls back to "project" if the result is empty.
pub fn slug_sanitize(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| {
            if c.is_whitespace()
                || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('_');
    if trimmed.is_empty() {
        "project".to_string()
    } else {
        trimmed.to_string()
    }
}

/// First 8 hex chars of blake3(canonical_absolute_project_path).
pub fn hash8(project_dir: &str) -> String {
    let h = blake3::hash(project_dir.as_bytes()).to_hex();
    h[..8].to_string()
}

/// Remote base directory for a project: `novelist-snapshots/{slug}-{hash8}`.
pub fn remote_project_dir(project_dir: &str) -> String {
    let folder_name = Path::new(project_dir)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project");
    let slug = slug_sanitize(folder_name);
    let h8 = hash8(project_dir);
    format!("novelist-snapshots/{}-{}", slug, h8)
}

/// Remote directory for a snapshot; IDs may include a collision-avoidance suffix.
pub fn remote_snap_dir(project_dir: &str, snap_id: &str) -> String {
    format!("{}/{}", remote_project_dir(project_dir), snap_id)
}

// ── identity card ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct ProjectIdentity {
    original_path: String,
    display_name: String,
}

// ── WebDAV detection ──────────────────────────────────────────────────────────

struct WebDavCtx {
    client: Client,
    base_url: String,
    auth: WebDavAuth,
}

fn get_webdav_ctx(project_dir: &str) -> Option<WebDavCtx> {
    let cfg = read_sync_config(project_dir).ok()?;
    if !cfg.enabled || cfg.webdav_url.is_empty() || cfg.username.is_empty() {
        return None;
    }
    Some(WebDavCtx {
        client: Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(webdav::REQUEST_TIMEOUT)
            .timeout(webdav::REQUEST_TIMEOUT)
            .build()
            .ok()?,
        base_url: cfg.webdav_url,
        auth: WebDavAuth {
            username: cfg.username,
            password: cfg.password,
        },
    })
}

// ── pre-upload identity check ─────────────────────────────────────────────────

/// The identity must be readable and match, or be atomically created if absent.
async fn verify_or_create_identity(ctx: &WebDavCtx, project_dir: &str) -> Result<(), AppError> {
    let project_remote = remote_project_dir(project_dir);
    create_collection(&ctx.client, &ctx.base_url, "novelist-snapshots", &ctx.auth).await?;
    create_collection(&ctx.client, &ctx.base_url, &project_remote, &ctx.auth).await?;
    let identity_path = format!("{project_remote}/project.json");
    let response = ctx
        .client
        .get(webdav::remote_url(&ctx.base_url, &identity_path)?)
        .timeout(webdav::REQUEST_TIMEOUT)
        .basic_auth(&ctx.auth.username, Some(&ctx.auth.password))
        .send()
        .await
        .map_err(|error| {
            AppError::Custom(format!(
                "Snapshot identity GET failed: {}",
                error.without_url()
            ))
        })?;
    if response.status().is_success() {
        let bytes = response.bytes().await.map_err(|error| {
            AppError::Custom(format!(
                "Snapshot identity read failed: {}",
                error.without_url()
            ))
        })?;
        let identity: ProjectIdentity = serde_json::from_slice(&bytes)?;
        if identity.original_path != project_dir {
            return Err(AppError::Custom(
                "Snapshot remote project identity does not match".into(),
            ));
        }
        return Ok(());
    }
    if response.status().as_u16() != 404 {
        return Err(AppError::Custom(format!(
            "Snapshot identity GET returned {}",
            response.status()
        )));
    }
    let identity = ProjectIdentity {
        original_path: project_dir.to_string(),
        display_name: Path::new(project_dir)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::InvalidInput("Project name is not UTF-8".into()))?
            .to_string(),
    };
    webdav::put_bytes(
        &ctx.client,
        &ctx.base_url,
        &identity_path,
        serde_json::to_vec(&identity)?,
        &ctx.auth,
        webdav::PutCondition::Absent,
    )
    .await
}

// ── public API ────────────────────────────────────────────────────────────────

/// Return the immutable snapshot manifest without following directory/file links.
fn snapshot_files(root: &Dir) -> Result<Vec<String>, AppError> {
    fn walk(dir: &Dir, prefix: &str, files: &mut Vec<String>) -> Result<(), AppError> {
        for entry in dir.entries()? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| AppError::InvalidInput("Snapshot filename is not UTF-8".into()))?;
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            webdav::validate_remote_path(&relative)?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                return Err(AppError::PathNotAllowed(
                    "Snapshot contains a symlink".into(),
                ));
            }
            if kind.is_dir() {
                walk(&dir.open_dir_nofollow(&name)?, &relative, files)?;
            } else if kind.is_file() && is_project_content_path(Path::new(&relative)) {
                files.push(relative);
            } else {
                return Err(AppError::PathNotAllowed(
                    "Snapshot contains unsupported content".into(),
                ));
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(root, "", &mut files)?;
    files.sort();
    Ok(files)
}

async fn upload_snapshot(
    ctx: &WebDavCtx,
    project_dir: &str,
    meta: &SnapshotMeta,
    local_snapshot: &Dir,
) -> Result<(), AppError> {
    webdav::validate_remote_path(&meta.id)?;
    if meta.id.is_empty() || meta.id.contains('/') {
        return Err(AppError::InvalidInput("Invalid snapshot ID".into()));
    }
    verify_or_create_identity(ctx, project_dir).await?;
    let remote = remote_snap_dir(project_dir, &meta.id);
    create_collection(&ctx.client, &ctx.base_url, &remote, &ctx.auth).await?;
    let marker = format!("{remote}/metadata.json");
    // Invalidate a previous completion marker before retrying any content.
    delete_remote(&ctx.client, &ctx.base_url, &marker, &ctx.auth).await?;
    let files_remote = format!("{remote}/files");
    create_collection(&ctx.client, &ctx.base_url, &files_remote, &ctx.auth).await?;
    let files_root = local_snapshot.open_dir_nofollow("files")?;
    let files = snapshot_files(&files_root)?;
    if files.len() != meta.file_count {
        return Err(AppError::Custom(
            "Snapshot file count does not match metadata".into(),
        ));
    }
    let mut created = std::collections::HashSet::new();
    let mut total_bytes = 0u64;
    for relative in files {
        for (index, _) in relative.match_indices('/') {
            let parent = &relative[..index];
            if created.insert(parent.to_string()) {
                create_collection(
                    &ctx.client,
                    &ctx.base_url,
                    &format!("{files_remote}/{parent}"),
                    &ctx.auth,
                )
                .await?;
            }
        }
        let bytes = webdav::read_confined(&files_root, Path::new(&relative))?;
        total_bytes += bytes.len() as u64;
        webdav::put_bytes(
            &ctx.client,
            &ctx.base_url,
            &format!("{files_remote}/{relative}"),
            bytes,
            &ctx.auth,
            webdav::PutCondition::Unconditional,
        )
        .await?;
    }
    if total_bytes != meta.total_bytes {
        return Err(AppError::Custom(
            "Snapshot byte count does not match metadata".into(),
        ));
    }
    let metadata_bytes = webdav::read_confined(local_snapshot, Path::new("metadata.json"))?;
    let stored: SnapshotMeta = serde_json::from_slice(&metadata_bytes)?;
    if stored.id != meta.id
        || stored.file_count != meta.file_count
        || stored.total_bytes != meta.total_bytes
    {
        return Err(AppError::Custom(
            "Snapshot metadata changed during upload".into(),
        ));
    }
    webdav::put_bytes(
        &ctx.client,
        &ctx.base_url,
        &marker,
        metadata_bytes,
        &ctx.auth,
        webdav::PutCondition::Unconditional,
    )
    .await
}

/// Upload content first and publish its completion marker only on total success.
pub async fn try_upload_snapshot(project_dir: &str, meta: &SnapshotMeta) {
    let Some(ctx) = get_webdav_ctx(project_dir) else {
        return;
    };
    // Snapshot mutation holds its lock through mirroring; even a responsive but
    // very slow server must not monopolize that lock indefinitely.
    let result = tokio::time::timeout(std::time::Duration::from_secs(300), async {
        webdav::validate_remote_path(&meta.id)?;
        if meta.id.is_empty() || meta.id.contains('/') {
            return Err(AppError::InvalidInput("Invalid snapshot ID".into()));
        }
        let root = Dir::open_ambient_dir(snapshots_dir(project_dir), ambient_authority())?;
        let snapshot = root.open_dir_nofollow(&meta.id)?;
        upload_snapshot(&ctx, project_dir, meta, &snapshot).await
    })
    .await
    .unwrap_or_else(|_| {
        Err(AppError::Custom(
            "Snapshot WebDAV upload deadline exceeded".into(),
        ))
    });
    if let Err(error) = result {
        tracing::warn!("Snapshot WebDAV upload failed: {error}");
    }
}

/// Delete a snapshot's remote directory. Best-effort; logs on failure.
pub async fn try_delete_snapshot_remote(project_dir: &str, snap_id: &str) {
    if webdav::validate_remote_path(snap_id).is_err() || snap_id.is_empty() || snap_id.contains('/')
    {
        tracing::warn!("Snapshot WebDAV deletion rejected invalid ID");
        return;
    }
    let ctx = match get_webdav_ctx(project_dir) {
        Some(c) => c,
        None => return,
    };
    let snap_remote = remote_snap_dir(project_dir, snap_id);
    if let Err(e) = delete_remote(&ctx.client, &ctx.base_url, &snap_remote, &ctx.auth).await {
        tracing::warn!("snapshot WebDAV: DELETE {} failed: {e}", snap_remote);
    }
}

// ── pure-function unit tests ───────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slug_sanitize_keeps_cjk() {
        assert_eq!(slug_sanitize("小说"), "小说");
    }

    #[test]
    fn test_slug_sanitize_replaces_illegal() {
        // Trailing `?` → `_`, then trim_matches strips trailing `_`
        assert_eq!(slug_sanitize("my: project?"), "my__project");
    }

    #[test]
    fn test_slug_sanitize_empty_falls_back() {
        assert_eq!(slug_sanitize("///"), "project");
    }

    #[test]
    fn test_slug_sanitize_whitespace() {
        assert_eq!(slug_sanitize("my novel"), "my_novel");
    }

    #[test]
    fn test_hash8_stable() {
        let h = hash8("/Users/foo/Documents/小说");
        assert_eq!(h, hash8("/Users/foo/Documents/小说"));
        assert_eq!(h.len(), 8);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_hash8_different_paths() {
        assert_ne!(
            hash8("/Users/foo/Documents/小说"),
            hash8("/Users/bar/Documents/小说")
        );
    }

    #[test]
    fn test_remote_project_dir_format() {
        let dir = remote_project_dir("/Users/foo/novels/小说");
        assert!(dir.starts_with("novelist-snapshots/小说-"));
        let parts: Vec<&str> = dir.splitn(2, '/').collect();
        assert_eq!(parts[0], "novelist-snapshots");
        let slug_hash: Vec<&str> = parts[1].rsplitn(2, '-').collect();
        assert_eq!(slug_hash[0].len(), 8); // hash8
    }

    #[test]
    fn test_remote_snap_dir_format() {
        let d = remote_snap_dir("/Users/foo/proj", "snap-1000");
        assert!(d.contains("/snap-1000"));
        assert!(d.starts_with("novelist-snapshots/"));
    }

    #[tokio::test]
    async fn failed_upload_and_retry_never_publish_completion_metadata() {
        use crate::services::webdav::test_server::DavServer;
        let server = DavServer::start();
        let project = tempfile::tempdir().unwrap();
        let project_name = project.path().to_str().unwrap();
        let snapshot = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(snapshot.path().join("files/卷一/章节#?%")).unwrap();
        std::fs::write(
            snapshot.path().join("files/卷一/章节#?%/第一章.md"),
            b"chapter",
        )
        .unwrap();
        let meta = SnapshotMeta {
            id: "snap-3000-00000000000000000001".into(),
            name: "snapshot".into(),
            timestamp: 3000,
            file_count: 1,
            total_bytes: 7,
        };
        std::fs::write(
            snapshot.path().join("metadata.json"),
            serde_json::to_vec(&meta).unwrap(),
        )
        .unwrap();
        let root = Dir::open_ambient_dir(snapshot.path(), ambient_authority()).unwrap();
        let ctx = WebDavCtx {
            client: Client::new(),
            base_url: server.url.clone(),
            auth: WebDavAuth {
                username: "test".into(),
                password: "not-a-credential".into(),
            },
        };
        let remote = remote_snap_dir(project_name, &meta.id);
        let file_path = webdav::remote_url(
            &server.url,
            &format!("{remote}/files/卷一/章节#?%/第一章.md"),
        )
        .unwrap()
        .path()
        .to_string();
        let marker = webdav::remote_url(&server.url, &format!("{remote}/metadata.json"))
            .unwrap()
            .path()
            .to_string();
        server
            .state
            .lock()
            .unwrap()
            .files
            .insert(marker.clone(), b"stale completion".to_vec());
        server
            .state
            .lock()
            .unwrap()
            .fail
            .insert(("PUT".into(), file_path.clone()));
        for _ in 0..2 {
            assert!(upload_snapshot(&ctx, project_name, &meta, &root)
                .await
                .is_err());
            assert!(!server.state.lock().unwrap().files.contains_key(&marker));
        }
        assert!(!server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|request| request.method == "PUT" && request.path == marker));
        server.state.lock().unwrap().fail.clear();
        upload_snapshot(&ctx, project_name, &meta, &root)
            .await
            .unwrap();
        {
            let state = server.state.lock().unwrap();
            assert_eq!(state.files[&file_path], b"chapter");
            assert_eq!(
                serde_json::from_slice::<SnapshotMeta>(&state.files[&marker])
                    .unwrap()
                    .id,
                meta.id
            );
            let last = state.requests.last().unwrap();
            assert_eq!((&last.method, &last.path), (&"PUT".to_string(), &marker));
        }
        // A failed nested MKCOL on a subsequent retry must invalidate the old marker too.
        let directory = webdav::remote_url(&server.url, &format!("{remote}/files/卷一/章节#?%"))
            .unwrap()
            .path()
            .to_string();
        server
            .state
            .lock()
            .unwrap()
            .fail
            .insert(("MKCOL".into(), directory));
        assert!(upload_snapshot(&ctx, project_name, &meta, &root)
            .await
            .is_err());
        assert!(!server.state.lock().unwrap().files.contains_key(&marker));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_snapshot_file_never_publishes_metadata() {
        use crate::services::webdav::test_server::DavServer;
        let server = DavServer::start();
        let snapshot = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(snapshot.path().join("files")).unwrap();
        std::fs::write(outside.path().join("secret.md"), b"secret").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.md"),
            snapshot.path().join("files/chapter.md"),
        )
        .unwrap();
        let meta = SnapshotMeta {
            id: "snap-1".into(),
            name: "bad".into(),
            timestamp: 1,
            file_count: 1,
            total_bytes: 6,
        };
        let root = Dir::open_ambient_dir(snapshot.path(), ambient_authority()).unwrap();
        let ctx = WebDavCtx {
            client: Client::new(),
            base_url: server.url.clone(),
            auth: WebDavAuth {
                username: "test".into(),
                password: "not-a-credential".into(),
            },
        };
        assert!(
            upload_snapshot(&ctx, snapshot.path().to_str().unwrap(), &meta, &root)
                .await
                .is_err()
        );
        assert!(!server
            .state
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|request| request.method == "PUT"
                && (request.path.ends_with("metadata.json")
                    || request.path.ends_with("chapter.md"))));
    }

    #[tokio::test]
    async fn stalled_snapshot_upload_returns_without_publishing_completion() {
        use crate::services::webdav::test_server::DavServer;
        let server = DavServer::start();
        let snapshot = tempfile::tempdir().unwrap();
        std::fs::create_dir(snapshot.path().join("files")).unwrap();
        std::fs::write(snapshot.path().join("files/chapter.md"), b"chapter").unwrap();
        let meta = SnapshotMeta {
            id: "snap-1".into(),
            name: "snapshot".into(),
            timestamp: 1,
            file_count: 1,
            total_bytes: 7,
        };
        std::fs::write(
            snapshot.path().join("metadata.json"),
            serde_json::to_vec(&meta).unwrap(),
        )
        .unwrap();
        let project = snapshot.path().to_str().unwrap();
        let root = Dir::open_ambient_dir(snapshot.path(), ambient_authority()).unwrap();
        let ctx = WebDavCtx {
            client: Client::new(),
            base_url: server.url.clone(),
            auth: WebDavAuth {
                username: "test".into(),
                password: "not-a-credential".into(),
            },
        };
        let remote = remote_snap_dir(project, &meta.id);
        let file_path = webdav::remote_url(&server.url, &format!("{remote}/files/chapter.md"))
            .unwrap()
            .path()
            .to_string();
        let marker = webdav::remote_url(&server.url, &format!("{remote}/metadata.json"))
            .unwrap()
            .path()
            .to_string();
        server
            .state
            .lock()
            .unwrap()
            .stall
            .insert(("PUT".into(), file_path));
        let result = tokio::time::timeout(
            webdav::REQUEST_TIMEOUT * 3,
            upload_snapshot(&ctx, project, &meta, &root),
        )
        .await
        .expect("snapshot request must return before outer watchdog");
        assert!(result.is_err());
        assert!(!server.state.lock().unwrap().files.contains_key(&marker));
        server.state.lock().unwrap().stall.clear();
        upload_snapshot(&ctx, project, &meta, &root).await.unwrap();
        assert!(server.state.lock().unwrap().files.contains_key(&marker));
    }
}
