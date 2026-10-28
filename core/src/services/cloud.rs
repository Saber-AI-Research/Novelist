//! This device's cloud account: one WebDAV folder URL, user name and
//! per-device app password from an existing provider (Nextcloud, ownCloud, a
//! self-hosted WebDAV server). Registration, password resets and revoking a
//! device stay with that provider; Novelist only keeps what it needs to sync.
//!
//! - `<data_root>/cloud/account.json` holds the endpoint and user name, never
//!   a secret.
//! - The password lives in the platform vault: iOS Keychain / Android Keystore
//!   through `tauri-plugin-mobile-support` on mobile (no plaintext fallback),
//!   an owner-only (0600) app-data file on desktop. It is stored together with
//!   the endpoint and user name it was entered for and released only for
//!   exactly that pair, so it can never be sent to another host.
//! - Nothing here returns the password over IPC.
//!
//! Projects opt in with `SyncConfig.cloud_account`; the three-way
//! reconciliation in `services::sync` remains the only sync algorithm.

use crate::commands::library::{library_staging_dir, publish_library_project};
use crate::services::portable;
use crate::services::sync::{self, SyncConfig, SyncStatus};
use crate::services::webdav::{self, WebDavAuth};
use crate::AppError;
use futures_util::stream::{self, StreamExt};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::task::Poll;

const ACCOUNT_FILE: &str = "account.json";
#[cfg(not(mobile))]
const CREDENTIAL_FILE: &str = "credential.json";
#[cfg(mobile)]
const VAULT_SERVICE: &str = "cloud-account";
#[cfg(mobile)]
const VAULT_ACCOUNT: &str = "password";
const MAX_ENDPOINT_BYTES: usize = 2048;
const MAX_USERNAME_BYTES: usize = 256;
const MAX_PASSWORD_BYTES: usize = 1024;
/// Account and credential records; also the native vault's per-secret limit.
const MAX_RECORD_BYTES: usize = 8 * 1024;
const MAX_PROBE_BYTES: usize = 64 * 1024;
/// Bounds on the untrusted `novelist-sync` listing.
const MAX_PROJECT_LISTING_BYTES: usize = 1 << 20;
const MAX_LISTING_ENTRIES: usize = 1000;
/// Projects described by one `list_projects` call.
pub(crate) const MAX_CLOUD_PROJECTS: usize = 200;
const MAX_PROJECT_TOML_BYTES: usize = 64 * 1024;
const MAX_DISPLAY_NAME_CHARS: usize = 120;
/// Local folders inspected when looking for an existing copy.
const MAX_LOCAL_SCAN: usize = 1000;
const DETAIL_CONCURRENCY: usize = 4;
pub(crate) const MIN_INTERVAL_MINUTES: u32 = 5;
pub(crate) const MAX_INTERVAL_MINUTES: u32 = 24 * 60;
const DEFAULT_INTERVAL_MINUTES: u32 = 30;
const AUTH_FAILED: &str = "The server rejected the user name or app password. Create a new app password for this device at your provider and connect again.";

/// Serializes connect, disconnect and project linking.
static ACCOUNT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Serializes downloads, so one project is never downloaded twice at once.
static DOWNLOAD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Shared by every `AccountLease`; taken exclusively to change the account.
static ACCOUNT_USE: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());
/// Bumped when an account change asks outstanding leases to stop.
static ACCOUNT_CHANGES: LazyLock<tokio::sync::watch::Sender<u64>> =
    LazyLock::new(|| tokio::sync::watch::channel(0).0);
/// Orders a download's final commit (last revocation check, publication,
/// sync-data move) against the account-change signal; whichever takes it
/// first goes first. Held only for those synchronous steps, never while
/// waiting for leases.
static COMMIT_GATE: Mutex<()> = Mutex::new(());
/// Test seam: a download about to commit records it and waits here.
#[cfg(test)]
static COMMIT_PAUSE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(test)]
static COMMIT_REACHED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AccountProfile {
    endpoint: String,
    username: String,
    connected_at: String,
}

/// Vault record. Deliberately neither `Debug` nor `Clone`.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredCredential {
    endpoint: String,
    username: String,
    password: String,
}

/// Where this device keeps the app password.
#[derive(Serialize, Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CredentialStorage {
    /// iOS Keychain / Android Keystore, bound to this device.
    SystemKeychain,
    /// Owner-only file in the app data folder; not encrypted at rest.
    AppDataFile,
}

const CREDENTIAL_STORAGE: CredentialStorage = if cfg!(mobile) {
    CredentialStorage::SystemKeychain
} else {
    CredentialStorage::AppDataFile
};

/// The connected account, without any credential.
#[derive(Serialize, Type, Clone, Debug)]
pub struct CloudAccountSummary {
    pub connected: bool,
    /// WebDAV folder URL; validated to carry no credentials.
    pub endpoint: Option<String>,
    pub host: Option<String>,
    pub username: Option<String>,
    pub connected_at: Option<String>,
    pub credential_storage: CredentialStorage,
}

#[derive(Serialize, Type, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CloudConnectionState {
    NotConnected,
    Online,
    /// The server rejected the stored user name or app password.
    AuthFailed,
    /// The password is missing from this device's vault, or belongs to
    /// another server or user.
    CredentialMissing,
    Unreachable,
    /// The URL does not answer as a WebDAV folder.
    Rejected,
}

#[derive(Serialize, Type, Clone, Debug)]
pub struct CloudAccountStatus {
    pub account: CloudAccountSummary,
    pub state: CloudConnectionState,
    pub message: Option<String>,
}

#[derive(Serialize, Type, Clone, Debug)]
pub struct CloudDisconnect {
    /// Projects whose sync was turned off; their files were not touched.
    pub unlinked_projects: u32,
}

#[derive(Serialize, Type, Clone, Debug, PartialEq, Eq)]
pub struct CloudProject {
    pub project_id: String,
    /// `[project] name` from the remote project.toml, when readable.
    pub name: Option<String>,
    /// An existing copy of this project on this device.
    pub local_project_dir: Option<String>,
}

#[derive(Serialize, Type, Clone, Debug)]
pub struct CloudProjectList {
    pub projects: Vec<CloudProject>,
    /// More projects exist than one listing describes.
    pub truncated: bool,
    /// Project folders without a valid identity card; never downloadable.
    pub skipped: u32,
}

#[derive(Serialize, Type, Clone, Debug)]
pub struct CloudDownload {
    pub project_dir: String,
    /// This device already had the project; nothing was downloaded.
    pub already_present: bool,
    /// Result of the initial sync that downloaded the files.
    pub status: Option<SyncStatus>,
}

#[derive(Serialize, Type, Clone, Debug)]
pub struct CloudProjectBinding {
    /// Sync uses this device's cloud account.
    pub linked: bool,
    /// Linked to a different server or user than the connected account.
    pub other_account: bool,
    /// Sync uses the project's own WebDAV settings instead.
    pub custom_webdav: bool,
    pub enabled: bool,
    pub interval_minutes: u32,
    pub last_sync: Option<String>,
}

// ── storage ──────────────────────────────────────────────────────────────────

fn cloud_dir() -> PathBuf {
    sync::data_root().join("cloud")
}

fn read_record(path: &Path) -> Result<Option<Vec<u8>>, AppError> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_RECORD_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(AppError::InvalidInput(
            "Cloud account record exceeds its size limit".into(),
        ));
    }
    Ok(Some(bytes))
}

/// Atomic and owner-only: the folder is 0700 and `atomic_write_state` stages
/// in a 0600 temporary file before renaming it into place.
fn write_record(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("Missing cloud data folder".into()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir)?;
    sync::atomic_write_state(path, bytes)
}

fn remove_record(path: &Path) -> Result<(), AppError> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

fn read_profile() -> Result<Option<AccountProfile>, AppError> {
    let Some(bytes) = read_record(&cloud_dir().join(ACCOUNT_FILE))? else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes).map(Some).map_err(|_| {
        AppError::Custom(
            "The cloud account record is unreadable; disconnect and connect again".into(),
        )
    })
}

fn not_connected() -> AppError {
    AppError::Custom(
        "No cloud account is connected on this device. Connect it in Settings → Sync.".into(),
    )
}

fn unreadable_credential() -> AppError {
    AppError::Custom(
        "This device's stored cloud password is unreadable. Connect the account again.".into(),
    )
}

// ── vault ────────────────────────────────────────────────────────────────────

#[cfg(mobile)]
static NATIVE_VAULT: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Route credentials to the iOS Keychain / Android Keystore. Call once from
/// `setup`, after `tauri_plugin_mobile_support::init()` is registered; until
/// then every mobile credential operation fails closed.
#[cfg(mobile)]
pub fn install_native_vault(app: &tauri::AppHandle) {
    let _ = NATIVE_VAULT.set(app.clone());
}

#[cfg(mobile)]
fn native_vault() -> Result<&'static tauri::AppHandle, AppError> {
    NATIVE_VAULT.get().ok_or_else(|| {
        AppError::Custom("Secure credential storage is not available on this device".into())
    })
}

#[cfg(mobile)]
fn vault_error(_: tauri_plugin_mobile_support::Error) -> AppError {
    AppError::Custom("The system keychain could not store or read the cloud password".into())
}

async fn vault_read() -> Result<Option<String>, AppError> {
    #[cfg(mobile)]
    {
        use tauri_plugin_mobile_support::MobileSupportExt;
        native_vault()?
            .mobile_support()
            .get_credential(VAULT_SERVICE, VAULT_ACCOUNT)
            .await
            .map_err(vault_error)
    }
    #[cfg(not(mobile))]
    {
        let Some(bytes) = read_record(&cloud_dir().join(CREDENTIAL_FILE))? else {
            return Ok(None);
        };
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| unreadable_credential())
    }
}

async fn vault_write(record: &str) -> Result<(), AppError> {
    #[cfg(mobile)]
    {
        use tauri_plugin_mobile_support::MobileSupportExt;
        native_vault()?
            .mobile_support()
            .set_credential(VAULT_SERVICE, VAULT_ACCOUNT, record)
            .await
            .map_err(vault_error)
    }
    #[cfg(not(mobile))]
    {
        write_record(&cloud_dir().join(CREDENTIAL_FILE), record.as_bytes())
    }
}

async fn vault_delete() -> Result<(), AppError> {
    #[cfg(mobile)]
    {
        use tauri_plugin_mobile_support::MobileSupportExt;
        native_vault()?
            .mobile_support()
            .delete_credential(VAULT_SERVICE, VAULT_ACCOUNT)
            .await
            .map_err(vault_error)
    }
    #[cfg(not(mobile))]
    {
        remove_record(&cloud_dir().join(CREDENTIAL_FILE))
    }
}

/// The stored password, released only while it was entered for exactly this
/// account's endpoint and user name.
async fn stored_password(profile: &AccountProfile) -> Result<WebDavAuth, AppError> {
    let raw = vault_read().await?.ok_or_else(|| {
        AppError::Custom(
            "This device has no stored cloud password. Connect the account again.".into(),
        )
    })?;
    let credential: StoredCredential =
        serde_json::from_str(&raw).map_err(|_| unreadable_credential())?;
    if credential.endpoint != profile.endpoint || credential.username != profile.username {
        return Err(AppError::Custom(
            "The stored cloud password belongs to another server or user and was not sent. Connect the account again.".into(),
        ));
    }
    Ok(WebDavAuth {
        username: credential.username,
        password: credential.password,
    })
}

// ── account leases ───────────────────────────────────────────────────────────

/// Authenticated cloud work holds a lease on the account for its whole
/// duration. `connect` and `disconnect` ask every outstanding lease to stop and
/// wait until all are released before they change the account, so once they
/// return nothing is still requesting, downloading or publishing on behalf of
/// the previous account.
pub(crate) struct AccountLease {
    _use: tokio::sync::RwLockReadGuard<'static, ()>,
    changes: tokio::sync::watch::Receiver<u64>,
    endpoint: String,
    auth: WebDavAuth,
}

impl AccountLease {
    pub(crate) fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub(crate) fn auth(&self) -> &WebDavAuth {
        &self.auth
    }

    /// An account change is waiting for this lease: stop before the next
    /// request or local write.
    pub(crate) fn revoked(&self) -> bool {
        self.changes.has_changed().unwrap_or(true)
    }

    /// Run `work`, dropping it at its next await once the account changes.
    /// Only for work that may stop anywhere (listings, probes, snapshot
    /// mirroring); a sync instead checks `revoked` between files.
    pub(crate) async fn guard<T>(
        &self,
        work: impl Future<Output = Result<T, AppError>>,
    ) -> Result<T, AppError> {
        let mut changes = self.changes.clone();
        tokio::select! {
            biased;
            _ = changes.changed() => Err(account_changed()),
            result = work => result,
        }
    }
}

pub(crate) fn account_changed() -> AppError {
    AppError::Custom(
        "The cloud account was changed or disconnected, so this operation was stopped".into(),
    )
}

/// Lease the connected account. With `linked`, it must be exactly that
/// endpoint and user name: the account a project was linked to. Never call
/// this while holding another lease; a waiting account change would block
/// the second one forever.
pub(crate) async fn lease_account(linked: Option<(&str, &str)>) -> Result<AccountLease, AppError> {
    let guard = ACCOUNT_USE.read().await;
    let changes = ACCOUNT_CHANGES.subscribe();
    let profile = read_profile()?.ok_or_else(not_connected)?;
    if let Some((endpoint, username)) = linked {
        if profile.endpoint != endpoint || profile.username != username {
            return Err(AppError::Custom(format!(
                "This project is linked to the cloud account {username} on {}, but this device is connected to another account. Link the project to the current account to sync it.",
                host_of(endpoint).unwrap_or_default()
            )));
        }
    }
    let auth = stored_password(&profile).await?;
    Ok(AccountLease {
        _use: guard,
        changes,
        endpoint: profile.endpoint,
        auth,
    })
}

/// Stop all in-flight cloud work and wait until it has ended. While the
/// returned guard is held no lease exists and none can start.
async fn exclusive_account() -> tokio::sync::RwLockWriteGuard<'static, ()> {
    let mut write = std::pin::pin!(ACCOUNT_USE.write());
    // Queue first, so leases requested from now on wait behind this change…
    if let Poll::Ready(guard) = futures_util::poll!(write.as_mut()) {
        return guard;
    }
    // …then ask the outstanding ones to stop. A download commit already under
    // way finishes first; none starts after this signal.
    {
        let _commit = COMMIT_GATE.lock().unwrap_or_else(PoisonError::into_inner);
        ACCOUNT_CHANGES.send_modify(|generation| *generation += 1);
    }
    write.await
}

// ── validation ───────────────────────────────────────────────────────────────

fn host_of(endpoint: &str) -> Option<String> {
    let url = Url::parse(endpoint).ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        None => false,
    }
}

/// An https WebDAV folder URL without embedded credentials, query or fragment.
/// Plain http is accepted only for a server on this device (development).
/// Errors never echo the input, which may contain a pasted password.
pub(crate) fn validate_endpoint(input: &str) -> Result<String, AppError> {
    let endpoint = input.trim();
    if endpoint.is_empty()
        || endpoint.len() > MAX_ENDPOINT_BYTES
        || endpoint.chars().any(char::is_control)
    {
        return Err(AppError::InvalidInput(
            "Enter the WebDAV folder URL from your provider".into(),
        ));
    }
    let url = webdav::remote_url(endpoint, "").map_err(|_| {
        AppError::InvalidInput(
            "The WebDAV URL is invalid. It must not contain a user name, password, '?' query or '#' fragment".into(),
        )
    })?;
    match url.scheme() {
        "https" => Ok(endpoint.to_owned()),
        "http" if is_loopback(&url) => Ok(endpoint.to_owned()),
        _ => Err(AppError::InvalidInput(
            "Use an https:// WebDAV URL. Plain http is accepted only for a server on this device"
                .into(),
        )),
    }
}

fn validate_username(input: &str) -> Result<String, AppError> {
    let username = input.trim();
    if username.is_empty()
        || username.len() > MAX_USERNAME_BYTES
        || username.contains(':')
        || username.chars().any(char::is_control)
    {
        return Err(AppError::InvalidInput(
            "Enter the user name of your provider account (it cannot contain ':')".into(),
        ));
    }
    Ok(username.to_owned())
}

fn validate_password(password: &str) -> Result<(), AppError> {
    if password.is_empty()
        || password.len() > MAX_PASSWORD_BYTES
        || password.chars().any(char::is_control)
    {
        return Err(AppError::InvalidInput(
            "Enter an app password created for this device in your provider's security settings"
                .into(),
        ));
    }
    Ok(())
}

// ── connection ───────────────────────────────────────────────────────────────

enum ProbeError {
    Auth,
    Unreachable(String),
    Rejected(String),
}

impl From<ProbeError> for AppError {
    fn from(error: ProbeError) -> Self {
        match error {
            ProbeError::Auth => AppError::Custom(AUTH_FAILED.into()),
            ProbeError::Unreachable(message) | ProbeError::Rejected(message) => {
                AppError::Custom(message)
            }
        }
    }
}

/// Authenticated Depth-0 PROPFIND: the URL must be a WebDAV collection that
/// accepts these credentials. Redirects are reported, never followed.
async fn probe(client: &Client, endpoint: &str, auth: &WebDavAuth) -> Result<(), ProbeError> {
    let url = webdav::remote_url(endpoint, "")
        .map_err(|error| ProbeError::Rejected(error.to_string()))?;
    let response = client
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), url)
        .timeout(webdav::REQUEST_TIMEOUT)
        .basic_auth(&auth.username, Some(&auth.password))
        .header("Depth", "0")
        .header("Content-Type", "application/xml")
        .body(r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#)
        .send()
        .await
        .map_err(|error| {
            ProbeError::Unreachable(format!("Cannot reach the server: {}", error.without_url()))
        })?;
    match response.status() {
        StatusCode::MULTI_STATUS => {}
        StatusCode::UNAUTHORIZED => return Err(ProbeError::Auth),
        StatusCode::FORBIDDEN => {
            return Err(ProbeError::Rejected(
                "The server refused access to this folder. Check that the URL points into your own files".into(),
            ))
        }
        StatusCode::NOT_FOUND => {
            return Err(ProbeError::Rejected(
                "No WebDAV folder exists at this URL".into(),
            ))
        }
        status if status.is_redirection() => {
            return Err(ProbeError::Rejected(
                "The server redirected to another address. Enter the final WebDAV folder URL; the password is never sent to a redirect".into(),
            ))
        }
        status => {
            return Err(ProbeError::Rejected(format!(
                "This URL does not answer as a WebDAV folder (HTTP {})",
                status.as_u16()
            )))
        }
    }
    let xml = webdav::read_body_bounded(response, MAX_PROBE_BYTES, "PROPFIND")
        .await
        .map_err(|error| ProbeError::Unreachable(error.to_string()))?;
    let entries = webdav::parse_listing(&xml)
        .map_err(|_| ProbeError::Rejected("The server's WebDAV answer is invalid".into()))?;
    if !entries.iter().any(|entry| entry.is_collection) {
        return Err(ProbeError::Rejected(
            "This URL is a file, not a WebDAV folder".into(),
        ));
    }
    Ok(())
}

fn summary(profile: Option<&AccountProfile>) -> CloudAccountSummary {
    CloudAccountSummary {
        connected: profile.is_some(),
        endpoint: profile.map(|profile| profile.endpoint.clone()),
        host: profile.and_then(|profile| host_of(&profile.endpoint)),
        username: profile.map(|profile| profile.username.clone()),
        connected_at: profile.map(|profile| profile.connected_at.clone()),
        credential_storage: CREDENTIAL_STORAGE,
    }
}

pub fn get_account() -> Result<CloudAccountSummary, AppError> {
    Ok(summary(read_profile()?.as_ref()))
}

/// Re-test the connected account with its stored credential.
pub async fn check_account() -> Result<CloudAccountStatus, AppError> {
    let lease = match lease_account(None).await {
        Ok(lease) => lease,
        Err(error) => {
            let account = get_account()?;
            let connected = account.connected;
            return Ok(CloudAccountStatus {
                account,
                state: if connected {
                    CloudConnectionState::CredentialMissing
                } else {
                    CloudConnectionState::NotConnected
                },
                message: connected.then(|| error.to_string()),
            });
        }
    };
    let account = get_account()?;
    let probed = lease
        .guard(async {
            Ok::<_, AppError>(probe(&sync::webdav_client()?, lease.endpoint(), lease.auth()).await)
        })
        .await?;
    let (state, message) = match probed {
        Ok(()) => (CloudConnectionState::Online, None),
        Err(ProbeError::Auth) => (CloudConnectionState::AuthFailed, Some(AUTH_FAILED.into())),
        Err(ProbeError::Unreachable(message)) => (CloudConnectionState::Unreachable, Some(message)),
        Err(ProbeError::Rejected(message)) => (CloudConnectionState::Rejected, Some(message)),
    };
    Ok(CloudAccountStatus {
        account,
        state,
        message,
    })
}

/// Validate the endpoint and credentials against the server, then store them.
/// Nothing is stored unless the server accepted exactly these credentials.
/// Projects already syncing with this endpoint and user name are linked to
/// the account and lose their plaintext password copy. Replaces a previously
/// connected account; projects linked to that one stop syncing until they
/// are linked again.
pub async fn connect(
    endpoint: &str,
    username: &str,
    password: String,
) -> Result<CloudAccountSummary, AppError> {
    let endpoint = validate_endpoint(endpoint)?;
    let username = validate_username(username)?;
    validate_password(&password)?;
    let _guard = ACCOUNT_LOCK.lock().await;
    // Only the new credentials are used here; work on the current account
    // continues until the server has accepted them.
    let auth = WebDavAuth { username, password };
    probe(&sync::webdav_client()?, &endpoint, &auth).await?;
    let _exclusive = exclusive_account().await;
    let WebDavAuth { username, password } = auth;
    let credential = StoredCredential {
        endpoint: endpoint.clone(),
        username: username.clone(),
        password,
    };
    vault_write(&serde_json::to_string(&credential)?).await?;
    drop(credential);
    // Before the account counts as connected, no per-project plaintext copy
    // of its password may remain (on mobile: none at all).
    sync::adopt_inline_credentials(&endpoint, &username, cfg!(mobile))?;
    let profile = AccountProfile {
        endpoint,
        username,
        connected_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    };
    write_record(
        &cloud_dir().join(ACCOUNT_FILE),
        &serde_json::to_vec_pretty(&profile)?,
    )?;
    Ok(summary(Some(&profile)))
}

/// Forget the account on this device: the vault entry, the account record,
/// and every project link. In-flight cloud work is stopped first and has
/// ended when this returns. Local and remote documents are never touched.
pub async fn disconnect() -> Result<CloudDisconnect, AppError> {
    let _guard = ACCOUNT_LOCK.lock().await;
    let _exclusive = exclusive_account().await;
    vault_delete().await?;
    remove_record(&cloud_dir().join(ACCOUNT_FILE))?;
    Ok(CloudDisconnect {
        unlinked_projects: sync::unlink_cloud_projects()?,
    })
}

// ── projects ─────────────────────────────────────────────────────────────────

fn linked_config(endpoint: &str, username: &str, interval_minutes: u32) -> SyncConfig {
    SyncConfig {
        enabled: true,
        webdav_url: endpoint.to_owned(),
        username: username.to_owned(),
        password: String::new(),
        interval_minutes,
        legacy_remote_acknowledged: false,
        cloud_account: true,
    }
}

fn binding_of(
    project_dir: &str,
    config: &SyncConfig,
    profile: Option<&AccountProfile>,
) -> Result<CloudProjectBinding, AppError> {
    let same_account = profile.is_some_and(|profile| {
        profile.endpoint == config.webdav_url && profile.username == config.username
    });
    Ok(CloudProjectBinding {
        linked: config.cloud_account && same_account,
        other_account: config.cloud_account && !same_account,
        custom_webdav: !config.cloud_account && !config.webdav_url.is_empty(),
        enabled: config.enabled,
        interval_minutes: config.interval_minutes,
        last_sync: sync::last_sync(project_dir)?,
    })
}

pub fn project_binding(project_dir: &str) -> Result<CloudProjectBinding, AppError> {
    let config = sync::read_sync_config(project_dir)?;
    binding_of(project_dir, &config, read_profile()?.as_ref())
}

/// Link a project to the connected account and turn its sync on. The
/// project's own identity is kept (or created by its first sync).
pub async fn bind_project(
    project_dir: &str,
    interval_minutes: u32,
) -> Result<CloudProjectBinding, AppError> {
    if !(MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&interval_minutes) {
        return Err(AppError::InvalidInput(format!(
            "Sync interval must be {MIN_INTERVAL_MINUTES}–{MAX_INTERVAL_MINUTES} minutes"
        )));
    }
    if !Path::new(project_dir).is_dir() {
        return Err(AppError::NotADirectory(project_dir.to_owned()));
    }
    let _guard = ACCOUNT_LOCK.lock().await;
    let profile = read_profile()?.ok_or_else(not_connected)?;
    // Connect and disconnect, the only vault writers, hold the same lock.
    stored_password(&profile).await?;
    let mut config = sync::read_sync_config(project_dir)?;
    let linked = linked_config(&profile.endpoint, &profile.username, interval_minutes);
    config.enabled = linked.enabled;
    config.webdav_url = linked.webdav_url;
    config.username = linked.username;
    config.password = linked.password;
    config.interval_minutes = linked.interval_minutes;
    config.cloud_account = linked.cloud_account;
    sync::save_sync_config_to_disk(project_dir, &config)?;
    binding_of(project_dir, &config, Some(&profile))
}

/// Stop syncing a project with the cloud account; nothing is deleted, and
/// linking it again later continues from the same baselines.
pub async fn unbind_project(project_dir: &str) -> Result<CloudProjectBinding, AppError> {
    let _guard = ACCOUNT_LOCK.lock().await;
    let mut config = sync::read_sync_config(project_dir)?;
    if config.cloud_account {
        config.cloud_account = false;
        config.enabled = false;
        config.password.clear();
        sync::save_sync_config_to_disk(project_dir, &config)?;
    }
    binding_of(project_dir, &config, read_profile()?.as_ref())
}

/// Strip control and bidirectional-format characters, collapse whitespace,
/// and bound the length of a name read from the server.
fn display_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_control()
                || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
            {
                ' '
            } else {
                c
            }
        })
        .collect();
    let name: String = cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_DISPLAY_NAME_CHARS)
        .collect();
    let name = name.trim_end().to_owned();
    (!name.is_empty()).then_some(name)
}

/// Remote project IDs: collections in `novelist-sync` named by a valid ID.
/// The listing is bounded in bytes and entries; an entry escaping the queried
/// collection rejects the whole listing.
async fn remote_project_ids(
    client: &Client,
    endpoint: &str,
    auth: &WebDavAuth,
) -> Result<Vec<String>, AppError> {
    let Some(entries) = webdav::list_collection(
        client,
        endpoint,
        sync::REMOTE_ROOT,
        auth,
        MAX_PROJECT_LISTING_BYTES,
    )
    .await?
    else {
        return Ok(Vec::new());
    };
    if entries.len() > MAX_LISTING_ENTRIES {
        return Err(AppError::InvalidInput(
            "The server listed too many entries in its novelist-sync folder".into(),
        ));
    }
    let collection = webdav::remote_url(endpoint, sync::REMOTE_ROOT)?;
    let mut ids = Vec::new();
    for entry in entries {
        let child = webdav::relative_href(&collection, &entry.href)?;
        if child.is_empty() {
            continue;
        }
        if child.contains('/') {
            return Err(AppError::InvalidInput(
                "WebDAV listing escaped requested depth".into(),
            ));
        }
        if entry.is_collection && sync::is_project_id(&child) {
            ids.push(child);
        }
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// `None` when the namespace has no identity card naming `project_id`;
/// otherwise its display name, if `project.toml` yields one.
async fn remote_project(
    client: &Client,
    endpoint: &str,
    auth: &WebDavAuth,
    project_id: &str,
) -> Result<Option<Option<String>>, AppError> {
    let base = format!("{}/{project_id}", sync::REMOTE_ROOT);
    let card = match webdav::get_file_if_exists(
        client,
        endpoint,
        &format!("{base}/{}", sync::LOCAL_IDENTITY_PATH),
        auth,
        sync::MAX_IDENTITY_BYTES,
    )
    .await
    {
        Ok(Some(card)) => card,
        // Missing or oversized: not a project this device can trust.
        Ok(None) | Err(AppError::InvalidInput(_)) => return Ok(None),
        Err(error) => return Err(error),
    };
    if sync::parse_project_id(&card.bytes).ok().as_deref() != Some(project_id) {
        return Ok(None);
    }
    #[derive(Deserialize)]
    struct ProjectToml {
        project: ProjectName,
    }
    #[derive(Deserialize)]
    struct ProjectName {
        name: String,
    }
    // The name is cosmetic: an unreadable project.toml leaves it unknown.
    let name = webdav::get_file_if_exists(
        client,
        endpoint,
        &format!("{base}/.novelist/project.toml"),
        auth,
        MAX_PROJECT_TOML_BYTES,
    )
    .await
    .ok()
    .flatten()
    .and_then(|file| String::from_utf8(file.bytes).ok())
    .and_then(|text| toml::from_str::<ProjectToml>(&text).ok())
    .and_then(|parsed| display_name(&parsed.project.name));
    Ok(Some(name))
}

/// Projects in `parent` (one level, no symlinks, no hidden staging folders)
/// by sync identity.
fn local_copies(parent: Option<&Path>) -> HashMap<String, PathBuf> {
    let mut copies = HashMap::new();
    let Some(entries) = parent.and_then(|parent| std::fs::read_dir(parent).ok()) else {
        return copies;
    };
    for entry in entries.flatten().take(MAX_LOCAL_SCAN) {
        if entry.file_name().to_string_lossy().starts_with('.')
            || !entry.file_type().is_ok_and(|kind| kind.is_dir())
        {
            continue;
        }
        let path = entry.path();
        if let Ok(Some(project_id)) = sync::local_project_id(&path) {
            copies.entry(project_id).or_insert(path);
        }
    }
    copies
}

fn path_string(path: &Path) -> Result<String, AppError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::InvalidInput("Project path is not valid UTF-8".into()))
}

/// Projects stored on the connected account. `local_parent` (the mobile
/// library) is searched for copies already on this device.
pub async fn list_projects(local_parent: Option<&Path>) -> Result<CloudProjectList, AppError> {
    let lease = lease_account(None).await?;
    lease.guard(list_with(&lease, local_parent)).await
}

async fn list_with(
    lease: &AccountLease,
    local_parent: Option<&Path>,
) -> Result<CloudProjectList, AppError> {
    let client = sync::webdav_client()?;
    let (endpoint, auth) = (lease.endpoint(), lease.auth());
    let mut ids = remote_project_ids(&client, endpoint, auth).await?;
    let truncated = ids.len() > MAX_CLOUD_PROJECTS;
    ids.truncate(MAX_CLOUD_PROJECTS);
    let local = local_copies(local_parent);
    // `None`: the folder has no valid identity card naming its ID.
    let details: Vec<Result<Option<CloudProject>, AppError>> = stream::iter(ids)
        .map(|project_id| {
            let (client, local) = (&client, &local);
            async move {
                let detail = remote_project(client, endpoint, auth, &project_id).await?;
                Ok::<_, AppError>(detail.map(|name| {
                    CloudProject {
                        local_project_dir: local
                            .get(&project_id)
                            .and_then(|path| path_string(path).ok()),
                        project_id,
                        name,
                    }
                }))
            }
        })
        .buffered(DETAIL_CONCURRENCY)
        .collect()
        .await;
    let mut projects = Vec::new();
    let mut skipped = 0;
    for detail in details {
        match detail? {
            Some(project) => projects.push(project),
            None => skipped += 1,
        }
    }
    Ok(CloudProjectList {
        projects,
        truncated,
        skipped,
    })
}

fn first_errors(errors: &[String]) -> String {
    let mut summary = errors
        .iter()
        .take(3)
        .cloned()
        .collect::<Vec<_>>()
        .join("; ");
    if errors.len() > 3 {
        summary.push_str(&format!(" (+{} more)", errors.len() - 3));
    }
    summary
}

/// Download a remote project as a new folder in `parent`, keeping its exact
/// identity. The files arrive through the regular sync into a hidden staging
/// folder, so baselines (and with them deletion propagation) are established
/// exactly as for any other project; only a complete, error-free copy is
/// published under its name. An existing folder is never written into.
///
/// The whole download holds one account lease: an account change stops it
/// before any further request, and nothing is published or linked once the
/// change was requested.
pub async fn download_project(project_id: &str, parent: &Path) -> Result<CloudDownload, AppError> {
    if !sync::is_project_id(project_id) {
        return Err(AppError::InvalidInput("Invalid cloud project ID".into()));
    }
    let _guard = DOWNLOAD_LOCK.lock().await;
    let parent = std::fs::canonicalize(parent)?;
    if !parent.is_dir() {
        return Err(AppError::NotADirectory(path_string(&parent)?));
    }
    if let Some(existing) = local_copies(Some(&parent)).remove(project_id) {
        return Ok(CloudDownload {
            project_dir: public_project_dir(&existing)?,
            already_present: true,
            status: None,
        });
    }
    let lease = lease_account(None).await?;
    let client = sync::webdav_client()?;
    let name = lease
        .guard(remote_project(
            &client,
            lease.endpoint(),
            lease.auth(),
            project_id,
        ))
        .await?
        .ok_or_else(|| {
            AppError::Custom(
                "This cloud project has no valid identity card, so it cannot be downloaded safely"
                    .into(),
            )
        })?
        .unwrap_or_else(|| format!("Novel {}", &project_id[..8]));
    let staged = library_staging_dir(&parent)?;
    let staged_dir = path_string(staged.path())?;
    // Resolved now: the staging name stops resolving once it is published.
    let staged_sync = sync::SyncData::of(&staged_dir)?;
    let filled = async {
        sync::write_project_identity(staged.path(), project_id)?;
        sync::save_sync_config_to_disk(
            &staged_dir,
            &linked_config(
                lease.endpoint(),
                &lease.auth().username,
                DEFAULT_INTERVAL_MINUTES,
            ),
        )?;
        // This lease covers the sync; it must not take a second one.
        sync::perform_sync_with(&staged_dir, Some(&lease)).await
    }
    .await;
    let status = match filled {
        Ok(_) if lease.revoked() => {
            staged_sync.discard()?;
            return Err(account_changed());
        }
        Ok(status) if status.errors.is_empty() && status.last_sync.is_some() => status,
        Ok(status) => {
            staged_sync.discard()?;
            return Err(AppError::Custom(format!(
                "Download incomplete; nothing was added to this device: {}",
                first_errors(&status.errors)
            )));
        }
        Err(error) => {
            staged_sync.discard()?;
            return Err(error);
        }
    };
    #[cfg(test)]
    {
        COMMIT_REACHED.store(true, std::sync::atomic::Ordering::SeqCst);
        drop(COMMIT_PAUSE.lock().await);
    }
    // Final commit, ordered against an account change by the commit gate:
    // after the change is signalled nothing is published; a commit that got
    // the gate first completes, and the change (and so disconnect's unlinking)
    // follows it.
    let project = {
        let _commit = COMMIT_GATE.lock().unwrap_or_else(PoisonError::into_inner);
        if lease.revoked() {
            staged_sync.discard()?;
            return Err(account_changed());
        }
        let project = match publish_library_project(&parent, staged, &name) {
            Ok(project) => project,
            Err(error) => {
                staged_sync.discard()?;
                return Err(error);
            }
        };
        staged_sync.relocate(&path_string(&project)?)?;
        project
    };
    Ok(CloudDownload {
        project_dir: public_project_dir(&project)?,
        already_present: false,
        status: Some(status),
    })
}

/// A project folder as the rest of the app spells it: under the configured
/// library root on mobile (the download resolved the root, which may name the
/// same folder differently), unchanged on desktop.
fn public_project_dir(path: &Path) -> Result<String, AppError> {
    Ok(portable::configured_project_path(&path_string(path)?).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::sync::ConflictResolution;
    use crate::services::webdav::test_server::DavServer;
    use serial_test::serial;

    const USER: &str = "writer";
    const PASSWORD: &str = "app-password-123";

    /// Isolated app data, a WebDAV server that requires `USER`/`PASSWORD`,
    /// and scratch folders for projects.
    struct Cloud {
        data: tempfile::TempDir,
        scratch: tempfile::TempDir,
        old: Option<std::ffi::OsString>,
        server: DavServer,
    }

    impl Cloud {
        fn new() -> Self {
            let data = tempfile::tempdir().unwrap();
            let old = std::env::var_os("NOVELIST_SYNC_DATA_DIR");
            unsafe {
                std::env::set_var("NOVELIST_SYNC_DATA_DIR", data.path());
            }
            let server = DavServer::start();
            server.state.lock().unwrap().credentials = Some((USER.into(), PASSWORD.into()));
            Self {
                data,
                scratch: tempfile::tempdir().unwrap(),
                old,
                server,
            }
        }

        fn dir(&self, name: &str) -> PathBuf {
            let path = self.scratch.path().join(name);
            std::fs::create_dir_all(&path).unwrap();
            path.canonicalize().unwrap()
        }

        fn project(&self, name: &str) -> String {
            self.dir(name).to_str().unwrap().to_owned()
        }

        async fn connect(&self) -> CloudAccountSummary {
            connect(&self.server.url, USER, PASSWORD.into())
                .await
                .unwrap()
        }

        fn remote(&self, path: &str) -> String {
            webdav::remote_url(&self.server.url, path)
                .unwrap()
                .path()
                .to_owned()
        }

        fn remote_write(&self, path: &str, bytes: &[u8]) {
            let path = self.remote(path);
            let mut state = self.server.state.lock().unwrap();
            for (index, _) in path.match_indices('/').skip(1) {
                state.collections.insert(path[..index].to_string());
            }
            state.files.insert(path, bytes.to_vec());
        }

        fn remote_file(&self, path: &str) -> Vec<u8> {
            self.server.state.lock().unwrap().files[&self.remote(path)].clone()
        }

        /// Whether app data holds a recovery copy named `name` with `content`.
        fn has_backup(&self, name: &str, content: &str) -> bool {
            fn walk(dir: &Path, name: &str, content: &str) -> bool {
                std::fs::read_dir(dir).unwrap().flatten().any(|entry| {
                    let path = entry.path();
                    if path.is_dir() {
                        walk(&path, name, content)
                    } else {
                        path.file_name().is_some_and(|file| file == name)
                            && path
                                .components()
                                .any(|part| part.as_os_str() == "conflicts")
                            && std::fs::read_to_string(&path).is_ok_and(|text| text == content)
                    }
                })
            }
            walk(self.data.path(), name, content)
        }
    }

    impl Drop for Cloud {
        fn drop(&mut self) {
            unsafe {
                match &self.old {
                    Some(old) => std::env::set_var("NOVELIST_SYNC_DATA_DIR", old),
                    None => std::env::remove_var("NOVELIST_SYNC_DATA_DIR"),
                }
            }
        }
    }

    fn write(project: &str, relative: &str, text: &str) {
        let path = Path::new(project).join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read(project: &str, relative: &str) -> String {
        std::fs::read_to_string(Path::new(project).join(relative)).unwrap()
    }

    async fn clean_sync(project: &str) -> SyncStatus {
        let status = sync::perform_sync(project).await.unwrap();
        assert!(status.errors.is_empty(), "{:?}", status.errors);
        status
    }

    fn project_id_of(project: &str) -> String {
        sync::local_project_id(Path::new(project)).unwrap().unwrap()
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn connect_validates_before_storing_and_never_exposes_the_password() {
        let cloud = Cloud::new();
        let authority = cloud.server.url.strip_prefix("http://").unwrap();
        for endpoint in [
            format!("http://{USER}:{PASSWORD}@{authority}"),
            format!("{}?token={PASSWORD}", cloud.server.url),
            format!("{}#{PASSWORD}", cloud.server.url),
            format!("http://example.com/{PASSWORD}"),
            format!("ftp://example.com/{PASSWORD}"),
        ] {
            let error = connect(&endpoint, USER, PASSWORD.into())
                .await
                .unwrap_err()
                .to_string();
            assert!(!error.contains(PASSWORD), "{error}");
        }
        assert!(connect(&cloud.server.url, "bad:user", PASSWORD.into())
            .await
            .is_err());
        assert!(connect(&cloud.server.url, USER, String::new())
            .await
            .is_err());
        assert!(cloud.server.state.lock().unwrap().requests.is_empty());

        // A wrong password, a redirect and a non-WebDAV answer store nothing.
        let error = connect(&cloud.server.url, USER, "wrong".into())
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("rejected"), "{error}");
        let root = cloud.remote("");
        for (code, body, expected) in [
            (302, Vec::new(), "redirected"),
            (200, b"<html>login</html>".to_vec(), "WebDAV"),
            (207, b"<html>login</html>".to_vec(), "invalid"),
        ] {
            cloud
                .server
                .state
                .lock()
                .unwrap()
                .canned
                .insert(("PROPFIND".into(), root.clone()), (code, body));
            let error = connect(&cloud.server.url, USER, PASSWORD.into())
                .await
                .unwrap_err()
                .to_string();
            assert!(error.contains(expected), "{error}");
        }
        cloud.server.state.lock().unwrap().canned.clear();
        assert!(!get_account().unwrap().connected);
        assert!(!cloud_dir().join(CREDENTIAL_FILE).exists());
        assert!(!cloud_dir().join(ACCOUNT_FILE).exists());

        let account = cloud.connect().await;
        assert!(account.connected);
        assert_eq!(account.username.as_deref(), Some(USER));
        assert_eq!(account.credential_storage, CredentialStorage::AppDataFile);
        let status = check_account().await.unwrap();
        assert_eq!(status.state, CloudConnectionState::Online);
        for exposed in [
            serde_json::to_string(&get_account().unwrap()).unwrap(),
            serde_json::to_string(&status).unwrap(),
            std::fs::read_to_string(cloud_dir().join(ACCOUNT_FILE)).unwrap(),
        ] {
            assert!(!exposed.contains(PASSWORD), "{exposed}");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode =
                |path: PathBuf| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(cloud_dir()), 0o700);
            assert_eq!(mode(cloud_dir().join(CREDENTIAL_FILE)), 0o600);
            assert_eq!(mode(cloud_dir().join(ACCOUNT_FILE)), 0o600);
        }

        // A revoked app password reports an authentication failure.
        cloud.server.state.lock().unwrap().credentials = Some((USER.into(), "rotated".into()));
        assert_eq!(
            check_account().await.unwrap().state,
            CloudConnectionState::AuthFailed
        );
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn stored_password_is_released_only_for_its_endpoint_and_user() {
        let cloud = Cloud::new();
        let other = DavServer::start();
        cloud.connect().await;
        assert_eq!(
            lease_account(Some((&cloud.server.url, USER)))
                .await
                .unwrap()
                .auth()
                .password,
            PASSWORD
        );
        for (endpoint, user) in [
            (other.url.as_str(), USER),
            (cloud.server.url.as_str(), "someone"),
        ] {
            let error = lease_account(Some((endpoint, user)))
                .await
                .err()
                .unwrap()
                .to_string();
            assert!(!error.contains(PASSWORD), "{error}");
        }

        let project = cloud.project("Novel");
        bind_project(&project, 30).await.unwrap();
        let stored = sync::read_sync_config(&project).unwrap();
        assert!(stored.cloud_account && stored.password.is_empty());
        let masked = crate::commands::sync::get_sync_config(project.clone())
            .await
            .unwrap();
        assert!(masked.cloud_account);
        assert_eq!(masked.password, "");

        // A config pointed at another host is refused before any request.
        let mut tampered = stored.clone();
        tampered.webdav_url = other.url.clone();
        sync::save_sync_config_to_disk(&project, &tampered).unwrap();
        assert!(sync::perform_sync(&project).await.is_err());
        // So is an account record pointed there: the password stays bound to
        // the endpoint it was entered for.
        let mut profile = read_profile().unwrap().unwrap();
        profile.endpoint = other.url.clone();
        write_record(
            &cloud_dir().join(ACCOUNT_FILE),
            &serde_json::to_vec(&profile).unwrap(),
        )
        .unwrap();
        let error = lease_account(Some((&other.url, USER)))
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("another server"), "{error}");
        assert!(sync::perform_sync(&project).await.is_err());
        assert!(other.state.lock().unwrap().requests.is_empty());
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn connecting_moves_plaintext_project_passwords_into_the_account() {
        let cloud = Cloud::new();
        let project = cloud.project("Novel");
        let elsewhere = cloud.project("Elsewhere");
        let inline = |url: &str, password: &str| SyncConfig {
            enabled: true,
            webdav_url: url.to_owned(),
            username: USER.into(),
            password: password.into(),
            interval_minutes: 30,
            legacy_remote_acknowledged: false,
            cloud_account: false,
        };
        sync::save_sync_config_to_disk(&project, &inline(&cloud.server.url, PASSWORD)).unwrap();
        sync::save_sync_config_to_disk(
            &elsewhere,
            &inline("https://elsewhere.example/dav", "other"),
        )
        .unwrap();
        write(&project, "chapter.md", "before the account");
        clean_sync(&project).await;

        cloud.connect().await;
        let linked = sync::read_sync_config(&project).unwrap();
        assert!(linked.cloud_account && linked.enabled && linked.password.is_empty());
        assert!(project_binding(&project).unwrap().linked);
        // Desktop keeps unrelated per-project settings (documented fallback).
        let untouched = sync::read_sync_config(&elsewhere).unwrap();
        assert!(!untouched.cloud_account && untouched.password == "other");
        assert!(project_binding(&elsewhere).unwrap().custom_webdav);
        // Baselines survive the move to the account: nothing is re-sent.
        let status = clean_sync(&project).await;
        assert_eq!((status.files_uploaded, status.files_downloaded), (0, 0));
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn new_device_discovers_and_downloads_the_same_identity() {
        let cloud = Cloud::new();
        cloud.connect().await;
        let device_a = cloud.project("desktop/长篇");
        write(
            &device_a,
            ".novelist/project.toml",
            // A bidi override and an escaped newline must not reach the UI.
            "[project]\nname = \"长篇\u{202E}\\n小说\"\n",
        );
        write(&device_a, "第一章.md", "# 第一章\n");
        write(&device_a, "废稿.md", "draft");
        let binding = bind_project(&device_a, 15).await.unwrap();
        assert!(binding.linked && binding.enabled && binding.interval_minutes == 15);
        clean_sync(&device_a).await;
        let project_id = project_id_of(&device_a);

        let library = cloud.dir("phone-library");
        let listed = list_projects(Some(&library)).await.unwrap();
        assert_eq!(
            listed.projects,
            vec![CloudProject {
                project_id: project_id.clone(),
                name: Some("长篇 小说".into()),
                local_project_dir: None,
            }]
        );
        assert!(!listed.truncated);
        let download = download_project(&project_id, &library).await.unwrap();
        assert!(!download.already_present);
        let device_b = download.project_dir;
        assert_eq!(Path::new(&device_b).parent().unwrap(), library);
        assert_eq!(project_id_of(&device_b), project_id);
        assert_eq!(read(&device_b, "第一章.md"), "# 第一章\n");
        assert_eq!(
            read(&device_b, ".novelist/project.toml"),
            read(&device_a, ".novelist/project.toml")
        );
        // Only the published project is left in the library, no staging folder.
        assert_eq!(std::fs::read_dir(&library).unwrap().count(), 1);
        assert!(project_binding(&device_b).unwrap().linked);

        // The download established baselines: nothing left to transfer, and a
        // deletion on the new device propagates instead of being restored.
        let status = clean_sync(&device_b).await;
        assert_eq!((status.files_uploaded, status.files_downloaded), (0, 0));
        std::fs::remove_file(Path::new(&device_b).join("废稿.md")).unwrap();
        write(&device_b, "第二章.md", "written on the phone");
        assert_eq!(clean_sync(&device_b).await.files_uploaded, 2);
        assert_eq!(clean_sync(&device_a).await.files_downloaded, 2);
        assert!(!Path::new(&device_a).join("废稿.md").exists());
        assert_eq!(read(&device_a, "第二章.md"), "written on the phone");

        // The existing copy is found instead of downloading a second one.
        let listed = list_projects(Some(&library)).await.unwrap();
        assert_eq!(
            listed.projects[0].local_project_dir.as_deref(),
            Some(device_b.as_str())
        );
        let again = download_project(&project_id, &library).await.unwrap();
        assert!(again.already_present);
        assert_eq!(again.project_dir, device_b);
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn interrupted_download_publishes_nothing() {
        let cloud = Cloud::new();
        cloud.connect().await;
        let device_a = cloud.project("Novel");
        write(&device_a, "a.md", "a");
        write(&device_a, "b.md", "b");
        bind_project(&device_a, 30).await.unwrap();
        clean_sync(&device_a).await;
        let project_id = project_id_of(&device_a);
        cloud.server.state.lock().unwrap().fail.insert((
            "GET".into(),
            cloud.remote(&format!("novelist-sync/{project_id}/b.md")),
        ));
        let library = cloud.dir("library");
        let error = download_project(&project_id, &library)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("nothing was added"), "{error}");
        assert_eq!(std::fs::read_dir(&library).unwrap().count(), 0);

        cloud.server.state.lock().unwrap().fail.clear();
        let device_b = download_project(&project_id, &library)
            .await
            .unwrap()
            .project_dir;
        assert_eq!(read(&device_b, "b.md"), "b");
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn conflicts_keep_both_versions_until_an_explicit_choice() {
        let cloud = Cloud::new();
        cloud.connect().await;
        let device_a = cloud.project("desk/Novel");
        for file in ["chapter.md", "notes.md", "plan.md"] {
            write(&device_a, file, "base");
        }
        bind_project(&device_a, 30).await.unwrap();
        clean_sync(&device_a).await;
        let project_id = project_id_of(&device_a);
        let device_b = download_project(&project_id, &cloud.dir("library"))
            .await
            .unwrap()
            .project_dir;
        let remote = |file: &str| {
            String::from_utf8(cloud.remote_file(&format!("novelist-sync/{project_id}/{file}")))
                .unwrap()
        };

        for file in ["chapter.md", "notes.md", "plan.md"] {
            write(&device_a, file, &format!("desk {file}"));
        }
        clean_sync(&device_a).await;
        for file in ["chapter.md", "notes.md", "plan.md"] {
            write(&device_b, file, &format!("phone {file}"));
        }
        let status = sync::perform_sync(&device_b).await.unwrap();
        assert_eq!(status.conflicts, ["chapter.md", "notes.md", "plan.md"]);
        assert_eq!(status.errors.len(), 3);
        assert_eq!((status.files_uploaded, status.files_downloaded), (0, 0));
        assert_eq!(read(&device_b, "chapter.md"), "phone chapter.md");
        assert_eq!(remote("chapter.md"), "desk chapter.md");

        // Keep both: this device's copy keeps the name, the remote one sits beside it.
        let copy = sync::resolve_conflict(&device_b, "chapter.md", ConflictResolution::Both)
            .await
            .unwrap()
            .unwrap();
        assert!(
            copy.starts_with("chapter (remote ") && copy.ends_with(").md"),
            "{copy}"
        );
        assert_eq!(read(&device_b, &copy), "desk chapter.md");
        assert_eq!(read(&device_b, "chapter.md"), "phone chapter.md");
        assert_eq!(remote("chapter.md"), "phone chapter.md");
        assert!(cloud.has_backup("chapter.md", "desk chapter.md"));
        // Keep remote: the replaced local edit stays recoverable in app data.
        sync::resolve_conflict(&device_b, "notes.md", ConflictResolution::Remote)
            .await
            .unwrap();
        assert_eq!(read(&device_b, "notes.md"), "desk notes.md");
        assert!(cloud.has_backup("notes.md", "phone notes.md"));
        // Keep local: the replaced remote version stays recoverable too.
        sync::resolve_conflict(&device_b, "plan.md", ConflictResolution::Local)
            .await
            .unwrap();
        assert_eq!(remote("plan.md"), "phone plan.md");
        assert!(cloud.has_backup("plan.md", "desk plan.md"));

        // Both devices converge without new conflicts.
        assert_eq!(clean_sync(&device_b).await.files_uploaded, 1);
        assert_eq!(clean_sync(&device_a).await.files_downloaded, 3);
        assert_eq!(read(&device_a, "chapter.md"), "phone chapter.md");
        assert_eq!(read(&device_a, &copy), "desk chapter.md");
        assert_eq!(read(&device_a, "plan.md"), "phone plan.md");

        for path in [
            "",
            "../escape.md",
            "/abs.md",
            ".novelist/sync-identity.json",
            "a/./b.md",
        ] {
            assert!(
                sync::resolve_conflict(&device_b, path, ConflictResolution::Local)
                    .await
                    .is_err(),
                "{path}"
            );
        }
        assert!(sync::resolve_conflict(
            &device_b,
            ".novelist/project.toml",
            ConflictResolution::Both
        )
        .await
        .is_err());
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn disconnect_keeps_local_and_remote_documents() {
        let cloud = Cloud::new();
        cloud.connect().await;
        let project = cloud.project("Novel");
        write(&project, "chapter.md", "kept");
        bind_project(&project, 30).await.unwrap();
        clean_sync(&project).await;
        let remote_before = cloud.server.state.lock().unwrap().files.clone();

        assert_eq!(disconnect().await.unwrap().unlinked_projects, 1);
        assert!(!get_account().unwrap().connected);
        assert!(!cloud_dir().join(CREDENTIAL_FILE).exists());
        assert_eq!(read(&project, "chapter.md"), "kept");
        {
            let state = cloud.server.state.lock().unwrap();
            assert_eq!(state.files, remote_before);
            assert!(!state
                .requests
                .iter()
                .any(|request| request.method == "DELETE"));
        }
        let binding = project_binding(&project).unwrap();
        assert!(!binding.linked && !binding.enabled);
        assert_eq!(
            sync::perform_sync(&project).await.unwrap().errors,
            ["Sync is not enabled"]
        );
        assert!(bind_project(&project, 30).await.is_err());

        // Reconnecting and linking again continues from the same baselines.
        cloud.connect().await;
        bind_project(&project, 30).await.unwrap();
        let status = clean_sync(&project).await;
        assert_eq!((status.files_uploaded, status.files_downloaded), (0, 0));
    }

    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn hostile_listings_and_identity_cards_are_rejected_or_skipped() {
        let cloud = Cloud::new();
        cloud.connect().await;
        let [good, forged, oversized, huge_toml] = ["a", "b", "c", "d"].map(|c| c.repeat(64));
        let card = |id: &str| format!(r#"{{"schema_version":1,"project_id":"{id}"}}"#);
        let card_path = |id: &str| format!("novelist-sync/{id}/.novelist/sync-identity.json");
        let toml_path = |id: &str| format!("novelist-sync/{id}/.novelist/project.toml");
        cloud.remote_write(&card_path(&good), card(&good).as_bytes());
        cloud.remote_write(
            &toml_path(&good),
            format!("[project]\nname = \"{}\"\n", "名".repeat(500)).as_bytes(),
        );
        // A card naming another project does not make this folder that project.
        cloud.remote_write(&card_path(&forged), card(&good).as_bytes());
        cloud.remote_write(&card_path(&oversized), &[b' '; 4096]);
        cloud.remote_write(&card_path(&huge_toml), card(&huge_toml).as_bytes());
        cloud.remote_write(
            &toml_path(&huge_toml),
            &vec![b'#'; MAX_PROJECT_TOML_BYTES + 1],
        );
        cloud.remote_write(
            "novelist-sync/legacy-claims/Novel.json",
            card(&good).as_bytes(),
        );
        cloud.remote_write("novelist-sync/not-an-id/chapter.md", b"x");

        let listed = list_projects(None).await.unwrap();
        let ids: Vec<&str> = listed
            .projects
            .iter()
            .map(|project| project.project_id.as_str())
            .collect();
        assert_eq!(ids, [good.as_str(), huge_toml.as_str()]);
        assert_eq!(listed.skipped, 2);
        assert_eq!(
            listed.projects[0].name.as_ref().unwrap().chars().count(),
            MAX_DISPLAY_NAME_CHARS
        );
        assert_eq!(listed.projects[1].name, None);

        // Forged or malformed IDs never become local folders.
        let library = cloud.dir("library");
        let uppercase = "A".repeat(64);
        for id in [
            forged.as_str(),
            oversized.as_str(),
            "../../escape",
            uppercase.as_str(),
            "",
        ] {
            assert!(download_project(id, &library).await.is_err(), "{id}");
        }
        assert_eq!(std::fs::read_dir(&library).unwrap().count(), 0);

        // Listings that escape the queried folder or exceed bounds are refused.
        let listing = cloud.remote("novelist-sync");
        let entry = |href: &str| {
            format!("<d:response><d:href>{href}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>")
        };
        let multistatus =
            |body: String| format!("<d:multistatus xmlns:d=\"DAV:\">{body}</d:multistatus>");
        for body in [
            multistatus(entry("../../../etc/")),
            multistatus(entry(&format!("{listing}/%2e%2e/"))),
            multistatus(entry(&format!("http://evil.example{listing}/{good}/"))),
            multistatus(entry(&format!("{listing}/{good}/nested/"))),
            multistatus(
                (0..=MAX_LISTING_ENTRIES)
                    .map(|index| entry(&format!("{listing}/{index:064}/")))
                    .collect(),
            ),
            multistatus(" ".repeat(MAX_PROJECT_LISTING_BYTES)),
        ] {
            cloud.server.state.lock().unwrap().canned.insert(
                ("PROPFIND".into(), listing.clone()),
                (207, body.into_bytes()),
            );
            assert!(list_projects(None).await.is_err());
        }
    }

    /// Wait (bounded) until `done` holds, letting spawned tasks run.
    async fn until(mut done: impl FnMut() -> bool) {
        for _ in 0..500 {
            if done() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("condition not reached");
    }

    fn account_generation() -> u64 {
        *ACCOUNT_CHANGES.borrow()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial(sync_data_dir)]
    async fn disconnect_waits_for_an_in_flight_download_and_nothing_is_published() {
        let cloud = Cloud::new();
        cloud.connect().await;
        let device_a = cloud.project("Novel");
        write(&device_a, "a.md", "a");
        write(&device_a, "b.md", "b");
        bind_project(&device_a, 30).await.unwrap();
        clean_sync(&device_a).await;
        let project_id = project_id_of(&device_a);
        let stalled = (
            "GET".to_string(),
            cloud.remote(&format!("novelist-sync/{project_id}/a.md")),
        );
        cloud
            .server
            .state
            .lock()
            .unwrap()
            .stall
            .insert(stalled.clone());
        let library = cloud.dir("library");
        let download = tokio::spawn({
            let (project_id, library) = (project_id.clone(), library.clone());
            async move { download_project(&project_id, &library).await }
        });
        until(|| {
            cloud
                .server
                .state
                .lock()
                .unwrap()
                .received
                .contains(&stalled)
        })
        .await;

        let before = account_generation();
        let disconnecting = tokio::spawn(disconnect());
        // The change is requested but waits while the download holds the account.
        until(|| account_generation() != before).await;
        assert!(!disconnecting.is_finished());
        cloud.server.state.lock().unwrap().stall.clear();
        assert_eq!(disconnecting.await.unwrap().unwrap().unlinked_projects, 1);

        // By the time disconnect returned, the download had stopped: nothing
        // was published or linked, and no further request is made.
        assert_eq!(std::fs::read_dir(&library).unwrap().count(), 0);
        assert_eq!(sync::unlink_cloud_projects().unwrap(), 0);
        assert!(!get_account().unwrap().connected);
        let received = cloud.server.state.lock().unwrap().received.len();
        let error = download.await.unwrap().unwrap_err().to_string();
        assert!(error.contains("disconnected"), "{error}");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(cloud.server.state.lock().unwrap().received.len(), received);
        assert_eq!(std::fs::read_dir(&library).unwrap().count(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial(sync_data_dir)]
    async fn replacing_the_account_stops_in_flight_work_on_the_old_one() {
        let cloud = Cloud::new();
        let replacement = DavServer::start();
        replacement.state.lock().unwrap().credentials =
            Some(("other".into(), "other-password".into()));
        cloud.connect().await;
        let project = cloud.project("Novel");
        write(&project, "chapter.md", "draft");
        bind_project(&project, 30).await.unwrap();
        clean_sync(&project).await;

        let listing = ("PROPFIND".to_string(), cloud.remote("novelist-sync"));
        cloud
            .server
            .state
            .lock()
            .unwrap()
            .stall
            .insert(listing.clone());
        let list = tokio::spawn(list_projects(None));
        until(|| {
            cloud
                .server
                .state
                .lock()
                .unwrap()
                .received
                .contains(&listing)
        })
        .await;

        let account = connect(&replacement.url, "other", "other-password".into())
            .await
            .unwrap();
        assert_eq!(account.endpoint.as_deref(), Some(replacement.url.as_str()));
        // The listing was stopped before connect returned.
        let error = list.await.unwrap().unwrap_err().to_string();
        assert!(error.contains("changed"), "{error}");

        // The old account's linked project refuses to run on the new one, so
        // the old server receives nothing more.
        let received = cloud.server.state.lock().unwrap().received.len();
        cloud.server.state.lock().unwrap().stall.clear();
        assert!(sync::perform_sync(&project).await.is_err());
        assert!(project_binding(&project).unwrap().other_account);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(cloud.server.state.lock().unwrap().received.len(), received);
        // The replacement only saw connect's probe of its root.
        let root = webdav::remote_url(&replacement.url, "")
            .unwrap()
            .path()
            .to_owned();
        assert_eq!(
            replacement.state.lock().unwrap().received,
            [("PROPFIND".to_string(), root)]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial(sync_data_dir)]
    async fn an_account_change_signalled_before_the_final_commit_prevents_publication() {
        use std::sync::atomic::Ordering::SeqCst;
        let cloud = Cloud::new();
        cloud.connect().await;
        let device_a = cloud.project("Novel");
        write(&device_a, "chapter.md", "draft");
        bind_project(&device_a, 30).await.unwrap();
        clean_sync(&device_a).await;
        let project_id = project_id_of(&device_a);
        let library = cloud.dir("library");

        COMMIT_REACHED.store(false, SeqCst);
        let pause = COMMIT_PAUSE.lock().await;
        let download = tokio::spawn({
            let (project_id, library) = (project_id.clone(), library.clone());
            async move { download_project(&project_id, &library).await }
        });
        // The staged copy is complete; the download waits just before its commit.
        until(|| COMMIT_REACHED.load(SeqCst)).await;
        let before = account_generation();
        let disconnecting = tokio::spawn(disconnect());
        until(|| account_generation() != before).await;
        drop(pause);

        let error = download.await.unwrap().unwrap_err().to_string();
        assert!(error.contains("disconnected"), "{error}");
        disconnecting.await.unwrap().unwrap();
        assert_eq!(std::fs::read_dir(&library).unwrap().count(), 0);
        assert_eq!(sync::unlink_cloud_projects().unwrap(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[serial(sync_data_dir)]
    async fn a_commit_under_way_completes_before_the_account_change_is_signalled() {
        let cloud = Cloud::new();
        cloud.connect().await;
        let lease = lease_account(None).await.unwrap();
        // A download inside its final commit holds the gate (on its own
        // thread: the gate is never held across an await).
        let (locked, is_locked) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let commit = std::thread::spawn(move || {
            let _commit = COMMIT_GATE.lock().unwrap();
            locked.send(()).unwrap();
            let _ = released.recv();
        });
        is_locked.recv().unwrap();
        let before = account_generation();
        let disconnecting = tokio::spawn(disconnect());
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(account_generation(), before);
        assert!(!lease.revoked());
        assert!(!disconnecting.is_finished());

        // Once the commit is done the change is signalled, and disconnect
        // still waits for the lease.
        release.send(()).unwrap();
        commit.join().unwrap();
        until(|| account_generation() != before).await;
        assert!(lease.revoked());
        assert!(!disconnecting.is_finished());
        drop(lease);
        disconnecting.await.unwrap().unwrap();
        assert!(!get_account().unwrap().connected);
    }

    /// Installs a project library for one test; removed on drop.
    struct TestLibrary;

    impl Drop for TestLibrary {
        fn drop(&mut self) {
            crate::services::portable::set_test_library(None);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    #[serial(sync_data_dir)]
    async fn download_into_an_aliased_library_keeps_its_link_and_baselines() {
        use crate::services::portable::{set_test_library, LibraryLayout};
        let cloud = Cloud::new();
        cloud.connect().await;
        let device_a = cloud.project("desktop/Novel");
        write(&device_a, "chapter.md", "draft");
        bind_project(&device_a, 30).await.unwrap();
        clean_sync(&device_a).await;
        let project_id = project_id_of(&device_a);

        // Like Android's /data/user/0 → /data/data: the library is configured
        // through a symlinked spelling, while the download resolves it.
        let real = cloud.dir("data");
        let alias = cloud.scratch.path().join("user0");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        let layout = LibraryLayout::prepare(alias.join("Projects"), cloud.dir("cache")).unwrap();
        let configured = layout.library_root().to_path_buf();
        assert_ne!(configured, layout.canonical_library_root());
        set_test_library(Some(layout));
        let _library = TestLibrary;

        // The download resolves the root, yet returns the configured spelling
        // the rest of the app (library listing, workspace keys) uses.
        let opened = download_project(&project_id, &configured)
            .await
            .unwrap()
            .project_dir;
        assert_eq!(Path::new(&opened).parent().unwrap(), configured);
        let config = sync::read_sync_config(&opened).unwrap();
        assert!(config.enabled && config.cloud_account);
        let binding = project_binding(&opened).unwrap();
        assert!(binding.linked && binding.last_sync.is_some());
        // The baselines moved with it: the first sync transfers nothing.
        let status = clean_sync(&opened).await;
        assert_eq!((status.files_uploaded, status.files_downloaded), (0, 0));
        // An existing copy is reported under the same spelling.
        let again = download_project(&project_id, &configured).await.unwrap();
        assert!(again.already_present);
        assert_eq!(again.project_dir, opened);
    }
}
