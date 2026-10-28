//! User-data roots.
//!
//! Desktop standard mode (no `portable.dat` next to exe): user data lives under
//! `~/.novelist/`. Desktop portable mode (marker file present): user data lives
//! under `<exe_dir>/data/`, the updater plugin is skipped, and the UI shows a
//! banner so the user knows where their data is.
//!
//! iOS / Android: sandbox paths need an `AppHandle`, so [`init_mobile`] runs
//! first in `setup`. Settings, credentials, plugin data, snapshots and sync
//! state live in the private app data directory. Projects live in a separate
//! project library: `Documents/Projects` on iOS (the only folder the Files app
//! shows) and `<app data>/Projects` on Android. iOS moves the app container on
//! updates, so anything persisted about a library project is keyed by its
//! library-relative path ([`project_storage_key`]), never by absolute path.

use crate::error::AppError;
use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug)]
pub struct PortableConfig {
    pub enabled: bool,
    pub data_root: PathBuf,
}

/// Folder name of the mobile project library.
#[cfg(any(mobile, test))]
const LIBRARY_DIR_NAME: &str = "Projects";

/// Prefix of a persisted library-relative project reference.
const LIBRARY_KEY_PREFIX: &str = "library:";

static CONFIG: OnceLock<PortableConfig> = OnceLock::new();
static LIBRARY: OnceLock<LibraryLayout> = OnceLock::new();

/// Test seam for storage keys and library path spelling only: unit tests
/// never run `init_mobile`. Paths outside the test library are unchanged, so
/// unrelated concurrent tests are unaffected.
#[cfg(test)]
static TEST_LIBRARY: std::sync::Mutex<Option<std::sync::Arc<LibraryLayout>>> =
    std::sync::Mutex::new(None);

#[cfg(test)]
pub(crate) fn set_test_library(layout: Option<LibraryLayout>) {
    *TEST_LIBRARY
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = layout.map(std::sync::Arc::new);
}

fn with_library<R>(use_layout: impl FnOnce(Option<&LibraryLayout>) -> R) -> R {
    #[cfg(test)]
    {
        let installed = TEST_LIBRARY
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(layout) = installed {
            return use_layout(Some(&layout));
        }
    }
    use_layout(LIBRARY.get())
}

/// Mobile project library and disposable-file roots.
#[derive(Debug)]
pub struct LibraryLayout {
    library_root: PathBuf,
    /// Symlink-resolved spelling of `library_root`: iOS reports the same
    /// container as both `/var/…` and `/private/var/…`.
    canonical_library_root: PathBuf,
    cache_root: PathBuf,
}

impl LibraryLayout {
    /// Creates and probes both roots. Errors name the failing directory;
    /// nothing falls back to another location.
    #[cfg(any(mobile, test))]
    pub(crate) fn prepare(library_root: PathBuf, cache_root: PathBuf) -> Result<Self, AppError> {
        ensure_writable_dir("project library", &library_root)?;
        ensure_writable_dir("app cache", &cache_root)?;
        let canonical_library_root = std::fs::canonicalize(&library_root)
            .map_err(|error| dir_error("project library", &library_root, error))?;
        Ok(Self {
            library_root,
            canonical_library_root,
            cache_root,
        })
    }

    pub fn library_root(&self) -> &Path {
        &self.library_root
    }

    /// Symlink-resolved library root, for containment checks against
    /// canonicalized paths.
    pub fn canonical_library_root(&self) -> &Path {
        &self.canonical_library_root
    }

    pub fn cache_root(&self) -> &Path {
        &self.cache_root
    }

    /// Path of `path` relative to the library root, when `path` names an
    /// entry strictly inside the library. Both root spellings captured at
    /// init match lexically, so a folder that was just renamed away (a
    /// published staging folder) keeps its key; only other spellings need
    /// the entry to exist.
    fn relative_path(&self, path: &Path) -> Option<PathBuf> {
        let relative = match path
            .strip_prefix(&self.library_root)
            .or_else(|_| path.strip_prefix(&self.canonical_library_root))
        {
            Ok(relative) => relative.to_path_buf(),
            Err(_) => std::fs::canonicalize(path)
                .ok()?
                .strip_prefix(&self.canonical_library_root)
                .ok()?
                .to_path_buf(),
        };
        let mut components = relative.components().peekable();
        (components.peek().is_some()
            && components.all(|component| matches!(component, Component::Normal(_))))
        .then_some(relative)
    }

    /// `library:<relative/path>` for a project inside the library; any other
    /// path is returned unchanged.
    pub fn storage_key<'a>(&self, project_dir: &'a str) -> Cow<'a, str> {
        let Some(relative) = self.relative_path(Path::new(project_dir)) else {
            return Cow::Borrowed(project_dir);
        };
        let mut key = String::from(LIBRARY_KEY_PREFIX);
        for (index, component) in relative.components().enumerate() {
            let Some(name) = component.as_os_str().to_str() else {
                return Cow::Borrowed(project_dir);
            };
            if index > 0 {
                key.push('/');
            }
            key.push_str(name);
        }
        Cow::Owned(key)
    }

    /// Inverse of [`Self::storage_key`] against the current library root.
    /// Anything that is not a well-formed library reference is returned as is.
    pub fn resolve<'a>(&self, key: &'a str) -> Cow<'a, str> {
        let Some(relative) = key.strip_prefix(LIBRARY_KEY_PREFIX) else {
            return Cow::Borrowed(key);
        };
        if !relative
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && !part.contains('\0'))
        {
            return Cow::Borrowed(key);
        }
        let mut path = self.library_root.clone();
        path.extend(relative.split('/'));
        Cow::Owned(path.to_string_lossy().into_owned())
    }

    /// `path` spelled under the configured library root (what
    /// `get_library_path` reports), whichever root spelling the caller used.
    /// Paths outside the library are returned unchanged.
    pub fn configured_path<'a>(&self, path: &'a str) -> Cow<'a, str> {
        match self.storage_key(path) {
            Cow::Borrowed(unchanged) => Cow::Borrowed(unchanged),
            Cow::Owned(key) => Cow::Owned(self.resolve(&key).into_owned()),
        }
    }
}

/// Initialize desktop data-root detection. Must be called once at startup
/// before any path-using code. Panics on portable mode if the data directory
/// cannot be created or is not writable — we never silently fall back to
/// APPDATA.
#[cfg(desktop)]
pub fn init() {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let cfg = detect_with_exe_dir(&exe_dir);
    CONFIG
        .set(cfg)
        .expect("portable::init() called more than once");
}

/// Initialize the iOS / Android data root, project library and cache root.
/// Must run first in `setup`, before any path-using code.
#[cfg(mobile)]
pub fn init_mobile(app: &tauri::AppHandle) -> Result<(), AppError> {
    use tauri::Manager;
    let paths = app.path();
    let data_root = paths
        .app_data_dir()
        .map_err(|error| unresolved_dir("app data", error))?;
    let cache_root = paths
        .app_cache_dir()
        .map_err(|error| unresolved_dir("app cache", error))?;
    #[cfg(target_os = "ios")]
    let library_root = paths
        .document_dir()
        .map_err(|error| unresolved_dir("Documents", error))?
        .join(LIBRARY_DIR_NAME);
    #[cfg(not(target_os = "ios"))]
    let library_root = data_root.join(LIBRARY_DIR_NAME);

    ensure_writable_dir("app data", &data_root)?;
    let layout = LibraryLayout::prepare(library_root, cache_root)?;
    CONFIG
        .set(PortableConfig {
            enabled: false,
            data_root,
        })
        .map_err(|_| AppError::Custom("portable::init_mobile() called more than once".into()))?;
    LIBRARY
        .set(layout)
        .map_err(|_| AppError::Custom("portable::init_mobile() called more than once".into()))
}

#[cfg(mobile)]
fn unresolved_dir(role: &str, error: tauri::Error) -> AppError {
    AppError::Custom(format!("Cannot resolve the {role} directory: {error}"))
}

#[cfg(any(mobile, test))]
fn ensure_writable_dir(role: &str, dir: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dir).map_err(|error| dir_error(role, dir, error))?;
    // The probe deletes itself on drop.
    tempfile::NamedTempFile::new_in(dir)
        .map(drop)
        .map_err(|error| dir_error(role, dir, error))
}

#[cfg(any(mobile, test))]
fn dir_error(role: &str, dir: &Path, error: std::io::Error) -> AppError {
    AppError::Custom(format!(
        "Cannot use the {role} directory {}: {error}",
        dir.display()
    ))
}

/// Test seam: detect using a caller-provided exe directory.
#[cfg(desktop)]
pub fn detect_with_exe_dir(exe_dir: &Path) -> PortableConfig {
    let marker = exe_dir.join("portable.dat");
    if !marker.exists() {
        return PortableConfig {
            enabled: false,
            data_root: dirs::home_dir()
                .expect("Cannot determine home directory for Novelist user data")
                .join(".novelist"),
        };
    }

    let data_root = exe_dir.join("data");
    std::fs::create_dir_all(&data_root).unwrap_or_else(|e| {
        panic!(
            "Portable mode: cannot create data directory at {}: {}. \
             Move Novelist out of Program Files or any read-only location.",
            data_root.display(),
            e
        )
    });

    match tempfile::NamedTempFile::new_in(&data_root) {
        Ok(probe) => {
            // probe auto-deletes on drop
            drop(probe);
        }
        Err(e) => panic!(
            "Portable mode: data directory at {} is not writable: {}. \
             Move Novelist out of Program Files or any read-only location.",
            data_root.display(),
            e
        ),
    }

    PortableConfig {
        enabled: true,
        data_root,
    }
}

pub fn config() -> &'static PortableConfig {
    CONFIG
        .get()
        .expect("portable::init() must be called before config()")
}

/// App data root: settings, credentials, plugin data, snapshots, sync state.
pub fn novelist_home() -> &'static Path {
    &config().data_root
}

pub fn is_portable() -> bool {
    config().enabled
}

/// The mobile project library. Desktop opens arbitrary folders and has none.
pub fn library() -> Result<&'static LibraryLayout, AppError> {
    LIBRARY
        .get()
        .ok_or(AppError::Unsupported("The in-app project library"))
}

pub fn library_root() -> Result<&'static Path, AppError> {
    Ok(library()?.library_root())
}

/// Root for disposable files (scratch files, staged imports, share exports):
/// the app cache directory on mobile, `<OS cache dir>/novelist` on desktop.
pub fn cache_root() -> Result<PathBuf, AppError> {
    if let Some(layout) = LIBRARY.get() {
        return Ok(layout.cache_root.clone());
    }
    if cfg!(mobile) {
        return Err(AppError::Custom(
            "The app cache directory is used before portable::init_mobile()".into(),
        ));
    }
    dirs::cache_dir()
        .map(|dir| dir.join("novelist"))
        .ok_or_else(|| AppError::Custom("Cannot determine cache directory".into()))
}

/// Key for per-project app data (snapshots, sync config and baselines,
/// writing stats) and persisted project references.
/// Desktop: the project path unchanged, so existing data keeps its location.
/// Mobile: `library:<relative path>` for library projects, which survives
/// app-container relocation.
pub fn project_storage_key(project_dir: &str) -> Cow<'_, str> {
    with_library(|layout| match layout {
        Some(layout) => layout.storage_key(project_dir),
        None => Cow::Borrowed(project_dir),
    })
}

/// Library project path spelled under the configured library root, as the
/// frontend sees it from `get_library_path`. Desktop: unchanged.
pub fn configured_project_path(project_dir: &str) -> Cow<'_, str> {
    with_library(|layout| match layout {
        Some(layout) => layout.configured_path(project_dir),
        None => Cow::Borrowed(project_dir),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[cfg(desktop)]
    #[test]
    fn detect_no_marker_uses_home_dir() {
        let tmp = TempDir::new().unwrap();
        let cfg = detect_with_exe_dir(tmp.path());
        assert!(!cfg.enabled);
        let expected = dirs::home_dir().unwrap().join(".novelist");
        assert_eq!(cfg.data_root, expected);
    }

    #[cfg(desktop)]
    #[test]
    fn detect_with_marker_writable_creates_data_dir() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("portable.dat"), b"").unwrap();
        let cfg = detect_with_exe_dir(tmp.path());
        assert!(cfg.enabled);
        assert_eq!(cfg.data_root, tmp.path().join("data"));
        assert!(cfg.data_root.is_dir());
    }

    #[cfg(all(desktop, unix))]
    #[test]
    fn detect_with_marker_readonly_panics() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("portable.dat"), b"").unwrap();
        // Make the temp dir read-only so create_dir_all OR write fails.
        let mut perms = std::fs::metadata(tmp.path()).unwrap().permissions();
        perms.set_mode(0o555);
        std::fs::set_permissions(tmp.path(), perms.clone()).unwrap();

        let result = std::panic::catch_unwind(|| detect_with_exe_dir(tmp.path()));

        // Restore so TempDir can clean up.
        let mut restore = perms.clone();
        restore.set_mode(0o755);
        let _ = std::fs::set_permissions(tmp.path(), restore);

        assert!(result.is_err(), "expected panic on read-only directory");
    }

    fn container(tmp: &TempDir, id: &str) -> LibraryLayout {
        let root = tmp.path().join(id);
        LibraryLayout::prepare(
            root.join("Documents").join(LIBRARY_DIR_NAME),
            root.join("Library/Caches/com.novelist.app"),
        )
        .unwrap()
    }

    #[test]
    fn mobile_roots_are_created_on_first_launch() {
        let tmp = TempDir::new().unwrap();
        let layout = container(&tmp, "A");
        assert!(layout.library_root().is_dir());
        assert!(layout.cache_root().is_dir());
        // The writability probe leaves nothing behind in the Files-visible library.
        assert_eq!(std::fs::read_dir(layout.library_root()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn unwritable_mobile_root_is_an_error_naming_the_directory() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new().unwrap();
        let locked = tmp.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();

        let result =
            LibraryLayout::prepare(locked.join(LIBRARY_DIR_NAME), tmp.path().join("cache"));

        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = result.unwrap_err().to_string();
        assert!(error.contains("project library"), "{error}");
        assert!(error.contains(&locked.display().to_string()), "{error}");
    }

    #[test]
    fn library_keys_survive_container_relocation() {
        let tmp = TempDir::new().unwrap();
        let before = container(&tmp, "8F1C-old");
        let after = container(&tmp, "D27A-new");
        for relative in ["我的小说", "系列/第一卷"] {
            let old_path = before.library_root().join(relative);
            let key = before.storage_key(old_path.to_str().unwrap()).into_owned();
            assert_eq!(key, format!("library:{relative}"));
            assert!(!key.contains(tmp.path().to_str().unwrap()));

            let new_path = after.library_root().join(relative);
            assert_eq!(after.resolve(&key), new_path.to_string_lossy());
            assert_eq!(after.storage_key(new_path.to_str().unwrap()), key);
        }
    }

    #[test]
    fn non_library_paths_and_malformed_keys_are_left_alone() {
        let tmp = TempDir::new().unwrap();
        let layout = container(&tmp, "A");
        let root = layout.library_root().to_string_lossy().into_owned();
        let outside = tmp.path().join("elsewhere").to_string_lossy().into_owned();
        let escaping = format!("{root}/../../escape");
        for path in [root.as_str(), outside.as_str(), escaping.as_str()] {
            assert!(
                matches!(layout.storage_key(path), Cow::Borrowed(_)),
                "{path}"
            );
        }
        for key in [
            "library:",
            "library:../x",
            "library:a//b",
            "library:./a",
            "/abs/path",
        ] {
            assert_eq!(layout.resolve(key), key);
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_spelling_of_the_container_maps_to_the_same_key() {
        let tmp = TempDir::new().unwrap();
        let layout = container(&tmp, "real");
        std::fs::create_dir(layout.library_root().join("书")).unwrap();
        // iOS reports `/var/mobile/…` for the `/private/var/mobile/…` container.
        let alias = tmp.path().join("alias");
        std::os::unix::fs::symlink(tmp.path().join("real"), &alias).unwrap();
        let aliased = alias.join("Documents").join(LIBRARY_DIR_NAME).join("书");
        assert_eq!(layout.storage_key(aliased.to_str().unwrap()), "library:书");
    }

    /// Resets the process-wide test library even when an assertion fails.
    struct TestLibrary;

    impl TestLibrary {
        fn install(layout: LibraryLayout) -> Self {
            set_test_library(Some(layout));
            Self
        }
    }

    impl Drop for TestLibrary {
        fn drop(&mut self) {
            set_test_library(None);
        }
    }

    #[cfg(unix)]
    #[test]
    #[serial_test::serial(sync_data_dir)]
    fn keys_of_renamed_away_folders_do_not_depend_on_root_spelling() {
        let tmp = TempDir::new().unwrap();
        let real = tmp.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let alias = tmp.path().join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        // Configured through a symlinked spelling, as the OS may report it.
        let layout =
            LibraryLayout::prepare(alias.join(LIBRARY_DIR_NAME), tmp.path().join("cache")).unwrap();
        let configured = layout.library_root().to_path_buf();
        let canonical = layout.canonical_library_root().to_path_buf();
        assert_ne!(canonical, configured);
        let _library = TestLibrary::install(layout);

        // A caller that canonicalized the parent stages, keys, then publishes.
        let staged = canonical.join(".novelist-import-abc");
        std::fs::create_dir(&staged).unwrap();
        let before = project_storage_key(staged.to_str().unwrap()).into_owned();
        assert_eq!(before, "library:.novelist-import-abc");
        std::fs::rename(&staged, canonical.join("长夜")).unwrap();

        let configured_spelling = configured.join(".novelist-import-abc");
        for vanished in [&staged, &configured_spelling] {
            assert_eq!(project_storage_key(vanished.to_str().unwrap()), before);
        }
        for published in [canonical.join("长夜"), configured.join("长夜")] {
            assert_eq!(
                project_storage_key(published.to_str().unwrap()),
                "library:长夜"
            );
        }
    }
}
