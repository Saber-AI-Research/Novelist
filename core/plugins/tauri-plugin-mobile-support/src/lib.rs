//! Native mobile capabilities for Novelist: the system share sheet and a
//! secure credential vault.
//!
//! # Security boundaries
//!
//! - **Share** (`plugin:mobile-support|share_file`, permission
//!   `mobile-support:allow-share-file`): only regular files strictly inside
//!   [`MobileSupport::share_staging_dir`] (`<app_cache_dir>/exports`) can be
//!   shared. Rust rejects relative paths, `..`, symlinks, hard-linked files
//!   and canonical escapes before calling native code; native code re-checks
//!   containment (Android: a plugin-private `FileProvider` rooted at
//!   `cache/exports/`; iOS: `Library/Caches/<app>/exports/` after resolving
//!   symlinks). Android grants a temporary read-only URI permission through
//!   the intent; nothing is granted persistently.
//! - **Vault** ([`MobileSupport::get_credential`] and friends): Rust-only.
//!   It has no command and no permission, so the webview cannot reach it
//!   (unlisted plugin commands fail the ACL check before Tauri would forward
//!   them to native code). iOS stores generic-password Keychain items with
//!   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, never synchronized;
//!   Android stores AES-256-GCM ciphertext (Android Keystore key, fresh
//!   random IV per write, entry-bound AAD) in app-private SharedPreferences.
//!   Failures are the opaque [`Error::Vault`]; there is no plaintext
//!   fallback and nothing is logged.
//! - **Desktop**: every API returns [`Error::Unsupported`].
//!
//! Native calls on Android run through the UI thread, so the async APIs must
//! not be driven with a blocking executor on the main thread.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;
#[cfg(any(mobile, test))]
mod validate;

#[cfg(desktop)]
pub use desktop::MobileSupport;
pub use error::{Error, Result};
#[cfg(mobile)]
pub use mobile::MobileSupport;
pub use models::ShareOutcome;

/// Name of the share staging directory under the app cache directory.
pub const SHARE_STAGING_DIR_NAME: &str = "exports";
/// Maximum UTF-8 length of a vault service name.
pub const MAX_SERVICE_BYTES: usize = 64;
/// Maximum UTF-8 length of a vault account name.
pub const MAX_ACCOUNT_BYTES: usize = 256;
/// Maximum UTF-8 length of a vault secret.
pub const MAX_SECRET_BYTES: usize = 8 * 1024;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the mobile-support APIs.
pub trait MobileSupportExt<R: Runtime> {
    fn mobile_support(&self) -> &MobileSupport<R>;
}

impl<R: Runtime, T: Manager<R>> crate::MobileSupportExt<R> for T {
    fn mobile_support(&self) -> &MobileSupport<R> {
        self.state::<MobileSupport<R>>().inner()
    }
}

/// Initializes the plugin. Register it on every platform; desktop APIs
/// report [`Error::Unsupported`].
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mobile-support")
        .invoke_handler(tauri::generate_handler![commands::share_file])
        .setup(|app, api| {
            #[cfg(mobile)]
            let mobile_support = mobile::init(app, api)?;
            #[cfg(desktop)]
            let mobile_support = desktop::init(app, api);
            app.manage(mobile_support);
            Ok(())
        })
        .build()
}
