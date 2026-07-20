//! Publish-channel adapters. One module per platform; no shared trait.
//!
//! Each platform's public `publish(config, input)` async fn talks to
//! the platform's REST API directly using `reqwest`. They share
//! `types.rs` (request/response/error shapes) and `pandoc_html.rs`
//! (Markdown → HTML conversion).

pub mod types;

pub mod pandoc_html;
pub mod styled_copy_pandoc;

pub mod cover_assets;
pub mod sidecar;

pub mod binding;

pub mod ghost;
pub mod medium;
pub mod wordpress;
pub mod wordpress_com;

use crate::services::publish::types::{build_error_from_body, PublishError};
use futures_util::StreamExt;
use serde::de::DeserializeOwned;

const MAX_JSON_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES: usize = 64 * 1024;

pub(crate) fn media_content_disposition(filename: &str) -> String {
    let fallback: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let fallback = if fallback.is_empty() {
        "upload"
    } else {
        &fallback
    };
    format!(
        "attachment; filename=\"{fallback}\"; filename*=UTF-8''{}",
        urlencoding::encode(filename)
    )
}

#[derive(Debug)]
enum ResponseReadError {
    BodyTooLarge { limit: usize },
    Read(reqwest::Error),
}

impl std::fmt::Display for ResponseReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BodyTooLarge { limit } => {
                write!(f, "response body exceeds {limit} bytes")
            }
            Self::Read(err) => write!(
                f,
                "response body read failed: {}",
                crate::services::publish::types::redact_secrets(&err.to_string())
            ),
        }
    }
}

async fn read_response_bytes(
    resp: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, ResponseReadError> {
    let content_length = resp.content_length();
    if content_length.is_some_and(|length| length > limit as u64) {
        return Err(ResponseReadError::BodyTooLarge { limit });
    }

    let capacity = content_length
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or(0);
    let mut body = Vec::with_capacity(capacity);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(ResponseReadError::Read)?;
        if chunk.len() > limit.saturating_sub(body.len()) {
            return Err(ResponseReadError::BodyTooLarge { limit });
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub(crate) async fn parse_json_response<T>(
    resp: reqwest::Response,
    context: &str,
) -> Result<T, PublishError>
where
    T: DeserializeOwned,
{
    let body = read_response_bytes(resp, MAX_JSON_RESPONSE_BYTES)
        .await
        .map_err(|err| PublishError::UnexpectedResponse(format!("{context}: {err}")))?;
    serde_json::from_slice(&body)
        .map_err(|err| PublishError::UnexpectedResponse(format!("{context}: {err}")))
}

pub(crate) async fn read_error_response_text(resp: reqwest::Response) -> String {
    match read_response_bytes(resp, MAX_ERROR_RESPONSE_BYTES).await {
        Ok(body) => String::from_utf8_lossy(&body).into_owned(),
        Err(ResponseReadError::BodyTooLarge { limit }) => {
            format!("response body exceeds {limit} bytes")
        }
        Err(ResponseReadError::Read(_)) => String::new(),
    }
}

/// Consume a `reqwest::Response`; if the HTTP status is non-2xx, read
/// a bounded body text and return a typed error whose text has been
/// passed through [`crate::services::publish::types::redact_secrets`]
/// before the 800-char cap. Otherwise return the response so the caller
/// can keep parsing.
///
/// Including the response body is critical for diagnostic value —
/// without it the user sees "status 401" with no clue what the
/// platform is actually complaining about. Redacting before
/// truncation is critical for credential safety — a token that
/// straddles the 800-char cut would otherwise be half-preserved.
pub(crate) async fn require_success(
    resp: reqwest::Response,
) -> Result<reqwest::Response, PublishError> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let s = status.as_u16();
    let body = read_error_response_text(resp).await;
    Err(build_error_from_body(s, &body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const TEST_RESPONSE_LIMIT: usize = 8;

    #[tokio::test]
    async fn bounded_response_read_rejects_content_length_over_cap() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(vec![b'x'; TEST_RESPONSE_LIMIT + 1]),
            )
            .mount(&server)
            .await;

        let resp = reqwest::get(server.uri()).await.unwrap();
        assert_eq!(
            resp.content_length(),
            Some((TEST_RESPONSE_LIMIT + 1) as u64)
        );

        let err = read_response_bytes(resp, TEST_RESPONSE_LIMIT)
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            ResponseReadError::BodyTooLarge {
                limit: TEST_RESPONSE_LIMIT
            }
        ));
    }

    #[tokio::test]
    async fn bounded_response_read_rejects_chunked_limit_plus_one() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("transfer-encoding", "chunked")
                    .set_body_bytes(vec![b'x'; TEST_RESPONSE_LIMIT + 1]),
            )
            .mount(&server)
            .await;

        let resp = reqwest::get(server.uri()).await.unwrap();
        assert_eq!(resp.content_length(), None);

        let err = read_response_bytes(resp, TEST_RESPONSE_LIMIT)
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            ResponseReadError::BodyTooLarge {
                limit: TEST_RESPONSE_LIMIT
            }
        ));
    }
}
