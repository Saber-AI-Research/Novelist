//! Tauri commands for publishing + per-platform media upload + the
//! Pandoc Markdown→HTML helper.
//!
//! Mirrors `commands/image_host.rs` — one command per platform, no
//! generic dispatcher. The frontend's `app/lib/services/publish.ts`
//! routes by `PlatformConfig.platform` discriminant.

use crate::error::AppError;
use crate::models::publish::{PlatformConfig, PublishSettings};
use crate::services::publish::binding::{BindingCapability, VerifiedBinding};
use crate::services::publish::cover_assets::{
    load_cover_bytes as asset_load_cover_bytes, store_cover_asset, CoverRef,
};
use crate::services::publish::sidecar::{
    acquire_cover_asset_transaction_lock, cleanup_orphan_assets, publish_sidecar_path,
    read_publish_form_drafts as sidecar_read_form_drafts, read_publish_sidecar as sidecar_read,
    update_publish_sidecar as sidecar_update, write_publish_form_draft as sidecar_write_form_draft,
    ChannelState, FormDraft, PublishFormDraftsSnapshot, RemoteIdentity,
};
use crate::services::publish::types::{
    ProviderRevision, PublishError, PublishInput, PublishOperation, PublishResult,
    UnsupportedUpdateReason, UpdateTarget,
};
use crate::services::publish::{ghost, medium, pandoc_html, wordpress, wordpress_com};
use std::path::PathBuf;

impl From<PublishError> for AppError {
    fn from(e: PublishError) -> AppError {
        let fallback = e.to_string();
        AppError::Custom(serde_json::to_string(&e).unwrap_or(fallback))
    }
}

#[tauri::command]
#[specta::specta]
pub async fn publish_to_ghost(
    input: PublishInput,
    config: PlatformConfig,
) -> Result<PublishResult, AppError> {
    Ok(ghost::publish(&config, &input).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn publish_to_wordpress_self_hosted(
    input: PublishInput,
    config: PlatformConfig,
) -> Result<PublishResult, AppError> {
    Ok(wordpress::publish(&config, &input).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn publish_to_wordpress_com(
    input: PublishInput,
    config: PlatformConfig,
) -> Result<PublishResult, AppError> {
    Ok(wordpress_com::publish(&config, &input).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn publish_to_medium(
    input: PublishInput,
    config: PlatformConfig,
) -> Result<PublishResult, AppError> {
    Ok(medium::publish(&config, &input).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn verify_wordpress_self_hosted_update(
    update_target: UpdateTarget,
    config: PlatformConfig,
) -> Result<(), AppError> {
    Ok(wordpress::verify_update(&config, &update_target).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn verify_wordpress_com_update(
    update_target: UpdateTarget,
    config: PlatformConfig,
) -> Result<(), AppError> {
    Ok(wordpress_com::verify_update(&config, &update_target).await?)
}

/// Returns `(hosted_url, attachment_id_or_zero)`. Only WordPress
/// returns a non-zero attachment id (used for `featured_media`).
#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
pub struct PostImageUploadResult {
    pub url: String,
    pub attachment_id: u64,
}

#[tauri::command]
#[specta::specta]
pub async fn upload_post_image_ghost(
    bytes: Vec<u8>,
    filename: String,
    mime: String,
    config: PlatformConfig,
) -> Result<PostImageUploadResult, AppError> {
    let (admin_url, api_key) = match &config {
        PlatformConfig::Ghost { admin_url, api_key } => (admin_url, api_key),
        _ => return Err(AppError::Custom("not a Ghost config".into())),
    };
    let url = ghost::upload_image(admin_url, api_key, bytes, filename, mime).await?;
    Ok(PostImageUploadResult {
        url,
        attachment_id: 0,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn upload_post_image_wordpress_self_hosted(
    bytes: Vec<u8>,
    filename: String,
    mime: String,
    config: PlatformConfig,
) -> Result<PostImageUploadResult, AppError> {
    let (site_url, username, app_password) = match &config {
        PlatformConfig::WordPressSelfHosted {
            site_url,
            username,
            app_password,
        } => (site_url, username, app_password),
        _ => return Err(AppError::Custom("not a WordPress config".into())),
    };
    let auth = wordpress::basic_auth_header(username, app_password);
    let (url, id) = wordpress::upload_image(site_url, &auth, bytes, filename, mime).await?;
    Ok(PostImageUploadResult {
        url,
        attachment_id: id,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn upload_post_image_wordpress_com(
    bytes: Vec<u8>,
    filename: String,
    mime: String,
    config: PlatformConfig,
) -> Result<PostImageUploadResult, AppError> {
    let (site, token) = match &config {
        PlatformConfig::WordPressCom {
            site_id_or_domain,
            access_token,
        } => (site_id_or_domain, access_token),
        _ => return Err(AppError::Custom("not a WordPress.com config".into())),
    };
    let (url, id) = wordpress_com::upload_image(site, token, bytes, filename, mime).await?;
    Ok(PostImageUploadResult {
        url,
        attachment_id: id,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn upload_post_image_medium(
    bytes: Vec<u8>,
    filename: String,
    mime: String,
    config: PlatformConfig,
) -> Result<PostImageUploadResult, AppError> {
    let token = match &config {
        PlatformConfig::Medium { token } => token,
        _ => return Err(AppError::Custom("not a Medium config".into())),
    };
    let url = medium::upload_image(token, bytes, filename, mime).await?;
    Ok(PostImageUploadResult {
        url,
        attachment_id: 0,
    })
}

/// Fetch existing tag names for the channel (used by the Publish
/// dialog's tag autocomplete). Returns an empty vec for platforms
/// that don't expose a tag-list API in v0.2.4 (Medium, WordPress —
/// can be added later by extending the relevant adapter).
#[tauri::command]
#[specta::specta]
pub async fn list_publish_tags(config: PlatformConfig) -> Result<Vec<String>, AppError> {
    Ok(match &config {
        PlatformConfig::Ghost { admin_url, api_key } => {
            ghost::list_tags(admin_url, api_key).await?
        }
        // WP/WP.com tag listing requires pagination; deferred to v0.2.5.
        // Medium has no public tag-listing API.
        PlatformConfig::WordPressSelfHosted { .. }
        | PlatformConfig::WordPressCom { .. }
        | PlatformConfig::Medium { .. } => Vec::new(),
    })
}

/// Read-only credentials check per platform. Returns a short
/// human-friendly status line like "Connected as alice" on success;
/// errors propagate with the platform's response body included.
#[tauri::command]
#[specta::specta]
pub async fn verify_publish_channel(config: PlatformConfig) -> Result<String, AppError> {
    Ok(match &config {
        PlatformConfig::Ghost { admin_url, api_key } => ghost::verify(admin_url, api_key).await?,
        PlatformConfig::WordPressSelfHosted {
            site_url,
            username,
            app_password,
        } => wordpress::verify(site_url, username, app_password).await?,
        PlatformConfig::WordPressCom {
            site_id_or_domain,
            access_token,
        } => wordpress_com::verify(site_id_or_domain, access_token).await?,
        PlatformConfig::Medium { token } => medium::verify(token).await?,
    })
}

/// PNG-encoded image bytes pulled from the system clipboard via the
/// Rust-side `arboard` API. Reading via Rust (instead of the browser's
/// `navigator.clipboard.read()`) avoids the WebKit/macOS "Paste"
/// permission prompt that otherwise pops up next to the cursor.
#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
pub struct ClipboardImage {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
#[specta::specta]
pub async fn read_clipboard_image() -> Result<ClipboardImage, AppError> {
    // arboard is sync and may take a few ms on the OS clipboard read
    // (especially on macOS when bridging across processes). Run it on
    // a blocking thread so we don't stall the Tokio runtime.
    let result = tokio::task::spawn_blocking(|| -> Result<ClipboardImage, String> {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| format!("clipboard init failed: {e}"))?;
        let img = clipboard
            .get_image()
            .map_err(|e| format!("no image on clipboard: {e}"))?;
        let mut png_bytes = Vec::new();
        {
            let mut encoder =
                png::Encoder::new(&mut png_bytes, img.width as u32, img.height as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder
                .write_header()
                .map_err(|e| format!("png header: {e}"))?;
            writer
                .write_image_data(&img.bytes)
                .map_err(|e| format!("png data: {e}"))?;
        }
        Ok(ClipboardImage {
            bytes: png_bytes,
            mime: "image/png".to_string(),
            width: img.width as u32,
            height: img.height as u32,
        })
    })
    .await
    .map_err(|e| AppError::Custom(format!("clipboard task panicked: {e}")))?;
    result.map_err(AppError::Custom)
}

/// Convert Markdown to HTML via the user-configured or discovered system Pandoc binary.
/// Used by the frontend orchestrator before submitting to Ghost / WP /
/// WP.com (Medium consumes Markdown directly).
#[tauri::command]
#[specta::specta]
pub async fn convert_markdown_to_html(markdown: String) -> Result<String, AppError> {
    Ok(pandoc_html::markdown_to_html(&markdown).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn get_publish_settings() -> Result<PublishSettings, AppError> {
    let g = crate::commands::settings::read_global_settings().await;
    Ok(g.publish)
}

#[tauri::command]
#[specta::specta]
pub async fn set_publish_settings(settings: PublishSettings) -> Result<(), AppError> {
    let mut g = crate::commands::settings::read_global_settings().await;
    g.publish = settings;
    crate::commands::settings::write_global_settings_to_disk(&g).await
}

/// Task 14: read the persisted per-channel Publish form drafts for one
/// document. Returns an empty snapshot when the sidecar does not yet
/// exist. Malformed top-level JSON surfaces as `AppError::Json`;
/// per-channel parse errors are surfaced in `invalidChannelIds` so a
/// broken entry cannot hide sibling channels.
#[tauri::command]
#[specta::specta]
pub async fn read_publish_form_drafts(
    project_dir: String,
    file_path: String,
) -> Result<PublishFormDraftsSnapshot, AppError> {
    let project = PathBuf::from(project_dir);
    let file = PathBuf::from(file_path);
    sidecar_read_form_drafts(&project, &file).await
}

/// Task 14: persist one channel's Publish form draft while preserving
/// that channel's `remote` identity and `cover` reference. Uses the
/// Task 3 atomic sidecar update helper so writes are safe under
/// concurrent renames/publishes.
#[tauri::command]
#[specta::specta]
pub async fn write_publish_form_draft(
    project_dir: String,
    file_path: String,
    channel_id: String,
    form: FormDraft,
) -> Result<(), AppError> {
    let project = PathBuf::from(project_dir);
    let file = PathBuf::from(file_path);
    sidecar_write_form_draft(&project, &file, &channel_id, form).await
}

/// Durable cover payload returned to the Publish UI after store/load.
/// `filename` and `mime` are canonical, content-derived metadata; `bytes`
/// are runtime IPC data and are never serialized into the sidecar.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type, PartialEq, Eq)]
pub struct PublishCoverAsset {
    pub cover: CoverRef,
    pub bytes: Vec<u8>,
    pub filename: String,
    pub mime: String,
}

fn validate_publish_sidecar_identity(
    project_dir: String,
    file_path: String,
    channel_id: &str,
) -> Result<(PathBuf, PathBuf), AppError> {
    if project_dir.trim().is_empty() {
        return Err(AppError::InvalidInput("project_dir is empty".into()));
    }
    if file_path.trim().is_empty() {
        return Err(AppError::InvalidInput("file_path is empty".into()));
    }
    crate::services::sidecar::validate_channel_id(channel_id)?;
    let project = PathBuf::from(project_dir);
    let file = PathBuf::from(file_path);
    publish_sidecar_path(&project, &file)?;
    Ok((project, file))
}

fn publish_cover_asset(cover: CoverRef, bytes: Vec<u8>) -> PublishCoverAsset {
    PublishCoverAsset {
        filename: cover.file_name(),
        mime: cover.mime.clone(),
        cover,
        bytes,
    }
}

#[cfg(test)]
struct AfterCoverStorePause {
    entered: tokio::sync::oneshot::Sender<()>,
    release: tokio::sync::oneshot::Receiver<()>,
}

#[cfg(test)]
static AFTER_COVER_STORE_PAUSE: once_cell::sync::Lazy<
    std::sync::Mutex<Option<AfterCoverStorePause>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(None));

#[cfg(test)]
fn install_after_cover_store_pause() -> (
    tokio::sync::oneshot::Receiver<()>,
    tokio::sync::oneshot::Sender<()>,
) {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    *AFTER_COVER_STORE_PAUSE
        .lock()
        .expect("after-cover-store pause poisoned") = Some(AfterCoverStorePause {
        entered: entered_tx,
        release: release_rx,
    });
    (entered_rx, release_tx)
}

#[cfg(test)]
async fn pause_after_cover_store_if_requested() {
    let pause = AFTER_COVER_STORE_PAUSE
        .lock()
        .expect("after-cover-store pause poisoned")
        .take();
    if let Some(pause) = pause {
        let _ = pause.entered.send(());
        let _ = pause.release.await;
    }
}

async fn cleanup_publish_assets_after_mutation(project: &std::path::Path) {
    if let Err(error) = cleanup_orphan_assets(project).await {
        tracing::warn!(
            target: "novelist::publish",
            error = %error,
            "publish cover mutation committed but orphan cleanup failed"
        );
    }
}

/// Persist one channel's cover transactionally: validate and store the
/// content-addressed asset, atomically update only `ChannelState.cover`, then
/// run reference-safe cleanup. Form fields, remote identity, and siblings are
/// preserved by `update_publish_sidecar`.
#[tauri::command]
#[specta::specta]
pub async fn store_publish_cover(
    project_dir: String,
    file_path: String,
    channel_id: String,
    bytes: Vec<u8>,
    declared_mime: String,
) -> Result<PublishCoverAsset, AppError> {
    let (project, file) = validate_publish_sidecar_identity(project_dir, file_path, &channel_id)?;
    let transaction_mutex = acquire_cover_asset_transaction_lock(&project).await?;
    let transaction_guard = transaction_mutex.lock().await;
    sidecar_read(&project, &file).await?;
    let cover = store_cover_asset(&project, bytes.clone(), Some(&declared_mime)).await?;
    #[cfg(test)]
    pause_after_cover_store_if_requested().await;
    let cover_for_sidecar = cover.clone();
    let update_result = sidecar_update(&project, &file, move |sidecar| {
        let entry = sidecar
            .channels
            .entry(channel_id)
            .or_insert_with(|| ChannelState {
                form: FormDraft::default(),
                remote: None,
                cover: None,
            });
        entry.cover = Some(cover_for_sidecar);
        Ok(())
    })
    .await;
    drop(transaction_guard);

    if let Err(error) = update_result {
        cleanup_publish_assets_after_mutation(&project).await;
        return Err(error);
    }
    cleanup_publish_assets_after_mutation(&project).await;
    Ok(publish_cover_asset(cover, bytes))
}

/// Restore the validated cover payload for one document/channel. A channel
/// without a cover returns `None`; a sidecar reference whose asset is missing
/// is an integrity error rather than a blank successful preview.
#[tauri::command]
#[specta::specta]
pub async fn load_publish_cover(
    project_dir: String,
    file_path: String,
    channel_id: String,
) -> Result<Option<PublishCoverAsset>, AppError> {
    let (project, file) = validate_publish_sidecar_identity(project_dir, file_path, &channel_id)?;
    let Some(sidecar) = sidecar_read(&project, &file).await? else {
        return Ok(None);
    };
    let Some(cover) = sidecar
        .channels
        .get(&channel_id)
        .and_then(|state| state.cover.clone())
    else {
        return Ok(None);
    };
    let bytes = asset_load_cover_bytes(&project, &cover)
        .await?
        .ok_or_else(|| {
            AppError::InvalidInput(format!(
                "Referenced publish cover asset is missing: {}",
                cover.file_name()
            ))
        })?;
    Ok(Some(publish_cover_asset(cover, bytes)))
}

/// Clear only the target channel's cover and then prune assets that no
/// sidecar references. Missing sidecars/channels/covers are idempotent.
#[tauri::command]
#[specta::specta]
pub async fn clear_publish_cover(
    project_dir: String,
    file_path: String,
    channel_id: String,
) -> Result<(), AppError> {
    let (project, file) = validate_publish_sidecar_identity(project_dir, file_path, &channel_id)?;
    let transaction_mutex = acquire_cover_asset_transaction_lock(&project).await?;
    let transaction_guard = transaction_mutex.lock().await;
    let Some(sidecar) = sidecar_read(&project, &file).await? else {
        drop(transaction_guard);
        cleanup_publish_assets_after_mutation(&project).await;
        return Ok(());
    };
    if sidecar
        .channels
        .get(&channel_id)
        .and_then(|state| state.cover.as_ref())
        .is_none()
    {
        drop(transaction_guard);
        cleanup_publish_assets_after_mutation(&project).await;
        return Ok(());
    }

    sidecar_update(&project, &file, move |current| {
        if let Some(entry) = current.channels.get_mut(&channel_id) {
            entry.cover = None;
        }
        Ok(())
    })
    .await?;
    drop(transaction_guard);
    cleanup_publish_assets_after_mutation(&project).await;
    Ok(())
}

#[cfg(test)]
mod cover_command_tests {
    use super::*;
    use crate::services::publish::cover_assets::{asset_path, assets_dir, MAX_COVER_BYTES};
    use crate::services::publish::sidecar::{
        publish_sidecar_path, read_publish_sidecar, write_publish_sidecar, PublishSidecar,
        CURRENT_SCHEMA_VERSION,
    };
    use std::collections::BTreeMap;
    use tempfile::TempDir;

    static CONCURRENT_COVER_TEST_LOCK: once_cell::sync::Lazy<tokio::sync::Mutex<()>> =
        once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(()));

    fn png_bytes(suffix: &[u8]) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(suffix);
        bytes
    }

    fn seeded_state(title: &str, remote_id: Option<&str>) -> ChannelState {
        ChannelState {
            form: FormDraft {
                title: title.into(),
                tags: vec!["长篇".into()],
                excerpt: Some("摘要".into()),
                slug: Some("first-chapter".into()),
                status: Some("draft".into()),
                destination: None,
            },
            remote: remote_id.map(|post_id| RemoteIdentity {
                post_id: post_id.into(),
                url: Some("https://example.com/第一章".into()),
                revision: Some("r1".into()),
                provider_revision: None,
                capability: None,
            }),
            cover: None,
        }
    }

    async fn seed_two_channels(project: &std::path::Path, file: &std::path::Path) {
        let mut channels = BTreeMap::new();
        channels.insert("ghost-main".into(), seeded_state("第一章", Some("g1")));
        channels.insert("wordpress-main".into(), seeded_state("Sibling", Some("42")));
        write_publish_sidecar(
            project,
            file,
            &PublishSidecar {
                schema_version: CURRENT_SCHEMA_VERSION,
                channels,
            },
        )
        .await
        .unwrap();
    }

    async fn assert_concurrent_cover_store_keeps_every_committed_asset(same_document: bool) {
        let _test_guard = CONCURRENT_COVER_TEST_LOCK.lock().await;
        let project = TempDir::new().unwrap();
        let first_file = project.path().join("first.md");
        let second_file = if same_document {
            first_file.clone()
        } else {
            project.path().join("second.md")
        };
        seed_two_channels(project.path(), &first_file).await;
        if !same_document {
            seed_two_channels(project.path(), &second_file).await;
        }

        let (entered, release) = install_after_cover_store_pause();
        let first_project = project.path().to_string_lossy().into_owned();
        let first_path = first_file.to_string_lossy().into_owned();
        let mut first = tokio::spawn(store_publish_cover(
            first_project.clone(),
            first_path.clone(),
            "ghost-main".into(),
            png_bytes(b"first-in-flight"),
            "image/png".into(),
        ));
        entered.await.unwrap();

        let second_channel = if same_document {
            "wordpress-main"
        } else {
            "ghost-main"
        };
        let mut second = tokio::spawn(store_publish_cover(
            first_project.clone(),
            second_file.to_string_lossy().into_owned(),
            second_channel.into(),
            png_bytes(b"second-committed"),
            "image/png".into(),
        ));
        let second_early =
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut second).await;
        release.send(()).unwrap();

        let first_asset = (&mut first).await.unwrap().unwrap();
        match second_early {
            Ok(result) => {
                result.unwrap().unwrap();
            }
            Err(_) => {
                second.await.unwrap().unwrap();
            }
        }

        let restored = load_publish_cover(first_project, first_path, "ghost-main".into())
            .await
            .unwrap()
            .expect("first committed cover must remain loadable");
        assert_eq!(restored, first_asset);
    }

    #[tokio::test]
    async fn concurrent_channels_cannot_cleanup_an_in_flight_cover_asset() {
        assert_concurrent_cover_store_keeps_every_committed_asset(true).await;
    }

    #[tokio::test]
    async fn concurrent_documents_cannot_cleanup_an_in_flight_cover_asset() {
        assert_concurrent_cover_store_keeps_every_committed_asset(false).await;
    }

    #[tokio::test]
    async fn store_and_load_cover_round_trip_canonical_metadata_across_cjk_space_paths() {
        let root = TempDir::new().unwrap();
        let project = root.path().join("小说 项目");
        let file = project.join("章节 甲").join("第一章.md");
        tokio::fs::create_dir_all(file.parent().unwrap())
            .await
            .unwrap();
        seed_two_channels(&project, &file).await;
        let bytes = png_bytes(b"cover-one");

        let stored = store_publish_cover(
            project.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-main".into(),
            bytes.clone(),
            "image/png".into(),
        )
        .await
        .unwrap();

        assert_eq!(stored.bytes, bytes);
        assert_eq!(stored.mime, "image/png");
        assert_eq!(stored.filename, stored.cover.file_name());
        assert!(stored.filename.ends_with(".png"));
        assert_eq!(stored.cover.bytes as usize, stored.bytes.len());
        assert!(asset_path(&project, &stored.cover).unwrap().exists());

        let loaded = load_publish_cover(
            project.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-main".into(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(loaded, stored);

        let sidecar = read_publish_sidecar(&project, &file)
            .await
            .unwrap()
            .unwrap();
        let target = sidecar.channels.get("ghost-main").unwrap();
        assert_eq!(target.form.title, "第一章");
        assert_eq!(target.remote.as_ref().unwrap().post_id, "g1");
        assert_eq!(target.cover.as_ref(), Some(&stored.cover));
        assert_eq!(sidecar.channels["wordpress-main"].form.title, "Sibling");
        assert_eq!(
            sidecar.channels["wordpress-main"]
                .remote
                .as_ref()
                .unwrap()
                .post_id,
            "42"
        );
    }

    #[tokio::test]
    async fn storing_identical_cover_dedupes_and_preserves_every_non_cover_field() {
        let project = TempDir::new().unwrap();
        let file = project.path().join("chapter.md");
        seed_two_channels(project.path(), &file).await;
        let bytes = png_bytes(b"shared");

        let first = store_publish_cover(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-main".into(),
            bytes.clone(),
            "image/png".into(),
        )
        .await
        .unwrap();
        let second = store_publish_cover(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "wordpress-main".into(),
            bytes,
            "image/png".into(),
        )
        .await
        .unwrap();
        assert_eq!(first, second);

        let mut entries = tokio::fs::read_dir(assets_dir(project.path()))
            .await
            .unwrap();
        let mut count = 0;
        while entries.next_entry().await.unwrap().is_some() {
            count += 1;
        }
        assert_eq!(count, 1);

        let sidecar = read_publish_sidecar(project.path(), &file)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(sidecar.channels["ghost-main"].form.title, "第一章");
        assert_eq!(
            sidecar.channels["ghost-main"]
                .remote
                .as_ref()
                .unwrap()
                .post_id,
            "g1"
        );
        assert_eq!(sidecar.channels["wordpress-main"].form.title, "Sibling");
        assert_eq!(
            sidecar.channels["wordpress-main"]
                .remote
                .as_ref()
                .unwrap()
                .post_id,
            "42"
        );
        assert_eq!(
            sidecar.channels["ghost-main"].cover,
            sidecar.channels["wordpress-main"].cover
        );
    }

    #[tokio::test]
    async fn replacing_and_clearing_cover_use_reference_safe_cleanup() {
        let project = TempDir::new().unwrap();
        let file = project.path().join("chapter.md");
        seed_two_channels(project.path(), &file).await;

        let shared = store_publish_cover(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-main".into(),
            png_bytes(b"shared-old"),
            "image/png".into(),
        )
        .await
        .unwrap();
        store_publish_cover(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "wordpress-main".into(),
            shared.bytes.clone(),
            shared.mime.clone(),
        )
        .await
        .unwrap();

        let replacement = store_publish_cover(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-main".into(),
            png_bytes(b"new-cover"),
            "image/png".into(),
        )
        .await
        .unwrap();
        assert_ne!(shared.cover, replacement.cover);
        assert!(asset_path(project.path(), &shared.cover).unwrap().exists());
        assert!(asset_path(project.path(), &replacement.cover)
            .unwrap()
            .exists());

        clear_publish_cover(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-main".into(),
        )
        .await
        .unwrap();
        assert!(!asset_path(project.path(), &replacement.cover)
            .unwrap()
            .exists());
        assert!(asset_path(project.path(), &shared.cover).unwrap().exists());

        let sidecar = read_publish_sidecar(project.path(), &file)
            .await
            .unwrap()
            .unwrap();
        assert!(sidecar.channels["ghost-main"].cover.is_none());
        assert_eq!(sidecar.channels["ghost-main"].form.title, "第一章");
        assert_eq!(
            sidecar.channels["ghost-main"]
                .remote
                .as_ref()
                .unwrap()
                .post_id,
            "g1"
        );
        assert_eq!(
            sidecar.channels["wordpress-main"].cover.as_ref(),
            Some(&shared.cover)
        );
    }

    #[tokio::test]
    async fn invalid_mime_bytes_and_oversize_replacements_leave_prior_cover_and_sidecar_unchanged()
    {
        let project = TempDir::new().unwrap();
        let file = project.path().join("chapter.md");
        seed_two_channels(project.path(), &file).await;
        let valid = store_publish_cover(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-main".into(),
            png_bytes(b"valid"),
            "image/png".into(),
        )
        .await
        .unwrap();
        let sidecar_path = publish_sidecar_path(project.path(), &file).unwrap();
        let before = tokio::fs::read(&sidecar_path).await.unwrap();

        for (bytes, mime) in [
            (png_bytes(b"mismatch"), "image/jpeg".to_string()),
            (b"not an image".to_vec(), "image/png".to_string()),
        ] {
            let err = store_publish_cover(
                project.path().to_string_lossy().into_owned(),
                file.to_string_lossy().into_owned(),
                "ghost-main".into(),
                bytes,
                mime,
            )
            .await
            .unwrap_err();
            assert!(matches!(err, AppError::InvalidInput(_)));
            assert_eq!(tokio::fs::read(&sidecar_path).await.unwrap(), before);
        }

        let mut oversize = png_bytes(b"oversize");
        oversize.resize(MAX_COVER_BYTES + 1, 0);
        let err = store_publish_cover(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-main".into(),
            oversize,
            "image/png".into(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert_eq!(tokio::fs::read(&sidecar_path).await.unwrap(), before);
        assert!(asset_path(project.path(), &valid.cover).unwrap().exists());
        assert_eq!(
            load_publish_cover(
                project.path().to_string_lossy().into_owned(),
                file.to_string_lossy().into_owned(),
                "ghost-main".into(),
            )
            .await
            .unwrap()
            .unwrap(),
            valid,
        );
    }

    #[tokio::test]
    async fn invalid_channel_is_rejected_before_asset_storage() {
        let project = TempDir::new().unwrap();
        let file = project.path().join("chapter.md");
        let err = store_publish_cover(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "bad channel".into(),
            png_bytes(b"unused"),
            "image/png".into(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(!assets_dir(project.path()).exists());
    }

    #[tokio::test]
    async fn load_returns_none_without_a_cover_and_errors_for_a_missing_referenced_asset() {
        let project = TempDir::new().unwrap();
        let file = project.path().join("chapter.md");
        seed_two_channels(project.path(), &file).await;
        assert!(load_publish_cover(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-main".into(),
        )
        .await
        .unwrap()
        .is_none());

        let stored = store_publish_cover(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-main".into(),
            png_bytes(b"will-disappear"),
            "image/png".into(),
        )
        .await
        .unwrap();
        tokio::fs::remove_file(asset_path(project.path(), &stored.cover).unwrap())
            .await
            .unwrap();
        let err = load_publish_cover(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-main".into(),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("missing"));
    }

    #[tokio::test]
    async fn sidecar_serializes_only_the_cover_reference_not_runtime_bytes_or_urls() {
        let project = TempDir::new().unwrap();
        let file = project.path().join("chapter.md");
        let stored = store_publish_cover(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-main".into(),
            png_bytes(b"json-hygiene-marker"),
            "image/png".into(),
        )
        .await
        .unwrap();
        let raw = tokio::fs::read_to_string(publish_sidecar_path(project.path(), &file).unwrap())
            .await
            .unwrap();
        assert!(raw.contains(&stored.cover.content_hash));
        assert!(!raw.contains("json-hygiene-marker"));
        assert!(!raw.contains("blob:"));
        assert!(!raw.contains("data:image"));
        assert!(!raw.contains(&stored.filename));
    }
}

fn provider_revision_to_string(revision: &ProviderRevision) -> String {
    match revision {
        ProviderRevision::Ghost { updated_at } => updated_at.clone(),
        ProviderRevision::WordPress {
            modified,
            modified_gmt,
        } => modified
            .clone()
            .or_else(|| modified_gmt.clone())
            .unwrap_or_default(),
    }
}

fn remote_identity_from_result(
    config: &PlatformConfig,
    result: &PublishResult,
) -> Result<RemoteIdentity, AppError> {
    let capability = match (config, result.provider_revision.as_ref()) {
        (PlatformConfig::Ghost { .. }, Some(ProviderRevision::Ghost { updated_at }))
            if !updated_at.trim().is_empty() =>
        {
            BindingCapability::Updatable
        }
        (
            PlatformConfig::WordPressSelfHosted { .. } | PlatformConfig::WordPressCom { .. },
            Some(ProviderRevision::WordPress {
                modified,
                modified_gmt,
            }),
        ) if modified
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
            || modified_gmt
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()) =>
        {
            BindingCapability::Updatable
        }
        (PlatformConfig::Medium { .. }, None) => BindingCapability::UnsupportedUpdate {
            reason: UnsupportedUpdateReason::CreateOnlyApi,
        },
        (PlatformConfig::Ghost { .. }, _) => {
            return Err(AppError::InvalidInput(
                "Ghost publish result is missing its typed updated_at revision".into(),
            ));
        }
        (PlatformConfig::WordPressSelfHosted { .. } | PlatformConfig::WordPressCom { .. }, _) => {
            return Err(AppError::InvalidInput(
                "WordPress publish result is missing its typed modified revision".into(),
            ));
        }
        (PlatformConfig::Medium { .. }, Some(_)) => {
            return Err(AppError::InvalidInput(
                "Medium publish result contains an unsupported provider revision".into(),
            ));
        }
    };
    let revision = result
        .provider_revision
        .as_ref()
        .map(provider_revision_to_string);
    Ok(RemoteIdentity {
        post_id: result.remote_id.clone(),
        url: Some(result.url.clone()),
        revision,
        provider_revision: result.provider_revision.clone(),
        capability: Some(capability),
    })
}

/// Read only the durable remote identity for one document/channel.
/// Credentials and sibling channel state never cross this boundary.
#[tauri::command]
#[specta::specta]
pub async fn read_publish_remote_state(
    project_dir: String,
    file_path: String,
    channel_id: String,
) -> Result<Option<RemoteIdentity>, AppError> {
    let (project, file) = validate_publish_sidecar_identity(project_dir, file_path, &channel_id)?;
    let transaction = acquire_cover_asset_transaction_lock(&project).await?;
    let _guard = transaction.lock().await;
    Ok(sidecar_read(&project, &file).await?.and_then(|sidecar| {
        sidecar
            .channels
            .get(&channel_id)
            .and_then(|state| state.remote.clone())
    }))
}

/// Atomically persist a successful create/update result. Provider capability
/// is derived from Rust-owned channel settings, never trusted from the UI.
#[tauri::command]
#[specta::specta]
pub async fn persist_publish_result(
    project_dir: String,
    file_path: String,
    channel_id: String,
    result: PublishResult,
) -> Result<RemoteIdentity, AppError> {
    let (project, file) = validate_publish_sidecar_identity(project_dir, file_path, &channel_id)?;
    let settings = crate::commands::settings::read_global_settings().await;
    let channel = settings
        .publish
        .channels
        .into_iter()
        .find(|channel| channel.id == channel_id)
        .ok_or_else(|| AppError::InvalidInput(format!("channel '{channel_id}' not found")))?;
    let identity = remote_identity_from_result(&channel.config, &result)?;
    let transaction = acquire_cover_asset_transaction_lock(&project).await?;
    let _guard = transaction.lock().await;
    let identity_to_store = identity.clone();
    sidecar_update(&project, &file, move |sidecar| {
        let entry = sidecar
            .channels
            .entry(channel_id.clone())
            .or_insert_with(|| ChannelState {
                form: FormDraft::default(),
                remote: None,
                cover: None,
            });
        if result.operation == PublishOperation::Updated {
            let current = entry.remote.as_ref().ok_or_else(|| {
                AppError::InvalidInput("cannot persist an update without tracked identity".into())
            })?;
            if current.post_id != result.remote_id {
                return Err(AppError::InvalidInput(
                    "updated remote id does not match tracked identity".into(),
                ));
            }
            if !matches!(current.capability, Some(BindingCapability::Updatable)) {
                return Err(AppError::InvalidInput(
                    "tracked remote identity is not updatable".into(),
                ));
            }
        }
        entry.remote = Some(identity_to_store.clone());
        Ok(())
    })
    .await?;
    Ok(identity)
}

pub(crate) async fn dispatch_verify_binding(
    channel_id: &str,
    config: &PlatformConfig,
    url_or_id: &str,
) -> Result<VerifiedBinding, PublishError> {
    match config {
        PlatformConfig::Ghost { .. } => ghost::verify_binding(channel_id, config, url_or_id).await,
        PlatformConfig::WordPressSelfHosted { .. } => {
            wordpress::verify_binding(channel_id, config, url_or_id).await
        }
        PlatformConfig::WordPressCom { .. } => {
            wordpress_com::verify_binding(channel_id, config, url_or_id).await
        }
        PlatformConfig::Medium { .. } => {
            medium::verify_binding(channel_id, config, url_or_id).await
        }
    }
}

pub(crate) async fn persist_verified_binding(
    project_dir: &std::path::Path,
    file_path: &std::path::Path,
    binding: &VerifiedBinding,
) -> Result<(), AppError> {
    let identity = RemoteIdentity {
        post_id: binding.remote_id.clone(),
        url: Some(binding.url.clone()),
        revision: binding.revision.as_ref().map(provider_revision_to_string),
        provider_revision: binding.revision.clone(),
        capability: Some(binding.capability.clone()),
    };
    let channel_id = binding.channel_id.clone();
    let transaction = acquire_cover_asset_transaction_lock(project_dir).await?;
    let _guard = transaction.lock().await;
    sidecar_update(project_dir, file_path, move |sidecar| {
        let entry = sidecar
            .channels
            .entry(channel_id.clone())
            .or_insert_with(|| ChannelState {
                form: FormDraft::default(),
                remote: None,
                cover: None,
            });
        entry.remote = Some(identity.clone());
        Ok(())
    })
    .await
    .map(|_| ())
}

/// Task 20: bind an existing remote post to a local document + channel
/// after authenticated verification.
///
/// Contract:
/// - The frontend supplies `project_dir`, `file_path`, `channel_id`,
///   and one `url_or_id` string. Credentials are NEVER passed in;
///   they are looked up on the Rust side by channel id from persisted
///   global settings.
/// - Verification is provider-specific: Ghost + both WordPress variants
///   authenticate-GET the referenced post and return an [`Updatable`]
///   [`VerifiedBinding`]. Medium returns a typed unsupported/insufficient-
///   scope error because its Integration Token API does not expose an
///   authenticated post-read/ownership endpoint. A successful `/v1/me`
///   token check alone is never treated as verified post identity.
/// - Sidecar mutation is atomic and touches ONLY the target channel's
///   `remote` field: `form`, `cover`, and every sibling channel are
///   preserved byte-identical.
/// - Any verification failure returns `AppError::Custom` with a typed
///   `PublishError` message. Sidecar bytes are unchanged on any failure.
///
/// [`Updatable`]: crate::services::publish::binding::BindingCapability::Updatable
/// [`UnsupportedUpdate`]: crate::services::publish::binding::BindingCapability::UnsupportedUpdate
#[tauri::command]
#[specta::specta]
pub async fn bind_legacy_publication(
    project_dir: String,
    file_path: String,
    channel_id: String,
    url_or_id: String,
) -> Result<VerifiedBinding, AppError> {
    let project = PathBuf::from(&project_dir);
    let file = PathBuf::from(&file_path);
    if project_dir.trim().is_empty() {
        return Err(AppError::InvalidInput("project_dir is empty".into()));
    }
    if file_path.trim().is_empty() {
        return Err(AppError::InvalidInput("file_path is empty".into()));
    }
    if channel_id.trim().is_empty() {
        return Err(AppError::InvalidInput("channel_id is empty".into()));
    }
    crate::services::sidecar::validate_channel_id(&channel_id)?;
    let _sidecar_path = crate::services::publish::sidecar::publish_sidecar_path(&project, &file)?;
    let settings = crate::commands::settings::read_global_settings().await;
    let channel = settings
        .publish
        .channels
        .into_iter()
        .find(|c| c.id == channel_id)
        .ok_or_else(|| AppError::InvalidInput(format!("channel '{channel_id}' not found")))?;
    let binding = dispatch_verify_binding(&channel.id, &channel.config, &url_or_id)
        .await
        .map_err(AppError::from)?;
    persist_verified_binding(&project, &file, &binding).await?;
    Ok(binding)
}

#[cfg(test)]
mod bind_tests {
    use super::*;
    use crate::models::publish::{ChannelConfig, PlatformConfig};
    use crate::services::publish::binding::{BindingCapability, VerifiedBinding};
    use crate::services::publish::sidecar::{
        read_publish_sidecar, update_publish_sidecar, ChannelState, CURRENT_SCHEMA_VERSION,
    };
    use crate::services::publish::types::ProviderRevision;
    use std::sync::Arc;
    use tempfile::TempDir;
    use tokio::sync::Mutex as AsyncMutex;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    static ENV_LOCK: once_cell::sync::Lazy<Arc<AsyncMutex<()>>> =
        once_cell::sync::Lazy::new(|| Arc::new(AsyncMutex::new(())));

    struct SettingsFixture {
        _guard: tokio::sync::OwnedMutexGuard<()>,
        _tmp: TempDir,
    }

    async fn install_settings(channels: Vec<ChannelConfig>) -> SettingsFixture {
        let guard = ENV_LOCK.clone().lock_owned().await;
        let tmp = TempDir::new().unwrap();
        std::env::set_var("NOVELIST_SETTINGS_DATA_DIR", tmp.path());
        let settings = crate::models::settings::GlobalSettings {
            publish: crate::models::publish::PublishSettings { channels },
            ..Default::default()
        };
        let path = tmp.path().join("settings.json");
        tokio::fs::write(&path, serde_json::to_vec_pretty(&settings).unwrap())
            .await
            .unwrap();
        SettingsFixture {
            _guard: guard,
            _tmp: tmp,
        }
    }

    fn ghost_channel(admin_url: &str) -> ChannelConfig {
        ChannelConfig {
            id: "ghost-personal_1".into(),
            name: "Personal Ghost".into(),
            config: PlatformConfig::Ghost {
                admin_url: admin_url.into(),
                api_key: "abc:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd"
                    .into(),
            },
        }
    }

    fn medium_channel() -> ChannelConfig {
        ChannelConfig {
            id: "medium-personal_1".into(),
            name: "Personal Medium".into(),
            config: PlatformConfig::Medium {
                token: "tok".into(),
            },
        }
    }

    fn ghost_success_body(id: &str, url: &str, updated_at: &str) -> serde_json::Value {
        serde_json::json!({
            "posts": [{
                "id": id,
                "url": url,
                "updated_at": updated_at,
            }]
        })
    }

    fn test_cover_ref() -> CoverRef {
        CoverRef {
            content_hash: "a".repeat(64),
            extension: "png".into(),
            mime: "image/png".into(),
            bytes: 4,
        }
    }

    #[test]
    fn publish_error_boundary_preserves_typed_shape_for_safe_frontend_recovery() {
        let error = AppError::from(PublishError::RemoteNotFound {
            provider: "ghost".into(),
            remote_id: "0123456789abcdef01234567".into(),
        });
        let AppError::Custom(payload) = error else {
            panic!("publish errors must cross through the custom boundary");
        };
        let value: serde_json::Value = serde_json::from_str(&payload)
            .expect("publish command error must contain structured JSON");
        assert_eq!(value["kind"], "remote_not_found");
        assert_eq!(value["data"]["provider"], "ghost");
        assert_eq!(value["data"]["remote_id"], "0123456789abcdef01234567");
        assert!(!payload.to_ascii_lowercase().contains("token"));
    }

    #[tokio::test]
    async fn publish_result_create_persists_remote_without_touching_form_cover_or_siblings() {
        let fixture = install_settings(vec![ghost_channel("https://ghost.example.com")]).await;
        let project = TempDir::new().unwrap();
        let file = project.path().join("章节 一.md");
        let cover = test_cover_ref();
        update_publish_sidecar(project.path(), &file, |sidecar| {
            sidecar.channels.insert(
                "ghost-personal_1".into(),
                ChannelState {
                    form: crate::services::publish::sidecar::FormDraft {
                        title: "保留标题".into(),
                        tags: vec!["中文".into()],
                        ..Default::default()
                    },
                    remote: None,
                    cover: Some(cover.clone()),
                },
            );
            sidecar.channels.insert(
                "wordpress-sibling".into(),
                ChannelState {
                    form: crate::services::publish::sidecar::FormDraft {
                        title: "sibling".into(),
                        ..Default::default()
                    },
                    remote: None,
                    cover: None,
                },
            );
            Ok(())
        })
        .await
        .unwrap();

        let result = PublishResult::created_with_revision(
            "https://ghost.example.com/first/",
            "0123456789abcdef01234567",
            ProviderRevision::Ghost {
                updated_at: "2026-07-17T00:00:00.000Z".into(),
            },
        );
        let persisted = persist_publish_result(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-personal_1".into(),
            result,
        )
        .await
        .expect("publish result should persist");

        assert_eq!(persisted.post_id, "0123456789abcdef01234567");
        assert_eq!(
            persisted.url.as_deref(),
            Some("https://ghost.example.com/first/")
        );
        assert_eq!(
            persisted.provider_revision,
            Some(ProviderRevision::Ghost {
                updated_at: "2026-07-17T00:00:00.000Z".into(),
            })
        );
        assert!(matches!(
            persisted.capability,
            Some(BindingCapability::Updatable)
        ));

        let restored = read_publish_remote_state(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-personal_1".into(),
        )
        .await
        .expect("remote state should read")
        .expect("remote state should exist");
        assert_eq!(restored, persisted);

        let sidecar = read_publish_sidecar(project.path(), &file)
            .await
            .unwrap()
            .unwrap();
        let state = sidecar.channels.get("ghost-personal_1").unwrap();
        assert_eq!(state.form.title, "保留标题");
        assert_eq!(state.form.tags, vec!["中文".to_string()]);
        assert_eq!(state.cover, Some(cover));
        assert_eq!(
            sidecar
                .channels
                .get("wordpress-sibling")
                .unwrap()
                .form
                .title,
            "sibling"
        );
        drop(fixture);
    }

    #[tokio::test]
    async fn publish_result_update_cannot_rotate_existing_remote_id() {
        let fixture = install_settings(vec![ghost_channel("https://ghost.example.com")]).await;
        let project = TempDir::new().unwrap();
        let file = project.path().join("chapter.md");
        update_publish_sidecar(project.path(), &file, |sidecar| {
            sidecar.channels.insert(
                "ghost-personal_1".into(),
                ChannelState {
                    form: Default::default(),
                    remote: Some(RemoteIdentity {
                        post_id: "0123456789abcdef01234567".into(),
                        url: Some("https://ghost.example.com/original/".into()),
                        revision: Some("old-revision".into()),
                        provider_revision: Some(ProviderRevision::Ghost {
                            updated_at: "old-revision".into(),
                        }),
                        capability: Some(BindingCapability::Updatable),
                    }),
                    cover: None,
                },
            );
            Ok(())
        })
        .await
        .unwrap();

        let result = PublishResult::updated(
            "https://ghost.example.com/wrong/",
            "fedcba9876543210fedcba98",
            Some(ProviderRevision::Ghost {
                updated_at: "new-revision".into(),
            }),
        );
        let err = persist_publish_result(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-personal_1".into(),
            result,
        )
        .await
        .expect_err("update must not rotate remote identity");
        assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");

        let restored = read_publish_sidecar(project.path(), &file)
            .await
            .unwrap()
            .unwrap();
        let remote = restored
            .channels
            .get("ghost-personal_1")
            .unwrap()
            .remote
            .as_ref()
            .unwrap();
        assert_eq!(remote.post_id, "0123456789abcdef01234567");
        assert_eq!(remote.revision.as_deref(), Some("old-revision"));
        drop(fixture);
    }

    #[tokio::test]
    async fn bind_writes_only_remote_and_preserves_form_and_cover_on_target_channel() {
        let server = MockServer::start().await;
        let canonical_url = format!("{}/hello/", server.uri());
        let ghost_id = "0123456789abcdef01234567";
        Mock::given(method("GET"))
            .and(path(format!("/ghost/api/admin/posts/{ghost_id}/")))
            .respond_with(ResponseTemplate::new(200).set_body_json(ghost_success_body(
                ghost_id,
                &canonical_url,
                "2026-07-16T00:00:00.000Z",
            )))
            .mount(&server)
            .await;
        let fixture = install_settings(vec![ghost_channel(&server.uri())]).await;
        let project = TempDir::new().unwrap();
        let file = project.path().join("ch1.md");

        update_publish_sidecar(project.path(), &file, |sidecar| {
            sidecar.channels.insert(
                "ghost-personal_1".into(),
                ChannelState {
                    form: crate::services::publish::sidecar::FormDraft {
                        title: "existing title".into(),
                        tags: vec!["existing-tag".into()],
                        ..Default::default()
                    },
                    remote: None,
                    cover: None,
                },
            );
            sidecar.channels.insert(
                "medium-sibling".into(),
                ChannelState {
                    form: crate::services::publish::sidecar::FormDraft {
                        title: "sibling title".into(),
                        ..Default::default()
                    },
                    remote: None,
                    cover: None,
                },
            );
            Ok(())
        })
        .await
        .unwrap();

        let vb = bind_legacy_publication(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-personal_1".into(),
            ghost_id.into(),
        )
        .await
        .expect("bind should succeed");

        assert_eq!(vb.channel_id, "ghost-personal_1");
        assert_eq!(vb.remote_id, ghost_id);
        assert!(matches!(vb.capability, BindingCapability::Updatable));

        let sidecar = read_publish_sidecar(project.path(), &file)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(sidecar.schema_version, CURRENT_SCHEMA_VERSION);
        let ghost_state = sidecar.channels.get("ghost-personal_1").unwrap();
        assert_eq!(ghost_state.form.title, "existing title");
        assert_eq!(ghost_state.form.tags, vec!["existing-tag".to_string()]);
        let remote = ghost_state.remote.as_ref().unwrap();
        assert_eq!(remote.post_id, ghost_id);
        assert_eq!(remote.url.as_deref(), Some(canonical_url.as_str()));
        assert_eq!(remote.revision.as_deref(), Some("2026-07-16T00:00:00.000Z"));
        assert_eq!(
            remote.provider_revision,
            Some(ProviderRevision::Ghost {
                updated_at: "2026-07-16T00:00:00.000Z".into(),
            })
        );
        let sibling = sidecar.channels.get("medium-sibling").unwrap();
        assert_eq!(sibling.form.title, "sibling title");
        assert!(sibling.remote.is_none());

        drop(fixture);
    }

    #[tokio::test]
    async fn bind_medium_failure_leaves_sidecar_absent() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/me"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"id": "u123"}
            })))
            .mount(&server)
            .await;
        let fixture = install_settings(vec![medium_channel()]).await;
        let project = TempDir::new().unwrap();
        let file = project.path().join("ch1.md");

        let err = crate::services::publish::medium::verify_binding_with_base(
            "medium-personal_1",
            &PlatformConfig::Medium {
                token: "tok".into(),
            },
            "abcDEF123",
            &server.uri(),
        )
        .await
        .unwrap_err();
        assert!(matches!(
            err,
            PublishError::UnsupportedUpdate {
                reason: crate::services::publish::types::UnsupportedUpdateReason::InsufficientScope,
                ..
            }
        ));
        assert!(read_publish_sidecar(project.path(), &file)
            .await
            .unwrap()
            .is_none());

        drop(fixture);
    }

    #[tokio::test]
    async fn bind_leaves_sidecar_byte_identical_when_verification_fails() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
            .mount(&server)
            .await;
        let fixture = install_settings(vec![ghost_channel(&server.uri())]).await;
        let project = TempDir::new().unwrap();
        let file = project.path().join("ch1.md");
        update_publish_sidecar(project.path(), &file, |sidecar| {
            sidecar.channels.insert(
                "ghost-personal_1".into(),
                ChannelState {
                    form: crate::services::publish::sidecar::FormDraft {
                        title: "unchanged".into(),
                        ..Default::default()
                    },
                    remote: None,
                    cover: None,
                },
            );
            Ok(())
        })
        .await
        .unwrap();
        let sidecar_path =
            crate::services::publish::sidecar::publish_sidecar_path(project.path(), &file).unwrap();
        let bytes_before = tokio::fs::read(&sidecar_path).await.unwrap();

        let err = bind_legacy_publication(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-personal_1".into(),
            "0123456789abcdef01234567".into(),
        )
        .await
        .unwrap_err();
        let AppError::Custom(payload) = err else {
            panic!("expected structured publish error");
        };
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(value["kind"], "remote_not_found");
        assert_eq!(value["data"]["remote_id"], "0123456789abcdef01234567");

        let bytes_after = tokio::fs::read(&sidecar_path).await.unwrap();
        assert_eq!(
            bytes_before, bytes_after,
            "sidecar bytes must be identical after failed bind"
        );

        drop(fixture);
    }

    #[tokio::test]
    async fn bind_rejects_missing_channel_without_touching_provider() {
        let fixture = install_settings(vec![]).await;
        let project = TempDir::new().unwrap();
        let file = project.path().join("ch1.md");
        let err = bind_legacy_publication(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "does-not-exist".into(),
            "0123456789abcdef01234567".into(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");
        drop(fixture);
    }

    #[tokio::test]
    async fn bind_rejects_invalid_channel_id_before_settings_lookup() {
        let fixture = install_settings(vec![]).await;
        let project = TempDir::new().unwrap();
        let file = project.path().join("ch1.md");
        let err = bind_legacy_publication(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "has space".into(),
            "0123456789abcdef01234567".into(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)), "got {err:?}");
        drop(fixture);
    }

    #[tokio::test]
    async fn two_channels_can_be_bound_without_losing_each_other() {
        let ghost_server = MockServer::start().await;
        let ghost_url = format!("{}/hello/", ghost_server.uri());
        let ghost_id = "0123456789abcdef01234567";
        Mock::given(method("GET"))
            .and(path(format!("/ghost/api/admin/posts/{ghost_id}/")))
            .respond_with(ResponseTemplate::new(200).set_body_json(ghost_success_body(
                ghost_id,
                &ghost_url,
                "2026-07-16T00:00:00.000Z",
            )))
            .mount(&ghost_server)
            .await;
        let fixture =
            install_settings(vec![ghost_channel(&ghost_server.uri()), medium_channel()]).await;
        let project = TempDir::new().unwrap();
        let file = project.path().join("ch1.md");

        bind_legacy_publication(
            project.path().to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            "ghost-personal_1".into(),
            ghost_id.into(),
        )
        .await
        .expect("ghost bind ok");

        let sidecar = read_publish_sidecar(project.path(), &file)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(sidecar.channels.len(), 1);
        assert_eq!(
            sidecar
                .channels
                .get("ghost-personal_1")
                .unwrap()
                .remote
                .as_ref()
                .unwrap()
                .post_id,
            ghost_id
        );
        drop(fixture);
    }

    #[tokio::test]
    async fn persist_verified_binding_never_touches_form_or_cover() {
        let project = TempDir::new().unwrap();
        let file = project.path().join("ch1.md");
        update_publish_sidecar(project.path(), &file, |sidecar| {
            sidecar.channels.insert(
                "ghost-personal_1".into(),
                ChannelState {
                    form: crate::services::publish::sidecar::FormDraft {
                        title: "hands-off".into(),
                        tags: vec!["a".into(), "b".into()],
                        excerpt: Some("brief".into()),
                        slug: Some("s".into()),
                        status: Some("draft".into()),
                        destination: None,
                    },
                    remote: None,
                    cover: None,
                },
            );
            Ok(())
        })
        .await
        .unwrap();

        let vb = VerifiedBinding {
            channel_id: "ghost-personal_1".into(),
            provider: "ghost".into(),
            remote_id: "0123456789abcdef01234567".into(),
            url: "https://blog.example.com/hello/".into(),
            revision: Some(ProviderRevision::Ghost {
                updated_at: "2026-07-16T00:00:00.000Z".into(),
            }),
            capability: BindingCapability::Updatable,
        };
        persist_verified_binding(project.path(), &file, &vb)
            .await
            .unwrap();
        let sidecar = read_publish_sidecar(project.path(), &file)
            .await
            .unwrap()
            .unwrap();
        let state = sidecar.channels.get("ghost-personal_1").unwrap();
        assert_eq!(state.form.title, "hands-off");
        assert_eq!(state.form.tags, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(state.form.excerpt.as_deref(), Some("brief"));
        assert!(state.cover.is_none());
        assert_eq!(
            state.remote.as_ref().unwrap().post_id,
            "0123456789abcdef01234567"
        );
        assert_eq!(
            state.remote.as_ref().unwrap().revision.as_deref(),
            Some("2026-07-16T00:00:00.000Z")
        );
        assert_eq!(
            state.remote.as_ref().unwrap().provider_revision,
            Some(ProviderRevision::Ghost {
                updated_at: "2026-07-16T00:00:00.000Z".into(),
            })
        );
    }

    #[tokio::test]
    async fn concurrent_bindings_do_not_lose_each_other() {
        let project = TempDir::new().unwrap();
        let file = project.path().join("ch1.md");
        let vb1 = VerifiedBinding {
            channel_id: "ghost-1".into(),
            provider: "ghost".into(),
            remote_id: "aaaaaaaaaaaaaaaaaaaaaaaa".into(),
            url: "https://a.example.com/x/".into(),
            revision: Some(ProviderRevision::Ghost {
                updated_at: "2026-07-16T00:00:00Z".into(),
            }),
            capability: BindingCapability::Updatable,
        };
        let vb2 = VerifiedBinding {
            channel_id: "wp-1".into(),
            provider: "wordpress".into(),
            remote_id: "42".into(),
            url: "https://b.example.com/?p=42".into(),
            revision: Some(ProviderRevision::WordPress {
                modified: Some("2026-07-16T00:00:00".into()),
                modified_gmt: None,
            }),
            capability: BindingCapability::Updatable,
        };
        let project_a = project.path().to_path_buf();
        let file_a = file.clone();
        let vb1c = vb1.clone();
        let t1 =
            tokio::spawn(async move { persist_verified_binding(&project_a, &file_a, &vb1c).await });
        let project_b = project.path().to_path_buf();
        let file_b = file.clone();
        let vb2c = vb2.clone();
        let t2 =
            tokio::spawn(async move { persist_verified_binding(&project_b, &file_b, &vb2c).await });
        t1.await.unwrap().unwrap();
        t2.await.unwrap().unwrap();
        let sidecar = read_publish_sidecar(project.path(), &file)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(sidecar.channels.len(), 2);
        assert_eq!(
            sidecar
                .channels
                .get("ghost-1")
                .unwrap()
                .remote
                .as_ref()
                .unwrap()
                .post_id,
            "aaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(
            sidecar
                .channels
                .get("wp-1")
                .unwrap()
                .remote
                .as_ref()
                .unwrap()
                .post_id,
            "42"
        );
        assert_eq!(
            sidecar
                .channels
                .get("wp-1")
                .unwrap()
                .remote
                .as_ref()
                .unwrap()
                .provider_revision,
            Some(ProviderRevision::WordPress {
                modified: Some("2026-07-16T00:00:00".into()),
                modified_gmt: None,
            })
        );
    }

    #[tokio::test]
    async fn concurrent_bind_racing_form_write_preserves_both() {
        let project = TempDir::new().unwrap();
        let file = project.path().join("ch1.md");
        update_publish_sidecar(project.path(), &file, |sidecar| {
            sidecar.channels.insert(
                "ghost-1".into(),
                ChannelState {
                    form: crate::services::publish::sidecar::FormDraft::default(),
                    remote: None,
                    cover: None,
                },
            );
            Ok(())
        })
        .await
        .unwrap();

        let vb = VerifiedBinding {
            channel_id: "ghost-1".into(),
            provider: "ghost".into(),
            remote_id: "aaaaaaaaaaaaaaaaaaaaaaaa".into(),
            url: "https://a.example.com/x/".into(),
            revision: Some(ProviderRevision::Ghost {
                updated_at: "2026-07-16T00:00:00Z".into(),
            }),
            capability: BindingCapability::Updatable,
        };

        let project_bind = project.path().to_path_buf();
        let file_bind = file.clone();
        let bind_task =
            tokio::spawn(
                async move { persist_verified_binding(&project_bind, &file_bind, &vb).await },
            );
        let project_form = project.path().to_path_buf();
        let file_form = file.clone();
        let form_task = tokio::spawn(async move {
            crate::services::publish::sidecar::write_publish_form_draft(
                &project_form,
                &file_form,
                "ghost-1",
                crate::services::publish::sidecar::FormDraft {
                    title: "concurrent user typing".into(),
                    ..Default::default()
                },
            )
            .await
        });
        bind_task.await.unwrap().unwrap();
        form_task.await.unwrap().unwrap();

        let sidecar = read_publish_sidecar(project.path(), &file)
            .await
            .unwrap()
            .unwrap();
        let state = sidecar.channels.get("ghost-1").unwrap();
        assert_eq!(state.form.title, "concurrent user typing");
        assert_eq!(
            state.remote.as_ref().unwrap().post_id,
            "aaaaaaaaaaaaaaaaaaaaaaaa"
        );
    }
}
