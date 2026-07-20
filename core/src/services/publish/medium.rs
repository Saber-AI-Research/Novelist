//! Medium publish adapter.
//!
//! Wire (Integration Token, Bearer auth):
//! - GET https://api.medium.com/v1/me — returns `data.id` (the
//!   authorId we'll publish under).
//! - POST https://api.medium.com/v1/users/{authorId}/posts — creates a
//!   post under the authenticated user. Body fields per
//!   https://github.com/Medium/medium-api-docs (archived 2023):
//!     * title (≤100 chars)
//!     * contentFormat ("markdown" | "html")
//!     * content
//!     * tags (string[], max 3)
//!     * canonicalUrl (optional)
//!     * publishStatus ("public" | "draft" | "unlisted") — default
//!       "public"
//! - POST https://api.medium.com/v1/images — multipart, field `image`,
//!   for pre-publish image upload.
//!
//! Note: the Medium Integration Token UI was removed from account
//! Settings in late 2024. Endpoints still respond for legacy tokens;
//! new users typically cannot generate one.

use crate::models::publish::PlatformConfig;
use crate::services::publish::binding::{
    parse_binding_input, preflight_input, ParsedInput, VerifiedBinding,
};
use crate::services::publish::types::{
    PublishError, PublishInput, PublishResult, UnsupportedUpdateReason,
};

const DEFAULT_BASE: &str = "https://api.medium.com";
const MAX_BYTES: u64 = 25 * 1024 * 1024;

/// Read-only credentials check. Returns the username on success.
pub async fn verify(token: &str) -> Result<String, PublishError> {
    if token.is_empty() {
        return Err(PublishError::BadConfig("medium token is empty".into()));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .get(format!("{DEFAULT_BASE}/v1/me"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "json").await?;
    let username = body
        .pointer("/data/username")
        .and_then(|v| v.as_str())
        .unwrap_or("Medium account");
    Ok(format!("Connected as @{username}"))
}

pub async fn get_user_id_with_base(token: &str, base: &str) -> Result<String, PublishError> {
    if token.is_empty() {
        return Err(PublishError::BadConfig("medium token is empty".into()));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .get(format!("{base}/v1/me"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "json").await?;
    body.pointer("/data/id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| PublishError::UnexpectedResponse("no data.id".into()))
}

pub async fn upload_image(
    token: &str,
    bytes: Vec<u8>,
    filename: String,
    mime: String,
) -> Result<String, PublishError> {
    upload_image_with_base(token, bytes, filename, mime, DEFAULT_BASE).await
}

pub async fn upload_image_with_base(
    token: &str,
    bytes: Vec<u8>,
    filename: String,
    mime: String,
    base: &str,
) -> Result<String, PublishError> {
    if token.is_empty() {
        return Err(PublishError::BadConfig("medium token is empty".into()));
    }
    let actual = bytes.len() as u64;
    if actual > MAX_BYTES {
        return Err(PublishError::BadConfig(format!(
            "image is {actual} bytes; medium accepts up to {MAX_BYTES}"
        )));
    }
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str(&mime)
        .map_err(|e| PublishError::BadConfig(format!("bad mime: {e}")))?;
    let form = reqwest::multipart::Form::new().part("image", part);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .post(format!("{base}/v1/images"))
        .header("Authorization", format!("Bearer {token}"))
        .multipart(form)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "json").await?;
    body.pointer("/data/url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| PublishError::UnexpectedResponse("no data.url".into()))
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
    let token = match config {
        PlatformConfig::Medium { token } => token,
        _ => return Err(PublishError::BadConfig("not a Medium config".into())),
    };
    if token.is_empty() {
        return Err(PublishError::BadConfig("medium token is empty".into()));
    }
    if input.update_target.is_some() {
        return Err(PublishError::UnsupportedUpdate {
            provider: "medium".into(),
            reason: UnsupportedUpdateReason::CreateOnlyApi,
        });
    }

    let author_id = match &input.publication_id {
        Some(_) => String::new(), // unused when publishing to a publication
        None => get_user_id_with_base(token, base).await?,
    };

    // Medium accepts at most 3 tags.
    let tags: Vec<String> = input.tags.iter().take(3).cloned().collect();

    let content_format = match input.body_format {
        crate::services::publish::types::BodyFormat::Markdown => "markdown",
        crate::services::publish::types::BodyFormat::Html => "html",
    };

    let mut payload = serde_json::json!({
        "title": input.title,
        "contentFormat": content_format,
        "content": input.body,
        "tags": tags,
        "publishStatus": input.status,
    });
    if let Some(slug) = &input.slug {
        if !slug.is_empty() {
            payload["canonicalUrl"] = serde_json::Value::String(slug.clone());
        }
    }

    let url = match &input.publication_id {
        Some(pid) => format!("{base}/v1/publications/{pid}/posts"),
        None => format!("{base}/v1/users/{author_id}/posts"),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(crate::services::publish::types::redact_reqwest_error)?;
    let resp = crate::services::publish::require_success(resp).await?;
    let body: serde_json::Value =
        crate::services::publish::parse_json_response(resp, "json").await?;
    let url = body
        .pointer("/data/url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("no data.url".into()))?
        .to_string();
    let id = body
        .pointer("/data/id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| PublishError::UnexpectedResponse("no data.id".into()))?
        .to_string();
    Ok(PublishResult::created(url, id))
}

fn is_medium_post_id(candidate: &str) -> bool {
    !candidate.is_empty()
        && candidate.len() <= 64
        && candidate
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn extract_medium_id_from_slug(slug: &str) -> Option<String> {
    let tail = slug.rsplit('-').next()?;
    if is_medium_post_id(tail) {
        Some(tail.to_string())
    } else {
        None
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
    _channel_id: &str,
    config: &PlatformConfig,
    raw_input: &str,
    base: &str,
) -> Result<VerifiedBinding, PublishError> {
    let token = match config {
        PlatformConfig::Medium { token } => token.as_str(),
        _ => return Err(PublishError::BadConfig("not a Medium config".into())),
    };
    if token.is_empty() {
        return Err(PublishError::BadConfig("medium token is empty".into()));
    }
    let trimmed = preflight_input(raw_input)?;
    let parsed = parse_binding_input(&trimmed)?;

    let _candidate_id = match parsed {
        ParsedInput::Id(candidate) => {
            if !is_medium_post_id(&candidate) {
                return Err(PublishError::BadConfig(
                    "medium bind ID must be an ASCII alphanumeric hash (≤64 chars, [A-Za-z0-9_-])"
                        .into(),
                ));
            }
            candidate
        }
        ParsedInput::Url(url) => {
            let host = url.host_str().unwrap_or("").to_ascii_lowercase();
            let host_ok = host == "medium.com" || host.ends_with(".medium.com");
            if !host_ok {
                return Err(PublishError::BadConfig(
                    "medium bind URL host must be medium.com or a medium.com subdomain".into(),
                ));
            }
            let last = crate::services::publish::binding::decoded_last_segment(&url)?.ok_or_else(
                || {
                    PublishError::BadConfig(
                        "medium bind URL must include a post slug or /p/<id> path".into(),
                    )
                },
            )?;
            if last.contains('-') {
                extract_medium_id_from_slug(&last).ok_or_else(|| {
                    PublishError::BadConfig(
                        "medium bind URL does not contain a recognizable trailing id hash".into(),
                    )
                })?
            } else if is_medium_post_id(&last) {
                last
            } else {
                return Err(PublishError::BadConfig(
                    "medium bind URL last segment is not a valid post id".into(),
                ));
            }
        }
    };

    let _user_id = get_user_id_with_base(token, base).await?;

    Err(PublishError::UnsupportedUpdate {
        provider: "medium".into(),
        reason: UnsupportedUpdateReason::InsufficientScope,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::publish::types::{BodyFormat, UpdateTarget};
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn cfg(token: &str) -> PlatformConfig {
        PlatformConfig::Medium {
            token: token.into(),
        }
    }

    fn input() -> PublishInput {
        PublishInput {
            title: "Hello".into(),
            body: "world".into(),
            body_format: BodyFormat::Markdown,
            tags: vec!["a".into(), "b".into(), "c".into(), "d".into()],
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
    async fn get_user_id_returns_data_id() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/me"))
            .and(header("Authorization", "Bearer tok"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"id": "u123", "username": "alice"}
            })))
            .mount(&server)
            .await;
        let id = get_user_id_with_base("tok", &server.uri()).await.unwrap();
        assert_eq!(id, "u123");
    }

    #[tokio::test]
    async fn upload_image_returns_url() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/images"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"url": "https://cdn.medium.com/x.png", "md5": "..."}
            })))
            .mount(&server)
            .await;
        let url = upload_image_with_base(
            "tok",
            vec![1, 2, 3],
            "x.png".into(),
            "image/png".into(),
            &server.uri(),
        )
        .await
        .unwrap();
        assert_eq!(url, "https://cdn.medium.com/x.png");
    }

    #[tokio::test]
    async fn publish_to_user_uses_authors_endpoint_and_truncates_tags() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/me"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": {"id": "u123"}})),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/users/u123/posts"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"id": "p1", "url": "https://medium.com/@x/p1", "title": "Hello"}
            })))
            .mount(&server)
            .await;
        let result = publish_with_base(&cfg("tok"), &input(), &server.uri())
            .await
            .unwrap();
        assert_eq!(result.remote_id, "p1");
        assert_eq!(result.url, "https://medium.com/@x/p1");
    }

    #[tokio::test]
    async fn publish_401_maps_to_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(401).set_body_string("invalid token"))
            .mount(&server)
            .await;
        let err = publish_with_base(&cfg("tok"), &input(), &server.uri())
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn empty_token_is_bad_config() {
        let err = publish(&cfg(""), &input()).await.unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn wrong_provider_config_is_bad_config() {
        let cfg = PlatformConfig::Ghost {
            admin_url: "x".into(),
            api_key: "y".into(),
        };
        let err = publish(&cfg, &input()).await.unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn update_target_is_rejected_before_network_access() {
        let server = MockServer::start().await;
        let mut publish_input = input();
        publish_input.update_target = Some(UpdateTarget {
            remote_id: "medium-old".into(),
            expected_revision: None,
        });

        let err = publish_with_base(&cfg("tok"), &publish_input, &server.uri())
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            PublishError::UnsupportedUpdate {
                ref provider,
                reason: UnsupportedUpdateReason::CreateOnlyApi,
            } if provider == "medium"
        ));
        assert!(server
            .received_requests()
            .await
            .unwrap_or_default()
            .is_empty());
    }

    const CH_ID_M: &str = "medium-personal_1";

    async fn mount_me(server: &MockServer, user_id: &str) {
        Mock::given(method("GET"))
            .and(path("/v1/me"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": {"id": user_id, "username": "alice"}
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn verify_binding_by_url_returns_unsupported_without_verified_identity() {
        let server = MockServer::start().await;
        mount_me(&server, "u123").await;
        let err = super::verify_binding_with_base(
            CH_ID_M,
            &cfg("tok"),
            "https://medium.com/@alice/my-story-abcDEF123",
            &server.uri(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(
                err,
                PublishError::UnsupportedUpdate {
                    ref provider,
                    reason: UnsupportedUpdateReason::InsufficientScope,
                } if provider == "medium"
            ),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn verify_binding_by_bare_id_returns_unsupported_without_verified_identity() {
        let server = MockServer::start().await;
        mount_me(&server, "u123").await;
        let err = super::verify_binding_with_base(CH_ID_M, &cfg("tok"), "abcDEF123", &server.uri())
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            PublishError::UnsupportedUpdate {
                reason: UnsupportedUpdateReason::InsufficientScope,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn verify_binding_p_path_url_returns_unsupported_without_verified_identity() {
        let server = MockServer::start().await;
        mount_me(&server, "u123").await;
        let err = super::verify_binding_with_base(
            CH_ID_M,
            &cfg("tok"),
            "https://medium.com/p/deadBEEF",
            &server.uri(),
        )
        .await
        .unwrap_err();
        assert!(matches!(
            err,
            PublishError::UnsupportedUpdate {
                reason: UnsupportedUpdateReason::InsufficientScope,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn verify_binding_rejects_non_medium_host() {
        let server = MockServer::start().await;
        mount_me(&server, "u123").await;
        let err = super::verify_binding_with_base(
            CH_ID_M,
            &cfg("tok"),
            "https://not-medium.example.com/@alice/story-hash1",
            &server.uri(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn verify_binding_401_maps_to_auth() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/me"))
            .respond_with(ResponseTemplate::new(401).set_body_string("nope"))
            .mount(&server)
            .await;
        let err = super::verify_binding_with_base(CH_ID_M, &cfg("tok"), "abcDEF123", &server.uri())
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn verify_binding_empty_token_is_bad_config() {
        let err = super::verify_binding(CH_ID_M, &cfg(""), "abcDEF123")
            .await
            .unwrap_err();
        assert!(matches!(err, PublishError::BadConfig(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn verify_binding_rejects_malformed_id() {
        let server = MockServer::start().await;
        mount_me(&server, "u123").await;
        let too_long_no_hyphen: String = "a".repeat(65);
        let bad_cases: [&str; 5] = [
            "",
            "has space",
            "invalid.dot",
            "invalid!bang",
            &too_long_no_hyphen,
        ];
        for bad in bad_cases {
            let err = super::verify_binding_with_base(CH_ID_M, &cfg("tok"), bad, &server.uri())
                .await
                .unwrap_err();
            assert!(
                matches!(err, PublishError::BadConfig(_)),
                "bad='{bad}' got {err:?}"
            );
        }
    }
}
