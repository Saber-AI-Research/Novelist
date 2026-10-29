use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::{Error, Result, ShareOutcome};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> MobileSupport<R> {
    MobileSupport(PhantomData)
}

/// Desktop stand-in: there is no native share sheet or keychain backend here,
/// so every API reports [`Error::Unsupported`] (no insecure fallback).
pub struct MobileSupport<R: Runtime>(PhantomData<fn() -> R>);

impl<R: Runtime> MobileSupport<R> {
    pub fn share_staging_dir(&self) -> Result<PathBuf> {
        Err(Error::Unsupported)
    }

    pub async fn share_file(&self, _path: &Path, _mime_type: &str) -> Result<ShareOutcome> {
        Err(Error::Unsupported)
    }

    pub async fn get_credential(&self, _service: &str, _account: &str) -> Result<Option<String>> {
        Err(Error::Unsupported)
    }

    pub async fn set_credential(
        &self,
        _service: &str,
        _account: &str,
        _secret: &str,
    ) -> Result<()> {
        Err(Error::Unsupported)
    }

    pub async fn delete_credential(&self, _service: &str, _account: &str) -> Result<()> {
        Err(Error::Unsupported)
    }
}
