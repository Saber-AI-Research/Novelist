//! Cover-asset storage for the Publish sidecar.
//!
//! Assets live under `<project>/.novelist/publish-assets/<hash>.<ext>`.
//! The filename stem is a hex BLAKE3 digest of the raw bytes so identical
//! images from different documents/channels dedupe automatically.
//!
//! MIME type is detected from the leading magic bytes (PNG / JPEG / GIF /
//! WebP) — the caller's declared MIME is treated as an assertion the
//! bytes must satisfy, never as ground truth. Mismatched declarations and
//! unknown formats fail with a typed error and never touch disk.
//!
//! Writes use the same atomic temp+fsync+rename primitive that Task 1's
//! `sidecar::atomic_write_json` uses (see `atomic_write_bytes` below),
//! and dedupe is enforced by BLAKE3 content addressing plus a
//! `create_new` guard on the temp file.
//!
//! Callers must not use this module to delete assets directly — deletion
//! is only safe through `sidecar::cleanup_orphan_assets`, which scans
//! every sidecar's `CoverRef` before pruning.

use crate::error::AppError;
use crate::services::sidecar::{
    atomic_write_bytes_confined, open_confined_metadata_dir, read_bytes_confined,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

const ASSETS_SUBDIR: &str = "publish-assets";

/// Cap the raw byte payload we'll hash & persist. 25 MiB is well beyond
/// any reasonable feature-image size and prevents an accidental
/// gigabyte-worth of decoded clipboard bytes from filling the project
/// working tree.
pub const MAX_COVER_BYTES: usize = 25 * 1024 * 1024;

/// Reference to a stored cover asset. Serialized inside the Publish
/// sidecar's per-channel state.
///
/// * `content_hash` is the hex BLAKE3 digest of the raw bytes; it doubles
///   as the on-disk filename stem so the reference is durable across
///   application restarts and repository moves.
/// * `extension` is the canonical lowercase file extension we assigned
///   at write time (`"png"` / `"jpg"` / `"gif"` / `"webp"`).
/// * `mime` is the content-derived MIME string (never the caller's
///   claimed value).
/// * `bytes` is the raw payload length; used at cleanup time to catch
///   accidental truncation.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct CoverRef {
    pub content_hash: String,
    pub extension: String,
    pub mime: String,
    pub bytes: u64,
}

impl CoverRef {
    /// Canonical on-disk filename (`<lowercase-hash>.<ext>`).
    ///
    /// The hash is folded to lowercase because `store_cover_asset`
    /// always emits lowercase BLAKE3 hex, and macOS/Windows default
    /// filesystems are case-insensitive while Linux ext4 is
    /// case-sensitive. Preserving caller case would make an
    /// uppercase-hash `CoverRef` resolve to a nonexistent path on
    /// Linux (load returns `Ok(None)`) AND make cleanup interpret
    /// the on-disk lowercase file as unreferenced (destructive
    /// delete). Lowercasing here is the single point of
    /// canonicalization; all other identity comparisons remain
    /// case-insensitive on the hash string itself.
    pub fn file_name(&self) -> String {
        format!(
            "{}.{}",
            self.content_hash.to_ascii_lowercase(),
            self.extension
        )
    }

    /// Authoritative validator. Every read/write/path boundary must
    /// call this before trusting a `CoverRef`. A `CoverRef` that
    /// arrives from disk (deserialized JSON) or from an IPC caller
    /// is UNTRUSTED until this returns `Ok(())`.
    ///
    /// Checks, in order:
    /// 1. `content_hash` is exactly 64 ASCII hex characters (BLAKE3
    ///    hex output length). Both cases are accepted for parsing
    ///    forward-compat, but only lowercase is produced by
    ///    `store_cover_asset`.
    /// 2. `extension` is one of `png` / `jpg` / `gif` / `webp`.
    /// 3. `mime` is the canonical MIME string that pairs with
    ///    `extension`. No aliases — the on-disk sidecar must be a
    ///    single, deterministic form.
    /// 4. `bytes` is within `1..=MAX_COVER_BYTES`. A zero-length
    ///    payload is impossible for a valid image.
    /// 5. The composed on-disk filename (`<hash>.<ext>`) has no path
    ///    separators, null bytes, or other filesystem escape
    ///    sequences and resolves to a single normal path component.
    pub fn validate(&self) -> Result<(), AppError> {
        if self.content_hash.len() != CONTENT_HASH_LEN
            || !self.content_hash.chars().all(|c| c.is_ascii_hexdigit())
        {
            return Err(AppError::InvalidInput(format!(
                "CoverRef.content_hash must be {CONTENT_HASH_LEN} ASCII hex chars: {:?}",
                self.content_hash
            )));
        }
        if !is_valid_extension(&self.extension) {
            return Err(AppError::InvalidInput(format!(
                "CoverRef.extension must be png/jpg/gif/webp: {:?}",
                self.extension
            )));
        }
        let expected_mime = canonical_mime_for_extension(&self.extension);
        if self.mime != expected_mime {
            return Err(AppError::InvalidInput(format!(
                "CoverRef.mime {:?} does not match extension {:?} (expected {:?})",
                self.mime, self.extension, expected_mime
            )));
        }
        if self.bytes == 0 {
            return Err(AppError::InvalidInput(
                "CoverRef.bytes must be non-zero".to_string(),
            ));
        }
        if self.bytes > MAX_COVER_BYTES as u64 {
            return Err(AppError::InvalidInput(format!(
                "CoverRef.bytes {} exceeds MAX_COVER_BYTES {}",
                self.bytes, MAX_COVER_BYTES
            )));
        }
        validate_asset_filename_component(&self.file_name())?;
        Ok(())
    }
}

const CONTENT_HASH_LEN: usize = 64;

fn canonical_mime_for_extension(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "",
    }
}

/// Reject any filename that would resolve to more than one path
/// component, contains separators, dot-dot, control chars, or null
/// bytes. A trusted `<hash>.<ext>` always passes.
fn validate_asset_filename_component(name: &str) -> Result<(), AppError> {
    if name.is_empty() {
        return Err(AppError::InvalidInput(
            "Asset filename must not be empty".to_string(),
        ));
    }
    if name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name.contains("..")
        || name.starts_with('.')
    {
        return Err(AppError::PathNotAllowed(format!(
            "Asset filename would escape publish-assets: {name:?}"
        )));
    }
    for ch in name.chars() {
        if ch.is_control() {
            return Err(AppError::PathNotAllowed(format!(
                "Asset filename contains control character: {name:?}"
            )));
        }
    }
    let path = std::path::Path::new(name);
    let mut count = 0usize;
    for component in path.components() {
        count += 1;
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err(AppError::PathNotAllowed(format!(
                "Asset filename produced non-normal component: {name:?}"
            )));
        }
    }
    if count != 1 {
        return Err(AppError::PathNotAllowed(format!(
            "Asset filename produced multi-segment path: {name:?}"
        )));
    }
    Ok(())
}

/// Content-derived MIME. Returned alongside the canonical extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DetectedImage {
    pub mime: &'static str,
    pub extension: &'static str,
}

/// Sniff the leading magic bytes and return the canonical MIME +
/// extension, or an `InvalidInput` error if the payload does not match
/// one of the supported formats.
///
/// Recognized formats:
/// - PNG:  `89 50 4E 47 0D 0A 1A 0A`
/// - JPEG: `FF D8 FF`
/// - GIF:  `GIF87a` / `GIF89a`
/// - WebP: `RIFF <4-byte-size> WEBP`
///
/// SVG, BMP, TIFF, HEIC and other formats are intentionally rejected —
/// the Publish spec only guarantees these four across all supported
/// hosts, and rejecting unknown bytes upstream is much safer than
/// silently uploading a mislabeled payload to the platform later.
pub fn detect_image_mime(bytes: &[u8]) -> Result<DetectedImage, AppError> {
    if bytes.is_empty() {
        return Err(AppError::InvalidInput("Cover payload is empty".to_string()));
    }
    // PNG (8-byte signature)
    if bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n" {
        return Ok(DetectedImage {
            mime: "image/png",
            extension: "png",
        });
    }
    // JPEG (SOI + first marker)
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Ok(DetectedImage {
            mime: "image/jpeg",
            extension: "jpg",
        });
    }
    // GIF87a / GIF89a
    if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
        return Ok(DetectedImage {
            mime: "image/gif",
            extension: "gif",
        });
    }
    // WebP — RIFF container with WEBP FourCC at offset 8
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok(DetectedImage {
            mime: "image/webp",
            extension: "webp",
        });
    }
    Err(AppError::InvalidInput(
        "Cover payload does not match a supported image format \
         (png / jpeg / gif / webp)"
            .to_string(),
    ))
}

/// Assert that `declared_mime`, if present, agrees with `detected` on
/// the top-level media type. We accept normal aliases (e.g. `image/jpg`
/// for JPEG) so the caller can pass through a browser `File.type`
/// verbatim, but a mismatch of the actual format (e.g. declared
/// `image/png` for JPEG bytes) is rejected.
fn assert_declared_mime_matches(
    declared: Option<&str>,
    detected: DetectedImage,
) -> Result<(), AppError> {
    let Some(declared) = declared else {
        return Ok(());
    };
    let normalised = declared.trim().to_ascii_lowercase();
    if normalised.is_empty() {
        return Ok(());
    }
    let matches = match detected.mime {
        "image/png" => normalised == "image/png",
        "image/jpeg" => normalised == "image/jpeg" || normalised == "image/jpg",
        "image/gif" => normalised == "image/gif",
        "image/webp" => normalised == "image/webp",
        _ => false,
    };
    if !matches {
        return Err(AppError::InvalidInput(format!(
            "Declared cover MIME {declared:?} does not match detected {}",
            detected.mime
        )));
    }
    Ok(())
}

/// Absolute path to the directory holding all cover assets for a
/// project. Not created eagerly; callers write through
/// `store_cover_asset` which creates the directory as needed.
pub fn assets_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(".novelist").join(ASSETS_SUBDIR)
}

/// Absolute path to a single asset given its `CoverRef`.
///
/// Fails with `InvalidInput` / `PathNotAllowed` for any `CoverRef`
/// whose fields do not pass [`CoverRef::validate`]. This is the only
/// public path-composition helper — callers cannot bypass validation
/// by constructing paths themselves.
pub fn asset_path(project_dir: &Path, cover: &CoverRef) -> Result<PathBuf, AppError> {
    cover.validate()?;
    Ok(assets_dir(project_dir).join(cover.file_name()))
}

/// Persist a cover-image payload under `.novelist/publish-assets/`.
///
/// Guarantees:
/// 1. `bytes` is sniffed for a supported image format; unknown or
///    mismatched declarations return `InvalidInput` and never touch
///    disk.
/// 2. The on-disk filename is `<blake3-hex>.<ext>`, so identical bytes
///    always resolve to the same file (natural dedupe across channels
///    and documents).
/// 3. If the target file already exists with matching bytes, this is a
///    no-op — no write, no temp artefact.
/// 4. Otherwise the bytes are written via a unique temp file with
///    `create_new(true)` + `sync_all` + `rename`, matching Task 1's
///    atomic-write guarantee.
///
/// Never deletes anything; use `sidecar::cleanup_orphan_assets` for
/// reclamation.
pub async fn store_cover_asset(
    project_dir: &Path,
    bytes: Vec<u8>,
    declared_mime: Option<&str>,
) -> Result<CoverRef, AppError> {
    if bytes.len() > MAX_COVER_BYTES {
        return Err(AppError::InvalidInput(format!(
            "Cover payload is {} bytes; limit is {}",
            bytes.len(),
            MAX_COVER_BYTES
        )));
    }
    let detected = detect_image_mime(&bytes)?;
    assert_declared_mime_matches(declared_mime, detected)?;

    let hash = blake3::hash(&bytes).to_hex().to_string();
    let cover = CoverRef {
        content_hash: hash,
        extension: detected.extension.to_string(),
        mime: detected.mime.to_string(),
        bytes: bytes.len() as u64,
    };
    let storage = open_confined_metadata_dir(project_dir, ASSETS_SUBDIR, true)?
        .expect("create=true always returns a metadata directory");
    let file_name = cover.file_name();

    // Dedupe: identical hash + matching size means the payload is
    // already on disk. NotFound is the only silent-continue case;
    // every other read error (permission denied, EIO, IsADirectory,
    // symlink loops, etc.) must be propagated so we do not
    // accidentally overwrite a file we could not inspect.
    if let Some(existing) = read_bytes_confined(&storage, &file_name, MAX_COVER_BYTES).await? {
        if existing.len() as u64 == cover.bytes
            && blake3::hash(&existing)
                .to_hex()
                .eq_ignore_ascii_case(&cover.content_hash)
        {
            return Ok(cover);
        }
    }

    atomic_write_bytes_confined(&storage, &file_name, &bytes).await?;
    Ok(cover)
}

/// Read the raw bytes of a stored cover, if present.
///
/// Returns `Ok(None)` only for a genuinely missing file. Every other
/// consistency violation (declared vs on-disk length, hash, detected
/// MIME, canonical MIME, canonical extension) returns `AppError` and
/// NEVER yields bytes.
///
/// Verification order — every check must pass before data flows out:
/// 1. `CoverRef::validate` — hash shape, extension, MIME, declared
///    length.
/// 2. On-disk file length == `cover.bytes`.
/// 3. BLAKE3(on-disk bytes) == `cover.content_hash` (lowercase
///    comparison so the same asset always resolves regardless of the
///    input hash case).
/// 4. `detect_image_mime(on-disk bytes)` returns a `DetectedImage`
///    whose MIME agrees with `cover.mime` and extension agrees with
///    `cover.extension`.
pub async fn load_cover_bytes(
    project_dir: &Path,
    cover: &CoverRef,
) -> Result<Option<Vec<u8>>, AppError> {
    cover.validate()?;
    let Some(storage) = open_confined_metadata_dir(project_dir, ASSETS_SUBDIR, false)? else {
        return Ok(None);
    };
    let path = storage.absolute.join(cover.file_name());
    let Some(bytes) =
        read_bytes_confined(&storage, &cover.file_name(), cover.bytes as usize).await?
    else {
        return Ok(None);
    };
    if bytes.len() as u64 != cover.bytes {
        return Err(AppError::Custom(format!(
            "Cover asset {} length mismatch: declared {} bytes, on-disk {} bytes",
            path.display(),
            cover.bytes,
            bytes.len()
        )));
    }
    let on_disk_hash = blake3::hash(&bytes).to_hex();
    if !on_disk_hash
        .as_str()
        .eq_ignore_ascii_case(cover.content_hash.as_str())
    {
        return Err(AppError::Custom(format!(
            "Cover asset {} content-hash mismatch",
            path.display()
        )));
    }
    let detected = detect_image_mime(&bytes)?;
    if detected.mime != cover.mime {
        return Err(AppError::Custom(format!(
            "Cover asset {} MIME mismatch: declared {}, detected {}",
            path.display(),
            cover.mime,
            detected.mime
        )));
    }
    if detected.extension != cover.extension {
        return Err(AppError::Custom(format!(
            "Cover asset {} extension mismatch: declared {}, detected {}",
            path.display(),
            cover.extension,
            detected.extension
        )));
    }
    Ok(Some(bytes))
}

fn is_valid_hex(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn is_valid_extension(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "gif" | "webp")
}

/// Detect whether an on-disk filename in `publish-assets/` looks like an
/// asset produced by `store_cover_asset` (`<64-hex>.<ext>`). Used by the
/// cleanup pass to skip unrelated files a user or another tool may have
/// dropped there.
pub(crate) fn parse_asset_file_name(name: &str) -> Option<(String, String)> {
    let (stem, ext) = name.rsplit_once('.')?;
    if !is_valid_extension(ext) {
        return None;
    }
    if stem.len() != 64 || !is_valid_hex(stem) {
        return None;
    }
    Some((stem.to_string(), ext.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // ---- Magic-byte fixtures ------------------------------------------------

    fn png_signature_bytes() -> Vec<u8> {
        // 8-byte PNG signature followed by a minimal IHDR chunk header so
        // the payload has more than just the magic — deterministic but
        // meaningful for the "same bytes -> same hash" tests.
        let mut v = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
        v.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
        v
    }

    fn jpeg_signature_bytes() -> Vec<u8> {
        vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F']
    }

    fn gif_signature_bytes() -> Vec<u8> {
        b"GIF89a\x01\x00\x01\x00".to_vec()
    }

    fn webp_signature_bytes() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&[0x1a, 0, 0, 0]);
        v.extend_from_slice(b"WEBPVP8 ");
        v.extend_from_slice(&[0; 14]);
        v
    }

    // ---- detect_image_mime --------------------------------------------------

    #[test]
    fn detect_image_mime_png() {
        let d = detect_image_mime(&png_signature_bytes()).unwrap();
        assert_eq!(d.mime, "image/png");
        assert_eq!(d.extension, "png");
    }

    #[test]
    fn detect_image_mime_jpeg() {
        let d = detect_image_mime(&jpeg_signature_bytes()).unwrap();
        assert_eq!(d.mime, "image/jpeg");
        assert_eq!(d.extension, "jpg");
    }

    #[test]
    fn detect_image_mime_gif() {
        let d = detect_image_mime(&gif_signature_bytes()).unwrap();
        assert_eq!(d.mime, "image/gif");
        assert_eq!(d.extension, "gif");
    }

    #[test]
    fn detect_image_mime_webp() {
        let d = detect_image_mime(&webp_signature_bytes()).unwrap();
        assert_eq!(d.mime, "image/webp");
        assert_eq!(d.extension, "webp");
    }

    #[test]
    fn detect_image_mime_rejects_svg_or_text() {
        let err = detect_image_mime(b"<svg xmlns='http://w3.org/2000/svg'/>").unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn detect_image_mime_rejects_empty() {
        let err = detect_image_mime(&[]).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn detect_image_mime_rejects_truncated_png() {
        // Only 3 bytes of the 8-byte PNG magic — should not misdetect.
        let err = detect_image_mime(&[0x89, 0x50, 0x4E]).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn detect_image_mime_rejects_riff_without_webp() {
        // RIFF header for a WAV file, not WebP.
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&[0x24, 0, 0, 0]);
        v.extend_from_slice(b"WAVE");
        v.extend_from_slice(&[0; 20]);
        let err = detect_image_mime(&v).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    // ---- assert_declared_mime_matches --------------------------------------

    #[test]
    fn declared_mime_optional_when_none() {
        let d = DetectedImage {
            mime: "image/png",
            extension: "png",
        };
        assert_declared_mime_matches(None, d).unwrap();
    }

    #[test]
    fn declared_mime_accepts_alias_image_jpg_for_jpeg() {
        let d = DetectedImage {
            mime: "image/jpeg",
            extension: "jpg",
        };
        assert_declared_mime_matches(Some("image/jpg"), d).unwrap();
        assert_declared_mime_matches(Some("image/jpeg"), d).unwrap();
    }

    #[test]
    fn declared_mime_rejects_mismatch() {
        let d = DetectedImage {
            mime: "image/png",
            extension: "png",
        };
        let err = assert_declared_mime_matches(Some("image/jpeg"), d).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn declared_mime_tolerates_leading_trailing_whitespace() {
        let d = DetectedImage {
            mime: "image/png",
            extension: "png",
        };
        assert_declared_mime_matches(Some("  image/png  "), d).unwrap();
    }

    // ---- store_cover_asset --------------------------------------------------

    #[tokio::test]
    async fn store_cover_asset_writes_under_publish_assets() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let bytes = png_signature_bytes();
        let cover = store_cover_asset(project, bytes.clone(), Some("image/png"))
            .await
            .unwrap();

        assert_eq!(cover.extension, "png");
        assert_eq!(cover.mime, "image/png");
        assert_eq!(cover.bytes, bytes.len() as u64);
        assert_eq!(cover.content_hash.len(), 64);

        let expected = project
            .join(".novelist")
            .join("publish-assets")
            .join(cover.file_name());
        assert!(expected.exists(), "asset not written to expected path");

        let on_disk = tokio::fs::read(&expected).await.unwrap();
        assert_eq!(on_disk, bytes);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn store_cover_asset_rejects_symlinked_novelist_directory() {
        use std::os::unix::fs::symlink;

        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        symlink(outside.path(), project.path().join(".novelist")).unwrap();

        let error = store_cover_asset(project.path(), png_signature_bytes(), Some("image/png"))
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::PathNotAllowed(_)));
        assert!(!outside.path().join("publish-assets").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn store_cover_asset_rejects_symlinked_asset_directory() {
        use std::os::unix::fs::symlink;

        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::fs::create_dir(project.path().join(".novelist")).unwrap();
        symlink(
            outside.path(),
            project.path().join(".novelist").join("publish-assets"),
        )
        .unwrap();

        let error = store_cover_asset(project.path(), png_signature_bytes(), Some("image/png"))
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::PathNotAllowed(_)));
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn store_cover_asset_dedupes_identical_bytes() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let bytes = png_signature_bytes();
        let a = store_cover_asset(project, bytes.clone(), Some("image/png"))
            .await
            .unwrap();
        let b = store_cover_asset(project, bytes.clone(), Some("image/png"))
            .await
            .unwrap();
        assert_eq!(a, b, "identical bytes must produce identical CoverRef");

        let assets_dir = project.join(".novelist").join("publish-assets");
        let mut count = 0usize;
        let mut entries = tokio::fs::read_dir(&assets_dir).await.unwrap();
        while let Some(e) = entries.next_entry().await.unwrap() {
            let n = e.file_name().to_string_lossy().to_string();
            assert!(!n.ends_with(".novelist-tmp"), "temp leaked: {n}");
            count += 1;
        }
        assert_eq!(count, 1, "duplicate write should not create a second file");
    }

    #[tokio::test]
    async fn store_cover_asset_leaves_no_temp_on_success() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        store_cover_asset(project, jpeg_signature_bytes(), Some("image/jpeg"))
            .await
            .unwrap();
        let assets_dir = project.join(".novelist").join("publish-assets");
        let mut entries = tokio::fs::read_dir(&assets_dir).await.unwrap();
        while let Some(e) = entries.next_entry().await.unwrap() {
            let n = e.file_name().to_string_lossy().to_string();
            assert!(!n.ends_with(".novelist-tmp"), "temp leaked: {n}");
        }
    }

    #[tokio::test]
    async fn store_cover_asset_rejects_invalid_bytes() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let err = store_cover_asset(project, b"not an image".to_vec(), Some("image/png"))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));

        // No assets directory should be created for a rejected payload.
        // (We tolerate the directory existing empty because
        // create_dir_all runs before detection in some flows — the
        // detection runs first here, so it must NOT exist.)
        assert!(
            !project.join(".novelist").join("publish-assets").exists(),
            "assets dir must not be created for rejected payloads"
        );
    }

    #[tokio::test]
    async fn store_cover_asset_rejects_mismatched_declared_mime() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        // PNG bytes labelled as JPEG.
        let err = store_cover_asset(project, png_signature_bytes(), Some("image/jpeg"))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(!project.join(".novelist").join("publish-assets").exists());
    }

    #[tokio::test]
    async fn store_cover_asset_rejects_oversize_payload() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let mut bytes = png_signature_bytes();
        bytes.resize(MAX_COVER_BYTES + 1, 0);
        let err = store_cover_asset(project, bytes, Some("image/png"))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn store_cover_asset_supports_all_formats() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        for (bytes, mime, ext) in [
            (png_signature_bytes(), "image/png", "png"),
            (jpeg_signature_bytes(), "image/jpeg", "jpg"),
            (gif_signature_bytes(), "image/gif", "gif"),
            (webp_signature_bytes(), "image/webp", "webp"),
        ] {
            let cover = store_cover_asset(project, bytes, Some(mime)).await.unwrap();
            assert_eq!(cover.mime, mime);
            assert_eq!(cover.extension, ext);
        }
    }

    #[tokio::test]
    async fn load_cover_bytes_returns_none_for_missing_asset() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let phantom = CoverRef {
            content_hash: "0".repeat(64),
            extension: "png".into(),
            mime: "image/png".into(),
            bytes: 8,
        };
        let out = load_cover_bytes(project, &phantom).await.unwrap();
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn load_cover_bytes_round_trips() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let bytes = png_signature_bytes();
        let cover = store_cover_asset(project, bytes.clone(), Some("image/png"))
            .await
            .unwrap();
        let back = load_cover_bytes(project, &cover).await.unwrap().unwrap();
        assert_eq!(back, bytes);
    }

    #[tokio::test]
    async fn load_cover_bytes_rejects_untrusted_hash() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let bogus = CoverRef {
            // Path traversal attempt disguised as a hex hash.
            content_hash: "../../../etc/passwd".into(),
            extension: "png".into(),
            mime: "image/png".into(),
            bytes: 0,
        };
        let err = load_cover_bytes(project, &bogus).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn load_cover_bytes_flags_disk_corruption() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let cover = store_cover_asset(project, png_signature_bytes(), Some("image/png"))
            .await
            .unwrap();
        let path = asset_path(project, &cover).unwrap();
        let original_len = cover.bytes as usize;
        let mut corrupted = vec![0u8; original_len];
        corrupted[0] = 0x89;
        tokio::fs::write(&path, &corrupted).await.unwrap();
        let err = load_cover_bytes(project, &cover).await.unwrap_err();
        assert!(
            err.to_string().contains("content-hash mismatch"),
            "same-length corrupt bytes must trigger a hash-mismatch error, got: {err}"
        );
    }

    #[test]
    fn parse_asset_file_name_accepts_valid_shape() {
        let name = format!("{}.png", "a".repeat(64));
        let (hash, ext) = parse_asset_file_name(&name).unwrap();
        assert_eq!(hash.len(), 64);
        assert_eq!(ext, "png");
    }

    #[test]
    fn parse_asset_file_name_rejects_bad_shapes() {
        assert!(parse_asset_file_name("random.txt").is_none());
        assert!(parse_asset_file_name("hello.png").is_none());
        assert!(parse_asset_file_name(&format!("{}.pngbogus", "a".repeat(64))).is_none());
        assert!(parse_asset_file_name(&format!("{}.exe", "a".repeat(64))).is_none());
    }

    fn valid_ref() -> CoverRef {
        let bytes = png_signature_bytes();
        CoverRef {
            content_hash: blake3::hash(&bytes).to_hex().to_string(),
            extension: "png".into(),
            mime: "image/png".into(),
            bytes: bytes.len() as u64,
        }
    }

    #[test]
    fn cover_ref_validate_accepts_lowercase_and_uppercase_hex() {
        let mut c = valid_ref();
        c.content_hash = c.content_hash.to_ascii_uppercase();
        c.validate().unwrap();
    }

    #[test]
    fn cover_ref_validate_rejects_wrong_length_hash() {
        let mut c = valid_ref();
        c.content_hash = "abcd".into();
        let err = c.validate().unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn cover_ref_validate_rejects_non_hex_hash() {
        let mut c = valid_ref();
        c.content_hash = "z".repeat(64);
        let err = c.validate().unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn cover_ref_validate_rejects_path_traversal_hash() {
        let mut c = valid_ref();
        c.content_hash = "../../../../etc/passwd".into();
        let err = c.validate().unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn cover_ref_validate_rejects_unsupported_extension() {
        let mut c = valid_ref();
        c.extension = "svg".into();
        let err = c.validate().unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn cover_ref_validate_rejects_mime_extension_mismatch() {
        let mut c = valid_ref();
        c.mime = "image/jpeg".into();
        let err = c.validate().unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn cover_ref_validate_rejects_non_canonical_mime_alias() {
        let mut c = valid_ref();
        c.mime = "image/jpg".into();
        c.extension = "jpg".into();
        let err = c.validate().unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn cover_ref_validate_rejects_zero_bytes() {
        let mut c = valid_ref();
        c.bytes = 0;
        let err = c.validate().unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn cover_ref_validate_rejects_bytes_over_max() {
        let mut c = valid_ref();
        c.bytes = MAX_COVER_BYTES as u64 + 1;
        let err = c.validate().unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[test]
    fn asset_path_rejects_invalid_cover_ref() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let bogus = CoverRef {
            content_hash: "../../secret".into(),
            extension: "png".into(),
            mime: "image/png".into(),
            bytes: 8,
        };
        let err = asset_path(project, &bogus).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn load_cover_bytes_rejects_length_mismatch_before_hash_check() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let cover = store_cover_asset(project, png_signature_bytes(), Some("image/png"))
            .await
            .unwrap();
        let path = asset_path(project, &cover).unwrap();
        let mut truncated = tokio::fs::read(&path).await.unwrap();
        truncated.pop();
        tokio::fs::write(&path, &truncated).await.unwrap();

        let err = load_cover_bytes(project, &cover).await.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("length mismatch"),
            "length check should fire before hash check, got: {msg}"
        );
    }

    #[tokio::test]
    async fn load_cover_bytes_rejects_mime_mismatch_between_declared_and_detected() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let jpeg = jpeg_signature_bytes();
        let mut same_length_jpeg = jpeg.clone();
        let png_ref = store_cover_asset(project, png_signature_bytes(), Some("image/png"))
            .await
            .unwrap();
        same_length_jpeg.resize(png_ref.bytes as usize, 0xFF);

        let mismatched = CoverRef {
            content_hash: blake3::hash(&same_length_jpeg).to_hex().to_string(),
            extension: png_ref.extension.clone(),
            mime: png_ref.mime.clone(),
            bytes: png_ref.bytes,
        };
        let target_path = asset_path(project, &mismatched).unwrap();
        tokio::fs::write(&target_path, &same_length_jpeg)
            .await
            .unwrap();

        let err = load_cover_bytes(project, &mismatched).await.unwrap_err();
        assert!(
            err.to_string().contains("MIME mismatch"),
            "expected MIME mismatch, got: {err}"
        );
    }

    #[tokio::test]
    async fn load_cover_bytes_rejects_extension_mismatch() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let png_bytes_local = png_signature_bytes();
        let hash = blake3::hash(&png_bytes_local).to_hex().to_string();
        let cover_gif_ext = CoverRef {
            content_hash: hash.clone(),
            extension: "gif".into(),
            mime: "image/gif".into(),
            bytes: png_bytes_local.len() as u64,
        };
        let target_path = asset_path(project, &cover_gif_ext).unwrap();
        tokio::fs::create_dir_all(target_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&target_path, &png_bytes_local)
            .await
            .unwrap();

        let err = load_cover_bytes(project, &cover_gif_ext).await.unwrap_err();
        assert!(
            err.to_string().contains("MIME mismatch")
                || err.to_string().contains("extension mismatch"),
            "expected MIME/extension mismatch, got: {err}"
        );
    }

    #[tokio::test]
    async fn uppercase_hash_ref_resolves_to_canonical_lowercase_file_name() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let bytes = png_signature_bytes();
        let lower = store_cover_asset(project, bytes.clone(), Some("image/png"))
            .await
            .unwrap();
        assert_eq!(lower.content_hash, lower.content_hash.to_ascii_lowercase());

        let upper = CoverRef {
            content_hash: lower.content_hash.to_ascii_uppercase(),
            ..lower.clone()
        };
        assert_eq!(upper.file_name(), lower.file_name());
        let resolved_path = asset_path(project, &upper).unwrap();
        let canonical_path = asset_path(project, &lower).unwrap();
        assert_eq!(resolved_path, canonical_path);
        assert!(resolved_path.exists());

        let loaded = load_cover_bytes(project, &upper).await.unwrap().unwrap();
        assert_eq!(loaded, bytes);
    }

    #[tokio::test]
    async fn store_cover_asset_propagates_non_notfound_read_error() {
        let dir = TempDir::new().unwrap();
        let project = dir.path();
        let bytes = png_signature_bytes();
        let hash = blake3::hash(&bytes).to_hex().to_string();
        let assets = assets_dir(project);
        tokio::fs::create_dir_all(&assets).await.unwrap();
        let target = assets.join(format!("{hash}.png"));
        tokio::fs::create_dir(&target).await.unwrap();

        let err = store_cover_asset(project, bytes, Some("image/png"))
            .await
            .unwrap_err();
        assert!(
            matches!(err, AppError::Io(_)),
            "non-NotFound read error must propagate, got: {err}"
        );
        assert!(
            target.is_dir(),
            "existing directory must not be silently overwritten"
        );
    }
}
