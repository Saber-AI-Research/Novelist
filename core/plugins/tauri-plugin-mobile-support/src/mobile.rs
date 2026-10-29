use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{
    plugin::{mobile::PluginInvokeError, PluginApi, PluginHandle},
    AppHandle, Manager, Runtime,
};

use crate::validate::{
    normalize_mime, resolve_staged_file, validate_credential_key, validate_secret,
};
use crate::{Error, Result, ShareOutcome, SHARE_STAGING_DIR_NAME};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_mobile_support);

/// Kotlin package and class of the Android plugin (see `android/`).
#[cfg(target_os = "android")]
const ANDROID_PACKAGE: &str = "com.novelist.mobilesupport";
#[cfg(target_os = "android")]
const ANDROID_PLUGIN_CLASS: &str = "MobileSupportPlugin";

// Native command names. None of them is in the ACL, so only this module can
// reach them.
const SHARE_FILE: &str = "shareFile";
const GET_CREDENTIAL: &str = "getCredential";
const SET_CREDENTIAL: &str = "setCredential";
const DELETE_CREDENTIAL: &str = "deleteCredential";

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> std::result::Result<MobileSupport<R>, PluginInvokeError> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(ANDROID_PACKAGE, ANDROID_PLUGIN_CLASS)?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_mobile_support)?;
    Ok(MobileSupport {
        app: app.clone(),
        handle,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SharePayload<'a> {
    path: &'a str,
    mime_type: &'a str,
}

#[derive(Deserialize)]
struct ShareResponse {
    outcome: ShareOutcome,
}

#[derive(Serialize)]
struct CredentialKey<'a> {
    service: &'a str,
    account: &'a str,
}

#[derive(Serialize)]
struct CredentialEntry<'a> {
    service: &'a str,
    account: &'a str,
    secret: &'a str,
}

#[derive(Deserialize)]
struct CredentialValue {
    value: Option<String>,
}

/// Access to the native share sheet and credential vault.
pub struct MobileSupport<R: Runtime> {
    app: AppHandle<R>,
    handle: PluginHandle<R>,
}

impl<R: Runtime> MobileSupport<R> {
    /// `<app_cache_dir>/exports`, created if missing. Write or copy a file
    /// here before passing it to [`Self::share_file`]. Android grants share
    /// targets only a temporary read grant that may outlive the sheet, so
    /// clean staged files up later (e.g. before staging the next export),
    /// not as soon as `share_file` returns.
    pub fn share_staging_dir(&self) -> Result<PathBuf> {
        let dir = self
            .app
            .path()
            .app_cache_dir()
            .map_err(|_| Error::CacheDirUnavailable)?
            .join(SHARE_STAGING_DIR_NAME);
        std::fs::create_dir_all(&dir)?;
        Ok(dir)
    }

    /// Presents the system share sheet for a staged file. `mime_type` must be
    /// a bare `type/subtype`. User cancellation is a successful
    /// [`ShareOutcome`], not an error.
    pub async fn share_file(&self, path: &Path, mime_type: &str) -> Result<ShareOutcome> {
        let mime_type = normalize_mime(mime_type)?;
        let file = resolve_staged_file(&self.share_staging_dir()?, path)?;
        let path = file.to_str().ok_or(Error::PathNotAllowed)?;
        let response: ShareResponse = self
            .handle
            .run_mobile_plugin_async(
                SHARE_FILE,
                SharePayload {
                    path,
                    mime_type: &mime_type,
                },
            )
            .await
            .map_err(|err| match err {
                PluginInvokeError::InvokeRejected(rejected) => Error::Share(
                    rejected
                        .message
                        .unwrap_or_else(|| "native share sheet failed".into()),
                ),
                other => Error::Share(other.to_string()),
            })?;
        Ok(response.outcome)
    }

    /// Reads a secret; a missing entry is `Ok(None)`.
    pub async fn get_credential(&self, service: &str, account: &str) -> Result<Option<String>> {
        validate_credential_key(service, account)?;
        let response: CredentialValue = self
            .handle
            .run_mobile_plugin_async(GET_CREDENTIAL, CredentialKey { service, account })
            .await
            .map_err(|_| Error::Vault)?;
        Ok(response.value)
    }

    /// Creates or overwrites a secret.
    pub async fn set_credential(&self, service: &str, account: &str, secret: &str) -> Result<()> {
        validate_credential_key(service, account)?;
        validate_secret(secret)?;
        self.handle
            .run_mobile_plugin_async::<()>(
                SET_CREDENTIAL,
                CredentialEntry {
                    service,
                    account,
                    secret,
                },
            )
            .await
            .map_err(|_| Error::Vault)
    }

    /// Deletes a secret; deleting a missing entry succeeds.
    pub async fn delete_credential(&self, service: &str, account: &str) -> Result<()> {
        validate_credential_key(service, account)?;
        self.handle
            .run_mobile_plugin_async::<()>(DELETE_CREDENTIAL, CredentialKey { service, account })
            .await
            .map_err(|_| Error::Vault)
    }
}
