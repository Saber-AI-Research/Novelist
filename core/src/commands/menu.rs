//! Menu IPC commands.
//!
//! The menu is built in `crate::menu` with static accelerators but
//! dynamic labels and a dynamic Open Recent submenu. The frontend owns
//! the i18n store and the recent-projects list, so it pushes both
//! across the bridge via `refresh_menu`. Called on app init and
//! whenever locale or recent-projects state changes.

use crate::error::AppError;
use crate::menu::{build_menu, MenuLabels, RecentEntry};
use tauri::AppHandle;

#[tauri::command]
#[specta::specta]
pub async fn refresh_menu(
    app: AppHandle,
    labels: MenuLabels,
    recent: Vec<RecentEntry>,
) -> Result<(), AppError> {
    let menu = build_menu(&app, &labels, &recent)
        .map_err(|e| AppError::Custom(format!("build menu: {e}")))?;
    app.set_menu(menu)
        .map_err(|e| AppError::Custom(format!("set menu: {e}")))?;
    Ok(())
}
