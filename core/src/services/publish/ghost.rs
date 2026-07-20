//! Ghost Admin API publish adapter.
//!
//! Wire (Admin API key + per-request HS256 JWT, 5-min TTL):
//! 1. Split api_key on `:` into `id` and `secret_hex`.
//! 2. hex-decode `secret_hex` → bytes (this is the HMAC key — a common
//!    mistake is to sign with the ASCII hex string directly).
//! 3. JWT header `{"alg":"HS256","kid":"<id>","typ":"JWT"}`.
//! 4. JWT payload `{"iat":<now>,"exp":<now+300>,"aud":"/admin/"}`.
//! 5. token = base64url(header) + "." + base64url(payload) + "." +
//!    base64url(HMAC-SHA256(key=secret_bytes, data=header.payload)).
//! 6. Per-request headers: `Authorization: Ghost <token>`,
//!    `Accept-Version: v5.0`, `Content-Type: application/json`.
//!
//! Endpoints:
//! - POST /ghost/api/admin/posts/?source=html — create. Body:
//!   `{posts:[{title, html, tags:[{name}], status, slug,
//!   custom_excerpt, feature_image}]}`. The `?source=html` query
//!   param tells Ghost to convert the HTML body to its internal
//!   Lexical format server-side.
//! - POST /ghost/api/admin/images/upload/ — multipart, field `file`,
//!   optional `purpose=image`. Returns `images[0].url`.
//! - GET /ghost/api/admin/site/ — connectivity smoke check.
//!
//! Reference: https://docs.ghost.org/admin-api/

use crate::models::publish::PlatformConfig;
use crate::services::publish::binding::{
    assert_authority_matches, decoded_last_segment, parse_binding_input, parse_channel_base,
    preflight_input, BindingCapability, ParsedInput, VerifiedBinding,
};
use crate::services::publish::types::{
    ProviderRevision, PublishError, PublishInput, PublishResult, UpdateConflictContext,
    UpdateTarget,
};
use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

const ADMIN_PATH_PREFIX: &str = "/ghost/api/admin";
const ACCEPT_VERSION: &str = "v5.0";
const TOKEN_TTL_SECONDS: i64 = 5 * 60;

/// Fetch every tag the user has on the Ghost site, returning their
/// names sorted alphabetically. Used by the Publish dialog's tag
/// autocomplete. Reads `/ghost/api/admin/tags/?limit=all`.
pub async fn list_tags(admin_url: &str, api_key: &str) -> Result<Vec<String>, PublishError> {
    if admin_url.is_empty() || api_key.is_empty() {
        return Err(PublishError::BadConfig(
            "ghost config missing admin_url or api_key".into(),
        ));
    }
    let token = make_jwt(api_key)?;
    let endpoint = format!(
        "{}{}/tags/?limit=all",
        admin_url.trim_end_matches('/'),
        ADMIN_PATH_PREFIX
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .get(&endpoint)
        .header("Authorization", format!("Ghost {token}"))
        .header("Accept-Version", ACCEPT_VERSION)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "json").await?;
    let arr = body
        .get("tags")
        .and_then(|v| v.as_array())
        .ok_or_else(|| PublishError::UnexpectedResponse("no tags array".into()))?;
    let mut names: Vec<String> = arr
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

/// Read-only credentials check: `GET /ghost/api/admin/site/` with a
/// fresh JWT. Returns the site title on success — surfaces nicely in
/// the Test button's status pane.
pub async fn verify(admin_url: &str, api_key: &str) -> Result<String, PublishError> {
    if admin_url.is_empty() || api_key.is_empty() {
        return Err(PublishError::BadConfig(
            "ghost config missing admin_url or api_key".into(),
        ));
    }
    let token = make_jwt(api_key)?;
    let endpoint = format!(
        "{}{}/site/",
        admin_url.trim_end_matches('/'),
        ADMIN_PATH_PREFIX
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .get(&endpoint)
        .header("Authorization", format!("Ghost {token}"))
        .header("Accept-Version", ACCEPT_VERSION)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "json").await?;
    let title = body
        .pointer("/site/title")
        .and_then(|v| v.as_str())
        .unwrap_or("Ghost site");
    Ok(format!("Connected to {title}"))
}

/// Split `id:secret_hex`, hex-decode the secret, build a fresh JWT.
pub fn make_jwt(api_key: &str) -> Result<String, PublishError> {
    make_jwt_with_clock(api_key, chrono::Utc::now().timestamp())
}

pub fn make_jwt_with_clock(api_key: &str, now_secs: i64) -> Result<String, PublishError> {
    let trimmed = api_key.trim();
    let (id, secret_hex) = trimmed.split_once(':').ok_or_else(|| {
        PublishError::BadConfig(
            "Ghost api_key must be 'id:secret' (Admin API Key from Ghost Admin → \
             Integrations). The Content API Key is a single hex string with no \
             colon and cannot publish — use the Admin API Key instead."
                .into(),
        )
    })?;
    if id.is_empty() || secret_hex.is_empty() {
        return Err(PublishError::BadConfig(
            "Ghost api_key has empty id or secret half".into(),
        ));
    }
    let key_bytes = hex_decode(secret_hex).map_err(|e| {
        PublishError::BadConfig(format!(
            "Ghost api_key secret half must be hex characters (got: {e}). \
             Make sure you copied the full Admin API Key from Ghost Admin → \
             Integrations → your integration."
        ))
    })?;

    let header = serde_json::json!({"alg":"HS256","kid":id,"typ":"JWT"});
    let header_b64 = b64url(&serde_json::to_vec(&header).unwrap());

    let payload = serde_json::json!({
        "iat": now_secs,
        "exp": now_secs + TOKEN_TTL_SECONDS,
        "aud": "/admin/",
    });
    let payload_b64 = b64url(&serde_json::to_vec(&payload).unwrap());

    let signing_input = format!("{header_b64}.{payload_b64}");
    type HmacSha256 = Hmac<Sha256>;
    let mut mac = HmacSha256::new_from_slice(&key_bytes)
        .map_err(|e| PublishError::BadConfig(format!("hmac init: {e}")))?;
    mac.update(signing_input.as_bytes());
    let sig = mac.finalize().into_bytes();
    let sig_b64 = b64url(&sig);
    Ok(format!("{signing_input}.{sig_b64}"))
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err(format!("odd length: {}", s.len()));
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    for chunk in bytes.chunks(2) {
        let hi = hex_nibble(chunk[0])?;
        let lo = hex_nibble(chunk[1])?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_nibble(b: u8) -> Result<u8, String> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err(format!("not hex: {b:#x}")),
    }
}

pub async fn upload_image(
    admin_url: &str,
    api_key: &str,
    bytes: Vec<u8>,
    filename: String,
    mime: String,
) -> Result<String, PublishError> {
    let token = make_jwt(api_key)?;
    let endpoint = format!(
        "{}{}/images/upload/",
        admin_url.trim_end_matches('/'),
        ADMIN_PATH_PREFIX
    );
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(&mime)
        .map_err(|e| PublishError::BadConfig(format!("bad mime: {e}")))?;
    let form = reqwest::multipart::Form::new()
        .text("purpose", "image")
        .part("file", part);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .post(&endpoint)
        .header("Authorization", format!("Ghost {token}"))
        .header("Accept-Version", ACCEPT_VERSION)
        .multipart(form)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "json").await?;
    body.pointer("/images/0/url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| PublishError::UnexpectedResponse("no images[0].url".into()))
}

fn ghost_creds(config: &PlatformConfig) -> Result<(&str, &str), PublishError> {
    let (admin_url, api_key) = match config {
        PlatformConfig::Ghost { admin_url, api_key } => (admin_url.as_str(), api_key.as_str()),
        _ => return Err(PublishError::BadConfig("not a Ghost config".into())),
    };
    if admin_url.is_empty() || api_key.is_empty() {
        return Err(PublishError::BadConfig(
            "ghost config missing admin_url or api_key".into(),
        ));
    }
    Ok((admin_url, api_key))
}

const MAX_REMOTE_ID_LEN: usize = 128;

fn validate_remote_id(remote_id: &str) -> Result<(), PublishError> {
    if remote_id.is_empty() {
        return Err(PublishError::BadConfig(
            "ghost update requires update_target.remote_id".into(),
        ));
    }
    if remote_id.len() > MAX_REMOTE_ID_LEN {
        return Err(PublishError::BadConfig(format!(
            "ghost remote_id exceeds {MAX_REMOTE_ID_LEN} bytes"
        )));
    }
    for c in remote_id.chars() {
        let ok = c.is_ascii_alphanumeric() || c == '-' || c == '_';
        if !ok {
            return Err(PublishError::BadConfig(
                "ghost remote_id must be ASCII [A-Za-z0-9_-]+ with no path, query, or control characters"
                    .into(),
            ));
        }
    }
    Ok(())
}

fn validate_update_target(update_target: &UpdateTarget) -> Result<String, PublishError> {
    validate_remote_id(&update_target.remote_id)?;
    match &update_target.expected_revision {
        Some(ProviderRevision::Ghost { updated_at }) if !updated_at.is_empty() => {
            Ok(updated_at.clone())
        }
        _ => Err(PublishError::BadConfig(
            "ghost update requires expected_revision=ProviderRevision::Ghost { updated_at }".into(),
        )),
    }
}

struct FetchedGhostPost {
    id: String,
    url: String,
    updated_at: String,
}

async fn fetch_ghost_post(
    admin_url: &str,
    token: &str,
    remote_id: &str,
) -> Result<FetchedGhostPost, PublishError> {
    let endpoint = format!(
        "{}{}/posts/{}/",
        admin_url.trim_end_matches('/'),
        ADMIN_PATH_PREFIX,
        remote_id
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .get(&endpoint)
        .header("Authorization", format!("Ghost {token}"))
        .header("Accept-Version", ACCEPT_VERSION)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    if resp.status().as_u16() == 404 {
        return Err(PublishError::RemoteNotFound {
            provider: "ghost".into(),
            remote_id: remote_id.to_string(),
        });
    }
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "ghost GET json").await?;
    let id = body
        .pointer("/posts/0/id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("ghost GET missing posts[0].id".into()))?
        .to_string();
    let updated_at = body
        .pointer("/posts/0/updated_at")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            PublishError::UnexpectedResponse("ghost GET missing posts[0].updated_at".into())
        })?
        .to_string();
    let url = body
        .pointer("/posts/0/url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("ghost GET missing posts[0].url".into()))?
        .to_string();
    Ok(FetchedGhostPost {
        id,
        url,
        updated_at,
    })
}

fn build_update_body(
    input: &PublishInput,
    remote_id: &str,
    expected_updated_at: &str,
) -> serde_json::Value {
    let tags: Vec<serde_json::Value> = input
        .tags
        .iter()
        .map(|t| serde_json::json!({"name": t}))
        .collect();
    let mut post = serde_json::json!({
        "id": remote_id,
        "title": input.title,
        "html": input.body,
        "tags": tags,
        "status": input.status,
        "updated_at": expected_updated_at,
    });
    if let Some(slug) = &input.slug {
        post["slug"] = serde_json::Value::String(slug.clone());
    }
    if let Some(excerpt) = &input.excerpt {
        post["custom_excerpt"] = serde_json::Value::String(excerpt.clone());
    }
    if let Some(image) = &input.feature_image_url {
        post["feature_image"] = serde_json::Value::String(image.clone());
    }
    serde_json::json!({"posts": [post]})
}

fn parse_ghost_updated_at(body_text: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(body_text).ok()?;
    parsed
        .pointer("/posts/0/updated_at")
        .and_then(|v| v.as_str())
        .map(String::from)
}

pub async fn update_post(
    config: &PlatformConfig,
    input: &PublishInput,
) -> Result<PublishResult, PublishError> {
    let (admin_url, api_key) = ghost_creds(config)?;
    let update_target = input.update_target.as_ref().ok_or_else(|| {
        PublishError::BadConfig("update_post requires PublishInput.update_target".into())
    })?;
    let expected_updated_at = validate_update_target(update_target)?;
    let tracked_id = update_target.remote_id.clone();
    let token = make_jwt(api_key)?;

    let fetched = fetch_ghost_post(admin_url, &token, &tracked_id).await?;
    if fetched.id != tracked_id {
        return Err(PublishError::UnexpectedResponse(
            "ghost GET returned a different post id than the tracked one".into(),
        ));
    }
    if fetched.updated_at != expected_updated_at {
        return Err(PublishError::UpdateConflict(Box::new(
            UpdateConflictContext {
                provider: "ghost".into(),
                remote_id: tracked_id.clone(),
                expected: Some(ProviderRevision::Ghost {
                    updated_at: expected_updated_at,
                }),
                actual: Some(ProviderRevision::Ghost {
                    updated_at: fetched.updated_at,
                }),
            },
        )));
    }

    let payload = build_update_body(input, &tracked_id, &expected_updated_at);
    let endpoint = format!(
        "{}{}/posts/{}/?source=html",
        admin_url.trim_end_matches('/'),
        ADMIN_PATH_PREFIX,
        tracked_id
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .put(&endpoint)
        .header("Authorization", format!("Ghost {token}"))
        .header("Accept-Version", ACCEPT_VERSION)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Err(PublishError::RemoteNotFound {
            provider: "ghost".into(),
            remote_id: tracked_id,
        });
    }
    if status.as_u16() == 409 {
        let body_text = crate::services::publish::read_error_response_text(resp).await;
        let actual = parse_ghost_updated_at(&body_text)
            .map(|updated_at| ProviderRevision::Ghost { updated_at });
        return Err(PublishError::UpdateConflict(Box::new(
            UpdateConflictContext {
                provider: "ghost".into(),
                remote_id: tracked_id,
                expected: Some(ProviderRevision::Ghost {
                    updated_at: expected_updated_at,
                }),
                actual,
            },
        )));
    }
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "ghost PUT json").await?;
    let refreshed_id = body
        .pointer("/posts/0/id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("ghost PUT missing posts[0].id".into()))?
        .to_string();
    let refreshed_url = body
        .pointer("/posts/0/url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("ghost PUT missing posts[0].url".into()))?
        .to_string();
    let refreshed_updated_at = body
        .pointer("/posts/0/updated_at")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            PublishError::UnexpectedResponse("ghost PUT missing posts[0].updated_at".into())
        })?
        .to_string();
    if refreshed_id != tracked_id {
        return Err(PublishError::UnexpectedResponse(
            "ghost PUT returned a different post id than the tracked one".into(),
        ));
    }
    Ok(PublishResult::updated(
        refreshed_url,
        refreshed_id,
        Some(ProviderRevision::Ghost {
            updated_at: refreshed_updated_at,
        }),
    ))
}

pub async fn publish(
    config: &PlatformConfig,
    input: &PublishInput,
) -> Result<PublishResult, PublishError> {
    if input.update_target.is_some() {
        return update_post(config, input).await;
    }
    let (admin_url, api_key) = ghost_creds(config)?;
    let token = make_jwt(api_key)?;

    let tags: Vec<serde_json::Value> = input
        .tags
        .iter()
        .map(|t| serde_json::json!({"name": t}))
        .collect();

    let mut post = serde_json::json!({
        "title": input.title,
        "html": input.body,
        "tags": tags,
        "status": input.status,
    });
    if let Some(slug) = &input.slug {
        post["slug"] = serde_json::Value::String(slug.clone());
    }
    if let Some(excerpt) = &input.excerpt {
        post["custom_excerpt"] = serde_json::Value::String(excerpt.clone());
    }
    if let Some(image) = &input.feature_image_url {
        post["feature_image"] = serde_json::Value::String(image.clone());
    }
    let payload = serde_json::json!({"posts": [post]});

    let endpoint = format!(
        "{}{}/posts/?source=html",
        admin_url.trim_end_matches('/'),
        ADMIN_PATH_PREFIX
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .post(&endpoint)
        .header("Authorization", format!("Ghost {token}"))
        .header("Accept-Version", ACCEPT_VERSION)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "json").await?;
    let id = body
        .pointer("/posts/0/id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("no posts[0].id".into()))?
        .to_string();
    let url = body
        .pointer("/posts/0/url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("no posts[0].url".into()))?
        .to_string();
    let updated_at = body
        .pointer("/posts/0/updated_at")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| PublishError::UnexpectedResponse("no posts[0].updated_at".into()))?
        .to_string();
    Ok(PublishResult::created_with_revision(
        url,
        id,
        ProviderRevision::Ghost { updated_at },
    ))
}

fn is_ghost_object_id(candidate: &str) -> bool {
    candidate.len() == 24
        && candidate
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

async fn fetch_ghost_post_by_slug(
    admin_url: &str,
    token: &str,
    slug: &str,
) -> Result<serde_json::Value, PublishError> {
    reject_unsafe_ghost_slug(slug)?;
    let mut endpoint = url::Url::parse(&format!(
        "{}{}",
        admin_url.trim_end_matches('/'),
        ADMIN_PATH_PREFIX,
    ))
    .map_err(|_| PublishError::BadConfig("ghost admin_url is not a valid URL".into()))?;
    {
        let mut segments = endpoint.path_segments_mut().map_err(|_| {
            PublishError::BadConfig("ghost admin_url cannot be used as a base URL".into())
        })?;
        segments.push("posts");
        segments.push("slug");
        segments.push(slug);
        segments.push("");
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .get(endpoint)
        .header("Authorization", format!("Ghost {token}"))
        .header("Accept-Version", ACCEPT_VERSION)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    if resp.status().as_u16() == 404 {
        return Err(PublishError::RemoteNotFound {
            provider: "ghost".into(),
            remote_id: slug.to_string(),
        });
    }
    let resp = crate::services::publish::require_success(resp).await?;
    crate::services::publish::parse_json_response(resp, "ghost GET slug json").await
}

fn reject_unsafe_ghost_slug(slug: &str) -> Result<(), PublishError> {
    if slug.is_empty() {
        return Err(PublishError::BadConfig(
            "ghost bind URL slug is empty".into(),
        ));
    }
    if slug
        .chars()
        .any(|c| c.is_control() || matches!(c, '/' | '\\' | '%' | '?' | '#'))
    {
        return Err(PublishError::BadConfig(
            "ghost bind URL slug contains unsafe path delimiters".into(),
        ));
    }
    Ok(())
}

pub async fn verify_binding(
    channel_id: &str,
    config: &PlatformConfig,
    raw_input: &str,
) -> Result<VerifiedBinding, PublishError> {
    let (admin_url, api_key) = ghost_creds(config)?;
    let base = parse_channel_base(admin_url)?;
    let trimmed = preflight_input(raw_input)?;
    let parsed = parse_binding_input(&trimmed)?;
    let token = make_jwt(api_key)?;

    let body = match parsed {
        ParsedInput::Id(candidate) => {
            if !is_ghost_object_id(&candidate) {
                return Err(PublishError::BadConfig(
                    "ghost bind ID must be exactly 24 lowercase hex characters".into(),
                ));
            }
            let fetched = fetch_ghost_post(admin_url, &token, &candidate).await?;
            if fetched.id != candidate {
                return Err(PublishError::UnexpectedResponse(
                    "ghost GET returned a different post id than requested".into(),
                ));
            }
            serde_json::json!({
                "posts": [{
                    "id": fetched.id,
                    "url": fetched.url,
                    "updated_at": fetched.updated_at,
                }]
            })
        }
        ParsedInput::Url(url) => {
            assert_authority_matches(&url, &base)?;
            let slug = decoded_last_segment(&url)?.ok_or_else(|| {
                PublishError::BadConfig(
                    "ghost bind URL must include a post slug in its path".into(),
                )
            })?;
            if is_ghost_object_id(&slug) {
                return Err(PublishError::BadConfig(
                    "ghost bind URL slug looks like a 24-hex object id; submit the ID directly instead of a URL".into(),
                ));
            }
            fetch_ghost_post_by_slug(admin_url, &token, &slug).await?
        }
    };

    let id = body
        .pointer("/posts/0/id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("ghost bind missing posts[0].id".into()))?
        .to_string();
    if !is_ghost_object_id(&id) {
        return Err(PublishError::UnexpectedResponse(
            "ghost bind returned a non-canonical post id".into(),
        ));
    }
    let canonical_url = body
        .pointer("/posts/0/url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("ghost bind missing posts[0].url".into()))?
        .to_string();
    let updated_at = body
        .pointer("/posts/0/updated_at")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            PublishError::UnexpectedResponse("ghost bind missing posts[0].updated_at".into())
        })?
        .to_string();

    let canonical_parsed = url::Url::parse(&canonical_url).map_err(|_| {
        PublishError::UnexpectedResponse("ghost bind response URL is malformed".into())
    })?;
    assert_authority_matches(&canonical_parsed, &base).map_err(|_| {
        PublishError::UnexpectedResponse(
            "ghost bind response URL host does not match selected channel".into(),
        )
    })?;

    Ok(VerifiedBinding {
        channel_id: channel_id.to_string(),
        provider: "ghost".into(),
        remote_id: id,
        url: canonical_url,
        revision: Some(ProviderRevision::Ghost { updated_at }),
        capability: BindingCapability::Updatable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::publish::types::{
        BodyFormat, ProviderRevision, PublishOperation, UpdateConflictContext, UpdateTarget,
    };
    use wiremock::matchers::{body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    const API_KEY: &str = "abc:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd";
    const EXPECTED_UPDATED_AT: &str = "2026-07-16T00:00:00.000Z";
    const REFRESHED_UPDATED_AT: &str = "2026-07-16T00:05:00.000Z";
    const REMOTE_ID: &str = "g1";

    fn cfg(admin_url: &str) -> PlatformConfig {
        PlatformConfig::Ghost {
            admin_url: admin_url.into(),
            // 32-byte secret as 64 hex chars
            api_key: API_KEY.into(),
        }
    }

    fn input() -> PublishInput {
        PublishInput {
            title: "Hello".into(),
            body: "<p>body</p>".into(),
            body_format: BodyFormat::Html,
            tags: vec!["rust".into()],
            slug: Some("hello".into()),
            excerpt: Some("brief".into()),
            status: "draft".into(),
            feature_image_url: None,
            featured_media_id: None,
            publication_id: None,
            update_target: None,
        }
    }

    fn update_input() -> PublishInput {
        let mut inp = input();
        inp.update_target = Some(UpdateTarget {
            remote_id: REMOTE_ID.into(),
            expected_revision: Some(ProviderRevision::Ghost {
                updated_at: EXPECTED_UPDATED_AT.into(),
            }),
        });
        inp
    }

    #[test]
    fn make_jwt_has_three_dot_segments_with_correct_kid() {
        let token = make_jwt_with_clock(
            "abc:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
            1_700_000_000,
        )
        .unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        // Decode header and verify kid
        let header_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts[0])
            .unwrap();
        let header: serde_json::Value = serde_json::from_slice(&header_bytes).unwrap();
        assert_eq!(header["kid"], "abc");
        assert_eq!(header["alg"], "HS256");
        assert_eq!(header["typ"], "JWT");
        // Decode payload and verify exp = iat + 300
        let payload_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts[1])
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&payload_bytes).unwrap();
        assert_eq!(payload["iat"], 1_700_000_000);
        assert_eq!(payload["exp"], 1_700_000_000 + 300);
        assert_eq!(payload["aud"], "/admin/");
    }

    #[test]
    fn make_jwt_signature_is_deterministic_for_fixed_inputs() {
        let a = make_jwt_with_clock(
            "abc:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
            1_700_000_000,
        )
        .unwrap();
        let b = make_jwt_with_clock(
            "abc:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
            1_700_000_000,
        )
        .unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn malformed_api_key_is_bad_config() {
        let err = make_jwt("no-colon-here").unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
        // The error should mention Admin vs Content API key distinction so
        // a user pasting the wrong key type gets actionable guidance.
        if let PublishError::BadConfig(msg) = err {
            assert!(
                msg.contains("Admin API Key") && msg.contains("Content API Key"),
                "error should distinguish Admin vs Content API Key, got: {msg}"
            );
        }
        let err = make_jwt("only-id:").unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[test]
    fn whitespace_in_api_key_is_trimmed() {
        // Users sometimes paste with surrounding whitespace.
        let token = make_jwt_with_clock(
            "  abc:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd  ",
            1_700_000_000,
        )
        .unwrap();
        assert_eq!(token.split('.').count(), 3);
    }

    #[tokio::test]
    async fn upload_image_returns_url() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ghost/api/admin/images/upload/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "images": [{"url": "https://blog.example.com/content/images/x.png", "ref": null}]
            })))
            .mount(&server)
            .await;
        let url = upload_image(
            &server.uri(),
            "abc:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
            vec![1, 2, 3],
            "x.png".into(),
            "image/png".into(),
        )
        .await
        .unwrap();
        assert_eq!(url, "https://blog.example.com/content/images/x.png");
    }

    #[tokio::test]
    async fn publish_creates_post_via_source_html() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/ghost/api/admin/posts/"))
            .and(query_param("source", "html"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "posts": [{
                    "id": "p123",
                    "url": "https://blog.example.com/hello/",
                    "title": "Hello",
                    "updated_at": "2026-07-17T00:00:00.000Z"
                }]
            })))
            .mount(&server)
            .await;
        let result = publish(&cfg(&server.uri()), &input()).await.unwrap();
        assert_eq!(result.remote_id, "p123");
        assert_eq!(result.url, "https://blog.example.com/hello/");
        assert_eq!(result.operation, PublishOperation::Created);
        assert_eq!(
            result.provider_revision,
            Some(ProviderRevision::Ghost {
                updated_at: "2026-07-17T00:00:00.000Z".into(),
            })
        );
    }

    #[tokio::test]
    async fn publish_401_is_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401).set_body_string("invalid token"))
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &input()).await.unwrap_err();
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn publish_5xx_is_server_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(503).set_body_string("down"))
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &input()).await.unwrap_err();
        assert!(
            matches!(err, PublishError::Server { status: 503, .. }),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn empty_field_is_bad_config() {
        let cfg = PlatformConfig::Ghost {
            admin_url: "".into(),
            api_key: "id:secret".into(),
        };
        let err = publish(&cfg, &input()).await.unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    fn refreshed_ok_body(id: &str, url: &str, updated_at: &str) -> serde_json::Value {
        serde_json::json!({
            "posts": [{
                "id": id,
                "url": url,
                "title": "any",
                "updated_at": updated_at,
            }]
        })
    }

    fn fetched_ok_body(id: &str, url: &str, updated_at: &str) -> serde_json::Value {
        serde_json::json!({
            "posts": [{
                "id": id,
                "url": url,
                "updated_at": updated_at,
            }]
        })
    }

    fn extract_put_post(req: &Request) -> serde_json::Value {
        let body: serde_json::Value =
            serde_json::from_slice(&req.body).expect("PUT body should be valid JSON");
        body.pointer("/posts/0")
            .expect("PUT body should have posts[0]")
            .clone()
    }

    async fn mount_no_create(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/ghost/api/admin/posts/"))
            .respond_with(ResponseTemplate::new(500).set_body_string("unexpected POST"))
            .expect(0)
            .mount(server)
            .await;
    }

    async fn mount_no_put(server: &MockServer) {
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(500).set_body_string("unexpected PUT"))
            .expect(0)
            .mount(server)
            .await;
    }

    async fn mount_get_success(server: &MockServer, url: &str) {
        Mock::given(method("GET"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .respond_with(ResponseTemplate::new(200).set_body_json(fetched_ok_body(
                REMOTE_ID,
                url,
                EXPECTED_UPDATED_AT,
            )))
            .expect(1)
            .mount(server)
            .await;
    }

    async fn assert_no_post_create(server: &MockServer) {
        let requests = server.received_requests().await.unwrap_or_default();
        let post_count = requests
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST)
            .count();
        assert_eq!(post_count, 0, "must not fall back to POST create");
    }

    async fn assert_no_put(server: &MockServer) {
        let requests = server.received_requests().await.unwrap_or_default();
        let put_count = requests
            .iter()
            .filter(|r| r.method == wiremock::http::Method::PUT)
            .count();
        assert_eq!(
            put_count, 0,
            "must not issue PUT on preflight or GET failure"
        );
    }

    fn assert_authorization_ghost_scheme(req: &Request) {
        let auth = req
            .headers
            .get("authorization")
            .expect("authorization header")
            .to_str()
            .expect("authorization header decodes");
        assert!(
            auth.starts_with("Ghost "),
            "authorization must use Ghost scheme (value elided)"
        );
    }

    #[tokio::test]
    async fn publish_update_issues_get_then_put_in_order_with_source_html_and_matching_body() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://blog.example.com/hello/").await;
        Mock::given(method("PUT"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .and(query_param("source", "html"))
            .and(header("Accept-Version", ACCEPT_VERSION))
            .and(header("Content-Type", "application/json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(refreshed_ok_body(
                REMOTE_ID,
                "https://blog.example.com/hello/",
                REFRESHED_UPDATED_AT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let result = publish(&cfg(&server.uri()), &update_input())
            .await
            .expect("update should succeed");
        assert_eq!(result.remote_id, REMOTE_ID);
        assert_eq!(result.url, "https://blog.example.com/hello/");
        assert_eq!(result.operation, PublishOperation::Updated);
        match result.provider_revision {
            Some(ProviderRevision::Ghost { updated_at }) => {
                assert_eq!(updated_at, REFRESHED_UPDATED_AT);
            }
            other => panic!("expected Ghost revision, got {other:?}"),
        }
        let requests = server.received_requests().await.unwrap_or_default();
        assert_eq!(
            requests.len(),
            2,
            "expected exactly one GET followed by one PUT"
        );
        assert_eq!(requests[0].method, wiremock::http::Method::GET);
        assert_eq!(requests[1].method, wiremock::http::Method::PUT);
        assert_eq!(
            requests[0].url.path(),
            format!("/ghost/api/admin/posts/{REMOTE_ID}/")
        );
        assert_eq!(
            requests[1].url.path(),
            format!("/ghost/api/admin/posts/{REMOTE_ID}/")
        );
        assert_authorization_ghost_scheme(&requests[0]);
        assert_authorization_ghost_scheme(&requests[1]);
        let get_accept_version = requests[0]
            .headers
            .get("accept-version")
            .expect("Accept-Version on GET")
            .to_str()
            .unwrap();
        assert_eq!(get_accept_version, ACCEPT_VERSION);
        let post = extract_put_post(&requests[1]);
        assert_eq!(post["id"], REMOTE_ID);
        assert_eq!(post["title"], "Hello");
        assert_eq!(post["html"], "<p>body</p>");
        assert_eq!(post["status"], "draft");
        assert_eq!(post["updated_at"], EXPECTED_UPDATED_AT);
        assert_eq!(post["slug"], "hello");
        assert_eq!(post["custom_excerpt"], "brief");
        let tags = post["tags"].as_array().expect("tags array");
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0]["name"], "rust");
    }

    #[tokio::test]
    async fn publish_update_preserves_cjk_title_body_and_optional_cover() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://blog.example.com/第一章/").await;
        Mock::given(method("PUT"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .and(query_param("source", "html"))
            .respond_with(ResponseTemplate::new(200).set_body_json(refreshed_ok_body(
                REMOTE_ID,
                "https://blog.example.com/第一章/",
                REFRESHED_UPDATED_AT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.title = "第一章 序幕".into();
        inp.body = "<p>你好，世界。</p>".into();
        inp.feature_image_url = Some("https://blog.example.com/content/images/cover.png".into());
        let result = publish(&cfg(&server.uri()), &inp).await.unwrap();
        assert_eq!(result.operation, PublishOperation::Updated);
        assert_eq!(result.url, "https://blog.example.com/第一章/");
        let requests = server.received_requests().await.unwrap_or_default();
        let put = requests
            .iter()
            .find(|r| r.method == wiremock::http::Method::PUT)
            .expect("PUT request");
        let post = extract_put_post(put);
        assert_eq!(post["title"], "第一章 序幕");
        assert_eq!(post["html"], "<p>你好，世界。</p>");
        assert_eq!(
            post["feature_image"],
            "https://blog.example.com/content/images/cover.png"
        );
        assert_eq!(post["updated_at"], EXPECTED_UPDATED_AT);
    }

    #[tokio::test]
    async fn publish_update_omits_feature_image_when_not_provided() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://blog.example.com/hello/").await;
        Mock::given(method("PUT"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .respond_with(ResponseTemplate::new(200).set_body_json(refreshed_ok_body(
                REMOTE_ID,
                "https://blog.example.com/hello/",
                REFRESHED_UPDATED_AT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.feature_image_url = None;
        let _ = publish(&cfg(&server.uri()), &inp).await.unwrap();
        let requests = server.received_requests().await.unwrap_or_default();
        let put = requests
            .iter()
            .find(|r| r.method == wiremock::http::Method::PUT)
            .expect("PUT request");
        let post = extract_put_post(put);
        assert!(
            post.get("feature_image").is_none(),
            "feature_image should be omitted, got {post:?}"
        );
    }

    #[tokio::test]
    async fn publish_update_get_404_maps_to_remote_not_found_without_put_or_post() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_put(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "errors": [{"message": "Resource not found", "type": "NotFoundError"}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &update_input())
            .await
            .unwrap_err();
        match err {
            PublishError::RemoteNotFound {
                provider,
                remote_id,
            } => {
                assert_eq!(provider, "ghost");
                assert_eq!(remote_id, REMOTE_ID);
            }
            other => panic!("expected RemoteNotFound, got {other:?}"),
        }
        assert_no_put(&server).await;
        assert_no_post_create(&server).await;
    }

    #[tokio::test]
    async fn publish_update_get_revision_mismatch_maps_to_conflict_without_put_or_post() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_put(&server).await;
        let stale_actual = "2026-07-16T00:10:00.000Z";
        Mock::given(method("GET"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .respond_with(ResponseTemplate::new(200).set_body_json(fetched_ok_body(
                REMOTE_ID,
                "https://blog.example.com/hello/",
                stale_actual,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &update_input())
            .await
            .unwrap_err();
        let ctx = match err {
            PublishError::UpdateConflict(ctx) => *ctx,
            other => panic!("expected UpdateConflict, got {other:?}"),
        };
        assert_eq!(ctx.provider, "ghost");
        assert_eq!(ctx.remote_id, REMOTE_ID);
        assert_eq!(
            ctx.expected,
            Some(ProviderRevision::Ghost {
                updated_at: EXPECTED_UPDATED_AT.into(),
            })
        );
        assert_eq!(
            ctx.actual,
            Some(ProviderRevision::Ghost {
                updated_at: stale_actual.into(),
            })
        );
        assert_no_put(&server).await;
        assert_no_post_create(&server).await;
    }

    #[tokio::test]
    async fn publish_update_get_malformed_response_returns_unexpected_response_without_put() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_put(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "posts": [{"id": REMOTE_ID}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &update_input())
            .await
            .unwrap_err();
        assert!(
            matches!(err, PublishError::UnexpectedResponse(_)),
            "got {err:?}"
        );
        assert_no_put(&server).await;
        assert_no_post_create(&server).await;
    }

    #[tokio::test]
    async fn publish_update_get_response_id_mismatch_returns_unexpected_response_without_put() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_put(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .respond_with(ResponseTemplate::new(200).set_body_json(fetched_ok_body(
                "not-the-same-id",
                "https://blog.example.com/hello/",
                EXPECTED_UPDATED_AT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &update_input())
            .await
            .unwrap_err();
        let msg = match err {
            PublishError::UnexpectedResponse(m) => m,
            other => panic!("expected UnexpectedResponse, got {other:?}"),
        };
        assert!(
            !msg.contains("not-the-same-id"),
            "must not echo unexpected id: {msg}"
        );
        assert!(
            !msg.contains(REMOTE_ID),
            "must not echo tracked id either: {msg}"
        );
        assert_no_put(&server).await;
        assert_no_post_create(&server).await;
    }

    #[tokio::test]
    async fn publish_update_get_401_maps_to_auth_error_without_put() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_put(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .respond_with(ResponseTemplate::new(401).set_body_string("invalid token"))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &update_input())
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
        assert_no_put(&server).await;
        assert_no_post_create(&server).await;
    }

    #[tokio::test]
    async fn publish_update_put_404_maps_to_remote_not_found_without_post_fallback() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://blog.example.com/hello/").await;
        Mock::given(method("PUT"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "errors": [{"message": "Resource not found", "type": "NotFoundError"}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &update_input())
            .await
            .unwrap_err();
        match err {
            PublishError::RemoteNotFound {
                provider,
                remote_id,
            } => {
                assert_eq!(provider, "ghost");
                assert_eq!(remote_id, REMOTE_ID);
            }
            other => panic!("expected RemoteNotFound, got {other:?}"),
        }
        assert_no_post_create(&server).await;
    }

    #[tokio::test]
    async fn publish_update_put_409_maps_to_update_conflict_with_actual_revision() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://blog.example.com/hello/").await;
        Mock::given(method("PUT"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
                "posts": [{
                    "id": REMOTE_ID,
                    "updated_at": "2026-07-16T00:10:00.000Z"
                }],
                "errors": [{"message": "Saving failed! Post updated", "code": "OUTDATED"}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &update_input())
            .await
            .unwrap_err();
        let ctx = match err {
            PublishError::UpdateConflict(ctx) => *ctx,
            other => panic!("expected UpdateConflict, got {other:?}"),
        };
        assert_eq!(ctx.provider, "ghost");
        assert_eq!(ctx.remote_id, REMOTE_ID);
        assert_eq!(
            ctx.expected,
            Some(ProviderRevision::Ghost {
                updated_at: EXPECTED_UPDATED_AT.into(),
            })
        );
        assert_eq!(
            ctx.actual,
            Some(ProviderRevision::Ghost {
                updated_at: "2026-07-16T00:10:00.000Z".into(),
            })
        );
        assert_no_post_create(&server).await;
    }

    #[tokio::test]
    async fn publish_update_put_409_without_parseable_actual_still_conflicts_without_fallback() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://blog.example.com/hello/").await;
        Mock::given(method("PUT"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .respond_with(ResponseTemplate::new(409).set_body_string("not-json"))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &update_input())
            .await
            .unwrap_err();
        let ctx = match err {
            PublishError::UpdateConflict(ctx) => *ctx,
            other => panic!("expected UpdateConflict, got {other:?}"),
        };
        assert_eq!(ctx.provider, "ghost");
        assert_eq!(ctx.remote_id, REMOTE_ID);
        assert!(ctx.actual.is_none());
        assert_no_post_create(&server).await;
    }

    #[tokio::test]
    async fn publish_update_put_401_maps_to_auth_error_without_fallback() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://blog.example.com/hello/").await;
        Mock::given(method("PUT"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .respond_with(ResponseTemplate::new(401).set_body_string("invalid token"))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &update_input())
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
        assert_no_post_create(&server).await;
    }

    #[tokio::test]
    async fn publish_update_put_malformed_success_body_returns_unexpected_response_without_fallback(
    ) {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://blog.example.com/hello/").await;
        Mock::given(method("PUT"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "posts": [{"id": REMOTE_ID}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &update_input())
            .await
            .unwrap_err();
        assert!(
            matches!(err, PublishError::UnexpectedResponse(_)),
            "got {err:?}"
        );
        assert_no_post_create(&server).await;
    }

    #[tokio::test]
    async fn publish_update_put_response_id_mismatch_returns_unexpected_response() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://blog.example.com/hello/").await;
        Mock::given(method("PUT"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .respond_with(ResponseTemplate::new(200).set_body_json(refreshed_ok_body(
                "swapped-id",
                "https://blog.example.com/hello/",
                REFRESHED_UPDATED_AT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &update_input())
            .await
            .unwrap_err();
        let msg = match err {
            PublishError::UnexpectedResponse(m) => m,
            other => panic!("expected UnexpectedResponse, got {other:?}"),
        };
        assert!(
            !msg.contains("swapped-id"),
            "must not echo returned id in message: {msg}"
        );
        assert_no_post_create(&server).await;
    }

    #[tokio::test]
    async fn publish_update_requires_expected_revision_and_does_not_touch_server() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_put(&server).await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.update_target = Some(UpdateTarget {
            remote_id: REMOTE_ID.into(),
            expected_revision: None,
        });
        let err = publish(&cfg(&server.uri()), &inp).await.unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn publish_update_rejects_wrong_provider_revision_variant() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_put(&server).await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.update_target = Some(UpdateTarget {
            remote_id: REMOTE_ID.into(),
            expected_revision: Some(ProviderRevision::WordPress {
                modified: Some("2026-07-16T00:00:00".into()),
                modified_gmt: None,
            }),
        });
        let err = publish(&cfg(&server.uri()), &inp).await.unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn publish_update_rejects_empty_remote_id_without_touching_server() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_put(&server).await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.update_target = Some(UpdateTarget {
            remote_id: String::new(),
            expected_revision: Some(ProviderRevision::Ghost {
                updated_at: EXPECTED_UPDATED_AT.into(),
            }),
        });
        let err = publish(&cfg(&server.uri()), &inp).await.unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    async fn assert_preflight_rejects_remote_id(raw_id: &str) {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_put(&server).await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.update_target = Some(UpdateTarget {
            remote_id: raw_id.into(),
            expected_revision: Some(ProviderRevision::Ghost {
                updated_at: EXPECTED_UPDATED_AT.into(),
            }),
        });
        let err = publish(&cfg(&server.uri()), &inp).await.unwrap_err();
        assert!(
            matches!(err, PublishError::BadConfig(_)),
            "expected BadConfig for id shape, got {err:?}"
        );
    }

    #[tokio::test]
    async fn publish_update_rejects_remote_id_with_forward_slash() {
        assert_preflight_rejects_remote_id("g1/../etc/passwd").await;
    }

    #[tokio::test]
    async fn publish_update_rejects_remote_id_with_back_slash() {
        assert_preflight_rejects_remote_id("g1\\etc").await;
    }

    #[tokio::test]
    async fn publish_update_rejects_remote_id_with_query_and_hash() {
        assert_preflight_rejects_remote_id("g1?source=html").await;
        assert_preflight_rejects_remote_id("g1#frag").await;
    }

    #[tokio::test]
    async fn publish_update_rejects_remote_id_with_percent_encoded_sequence() {
        assert_preflight_rejects_remote_id("g1%2F..").await;
    }

    #[tokio::test]
    async fn publish_update_rejects_remote_id_with_dot_segments() {
        assert_preflight_rejects_remote_id("..").await;
        assert_preflight_rejects_remote_id(".").await;
        assert_preflight_rejects_remote_id("g1.").await;
    }

    #[tokio::test]
    async fn publish_update_rejects_remote_id_with_whitespace_or_control_chars() {
        assert_preflight_rejects_remote_id("g1 ").await;
        assert_preflight_rejects_remote_id("g1\n").await;
        assert_preflight_rejects_remote_id("g1\t").await;
        assert_preflight_rejects_remote_id("g1\0").await;
    }

    #[tokio::test]
    async fn publish_update_rejects_remote_id_with_non_ascii_or_high_bytes() {
        assert_preflight_rejects_remote_id("g1中").await;
    }

    #[tokio::test]
    async fn publish_update_rejects_overly_long_remote_id() {
        let long_id = "a".repeat(129);
        assert_preflight_rejects_remote_id(&long_id).await;
    }

    #[tokio::test]
    async fn publish_absent_update_target_still_creates_via_post() {
        let server = MockServer::start().await;
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/ghost/api/admin/posts/"))
            .and(query_param("source", "html"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "posts": [{
                    "id": "p999",
                    "url": "https://blog.example.com/new/",
                    "updated_at": "2026-07-17T00:00:00.000Z"
                }]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let result = publish(&cfg(&server.uri()), &input()).await.unwrap();
        assert_eq!(result.operation, PublishOperation::Created);
        assert_eq!(result.remote_id, "p999");
    }

    #[tokio::test]
    async fn publish_update_success_body_exactly_matches_expected_wire_shape() {
        let server = MockServer::start().await;
        mount_get_success(&server, "https://blog.example.com/hello/").await;
        let expected_body = serde_json::json!({
            "posts": [{
                "id": REMOTE_ID,
                "title": "Hello",
                "html": "<p>body</p>",
                "tags": [{"name": "rust"}],
                "status": "draft",
                "updated_at": EXPECTED_UPDATED_AT,
                "slug": "hello",
                "custom_excerpt": "brief",
            }]
        });
        Mock::given(method("PUT"))
            .and(path(format!("/ghost/api/admin/posts/{REMOTE_ID}/")))
            .and(query_param("source", "html"))
            .and(body_json(&expected_body))
            .respond_with(ResponseTemplate::new(200).set_body_json(refreshed_ok_body(
                REMOTE_ID,
                "https://blog.example.com/hello/",
                REFRESHED_UPDATED_AT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let _ = publish(&cfg(&server.uri()), &update_input())
            .await
            .expect("update should succeed against exact body match");
        let _ = UpdateConflictContext {
            provider: "ghost".into(),
            remote_id: REMOTE_ID.into(),
            expected: None,
            actual: None,
        };
    }

    const GHOST_ID_24: &str = "0123456789abcdef01234567";
    const CH_ID: &str = "ghost-personal_1";

    fn bind_body(id: &str, url: &str, updated_at: &str) -> serde_json::Value {
        serde_json::json!({
            "posts": [{
                "id": id,
                "url": url,
                "updated_at": updated_at,
            }]
        })
    }

    #[tokio::test]
    async fn verify_binding_by_id_returns_updatable_with_canonical_revision() {
        let server = MockServer::start().await;
        let canonical_url = format!("{}/hello/", server.uri());
        Mock::given(method("GET"))
            .and(path(format!("/ghost/api/admin/posts/{GHOST_ID_24}/")))
            .respond_with(ResponseTemplate::new(200).set_body_json(bind_body(
                GHOST_ID_24,
                &canonical_url,
                EXPECTED_UPDATED_AT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let vb = super::verify_binding(CH_ID, &cfg(&server.uri()), GHOST_ID_24)
            .await
            .expect("should verify by ID");
        assert_eq!(vb.channel_id, CH_ID);
        assert_eq!(vb.provider, "ghost");
        assert_eq!(vb.remote_id, GHOST_ID_24);
        assert_eq!(vb.url, canonical_url);
        assert_eq!(
            vb.revision,
            Some(ProviderRevision::Ghost {
                updated_at: EXPECTED_UPDATED_AT.into(),
            })
        );
        assert_eq!(
            vb.capability,
            crate::services::publish::binding::BindingCapability::Updatable
        );
    }

    #[tokio::test]
    async fn verify_binding_by_permalink_url_uses_slug_endpoint() {
        let server = MockServer::start().await;
        let canonical_url = format!("{}/hello/", server.uri());
        Mock::given(method("GET"))
            .and(path("/ghost/api/admin/posts/slug/hello/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(bind_body(
                GHOST_ID_24,
                &canonical_url,
                EXPECTED_UPDATED_AT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let vb = super::verify_binding(
            CH_ID,
            &cfg(&server.uri()),
            &format!("{}/hello/", server.uri()),
        )
        .await
        .expect("permalink should verify");
        assert_eq!(vb.remote_id, GHOST_ID_24);
    }

    #[tokio::test]
    async fn verify_binding_by_cjk_permalink_url_percent_decodes_before_lookup() {
        let server = MockServer::start().await;
        let canonical_url = format!("{}/\u{7b2c}\u{4e00}\u{7ae0}/", server.uri());
        Mock::given(method("GET"))
            .and(path(
                "/ghost/api/admin/posts/slug/%E7%AC%AC%E4%B8%80%E7%AB%A0/",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(bind_body(
                GHOST_ID_24,
                &canonical_url,
                EXPECTED_UPDATED_AT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let vb = super::verify_binding(
            CH_ID,
            &cfg(&server.uri()),
            &format!("{}/%E7%AC%AC%E4%B8%80%E7%AB%A0/", server.uri()),
        )
        .await
        .expect("CJK permalink should verify");
        assert_eq!(vb.remote_id, GHOST_ID_24);
    }

    #[tokio::test]
    async fn verify_binding_rejects_wrong_host_url() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        let err = super::verify_binding(
            CH_ID,
            &cfg(&server.uri()),
            "https://not-my-blog.example.com/hello/",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn verify_binding_rejects_malformed_id() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        for bad in [
            "",
            "abc",
            "0123456789ABCDEF01234567",
            "0123456789abcdef0123456",
            "0123456789abcdef012345678",
            "0123456789abcdef0123XYZ7",
            "../../../etc",
            "42?x=1",
        ] {
            let err = super::verify_binding(CH_ID, &cfg(&server.uri()), bad)
                .await
                .unwrap_err();
            assert!(
                matches!(err, PublishError::BadConfig(_)),
                "bad='{bad}' got {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn verify_binding_404_maps_to_remote_not_found() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/ghost/api/admin/posts/{GHOST_ID_24}/")))
            .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
            .expect(1)
            .mount(&server)
            .await;
        let err = super::verify_binding(CH_ID, &cfg(&server.uri()), GHOST_ID_24)
            .await
            .unwrap_err();
        assert!(
            matches!(err, PublishError::RemoteNotFound { .. }),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn verify_binding_401_maps_to_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(401).set_body_string("nope"))
            .mount(&server)
            .await;
        let err = super::verify_binding(CH_ID, &cfg(&server.uri()), GHOST_ID_24)
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn verify_binding_rejects_response_id_mismatch() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/ghost/api/admin/posts/{GHOST_ID_24}/")))
            .respond_with(ResponseTemplate::new(200).set_body_json(bind_body(
                "aaaaaaaaaaaaaaaaaaaaaaaa",
                "https://blog.example.com/hello/",
                EXPECTED_UPDATED_AT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let err = super::verify_binding(CH_ID, &cfg(&server.uri()), GHOST_ID_24)
            .await
            .unwrap_err();
        assert!(
            matches!(err, PublishError::UnexpectedResponse(_)),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn verify_binding_rejects_response_url_host_mismatch() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/ghost/api/admin/posts/{GHOST_ID_24}/")))
            .respond_with(ResponseTemplate::new(200).set_body_json(bind_body(
                GHOST_ID_24,
                "https://not-my-blog.example.com/hello/",
                EXPECTED_UPDATED_AT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let err = super::verify_binding(CH_ID, &cfg(&server.uri()), GHOST_ID_24)
            .await
            .unwrap_err();
        assert!(
            matches!(err, PublishError::UnexpectedResponse(_)),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn verify_binding_rejects_url_with_credentials_or_fragment() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        for bad in [
            "https://alice:pw@blog.example.com/hello/",
            "https://blog.example.com/hello/#anchor",
        ] {
            let err = super::verify_binding(CH_ID, &cfg(&server.uri()), bad)
                .await
                .unwrap_err();
            assert!(
                matches!(err, PublishError::BadConfig(_)),
                "bad='{bad}' got {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn verify_binding_rejects_slug_delimiter_encodings_without_request() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        for bad in ["%2F", "%5C", "%00", "%25", "safe%2Funsafe", "safe%5Cunsafe"] {
            let err = super::verify_binding(
                CH_ID,
                &cfg(&server.uri()),
                &format!("{}/{bad}/", server.uri()),
            )
            .await
            .unwrap_err();
            assert!(
                matches!(err, PublishError::BadConfig(_)),
                "bad='{bad}' got {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn verify_binding_rejects_encoded_dot_traversal_without_request() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        for bad in ["a/%2e%2e/b", "a/%2E/b", "a/../b"] {
            let err = super::verify_binding(
                CH_ID,
                &cfg(&server.uri()),
                &format!("{}/{bad}/", server.uri()),
            )
            .await
            .unwrap_err();
            assert!(
                matches!(err, PublishError::BadConfig(_)),
                "bad='{bad}' got {err:?}"
            );
        }
    }
}
