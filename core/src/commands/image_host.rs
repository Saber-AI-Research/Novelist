//! Tauri commands for image-host uploads + settings.
//!
//! One command per provider — no generic dispatcher — because each
//! provider's wire format and config shape differ enough that a unified
//! trait would be a forced abstraction. The frontend's
//! `app/lib/services/image-host.ts` routes to the right command based on
//! the active host's `provider` discriminant.
//!
//! Settings live in `GlobalSettings.image_hosts` (always global —
//! credentials never leak into per-project files). Per-project overrides
//! are limited to `ProjectConfig.active_image_host_id` (the pointer only,
//! handled in `commands/settings.rs`).

use crate::error::AppError;
use crate::models::image_host::{ImageHostSettings, ProviderConfig};
use crate::services::image_host::naming;
use crate::services::image_host::types::{HostError, UploadInput, UploadResult};
use crate::services::image_host::{aliyun_oss, custom, imgur, qiniu, s3, smms};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, Metadata, OpenOptions as CapOpenOptions};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

const MAX_LOCAL_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const MAX_IMAGE_REFERENCE_BYTES: usize = 4096;

pub struct WindowImageCapabilities {
    inner: Mutex<HashMap<String, WindowImageScope>>,
}

#[derive(Default)]
struct WindowImageScope {
    project: Option<ImageCapabilityRoot>,
    documents: HashMap<PathBuf, DocumentImageCapability>,
}

struct DocumentImageCapability {
    root: ImageCapabilityRoot,
    registrations: usize,
}

struct AuthorizedImageScope {
    root: ImageCapabilityRoot,
    base_dir: PathBuf,
}

impl WindowImageCapabilities {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    pub fn replace_project(&self, owner: &str, root: &Path) -> Result<(), AppError> {
        let root = acquire_canonical_image_root(root)?;
        let mut scopes = self
            .inner
            .lock()
            .map_err(|_| unsafe_image("scope_unavailable"))?;
        let scope = scopes.entry(owner.to_string()).or_default();
        scope.project = Some(root);
        scope.documents.clear();
        Ok(())
    }

    pub fn register_document(&self, owner: &str, document: &Path) -> Result<(), AppError> {
        let parent = document
            .parent()
            .ok_or_else(|| unsafe_image("invalid_scope"))?;
        let canonical_parent =
            std::fs::canonicalize(parent).map_err(|_| unsafe_image("invalid_scope"))?;
        let root = acquire_image_root(&canonical_parent)?;
        let mut scopes = self
            .inner
            .lock()
            .map_err(|_| unsafe_image("scope_unavailable"))?;
        let capability = scopes
            .entry(owner.to_string())
            .or_default()
            .documents
            .entry(canonical_parent)
            .or_insert(DocumentImageCapability {
                root,
                registrations: 0,
            });
        capability.registrations = capability.registrations.saturating_add(1);
        Ok(())
    }

    pub fn unregister_document(&self, owner: &str, document: &Path) -> Result<(), AppError> {
        let parent = document
            .parent()
            .ok_or_else(|| unsafe_image("invalid_scope"))?;
        let canonical_parent =
            std::fs::canonicalize(parent).map_err(|_| unsafe_image("invalid_scope"))?;
        let mut scopes = self
            .inner
            .lock()
            .map_err(|_| unsafe_image("scope_unavailable"))?;
        let Some(scope) = scopes.get_mut(owner) else {
            return Ok(());
        };
        let remove = match scope.documents.get_mut(&canonical_parent) {
            Some(capability) if capability.registrations > 1 => {
                capability.registrations -= 1;
                false
            }
            Some(_) => true,
            None => false,
        };
        if remove {
            scope.documents.remove(&canonical_parent);
        }
        if scope.project.is_none() && scope.documents.is_empty() {
            scopes.remove(owner);
        }
        Ok(())
    }

    pub fn clear_owner(&self, owner: &str) {
        if let Ok(mut scopes) = self.inner.lock() {
            scopes.remove(owner);
        }
    }

    fn authorize_base(
        &self,
        owner: &str,
        base_dir: &Path,
    ) -> Result<AuthorizedImageScope, AppError> {
        let canonical_base =
            std::fs::canonicalize(base_dir).map_err(|_| unsafe_image("invalid_scope"))?;
        if !canonical_base.is_dir() {
            return Err(unsafe_image("invalid_scope"));
        }
        let scopes = self
            .inner
            .lock()
            .map_err(|_| unsafe_image("scope_unavailable"))?;
        let scope = scopes
            .get(owner)
            .ok_or_else(|| unsafe_image("scope_not_registered"))?;

        if let Some(project) = scope.project.as_ref() {
            if canonical_base.starts_with(&project.input_path) {
                return Ok(AuthorizedImageScope {
                    root: clone_attached_image_root(project)?,
                    base_dir: canonical_base,
                });
            }
        }
        if let Some(document) = scope.documents.get(&canonical_base) {
            return Ok(AuthorizedImageScope {
                root: clone_attached_image_root(&document.root)?,
                base_dir: canonical_base,
            });
        }
        Err(unsafe_image("outside_registered_scope"))
    }
}

impl Default for WindowImageCapabilities {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
type BeforeImageOpenHook = Box<dyn FnOnce() + Send>;

#[cfg(test)]
type AfterParentVerifyHook = Box<dyn FnOnce() + Send>;

#[cfg(test)]
static BEFORE_IMAGE_OPEN_HOOKS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, BeforeImageOpenHook>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
static AFTER_PARENT_VERIFY_HOOKS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, AfterParentVerifyHook>>,
> = std::sync::OnceLock::new();

impl From<HostError> for AppError {
    fn from(e: HostError) -> AppError {
        AppError::Custom(e.to_string())
    }
}

fn build_input(bytes: Vec<u8>, filename: String, mime: String) -> UploadInput {
    let key = naming::generate_key(&filename, &bytes, chrono::Utc::now());
    UploadInput {
        bytes,
        filename,
        mime,
        key,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn upload_image_qiniu(
    bytes: Vec<u8>,
    filename: String,
    mime: String,
    config: ProviderConfig,
) -> Result<UploadResult, AppError> {
    Ok(qiniu::upload(&config, build_input(bytes, filename, mime)).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn upload_image_aliyun_oss(
    bytes: Vec<u8>,
    filename: String,
    mime: String,
    config: ProviderConfig,
) -> Result<UploadResult, AppError> {
    Ok(aliyun_oss::upload(&config, build_input(bytes, filename, mime)).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn upload_image_s3(
    bytes: Vec<u8>,
    filename: String,
    mime: String,
    config: ProviderConfig,
) -> Result<UploadResult, AppError> {
    Ok(s3::upload(&config, build_input(bytes, filename, mime)).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn upload_image_imgur(
    bytes: Vec<u8>,
    filename: String,
    mime: String,
    config: ProviderConfig,
) -> Result<UploadResult, AppError> {
    Ok(imgur::upload(&config, build_input(bytes, filename, mime)).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn upload_image_smms(
    bytes: Vec<u8>,
    filename: String,
    mime: String,
    config: ProviderConfig,
) -> Result<UploadResult, AppError> {
    Ok(smms::upload(&config, build_input(bytes, filename, mime)).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn upload_image_custom(
    bytes: Vec<u8>,
    filename: String,
    mime: String,
    config: ProviderConfig,
) -> Result<UploadResult, AppError> {
    Ok(custom::upload(&config, build_input(bytes, filename, mime)).await?)
}

/// Read the global `image_hosts` settings block.
#[tauri::command]
#[specta::specta]
pub async fn get_image_host_settings() -> Result<ImageHostSettings, AppError> {
    let g = crate::commands::settings::read_global_settings().await;
    Ok(g.image_hosts)
}

/// Replace the global `image_hosts` settings block atomically.
#[tauri::command]
#[specta::specta]
pub async fn set_image_host_settings(settings: ImageHostSettings) -> Result<(), AppError> {
    let mut g = crate::commands::settings::read_global_settings().await;
    g.image_hosts = settings;
    crate::commands::settings::write_global_settings_to_disk(&g).await
}

/// Read a Markdown image through a project/document capability. `reference`
/// remains relative to `base_dir`; both are confined under `allowed_root`.
/// Every path component is opened relative to retained directory handles, and
/// symlinks are rejected before any image bytes are read.
#[tauri::command]
#[specta::specta]
pub async fn read_image_bytes(
    window: tauri::WebviewWindow,
    capabilities: tauri::State<'_, WindowImageCapabilities>,
    base_dir: String,
    reference: String,
) -> Result<Vec<u8>, AppError> {
    if base_dir.trim().is_empty() || reference.trim().is_empty() {
        return Err(unsafe_image("invalid_scope"));
    }
    let scope = capabilities.authorize_base(window.label(), Path::new(&base_dir))?;
    tokio::task::spawn_blocking(move || {
        read_image_bytes_blocking(scope.root, &scope.base_dir, &reference)
    })
    .await
    .map_err(|_| unsafe_image("unreadable"))?
}

struct ImageCapabilityRoot {
    input_path: PathBuf,
    directory: Dir,
}

struct OpenedDirectoryComponent {
    relative: PathBuf,
    metadata: Metadata,
}

fn read_image_bytes_blocking(
    root: ImageCapabilityRoot,
    base_dir: &Path,
    reference: &str,
) -> Result<Vec<u8>, AppError> {
    if reference.len() > MAX_IMAGE_REFERENCE_BYTES || reference.contains('\0') {
        return Err(unsafe_image("invalid_reference"));
    }
    let relative_target = relative_image_target(&root.input_path, base_dir, reference)?;
    let mut components: Vec<_> = relative_target.components().collect();
    let file_name = match components.pop() {
        Some(Component::Normal(name)) => name.to_owned(),
        _ => return Err(unsafe_image("invalid_reference")),
    };

    let mut current = root
        .directory
        .try_clone()
        .map_err(|_| unsafe_image("unreadable"))?;
    let mut relative_parent = PathBuf::new();
    let mut opened_parents = Vec::with_capacity(components.len());
    for component in components {
        let Component::Normal(name) = component else {
            return Err(unsafe_image("invalid_reference"));
        };
        let before = current
            .symlink_metadata(name)
            .map_err(|_| unsafe_image("unreadable"))?;
        if before.file_type().is_symlink() {
            return Err(unsafe_image("symlink_component"));
        }
        if !before.is_dir() {
            return Err(unsafe_image("not_regular_file"));
        }
        let next = current
            .open_dir(name)
            .map_err(|_| unsafe_image("unreadable"))?;
        let opened = next
            .dir_metadata()
            .map_err(|_| unsafe_image("unreadable"))?;
        if !opened.is_dir() || !metadata_matches(&before, &opened) {
            return Err(unsafe_image("path_changed"));
        }
        relative_parent.push(name);
        opened_parents.push(OpenedDirectoryComponent {
            relative: relative_parent.clone(),
            metadata: opened,
        });
        current = next;
    }

    #[cfg(test)]
    run_before_image_open_hook(&relative_target);

    verify_opened_parents_are_attached(&root.directory, &opened_parents)?;
    #[cfg(test)]
    run_after_parent_verify_hook(&relative_target);
    let before = current
        .symlink_metadata(&file_name)
        .map_err(|_| unsafe_image("unreadable"))?;
    validate_image_metadata(&before)?;

    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = root
        .directory
        .open_with(&relative_target, &options)
        .map_err(|_| unsafe_image("unreadable"))?;
    let opened = file.metadata().map_err(|_| unsafe_image("unreadable"))?;
    validate_image_metadata(&opened)?;
    if !metadata_matches(&before, &opened) {
        return Err(unsafe_image("path_changed"));
    }

    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.by_ref()
        .take((MAX_LOCAL_IMAGE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| unsafe_image("unreadable"))?;
    if bytes.len() > MAX_LOCAL_IMAGE_BYTES {
        return Err(unsafe_image("image_too_large"));
    }
    let after = file.metadata().map_err(|_| unsafe_image("unreadable"))?;
    validate_image_metadata(&after)?;
    if !metadata_matches(&opened, &after) || after.len() != bytes.len() as u64 {
        return Err(unsafe_image("file_changed"));
    }
    Ok(bytes)
}

fn acquire_image_root(path: &Path) -> Result<ImageCapabilityRoot, AppError> {
    if !path.is_absolute() {
        return Err(unsafe_image("invalid_scope"));
    }
    let directory = match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => {
            let parent = Dir::open_ambient_dir(parent, ambient_authority())
                .map_err(|_| unsafe_image("invalid_scope"))?;
            let before = parent
                .symlink_metadata(name)
                .map_err(|_| unsafe_image("invalid_scope"))?;
            if before.file_type().is_symlink() || !before.is_dir() {
                return Err(unsafe_image("invalid_scope"));
            }
            let directory = parent
                .open_dir(name)
                .map_err(|_| unsafe_image("invalid_scope"))?;
            let opened = directory
                .dir_metadata()
                .map_err(|_| unsafe_image("invalid_scope"))?;
            if !opened.is_dir() || !metadata_matches(&before, &opened) {
                return Err(unsafe_image("scope_changed"));
            }
            directory
        }
        _ => Dir::open_ambient_dir(path, ambient_authority())
            .map_err(|_| unsafe_image("invalid_scope"))?,
    };
    let opened = directory
        .dir_metadata()
        .map_err(|_| unsafe_image("invalid_scope"))?;
    if !opened.is_dir() {
        return Err(unsafe_image("invalid_scope"));
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| unsafe_image("invalid_scope"))?;
    let current = Dir::open_ambient_dir(&canonical, ambient_authority())
        .map_err(|_| unsafe_image("invalid_scope"))?;
    let current_metadata = current
        .dir_metadata()
        .map_err(|_| unsafe_image("invalid_scope"))?;
    if !metadata_matches(&opened, &current_metadata) {
        return Err(unsafe_image("scope_changed"));
    }
    Ok(ImageCapabilityRoot {
        input_path: path.to_path_buf(),
        directory,
    })
}

fn acquire_canonical_image_root(path: &Path) -> Result<ImageCapabilityRoot, AppError> {
    let canonical = std::fs::canonicalize(path).map_err(|_| unsafe_image("invalid_scope"))?;
    acquire_image_root(&canonical)
}

fn clone_attached_image_root(root: &ImageCapabilityRoot) -> Result<ImageCapabilityRoot, AppError> {
    let current = acquire_image_root(&root.input_path)?;
    let expected_metadata = root
        .directory
        .dir_metadata()
        .map_err(|_| unsafe_image("scope_unavailable"))?;
    let current_metadata = current
        .directory
        .dir_metadata()
        .map_err(|_| unsafe_image("scope_unavailable"))?;
    if !metadata_matches(&expected_metadata, &current_metadata) {
        return Err(unsafe_image("scope_changed"));
    }
    Ok(ImageCapabilityRoot {
        input_path: root.input_path.clone(),
        directory: root
            .directory
            .try_clone()
            .map_err(|_| unsafe_image("scope_unavailable"))?,
    })
}

fn relative_image_target(
    allowed_root: &Path,
    base_dir: &Path,
    reference: &str,
) -> Result<PathBuf, AppError> {
    if !base_dir.is_absolute() {
        return Err(unsafe_image("invalid_scope"));
    }
    let relative_base = base_dir
        .strip_prefix(allowed_root)
        .map_err(|_| unsafe_image("outside_allowed_root"))?;
    validate_relative_path(relative_base, true)?;

    let reference = Path::new(reference);
    validate_relative_path(reference, false)?;
    let target = relative_base.join(reference);
    validate_relative_path(&target, false)?;
    let mut normalized = PathBuf::new();
    for component in target.components() {
        if let Component::Normal(part) = component {
            normalized.push(part);
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err(unsafe_image("invalid_reference"));
    }
    Ok(normalized)
}

fn validate_relative_path(path: &Path, allow_empty: bool) -> Result<(), AppError> {
    if path.is_absolute() || (!allow_empty && path.as_os_str().is_empty()) {
        return Err(unsafe_image("invalid_reference"));
    }
    for component in path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => return Err(unsafe_image("parent_traversal")),
            Component::Prefix(_) | Component::RootDir => {
                return Err(unsafe_image("invalid_reference"))
            }
        }
    }
    Ok(())
}

fn verify_opened_parents_are_attached(
    root: &Dir,
    opened: &[OpenedDirectoryComponent],
) -> Result<(), AppError> {
    for component in opened {
        let current = root
            .symlink_metadata(&component.relative)
            .map_err(|_| unsafe_image("path_changed"))?;
        if current.file_type().is_symlink()
            || !current.is_dir()
            || !metadata_matches(&current, &component.metadata)
        {
            return Err(unsafe_image("path_changed"));
        }
    }
    Ok(())
}

fn validate_image_metadata(metadata: &Metadata) -> Result<(), AppError> {
    if metadata.file_type().is_symlink() {
        return Err(unsafe_image("symlink_component"));
    }
    if !metadata.is_file() {
        return Err(unsafe_image("not_regular_file"));
    }
    if metadata.len() > MAX_LOCAL_IMAGE_BYTES as u64 {
        return Err(unsafe_image("image_too_large"));
    }
    Ok(())
}

#[cfg(unix)]
fn metadata_matches(left: &Metadata, right: &Metadata) -> bool {
    use cap_std::fs::MetadataExt;

    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(windows)]
fn metadata_matches(left: &Metadata, right: &Metadata) -> bool {
    use cap_primitives::fs::_WindowsByHandle;

    matches!(
        (
            left.volume_serial_number(),
            right.volume_serial_number(),
            left.file_index(),
            right.file_index(),
        ),
        (Some(left_volume), Some(right_volume), Some(left_index), Some(right_index))
            if left_volume == right_volume && left_index == right_index
    )
}

#[cfg(not(any(unix, windows)))]
fn metadata_matches(_left: &Metadata, _right: &Metadata) -> bool {
    false
}

fn unsafe_image(reason: &str) -> AppError {
    AppError::Custom(format!("unsafe_image: {reason}"))
}

#[cfg(test)]
#[allow(dead_code)]
fn install_before_image_open_hook(path: PathBuf, hook: impl FnOnce() + Send + 'static) {
    BEFORE_IMAGE_OPEN_HOOKS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(path, Box::new(hook));
}

#[cfg(test)]
#[allow(dead_code)]
fn install_after_parent_verify_hook(path: PathBuf, hook: impl FnOnce() + Send + 'static) {
    AFTER_PARENT_VERIFY_HOOKS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(path, Box::new(hook));
}

#[cfg(test)]
fn run_before_image_open_hook(path: &Path) {
    let hook = BEFORE_IMAGE_OPEN_HOOKS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(path);
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(test)]
fn run_after_parent_verify_hook(path: &Path) {
    let hook = AFTER_PARENT_VERIFY_HOOKS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(path);
    if let Some(hook) = hook {
        hook();
    }
}

#[cfg(test)]
mod confined_read_tests {
    use super::*;
    use std::path::Path;
    use tempfile::TempDir;

    const LOCAL_IMAGE: &[u8] = b"local-image-bytes";
    const OUTSIDE_SENTINEL: &[u8] = b"outside-sentinel-must-never-be-read";

    async fn confined_read(
        allowed_root: &Path,
        base_dir: &Path,
        reference: &str,
    ) -> Result<Vec<u8>, AppError> {
        let root = acquire_image_root(allowed_root)?;
        read_image_bytes_blocking(root, base_dir, reference)
    }

    fn assert_safe_rejection(error: AppError, outside_path: &Path) {
        let message = error.to_string();
        assert!(message.starts_with("unsafe_image:"), "{message}");
        assert!(
            message.len() <= 128,
            "unsafe image error is unbounded: {message}"
        );
        assert!(!message.contains(&outside_path.to_string_lossy().to_string()));
        assert!(!message.contains("outside-sentinel-must-never-be-read"));
        assert_eq!(std::fs::read(outside_path).unwrap(), OUTSIDE_SENTINEL);
    }

    #[tokio::test]
    async fn confined_read_preserves_nested_cjk_image_paths() {
        let project = TempDir::new().unwrap();
        let document_dir = project.path().join("章节").join("第一章");
        let image = document_dir.join("插图").join("人物 甲.png");
        std::fs::create_dir_all(image.parent().unwrap()).unwrap();
        std::fs::write(&image, LOCAL_IMAGE).unwrap();

        let bytes = confined_read(project.path(), &document_dir, "插图/人物 甲.png")
            .await
            .unwrap();
        assert_eq!(bytes, LOCAL_IMAGE);
    }

    #[tokio::test]
    async fn confined_read_rejects_parent_traversal_before_outside_sentinel_read() {
        let parent = TempDir::new().unwrap();
        let project = parent.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let outside = parent.path().join("outside-sentinel.png");
        std::fs::write(&outside, OUTSIDE_SENTINEL).unwrap();

        let error = confined_read(&project, &project, "../outside-sentinel.png")
            .await
            .expect_err("parent traversal must be rejected");
        assert_safe_rejection(error, &outside);
    }

    #[tokio::test]
    async fn confined_read_rejects_absolute_external_path_before_sentinel_read() {
        let project = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let outside = outside_dir.path().join("absolute-sentinel.png");
        std::fs::write(&outside, OUTSIDE_SENTINEL).unwrap();

        let error = confined_read(project.path(), project.path(), &outside.to_string_lossy())
            .await
            .expect_err("absolute external path must be rejected");
        assert_safe_rejection(error, &outside);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn confined_read_rejects_symlinked_capability_root_before_sentinel_read() {
        use std::os::unix::fs::symlink;

        let parent = TempDir::new().unwrap();
        let outside_dir = parent.path().join("outside");
        std::fs::create_dir(&outside_dir).unwrap();
        let outside = outside_dir.join("root-sentinel.png");
        std::fs::write(&outside, OUTSIDE_SENTINEL).unwrap();
        let linked_root = parent.path().join("project");
        symlink(&outside_dir, &linked_root).unwrap();

        let error = confined_read(&linked_root, &linked_root, "root-sentinel.png")
            .await
            .expect_err("symlinked capability root must be rejected");
        assert_safe_rejection(error, &outside);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn confined_read_rejects_symlinked_file_before_sentinel_read() {
        use std::os::unix::fs::symlink;

        let project = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let outside = outside_dir.path().join("file-sentinel.png");
        std::fs::write(&outside, OUTSIDE_SENTINEL).unwrap();
        symlink(&outside, project.path().join("linked.png")).unwrap();

        let error = confined_read(project.path(), project.path(), "linked.png")
            .await
            .expect_err("symlinked file must be rejected");
        assert_safe_rejection(error, &outside);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn confined_read_rejects_symlinked_parent_before_sentinel_read() {
        use std::os::unix::fs::symlink;

        let project = TempDir::new().unwrap();
        let outside_dir = TempDir::new().unwrap();
        let outside = outside_dir.path().join("parent-sentinel.png");
        std::fs::write(&outside, OUTSIDE_SENTINEL).unwrap();
        symlink(outside_dir.path(), project.path().join("linked-parent")).unwrap();

        let error = confined_read(
            project.path(),
            project.path(),
            "linked-parent/parent-sentinel.png",
        )
        .await
        .expect_err("symlinked parent must be rejected");
        assert_safe_rejection(error, &outside);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn confined_read_rejects_directory_swap_before_outside_sentinel_read() {
        use std::os::unix::fs::symlink;

        let parent = TempDir::new().unwrap();
        let project = parent.path().join("project");
        let images = project.join("images");
        let outside_dir = parent.path().join("outside");
        std::fs::create_dir_all(&images).unwrap();
        std::fs::create_dir(&outside_dir).unwrap();
        std::fs::write(images.join("target.png"), LOCAL_IMAGE).unwrap();
        let outside = outside_dir.join("target.png");
        std::fs::write(&outside, OUTSIDE_SENTINEL).unwrap();
        let moved_images = project.join("images-before-swap");

        install_before_image_open_hook(PathBuf::from("images/target.png"), move || {
            std::fs::rename(&images, &moved_images).unwrap();
            symlink(&outside_dir, &images).unwrap();
        });
        let error = confined_read(&project, &project, "images/target.png")
            .await
            .expect_err("directory replacement must be rejected");
        assert_safe_rejection(error, &outside);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn confined_read_rejects_parent_detached_after_attachment_check() {
        let parent = TempDir::new().unwrap();
        let project = parent.path().join("project");
        let images = project.join("post-check-images");
        let detached = parent.path().join("detached-images");
        std::fs::create_dir_all(&images).unwrap();
        std::fs::write(images.join("target.png"), LOCAL_IMAGE).unwrap();

        let detached_for_hook = detached.clone();
        install_after_parent_verify_hook(
            PathBuf::from("post-check-images/target.png"),
            move || {
                std::fs::rename(&images, &detached_for_hook).unwrap();
                std::fs::write(detached_for_hook.join("target.png"), OUTSIDE_SENTINEL).unwrap();
            },
        );

        let error = confined_read(&project, &project, "post-check-images/target.png")
            .await
            .expect_err("detached final parent must be rejected");
        assert_safe_rejection(error, &detached.join("target.png"));
    }

    #[test]
    fn capability_registry_rejects_unregistered_owners_and_arbitrary_bases() {
        let project = TempDir::new().unwrap();
        let document_dir = project.path().join("章节");
        std::fs::create_dir(&document_dir).unwrap();
        let outside = TempDir::new().unwrap();
        let capabilities = WindowImageCapabilities::new();

        capabilities
            .replace_project("owner-a", project.path())
            .unwrap();

        assert!(capabilities
            .authorize_base("owner-a", &document_dir)
            .is_ok());
        assert!(capabilities
            .authorize_base("owner-a", outside.path())
            .is_err());
        assert!(capabilities
            .authorize_base("owner-b", &document_dir)
            .is_err());
    }

    #[test]
    fn document_capability_is_owner_scoped_reference_counted_and_revoked() {
        let project = TempDir::new().unwrap();
        let document = project.path().join("第一章.md");
        std::fs::write(&document, "# 第一章").unwrap();
        let capabilities = WindowImageCapabilities::new();

        capabilities
            .register_document("owner-a", &document)
            .unwrap();
        capabilities
            .register_document("owner-a", &document)
            .unwrap();
        assert!(capabilities
            .authorize_base("owner-a", project.path())
            .is_ok());
        assert!(capabilities
            .authorize_base("owner-b", project.path())
            .is_err());

        capabilities
            .unregister_document("owner-a", &document)
            .unwrap();
        assert!(capabilities
            .authorize_base("owner-a", project.path())
            .is_ok());
        capabilities
            .unregister_document("owner-a", &document)
            .unwrap();
        assert!(capabilities
            .authorize_base("owner-a", project.path())
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn capability_registry_rejects_a_replaced_project_root() {
        let parent = TempDir::new().unwrap();
        let project = parent.path().join("project");
        let moved = parent.path().join("moved-project");
        std::fs::create_dir(&project).unwrap();
        let capabilities = WindowImageCapabilities::new();
        capabilities.replace_project("owner", &project).unwrap();

        std::fs::rename(&project, &moved).unwrap();
        std::fs::create_dir(&project).unwrap();

        assert!(capabilities.authorize_base("owner", &project).is_err());
    }

    #[test]
    fn clearing_owner_revokes_project_and_document_capabilities() {
        let project = TempDir::new().unwrap();
        let document = project.path().join("chapter.md");
        std::fs::write(&document, "# Chapter").unwrap();
        let capabilities = WindowImageCapabilities::new();
        capabilities
            .replace_project("owner", project.path())
            .unwrap();
        capabilities.register_document("owner", &document).unwrap();

        capabilities.clear_owner("owner");

        assert!(capabilities
            .authorize_base("owner", project.path())
            .is_err());
    }
}
