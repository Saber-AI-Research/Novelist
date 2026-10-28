use std::path::Path;

use tauri::{command, AppHandle, Runtime};

use crate::{MobileSupportExt, Result, ShareOutcome};

/// `invoke('plugin:mobile-support|share_file', { path, mimeType })`.
#[command]
pub(crate) async fn share_file<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    mime_type: String,
) -> Result<ShareOutcome> {
    app.mobile_support()
        .share_file(Path::new(&path), &mime_type)
        .await
}
