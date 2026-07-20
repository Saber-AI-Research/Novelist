//! WordPress.com publish adapter.
//!
//! Same wire shape as the self-hosted adapter except:
//! - Base URL: `https://public-api.wordpress.com/wp/v2/sites/<site_id_or_domain>`
//! - Auth: `Authorization: Bearer <access_token>` (OAuth2 personal
//!   access token from developer.wordpress.com)
//!
//! Adapter kept separate per design — different URL space + different
//! auth mode means a single combined file would be a forced
//! abstraction.

use crate::models::publish::PlatformConfig;
use crate::services::publish::binding::{
    decoded_last_segment, parse_binding_input, preflight_input, wordpress_query_id,
    BindingCapability, ParsedInput, VerifiedBinding,
};
use crate::services::publish::types::{
    ProviderRevision, PublishError, PublishInput, PublishResult, UpdateConflictContext,
    UpdateTarget,
};
use url::Url;

const DEFAULT_BASE: &str = "https://public-api.wordpress.com";
const MAX_REMOTE_ID_LEN: usize = 128;

/// Read-only credentials check: `GET /wp/v2/sites/<id>/users/me`.
pub async fn verify(site: &str, token: &str) -> Result<String, PublishError> {
    if site.is_empty() || token.is_empty() {
        return Err(PublishError::BadConfig(
            "wordpress_com config missing site or access_token".into(),
        ));
    }
    let endpoint = format!("{DEFAULT_BASE}/wp/v2/sites/{site}/users/me");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .get(&endpoint)
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "json").await?;
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("WordPress.com user");
    Ok(format!("Connected as {name}"))
}

pub async fn upload_image(
    site: &str,
    token: &str,
    bytes: Vec<u8>,
    filename: String,
    mime: String,
) -> Result<(String, u64), PublishError> {
    upload_image_with_base(site, token, bytes, filename, mime, DEFAULT_BASE).await
}

pub async fn upload_image_with_base(
    site: &str,
    token: &str,
    bytes: Vec<u8>,
    filename: String,
    mime: String,
    base: &str,
) -> Result<(String, u64), PublishError> {
    if site.is_empty() || token.is_empty() {
        return Err(PublishError::BadConfig("missing site or token".into()));
    }
    let endpoint = format!("{base}/wp/v2/sites/{site}/media");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", &mime)
        .header(
            "Content-Disposition",
            crate::services::publish::media_content_disposition(&filename),
        )
        .body(bytes)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "json").await?;
    let id = body
        .get("id")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| PublishError::UnexpectedResponse("no id".into()))?;
    let url = body
        .get("source_url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("no source_url".into()))?
        .to_string();
    Ok((url, id))
}

/// Extract WordPress.com bearer credentials from `PlatformConfig`.
/// Kept separate from `wordpress::wp_creds` because WordPress.com
/// uses a site-scoped route (`/wp/v2/sites/{site}/...`) plus OAuth
/// bearer instead of Basic Auth.
fn wp_com_creds(config: &PlatformConfig) -> Result<(&str, &str), PublishError> {
    let (site, token) = match config {
        PlatformConfig::WordPressCom {
            site_id_or_domain,
            access_token,
        } => (site_id_or_domain.as_str(), access_token.as_str()),
        _ => return Err(PublishError::BadConfig("not a WordPress.com config".into())),
    };
    if site.is_empty() || token.is_empty() {
        return Err(PublishError::BadConfig(
            "wordpress_com config missing site or access_token".into(),
        ));
    }
    Ok((site, token))
}

fn validate_remote_id_wp_com(remote_id: &str) -> Result<u64, PublishError> {
    if remote_id.is_empty() {
        return Err(PublishError::BadConfig(
            "wordpress_com update requires update_target.remote_id".into(),
        ));
    }
    if remote_id.len() > MAX_REMOTE_ID_LEN {
        return Err(PublishError::BadConfig(format!(
            "wordpress_com remote_id exceeds {MAX_REMOTE_ID_LEN} bytes"
        )));
    }
    if !remote_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(PublishError::BadConfig(
            "wordpress_com remote_id must be a positive canonical base-10 u64 integer with only ASCII digits (no signs, letters, path/query/hash/whitespace characters)".into(),
        ));
    }
    let parsed: u64 = remote_id.parse().map_err(|_| {
        PublishError::BadConfig("wordpress_com remote_id exceeds the u64 range".into())
    })?;
    if parsed == 0 {
        return Err(PublishError::BadConfig(
            "wordpress_com remote_id must be greater than zero".into(),
        ));
    }
    if parsed.to_string() != remote_id {
        return Err(PublishError::BadConfig(
            "wordpress_com remote_id must be canonical (no leading zeros)".into(),
        ));
    }
    Ok(parsed)
}

fn validate_wp_com_update_target(
    update_target: &UpdateTarget,
) -> Result<(u64, Option<String>, Option<String>), PublishError> {
    let parsed_id = validate_remote_id_wp_com(&update_target.remote_id)?;
    match &update_target.expected_revision {
        Some(ProviderRevision::WordPress {
            modified,
            modified_gmt,
        }) => {
            let m = modified
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(String::from);
            let g = modified_gmt
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(String::from);
            if m.is_none() && g.is_none() {
                return Err(PublishError::BadConfig(
                    "wordpress_com update requires expected_revision with at least one non-empty (non-whitespace) modified or modified_gmt field".into(),
                ));
            }
            Ok((parsed_id, m, g))
        }
        Some(ProviderRevision::Ghost { .. }) => Err(PublishError::BadConfig(
            "wordpress_com update requires expected_revision=ProviderRevision::WordPress; got Ghost variant".into(),
        )),
        None => Err(PublishError::BadConfig(
            "wordpress_com update requires expected_revision=ProviderRevision::WordPress { modified, modified_gmt }".into(),
        )),
    }
}

struct FetchedWpComPost {
    id: u64,
    link: String,
    modified: Option<String>,
    modified_gmt: Option<String>,
    featured_media: Option<u64>,
}

async fn fetch_wp_com_post(
    base: &str,
    site: &str,
    auth: &str,
    remote_id: &str,
) -> Result<FetchedWpComPost, PublishError> {
    let endpoint = format!("{base}/wp/v2/sites/{site}/posts/{remote_id}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .get(&endpoint)
        .query(&[("context", "edit")])
        .header("Authorization", auth)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    if resp.status().as_u16() == 404 {
        return Err(PublishError::RemoteNotFound {
            provider: "wordpress_com".into(),
            remote_id: remote_id.to_string(),
        });
    }
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "wordpress_com GET json").await?;
    parse_fetched_wp_com_post(&body)
}

fn parse_fetched_wp_com_post(body: &serde_json::Value) -> Result<FetchedWpComPost, PublishError> {
    let id = body
        .get("id")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| PublishError::UnexpectedResponse("wordpress_com GET missing id".into()))?;
    let link = body
        .get("link")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("wordpress_com GET missing link".into()))?
        .to_string();
    let modified = body
        .get("modified")
        .and_then(|v| v.as_str())
        .map(String::from);
    let modified_gmt = body
        .get("modified_gmt")
        .and_then(|v| v.as_str())
        .map(String::from);
    if modified.is_none() && modified_gmt.is_none() {
        return Err(PublishError::UnexpectedResponse(
            "wordpress_com GET missing both modified and modified_gmt".into(),
        ));
    }
    let featured_media = body.get("featured_media").and_then(|v| v.as_u64());
    Ok(FetchedWpComPost {
        id,
        link,
        modified,
        modified_gmt,
        featured_media,
    })
}

fn compare_wp_com_revisions(
    expected_modified: Option<&str>,
    expected_modified_gmt: Option<&str>,
    fetched: &FetchedWpComPost,
    remote_id: &str,
) -> Result<(), PublishError> {
    let m_match = match expected_modified {
        Some(exp) => fetched.modified.as_deref() == Some(exp),
        None => true,
    };
    let g_match = match expected_modified_gmt {
        Some(exp) => fetched.modified_gmt.as_deref() == Some(exp),
        None => true,
    };
    if m_match && g_match {
        return Ok(());
    }
    Err(PublishError::UpdateConflict(Box::new(
        UpdateConflictContext {
            provider: "wordpress_com".into(),
            remote_id: remote_id.to_string(),
            expected: Some(ProviderRevision::WordPress {
                modified: expected_modified.map(String::from),
                modified_gmt: expected_modified_gmt.map(String::from),
            }),
            actual: Some(ProviderRevision::WordPress {
                modified: fetched.modified.clone(),
                modified_gmt: fetched.modified_gmt.clone(),
            }),
        },
    )))
}

/// Read-only update preflight used before the frontend performs media uploads.
/// The actual update repeats verification to preserve the adapter's standalone
/// fail-closed contract.
pub async fn verify_update(
    config: &PlatformConfig,
    update_target: &UpdateTarget,
) -> Result<(), PublishError> {
    verify_update_with_base(config, update_target, DEFAULT_BASE).await
}

pub async fn verify_update_with_base(
    config: &PlatformConfig,
    update_target: &UpdateTarget,
    base: &str,
) -> Result<(), PublishError> {
    let (site, token) = wp_com_creds(config)?;
    let (tracked_id_num, expected_modified, expected_modified_gmt) =
        validate_wp_com_update_target(update_target)?;
    let auth = format!("Bearer {token}");
    let fetched = fetch_wp_com_post(base, site, &auth, &update_target.remote_id).await?;
    if fetched.id != tracked_id_num {
        return Err(PublishError::UnexpectedResponse(
            "wordpress_com GET returned a different post id than the tracked one".into(),
        ));
    }
    compare_wp_com_revisions(
        expected_modified.as_deref(),
        expected_modified_gmt.as_deref(),
        &fetched,
        &update_target.remote_id,
    )
}

/// Build the WordPress.com update payload. Featured media semantics
/// match the self-hosted adapter — see
/// [`crate::services::publish::wordpress::update_post`].
fn build_wp_com_update_body(
    input: &PublishInput,
    fetched: &FetchedWpComPost,
    tag_ids: &[u64],
) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "title": input.title,
        "content": input.body,
        "status": input.status,
        "tags": tag_ids,
    });
    if let Some(slug) = &input.slug {
        payload["slug"] = serde_json::Value::String(slug.clone());
    }
    if let Some(excerpt) = &input.excerpt {
        payload["excerpt"] = serde_json::Value::String(excerpt.clone());
    }
    let effective_media = input.featured_media_id.or(fetched.featured_media);
    if let Some(media_id) = effective_media {
        payload["featured_media"] = serde_json::Value::Number(media_id.into());
    }
    payload
}

pub async fn update_post_with_base(
    config: &PlatformConfig,
    input: &PublishInput,
    base: &str,
) -> Result<PublishResult, PublishError> {
    let (site, token) = wp_com_creds(config)?;
    let update_target = input.update_target.as_ref().ok_or_else(|| {
        PublishError::BadConfig("update_post_with_base requires PublishInput.update_target".into())
    })?;
    let (tracked_id_num, expected_modified, expected_modified_gmt) =
        validate_wp_com_update_target(update_target)?;
    let tracked_id = update_target.remote_id.clone();
    let auth = format!("Bearer {token}");

    let fetched = fetch_wp_com_post(base, site, &auth, &tracked_id).await?;
    if fetched.id != tracked_id_num {
        return Err(PublishError::UnexpectedResponse(
            "wordpress_com GET returned a different post id than the tracked one".into(),
        ));
    }
    compare_wp_com_revisions(
        expected_modified.as_deref(),
        expected_modified_gmt.as_deref(),
        &fetched,
        &tracked_id,
    )?;

    let tag_ids = if input.tags.is_empty() {
        Vec::new()
    } else {
        resolve_tag_ids_with_base(site, &auth, &input.tags, base).await?
    };

    let payload = build_wp_com_update_body(input, &fetched, &tag_ids);
    let endpoint = format!("{base}/wp/v2/sites/{site}/posts/{tracked_id}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .post(&endpoint)
        .header("Authorization", &auth)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    if resp.status().as_u16() == 404 {
        return Err(PublishError::RemoteNotFound {
            provider: "wordpress_com".into(),
            remote_id: tracked_id,
        });
    }
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "wordpress_com update json").await?;
    let refreshed_id = body.get("id").and_then(|v| v.as_u64()).ok_or_else(|| {
        PublishError::UnexpectedResponse("wordpress_com update missing id".into())
    })?;
    if refreshed_id != tracked_id_num {
        return Err(PublishError::UnexpectedResponse(
            "wordpress_com update returned a different post id than the tracked one".into(),
        ));
    }
    let refreshed_link = body
        .get("link")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            PublishError::UnexpectedResponse("wordpress_com update missing link".into())
        })?
        .to_string();
    let refreshed_revision = parse_refreshed_wp_com_revision(&body)?;
    Ok(PublishResult::updated(
        refreshed_link,
        refreshed_id.to_string(),
        Some(refreshed_revision),
    ))
}

fn parse_refreshed_wp_com_revision(
    body: &serde_json::Value,
) -> Result<ProviderRevision, PublishError> {
    let modified = body
        .get("modified")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let modified_gmt = body
        .get("modified_gmt")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(String::from);
    if modified.is_none() && modified_gmt.is_none() {
        return Err(PublishError::UnexpectedResponse(
            "wordpress_com update response has no usable modified or modified_gmt field".into(),
        ));
    }
    Ok(ProviderRevision::WordPress {
        modified,
        modified_gmt,
    })
}

pub async fn publish(
    config: &PlatformConfig,
    input: &PublishInput,
) -> Result<PublishResult, PublishError> {
    publish_with_base(config, input, DEFAULT_BASE).await
}

pub async fn publish_with_base(
    config: &PlatformConfig,
    input: &PublishInput,
    base: &str,
) -> Result<PublishResult, PublishError> {
    if input.update_target.is_some() {
        return update_post_with_base(config, input, base).await;
    }
    let (site, token) = wp_com_creds(config)?;
    let auth = format!("Bearer {token}");
    let tag_ids = if input.tags.is_empty() {
        Vec::new()
    } else {
        resolve_tag_ids_with_base(site, &auth, &input.tags, base).await?
    };

    let mut payload = serde_json::json!({
        "title": input.title,
        "content": input.body,
        "status": input.status,
        "tags": tag_ids,
    });
    if let Some(slug) = &input.slug {
        payload["slug"] = serde_json::Value::String(slug.clone());
    }
    if let Some(excerpt) = &input.excerpt {
        payload["excerpt"] = serde_json::Value::String(excerpt.clone());
    }
    if let Some(media_id) = input.featured_media_id {
        payload["featured_media"] = serde_json::Value::Number(media_id.into());
    }

    let endpoint = format!("{base}/wp/v2/sites/{site}/posts");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .post(&endpoint)
        .header("Authorization", &auth)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "json").await?;
    let id = body
        .get("id")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| PublishError::UnexpectedResponse("no id".into()))?;
    let url = body
        .get("link")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("no link".into()))?
        .to_string();
    let revision = parse_refreshed_wp_com_revision(&body)?;
    Ok(PublishResult::created_with_revision(
        url,
        id.to_string(),
        revision,
    ))
}

async fn resolve_tag_ids_with_base(
    site: &str,
    auth: &str,
    tag_names: &[String],
    base: &str,
) -> Result<Vec<u64>, PublishError> {
    let mut out = Vec::with_capacity(tag_names.len());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    for name in tag_names {
        let resp = client
            .get(format!("{base}/wp/v2/sites/{site}/tags"))
            .query(&[("search", name)])
            .header("Authorization", auth)
            .send()
            .await
            .map_err(crate::services::publish::types::redact_reqwest_error)?;
        let resp = crate::services::publish::require_success(resp).await?;
        let body: serde_json::Value =
            crate::services::publish::parse_json_response(resp, "json").await?;
        let matched_id = body.as_array().and_then(|arr| {
            arr.iter()
                .find(|t| {
                    t.get("name")
                        .and_then(|n| n.as_str())
                        .map(|n| n.eq_ignore_ascii_case(name))
                        .unwrap_or(false)
                })
                .and_then(|t| t.get("id").and_then(|v| v.as_u64()))
        });
        if let Some(id) = matched_id {
            out.push(id);
            continue;
        }
        let create = client
            .post(format!("{base}/wp/v2/sites/{site}/tags"))
            .header("Authorization", auth)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({"name": name}))
            .send()
            .await
            .map_err(crate::services::publish::types::redact_reqwest_error)?;
        let create = crate::services::publish::require_success(create).await?;
        let body: serde_json::Value =
            crate::services::publish::parse_json_response(create, "json").await?;
        let id = body
            .get("id")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| PublishError::UnexpectedResponse("no id on tag create".into()))?;
        out.push(id);
    }
    Ok(out)
}

fn wp_com_public_host(site: &str) -> Option<String> {
    let s = site.trim();
    if s.is_empty() {
        return None;
    }
    if s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if s.contains('/') || s.contains(':') || s.contains(' ') {
        return None;
    }
    Some(s.to_ascii_lowercase())
}

fn assert_wp_com_domain_authority(url: &url::Url, expected_host: &str) -> Result<(), PublishError> {
    if url.scheme() != "https" {
        return Err(PublishError::BadConfig(
            "wordpress_com bind URL scheme must be https for domain-based sites".into(),
        ));
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host != expected_host {
        return Err(PublishError::BadConfig(
            "wordpress_com bind URL host does not exactly match selected site domain".into(),
        ));
    }
    if url.port_or_known_default() != Some(443) {
        return Err(PublishError::BadConfig(
            "wordpress_com bind URL port must match the selected site authority".into(),
        ));
    }
    Ok(())
}

fn authority_tuple(url: &url::Url) -> (String, String, Option<u16>) {
    (
        url.scheme().to_string(),
        url.host_str().unwrap_or("").to_ascii_lowercase(),
        url.port_or_known_default(),
    )
}

fn assert_same_authority(
    submitted: &url::Url,
    canonical: &url::Url,
    message: &str,
) -> Result<(), PublishError> {
    if authority_tuple(submitted) != authority_tuple(canonical) {
        return Err(PublishError::UnexpectedResponse(message.into()));
    }
    Ok(())
}

async fn fetch_wp_com_post_by_slug(
    base: &str,
    site: &str,
    auth: &str,
    slug: &str,
) -> Result<FetchedWpComPost, PublishError> {
    let endpoint = format!("{base}/wp/v2/sites/{site}/posts");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .get(&endpoint)
        .query(&[("context", "edit"), ("slug", slug), ("per_page", "2")])
        .header("Authorization", auth)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = crate::services::publish::require_success(resp).await?;
    let arr: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "wordpress_com bind json").await?;
    let items = arr.as_array().ok_or_else(|| {
        PublishError::UnexpectedResponse("wordpress_com slug lookup did not return an array".into())
    })?;
    match items.len() {
        0 => Err(PublishError::RemoteNotFound {
            provider: "wordpress_com".into(),
            remote_id: slug.to_string(),
        }),
        1 => parse_fetched_wp_com_post(&items[0]),
        _ => Err(PublishError::UnexpectedResponse(
            "wordpress_com slug lookup returned multiple posts; slug must be unique per site"
                .into(),
        )),
    }
}

pub async fn verify_binding(
    channel_id: &str,
    config: &PlatformConfig,
    raw_input: &str,
) -> Result<VerifiedBinding, PublishError> {
    verify_binding_with_base(channel_id, config, raw_input, DEFAULT_BASE).await
}

pub async fn verify_binding_with_base(
    channel_id: &str,
    config: &PlatformConfig,
    raw_input: &str,
    base: &str,
) -> Result<VerifiedBinding, PublishError> {
    let (site, token) = wp_com_creds(config)?;
    let trimmed = preflight_input(raw_input)?;
    let parsed = parse_binding_input(&trimmed)?;
    let auth = format!("Bearer {token}");

    let (tracked_id_num, fetched, input_url) = match parsed {
        ParsedInput::Id(candidate) => {
            let id_num = validate_remote_id_wp_com(&candidate)?;
            let fetched = fetch_wp_com_post(base, site, &auth, &candidate).await?;
            (id_num, fetched, None)
        }
        ParsedInput::Url(url) => {
            if let Some(expected_host) = wp_com_public_host(site) {
                assert_wp_com_domain_authority(&url, &expected_host)?;
            }
            if let Some(query_id) = wordpress_query_id(&url) {
                let id_num = validate_remote_id_wp_com(&query_id)?;
                let fetched = fetch_wp_com_post(base, site, &auth, &query_id).await?;
                (id_num, fetched, Some(url))
            } else {
                let slug = decoded_last_segment(&url)?.ok_or_else(|| {
                    PublishError::BadConfig(
                        "wordpress_com bind URL must include ?p=<id> or a permalink slug".into(),
                    )
                })?;
                if slug.is_empty() {
                    return Err(PublishError::BadConfig(
                        "wordpress_com bind URL slug is empty".into(),
                    ));
                }
                let fetched = fetch_wp_com_post_by_slug(base, site, &auth, &slug).await?;
                (fetched.id, fetched, Some(url))
            }
        }
    };

    if fetched.id != tracked_id_num {
        return Err(PublishError::UnexpectedResponse(
            "wordpress_com bind response id disagrees with request".into(),
        ));
    }
    let canonical = Url::parse(&fetched.link).map_err(|_| {
        PublishError::UnexpectedResponse("wordpress_com bind link is not a valid URL".into())
    })?;
    if let Some(expected_host) = wp_com_public_host(site) {
        if let Err(err) = assert_wp_com_domain_authority(&canonical, &expected_host) {
            return match err {
                PublishError::BadConfig(_) => Err(PublishError::UnexpectedResponse(
                    "wordpress_com bind response link authority does not exactly match selected site".into(),
                )),
                other => Err(other),
            };
        }
    } else if let Some(input_url) = &input_url {
        assert_same_authority(
            input_url,
            &canonical,
            "wordpress_com bind response link authority does not match submitted URL authority",
        )?;
    }
    let revision = build_wp_com_revision_from_fetched(&fetched)?;

    Ok(VerifiedBinding {
        channel_id: channel_id.to_string(),
        provider: "wordpress_com".into(),
        remote_id: fetched.id.to_string(),
        url: fetched.link,
        revision: Some(revision),
        capability: BindingCapability::Updatable,
    })
}

fn build_wp_com_revision_from_fetched(
    fetched: &FetchedWpComPost,
) -> Result<ProviderRevision, PublishError> {
    let m = fetched
        .modified
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let g = fetched
        .modified_gmt
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(String::from);
    if m.is_none() && g.is_none() {
        return Err(PublishError::UnexpectedResponse(
            "wordpress_com bind response has no usable modified or modified_gmt".into(),
        ));
    }
    Ok(ProviderRevision::WordPress {
        modified: m,
        modified_gmt: g,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::publish::types::{BodyFormat, PublishOperation};
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    const REMOTE_ID: &str = "7";
    const SITE: &str = "myblog.example.com";
    const EXPECTED_MODIFIED: &str = "2026-07-16T09:00:00";
    const EXPECTED_MODIFIED_GMT: &str = "2026-07-16T09:00:00";
    const REFRESHED_MODIFIED: &str = "2026-07-16T09:05:00";
    const REFRESHED_MODIFIED_GMT: &str = "2026-07-16T09:05:00";

    fn cfg(site: &str) -> PlatformConfig {
        PlatformConfig::WordPressCom {
            site_id_or_domain: site.into(),
            access_token: "tok".into(),
        }
    }

    fn input() -> PublishInput {
        PublishInput {
            title: "Hello".into(),
            body: "<p>world</p>".into(),
            body_format: BodyFormat::Html,
            tags: vec![],
            slug: None,
            excerpt: None,
            status: "draft".into(),
            feature_image_url: None,
            featured_media_id: None,
            publication_id: None,
            update_target: None,
        }
    }

    #[tokio::test]
    async fn publish_creates_post() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/wp/v2/sites/myblog.example.com/posts"))
            .and(header("Authorization", "Bearer tok"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 7,
                "link": "https://myblog.example.com/?p=7",
                "modified": "2026-07-17T09:00:00",
                "modified_gmt": "2026-07-17T01:00:00"
            })))
            .mount(&server)
            .await;
        let result = publish_with_base(&cfg("myblog.example.com"), &input(), &server.uri())
            .await
            .unwrap();
        assert_eq!(result.remote_id, "7");
        assert!(result.url.contains("?p=7"), "got {}", result.url);
        assert_eq!(
            result.provider_revision,
            Some(ProviderRevision::WordPress {
                modified: Some("2026-07-17T09:00:00".into()),
                modified_gmt: Some("2026-07-17T01:00:00".into()),
            })
        );
    }

    #[tokio::test]
    async fn upload_image_returns_id_and_url() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/wp/v2/sites/myblog/media"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 11,
                "source_url": "https://wp.com/files/x.png"
            })))
            .mount(&server)
            .await;
        let (url, id) = upload_image_with_base(
            "myblog",
            "tok",
            vec![1, 2],
            "x.png".into(),
            "image/png".into(),
            &server.uri(),
        )
        .await
        .unwrap();
        assert_eq!(id, 11);
        assert_eq!(url, "https://wp.com/files/x.png");
    }

    #[tokio::test]
    async fn upload_image_encodes_cjk_filename_in_content_disposition() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/wp/v2/sites/myblog/media"))
            .and(header(
                "Content-Disposition",
                "attachment; filename=\"__.png\"; filename*=UTF-8''%E5%B0%81%E9%9D%A2.png",
            ))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 11,
                "source_url": "https://wp.com/files/cover.png"
            })))
            .mount(&server)
            .await;

        upload_image_with_base(
            "myblog",
            "tok",
            vec![1, 2],
            "封面.png".into(),
            "image/png".into(),
            &server.uri(),
        )
        .await
        .expect("CJK filename should produce an ASCII-safe upload header");
    }

    #[tokio::test]
    async fn publish_401_is_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(401).set_body_string("invalid_token"))
            .mount(&server)
            .await;
        let err = publish_with_base(&cfg("myblog"), &input(), &server.uri())
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn empty_field_is_bad_config() {
        let cfg = PlatformConfig::WordPressCom {
            site_id_or_domain: "".into(),
            access_token: "t".into(),
        };
        let err = publish(&cfg, &input()).await.unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    fn update_input() -> PublishInput {
        let mut inp = input();
        inp.slug = Some("hello".into());
        inp.excerpt = Some("brief".into());
        inp.tags = vec![];
        inp.update_target = Some(UpdateTarget {
            remote_id: REMOTE_ID.into(),
            expected_revision: Some(ProviderRevision::WordPress {
                modified: Some(EXPECTED_MODIFIED.into()),
                modified_gmt: Some(EXPECTED_MODIFIED_GMT.into()),
            }),
        });
        inp
    }

    fn fetched_ok_body(id: u64, link: &str, featured_media: Option<u64>) -> serde_json::Value {
        let mut v = serde_json::json!({
            "id": id,
            "link": link,
            "modified": EXPECTED_MODIFIED,
            "modified_gmt": EXPECTED_MODIFIED_GMT,
        });
        if let Some(m) = featured_media {
            v["featured_media"] = serde_json::Value::Number(m.into());
        }
        v
    }

    fn refreshed_ok_body(id: u64, link: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "link": link,
            "modified": REFRESHED_MODIFIED,
            "modified_gmt": REFRESHED_MODIFIED_GMT,
        })
    }

    fn extract_update_body(req: &Request) -> serde_json::Value {
        serde_json::from_slice(&req.body).expect("update body should be valid JSON")
    }

    async fn mount_get_success(server: &MockServer, link: &str, featured_media: Option<u64>) {
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .and(query_param("context", "edit"))
            .respond_with(ResponseTemplate::new(200).set_body_json(fetched_ok_body(
                REMOTE_ID.parse().unwrap(),
                link,
                featured_media,
            )))
            .expect(1)
            .mount(server)
            .await;
    }

    async fn mount_no_create(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts")))
            .respond_with(ResponseTemplate::new(500).set_body_string("unexpected create"))
            .expect(0)
            .mount(server)
            .await;
    }

    async fn mount_no_update(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(500).set_body_string("unexpected update"))
            .expect(0)
            .mount(server)
            .await;
    }

    async fn assert_no_create_post(server: &MockServer) {
        let requests = server.received_requests().await.unwrap_or_default();
        let create_path = format!("/wp/v2/sites/{SITE}/posts");
        let bare = requests
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST && r.url.path() == create_path)
            .count();
        assert_eq!(
            bare, 0,
            "must not fall back to POST /wp/v2/sites/{{site}}/posts (create)"
        );
    }

    async fn assert_no_update_post(server: &MockServer) {
        let requests = server.received_requests().await.unwrap_or_default();
        let update_path = format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}");
        let updates = requests
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST && r.url.path() == update_path)
            .count();
        assert_eq!(
            updates, 0,
            "must not POST update after preflight or GET failure"
        );
    }

    fn assert_authorization_bearer_scheme(req: &Request) {
        let auth = req
            .headers
            .get("authorization")
            .expect("authorization header")
            .to_str()
            .expect("authorization header decodes");
        assert!(
            auth.starts_with("Bearer "),
            "authorization must use Bearer scheme (value elided)"
        );
    }

    #[tokio::test]
    async fn publish_update_issues_get_then_post_update_on_site_scoped_route() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://myblog.example.com/?p=7", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .and(header("Content-Type", "application/json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(refreshed_ok_body(7, "https://myblog.example.com/?p=7")),
            )
            .expect(1)
            .mount(&server)
            .await;
        let result = publish_with_base(&cfg(SITE), &update_input(), &server.uri())
            .await
            .expect("update should succeed");
        assert_eq!(result.remote_id, REMOTE_ID);
        assert_eq!(result.url, "https://myblog.example.com/?p=7");
        assert_eq!(result.operation, PublishOperation::Updated);
        match result.provider_revision {
            Some(ProviderRevision::WordPress {
                modified,
                modified_gmt,
            }) => {
                assert_eq!(modified.as_deref(), Some(REFRESHED_MODIFIED));
                assert_eq!(modified_gmt.as_deref(), Some(REFRESHED_MODIFIED_GMT));
            }
            other => panic!("expected WordPress revision, got {other:?}"),
        }
        let requests = server.received_requests().await.unwrap_or_default();
        assert_eq!(requests.len(), 2, "expected GET then POST update");
        assert_eq!(requests[0].method, wiremock::http::Method::GET);
        assert_eq!(requests[1].method, wiremock::http::Method::POST);
        assert_eq!(
            requests[0].url.path(),
            format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")
        );
        assert_eq!(
            requests[1].url.path(),
            format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")
        );
        assert_authorization_bearer_scheme(&requests[0]);
        assert_authorization_bearer_scheme(&requests[1]);
        let body = extract_update_body(&requests[1]);
        assert_eq!(body["title"], "Hello");
        assert_eq!(body["content"], "<p>world</p>");
        assert_eq!(body["status"], "draft");
        assert_eq!(body["slug"], "hello");
        assert_eq!(body["excerpt"], "brief");
        assert_eq!(body["tags"], serde_json::json!([]));
        assert!(
            body.get("featured_media").is_none(),
            "no cover input and none fetched → omit featured_media, got: {body}"
        );
    }

    #[tokio::test]
    async fn verify_update_preflight_issues_only_the_site_scoped_revision_get() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        mount_get_success(&server, "https://myblog.example.com/?p=7", Some(88)).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/media")))
            .respond_with(ResponseTemplate::new(500).set_body_string("unexpected media upload"))
            .expect(0)
            .mount(&server)
            .await;
        let input = update_input();

        verify_update_with_base(
            &cfg(SITE),
            input.update_target.as_ref().unwrap(),
            &server.uri(),
        )
        .await
        .expect("matching revision should pass preflight");

        let requests = server.received_requests().await.unwrap_or_default();
        assert_eq!(requests.len(), 1, "preflight must remain read-only");
        assert_eq!(requests[0].method, wiremock::http::Method::GET);
        assert_eq!(
            requests[0].url.path(),
            format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")
        );
        assert_eq!(requests[0].url.query(), Some("context=edit"));
        assert_authorization_bearer_scheme(&requests[0]);
    }

    #[tokio::test]
    async fn verify_update_preflight_maps_404_without_side_effects() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
            .expect(1)
            .mount(&server)
            .await;

        let err = verify_update_with_base(
            &cfg(SITE),
            update_input().update_target.as_ref().unwrap(),
            &server.uri(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, PublishError::RemoteNotFound { .. }),
            "got {err:?}"
        );
        assert_no_update_post(&server).await;
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn verify_update_preflight_maps_revision_conflict_without_side_effects() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 7,
                "link": "https://myblog.example.com/?p=7",
                "modified": "newer",
                "modified_gmt": "newer",
            })))
            .expect(1)
            .mount(&server)
            .await;

        let err = verify_update_with_base(
            &cfg(SITE),
            update_input().update_target.as_ref().unwrap(),
            &server.uri(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, PublishError::UpdateConflict(_)),
            "got {err:?}"
        );
        assert_no_update_post(&server).await;
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn verify_update_preflight_maps_auth_failure_without_side_effects() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .expect(1)
            .mount(&server)
            .await;

        let err = verify_update_with_base(
            &cfg(SITE),
            update_input().update_target.as_ref().unwrap(),
            &server.uri(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
        assert_no_update_post(&server).await;
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_preserves_cjk_title_body_and_link() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://myblog.example.com/第一章/", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(refreshed_ok_body(7, "https://myblog.example.com/第一章/")),
            )
            .expect(1)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.title = "第一章 序幕".into();
        inp.body = "<p>你好，世界。</p>".into();
        let result = publish_with_base(&cfg(SITE), &inp, &server.uri())
            .await
            .unwrap();
        assert_eq!(result.url, "https://myblog.example.com/第一章/");
        let requests = server.received_requests().await.unwrap_or_default();
        let update = requests
            .iter()
            .find(|r| r.method == wiremock::http::Method::POST)
            .expect("POST update request");
        let body = extract_update_body(update);
        assert_eq!(body["title"], "第一章 序幕");
        assert_eq!(body["content"], "<p>你好，世界。</p>");
    }

    #[tokio::test]
    async fn publish_update_echoes_fetched_featured_media_when_input_has_none() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://myblog.example.com/?p=7", Some(88)).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(refreshed_ok_body(7, "https://myblog.example.com/?p=7")),
            )
            .expect(1)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.featured_media_id = None;
        let _ = publish_with_base(&cfg(SITE), &inp, &server.uri())
            .await
            .unwrap();
        let requests = server.received_requests().await.unwrap_or_default();
        let update = requests
            .iter()
            .find(|r| r.method == wiremock::http::Method::POST)
            .expect("POST update request");
        let body = extract_update_body(update);
        assert_eq!(
            body["featured_media"], 88,
            "unchanged featured media must be preserved by echoing fetched value"
        );
    }

    #[tokio::test]
    async fn publish_update_uses_input_featured_media_id_when_provided() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://myblog.example.com/?p=7", Some(88)).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(refreshed_ok_body(7, "https://myblog.example.com/?p=7")),
            )
            .expect(1)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.featured_media_id = Some(456);
        let _ = publish_with_base(&cfg(SITE), &inp, &server.uri())
            .await
            .unwrap();
        let requests = server.received_requests().await.unwrap_or_default();
        let update = requests
            .iter()
            .find(|r| r.method == wiremock::http::Method::POST)
            .expect("POST update request");
        let body = extract_update_body(update);
        assert_eq!(body["featured_media"], 456);
    }

    #[tokio::test]
    async fn publish_update_get_404_maps_to_remote_not_found_without_create_or_update() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish_with_base(&cfg(SITE), &update_input(), &server.uri())
            .await
            .unwrap_err();
        match err {
            PublishError::RemoteNotFound {
                provider,
                remote_id,
            } => {
                assert_eq!(provider, "wordpress_com");
                assert_eq!(remote_id, REMOTE_ID);
            }
            other => panic!("expected RemoteNotFound, got {other:?}"),
        }
        assert_no_update_post(&server).await;
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_revision_mismatch_maps_to_conflict_without_update_or_create() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 7,
                "link": "https://myblog.example.com/?p=7",
                "modified": "2026-07-16T10:00:00",
                "modified_gmt": "2026-07-16T10:00:00",
            })))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish_with_base(&cfg(SITE), &update_input(), &server.uri())
            .await
            .unwrap_err();
        let ctx = match err {
            PublishError::UpdateConflict(ctx) => *ctx,
            other => panic!("expected UpdateConflict, got {other:?}"),
        };
        assert_eq!(ctx.provider, "wordpress_com");
        assert_eq!(ctx.remote_id, REMOTE_ID);
        assert_no_update_post(&server).await;
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_get_401_maps_to_auth_error_without_update_or_create() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(401).set_body_string("invalid"))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish_with_base(&cfg(SITE), &update_input(), &server.uri())
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
        assert_no_update_post(&server).await;
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_get_malformed_response_returns_unexpected_response() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 7,
                "link": "https://myblog.example.com/?p=7",
            })))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish_with_base(&cfg(SITE), &update_input(), &server.uri())
            .await
            .unwrap_err();
        assert!(
            matches!(err, PublishError::UnexpectedResponse(_)),
            "got {err:?}"
        );
        assert_no_update_post(&server).await;
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_get_response_id_mismatch_returns_unexpected_response() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 999,
                "link": "https://myblog.example.com/?p=999",
                "modified": EXPECTED_MODIFIED,
                "modified_gmt": EXPECTED_MODIFIED_GMT,
            })))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish_with_base(&cfg(SITE), &update_input(), &server.uri())
            .await
            .unwrap_err();
        assert!(
            matches!(err, PublishError::UnexpectedResponse(_)),
            "got {err:?}"
        );
        assert_no_update_post(&server).await;
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_post_404_maps_to_remote_not_found_without_create_fallback() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://myblog.example.com/?p=7", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(404).set_body_string("gone"))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish_with_base(&cfg(SITE), &update_input(), &server.uri())
            .await
            .unwrap_err();
        match err {
            PublishError::RemoteNotFound {
                provider,
                remote_id,
            } => {
                assert_eq!(provider, "wordpress_com");
                assert_eq!(remote_id, REMOTE_ID);
            }
            other => panic!("expected RemoteNotFound, got {other:?}"),
        }
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_post_response_id_mismatch_returns_unexpected_response() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://myblog.example.com/?p=7", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(refreshed_ok_body(999, "https://myblog.example.com/?p=999")),
            )
            .expect(1)
            .mount(&server)
            .await;
        let err = publish_with_base(&cfg(SITE), &update_input(), &server.uri())
            .await
            .unwrap_err();
        assert!(
            matches!(err, PublishError::UnexpectedResponse(_)),
            "got {err:?}"
        );
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_post_401_maps_to_auth_error_without_create_fallback() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://myblog.example.com/?p=7", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(401).set_body_string("nope"))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish_with_base(&cfg(SITE), &update_input(), &server.uri())
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_rejects_missing_expected_revision_without_touching_server() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.update_target = Some(UpdateTarget {
            remote_id: REMOTE_ID.into(),
            expected_revision: None,
        });
        let err = publish_with_base(&cfg(SITE), &inp, &server.uri())
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn publish_update_rejects_wrong_revision_provider_without_touching_server() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.update_target = Some(UpdateTarget {
            remote_id: REMOTE_ID.into(),
            expected_revision: Some(ProviderRevision::Ghost {
                updated_at: "iso".into(),
            }),
        });
        let err = publish_with_base(&cfg(SITE), &inp, &server.uri())
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn publish_update_rejects_empty_revision_fields_without_touching_server() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.update_target = Some(UpdateTarget {
            remote_id: REMOTE_ID.into(),
            expected_revision: Some(ProviderRevision::WordPress {
                modified: None,
                modified_gmt: None,
            }),
        });
        let err = publish_with_base(&cfg(SITE), &inp, &server.uri())
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    async fn assert_preflight_rejects_remote_id(raw_id: &str) {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.update_target = Some(UpdateTarget {
            remote_id: raw_id.into(),
            expected_revision: Some(ProviderRevision::WordPress {
                modified: Some(EXPECTED_MODIFIED.into()),
                modified_gmt: Some(EXPECTED_MODIFIED_GMT.into()),
            }),
        });
        let err = publish_with_base(&cfg(SITE), &inp, &server.uri())
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn publish_update_rejects_path_traversal_and_query_hash_in_remote_id() {
        assert_preflight_rejects_remote_id("").await;
        assert_preflight_rejects_remote_id("7/../etc").await;
        assert_preflight_rejects_remote_id("7?x=1").await;
        assert_preflight_rejects_remote_id("7#frag").await;
        assert_preflight_rejects_remote_id("7 ").await;
        assert_preflight_rejects_remote_id("7中").await;
    }

    #[tokio::test]
    async fn publish_update_rejects_noncanonical_or_nonnumeric_remote_id_before_any_request() {
        assert_preflight_rejects_remote_id("abc").await;
        assert_preflight_rejects_remote_id("0").await;
        assert_preflight_rejects_remote_id("00007").await;
        assert_preflight_rejects_remote_id("007").await;
        assert_preflight_rejects_remote_id("-7").await;
        assert_preflight_rejects_remote_id("+7").await;
        assert_preflight_rejects_remote_id("7_1").await;
        assert_preflight_rejects_remote_id("7-1").await;
        assert_preflight_rejects_remote_id("7a").await;
        assert_preflight_rejects_remote_id("18446744073709551616").await;
        assert_preflight_rejects_remote_id("99999999999999999999").await;
    }

    #[tokio::test]
    async fn publish_update_rejects_whitespace_only_expected_revision_before_any_request() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.update_target = Some(UpdateTarget {
            remote_id: REMOTE_ID.into(),
            expected_revision: Some(ProviderRevision::WordPress {
                modified: Some("   ".into()),
                modified_gmt: Some("\t\n".into()),
            }),
        });
        let err = publish_with_base(&cfg(SITE), &inp, &server.uri())
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn publish_update_post_success_with_missing_both_revision_fields_returns_unexpected_response(
    ) {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://myblog.example.com/?p=7", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 7,
                "link": "https://myblog.example.com/?p=7",
            })))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish_with_base(&cfg(SITE), &update_input(), &server.uri())
            .await
            .unwrap_err();
        assert!(
            matches!(err, PublishError::UnexpectedResponse(_)),
            "got {err:?}"
        );
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_post_success_with_whitespace_only_revision_fields_returns_unexpected_response(
    ) {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://myblog.example.com/?p=7", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 7,
                "link": "https://myblog.example.com/?p=7",
                "modified": "  ",
                "modified_gmt": "\t\n",
            })))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish_with_base(&cfg(SITE), &update_input(), &server.uri())
            .await
            .unwrap_err();
        assert!(
            matches!(err, PublishError::UnexpectedResponse(_)),
            "got {err:?}"
        );
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_post_success_with_only_modified_gmt_returns_updated() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://myblog.example.com/?p=7", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 7,
                "link": "https://myblog.example.com/?p=7",
                "modified_gmt": REFRESHED_MODIFIED_GMT,
            })))
            .expect(1)
            .mount(&server)
            .await;
        let result = publish_with_base(&cfg(SITE), &update_input(), &server.uri())
            .await
            .expect("update should succeed with only modified_gmt");
        match result.provider_revision {
            Some(ProviderRevision::WordPress {
                modified,
                modified_gmt,
            }) => {
                assert!(modified.is_none());
                assert_eq!(modified_gmt.as_deref(), Some(REFRESHED_MODIFIED_GMT));
            }
            other => panic!("expected WordPress revision, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn upload_image_401_stops_workflow_before_any_publish_or_update_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/media")))
            .respond_with(ResponseTemplate::new(401).set_body_string("invalid credentials"))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts")))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not create"))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not update"))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not fetch"))
            .expect(0)
            .mount(&server)
            .await;
        let err = upload_image_with_base(
            SITE,
            "tok",
            vec![1, 2, 3],
            "cover.png".into(),
            "image/png".into(),
            &server.uri(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
        let requests = server.received_requests().await.unwrap_or_default();
        assert_eq!(requests.len(), 1, "only media endpoint should be requested");
        assert_eq!(requests[0].url.path(), format!("/wp/v2/sites/{SITE}/media"));
    }

    #[tokio::test]
    async fn upload_image_500_stops_workflow_before_any_publish_or_update_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/media")))
            .respond_with(ResponseTemplate::new(503).set_body_string("service down"))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts")))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not create"))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not update"))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not fetch"))
            .expect(0)
            .mount(&server)
            .await;
        let err = upload_image_with_base(
            SITE,
            "tok",
            vec![1, 2, 3],
            "cover.png".into(),
            "image/png".into(),
            &server.uri(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, PublishError::Server { status: 503, .. }),
            "got {err:?}"
        );
        let requests = server.received_requests().await.unwrap_or_default();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].url.path(), format!("/wp/v2/sites/{SITE}/media"));
    }

    #[tokio::test]
    async fn publish_absent_update_target_still_creates_via_bare_site_scoped_posts_path() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts")))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 999,
                "link": "https://myblog.example.com/?p=999",
                "modified": "2026-07-17T09:00:00",
                "modified_gmt": "2026-07-17T01:00:00",
            })))
            .expect(1)
            .mount(&server)
            .await;
        let result = publish_with_base(&cfg(SITE), &input(), &server.uri())
            .await
            .unwrap();
        assert_eq!(result.operation, PublishOperation::Created);
        assert_eq!(result.remote_id, "999");
    }

    const CH_ID_COM: &str = "wp-com-personal_1";

    fn bind_body_com(id: u64, link: &str, m: &str, gmt: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "link": link,
            "modified": m,
            "modified_gmt": gmt,
        })
    }

    #[tokio::test]
    async fn verify_binding_by_id_returns_canonical() {
        let server = MockServer::start().await;
        let link = format!("https://{SITE}/hello/");
        let numeric_id: u64 = REMOTE_ID.parse().unwrap();
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .and(query_param("context", "edit"))
            .respond_with(ResponseTemplate::new(200).set_body_json(bind_body_com(
                numeric_id,
                &link,
                EXPECTED_MODIFIED,
                EXPECTED_MODIFIED_GMT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let vb = super::verify_binding_with_base(CH_ID_COM, &cfg(SITE), REMOTE_ID, &server.uri())
            .await
            .expect("should verify");
        assert_eq!(vb.channel_id, CH_ID_COM);
        assert_eq!(vb.provider, "wordpress_com");
        assert_eq!(vb.remote_id, REMOTE_ID);
        assert_eq!(vb.url, link);
        assert!(matches!(
            vb.capability,
            crate::services::publish::binding::BindingCapability::Updatable
        ));
    }

    #[tokio::test]
    async fn verify_binding_by_permalink_slug_uses_slug_query() {
        let server = MockServer::start().await;
        let link = format!("https://{SITE}/hello/");
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts")))
            .and(query_param("slug", "hello"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                bind_body_com(42, &link, EXPECTED_MODIFIED, EXPECTED_MODIFIED_GMT)
            ])))
            .expect(1)
            .mount(&server)
            .await;
        let vb = super::verify_binding_with_base(
            CH_ID_COM,
            &cfg(SITE),
            &format!("https://{SITE}/hello/"),
            &server.uri(),
        )
        .await
        .unwrap();
        assert_eq!(vb.remote_id, "42");
    }

    #[tokio::test]
    async fn verify_binding_by_cjk_slug_url_percent_decodes() {
        let server = MockServer::start().await;
        let link = format!("https://{SITE}/\u{7b2c}\u{4e00}\u{7ae0}/");
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts")))
            .and(query_param("slug", "\u{7b2c}\u{4e00}\u{7ae0}"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                bind_body_com(42, &link, EXPECTED_MODIFIED, EXPECTED_MODIFIED_GMT)
            ])))
            .expect(1)
            .mount(&server)
            .await;
        let vb = super::verify_binding_with_base(
            CH_ID_COM,
            &cfg(SITE),
            &format!("https://{SITE}/%E7%AC%AC%E4%B8%80%E7%AB%A0/"),
            &server.uri(),
        )
        .await
        .unwrap();
        assert_eq!(vb.remote_id, "42");
    }

    #[tokio::test]
    async fn verify_binding_rejects_wrong_site_domain_url() {
        let err = super::verify_binding_with_base(
            CH_ID_COM,
            &cfg(SITE),
            "https://stranger.example.com/hello/",
            "https://public-api.wordpress.com",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn verify_binding_rejects_subdomain_of_selected_site() {
        let err = super::verify_binding_with_base(
            CH_ID_COM,
            &cfg(SITE),
            &format!("https://evil.{SITE}/hello/"),
            "https://public-api.wordpress.com",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn verify_binding_rejects_domain_site_scheme_downgrade() {
        let err = super::verify_binding_with_base(
            CH_ID_COM,
            &cfg(SITE),
            &format!("http://{SITE}/hello/"),
            "https://public-api.wordpress.com",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn verify_binding_rejects_domain_site_alternate_port() {
        let err = super::verify_binding_with_base(
            CH_ID_COM,
            &cfg(SITE),
            &format!("https://{SITE}:8443/hello/"),
            "https://public-api.wordpress.com",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn verify_binding_rejects_domain_site_response_authority_mismatch() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .and(query_param("context", "edit"))
            .respond_with(ResponseTemplate::new(200).set_body_json(bind_body_com(
                REMOTE_ID.parse().unwrap(),
                "https://evil.myblog.example.com/?p=7",
                EXPECTED_MODIFIED,
                EXPECTED_MODIFIED_GMT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let err = super::verify_binding_with_base(CH_ID_COM, &cfg(SITE), REMOTE_ID, &server.uri())
            .await
            .unwrap_err();
        assert!(
            matches!(err, PublishError::UnexpectedResponse(_)),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn verify_binding_numeric_site_rejects_url_host_that_disagrees_with_response_link() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/wp/v2/sites/12345/posts/7"))
            .and(query_param("context", "edit"))
            .respond_with(ResponseTemplate::new(200).set_body_json(bind_body_com(
                7,
                &format!("https://{SITE}/?p=7"),
                EXPECTED_MODIFIED,
                EXPECTED_MODIFIED_GMT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let err = super::verify_binding_with_base(
            CH_ID_COM,
            &cfg("12345"),
            "https://stranger.example.com/?p=7",
            &server.uri(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, PublishError::UnexpectedResponse(_)),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn verify_binding_numeric_site_rejects_url_scheme_that_disagrees_with_response_link() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/wp/v2/sites/12345/posts/7"))
            .and(query_param("context", "edit"))
            .respond_with(ResponseTemplate::new(200).set_body_json(bind_body_com(
                7,
                &format!("https://{SITE}/?p=7"),
                EXPECTED_MODIFIED,
                EXPECTED_MODIFIED_GMT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let err = super::verify_binding_with_base(
            CH_ID_COM,
            &cfg("12345"),
            &format!("http://{SITE}/?p=7"),
            &server.uri(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, PublishError::UnexpectedResponse(_)),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn verify_binding_numeric_site_rejects_url_port_that_disagrees_with_response_link() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/wp/v2/sites/12345/posts/7"))
            .and(query_param("context", "edit"))
            .respond_with(ResponseTemplate::new(200).set_body_json(bind_body_com(
                7,
                &format!("https://{SITE}/?p=7"),
                EXPECTED_MODIFIED,
                EXPECTED_MODIFIED_GMT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let err = super::verify_binding_with_base(
            CH_ID_COM,
            &cfg("12345"),
            &format!("https://{SITE}:8443/?p=7"),
            &server.uri(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, PublishError::UnexpectedResponse(_)),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn verify_binding_rejects_noncanonical_id() {
        for bad in ["", "0", "042", "abc", "-42"] {
            let err = super::verify_binding_with_base(
                CH_ID_COM,
                &cfg(SITE),
                bad,
                "https://public-api.wordpress.com",
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
    async fn verify_binding_404_maps_to_remote_not_found() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/wp/v2/sites/{SITE}/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(404).set_body_string("gone"))
            .mount(&server)
            .await;
        let err = super::verify_binding_with_base(CH_ID_COM, &cfg(SITE), REMOTE_ID, &server.uri())
            .await
            .unwrap_err();
        assert!(
            matches!(err, PublishError::RemoteNotFound { .. }),
            "got {err:?}"
        );
    }
}
