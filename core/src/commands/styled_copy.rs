use crate::error::AppError;
use crate::services::publish::styled_copy_pandoc;
use cap_std::ambient_authority;
use cap_std::fs::{Dir, Metadata};
use std::io::Read;
use std::path::{Path, PathBuf};

#[cfg(test)]
type BeforeImageOpenHook = Box<dyn FnOnce() + Send>;

#[cfg(test)]
static BEFORE_IMAGE_OPEN_HOOKS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, BeforeImageOpenHook>>,
> = std::sync::OnceLock::new();

pub const MAX_STYLED_COPY_IMAGE_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_STYLED_CLIPBOARD_HTML_BYTES: usize = styled_copy_pandoc::MAX_HTML_BYTES;
pub const MAX_STYLED_CLIPBOARD_PLAIN_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, serde::Serialize, specta::Type)]
pub struct StyledCopyImage {
    pub bytes: Vec<u8>,
    pub mime: String,
}

#[tauri::command]
#[specta::specta]
pub async fn convert_markdown_to_styled_html(markdown: String) -> Result<String, AppError> {
    styled_copy_pandoc::styled_markdown_to_html(&markdown).await
}

#[tauri::command]
#[specta::specta]
pub async fn read_styled_copy_image(
    path: String,
    allowed_roots: Vec<String>,
) -> Result<StyledCopyImage, AppError> {
    if path.trim().is_empty() || allowed_roots.is_empty() {
        return Err(unsafe_asset("invalid_path"));
    }

    tokio::task::spawn_blocking(move || read_styled_copy_image_blocking(path, allowed_roots))
        .await
        .map_err(|_| unsafe_asset("unreadable"))?
}

struct AllowedRoot {
    canonical: PathBuf,
    directory: Dir,
}

fn read_styled_copy_image_blocking(
    path: String,
    allowed_roots: Vec<String>,
) -> Result<StyledCopyImage, AppError> {
    let candidate =
        std::fs::canonicalize(PathBuf::from(path)).map_err(|_| unsafe_asset("invalid_path"))?;
    let mut roots = Vec::with_capacity(allowed_roots.len());
    for root in allowed_roots {
        if root.trim().is_empty() {
            return Err(unsafe_asset("invalid_root"));
        }
        roots.push(acquire_allowed_root(PathBuf::from(root))?);
    }

    let root = roots
        .iter()
        .find(|root| path_is_within(&candidate, &root.canonical))
        .ok_or_else(|| unsafe_asset("outside_allowed_roots"))?;
    let relative = candidate
        .strip_prefix(&root.canonical)
        .map_err(|_| unsafe_asset("outside_allowed_roots"))?;
    let relative = if relative.as_os_str().is_empty() {
        Path::new(".")
    } else {
        relative
    };

    #[cfg(test)]
    run_before_image_open_hook(&candidate);

    let mut file = root
        .directory
        .open(relative)
        .map_err(|_| unsafe_asset("unreadable"))?;
    let opened_metadata = file.metadata().map_err(|_| unsafe_asset("unreadable"))?;
    validate_file_metadata(&opened_metadata)?;

    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.by_ref()
        .take((MAX_STYLED_COPY_IMAGE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| unsafe_asset("unreadable"))?;
    if bytes.len() > MAX_STYLED_COPY_IMAGE_BYTES {
        return Err(AppError::Custom("asset_too_large".to_string()));
    }
    let after_read = file.metadata().map_err(|_| unsafe_asset("unreadable"))?;
    validate_file_metadata(&after_read)?;

    let mime = detect_image_mime(&bytes)
        .ok_or_else(|| AppError::Custom("unsupported_image_format".to_string()))?;
    Ok(StyledCopyImage {
        bytes,
        mime: mime.to_string(),
    })
}

fn acquire_allowed_root(path: PathBuf) -> Result<AllowedRoot, AppError> {
    let directory = Dir::open_ambient_dir(&path, ambient_authority())
        .map_err(|_| unsafe_asset("invalid_root"))?;
    let metadata = directory
        .dir_metadata()
        .map_err(|_| unsafe_asset("invalid_root"))?;
    if !metadata.is_dir() {
        return Err(unsafe_asset("invalid_root"));
    }

    let canonical = std::fs::canonicalize(&path).map_err(|_| unsafe_asset("invalid_root"))?;
    let current = Dir::open_ambient_dir(&canonical, ambient_authority())
        .map_err(|_| unsafe_asset("invalid_root"))?;
    let current_metadata = current
        .dir_metadata()
        .map_err(|_| unsafe_asset("invalid_root"))?;
    if !metadata_matches(&metadata, &current_metadata) {
        return Err(unsafe_asset("invalid_root"));
    }

    Ok(AllowedRoot {
        canonical,
        directory,
    })
}

#[cfg(unix)]
fn metadata_matches(left: &Metadata, right: &Metadata) -> bool {
    use cap_std::fs::MetadataExt;

    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(windows)]
fn metadata_matches(_left: &Metadata, _right: &Metadata) -> bool {
    // cap-std omits FILE_SHARE_DELETE for retained Windows directory handles,
    // preventing the capability root from being renamed or deleted during lookup.
    true
}

#[cfg(not(any(unix, windows)))]
fn metadata_matches(_left: &Metadata, _right: &Metadata) -> bool {
    false
}

#[tauri::command]
#[specta::specta]
pub async fn write_styled_clipboard(html: String, plain_text: String) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        write_styled_clipboard_with(&html, &plain_text, |actual_html, actual_plain| {
            let mut clipboard = arboard::Clipboard::new().map_err(|_| ())?;
            clipboard
                .set_html(actual_html, Some(actual_plain))
                .map_err(|_| ())
        })
    })
    .await
    .map_err(|_| AppError::Custom("clipboard_write_failed".to_string()))?
}

fn write_styled_clipboard_with<F>(html: &str, plain_text: &str, writer: F) -> Result<(), AppError>
where
    F: FnOnce(&str, &str) -> Result<(), ()>,
{
    if html.len() > MAX_STYLED_CLIPBOARD_HTML_BYTES {
        return Err(AppError::Custom("clipboard_html_too_large".to_string()));
    }
    if plain_text.len() > MAX_STYLED_CLIPBOARD_PLAIN_BYTES {
        return Err(AppError::Custom("clipboard_plain_too_large".to_string()));
    }
    writer(html, plain_text).map_err(|_| AppError::Custom("clipboard_write_failed".to_string()))
}

fn path_is_within(candidate: &Path, root: &Path) -> bool {
    candidate.starts_with(root)
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

fn validate_file_metadata(metadata: &Metadata) -> Result<(), AppError> {
    if !metadata.is_file() {
        return Err(unsafe_asset("not_regular_file"));
    }
    if metadata.len() == 0 {
        return Err(unsafe_asset("empty_file"));
    }
    if metadata.len() > MAX_STYLED_COPY_IMAGE_BYTES as u64 {
        return Err(AppError::Custom("asset_too_large".to_string()));
    }
    Ok(())
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn unsafe_asset(reason: &str) -> AppError {
    AppError::Custom(format!("unsafe_asset: {reason}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nrest";
    const JPEG: &[u8] = b"\xff\xd8\xff\xe0rest";
    const GIF: &[u8] = b"GIF89arest";
    const WEBP: &[u8] = b"RIFF\x04\x00\x00\x00WEBPrest";

    async fn read(path: &Path, roots: &[&Path]) -> Result<StyledCopyImage, AppError> {
        read_styled_copy_image(
            path.to_string_lossy().to_string(),
            roots
                .iter()
                .map(|root| root.to_string_lossy().to_string())
                .collect(),
        )
        .await
    }

    #[tokio::test]
    async fn styled_copy_image_accepts_only_supported_magic_under_allowed_root() {
        let dir = TempDir::new().unwrap();
        for (name, bytes, mime) in [
            ("image.bin", PNG, "image/png"),
            ("photo.data", JPEG, "image/jpeg"),
            ("animation.unknown", GIF, "image/gif"),
            ("picture.noext", WEBP, "image/webp"),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            let image = read(&path, &[dir.path()]).await.unwrap();
            assert_eq!(image.bytes, bytes);
            assert_eq!(image.mime, mime);
        }
    }

    #[tokio::test]
    async fn styled_copy_image_rejects_traversal_and_spoofed_content() {
        let parent = TempDir::new().unwrap();
        let root = parent.path().join("allowed");
        std::fs::create_dir(&root).unwrap();
        let outside = parent.path().join("outside.png");
        std::fs::write(&outside, PNG).unwrap();
        let traversal = root.join("..").join("outside.png");
        let traversal_error = read(&traversal, &[&root]).await.unwrap_err().to_string();
        assert!(
            traversal_error.starts_with("unsafe_asset:"),
            "{traversal_error}"
        );

        let spoof = root.join("spoof.png");
        std::fs::write(&spoof, b"not really an image").unwrap();
        assert_eq!(
            read(&spoof, &[&root]).await.unwrap_err().to_string(),
            "unsupported_image_format"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn styled_copy_image_rejects_symlink_escape() {
        let parent = TempDir::new().unwrap();
        let root = parent.path().join("allowed");
        std::fs::create_dir(&root).unwrap();
        let outside = parent.path().join("outside.png");
        std::fs::write(&outside, PNG).unwrap();
        let link = root.join("link.png");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        let error = read(&link, &[&root]).await.unwrap_err().to_string();
        assert!(error.starts_with("unsafe_asset:"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn styled_copy_image_rejects_parent_symlink_swap_after_containment_check() {
        let parent = TempDir::new().unwrap();
        let root = parent.path().join("allowed");
        let checked_parent = root.join("checked");
        let outside = parent.path().join("outside");
        std::fs::create_dir_all(&checked_parent).unwrap();
        std::fs::create_dir(&outside).unwrap();

        let candidate = checked_parent.join("image.png");
        std::fs::write(&candidate, JPEG).unwrap();
        std::fs::write(outside.join("image.png"), PNG).unwrap();

        let moved_parent = root.join("checked-before-swap");
        install_before_image_open_hook(std::fs::canonicalize(&candidate).unwrap(), {
            let checked_parent = checked_parent.clone();
            let outside = outside.clone();
            move || {
                std::fs::rename(&checked_parent, &moved_parent).unwrap();
                std::os::unix::fs::symlink(&outside, &checked_parent).unwrap();
            }
        });

        let error = read(&candidate, &[&root])
            .await
            .expect_err("swapped parent must not expose outside PNG bytes")
            .to_string();
        assert!(error.starts_with("unsafe_asset:"), "{error}");
    }

    #[tokio::test]
    async fn styled_copy_image_rejects_empty_directory_svg_and_oversize() {
        let dir = TempDir::new().unwrap();
        let empty = dir.path().join("empty.png");
        std::fs::write(&empty, b"").unwrap();
        assert!(read(&empty, &[dir.path()]).await.is_err());

        assert!(read(dir.path(), &[dir.path()]).await.is_err());

        let svg = dir.path().join("vector.svg");
        std::fs::write(&svg, b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();
        assert_eq!(
            read(&svg, &[dir.path()]).await.unwrap_err().to_string(),
            "unsupported_image_format"
        );

        let oversize = dir.path().join("large.png");
        let file = std::fs::File::create(&oversize).unwrap();
        file.set_len((MAX_STYLED_COPY_IMAGE_BYTES + 1) as u64)
            .unwrap();
        assert_eq!(
            read(&oversize, &[dir.path()])
                .await
                .unwrap_err()
                .to_string(),
            "asset_too_large"
        );
    }

    #[tokio::test]
    async fn styled_copy_image_rejects_empty_candidate_or_roots() {
        let dir = TempDir::new().unwrap();
        let image = dir.path().join("image.png");
        std::fs::write(&image, PNG).unwrap();

        let empty_path = read_styled_copy_image(
            "".to_string(),
            vec![dir.path().to_string_lossy().to_string()],
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(empty_path.starts_with("unsafe_asset:"), "{empty_path}");
        let empty_roots = read_styled_copy_image(image.to_string_lossy().to_string(), vec![])
            .await
            .unwrap_err()
            .to_string();
        assert!(empty_roots.starts_with("unsafe_asset:"), "{empty_roots}");
    }

    #[tokio::test]
    async fn styled_copy_image_preserves_candidate_error_precedence() {
        let dir = TempDir::new().unwrap();
        let missing_candidate = dir.path().join("missing.png");
        let missing_root = dir.path().join("missing-root");

        let error = read_styled_copy_image(
            missing_candidate.to_string_lossy().to_string(),
            vec![missing_root.to_string_lossy().to_string()],
        )
        .await
        .unwrap_err()
        .to_string();
        assert_eq!(error, "unsafe_asset: invalid_path");
    }

    #[test]
    fn styled_clipboard_forwards_html_and_plain_exactly_once() {
        let calls = AtomicUsize::new(0);
        let html = "<p>第一章 <strong>重点</strong></p>";
        let plain = "第一章 重点";

        write_styled_clipboard_with(html, plain, |actual_html, actual_plain| {
            calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(actual_html, html);
            assert_eq!(actual_plain, plain);
            Ok(())
        })
        .unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn styled_clipboard_validates_both_payloads_before_writer_call() {
        for (html, plain, expected) in [
            (
                "x".repeat(MAX_STYLED_CLIPBOARD_HTML_BYTES + 1),
                "plain".to_string(),
                "clipboard_html_too_large",
            ),
            (
                "<p>x</p>".to_string(),
                "x".repeat(MAX_STYLED_CLIPBOARD_PLAIN_BYTES + 1),
                "clipboard_plain_too_large",
            ),
        ] {
            let calls = AtomicUsize::new(0);
            let error = write_styled_clipboard_with(&html, &plain, |_, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap_err()
            .to_string();
            assert_eq!(error, expected);
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn styled_clipboard_maps_writer_errors_without_raw_os_details() {
        let error = write_styled_clipboard_with("<p>x</p>", "x", |_, _| Err(()))
            .unwrap_err()
            .to_string();
        assert_eq!(error, "clipboard_write_failed");
    }
}
