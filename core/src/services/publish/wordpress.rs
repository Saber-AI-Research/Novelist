//! WordPress (self-hosted, REST API) publish adapter.
//!
//! Wire (HTTP Basic with Application Password):
//! - GET  /wp-json/wp/v2/users/me           — connectivity check
//! - GET  /wp-json/wp/v2/tags?search=<name> — resolve tag id by name
//! - POST /wp-json/wp/v2/tags { name }      — create tag if missing
//! - POST /wp-json/wp/v2/media              — image upload (raw body
//!   with Content-Disposition + Content-Type), returns id + source_url
//! - POST /wp-json/wp/v2/posts              — create post with HTML
//!   body, status, title, slug, excerpt, tags (id array),
//!   featured_media (attachment id)
//!
//! Reference: https://developer.wordpress.org/rest-api/reference/posts/
//! Application Passwords:
//! https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/

use crate::models::publish::PlatformConfig;
use crate::services::publish::binding::{
    assert_authority_matches, decoded_last_segment, parse_binding_input, parse_channel_base,
    preflight_input, wordpress_query_id, BindingCapability, ParsedInput, VerifiedBinding,
};
use crate::services::publish::types::{
    ProviderRevision, PublishError, PublishInput, PublishResult, UpdateConflictContext,
    UpdateTarget,
};
use base64::Engine;

const MAX_REMOTE_ID_LEN: usize = 128;

/// Build the `Authorization: Basic ...` header value.
/// Spaces in the application password are stripped first
/// (per WP integration guide; the password as displayed contains
/// spaces for readability).
pub fn basic_auth_header(username: &str, app_password: &str) -> String {
    let pw = app_password.replace(' ', "");
    let pair = format!("{username}:{pw}");
    let encoded = base64::engine::general_purpose::STANDARD.encode(pair.as_bytes());
    format!("Basic {encoded}")
}

/// Read-only credentials check: `GET /wp-json/wp/v2/users/me`. Returns
/// the user's display name on success.
pub async fn verify(
    site_url: &str,
    username: &str,
    app_password: &str,
) -> Result<String, PublishError> {
    if site_url.is_empty() || username.is_empty() || app_password.is_empty() {
        return Err(PublishError::BadConfig(
            "wordpress config missing site_url / username / app_password".into(),
        ));
    }
    let auth = basic_auth_header(username, app_password);
    let endpoint = format!("{}/wp-json/wp/v2/users/me", site_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .get(&endpoint)
        .header("Authorization", &auth)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "json").await?;
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("WordPress user");
    Ok(format!("Connected as {name}"))
}

pub async fn upload_image(
    site_url: &str,
    auth: &str,
    bytes: Vec<u8>,
    filename: String,
    mime: String,
) -> Result<(String, u64), PublishError> {
    let endpoint = format!("{}/wp-json/wp/v2/media", site_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .post(&endpoint)
        .header("Authorization", auth)
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

pub async fn resolve_tag_ids(
    site_url: &str,
    auth: &str,
    tag_names: &[String],
) -> Result<Vec<u64>, PublishError> {
    let mut out = Vec::with_capacity(tag_names.len());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let base = site_url.trim_end_matches('/');
    for name in tag_names {
        let resp = client
            .get(format!("{base}/wp-json/wp/v2/tags"))
            .query(&[("search", name)])
            .header("Authorization", auth)
            .send()
            .await
            .map_err(crate::services::publish::types::redact_reqwest_error)?;
        let resp = crate::services::publish::require_success(resp).await?;
        let body: serde_json::Value =
            crate::services::publish::parse_json_response(resp, "json").await?;
        // Search might return multiple — find one whose `name` matches case-insensitively
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
        // Create the tag.
        let create = client
            .post(format!("{base}/wp-json/wp/v2/tags"))
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

/// Extract self-hosted WordPress credentials from `PlatformConfig`.
/// Fails closed on non-WordPress configs or missing fields; kept
/// separate from `wordpress_com::wp_com_creds` so route logic never
/// mixes with the WordPress.com site-scoped adapter.
fn wp_creds(config: &PlatformConfig) -> Result<(&str, &str, &str), PublishError> {
    let (site_url, username, app_password) = match config {
        PlatformConfig::WordPressSelfHosted {
            site_url,
            username,
            app_password,
        } => (site_url.as_str(), username.as_str(), app_password.as_str()),
        _ => return Err(PublishError::BadConfig("not a WordPress config".into())),
    };
    if site_url.is_empty() || username.is_empty() || app_password.is_empty() {
        return Err(PublishError::BadConfig(
            "wordpress config missing site_url / username / app_password".into(),
        ));
    }
    Ok((site_url, username, app_password))
}

fn validate_remote_id_wp(remote_id: &str) -> Result<u64, PublishError> {
    if remote_id.is_empty() {
        return Err(PublishError::BadConfig(
            "wordpress update requires update_target.remote_id".into(),
        ));
    }
    if remote_id.len() > MAX_REMOTE_ID_LEN {
        return Err(PublishError::BadConfig(format!(
            "wordpress remote_id exceeds {MAX_REMOTE_ID_LEN} bytes"
        )));
    }
    if !remote_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err(PublishError::BadConfig(
            "wordpress remote_id must be a positive canonical base-10 u64 integer with only ASCII digits (no signs, letters, path/query/hash/whitespace characters)".into(),
        ));
    }
    let parsed: u64 = remote_id
        .parse()
        .map_err(|_| PublishError::BadConfig("wordpress remote_id exceeds the u64 range".into()))?;
    if parsed == 0 {
        return Err(PublishError::BadConfig(
            "wordpress remote_id must be greater than zero".into(),
        ));
    }
    if parsed.to_string() != remote_id {
        return Err(PublishError::BadConfig(
            "wordpress remote_id must be canonical (no leading zeros)".into(),
        ));
    }
    Ok(parsed)
}

fn validate_wp_update_target(
    update_target: &UpdateTarget,
) -> Result<(u64, Option<String>, Option<String>), PublishError> {
    let parsed_id = validate_remote_id_wp(&update_target.remote_id)?;
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
                    "wordpress update requires expected_revision with at least one non-empty (non-whitespace) modified or modified_gmt field".into(),
                ));
            }
            Ok((parsed_id, m, g))
        }
        Some(ProviderRevision::Ghost { .. }) => Err(PublishError::BadConfig(
            "wordpress update requires expected_revision=ProviderRevision::WordPress; got Ghost variant".into(),
        )),
        None => Err(PublishError::BadConfig(
            "wordpress update requires expected_revision=ProviderRevision::WordPress { modified, modified_gmt }".into(),
        )),
    }
}

struct FetchedWpPost {
    id: u64,
    link: String,
    modified: Option<String>,
    modified_gmt: Option<String>,
    featured_media: Option<u64>,
}

/// GET `/wp-json/wp/v2/posts/{id}?context=edit` to verify existence
/// and read the current revision fields.
async fn fetch_wp_post(
    site_url: &str,
    auth: &str,
    remote_id: &str,
) -> Result<FetchedWpPost, PublishError> {
    let endpoint = format!(
        "{}/wp-json/wp/v2/posts/{remote_id}",
        site_url.trim_end_matches('/')
    );
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
            provider: "wordpress".into(),
            remote_id: remote_id.to_string(),
        });
    }
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "wordpress GET json").await?;
    parse_fetched_wp_post(&body)
}

fn parse_fetched_wp_post(body: &serde_json::Value) -> Result<FetchedWpPost, PublishError> {
    let id = body
        .get("id")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| PublishError::UnexpectedResponse("wordpress GET missing id".into()))?;
    let link = body
        .get("link")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("wordpress GET missing link".into()))?
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
            "wordpress GET missing both modified and modified_gmt".into(),
        ));
    }
    let featured_media = body.get("featured_media").and_then(|v| v.as_u64());
    Ok(FetchedWpPost {
        id,
        link,
        modified,
        modified_gmt,
        featured_media,
    })
}

/// Compare the expected revision against the fetched revision. WP
/// does not enforce revision echoing on update (unlike Ghost), so
/// this is best-effort drift detection. Semantics: for each expected
/// field that is `Some`, the corresponding fetched field must equal
/// it. Missing fetched field or value mismatch returns
/// `UpdateConflict`.
fn compare_wp_revisions(
    expected_modified: Option<&str>,
    expected_modified_gmt: Option<&str>,
    fetched: &FetchedWpPost,
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
            provider: "wordpress".into(),
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

/// Read-only update preflight used by the frontend orchestrator before it
/// starts side-effectful media uploads. The update path repeats this check so
/// direct adapter callers and changes between IPC calls still fail closed.
pub async fn verify_update(
    config: &PlatformConfig,
    update_target: &UpdateTarget,
) -> Result<(), PublishError> {
    let (site_url, username, app_password) = wp_creds(config)?;
    let (tracked_id_num, expected_modified, expected_modified_gmt) =
        validate_wp_update_target(update_target)?;
    let auth = basic_auth_header(username, app_password);
    let fetched = fetch_wp_post(site_url, &auth, &update_target.remote_id).await?;
    if fetched.id != tracked_id_num {
        return Err(PublishError::UnexpectedResponse(
            "wordpress GET returned a different post id than the tracked one".into(),
        ));
    }
    compare_wp_revisions(
        expected_modified.as_deref(),
        expected_modified_gmt.as_deref(),
        &fetched,
        &update_target.remote_id,
    )
}

/// Build the update payload. Fields:
/// - title, content, status: always included.
/// - slug, excerpt: included only when caller supplies them.
/// - tags: array of resolved tag IDs (empty vec when no tags).
/// - featured_media: input's value when `Some`; otherwise echoed
///   from the fetched post when it has one. Omitted when neither
///   source supplies a media id.
fn build_wp_update_body(
    input: &PublishInput,
    fetched: &FetchedWpPost,
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
    // Featured media: input takes precedence (already uploaded
    // outside the adapter — see commands::publish::upload_post_image_
    // wordpress_self_hosted). When absent, echo the fetched value to
    // avoid an accidental clear on stale-form re-publish.
    let effective_media = input.featured_media_id.or(fetched.featured_media);
    if let Some(media_id) = effective_media {
        payload["featured_media"] = serde_json::Value::Number(media_id.into());
    }
    payload
}

/// Update an existing WordPress self-hosted post in place. See
/// module docstring for the request sequence; every negative-path
/// test asserts zero fallback to POST /posts (create).
pub async fn update_post(
    config: &PlatformConfig,
    input: &PublishInput,
) -> Result<PublishResult, PublishError> {
    let (site_url, username, app_password) = wp_creds(config)?;
    let update_target = input.update_target.as_ref().ok_or_else(|| {
        PublishError::BadConfig("update_post requires PublishInput.update_target".into())
    })?;
    let (tracked_id_num, expected_modified, expected_modified_gmt) =
        validate_wp_update_target(update_target)?;
    let tracked_id = update_target.remote_id.clone();
    let auth = basic_auth_header(username, app_password);

    let fetched = fetch_wp_post(site_url, &auth, &tracked_id).await?;
    if fetched.id != tracked_id_num {
        return Err(PublishError::UnexpectedResponse(
            "wordpress GET returned a different post id than the tracked one".into(),
        ));
    }
    compare_wp_revisions(
        expected_modified.as_deref(),
        expected_modified_gmt.as_deref(),
        &fetched,
        &tracked_id,
    )?;

    let tag_ids = if input.tags.is_empty() {
        Vec::new()
    } else {
        resolve_tag_ids(site_url, &auth, &input.tags).await?
    };

    let payload = build_wp_update_body(input, &fetched, &tag_ids);
    let endpoint = format!(
        "{}/wp-json/wp/v2/posts/{tracked_id}",
        site_url.trim_end_matches('/')
    );
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
            provider: "wordpress".into(),
            remote_id: tracked_id,
        });
    }
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "wordpress update json").await?;
    let refreshed_id = body
        .get("id")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| PublishError::UnexpectedResponse("wordpress update missing id".into()))?;
    if refreshed_id != tracked_id_num {
        return Err(PublishError::UnexpectedResponse(
            "wordpress update returned a different post id than the tracked one".into(),
        ));
    }
    let refreshed_link = body
        .get("link")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("wordpress update missing link".into()))?
        .to_string();
    let refreshed_revision = parse_refreshed_wp_revision(&body)?;
    Ok(PublishResult::updated(
        refreshed_link,
        refreshed_id.to_string(),
        Some(refreshed_revision),
    ))
}

fn parse_refreshed_wp_revision(body: &serde_json::Value) -> Result<ProviderRevision, PublishError> {
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
            "wordpress update response has no usable modified or modified_gmt field".into(),
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
    if input.update_target.is_some() {
        return update_post(config, input).await;
    }
    let (site_url, username, app_password) = wp_creds(config)?;
    let auth = basic_auth_header(username, app_password);

    let tag_ids = if input.tags.is_empty() {
        Vec::new()
    } else {
        resolve_tag_ids(site_url, &auth, &input.tags).await?
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

    let endpoint = format!("{}/wp-json/wp/v2/posts", site_url.trim_end_matches('/'));
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
    let revision = parse_refreshed_wp_revision(&body)?;
    Ok(PublishResult::created_with_revision(
        url,
        id.to_string(),
        revision,
    ))
}

async fn fetch_wp_post_by_slug(
    site_url: &str,
    auth: &str,
    slug: &str,
) -> Result<FetchedWpPost, PublishError> {
    let endpoint = format!("{}/wp-json/wp/v2/posts", site_url.trim_end_matches('/'));
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
        crate::services::publish::parse_json_response(resp, "wordpress bind json").await?;
    let items = arr.as_array().ok_or_else(|| {
        PublishError::UnexpectedResponse("wordpress slug lookup did not return an array".into())
    })?;
    match items.len() {
        0 => Err(PublishError::RemoteNotFound {
            provider: "wordpress".into(),
            remote_id: slug.to_string(),
        }),
        1 => parse_fetched_wp_post(&items[0]),
        _ => Err(PublishError::UnexpectedResponse(
            "wordpress slug lookup returned multiple posts; slug must be unique per site".into(),
        )),
    }
}

pub async fn verify_binding(
    channel_id: &str,
    config: &PlatformConfig,
    raw_input: &str,
) -> Result<VerifiedBinding, PublishError> {
    let (site_url, username, app_password) = wp_creds(config)?;
    let base = parse_channel_base(site_url)?;
    let trimmed = preflight_input(raw_input)?;
    let parsed = parse_binding_input(&trimmed)?;
    let auth = basic_auth_header(username, app_password);

    let (tracked_id_num, fetched) = match parsed {
        ParsedInput::Id(candidate) => {
            let id_num = validate_remote_id_wp(&candidate)?;
            let fetched = fetch_wp_post(site_url, &auth, &candidate).await?;
            (id_num, fetched)
        }
        ParsedInput::Url(url) => {
            assert_authority_matches(&url, &base)?;
            if let Some(query_id) = wordpress_query_id(&url) {
                let id_num = validate_remote_id_wp(&query_id)?;
                let fetched = fetch_wp_post(site_url, &auth, &query_id).await?;
                (id_num, fetched)
            } else {
                let slug = decoded_last_segment(&url)?.ok_or_else(|| {
                    PublishError::BadConfig(
                        "wordpress bind URL must include ?p=<id> or a permalink slug".into(),
                    )
                })?;
                if slug.is_empty() {
                    return Err(PublishError::BadConfig(
                        "wordpress bind URL slug is empty".into(),
                    ));
                }
                let fetched = fetch_wp_post_by_slug(site_url, &auth, &slug).await?;
                (fetched.id, fetched)
            }
        }
    };

    if fetched.id != tracked_id_num {
        return Err(PublishError::UnexpectedResponse(
            "wordpress bind response id disagrees with request".into(),
        ));
    }

    let canonical_parsed = url::Url::parse(&fetched.link).map_err(|_| {
        PublishError::UnexpectedResponse("wordpress bind link is not a valid URL".into())
    })?;
    assert_authority_matches(&canonical_parsed, &base).map_err(|_| {
        PublishError::UnexpectedResponse(
            "wordpress bind link host does not match selected channel".into(),
        )
    })?;

    let revision = build_wp_revision_from_fetched(&fetched)?;
    let link = fetched.link.clone();

    Ok(VerifiedBinding {
        channel_id: channel_id.to_string(),
        provider: "wordpress".into(),
        remote_id: fetched.id.to_string(),
        url: link,
        revision: Some(revision),
        capability: BindingCapability::Updatable,
    })
}

fn build_wp_revision_from_fetched(
    fetched: &FetchedWpPost,
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
            "wordpress bind response has no usable modified or modified_gmt".into(),
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

    const REMOTE_ID: &str = "42";
    const EXPECTED_MODIFIED: &str = "2026-07-16T09:00:00";
    const EXPECTED_MODIFIED_GMT: &str = "2026-07-16T09:00:00";
    const REFRESHED_MODIFIED: &str = "2026-07-16T09:05:00";
    const REFRESHED_MODIFIED_GMT: &str = "2026-07-16T09:05:00";

    fn cfg(site_url: &str) -> PlatformConfig {
        PlatformConfig::WordPressSelfHosted {
            site_url: site_url.into(),
            username: "alice".into(),
            app_password: "abcd EFGH 1234 ijkl MNOP 6789".into(),
        }
    }

    fn input() -> PublishInput {
        PublishInput {
            title: "Hello".into(),
            body: "<p>world</p>".into(),
            body_format: BodyFormat::Html,
            tags: vec!["rust".into()],
            slug: Some("hello".into()),
            excerpt: Some("brief".into()),
            status: "draft".into(),
            feature_image_url: None,
            featured_media_id: Some(7),
            publication_id: None,
            update_target: None,
        }
    }

    #[test]
    fn basic_auth_strips_spaces_from_password() {
        let h = basic_auth_header("alice", "abcd EFGH 1234");
        // base64("alice:abcdEFGH1234") = YWxpY2U6YWJjZEVGR0gxMjM0
        assert_eq!(h, "Basic YWxpY2U6YWJjZEVGR0gxMjM0");
    }

    #[tokio::test]
    async fn upload_image_returns_id_and_url() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/wp-json/wp/v2/media"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 42,
                "source_url": "https://example.com/wp-content/uploads/x.png"
            })))
            .mount(&server)
            .await;
        let auth = basic_auth_header("alice", "p");
        let (url, id) = upload_image(
            &server.uri(),
            &auth,
            vec![1, 2, 3],
            "x.png".into(),
            "image/png".into(),
        )
        .await
        .unwrap();
        assert_eq!(id, 42);
        assert_eq!(url, "https://example.com/wp-content/uploads/x.png");
    }

    #[tokio::test]
    async fn upload_image_encodes_cjk_filename_in_content_disposition() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/wp-json/wp/v2/media"))
            .and(header(
                "Content-Disposition",
                "attachment; filename=\"__.png\"; filename*=UTF-8''%E5%B0%81%E9%9D%A2.png",
            ))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 42,
                "source_url": "https://example.com/wp-content/uploads/cover.png"
            })))
            .mount(&server)
            .await;

        upload_image(
            &server.uri(),
            &basic_auth_header("alice", "p"),
            vec![1, 2, 3],
            "封面.png".into(),
            "image/png".into(),
        )
        .await
        .expect("CJK filename should produce an ASCII-safe upload header");
    }

    #[tokio::test]
    async fn resolve_tag_ids_finds_existing_or_creates() {
        let server = MockServer::start().await;
        // existing tag
        Mock::given(method("GET"))
            .and(path("/wp-json/wp/v2/tags"))
            .and(query_param("search", "rust"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"id": 10, "name": "rust"}
            ])))
            .mount(&server)
            .await;
        // missing tag → POST to create
        Mock::given(method("GET"))
            .and(path("/wp-json/wp/v2/tags"))
            .and(query_param("search", "tauri"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/wp-json/wp/v2/tags"))
            .respond_with(
                ResponseTemplate::new(201)
                    .set_body_json(serde_json::json!({"id": 20, "name": "tauri"})),
            )
            .mount(&server)
            .await;
        let auth = basic_auth_header("alice", "p");
        let ids = resolve_tag_ids(&server.uri(), &auth, &["rust".into(), "tauri".into()])
            .await
            .unwrap();
        assert_eq!(ids, vec![10, 20]);
    }

    #[tokio::test]
    async fn publish_creates_post_with_resolved_tags() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/wp-json/wp/v2/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"id": 10, "name": "rust"}
            ])))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/wp-json/wp/v2/posts"))
            .and(header(
                "Authorization",
                "Basic YWxpY2U6YWJjZEVGR0gxMjM0aWprbE1OT1A2Nzg5",
            ))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 99,
                "link": "https://example.com/?p=99",
                "slug": "hello",
                "modified": "2026-07-17T09:00:00",
                "modified_gmt": "2026-07-17T01:00:00"
            })))
            .mount(&server)
            .await;
        let result = publish(&cfg(&server.uri()), &input()).await.unwrap();
        assert_eq!(result.remote_id, "99");
        assert_eq!(result.url, "https://example.com/?p=99");
        assert_eq!(
            result.provider_revision,
            Some(ProviderRevision::WordPress {
                modified: Some("2026-07-17T09:00:00".into()),
                modified_gmt: Some("2026-07-17T01:00:00".into()),
            })
        );
    }

    #[tokio::test]
    async fn publish_401_is_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(401).set_body_string("nope"))
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &input()).await.unwrap_err();
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn empty_field_is_bad_config() {
        let cfg = PlatformConfig::WordPressSelfHosted {
            site_url: "".into(),
            username: "a".into(),
            app_password: "p".into(),
        };
        let err = publish(&cfg, &input()).await.unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    fn update_input() -> PublishInput {
        let mut inp = input();
        inp.featured_media_id = None;
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
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
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
            .and(path("/wp-json/wp/v2/posts"))
            .respond_with(ResponseTemplate::new(500).set_body_string("unexpected create"))
            .expect(0)
            .mount(server)
            .await;
    }

    async fn mount_no_update(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(500).set_body_string("unexpected update"))
            .expect(0)
            .mount(server)
            .await;
    }

    async fn assert_no_create_post(server: &MockServer) {
        let requests = server.received_requests().await.unwrap_or_default();
        let bare = requests
            .iter()
            .filter(|r| {
                r.method == wiremock::http::Method::POST && r.url.path() == "/wp-json/wp/v2/posts"
            })
            .count();
        assert_eq!(
            bare, 0,
            "must not fall back to bare POST /wp/v2/posts (create)"
        );
    }

    async fn assert_no_update_post(server: &MockServer) {
        let requests = server.received_requests().await.unwrap_or_default();
        let update_path = format!("/wp-json/wp/v2/posts/{REMOTE_ID}");
        let updates = requests
            .iter()
            .filter(|r| r.method == wiremock::http::Method::POST && r.url.path() == update_path)
            .count();
        assert_eq!(
            updates, 0,
            "must not POST update after preflight or GET failure"
        );
    }

    fn assert_authorization_basic_scheme(req: &Request) {
        let auth = req
            .headers
            .get("authorization")
            .expect("authorization header")
            .to_str()
            .expect("authorization header decodes");
        assert!(
            auth.starts_with("Basic "),
            "authorization must use Basic scheme (value elided)"
        );
    }

    #[tokio::test]
    async fn publish_update_issues_get_then_post_update_on_self_hosted_route() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://example.com/?p=42", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(refreshed_ok_body(42, "https://example.com/?p=42")),
            )
            .expect(1)
            .mount(&server)
            .await;
        let result = publish(&cfg(&server.uri()), &update_input())
            .await
            .expect("update should succeed");
        assert_eq!(result.remote_id, REMOTE_ID);
        assert_eq!(result.url, "https://example.com/?p=42");
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
            format!("/wp-json/wp/v2/posts/{REMOTE_ID}")
        );
        assert_eq!(
            requests[1].url.path(),
            format!("/wp-json/wp/v2/posts/{REMOTE_ID}")
        );
        assert_authorization_basic_scheme(&requests[0]);
        assert_authorization_basic_scheme(&requests[1]);
        let body = extract_update_body(&requests[1]);
        assert_eq!(body["title"], "Hello");
        assert_eq!(body["content"], "<p>world</p>");
        assert_eq!(body["status"], "draft");
        assert_eq!(body["slug"], "hello");
        assert_eq!(body["excerpt"], "brief");
        assert_eq!(body["tags"], serde_json::json!([]));
        assert!(
            body.get("featured_media").is_none(),
            "no cover in input and none fetched → omit featured_media, got: {body}"
        );
    }

    #[tokio::test]
    async fn verify_update_preflight_issues_only_the_authenticated_revision_get() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        mount_get_success(&server, "https://example.com/?p=42", Some(77)).await;
        Mock::given(method("POST"))
            .and(path("/wp-json/wp/v2/media"))
            .respond_with(ResponseTemplate::new(500).set_body_string("unexpected media upload"))
            .expect(0)
            .mount(&server)
            .await;
        let input = update_input();

        verify_update(&cfg(&server.uri()), input.update_target.as_ref().unwrap())
            .await
            .expect("matching revision should pass preflight");

        let requests = server.received_requests().await.unwrap_or_default();
        assert_eq!(requests.len(), 1, "preflight must remain read-only");
        assert_eq!(requests[0].method, wiremock::http::Method::GET);
        assert_eq!(
            requests[0].url.path(),
            format!("/wp-json/wp/v2/posts/{REMOTE_ID}")
        );
        assert_eq!(requests[0].url.query(), Some("context=edit"));
        assert_authorization_basic_scheme(&requests[0]);
    }

    #[tokio::test]
    async fn verify_update_preflight_maps_404_without_side_effects() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
            .expect(1)
            .mount(&server)
            .await;

        let err = verify_update(
            &cfg(&server.uri()),
            update_input().update_target.as_ref().unwrap(),
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
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "link": "https://example.com/?p=42",
                "modified": "newer",
                "modified_gmt": "newer",
            })))
            .expect(1)
            .mount(&server)
            .await;

        let err = verify_update(
            &cfg(&server.uri()),
            update_input().update_target.as_ref().unwrap(),
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
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .expect(1)
            .mount(&server)
            .await;

        let err = verify_update(
            &cfg(&server.uri()),
            update_input().update_target.as_ref().unwrap(),
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
        mount_get_success(&server, "https://example.com/第一章/", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(refreshed_ok_body(42, "https://example.com/第一章/")),
            )
            .expect(1)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.title = "第一章 序幕".into();
        inp.body = "<p>你好，世界。</p>".into();
        let result = publish(&cfg(&server.uri()), &inp).await.unwrap();
        assert_eq!(result.url, "https://example.com/第一章/");
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
        mount_get_success(&server, "https://example.com/?p=42", Some(77)).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(refreshed_ok_body(42, "https://example.com/?p=42")),
            )
            .expect(1)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.featured_media_id = None;
        let _ = publish(&cfg(&server.uri()), &inp).await.unwrap();
        let requests = server.received_requests().await.unwrap_or_default();
        let update = requests
            .iter()
            .find(|r| r.method == wiremock::http::Method::POST)
            .expect("POST update request");
        let body = extract_update_body(update);
        assert_eq!(
            body["featured_media"], 77,
            "unchanged featured media must be preserved by echoing fetched value"
        );
    }

    #[tokio::test]
    async fn publish_update_uses_input_featured_media_id_when_provided() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://example.com/?p=42", Some(77)).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(refreshed_ok_body(42, "https://example.com/?p=42")),
            )
            .expect(1)
            .mount(&server)
            .await;
        let mut inp = update_input();
        inp.featured_media_id = Some(123);
        let _ = publish(&cfg(&server.uri()), &inp).await.unwrap();
        let requests = server.received_requests().await.unwrap_or_default();
        let update = requests
            .iter()
            .find(|r| r.method == wiremock::http::Method::POST)
            .expect("POST update request");
        let body = extract_update_body(update);
        assert_eq!(body["featured_media"], 123);
    }

    #[tokio::test]
    async fn publish_update_get_404_maps_to_remote_not_found_without_create_or_update() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(404).set_body_string("not found"))
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
                assert_eq!(provider, "wordpress");
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
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "link": "https://example.com/?p=42",
                "modified": "2026-07-16T10:00:00",
                "modified_gmt": "2026-07-16T10:00:00",
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
        assert_eq!(ctx.provider, "wordpress");
        assert_eq!(ctx.remote_id, REMOTE_ID);
        assert_eq!(
            ctx.expected,
            Some(ProviderRevision::WordPress {
                modified: Some(EXPECTED_MODIFIED.into()),
                modified_gmt: Some(EXPECTED_MODIFIED_GMT.into()),
            })
        );
        assert_eq!(
            ctx.actual,
            Some(ProviderRevision::WordPress {
                modified: Some("2026-07-16T10:00:00".into()),
                modified_gmt: Some("2026-07-16T10:00:00".into()),
            })
        );
        assert_no_update_post(&server).await;
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_get_401_maps_to_auth_error_without_update_or_create() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(401).set_body_string("invalid"))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &update_input())
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
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "link": "https://example.com/?p=42",
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
        assert_no_update_post(&server).await;
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_get_response_id_mismatch_returns_unexpected_response() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_no_update(&server).await;
        Mock::given(method("GET"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 999,
                "link": "https://example.com/?p=999",
                "modified": EXPECTED_MODIFIED,
                "modified_gmt": EXPECTED_MODIFIED_GMT,
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
        assert_no_update_post(&server).await;
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_post_404_maps_to_remote_not_found_without_create_fallback() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://example.com/?p=42", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(404).set_body_string("gone"))
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
                assert_eq!(provider, "wordpress");
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
        mount_get_success(&server, "https://example.com/?p=42", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(refreshed_ok_body(999, "https://example.com/?p=999")),
            )
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
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_post_401_maps_to_auth_error_without_create_fallback() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://example.com/?p=42", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(401).set_body_string("nope"))
            .expect(1)
            .mount(&server)
            .await;
        let err = publish(&cfg(&server.uri()), &update_input())
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
        let err = publish(&cfg(&server.uri()), &inp).await.unwrap_err();
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
        let err = publish(&cfg(&server.uri()), &inp).await.unwrap_err();
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
        let err = publish(&cfg(&server.uri()), &inp).await.unwrap_err();
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
        let err = publish(&cfg(&server.uri()), &inp).await.unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn publish_update_rejects_path_traversal_and_query_hash_in_remote_id() {
        assert_preflight_rejects_remote_id("").await;
        assert_preflight_rejects_remote_id("42/../etc").await;
        assert_preflight_rejects_remote_id("42?x=1").await;
        assert_preflight_rejects_remote_id("42#frag").await;
        assert_preflight_rejects_remote_id("42 ").await;
        assert_preflight_rejects_remote_id("42中").await;
    }

    #[tokio::test]
    async fn publish_update_rejects_noncanonical_or_nonnumeric_remote_id_before_any_request() {
        assert_preflight_rejects_remote_id("abc").await;
        assert_preflight_rejects_remote_id("0").await;
        assert_preflight_rejects_remote_id("00042").await;
        assert_preflight_rejects_remote_id("042").await;
        assert_preflight_rejects_remote_id("-42").await;
        assert_preflight_rejects_remote_id("+42").await;
        assert_preflight_rejects_remote_id("4_2").await;
        assert_preflight_rejects_remote_id("4-2").await;
        assert_preflight_rejects_remote_id("42a").await;
        assert_preflight_rejects_remote_id("18446744073709551616").await;
        assert_preflight_rejects_remote_id("99999999999999999999").await;
    }

    #[tokio::test]
    async fn publish_update_post_success_with_missing_both_revision_fields_returns_unexpected_response(
    ) {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://example.com/?p=42", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "link": "https://example.com/?p=42",
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
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_post_success_with_whitespace_only_revision_fields_returns_unexpected_response(
    ) {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://example.com/?p=42", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "link": "https://example.com/?p=42",
                "modified": "  ",
                "modified_gmt": "\t\n",
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
        assert_no_create_post(&server).await;
    }

    #[tokio::test]
    async fn publish_update_post_success_with_only_modified_gmt_returns_updated() {
        let server = MockServer::start().await;
        mount_no_create(&server).await;
        mount_get_success(&server, "https://example.com/?p=42", None).await;
        Mock::given(method("POST"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "link": "https://example.com/?p=42",
                "modified_gmt": REFRESHED_MODIFIED_GMT,
            })))
            .expect(1)
            .mount(&server)
            .await;
        let result = publish(&cfg(&server.uri()), &update_input())
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
        let err = publish(&cfg(&server.uri()), &inp).await.unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn upload_image_401_stops_workflow_before_any_publish_or_update_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/wp-json/wp/v2/media"))
            .respond_with(ResponseTemplate::new(401).set_body_string("invalid credentials"))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/wp-json/wp/v2/posts"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not create"))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not update"))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not fetch"))
            .expect(0)
            .mount(&server)
            .await;
        let auth = basic_auth_header("alice", "abcd EFGH 1234");
        let err = upload_image(
            &server.uri(),
            &auth,
            vec![1, 2, 3],
            "cover.png".into(),
            "image/png".into(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
        let requests = server.received_requests().await.unwrap_or_default();
        assert_eq!(requests.len(), 1, "only media endpoint should be requested");
        assert_eq!(requests[0].url.path(), "/wp-json/wp/v2/media");
    }

    #[tokio::test]
    async fn upload_image_500_stops_workflow_before_any_publish_or_update_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/wp-json/wp/v2/media"))
            .respond_with(ResponseTemplate::new(503).set_body_string("service down"))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/wp-json/wp/v2/posts"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not create"))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not update"))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not fetch"))
            .expect(0)
            .mount(&server)
            .await;
        let auth = basic_auth_header("alice", "p");
        let err = upload_image(
            &server.uri(),
            &auth,
            vec![1, 2, 3],
            "cover.png".into(),
            "image/png".into(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, PublishError::Server { status: 503, .. }),
            "got {err:?}"
        );
        let requests = server.received_requests().await.unwrap_or_default();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].url.path(), "/wp-json/wp/v2/media");
    }

    #[tokio::test]
    async fn publish_absent_update_target_still_creates_via_bare_posts_path() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/wp-json/wp/v2/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                {"id": 10, "name": "rust"}
            ])))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/wp-json/wp/v2/posts"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 999,
                "link": "https://example.com/?p=999",
                "modified": "2026-07-17T09:00:00",
                "modified_gmt": "2026-07-17T01:00:00",
            })))
            .expect(1)
            .mount(&server)
            .await;
        let result = publish(&cfg(&server.uri()), &input()).await.unwrap();
        assert_eq!(result.operation, PublishOperation::Created);
        assert_eq!(result.remote_id, "999");
    }

    const CH_ID: &str = "wp-personal_1";

    fn bind_body_wp(id: u64, link: &str, modified: &str, modified_gmt: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "link": link,
            "modified": modified,
            "modified_gmt": modified_gmt,
        })
    }

    #[tokio::test]
    async fn verify_binding_by_id_returns_canonical_with_modified() {
        let server = MockServer::start().await;
        let link = format!("{}/?p=42", server.uri());
        Mock::given(method("GET"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .and(query_param("context", "edit"))
            .respond_with(ResponseTemplate::new(200).set_body_json(bind_body_wp(
                42,
                &link,
                EXPECTED_MODIFIED,
                EXPECTED_MODIFIED_GMT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let vb = super::verify_binding(CH_ID, &cfg(&server.uri()), REMOTE_ID)
            .await
            .expect("should verify");
        assert_eq!(vb.channel_id, CH_ID);
        assert_eq!(vb.provider, "wordpress");
        assert_eq!(vb.remote_id, "42");
        assert_eq!(vb.url, link);
        match vb.revision.unwrap() {
            ProviderRevision::WordPress {
                modified,
                modified_gmt,
            } => {
                assert_eq!(modified.as_deref(), Some(EXPECTED_MODIFIED));
                assert_eq!(modified_gmt.as_deref(), Some(EXPECTED_MODIFIED_GMT));
            }
            other => panic!("expected WordPress, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn verify_binding_by_query_p_url() {
        let server = MockServer::start().await;
        let link = format!("{}/?p=42", server.uri());
        Mock::given(method("GET"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(bind_body_wp(
                42,
                &link,
                EXPECTED_MODIFIED,
                EXPECTED_MODIFIED_GMT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let vb = super::verify_binding(
            CH_ID,
            &cfg(&server.uri()),
            &format!("{}/?p=42", server.uri()),
        )
        .await
        .unwrap();
        assert_eq!(vb.remote_id, "42");
    }

    #[tokio::test]
    async fn verify_binding_by_permalink_slug_uses_slug_query() {
        let server = MockServer::start().await;
        let link = format!("{}/hello/", server.uri());
        Mock::given(method("GET"))
            .and(path("/wp-json/wp/v2/posts"))
            .and(query_param("slug", "hello"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                bind_body_wp(42, &link, EXPECTED_MODIFIED, EXPECTED_MODIFIED_GMT)
            ])))
            .expect(1)
            .mount(&server)
            .await;
        let vb = super::verify_binding(
            CH_ID,
            &cfg(&server.uri()),
            &format!("{}/hello/", server.uri()),
        )
        .await
        .unwrap();
        assert_eq!(vb.remote_id, "42");
    }

    #[tokio::test]
    async fn verify_binding_by_cjk_permalink_percent_decodes_slug() {
        let server = MockServer::start().await;
        let link = format!("{}/\u{7b2c}\u{4e00}\u{7ae0}/", server.uri());
        Mock::given(method("GET"))
            .and(path("/wp-json/wp/v2/posts"))
            .and(query_param("slug", "\u{7b2c}\u{4e00}\u{7ae0}"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                bind_body_wp(42, &link, EXPECTED_MODIFIED, EXPECTED_MODIFIED_GMT)
            ])))
            .expect(1)
            .mount(&server)
            .await;
        let vb = super::verify_binding(
            CH_ID,
            &cfg(&server.uri()),
            &format!("{}/%E7%AC%AC%E4%B8%80%E7%AB%A0/", server.uri()),
        )
        .await
        .unwrap();
        assert_eq!(vb.remote_id, "42");
    }

    #[tokio::test]
    async fn verify_binding_slug_lookup_zero_results_maps_to_remote_not_found() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/wp-json/wp/v2/posts"))
            .and(query_param("slug", "missing"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .expect(1)
            .mount(&server)
            .await;
        let err = super::verify_binding(
            CH_ID,
            &cfg(&server.uri()),
            &format!("{}/missing/", server.uri()),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, PublishError::RemoteNotFound { .. }),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn verify_binding_rejects_wrong_site_url() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        let err = super::verify_binding(
            CH_ID,
            &cfg(&server.uri()),
            "https://not-my-site.example.com/?p=42",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn verify_binding_rejects_url_outside_configured_site_path() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        let configured_site = format!("{}/novel", server.uri());
        let pasted_url = format!("{}/other/?p=42", server.uri());
        let err = super::verify_binding(CH_ID, &cfg(&configured_site), &pasted_url)
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn verify_binding_rejects_noncanonical_ids_before_network() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500).set_body_string("must not be called"))
            .expect(0)
            .mount(&server)
            .await;
        for bad in ["", "0", "042", "abc", "-42", "42.0", "18446744073709551616"] {
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
    async fn verify_binding_response_link_host_mismatch_returns_unexpected_response() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(bind_body_wp(
                42,
                "https://not-my-site.example.com/?p=42",
                EXPECTED_MODIFIED,
                EXPECTED_MODIFIED_GMT,
            )))
            .expect(1)
            .mount(&server)
            .await;
        let err = super::verify_binding(CH_ID, &cfg(&server.uri()), REMOTE_ID)
            .await
            .unwrap_err();
        assert!(
            matches!(err, PublishError::UnexpectedResponse(_)),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn verify_binding_404_maps_to_remote_not_found() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/wp-json/wp/v2/posts/{REMOTE_ID}")))
            .respond_with(ResponseTemplate::new(404).set_body_string("gone"))
            .expect(1)
            .mount(&server)
            .await;
        let err = super::verify_binding(CH_ID, &cfg(&server.uri()), REMOTE_ID)
            .await
            .unwrap_err();
        assert!(
            matches!(err, PublishError::RemoteNotFound { .. }),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn verify_binding_401_maps_to_auth() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(401).set_body_string("nope"))
            .mount(&server)
            .await;
        let err = super::verify_binding(CH_ID, &cfg(&server.uri()), REMOTE_ID)
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
    }
}
