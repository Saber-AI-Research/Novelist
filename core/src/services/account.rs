//! Optional Novelist identity and opaque configuration transport.
//!
//! Session tokens and account-bound recovery keys stay in the platform vault.
//! Disk contains only a nonsecret active-account summary and encrypted envelopes;
//! this module never reads projects, WebDAV credentials, or ordinary settings.

use crate::error::AppError;
use crate::services::{portable, sidecar};
use base64::engine::general_purpose::STANDARD;
use futures_util::StreamExt;
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;
use url::{Host, Url};

const VAULT_SERVICE: &str = "novelist-account";
const SESSION_SLOT: &str = "session";
const RECOVERY_SLOT: &str = "recovery";
const MAX_RECORD_BYTES: usize = 8 * 1024;
const MAX_HTTP_BYTES: usize = 1024 * 1024;
const MAX_STATE_BYTES: usize = 8 * 1024 * 1024;

// Serializes authentication, local erasure, and requests so a session cannot be
// replaced or used after a concurrent forget has completed.
static ACCOUNT_LOCK: Mutex<()> = Mutex::const_new(());
static HTTP: std::sync::LazyLock<Result<Client, &'static str>> = std::sync::LazyLock::new(|| {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        // Keep development loopback HTTP credentials off system proxies.
        .no_proxy()
        .build()
        .map_err(|_| "account_network_unavailable")
});

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AccountSummary {
    pub endpoint: String,
    pub user_id: String,
    pub username: String,
    pub device_id: String,
    pub expires_at: String,
}

#[derive(Deserialize)]
struct Authentication {
    user_id: String,
    username: String,
    device_id: String,
    token: String,
    expires_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredSession {
    scope: String,
    token: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredRecoveryKey {
    scope: String,
    value: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct EncryptedEnvelope {
    version: u8,
    iv: String,
    ciphertext: String,
}

fn error(message: &str) -> AppError {
    AppError::Custom(message.into())
}

fn account_dir() -> PathBuf {
    portable::novelist_home().join("account")
}

fn summary_path() -> PathBuf {
    account_dir().join("summary.json")
}

fn scope(parts: &[&str]) -> String {
    let mut hasher = blake3::Hasher::new_derive_key("novelist.account.identity.v1");
    for part in parts {
        hasher.update(&(part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    hasher.finalize().to_hex().to_string()
}

fn account_scope(summary: &AccountSummary) -> String {
    scope(&[&summary.endpoint, &summary.user_id])
}

fn session_scope(summary: &AccountSummary) -> String {
    scope(&[&summary.endpoint, &summary.user_id, &summary.device_id])
}

fn state_path(summary: &AccountSummary) -> PathBuf {
    account_dir()
        .join("state")
        .join(format!("{}.json", account_scope(summary)))
}

fn normalize_endpoint(value: &str) -> Result<String, AppError> {
    if value.len() > 2048 || value.trim() != value || value.contains('\\') {
        return Err(error("account_endpoint_invalid"));
    }
    let url = Url::parse(value).map_err(|_| error("account_endpoint_invalid"))?;
    let loopback = match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain(host)) => host == "localhost",
        None => false,
    };
    if !(url.scheme() == "https" || (cfg!(debug_assertions) && url.scheme() == "http" && loopback))
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(error("account_endpoint_invalid"));
    }
    Ok(url.origin().ascii_serialization())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn validate_summary(summary: &AccountSummary) -> Result<(), AppError> {
    if normalize_endpoint(&summary.endpoint).ok().as_deref() != Some(summary.endpoint.as_str())
        || !valid_identifier(&summary.user_id)
        || !valid_identifier(&summary.device_id)
        || summary.username.is_empty()
        || summary.username.len() > 64
        || summary.username.chars().any(char::is_control)
        || summary.expires_at.len() > 64
        || chrono::DateTime::parse_from_rfc3339(&summary.expires_at).is_err()
    {
        return Err(error("account_record_invalid"));
    }
    Ok(())
}

async fn read_bounded(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, AppError> {
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error("account_storage_unavailable")),
    };
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| error("account_storage_unavailable"))?;
    if bytes.len() > limit {
        return Err(error("account_record_too_large"));
    }
    Ok(Some(bytes))
}

async fn read_summary() -> Result<Option<AccountSummary>, AppError> {
    let Some(bytes) = read_bounded(&summary_path(), MAX_RECORD_BYTES).await? else {
        return Ok(None);
    };
    let summary = serde_json::from_slice(&bytes).map_err(|_| error("account_record_invalid"))?;
    validate_summary(&summary)?;
    Ok(Some(summary))
}

async fn current_summary() -> Result<AccountSummary, AppError> {
    read_summary()
        .await?
        .ok_or_else(|| error("session_expired"))
}

// Mobile vault access fails closed until the platform plugin is initialized.
#[cfg(mobile)]
static NATIVE_VAULT: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

#[cfg(mobile)]
pub fn install_native_vault(app: &tauri::AppHandle) {
    let _ = NATIVE_VAULT.set(app.clone());
}

#[cfg(mobile)]
fn native_vault() -> Result<&'static tauri::AppHandle, AppError> {
    NATIVE_VAULT
        .get()
        .ok_or_else(|| error("account_secure_storage_unavailable"))
}

async fn vault_read(service: &'static str, key: &str) -> Result<Option<String>, AppError> {
    #[cfg(mobile)]
    {
        use tauri_plugin_mobile_support::MobileSupportExt;
        native_vault()?
            .mobile_support()
            .get_credential(service, key)
            .await
            .map_err(|_| error("account_secure_storage_unavailable"))
    }
    #[cfg(not(mobile))]
    {
        let key = key.to_owned();
        tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(service, &key)
                .map_err(|_| error("account_secure_storage_unavailable"))?;
            match entry.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(error("account_secure_storage_unavailable")),
            }
        })
        .await
        .map_err(|_| error("account_secure_storage_unavailable"))?
    }
}

async fn vault_write(
    service: &'static str,
    key: &str,
    value: Option<&str>,
) -> Result<(), AppError> {
    if value.is_some_and(|value| value.len() > MAX_RECORD_BYTES) {
        return Err(error("account_record_too_large"));
    }
    #[cfg(mobile)]
    {
        use tauri_plugin_mobile_support::MobileSupportExt;
        let vault = native_vault()?.mobile_support();
        match value {
            Some(value) => vault.set_credential(service, key, value).await,
            None => vault.delete_credential(service, key).await,
        }
        .map_err(|_| error("account_secure_storage_unavailable"))
    }
    #[cfg(not(mobile))]
    {
        let key = key.to_owned();
        let value = value.map(str::to_owned);
        tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(service, &key)
                .map_err(|_| error("account_secure_storage_unavailable"))?;
            match value {
                Some(value) => entry
                    .set_password(&value)
                    .map_err(|_| error("account_secure_storage_unavailable")),
                None => match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                    Err(_) => Err(error("account_secure_storage_unavailable")),
                },
            }
        })
        .await
        .map_err(|_| error("account_secure_storage_unavailable"))?
    }
}

// Restored user configuration has an independent lifetime from Novelist login.
pub(crate) async fn config_vault_read(key: &str) -> Result<Option<String>, AppError> {
    vault_read("novelist-config", key).await
}

pub(crate) async fn config_vault_write(key: &str, value: Option<&str>) -> Result<(), AppError> {
    vault_write("novelist-config", key, value).await
}

fn http_client() -> Result<&'static Client, AppError> {
    HTTP.as_ref().map_err(|message| error(message))
}

async fn send_request(
    endpoint: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
) -> Result<Value, AppError> {
    let mut request = http_client()?
        .request(method.clone(), format!("{endpoint}{path}"))
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        let bytes = serde_json::to_vec(&body).map_err(|_| error("account_request_invalid"))?;
        if bytes.len() > MAX_HTTP_BYTES {
            return Err(error("account_request_too_large"));
        }
        request = request
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(bytes);
    }
    let response = request
        .send()
        .await
        .map_err(|_| error("account_network_unavailable"))?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|size| size > MAX_HTTP_BYTES as u64)
    {
        return Err(error("account_response_too_large"));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| error("account_network_unavailable"))?;
        if chunk.len() > MAX_HTTP_BYTES - bytes.len() {
            return Err(error("account_response_too_large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        // Deleting an account also verifies its password. A rejected password
        // leaves the authenticated session valid and must not expire it locally.
        let invalid_password = status == StatusCode::UNAUTHORIZED
            && method == Method::DELETE
            && path == "/v1/account"
            && serde_json::from_slice::<Value>(&bytes)
                .ok()
                .is_some_and(|body| {
                    body.get("error").and_then(Value::as_str) == Some("invalid_credentials")
                });
        return Err(error(match status {
            StatusCode::UNAUTHORIZED if invalid_password => "account_credentials_invalid",
            StatusCode::UNAUTHORIZED if token.is_some() => "session_expired",
            StatusCode::UNAUTHORIZED => "account_credentials_invalid",
            StatusCode::CONFLICT if method == Method::PUT && path == "/v1/config" => {
                "revision_conflict"
            }
            StatusCode::CONFLICT => "account_username_unavailable",
            StatusCode::PAYLOAD_TOO_LARGE => "account_request_too_large",
            StatusCode::TOO_MANY_REQUESTS => "account_rate_limited",
            StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY => "account_request_invalid",
            StatusCode::FORBIDDEN => "account_request_forbidden",
            _ if status.is_redirection() => "account_redirect_refused",
            _ if status.is_server_error() => "account_service_unavailable",
            _ => "account_request_failed",
        }));
    }
    serde_json::from_slice(&bytes).map_err(|_| error("account_response_invalid"))
}

fn allowed_request(method: &str, path: &str) -> Result<Method, AppError> {
    let allowed = match (method, path) {
        ("GET", "/v1/me" | "/v1/devices" | "/v1/config")
        | ("POST", "/v1/logout")
        | ("DELETE", "/v1/account")
        | ("PUT", "/v1/config") => true,
        ("DELETE", path) => path
            .strip_prefix("/v1/devices/")
            .is_some_and(valid_identifier),
        _ => false,
    };
    if !allowed {
        return Err(error("account_request_forbidden"));
    }
    Method::from_bytes(method.as_bytes()).map_err(|_| error("account_request_forbidden"))
}

fn base64_length(value: &str) -> Option<u64> {
    let mut decoder = base64::read::DecoderReader::new(value.as_bytes(), &STANDARD);
    std::io::copy(&mut decoder, &mut std::io::sink()).ok()
}

fn validate_envelope(value: &str) -> Result<EncryptedEnvelope, AppError> {
    if value.len() > MAX_STATE_BYTES {
        return Err(error("account_state_too_large"));
    }
    let envelope: EncryptedEnvelope =
        serde_json::from_str(value).map_err(|_| error("account_encrypted_state_required"))?;
    // Leave space for the canonical JSON framing added by the atomic writer.
    if envelope.ciphertext.len() > MAX_STATE_BYTES - 128 {
        return Err(error("account_state_too_large"));
    }
    if envelope.version != 1
        || base64_length(&envelope.iv) != Some(12)
        || base64_length(&envelope.ciphertext).is_none_or(|length| length < 16)
    {
        return Err(error("account_encrypted_state_required"));
    }
    Ok(envelope)
}

pub async fn status() -> Result<Option<AccountSummary>, AppError> {
    let _guard = ACCOUNT_LOCK.lock().await;
    read_summary().await
}

pub async fn authenticate(
    endpoint: String,
    username: String,
    password: String,
    device_name: String,
    register: bool,
) -> Result<AccountSummary, AppError> {
    let _guard = ACCOUNT_LOCK.lock().await;
    if read_summary().await?.is_some() || vault_read(VAULT_SERVICE, SESSION_SLOT).await?.is_some() {
        return Err(error("account_session_exists"));
    }
    let endpoint = normalize_endpoint(&endpoint)?;
    if username.trim().is_empty()
        || username.len() > 64
        || password.is_empty()
        || password.len() > 1024
        || device_name.trim().is_empty()
        || device_name.len() > 128
        || device_name.chars().any(char::is_control)
    {
        return Err(error("account_request_invalid"));
    }
    let body = serde_json::json!({
        "username": username,
        "password": password,
        "device_name": device_name,
    });
    let value = send_request(
        &endpoint,
        Method::POST,
        if register {
            "/v1/register"
        } else {
            "/v1/login"
        },
        Some(body),
        None,
    )
    .await?;
    // From here on the server has created a session and a device. Any local
    // rejection of its answer must log that session out again, best effort.
    let issued_token = value
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| {
            !token.is_empty()
                && token.len() <= 1024
                && token.bytes().all(|byte| byte.is_ascii_graphic())
        })
        .map(str::to_owned);
    let validated = (|| {
        let authenticated: Authentication =
            serde_json::from_value(value).map_err(|_| error("account_response_invalid"))?;
        let summary = AccountSummary {
            endpoint: endpoint.clone(),
            user_id: authenticated.user_id,
            username: authenticated.username,
            device_id: authenticated.device_id,
            expires_at: authenticated.expires_at,
        };
        validate_summary(&summary)?;
        if authenticated.token.len() < 32
            || authenticated.token.len() > 1024
            || !authenticated
                .token
                .bytes()
                .all(|byte| byte.is_ascii_graphic())
        {
            return Err(error("account_response_invalid"));
        }
        Ok((summary, authenticated.token))
    })();
    let (summary, token) = match validated {
        Ok(validated) => validated,
        Err(err) => {
            if let Some(token) = issued_token {
                let _ =
                    send_request(&endpoint, Method::POST, "/v1/logout", None, Some(&token)).await;
            }
            return Err(err);
        }
    };
    let stored = StoredSession {
        scope: session_scope(&summary),
        token,
    };
    let secret = serde_json::to_string(&stored).map_err(|_| error("account_record_invalid"))?;
    let result = match vault_write(VAULT_SERVICE, SESSION_SLOT, Some(&secret)).await {
        Ok(()) => sidecar::atomic_write_json_private(&summary_path(), &summary)
            .await
            .map_err(|_| error("account_storage_unavailable")),
        Err(err) => Err(err),
    };
    if let Err(err) = result {
        // Creating the remote session succeeded: compensate even when storing
        // or deleting the local vault entry itself has failed.
        let _ = vault_write(VAULT_SERVICE, SESSION_SLOT, None).await;
        let _ = send_request(
            &summary.endpoint,
            Method::POST,
            "/v1/logout",
            None,
            Some(&stored.token),
        )
        .await;
        return Err(err);
    }
    Ok(summary)
}

pub async fn request(method: String, path: String, body: Option<Value>) -> Result<Value, AppError> {
    let method = allowed_request(&method, &path)?;
    if body.is_some() && method != Method::PUT && method != Method::DELETE {
        return Err(error("account_request_invalid"));
    }
    let _guard = ACCOUNT_LOCK.lock().await;
    let summary = current_summary().await?;
    let raw = vault_read(VAULT_SERVICE, SESSION_SLOT)
        .await?
        .ok_or_else(|| error("session_expired"))?;
    let session: StoredSession =
        serde_json::from_str(&raw).map_err(|_| error("session_expired"))?;
    if session.scope != session_scope(&summary) {
        return Err(error("session_expired"));
    }
    send_request(&summary.endpoint, method, &path, body, Some(&session.token)).await
}

pub async fn forget() -> Result<(), AppError> {
    let _guard = ACCOUNT_LOCK.lock().await;
    // No network and no settings/project/WebDAV access, including when the
    // account summary is damaged or the remote session is already revoked.
    let token_result = vault_write(VAULT_SERVICE, SESSION_SLOT, None).await;
    let recovery_result = vault_write(VAULT_SERVICE, RECOVERY_SLOT, None).await;
    let state_result = match tokio::fs::remove_dir_all(account_dir().join("state")).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(error("account_storage_unavailable")),
    };
    // Keep the nonsecret pointer on failure so cleanup can be retried and a
    // different account cannot silently replace partially removed credentials.
    token_result?;
    recovery_result?;
    state_result?;
    match tokio::fs::remove_file(summary_path()).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(error("account_storage_unavailable")),
    }
}

pub async fn recovery_key(value: Option<String>) -> Result<Option<String>, AppError> {
    let _guard = ACCOUNT_LOCK.lock().await;
    let summary = current_summary().await?;
    let identity = account_scope(&summary);
    if let Some(value) = value {
        if value.len() != 44 || base64_length(&value) != Some(32) {
            return Err(error("account_recovery_key_invalid"));
        }
        let record = StoredRecoveryKey {
            scope: identity,
            value,
        };
        let secret = serde_json::to_string(&record).map_err(|_| error("account_record_invalid"))?;
        vault_write(VAULT_SERVICE, RECOVERY_SLOT, Some(&secret)).await?;
        return Ok(Some(record.value));
    }
    let Some(secret) = vault_read(VAULT_SERVICE, RECOVERY_SLOT).await? else {
        return Ok(None);
    };
    let record: StoredRecoveryKey =
        serde_json::from_str(&secret).map_err(|_| error("account_recovery_key_invalid"))?;
    if record.scope != identity {
        return Ok(None);
    }
    if record.value.len() != 44 || base64_length(&record.value) != Some(32) {
        return Err(error("account_recovery_key_invalid"));
    }
    Ok(Some(record.value))
}

pub async fn load_state() -> Result<Option<String>, AppError> {
    let _guard = ACCOUNT_LOCK.lock().await;
    let Some(summary) = read_summary().await? else {
        return Ok(None);
    };
    let Some(bytes) = read_bounded(&state_path(&summary), MAX_STATE_BYTES).await? else {
        return Ok(None);
    };
    let value = String::from_utf8(bytes).map_err(|_| error("account_encrypted_state_required"))?;
    validate_envelope(&value)?;
    Ok(Some(value))
}

pub async fn save_state(value: String) -> Result<(), AppError> {
    let envelope = validate_envelope(&value)?;
    let _guard = ACCOUNT_LOCK.lock().await;
    let summary = current_summary().await?;
    sidecar::atomic_write_json_private(&state_path(&summary), &envelope)
        .await
        .map_err(|_| error("account_storage_unavailable"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn account_request_allowlist_rejects_url_and_path_escape() {
        for (method, path) in [
            ("GET", "/v1/me"),
            ("GET", "/v1/devices"),
            ("GET", "/v1/config"),
            ("PUT", "/v1/config"),
            ("POST", "/v1/logout"),
            ("DELETE", "/v1/account"),
            ("DELETE", "/v1/devices/device_1-2"),
        ] {
            assert!(allowed_request(method, path).is_ok());
        }
        for (method, path) in [
            ("POST", "/v1/login"),
            ("GET", "https://another.example/v1/me"),
            ("GET", "/v1/me?token=value"),
            ("GET", "/v1/me#fragment"),
            ("GET", "/v1/../me"),
            ("DELETE", "/v1/devices/"),
            ("DELETE", "/v1/devices/../account"),
            ("DELETE", "/v1/devices/%2e%2e"),
            ("DELETE", "/v1/devices/id/other"),
            ("PATCH", "/v1/config"),
            ("get", "/v1/me"),
        ] {
            assert!(allowed_request(method, path).is_err());
        }
    }

    #[test]
    fn account_endpoints_require_an_origin_and_production_tls() {
        assert_eq!(
            normalize_endpoint("https://example.com/").unwrap(),
            "https://example.com"
        );
        for endpoint in [
            "http://example.com",
            "https://user:password@example.com",
            "https://example.com/v1",
            "https://example.com/?query",
            "https://example.com/#fragment",
            "file:///tmp/account",
            " https://example.com",
            "https://example.com\\@other.example",
        ] {
            assert!(normalize_endpoint(endpoint).is_err());
        }
        assert_eq!(
            normalize_endpoint("http://127.0.0.1:8080").is_ok(),
            cfg!(debug_assertions)
        );
        assert_eq!(
            normalize_endpoint("http://[::1]:8080").is_ok(),
            cfg!(debug_assertions)
        );
    }

    #[test]
    fn account_state_requires_only_an_encrypted_envelope() {
        let envelope = serde_json::json!({
            "version": 1,
            "iv": STANDARD.encode([0_u8; 12]),
            "ciphertext": STANDARD.encode([0_u8; 16]),
        });
        assert!(validate_envelope(&envelope.to_string()).is_ok());
        assert!(validate_envelope(r#"{"password":"plaintext"}"#).is_err());
        let mut modified = envelope.clone();
        modified["plaintext"] = Value::String("must never persist".into());
        assert!(validate_envelope(&modified.to_string()).is_err());
        let mut modified = envelope.clone();
        modified["iv"] = Value::String(STANDARD.encode([0_u8; 11]));
        assert!(validate_envelope(&modified.to_string()).is_err());
        let mut modified = envelope;
        modified["ciphertext"] = Value::String(STANDARD.encode([0_u8; 15]));
        assert!(validate_envelope(&modified.to_string()).is_err());
    }

    #[test]
    fn account_and_device_scopes_are_unambiguous() {
        assert_ne!(
            scope(&["https://one.example", "user"]),
            scope(&["https://two.example", "user"])
        );
        assert_ne!(
            scope(&["https://one.example", "user"]),
            scope(&["https://one.example", "other"])
        );
        assert_ne!(scope(&["a", "bc"]), scope(&["ab", "c"]));
        assert_ne!(
            scope(&["endpoint", "user", "one"]),
            scope(&["endpoint", "user", "two"])
        );
    }

    /// Explicit opt-in: uses the real desktop system vault, not a mock.
    /// A random test account avoids touching application or user credentials.
    #[cfg(not(mobile))]
    #[tokio::test]
    #[ignore = "Exercises the real OS vault; run explicitly on a desktop"]
    async fn desktop_system_vault_round_trip() -> Result<(), AppError> {
        const SERVICE: &str = "novelist-account-smoke";
        let mut random = [0_u8; 32];
        getrandom::getrandom(&mut random).map_err(|_| error("vault_smoke_random_failed"))?;
        let key = format!("test-{}", blake3::hash(&random).to_hex());
        getrandom::getrandom(&mut random).map_err(|_| error("vault_smoke_random_failed"))?;
        let secret = STANDARD.encode(random);
        let result = async {
            vault_write(SERVICE, &key, Some(&secret)).await?;
            let stored = vault_read(SERVICE, &key).await?;
            if stored.as_deref() != Some(secret.as_str()) {
                return Err(error("vault_smoke_round_trip_failed"));
            }
            Ok(())
        }
        .await;
        // Always attempt deletion, including when a write partially succeeded.
        let cleanup = vault_write(SERVICE, &key, None).await;
        result?;
        cleanup?;
        if vault_read(SERVICE, &key).await?.is_some() {
            return Err(error("vault_smoke_cleanup_failed"));
        }
        Ok(())
    }
}
