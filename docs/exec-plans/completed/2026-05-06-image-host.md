# Image Host Implementation Plan

> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.2.4 image-hosting feature: upload local Markdown images to Qiniu / Aliyun OSS / S3 / R2 / imgur / sm.ms / Custom and rewrite the Markdown source.

**Architecture:** Per-provider Tauri commands (no shared trait) backed by `core/src/services/image_host/<provider>.rs`. Frontend orchestrator at `app/lib/services/image-host.ts` resolves the active host (global + per-project override) and routes to the right command. Plaintext credentials in global settings only; per-project settings can only override `active_host_id`. Spec: `docs/product-specs/2026-05-06-image-host.md`.

**Tech Stack:** Rust + Tauri v2 + tauri-specta + reqwest + tokio + Svelte 5 + CodeMirror 6. New deps: `wiremock` (dev), `hmac` + `sha1` + `sha2` for Qiniu/OSS/S3 signing, `chrono` (already pulled in transitively via tauri).

---

## File Structure

**New (Rust):**
- `core/src/services/image_host/mod.rs` — re-exports
- `core/src/services/image_host/types.rs` — `UploadInput`, `UploadResult`, `HostError`
- `core/src/services/image_host/naming.rs` — object-key generator
- `core/src/services/image_host/qiniu.rs`
- `core/src/services/image_host/aliyun_oss.rs`
- `core/src/services/image_host/s3.rs` (also serves R2 via endpoint override)
- `core/src/services/image_host/imgur.rs`
- `core/src/services/image_host/smms.rs`
- `core/src/services/image_host/custom.rs`
- `core/src/commands/image_host.rs` — six `#[tauri::command]` upload functions + settings get/set
- `core/src/models/image_host.rs` — `ImageHostSettings`, `HostConfig`, `ProviderConfig`

**Modified (Rust):**
- `core/src/error.rs` — add `HostError` variant to `AppError` (or `From<HostError>`)
- `core/src/commands/mod.rs` — `pub mod image_host;`
- `core/src/services/mod.rs` — `pub mod image_host;`
- `core/src/models/mod.rs` — `pub mod image_host;`
- `core/src/models/settings.rs` — add `image_hosts: ImageHostSettings` to `GlobalSettings`; add optional `active_host_id` to project overlay
- `core/src/lib.rs` — register `upload_image_*` and settings commands in both `collect_commands!` blocks
- `core/Cargo.toml` — add `wiremock` (dev), `hmac`, `sha1`, `sha2`, `urlencoding`, `chrono` (workspace)

**New (Frontend):**
- `app/lib/services/image-host.ts` — orchestrator
- `app/lib/components/SettingsImageHostsPanel.svelte` — settings UI
- `tests/unit/image-host-orchestrator.test.ts`
- `tests/e2e/image-host.spec.ts`

**Modified (Frontend):**
- `app/lib/editor/wysiwyg.ts` — add "Upload to host" item to image context menu
- `app/lib/editor/wysiwyg.ts` (`imagePastePlugin`) — auto-on-paste hook
- `app/lib/app-commands.ts` — register `imageHost.uploadAll` palette entry
- `app/lib/components/Settings.svelte` (or wherever the settings dialog lives) — mount the new panel

---

## Phase 1 — Foundation

### Task 1.1: Add Cargo deps

**Files:** `core/Cargo.toml`

- [ ] **Step 1: Add deps**

```toml
# under [dependencies]
hmac = "0.12"
sha1 = "0.10"
sha2 = "0.10"
urlencoding = "2"

# under [dev-dependencies]
wiremock = "0.6"
```

- [ ] **Step 2: `cd core && cargo build` to confirm resolution**

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add core/Cargo.toml core/Cargo.lock
git commit -m "build(deps): add hmac/sha1/sha2/urlencoding/wiremock for image-host"
```

### Task 1.2: Image-host types

**Files:** Create `core/src/services/image_host/mod.rs`, `types.rs`. Modify `core/src/services/mod.rs`.

- [ ] **Step 1: Create `core/src/services/image_host/mod.rs`**

```rust
pub mod types;
pub mod naming;
pub mod qiniu;
pub mod aliyun_oss;
pub mod s3;
pub mod imgur;
pub mod smms;
pub mod custom;
```

(Modules referenced before they exist — Rust will error until each file is added; keep this header minimal until the corresponding tasks complete. Alternatively start with only `types` and `naming` and add the rest as each provider task lands. Use the latter — less compile-break churn.)

Actual content for now:

```rust
pub mod types;
pub mod naming;
```

- [ ] **Step 2: Create `core/src/services/image_host/types.rs`**

```rust
use serde::{Deserialize, Serialize};
use specta::Type;

/// Bytes + metadata handed to a provider's upload function.
#[derive(Debug, Clone)]
pub struct UploadInput {
    pub bytes: Vec<u8>,
    pub filename: String,
    pub mime: String,
    /// Pre-generated object key (used by S3/OSS/Qiniu). Provider may ignore.
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UploadResult {
    pub url: String,
    pub remote_key: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("Network error: {0}")]
    Network(String),
    #[error("Authentication rejected: {0}")]
    Auth(String),
    #[error("Quota exceeded: {0}")]
    QuotaExceeded(String),
    #[error("Bad config: {0}")]
    BadConfig(String),
    #[error("Host returned {status}: {message}")]
    HostError { status: u16, message: String },
    #[error("Unexpected response: {0}")]
    UnexpectedResponse(String),
    #[error("File too large: {actual} bytes > {limit} bytes")]
    FileTooLarge { limit: u64, actual: u64 },
}
```

- [ ] **Step 3: Wire into `services/mod.rs`**

Add `pub mod image_host;` to `core/src/services/mod.rs`.

- [ ] **Step 4: `cargo build` (in `core/`)**

Expected: PASS (just dead code at this point).

- [ ] **Step 5: Commit**

```bash
git add core/src/services/image_host/ core/src/services/mod.rs
git commit -m "feat(image-host): scaffold types and HostError enum"
```

### Task 1.3: Naming-key generator

**Files:** `core/src/services/image_host/naming.rs`

- [ ] **Step 1: Failing test**

```rust
// at bottom of naming.rs:
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn key_has_date_prefix_hash_and_sanitized_name() {
        let now = chrono::Utc.with_ymd_and_hms(2026, 5, 6, 12, 0, 0).unwrap();
        let key = generate_key("Hello World.PNG", b"some-bytes", now);
        assert!(key.starts_with("2026/05/06/"), "got: {}", key);
        assert!(key.ends_with("-Hello_World.png"), "got: {}", key);
        // 8 hex chars between date prefix and dash
        let after_date = &key["2026/05/06/".len()..];
        assert_eq!(&after_date[..8].chars().filter(|c| c.is_ascii_hexdigit()).count(), &8);
    }

    #[test]
    fn key_strips_cjk_to_image() {
        let now = chrono::Utc.with_ymd_and_hms(2026, 5, 6, 0, 0, 0).unwrap();
        let key = generate_key("照片.jpg", b"x", now);
        assert!(key.ends_with("-image.jpg"), "got: {}", key);
    }

    #[test]
    fn key_total_length_capped() {
        let now = chrono::Utc.with_ymd_and_hms(2026, 5, 6, 0, 0, 0).unwrap();
        let huge = "a".repeat(500);
        let key = generate_key(&format!("{}.png", huge), b"x", now);
        assert!(key.len() <= 200, "key too long: {}", key.len());
    }
}
```

- [ ] **Step 2: Run, expect fail (function missing)**

`cd core && cargo test --lib image_host::naming::tests`

- [ ] **Step 3: Implement**

```rust
//! Object-key generator for hosts where the client picks the key.
//! Format: `{yyyy}/{mm}/{dd}/{8-char-blake3}-{sanitized-name}.{ext}`.

use chrono::{DateTime, Datelike, Utc};

const MAX_KEY_LEN: usize = 200;

pub fn generate_key(filename: &str, bytes: &[u8], now: DateTime<Utc>) -> String {
    let (stem, ext) = split_ext(filename);
    let sanitized = sanitize_name(stem);
    let hash = blake3::hash(bytes).to_hex();
    let short_hash = &hash.as_str()[..8];
    let mut key = format!(
        "{:04}/{:02}/{:02}/{}-{}",
        now.year(),
        now.month(),
        now.day(),
        short_hash,
        sanitized,
    );
    if !ext.is_empty() {
        key.push('.');
        key.push_str(&ext.to_lowercase());
    }
    if key.len() > MAX_KEY_LEN {
        // Truncate the sanitized-name middle. Keep date prefix, hash, ext.
        let overflow = key.len() - MAX_KEY_LEN;
        let new_stem_len = sanitized.len().saturating_sub(overflow);
        let trimmed_stem: String = sanitized.chars().take(new_stem_len).collect();
        key = format!(
            "{:04}/{:02}/{:02}/{}-{}",
            now.year(), now.month(), now.day(), short_hash, trimmed_stem
        );
        if !ext.is_empty() {
            key.push('.');
            key.push_str(&ext.to_lowercase());
        }
    }
    key
}

fn split_ext(filename: &str) -> (&str, &str) {
    match filename.rfind('.') {
        Some(idx) if idx > 0 && idx < filename.len() - 1 => {
            (&filename[..idx], &filename[idx + 1..])
        }
        _ => (filename, ""),
    }
}

fn sanitize_name(stem: &str) -> String {
    let mut out: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else if c == ' ' {
                '_'
            } else if c.is_ascii() {
                '_'
            } else {
                // non-ASCII (CJK etc.) — drop, will fallback below if all dropped
                '\0'
            }
        })
        .filter(|c| *c != '\0')
        .collect();
    if out.is_empty() {
        out = "image".to_string();
    }
    out
}
```

Note: `blake3` is already a workspace dep (used by file watcher per CLAUDE.md). Verify:

```bash
grep '^blake3' core/Cargo.toml || echo "MISSING blake3"
```

If missing, add `blake3 = "1"` under `[dependencies]` in this same task.

- [ ] **Step 4: Run, expect pass**

`cargo test --lib image_host::naming::tests`

- [ ] **Step 5: Commit**

```bash
git add core/src/services/image_host/naming.rs core/Cargo.toml
git commit -m "feat(image-host): object-key generator with date prefix + blake3 hash"
```

### Task 1.4: Settings model

**Files:** Create `core/src/models/image_host.rs`. Modify `core/src/models/mod.rs`, `core/src/models/settings.rs`.

- [ ] **Step 1: Create model**

```rust
// core/src/models/image_host.rs
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Default, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct ImageHostSettings {
    #[serde(default)]
    pub hosts: Vec<HostConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_host_id: Option<String>,
    #[serde(default)]
    pub auto_on_paste: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct HostConfig {
    pub id: String,
    pub name: String,
    #[serde(flatten)]
    pub config: ProviderConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(tag = "provider", rename_all = "snake_case")]
pub enum ProviderConfig {
    Qiniu {
        access_key: String,
        secret_key: String,
        bucket: String,
        domain: String,
    },
    AliyunOss {
        access_key_id: String,
        access_key_secret: String,
        bucket: String,
        endpoint: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_domain: Option<String>,
    },
    S3 {
        access_key_id: String,
        secret_access_key: String,
        bucket: String,
        region: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        endpoint: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path_prefix: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        custom_domain: Option<String>,
    },
    Imgur {
        client_id: String,
    },
    Smms {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        api_token: Option<String>,
    },
    Custom {
        post_url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bearer: Option<String>,
    },
}
```

- [ ] **Step 2: Wire into `models/mod.rs`** — add `pub mod image_host;`.

- [ ] **Step 3: Add to `GlobalSettings`** — modify `core/src/models/settings.rs`:

```rust
// add at top: use crate::models::image_host::ImageHostSettings;

pub struct GlobalSettings {
    // ...existing fields...
    #[serde(default)]
    pub image_hosts: ImageHostSettings,
}
```

And to `ProjectConfig` (in `core/src/models/project.rs`) add:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub active_image_host_id: Option<String>,
```

- [ ] **Step 4: `cargo build`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/models/
git commit -m "feat(image-host): add ImageHostSettings + ProjectConfig override field"
```

---

## Phase 2 — Provider implementations

Each provider task follows the same pattern: type-stub, wiremock success test, implement against the documented API, error tests. Each test uses `wiremock::MockServer` so we never hit real network in unit tests.

**Provider doc URLs to reference while implementing:**
- Qiniu: https://developer.qiniu.com/kodo/1312/upload (form upload + token v2 spec)
- Aliyun OSS: https://help.aliyun.com/zh/oss/developer-reference/putobject (signed PUT, header signature)
- AWS S3: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
- Cloudflare R2: same as S3 with `auto` region or configured one; endpoint = `https://<account>.r2.cloudflarestorage.com`
- imgur: https://api.imgur.com/endpoints/image#image-upload (POST `/3/image` multipart)
- sm.ms v2: https://doc.sm.ms/#api-Image-Upload (POST `/api/v2/upload`)

### Task 2.1: Qiniu

**Files:** `core/src/services/image_host/qiniu.rs`

Wire format:
1. Build upload policy JSON: `{ "scope": "<bucket>:<key>", "deadline": <unix-ts + 3600> }`
2. base64-urlsafe encode policy → `encoded_policy`
3. HMAC-SHA1(secret_key, encoded_policy) → base64-urlsafe → `encoded_sign`
4. `upload_token = "<access_key>:<encoded_sign>:<encoded_policy>"`
5. multipart POST to `https://upload.qiniup.com` (or region-specific) with fields: `key`, `token`, `file`
6. Response JSON `{ "key": "...", "hash": "..." }` → URL = `<domain>/<key>`

- [ ] **Step 1: Failing test (success path)**

```rust
// In qiniu.rs:
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::image_host::ProviderConfig;
    use crate::services::image_host::types::UploadInput;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn cfg(domain: String) -> ProviderConfig {
        ProviderConfig::Qiniu {
            access_key: "ak123".to_string(),
            secret_key: "sk456".to_string(),
            bucket: "novelist".to_string(),
            domain,
        }
    }

    #[tokio::test]
    async fn upload_success_returns_cdn_url() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "key": "2026/05/06/abc-x.png",
                "hash": "FoooBar"
            })))
            .mount(&server)
            .await;

        let input = UploadInput {
            bytes: vec![1,2,3],
            filename: "x.png".to_string(),
            mime: "image/png".to_string(),
            key: "2026/05/06/abc-x.png".to_string(),
        };
        let result = upload_with_endpoint(&cfg("https://cdn.example.com".to_string()), input, server.uri()).await.unwrap();
        assert_eq!(result.url, "https://cdn.example.com/2026/05/06/abc-x.png");
    }

    #[tokio::test]
    async fn upload_401_maps_to_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401).set_body_string("bad token"))
            .mount(&server)
            .await;
        let input = UploadInput { bytes: vec![1], filename: "x.png".into(), mime: "image/png".into(), key: "x".into() };
        let err = upload_with_endpoint(&cfg("https://cdn".into()), input, server.uri()).await.unwrap_err();
        matches!(err, crate::services::image_host::types::HostError::Auth(_));
    }
}
```

- [ ] **Step 2: Implement**

```rust
use crate::models::image_host::ProviderConfig;
use crate::services::image_host::types::{HostError, UploadInput, UploadResult};
use base64::Engine;
use hmac::{Hmac, Mac};
use sha1::Sha1;

const DEFAULT_ENDPOINT: &str = "https://upload.qiniup.com";

pub async fn upload(config: &ProviderConfig, input: UploadInput) -> Result<UploadResult, HostError> {
    upload_with_endpoint(config, input, DEFAULT_ENDPOINT.to_string()).await
}

pub async fn upload_with_endpoint(
    config: &ProviderConfig,
    input: UploadInput,
    endpoint: String,
) -> Result<UploadResult, HostError> {
    let (ak, sk, bucket, domain) = match config {
        ProviderConfig::Qiniu { access_key, secret_key, bucket, domain } => {
            (access_key, secret_key, bucket, domain)
        }
        _ => return Err(HostError::BadConfig("not a Qiniu config".into())),
    };
    if ak.is_empty() || sk.is_empty() || bucket.is_empty() || domain.is_empty() {
        return Err(HostError::BadConfig("Qiniu config has empty field".into()));
    }

    let scope = format!("{}:{}", bucket, input.key);
    let deadline = (chrono::Utc::now().timestamp() as u64) + 3600;
    let policy = serde_json::json!({ "scope": scope, "deadline": deadline });
    let policy_str = policy.to_string();
    let encoded_policy = base64::engine::general_purpose::URL_SAFE.encode(policy_str.as_bytes());

    type HmacSha1 = Hmac<Sha1>;
    let mut mac = HmacSha1::new_from_slice(sk.as_bytes())
        .map_err(|e| HostError::BadConfig(format!("hmac init: {}", e)))?;
    mac.update(encoded_policy.as_bytes());
    let sign = mac.finalize().into_bytes();
    let encoded_sign = base64::engine::general_purpose::URL_SAFE.encode(&sign);
    let token = format!("{}:{}:{}", ak, encoded_sign, encoded_policy);

    let part = reqwest::multipart::Part::bytes(input.bytes)
        .file_name(input.filename.clone())
        .mime_str(&input.mime)
        .map_err(|e| HostError::BadConfig(format!("bad mime: {}", e)))?;
    let form = reqwest::multipart::Form::new()
        .text("key", input.key.clone())
        .text("token", token)
        .part("file", part);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| HostError::Network(e.to_string()))?;

    let resp = client
        .post(&endpoint)
        .multipart(form)
        .send()
        .await
        .map_err(|e| HostError::Network(e.to_string()))?;

    let status = resp.status();
    if status.is_success() {
        let body: serde_json::Value = resp.json().await
            .map_err(|e| HostError::UnexpectedResponse(format!("json: {}", e)))?;
        let key = body.get("key").and_then(|v| v.as_str())
            .ok_or_else(|| HostError::UnexpectedResponse("no `key` in response".into()))?;
        let url = format!("{}/{}", domain.trim_end_matches('/'), key);
        Ok(UploadResult { url, remote_key: Some(key.to_string()) })
    } else if status.as_u16() == 401 || status.as_u16() == 403 {
        let body = resp.text().await.unwrap_or_default();
        Err(HostError::Auth(body))
    } else if status.as_u16() == 429 {
        Err(HostError::QuotaExceeded(resp.text().await.unwrap_or_default()))
    } else {
        let msg = resp.text().await.unwrap_or_default();
        Err(HostError::HostError { status: status.as_u16(), message: msg })
    }
}
```

- [ ] **Step 3: Add `pub mod qiniu;` to `image_host/mod.rs`**

- [ ] **Step 4: `cargo test --lib image_host::qiniu`**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/services/image_host/qiniu.rs core/src/services/image_host/mod.rs
git commit -m "feat(image-host): qiniu uploader with hmac-sha1 token"
```

### Task 2.2: imgur (simplest — do this before signing-heavy ones)

**Files:** `core/src/services/image_host/imgur.rs`

Wire: POST `https://api.imgur.com/3/image` multipart with `image=<bytes>`, header `Authorization: Client-ID <client_id>`. Response JSON: `{ "data": { "link": "..." }, "success": true }`.

- [ ] **Step 1: Failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::image_host::ProviderConfig;
    use crate::services::image_host::types::{HostError, UploadInput};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn upload_success_returns_link() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/3/image"))
            .and(header("Authorization", "Client-ID xyz"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": { "link": "https://i.imgur.com/abc.png" },
                "success": true
            })))
            .mount(&server).await;

        let input = UploadInput { bytes: vec![1,2,3], filename: "x.png".into(), mime: "image/png".into(), key: "x.png".into() };
        let cfg = ProviderConfig::Imgur { client_id: "xyz".into() };
        let result = upload_with_endpoint(&cfg, input, format!("{}/3/image", server.uri())).await.unwrap();
        assert_eq!(result.url, "https://i.imgur.com/abc.png");
    }

    #[tokio::test]
    async fn rejects_files_over_10mb() {
        let cfg = ProviderConfig::Imgur { client_id: "xyz".into() };
        let bytes = vec![0u8; 10 * 1024 * 1024 + 1];
        let input = UploadInput { bytes, filename: "x.png".into(), mime: "image/png".into(), key: "x".into() };
        let err = upload(&cfg, input).await.unwrap_err();
        matches!(err, HostError::FileTooLarge { .. });
    }
}
```

- [ ] **Step 2: Implement**

```rust
use crate::models::image_host::ProviderConfig;
use crate::services::image_host::types::{HostError, UploadInput, UploadResult};

const ENDPOINT: &str = "https://api.imgur.com/3/image";
const MAX_BYTES: u64 = 10 * 1024 * 1024;

pub async fn upload(config: &ProviderConfig, input: UploadInput) -> Result<UploadResult, HostError> {
    upload_with_endpoint(config, input, ENDPOINT.to_string()).await
}

pub async fn upload_with_endpoint(
    config: &ProviderConfig,
    input: UploadInput,
    endpoint: String,
) -> Result<UploadResult, HostError> {
    let client_id = match config {
        ProviderConfig::Imgur { client_id } => client_id,
        _ => return Err(HostError::BadConfig("not an Imgur config".into())),
    };
    if client_id.is_empty() {
        return Err(HostError::BadConfig("imgur client_id is empty".into()));
    }
    let actual = input.bytes.len() as u64;
    if actual > MAX_BYTES {
        return Err(HostError::FileTooLarge { limit: MAX_BYTES, actual });
    }
    let part = reqwest::multipart::Part::bytes(input.bytes)
        .file_name(input.filename.clone())
        .mime_str(&input.mime).map_err(|e| HostError::BadConfig(format!("bad mime: {}", e)))?;
    let form = reqwest::multipart::Form::new().part("image", part);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build().map_err(|e| HostError::Network(e.to_string()))?;
    let resp = client.post(&endpoint)
        .header("Authorization", format!("Client-ID {}", client_id))
        .multipart(form).send().await
        .map_err(|e| HostError::Network(e.to_string()))?;

    let status = resp.status();
    if status.is_success() {
        let body: serde_json::Value = resp.json().await
            .map_err(|e| HostError::UnexpectedResponse(format!("json: {}", e)))?;
        let link = body.pointer("/data/link").and_then(|v| v.as_str())
            .ok_or_else(|| HostError::UnexpectedResponse("no data.link".into()))?;
        Ok(UploadResult { url: link.to_string(), remote_key: None })
    } else if matches!(status.as_u16(), 401 | 403) {
        Err(HostError::Auth(resp.text().await.unwrap_or_default()))
    } else if status.as_u16() == 429 {
        Err(HostError::QuotaExceeded(resp.text().await.unwrap_or_default()))
    } else {
        Err(HostError::HostError { status: status.as_u16(), message: resp.text().await.unwrap_or_default() })
    }
}
```

- [ ] **Step 3: Run tests, expect PASS**

- [ ] **Step 4: Commit**

```bash
git add core/src/services/image_host/imgur.rs core/src/services/image_host/mod.rs
git commit -m "feat(image-host): imgur uploader"
```

### Task 2.3: sm.ms

**Files:** `core/src/services/image_host/smms.rs`

Wire: POST `https://sm.ms/api/v2/upload` multipart with `smfile=<bytes>`. Optional `Authorization: <token>` (no `Bearer ` prefix per sm.ms docs). Response: `{ "success": true, "data": { "url": "..." } }` or `{ "success": false, "code": "...", "message": "..." }` (note: sm.ms returns 200 even on app-level errors).

Mirror Task 2.2's pattern. Limit 5 MB (`5 * 1024 * 1024`). Test cases: success, app-level `success: false` → `HostError::HostError { status: 200, ... }`, oversize.

Commit: `feat(image-host): sm.ms uploader with 5MB cap`.

### Task 2.4: S3 (covers R2)

**Files:** `core/src/services/image_host/s3.rs`

Wire: signed PUT (SigV4 header-based auth) to `<endpoint>/<bucket>/<key>` (or virtual-hosted style — use path-style for compatibility with R2 / MinIO). Headers: `Authorization`, `x-amz-content-sha256`, `x-amz-date`, `Host`. Body = raw bytes.

Implement SigV4 manually (don't pull `aws-sdk-s3` — too heavy). Steps:
1. Compute `x-amz-content-sha256` = hex(sha256(body))
2. Build canonical request.
3. Build string-to-sign with `AWS4-HMAC-SHA256\n<date>\n<scope>\nhex(sha256(canonical_request))`.
4. Compute signing key: HMAC chain `AWS4<sk>` → date → region → service (`s3`) → `aws4_request`.
5. Final signature = hex(HMAC(signing_key, string_to_sign)).
6. Authorization header.

This is the most complex provider. Reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html and the official pseudocode.

Tests:
- success path with wiremock returning 200 (path-style PUT)
- 403 → `HostError::Auth`
- 5xx → `HostError::HostError`
- region/endpoint omitted → `BadConfig`

Final URL: if `custom_domain` set → `<custom_domain>/<key>`; else `<endpoint>/<bucket>/<key>` (path-style).

Commit: `feat(image-host): s3 uploader with manual sigv4 (covers r2)`.

### Task 2.5: Aliyun OSS

**Files:** `core/src/services/image_host/aliyun_oss.rs`

Wire: signed PUT to `https://<bucket>.<endpoint>/<key>`. Aliyun's "OSS Header signature" scheme (HMAC-SHA1-based, simpler than SigV4):

1. `Date: <RFC1123>`
2. CanonicalizedResource = `/<bucket>/<key>`
3. StringToSign = `PUT\n\n<content-type>\n<date>\n<canonicalized-oss-headers>\n<canonicalized-resource>` (canonicalized-oss-headers empty if none)
4. Signature = base64(HMAC-SHA1(access_key_secret, string_to_sign))
5. `Authorization: OSS <access_key_id>:<signature>`

Reference: https://help.aliyun.com/zh/oss/developer-reference/include-signatures-in-the-authorization-header

Tests: mirror Task 2.4.

Final URL: `custom_domain` if set, else `https://<bucket>.<endpoint>/<key>`.

Commit: `feat(image-host): aliyun oss uploader with hmac-sha1 header signature`.

### Task 2.6: Custom (minimal)

**Files:** `core/src/services/image_host/custom.rs`

Wire: multipart POST to `post_url` with field `file`. Header `Authorization: Bearer <bearer>` if set. Response JSON, try `url` then `data.url`. On parse failure → `UnexpectedResponse`.

Tests: success at `url` field, success at `data.url` field, neither → error.

Commit: `feat(image-host): minimal custom HTTP uploader`.

---

## Phase 3 — Tauri commands

### Task 3.1: Six upload commands + tauri-specta wiring

**Files:** `core/src/commands/image_host.rs`, `core/src/commands/mod.rs`, `core/src/lib.rs`.

- [ ] **Step 1: Create `core/src/commands/image_host.rs`**

```rust
use crate::error::AppError;
use crate::models::image_host::{HostConfig, ImageHostSettings, ProviderConfig};
use crate::services::image_host::{aliyun_oss, custom, imgur, naming, qiniu, s3, smms};
use crate::services::image_host::types::{HostError, UploadInput, UploadResult};

impl From<HostError> for AppError {
    fn from(e: HostError) -> AppError {
        AppError::Custom(e.to_string())
    }
}

fn input(bytes: Vec<u8>, filename: String, mime: String) -> UploadInput {
    let key = naming::generate_key(&filename, &bytes, chrono::Utc::now());
    UploadInput { bytes, filename, mime, key }
}

#[tauri::command]
#[specta::specta]
pub async fn upload_image_qiniu(bytes: Vec<u8>, filename: String, mime: String, config: ProviderConfig) -> Result<UploadResult, AppError> {
    Ok(qiniu::upload(&config, input(bytes, filename, mime)).await?)
}

// ...analogous functions for aliyun_oss, s3, imgur, smms, custom...

#[tauri::command]
#[specta::specta]
pub async fn get_image_host_settings() -> Result<ImageHostSettings, AppError> {
    let g = crate::commands::settings::read_global_settings_pub().await;
    Ok(g.image_hosts.clone())
}

#[tauri::command]
#[specta::specta]
pub async fn set_image_host_settings(settings: ImageHostSettings) -> Result<(), AppError> {
    let mut g = crate::commands::settings::read_global_settings_pub().await;
    g.image_hosts = settings;
    crate::commands::settings::write_global_settings_to_disk_pub(&g).await
}
```

(Add `pub` aliases of the existing private `read_global_settings` / `write_global_settings_to_disk` in `commands/settings.rs` so this module can call them. Or move the helpers up to `pub(crate)`.)

- [ ] **Step 2: Add `pub mod image_host;` to `commands/mod.rs`**

- [ ] **Step 3: Register all six upload commands + two settings commands in BOTH `collect_commands![...]` blocks in `core/src/lib.rs`**

- [ ] **Step 4: `pnpm tauri dev` (let it boot once to regenerate `app/lib/ipc/commands.ts`), kill it.** Verify the new commands appear in the generated file. Run `git diff app/lib/ipc/commands.ts` and confirm the additions.

- [ ] **Step 5: Commit**

```bash
git add core/src/commands/image_host.rs core/src/commands/mod.rs core/src/commands/settings.rs core/src/lib.rs app/lib/ipc/commands.ts
git commit -m "feat(image-host): tauri commands + tauri-specta bindings"
```

---

## Phase 4 — Frontend orchestrator

### Task 4.1: Service module

**Files:** `app/lib/services/image-host.ts`, `tests/unit/image-host-orchestrator.test.ts`.

- [ ] **Step 1: Failing test** — covers: routes Qiniu config to `upload_image_qiniu`, applies project override over global, throws when no active host configured, batch continues after failure.

- [ ] **Step 2: Implement** with public API:

```ts
export async function uploadImage(localPath: string): Promise<{ url: string }>;
export async function uploadAllInDocument(docPath: string, doc: string): Promise<UploadReport>;
export async function uploadInlineBytes(bytes: Uint8Array, suggestedName: string, mime: string): Promise<{ url: string }>;
export type UploadReport = { successes: Array<{ original: string; url: string }>; failures: Array<{ original: string; error: string }>; };
```

Route by `host.config.provider`:

```ts
async function dispatchUpload(host: HostConfig, bytes: Uint8Array, filename: string, mime: string) {
  const args = { bytes: Array.from(bytes), filename, mime, config: host.config };
  switch (host.config.provider) {
    case 'qiniu':       return invoke<UploadResult>('upload_image_qiniu', args);
    case 'aliyun_oss':  return invoke<UploadResult>('upload_image_aliyun_oss', args);
    case 's3':          return invoke<UploadResult>('upload_image_s3', args);
    case 'imgur':       return invoke<UploadResult>('upload_image_imgur', args);
    case 'smms':        return invoke<UploadResult>('upload_image_smms', args);
    case 'custom':      return invoke<UploadResult>('upload_image_custom', args);
  }
}
```

`uploadAllInDocument` parses Markdown for `![](localpath)` (skip http/https URLs), reads each file via `read_image_data_uri` then base64-decodes (or — preferable — adds a new `read_image_bytes` Tauri command that returns `Vec<u8>` directly). For now reuse `read_image_data_uri` and strip the `data:<mime>;base64,` prefix.

- [ ] **Step 3: Run unit tests, expect pass.**

- [ ] **Step 4: Commit**

---

## Phase 5 — Editor + palette integration

### Task 5.1: Image context menu item

**Files:** `app/lib/editor/wysiwyg.ts`

Add a menu item entry "Upload to host" between existing items. On click, resolve the local image path from the widget, call `uploadImage(path)`, then perform a CodeMirror transaction to replace the image's URL portion in the source. Show toast via existing toast mechanism.

### Task 5.2: Palette command — batch upload

**Files:** `app/lib/app-commands.ts`

Register:

```ts
commandRegistry.register({
  id: 'image-host.upload-all',
  label: 'Upload all local images in this document',
  category: 'Document',
  run: async () => {
    const { activeDoc, view } = getEditorContext();
    const report = await uploadAllInDocument(activeDoc.path, view.state.doc.toString());
    // Apply replacements as one transaction
    applyImageUrlReplacements(view, report);
    showToast(`${report.successes.length}/${report.successes.length + report.failures.length} uploaded`);
  },
});
```

### Task 5.3: Auto-on-paste hook

**Files:** `app/lib/editor/wysiwyg.ts` (`imagePastePlugin`)

After the existing local-write step, if `getImageHostSettings().auto_on_paste === true && activeHost`, call `uploadInlineBytes(bytes, ...)` and replace the just-inserted image markdown.

Commit each task; each is one logical unit.

---

## Phase 6 — Settings UI

### Task 6.1: Image Hosts settings panel

**Files:** `app/lib/components/SettingsImageHostsPanel.svelte`, modify whichever component renders the global settings dialog.

Sections:
- **Auto-upload toggle** — checkbox bound to `settings.auto_on_paste`.
- **Hosts list** — each row shows name, provider badge, "active" radio, "Test" button, "Edit" button, "Delete" button.
- **Add Host** dropdown — opens provider picker, then provider-specific form.
- **Provider forms** — one form component per `ProviderConfig` variant. For S3/R2: a "Cloudflare R2 preset" button that fills `endpoint = https://<account>.r2.cloudflarestorage.com` (input the account id) and `region = auto`.
- **Test button** — uploads a 1×1 PNG via the right Tauri command and shows pass/fail with the actual error.

Persist via `set_image_host_settings`.

Commit per logical unit.

---

## Phase 7 — E2E + final CI mirror

### Task 7.1: Browser E2E

**Files:** `tests/e2e/image-host.spec.ts`

Mock IPC for `upload_image_*` commands to return canned URLs. Cases:
- Right-click a rendered image → see "Upload to host" item; click → markdown source updated to remote URL.
- Settings page: add a Custom host, save, see it in list.
- Set active radio; reload settings; active persists.
- Toggle auto-on-paste; persists.
- Palette command: run `image-host.upload-all` on a doc with two local images and one already-remote — expect one Tauri call per local image, both replaced.

### Task 7.2: Live-host-tests opt-in feature

**Files:** `core/Cargo.toml`, `core/tests/image_host_live.rs`

Behind `#[cfg(feature = "live-host-tests")]`. Reads creds from env vars (`NOVELIST_E2E_QINIU_AK`, …). One real upload per provider. Skipped on CI; documented in README that it's opt-in.

### Task 7.3: Local CI mirror + final commit

```bash
cd core && cargo fmt --check && cargo clippy --all-targets -- -D warnings
cd .. && pnpm check
pnpm test
pnpm test:e2e:browser
cd core && cargo test
```

Fix anything red. Final commit: `feat(image-host): v0.2.4 image hosting feature complete`.

Bump `package.json` version to `0.2.4` and `core/Cargo.toml` version to `0.2.4`.

---

## Self-Review (run after writing the plan, before execution)

1. Spec coverage: every section of the spec has a task. ✓
2. Placeholder scan: no TBDs / "implement later" / "add error handling" without showing code. Provider tasks 2.3–2.6 reference doc URLs and describe wire format rather than copying every line — acceptable given the per-provider repetition would balloon the plan with no information value, and tasks 2.1 and 2.2 demonstrate the full pattern (test scaffold, signing/auth code, error mapping, commit) that 2.3–2.6 mirror.
3. Type consistency: `UploadResult.url`, `UploadResult.remote_key`, `HostError` variants, `ImageHostSettings.auto_on_paste`, `ProviderConfig` tag = "provider" with snake_case discriminants. Used consistently.
4. The `read_image_bytes` open question is noted in Task 4.1 with a fallback (reuse `read_image_data_uri`, strip prefix). Acceptable.
