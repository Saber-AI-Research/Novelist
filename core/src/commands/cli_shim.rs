//! Install the bundled `novelist` CLI shim onto the user's PATH.
//!
//! The shim itself ships as a bundle resource (`bundled-cli/novelist` on
//! macOS/Linux, `bundled-cli/novelist.cmd` on Windows). This module exposes
//! two commands:
//!
//!   * `cli_shim_status` — reports whether a `novelist` symlink already
//!     exists at the conventional install path and whether the running
//!     binary can write there.
//!   * `install_cli_shim` — creates the symlink (mac/Linux) or copies the
//!     `.cmd` to `%LOCALAPPDATA%\Novelist\bin\novelist.cmd` on Windows.
//!
//! macOS and Linux install to `/usr/local/bin/novelist`. Most user PATH
//! configurations include this directory; if the directory isn't writable
//! we surface the error so the frontend can ask the user to re-run via
//! `sudo` (we do not attempt to escalate ourselves).

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CliShimStatus {
    /// Where the shim would (or does) live on this platform.
    pub install_path: String,
    /// True if the file at `install_path` exists.
    pub installed: bool,
    /// True if `installed` AND it points at the bundled shim we ship now.
    pub up_to_date: bool,
    /// Path to the bundled shim — what would be linked/copied.
    pub source_path: String,
}

const CLI_SHIM_FEATURE: &str = "Command-line shim";

fn install_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA")
            .or_else(|_| std::env::var("APPDATA"))
            .unwrap_or_else(|_| "C:\\Users\\Public".into());
        PathBuf::from(local)
            .join("Novelist")
            .join("bin")
            .join("novelist.cmd")
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from("/usr/local/bin/novelist")
    }
}

fn shim_filename() -> &'static str {
    if cfg!(target_os = "windows") {
        "novelist.cmd"
    } else {
        "novelist"
    }
}

fn resolve_source(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::Custom(format!("could not locate resource dir: {e}")))?;
    let candidate = resource_dir.join("bundled-cli").join(shim_filename());
    if !candidate.exists() {
        return Err(AppError::FileNotFound(
            candidate.to_string_lossy().to_string(),
        ));
    }
    Ok(candidate)
}

#[tauri::command]
#[specta::specta]
pub async fn cli_shim_status(app: tauri::AppHandle) -> Result<CliShimStatus, AppError> {
    crate::services::platform::require_desktop(CLI_SHIM_FEATURE)?;
    let install = install_path();
    let source = resolve_source(&app)?;
    let installed = install.exists() || install.symlink_metadata().is_ok();

    // up_to_date = the link/file at install resolves to (or matches) source.
    let up_to_date = if installed {
        match std::fs::read_link(&install) {
            Ok(target) => {
                let target = if target.is_relative() {
                    install
                        .parent()
                        .map(|p| p.join(&target))
                        .unwrap_or(target.clone())
                } else {
                    target
                };
                paths_equal(&target, &source)
            }
            // Not a symlink (Windows .cmd copy) — compare contents.
            Err(_) => match (std::fs::read(&install), std::fs::read(&source)) {
                (Ok(a), Ok(b)) => a == b,
                _ => false,
            },
        }
    } else {
        false
    };

    Ok(CliShimStatus {
        install_path: install.to_string_lossy().to_string(),
        installed,
        up_to_date,
        source_path: source.to_string_lossy().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn install_cli_shim(app: tauri::AppHandle) -> Result<CliShimStatus, AppError> {
    crate::services::platform::require_desktop(CLI_SHIM_FEATURE)?;
    let install = install_path();
    let source = resolve_source(&app)?;

    if let Some(parent) = install.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::Custom(format!(
                "could not create install directory {}: {e}",
                parent.to_string_lossy()
            ))
        })?;
    }

    // Best-effort remove existing symlink/file before reinstalling.
    if install.symlink_metadata().is_ok() {
        let _ = std::fs::remove_file(&install);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(&source, &install).map_err(|e| {
            AppError::Custom(format!(
                "could not create symlink at {}: {e} — try running with sudo or pick a writable directory",
                install.to_string_lossy()
            ))
        })?;
    }

    #[cfg(windows)]
    {
        std::fs::copy(&source, &install).map_err(|e| {
            AppError::Custom(format!(
                "could not copy shim to {}: {e}",
                install.to_string_lossy()
            ))
        })?;
    }

    cli_shim_status(app).await
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    let ca = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let cb = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    ca == cb
}
