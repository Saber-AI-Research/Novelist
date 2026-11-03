use crate::services::{account, portable};
use crate::AppError;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::PathBuf;
use tokio::io::AsyncReadExt;

const MAX_JOURNAL_BYTES: usize = 2 * 1024 * 1024;
static JOURNAL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn invalid() -> AppError {
    AppError::InvalidInput("Invalid account configuration storage request".into())
}

fn validate_slot(key: &str) -> Result<(), AppError> {
    if key.len() > 512
        || !(key.starts_with("ai:") || key.starts_with("ai-url:") || key.starts_with("retained:"))
        || key.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    Ok(())
}

pub async fn get_secret(key: &str) -> Result<Option<String>, AppError> {
    validate_slot(key)?;
    account::config_vault_read(key).await
}

pub async fn set_secret(key: &str, value: Option<&str>) -> Result<(), AppError> {
    validate_slot(key)?;
    if value.is_some_and(|value| value.len() > 8192) {
        return Err(invalid());
    }
    account::config_vault_write(key, value).await
}

fn journal_path() -> PathBuf {
    portable::novelist_home().join("account-config-restore.enc")
}

async fn cipher(create: bool) -> Result<Aes256Gcm, AppError> {
    let raw = match account::config_vault_read("restore-journal-key").await? {
        Some(value) => value,
        None if create => {
            let mut key = [0u8; 32];
            getrandom::getrandom(&mut key).map_err(|_| invalid())?;
            let encoded = STANDARD.encode(key);
            account::config_vault_write("restore-journal-key", Some(&encoded)).await?;
            encoded
        }
        None => {
            return Err(AppError::Custom(
                "Configuration restore key is unavailable".into(),
            ))
        }
    };
    let key = STANDARD.decode(raw).map_err(|_| invalid())?;
    Aes256Gcm::new_from_slice(&key).map_err(|_| invalid())
}

/// Recovery bytes are always authenticated ciphertext; the device key never
/// leaves the operating system's credential store.
pub async fn journal(value: Option<String>, clear: bool) -> Result<Option<String>, AppError> {
    let _guard = JOURNAL_LOCK.lock().await;
    let path = journal_path();
    if clear {
        if value.is_some() {
            return Err(invalid());
        }
        match tokio::fs::remove_file(path).await {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => return Ok(None),
        }
    }
    if let Some(value) = value {
        if value.len() > MAX_JOURNAL_BYTES {
            return Err(invalid());
        }
        if tokio::fs::try_exists(&path).await? {
            return Err(AppError::Custom(
                "An unfinished configuration restore must be recovered first".into(),
            ));
        }
        let cipher = cipher(true).await?;
        let mut nonce = [0u8; 12];
        getrandom::getrandom(&mut nonce).map_err(|_| invalid())?;
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), value.as_bytes())
            .map_err(|_| invalid())?;
        let mut bytes = Vec::with_capacity(nonce.len() + ciphertext.len());
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&ciphertext);
        crate::services::sidecar::atomic_write_bytes(&path, &bytes).await?;
        return Ok(None);
    }
    let file = match tokio::fs::File::open(&path).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        result => result?,
    };
    let mut bytes = Vec::new();
    file.take((MAX_JOURNAL_BYTES + 29) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() < 28 || bytes.len() > MAX_JOURNAL_BYTES + 28 {
        return Err(invalid());
    }
    let plaintext = cipher(false)
        .await?
        .decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..])
        .map_err(|_| {
            AppError::Custom("Configuration restore journal could not be decrypted".into())
        })?;
    String::from_utf8(plaintext)
        .map(Some)
        .map_err(|_| invalid())
}
