//! WebDAV backup helpers for snapshots.
//!
//! Remote path scheme:
//!   `{webdav_url}/novelist-snapshots/{slug}-{hash8}/`
//!       project.json          ← identity card, written once on first upload
//!       snap-{ts}/
//!           metadata.json
//!           files/…
//!
//! Every operation is best-effort: failure is logged, never returned to caller.

use crate::services::snapshots::{snapshots_dir, SnapshotMeta};
use crate::services::sync::read_sync_config;
use crate::services::webdav::{create_collection, delete_remote, upload_file, WebDavAuth};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::Path;
use walkdir::WalkDir;

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

/// Remote directory for a specific snapshot: `novelist-snapshots/{slug}-{hash8}/snap-{ts}`.
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
        client: Client::new(),
        base_url: cfg.webdav_url,
        auth: WebDavAuth {
            username: cfg.username,
            password: cfg.password,
        },
    })
}

// ── pre-upload identity check ─────────────────────────────────────────────────

/// Ensure the remote project dir exists and belongs to this local project.
/// Returns `false` if a collision is detected (remote claims a different path).
async fn verify_or_create_identity(ctx: &WebDavCtx, project_dir: &str) -> bool {
    let proj_remote = remote_project_dir(project_dir);
    let identity_path = format!("{}/project.json", proj_remote);
    let identity_url = format!(
        "{}/{}",
        ctx.base_url.trim_end_matches('/'),
        identity_path.trim_start_matches('/')
    );

    // PROPFIND (depth 0) to check if the dir exists.
    let propfind_url = format!(
        "{}/{}",
        ctx.base_url.trim_end_matches('/'),
        proj_remote.trim_start_matches('/')
    );
    let exists_resp = ctx
        .client
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").unwrap(),
            &propfind_url,
        )
        .basic_auth(&ctx.auth.username, Some(&ctx.auth.password))
        .header("Depth", "0")
        .header("Content-Type", "application/xml")
        .body(r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#)
        .send()
        .await;

    // 207 Multi-Status is PROPFIND's normal success code and already falls
    // inside the 2xx range — no separate arm needed.
    let dir_exists = matches!(
        exists_resp.as_ref().map(|r| r.status().as_u16()),
        Ok(200..=299)
    );

    if dir_exists {
        // Try to GET project.json and verify original_path.
        let get_resp = ctx
            .client
            .get(&identity_url)
            .basic_auth(&ctx.auth.username, Some(&ctx.auth.password))
            .send()
            .await;

        if let Ok(resp) = get_resp {
            if resp.status().is_success() {
                if let Ok(text) = resp.text().await {
                    if let Ok(id) = serde_json::from_str::<ProjectIdentity>(&text) {
                        if id.original_path != project_dir {
                            tracing::warn!(
                                "WebDAV path collision: remote project.json says {}, local is {}. \
                                 Skipping remote upload for this snapshot.",
                                id.original_path,
                                project_dir
                            );
                            return false;
                        }
                    }
                    // If project.json exists but can't be parsed, claim it by overwriting.
                }
                return true; // identity matches
            }
            // project.json missing (404) → write it below.
        }
    }

    // Dir doesn't exist or project.json is absent — create and write identity.
    if !dir_exists {
        let root_coll = format!("{}/novelist-snapshots", ctx.base_url.trim_end_matches('/'));
        let _ = ctx
            .client
            .request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), &root_coll)
            .basic_auth(&ctx.auth.username, Some(&ctx.auth.password))
            .send()
            .await;
        let _ = ctx
            .client
            .request(
                reqwest::Method::from_bytes(b"MKCOL").unwrap(),
                &propfind_url,
            )
            .basic_auth(&ctx.auth.username, Some(&ctx.auth.password))
            .send()
            .await;
    }

    let folder_name = Path::new(project_dir)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project")
        .to_string();
    let identity = ProjectIdentity {
        original_path: project_dir.to_string(),
        display_name: folder_name,
    };
    let body = serde_json::to_string(&identity).unwrap_or_default();
    let _ = ctx
        .client
        .put(&identity_url)
        .basic_auth(&ctx.auth.username, Some(&ctx.auth.password))
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await;

    true
}

// ── public API ────────────────────────────────────────────────────────────────

/// Upload a snapshot's files to WebDAV. Best-effort; logs on failure.
pub async fn try_upload_snapshot(project_dir: &str, meta: &SnapshotMeta) {
    let ctx = match get_webdav_ctx(project_dir) {
        Some(c) => c,
        None => return,
    };

    if !verify_or_create_identity(&ctx, project_dir).await {
        return;
    }

    let snap_remote = remote_snap_dir(project_dir, &meta.id);
    let files_remote = format!("{}/files", snap_remote);

    // Create snap dir and files/ subdir.
    if let Err(e) = create_collection(&ctx.client, &ctx.base_url, &snap_remote, &ctx.auth).await {
        tracing::warn!("snapshot WebDAV: MKCOL {} failed: {e}", snap_remote);
        return;
    }
    if let Err(e) = create_collection(&ctx.client, &ctx.base_url, &files_remote, &ctx.auth).await {
        tracing::warn!("snapshot WebDAV: MKCOL {} failed: {e}", files_remote);
        return;
    }

    // Walk local files/ dir, MKCOL subdirs, PUT files.
    let local_snap_dir = snapshots_dir(project_dir).join(&meta.id);
    let local_files_dir = local_snap_dir.join("files");

    for entry in WalkDir::new(&local_files_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let relative = match path.strip_prefix(&local_files_dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        let remote_item = format!(
            "{}/{}",
            files_remote,
            relative.to_string_lossy().replace('\\', "/")
        );
        if path.is_dir() {
            let _ = create_collection(&ctx.client, &ctx.base_url, &remote_item, &ctx.auth).await;
        } else if let Err(e) =
            upload_file(&ctx.client, &ctx.base_url, &remote_item, path, &ctx.auth).await
        {
            tracing::warn!("snapshot WebDAV: PUT {} failed: {e}", remote_item);
        }
    }

    // PUT metadata.json last (so a partial upload doesn't look complete).
    let local_meta = local_snap_dir.join("metadata.json");
    let remote_meta = format!("{}/metadata.json", snap_remote);
    if let Err(e) = upload_file(
        &ctx.client,
        &ctx.base_url,
        &remote_meta,
        &local_meta,
        &ctx.auth,
    )
    .await
    {
        tracing::warn!("snapshot WebDAV: PUT metadata.json failed: {e}");
    }
}

/// Delete a snapshot's remote directory. Best-effort; logs on failure.
pub async fn try_delete_snapshot_remote(project_dir: &str, snap_id: &str) {
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
}
