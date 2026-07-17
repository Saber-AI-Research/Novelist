//! Publish-channel adapters. One module per platform; no shared trait.
//!
//! Each platform's public `publish(config, input)` async fn talks to
//! the platform's REST API directly using `reqwest`. They share
//! `types.rs` (request/response/error shapes) and `pandoc_html.rs`
//! (Markdown → HTML conversion).

pub mod types;

pub mod pandoc_html;
pub mod styled_copy_pandoc;

// Provider modules added one at a time as each is implemented.
pub mod ghost;
pub mod medium;
pub mod wordpress;
pub mod wordpress_com;

use crate::services::publish::types::PublishError;

/// Consume a `reqwest::Response`; if the HTTP status is non-2xx, read
/// the body text and return a typed error that includes it. Otherwise
/// return the response so the caller can keep parsing.
///
/// Including the response body is critical for diagnostic value —
/// without it the user sees "status 401" with no clue what the
/// platform is actually complaining about.
pub(crate) async fn require_success(
    resp: reqwest::Response,
) -> Result<reqwest::Response, PublishError> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let s = status.as_u16();
    let body = resp.text().await.unwrap_or_default();
    // Cap at 800 chars so a giant HTML 404 page doesn't blow up the toast.
    let truncated = if body.chars().count() > 800 {
        let mut t: String = body.chars().take(800).collect();
        t.push_str(" …(truncated)");
        t
    } else {
        body
    };
    let combined = if truncated.is_empty() {
        format!("HTTP {s}")
    } else {
        format!("HTTP {s}: {truncated}")
    };
    Err(match s {
        401 | 403 => PublishError::Auth(combined),
        429 => PublishError::QuotaExceeded(combined),
        _ => PublishError::Server {
            status: s,
            message: truncated,
        },
    })
}
