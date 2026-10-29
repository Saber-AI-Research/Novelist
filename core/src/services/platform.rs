//! Platform capability table (D3 in
//! `docs/exec-plans/active/2026-10-28-mobile-platform.md`).
//!
//! The IPC command set is identical on every platform. Commands whose native
//! backing is missing return [`AppError::Unsupported`] instead of pretending to
//! succeed, and the frontend reads [`get_platform_capabilities`] once at startup
//! to choose its shell and hide what it cannot use. Phone versus tablet is a
//! viewport decision made by the frontend, not a capability.

use crate::commands::export::EXPORT_FORMATS;
use crate::commands::library::DOCUMENT_EXPORT_FORMATS;
use crate::error::AppError;
use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum PlatformOs {
    Macos,
    Windows,
    Linux,
    Ios,
    Android,
}

impl PlatformOs {
    /// The OS this binary was compiled for.
    pub const CURRENT: Self = if cfg!(target_os = "macos") {
        Self::Macos
    } else if cfg!(target_os = "windows") {
        Self::Windows
    } else if cfg!(target_os = "ios") {
        Self::Ios
    } else if cfg!(target_os = "android") {
        Self::Android
    } else {
        Self::Linux
    };

    pub const fn is_mobile(self) -> bool {
        matches!(self, Self::Ios | Self::Android)
    }

    /// iOS runs only the plugins bundled with the app: TestFlight review does
    /// not allow downloaded executable code. Android and desktop keep the
    /// marketplace and local plugin development.
    pub const fn plugin_install(self) -> bool {
        !matches!(self, Self::Ios)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct PlatformCapabilities {
    pub os: PlatformOs,
    pub is_mobile: bool,
    /// OS menu bar driven by `refresh_menu`.
    pub native_menu: bool,
    /// Additional `novelist-*` windows.
    pub multi_window: bool,
    /// Any folder can be opened as a project (mobile uses the project library).
    pub pick_directory: bool,
    /// Helper binaries such as Pandoc can be spawned.
    pub external_processes: bool,
    /// The updater plugin is registered (desktop, not portable).
    pub self_update: bool,
    pub cli_shim: bool,
    /// OS file-system events. Without it, `poll_external_changes` is the only
    /// external-change detector; open-file tracking works everywhere.
    pub file_watcher: bool,
    /// Third-party plugins can be installed, scaffolded and loaded.
    pub plugin_install: bool,
    /// Document export formats: Pandoc's `export_project` formats where
    /// helper binaries run (`external_processes`), otherwise the built-in
    /// `export_library_document` formats.
    pub export_formats: Vec<String>,
}

impl PlatformCapabilities {
    pub fn for_os(os: PlatformOs, portable: bool) -> Self {
        let desktop = !os.is_mobile();
        Self {
            os,
            is_mobile: os.is_mobile(),
            native_menu: desktop,
            multi_window: desktop,
            pick_directory: desktop,
            external_processes: desktop,
            // Portable builds never register the updater plugin (lib.rs).
            self_update: desktop && !portable,
            cli_shim: desktop,
            file_watcher: desktop,
            plugin_install: os.plugin_install(),
            export_formats: if desktop {
                &EXPORT_FORMATS[..]
            } else {
                &DOCUMENT_EXPORT_FORMATS[..]
            }
            .iter()
            .map(|format| format.to_string())
            .collect(),
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn get_platform_capabilities() -> PlatformCapabilities {
    PlatformCapabilities::for_os(
        PlatformOs::CURRENT,
        crate::services::portable::is_portable(),
    )
}

/// Reject `feature` where helper binaries cannot run (iOS forbids spawning;
/// Android ships none). Commands call this before any discovery or spawn.
pub fn require_external_processes(feature: &'static str) -> Result<(), AppError> {
    require(!PlatformOs::CURRENT.is_mobile(), feature)
}

/// Reject `feature` where it needs desktop OS integration (file manager,
/// installing a CLI shim onto `PATH`).
pub fn require_desktop(feature: &'static str) -> Result<(), AppError> {
    require(!PlatformOs::CURRENT.is_mobile(), feature)
}

fn require(available: bool, feature: &'static str) -> Result<(), AppError> {
    if available {
        Ok(())
    } else {
        Err(AppError::Unsupported(feature))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_capabilities_turn_off_desktop_integrations() {
        for os in [PlatformOs::Ios, PlatformOs::Android] {
            let caps = PlatformCapabilities::for_os(os, false);
            assert!(caps.is_mobile);
            assert!(!caps.native_menu);
            assert!(!caps.multi_window);
            assert!(!caps.pick_directory);
            assert!(!caps.external_processes);
            assert!(!caps.self_update);
            assert!(!caps.cli_shim);
            assert!(!caps.file_watcher);
            assert_eq!(caps.export_formats, ["markdown", "html"]);
        }
    }

    #[test]
    fn only_ios_is_restricted_to_bundled_plugins() {
        assert!(!PlatformCapabilities::for_os(PlatformOs::Ios, false).plugin_install);
        for os in [
            PlatformOs::Android,
            PlatformOs::Macos,
            PlatformOs::Windows,
            PlatformOs::Linux,
        ] {
            assert!(PlatformCapabilities::for_os(os, false).plugin_install);
        }
    }

    #[test]
    fn portable_desktop_reports_no_self_update() {
        let caps = PlatformCapabilities::for_os(PlatformOs::Windows, true);
        assert!(!caps.self_update);
        assert!(caps.external_processes);
        assert_eq!(caps.export_formats, ["html", "pdf", "docx", "epub"]);
    }

    #[test]
    fn capabilities_serialize_with_lowercase_os() {
        let json =
            serde_json::to_value(PlatformCapabilities::for_os(PlatformOs::Ios, false)).unwrap();
        assert_eq!(json["os"], "ios");
        assert_eq!(json["is_mobile"], true);
        assert_eq!(json["plugin_install"], false);
    }

    #[test]
    fn unavailable_feature_is_reported_as_unsupported() {
        let error = require(false, "Pandoc export").unwrap_err();
        assert!(matches!(error, AppError::Unsupported("Pandoc export")));
        assert!(require(true, "Pandoc export").is_ok());
    }
}
