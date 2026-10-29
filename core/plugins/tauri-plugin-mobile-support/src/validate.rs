//! Argument validation performed in Rust before anything reaches native code.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::{Error, Result, MAX_ACCOUNT_BYTES, MAX_SECRET_BYTES, MAX_SERVICE_BYTES};

/// Longest accepted MIME type (`type/subtype`, RFC 6838 limits each part to 127).
const MAX_MIME_BYTES: usize = 255;

/// Resolves `requested` to the canonical path of a regular file strictly
/// inside `staging_root`.
///
/// Rejected: relative paths, any `..` component, paths not spelled under the
/// staging root, a symlink as the final component, anything whose canonical
/// form (intermediate symlinks resolved) leaves the root, and on Unix files
/// with more than one hard link (a hard link could alias a private file).
pub(crate) fn resolve_staged_file(staging_root: &Path, requested: &Path) -> Result<PathBuf> {
    if !requested.is_absolute()
        || requested
            .components()
            .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(Error::PathNotAllowed);
    }
    let root = staging_root
        .canonicalize()
        .map_err(|_| Error::PathNotAllowed)?;
    // Accept the configured spelling and the canonical one (iOS `/var` vs
    // `/private/var`); everything else is rejected before touching the disk.
    if !requested.starts_with(staging_root) && !requested.starts_with(&root) {
        return Err(Error::PathNotAllowed);
    }

    let meta = fs::symlink_metadata(requested).map_err(|_| Error::FileUnavailable)?;
    if meta.file_type().is_symlink() {
        return Err(Error::PathNotAllowed);
    }
    if !meta.is_file() {
        return Err(Error::FileUnavailable);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err(Error::PathNotAllowed);
        }
    }

    let canonical = requested
        .canonicalize()
        .map_err(|_| Error::FileUnavailable)?;
    if !canonical.starts_with(&root) {
        return Err(Error::PathNotAllowed);
    }
    Ok(canonical)
}

/// Validates a bare `type/subtype` MIME type (RFC 6838 restricted names, no
/// parameters or wildcards) and returns it lowercased.
pub(crate) fn normalize_mime(mime: &str) -> Result<String> {
    fn restricted_name(part: &str) -> bool {
        let bytes = part.as_bytes();
        !bytes.is_empty()
            && bytes.len() <= 127
            && bytes[0].is_ascii_alphanumeric()
            && bytes
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(b))
    }

    let invalid = Error::InvalidArgument("mime type");
    if mime.len() > MAX_MIME_BYTES {
        return Err(invalid);
    }
    match mime.split_once('/') {
        Some((ty, sub)) if restricted_name(ty) && restricted_name(sub) => {
            Ok(mime.to_ascii_lowercase())
        }
        _ => Err(invalid),
    }
}

/// Validates the vault namespace pair. Names are bounded and free of control
/// characters; the error names the field, never its value.
pub(crate) fn validate_credential_key(service: &str, account: &str) -> Result<()> {
    fn valid(value: &str, max: usize) -> bool {
        !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
    }

    if !valid(service, MAX_SERVICE_BYTES) {
        return Err(Error::InvalidArgument("credential service"));
    }
    if !valid(account, MAX_ACCOUNT_BYTES) {
        return Err(Error::InvalidArgument("credential account"));
    }
    Ok(())
}

/// Secrets are non-empty (use delete instead) and bounded.
pub(crate) fn validate_secret(secret: &str) -> Result<()> {
    if secret.is_empty() || secret.len() > MAX_SECRET_BYTES {
        return Err(Error::InvalidArgument("credential secret"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Self-cleaning temp dir; avoids a dev-dependency.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "mobile-support-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// `<tmp>/exports` staging root plus a private sibling `<tmp>/private/secret.txt`.
    fn layout() -> (TempDir, PathBuf, PathBuf) {
        let tmp = TempDir::new();
        let root = tmp.0.join("exports");
        let private = tmp.0.join("private");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&private).unwrap();
        let secret = private.join("secret.txt");
        fs::write(&secret, "private").unwrap();
        (tmp, root, secret)
    }

    fn rejected(root: &Path, requested: &Path) -> bool {
        matches!(
            resolve_staged_file(root, requested),
            Err(Error::PathNotAllowed)
        )
    }

    #[test]
    fn accepts_regular_file_in_root_and_nested_dirs() {
        let (_tmp, root, _) = layout();
        let file = root.join("book.epub");
        fs::write(&file, "x").unwrap();
        let nested = root.join("job-1").join("chapter.md");
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::write(&nested, "x").unwrap();

        assert_eq!(
            resolve_staged_file(&root, &file).unwrap(),
            file.canonicalize().unwrap()
        );
        assert_eq!(
            resolve_staged_file(&root, &nested).unwrap(),
            nested.canonicalize().unwrap()
        );
    }

    #[test]
    fn accepts_canonical_spelling_of_root() {
        let (_tmp, root, _) = layout();
        let file = root.join("a.txt");
        fs::write(&file, "x").unwrap();
        let canonical = root.canonicalize().unwrap().join("a.txt");
        assert!(resolve_staged_file(&root, &canonical).is_ok());
    }

    #[test]
    fn rejects_parent_dir_traversal_even_when_target_exists() {
        let (_tmp, root, secret) = layout();
        let escape = root.join("..").join("private").join("secret.txt");
        assert!(escape.exists());
        assert!(rejected(&root, &escape));
        // `..` that would land back inside the root is still refused.
        fs::write(root.join("a.txt"), "x").unwrap();
        assert!(rejected(&root, &root.join("sub").join("..").join("a.txt")));
        assert!(rejected(&root, &secret));
    }

    #[test]
    fn rejects_relative_paths_and_sibling_prefix_dirs() {
        let (tmp, root, _) = layout();
        assert!(rejected(&root, Path::new("exports/a.txt")));
        // `exports-evil` shares a string prefix but is a different directory.
        let sibling = tmp.0.join("exports-evil");
        fs::create_dir_all(&sibling).unwrap();
        let file = sibling.join("a.txt");
        fs::write(&file, "x").unwrap();
        assert!(rejected(&root, &file));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_file_escape() {
        let (_tmp, root, secret) = layout();
        let link = root.join("innocent.txt");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        assert!(rejected(&root, &link));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_file_even_when_target_is_inside_root() {
        let (_tmp, root, _) = layout();
        let real = root.join("real.txt");
        fs::write(&real, "x").unwrap();
        let link = root.join("alias.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(rejected(&root, &link));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_directory_escape() {
        let (_tmp, root, secret) = layout();
        let link_dir = root.join("dir");
        std::os::unix::fs::symlink(secret.parent().unwrap(), &link_dir).unwrap();
        assert!(rejected(&root, &link_dir.join("secret.txt")));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_hard_link_alias_of_private_file() {
        let (_tmp, root, secret) = layout();
        let alias = root.join("alias.txt");
        fs::hard_link(&secret, &alias).unwrap();
        assert!(rejected(&root, &alias));
    }

    #[test]
    fn missing_file_and_directories_are_unavailable() {
        let (_tmp, root, _) = layout();
        let dir = root.join("folder");
        fs::create_dir_all(&dir).unwrap();
        for path in [root.join("missing.txt"), dir, root.clone()] {
            assert!(matches!(
                resolve_staged_file(&root, &path),
                Err(Error::FileUnavailable)
            ));
        }
    }

    #[test]
    fn missing_staging_root_rejects_everything() {
        let tmp = TempDir::new();
        let root = tmp.0.join("exports");
        assert!(rejected(&root, &root.join("a.txt")));
    }

    #[test]
    fn mime_types_are_bounded_and_normalized() {
        assert_eq!(
            normalize_mime("Application/EPUB+zip").unwrap(),
            "application/epub+zip"
        );
        assert_eq!(normalize_mime("text/markdown").unwrap(), "text/markdown");
        for bad in [
            "",
            "text",
            "text/",
            "/plain",
            "*/*",
            "text/*",
            "text/plain; charset=utf-8",
            "text/plain/extra",
            "text/pla in",
            "text/plain\n",
            ".text/plain",
        ] {
            assert!(normalize_mime(bad).is_err(), "accepted {bad:?}");
        }
        assert!(normalize_mime(&format!("application/{}", "x".repeat(128))).is_err());
    }

    #[test]
    fn credential_names_and_secrets_are_bounded() {
        assert!(validate_credential_key("cloud-account", "alice@example.com").is_ok());
        assert!(validate_credential_key("", "a").is_err());
        assert!(validate_credential_key("s", "").is_err());
        assert!(validate_credential_key(&"s".repeat(MAX_SERVICE_BYTES + 1), "a").is_err());
        assert!(validate_credential_key("s", &"a".repeat(MAX_ACCOUNT_BYTES + 1)).is_err());
        assert!(validate_credential_key("s\0x", "a").is_err());
        assert!(validate_secret("").is_err());
        assert!(validate_secret(&"k".repeat(MAX_SECRET_BYTES)).is_ok());
        assert!(validate_secret(&"k".repeat(MAX_SECRET_BYTES + 1)).is_err());
    }

    #[test]
    fn validation_errors_never_echo_values() {
        let err = validate_secret(&"hunter2".repeat(2000)).unwrap_err();
        assert!(!err.to_string().contains("hunter2"));
        let err = validate_credential_key("svc\u{7}hunter2", "a").unwrap_err();
        assert!(!err.to_string().contains("hunter2"));
    }
}
