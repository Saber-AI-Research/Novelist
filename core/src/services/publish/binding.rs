//! Task 20: verified legacy-post binding.
//!
//! Provides shared parsing and ownership-check helpers for
//! `bind_legacy_publication`. Provider-specific verification lives in
//! each adapter (`ghost::verify_binding`, `wordpress::verify_binding`,
//! `wordpress_com::verify_binding`, `medium::verify_binding`).
//!
//! Scope guarantees:
//!
//! - **No title/slug fuzzy search.** Bare IDs are validated by each
//!   provider's canonical grammar and looked up by primary key. URL
//!   permalink inputs are resolved via provider endpoints that either
//!   return a single canonical post (Ghost's `/posts/slug/{slug}/`,
//!   WordPress's `?slug=` which is unique per site) or an
//!   `UnexpectedResponse` when the response would be ambiguous.
//! - **No persistence here.** This module returns
//!   [`VerifiedBinding`]; the IPC command (`commands::publish::
//!   bind_legacy_publication`) is the only place that mutates the
//!   sidecar, and only after verification succeeds.
//! - **No frontend-supplied credentials.** The IPC command resolves the
//!   channel by ID from persisted global settings and calls this module
//!   with the trusted `PlatformConfig`. Frontend never controls the
//!   credential material.
//! - **Ownership enforced through URL normalization + response
//!   introspection.** The user cannot bind post 42 on a stranger's WP
//!   site just by pasting its URL: the URL host+port+scheme must match
//!   the selected channel's, AND the response's canonical id/link must
//!   agree with what we asked for.
//! - **Secret-safe errors.** Every request path funnels through
//!   `require_success` (which redacts via `redact_secrets` before
//!   truncation); Display messages carry only structured provider
//!   context.

use crate::services::publish::types::{ProviderRevision, PublishError, UnsupportedUpdateReason};
use serde::{Deserialize, Serialize};
use specta::Type;
use url::Url;

/// Whether the caller can subsequently `update` a verified remote
/// identity via the standard `PublishInput.update_target` flow, or the
/// provider/API state requires a separate, explicit user action such as
/// creating a new copy.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum BindingCapability {
    /// Ghost, WordPress self-hosted, WordPress.com. Persist the returned
    /// typed revision as `RemoteIdentity.provider_revision` and the
    /// legacy flat value as `RemoteIdentity.revision`; the typed value is
    /// ready to feed `UpdateTarget.expected_revision` on the next publish.
    Updatable,
    /// Verified remote identity exists, but the provider/API cannot
    /// update it in place. This type remains useful for verified create
    /// results and a future explicit New Copy flow; Task 20 must not
    /// manufacture it for unverifiable Medium legacy-post binds.
    UnsupportedUpdate { reason: UnsupportedUpdateReason },
}

/// Canonical verified remote identity — the shape Task 21 persists into
/// `ChannelState.remote` via [`crate::services::publish::sidecar::
/// update_publish_sidecar`].
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct VerifiedBinding {
    /// The selected channel's stable id (echoed back for the frontend).
    pub channel_id: String,
    /// Provider discriminant string. Task 20 currently returns verified
    /// bindings for `"ghost"`, `"wordpress"`, and `"wordpress_com"`;
    /// Medium legacy binding fails closed because `/v1/me` does not prove
    /// post ownership.
    pub provider: String,
    /// Server-returned canonical post id.
    pub remote_id: String,
    /// Server-returned canonical URL (may differ from user input for
    /// permalink/slug URLs the server percent-encodes).
    pub url: String,
    /// Provider-typed revision stamp. Absent for Medium and any future
    /// provider whose API exposes no revision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<ProviderRevision>,
    /// Whether Task 21 can expose Update on this channel for this post.
    pub capability: BindingCapability,
}

/// One of the two shapes the user's input can take.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedInput {
    /// A bare provider-shaped ID (Ghost 24-hex, WP positive integer,
    /// Medium opaque). Provider-specific grammar is enforced in the
    /// provider's `verify_binding`.
    Id(String),
    /// A URL that must be verified against the selected channel's
    /// scheme/host/port.
    Url(Url),
}

const MAX_INPUT_LEN: usize = 2048;

/// Trim + minimal-format checks shared by every provider. Rejects
/// pathological cases before any URL parse or provider dispatch:
/// - Empty or whitespace-only input.
/// - Length above [`MAX_INPUT_LEN`] (defensive against a whole-document
///   paste — real Ghost 24-hex IDs are 24 bytes and canonical WP IDs
///   fit in 20 bytes; Medium hashes are ≤ 32 bytes; even the deepest
///   CJK permalink URL stays well under 2 KB).
/// - Control characters (U+0000..U+001F, U+007F) anywhere in the string.
/// - Whitespace anywhere inside the string after trimming.
pub fn preflight_input(input: &str) -> Result<String, PublishError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(PublishError::BadConfig(
            "bind requires a non-empty URL or provider post ID".into(),
        ));
    }
    if trimmed.len() > MAX_INPUT_LEN {
        return Err(PublishError::BadConfig(format!(
            "bind input exceeds {MAX_INPUT_LEN} bytes"
        )));
    }
    for c in trimmed.chars() {
        if c.is_control() {
            return Err(PublishError::BadConfig(
                "bind input contains control characters".into(),
            ));
        }
        if c.is_whitespace() {
            return Err(PublishError::BadConfig(
                "bind input contains internal whitespace".into(),
            ));
        }
    }
    Ok(trimmed.to_string())
}

/// Decide URL vs bare ID and apply URL-level safety checks.
///
/// URL rules:
/// - Scheme must be `http` or `https`. Provider verifiers may further
///   require HTTPS (self-hosted local dev is the only case that needs
///   HTTP and it is opt-in via the channel's configured `site_url`).
/// - No embedded credentials `user:pass@host`.
/// - No fragment `#...`. Fragments are user-agent-local and never reach
///   the server, so they cannot carry identity for binding.
/// - Percent-encoding invariants enforced by [`url::Url::parse`].
pub fn parse_binding_input(trimmed: &str) -> Result<ParsedInput, PublishError> {
    if trimmed.contains(':') {
        reject_raw_traversal_markers(trimmed)?;
        let parsed = Url::parse(trimmed)
            .map_err(|_| PublishError::BadConfig("bind URL is not a valid absolute URL".into()))?;
        let scheme = parsed.scheme();
        if scheme != "http" && scheme != "https" {
            return Err(PublishError::BadConfig(format!(
                "bind URL scheme must be http or https, got '{scheme}'"
            )));
        }
        if parsed.host_str().is_none() {
            return Err(PublishError::BadConfig("bind URL must have a host".into()));
        }
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(PublishError::BadConfig(
                "bind URL must not contain embedded credentials (user:pass@host)".into(),
            ));
        }
        if parsed.fragment().is_some() {
            return Err(PublishError::BadConfig(
                "bind URL must not contain a fragment (fragments never reach the server)".into(),
            ));
        }
        validate_url_path_segments(&parsed)?;
        reject_sensitive_query_pairs(&parsed)?;
        Ok(ParsedInput::Url(parsed))
    } else {
        Ok(ParsedInput::Id(trimmed.to_string()))
    }
}

fn reject_raw_traversal_markers(input: &str) -> Result<(), PublishError> {
    let lower = input.to_ascii_lowercase();
    let Some(path_start) = lower.find("://").map(|i| i + 3) else {
        return Ok(());
    };
    let path = lower[path_start..]
        .find('/')
        .map(|i| &lower[path_start + i..])
        .unwrap_or("/");
    let path_only = path.split(['?', '#']).next().unwrap_or(path);
    if path_only.contains("/../")
        || path_only.ends_with("/..")
        || path_only.contains("/./")
        || path_only.ends_with("/.")
    {
        return Err(PublishError::BadConfig(
            "bind URL path must not contain traversal segments".into(),
        ));
    }
    for segment in path_only.split('/') {
        let dot_normalized = segment.replace("%2e", ".");
        if dot_normalized == "." || dot_normalized == ".." {
            return Err(PublishError::BadConfig(
                "bind URL path must not contain traversal segments".into(),
            ));
        }
    }
    Ok(())
}

fn validate_url_path_segments(url: &Url) -> Result<(), PublishError> {
    let Some(segments) = url.path_segments() else {
        return Ok(());
    };
    for segment in segments {
        let decoded = percent_decode_utf8(segment)?;
        if decoded == "." || decoded == ".." {
            return Err(PublishError::BadConfig(
                "bind URL path must not contain traversal segments".into(),
            ));
        }
    }
    Ok(())
}

fn reject_sensitive_query_pairs(url: &Url) -> Result<(), PublishError> {
    for (key, _) in url.query_pairs() {
        let key = key.to_ascii_lowercase();
        let sensitive = key.contains("token")
            || key.contains("password")
            || key.contains("secret")
            || key.contains("credential")
            || key == "auth"
            || key == "authorization"
            || key == "api_key"
            || key == "apikey";
        if sensitive {
            return Err(PublishError::BadConfig(
                "bind URL query must not contain credential-like parameters".into(),
            ));
        }
    }
    Ok(())
}

/// Assert `url`'s authority (scheme + host + effective port) matches
/// `expected_base`'s. Comparison is:
/// - Scheme: exact (case-insensitive per URL spec, but `url` crate
///   already lower-cases).
/// - Host: exact (ASCII lowercased for hostnames; IPv6 preserves brackets;
///   IPv4 preserves numeric form).
/// - Port: `port_or_known_default()` on both sides. `https://x.com` and
///   `https://x.com:443` compare equal; `https://x.com:8443` differs.
pub fn assert_authority_matches(url: &Url, expected_base: &Url) -> Result<(), PublishError> {
    if url.scheme() != expected_base.scheme() {
        return Err(PublishError::BadConfig(
            "bind URL scheme does not match selected channel scheme".into(),
        ));
    }
    match (url.host_str(), expected_base.host_str()) {
        (Some(a), Some(b)) if a.eq_ignore_ascii_case(b) => {}
        _ => {
            return Err(PublishError::BadConfig(
                "bind URL host does not match selected channel host".into(),
            ));
        }
    }
    if url.port_or_known_default() != expected_base.port_or_known_default() {
        return Err(PublishError::BadConfig(
            "bind URL port does not match selected channel port".into(),
        ));
    }
    let base_path = expected_base.path().trim_end_matches('/');
    if !base_path.is_empty() {
        let path = url.path();
        let under_base = path == base_path || path.starts_with(&format!("{base_path}/"));
        if !under_base {
            return Err(PublishError::BadConfig(
                "bind URL path is outside the selected channel base path".into(),
            ));
        }
    }
    Ok(())
}

/// Parse a channel's configured base URL into a `Url` for authority
/// comparison. Provider adapters store base URLs as plain strings, so
/// this helper centralizes the "trust the config, but still validate"
/// gate. Rejects config URLs missing a host, or with embedded creds /
/// fragment (a corrupt/hostile config could otherwise smuggle
/// credentials into the assertion).
pub fn parse_channel_base(raw: &str) -> Result<Url, PublishError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(PublishError::BadConfig("channel base URL is empty".into()));
    }
    reject_raw_traversal_markers(trimmed)?;
    let url = Url::parse(trimmed).map_err(|_| {
        PublishError::BadConfig("channel base URL is not a valid absolute URL".into())
    })?;
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(PublishError::BadConfig(format!(
            "channel base URL scheme must be http or https, got '{scheme}'"
        )));
    }
    if url.host_str().is_none() {
        return Err(PublishError::BadConfig(
            "channel base URL has no host".into(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(PublishError::BadConfig(
            "channel base URL must not contain embedded credentials".into(),
        ));
    }
    if url.fragment().is_some() {
        return Err(PublishError::BadConfig(
            "channel base URL must not contain a fragment".into(),
        ));
    }
    validate_url_path_segments(&url)?;
    reject_sensitive_query_pairs(&url)?;
    Ok(url)
}

/// Percent-decoded path segment of a URL, without the leading `/`.
/// Returns an error when the URL's path fails UTF-8 decoding (invalid
/// percent-encoding). Used by permalink extraction: WordPress and Ghost
/// both allow CJK slugs which arrive percent-encoded and must be
/// decoded before we ask the provider "look up this slug".
pub fn decoded_last_segment(url: &Url) -> Result<Option<String>, PublishError> {
    let mut segments: Vec<&str> = match url.path_segments() {
        Some(iter) => iter.collect(),
        None => return Ok(None),
    };
    // Trailing empty segment appears for URLs ending in `/`.
    while segments.last().is_some_and(|s| s.is_empty()) {
        segments.pop();
    }
    let Some(last) = segments.pop() else {
        return Ok(None);
    };
    percent_decode_utf8(last).map(Some)
}

fn percent_decode_utf8(input: &str) -> Result<String, PublishError> {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(PublishError::BadConfig(
                    "bind URL contains truncated percent-encoding".into(),
                ));
            }
            let hi = hex_nibble(bytes[i + 1])?;
            let lo = hex_nibble(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| {
        PublishError::BadConfig("bind URL slug contains invalid percent-encoded UTF-8".into())
    })
}

fn hex_nibble(b: u8) -> Result<u8, PublishError> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err(PublishError::BadConfig(
            "bind URL contains invalid percent-encoding".into(),
        )),
    }
}

/// Given a URL with a `?p=NN` (or `?page_id=NN`) query parameter,
/// extract the first canonical numeric value. Returns `None` when
/// neither key is present.
pub fn wordpress_query_id(url: &Url) -> Option<String> {
    for (key, value) in url.query_pairs() {
        let k = key.to_ascii_lowercase();
        if k == "p" || k == "page_id" {
            return Some(value.into_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preflight_rejects_empty_and_whitespace_only() {
        assert!(matches!(
            preflight_input(""),
            Err(PublishError::BadConfig(_))
        ));
        assert!(matches!(
            preflight_input("   \t\n"),
            Err(PublishError::BadConfig(_))
        ));
    }

    #[test]
    fn preflight_rejects_over_length() {
        let s: String = "a".repeat(MAX_INPUT_LEN + 1);
        assert!(matches!(
            preflight_input(&s),
            Err(PublishError::BadConfig(_))
        ));
    }

    #[test]
    fn preflight_rejects_control_chars() {
        assert!(matches!(
            preflight_input("abc\x00def"),
            Err(PublishError::BadConfig(_))
        ));
        assert!(matches!(
            preflight_input("abc\x1fdef"),
            Err(PublishError::BadConfig(_))
        ));
        assert!(matches!(
            preflight_input("abc\x7fdef"),
            Err(PublishError::BadConfig(_))
        ));
    }

    #[test]
    fn preflight_rejects_internal_whitespace() {
        assert!(matches!(
            preflight_input("https://x.com/ a"),
            Err(PublishError::BadConfig(_))
        ));
    }

    #[test]
    fn preflight_trims_edges() {
        assert_eq!(preflight_input("  42\t\n").unwrap(), "42");
    }

    #[test]
    fn parse_binding_input_rejects_non_http_scheme() {
        assert!(matches!(
            parse_binding_input("ftp://x.com/y"),
            Err(PublishError::BadConfig(_))
        ));
        assert!(matches!(
            parse_binding_input("javascript:alert(1)"),
            Err(PublishError::BadConfig(_))
        ));
        assert!(matches!(
            parse_binding_input("file:///etc/passwd"),
            Err(PublishError::BadConfig(_))
        ));
    }

    #[test]
    fn parse_binding_input_rejects_embedded_credentials() {
        assert!(matches!(
            parse_binding_input("https://alice:secret@x.com/hello/"),
            Err(PublishError::BadConfig(_))
        ));
    }

    #[test]
    fn parse_binding_input_rejects_fragment() {
        assert!(matches!(
            parse_binding_input("https://x.com/hello/#id"),
            Err(PublishError::BadConfig(_))
        ));
    }

    #[test]
    fn parse_binding_input_rejects_path_traversal_segments() {
        for bad in [
            "https://x.com/a/../b/",
            "https://x.com/a/%2e%2e/b/",
            "https://x.com/a/%2E/b/",
        ] {
            assert!(
                matches!(parse_binding_input(bad), Err(PublishError::BadConfig(_))),
                "expected traversal URL to be rejected: {bad}"
            );
        }
    }

    #[test]
    fn parse_binding_input_rejects_sensitive_query_parameters() {
        for bad in [
            "https://x.com/hello/?access_token=abc123",
            "https://x.com/hello/?api_key=abc123",
            "https://x.com/hello/?password=abc123",
            "https://x.com/hello/?auth=abc123",
        ] {
            assert!(
                matches!(parse_binding_input(bad), Err(PublishError::BadConfig(_))),
                "expected sensitive query URL to be rejected: {bad}"
            );
        }
    }

    #[test]
    fn parse_binding_input_accepts_http_and_https() {
        assert!(matches!(
            parse_binding_input("http://localhost:8080/hello/"),
            Ok(ParsedInput::Url(_))
        ));
        assert!(matches!(
            parse_binding_input("https://blog.example.com/hello/"),
            Ok(ParsedInput::Url(_))
        ));
    }

    #[test]
    fn parse_binding_input_treats_bare_string_as_id() {
        match parse_binding_input("42").unwrap() {
            ParsedInput::Id(s) => assert_eq!(s, "42"),
            other => panic!("expected Id, got {other:?}"),
        }
        match parse_binding_input("aabbccddeeff00112233445566778899").unwrap() {
            ParsedInput::Id(s) => assert_eq!(s, "aabbccddeeff00112233445566778899"),
            other => panic!("expected Id, got {other:?}"),
        }
    }

    #[test]
    fn assert_authority_matches_accepts_same_scheme_host_port() {
        let base = Url::parse("https://blog.example.com").unwrap();
        let url = Url::parse("https://blog.example.com/hello/").unwrap();
        assert!(assert_authority_matches(&url, &base).is_ok());
    }

    #[test]
    fn assert_authority_matches_treats_explicit_default_port_equal() {
        let base = Url::parse("https://blog.example.com").unwrap();
        let url = Url::parse("https://blog.example.com:443/hello/").unwrap();
        assert!(assert_authority_matches(&url, &base).is_ok());
    }

    #[test]
    fn assert_authority_matches_rejects_different_port() {
        let base = Url::parse("https://blog.example.com").unwrap();
        let url = Url::parse("https://blog.example.com:8443/hello/").unwrap();
        assert!(matches!(
            assert_authority_matches(&url, &base),
            Err(PublishError::BadConfig(_))
        ));
    }

    #[test]
    fn assert_authority_matches_rejects_different_host() {
        let base = Url::parse("https://blog.example.com").unwrap();
        let url = Url::parse("https://other.example.com/hello/").unwrap();
        assert!(matches!(
            assert_authority_matches(&url, &base),
            Err(PublishError::BadConfig(_))
        ));
    }

    #[test]
    fn assert_authority_matches_rejects_different_scheme() {
        let base = Url::parse("https://blog.example.com").unwrap();
        let url = Url::parse("http://blog.example.com/hello/").unwrap();
        assert!(matches!(
            assert_authority_matches(&url, &base),
            Err(PublishError::BadConfig(_))
        ));
    }

    #[test]
    fn assert_authority_matches_rejects_paths_outside_configured_base_path() {
        let base = Url::parse("https://blog.example.com/novel").unwrap();
        let ok = Url::parse("https://blog.example.com/novel/chapter-1/").unwrap();
        let wrong = Url::parse("https://blog.example.com/other/chapter-1/").unwrap();
        assert!(assert_authority_matches(&ok, &base).is_ok());
        assert!(matches!(
            assert_authority_matches(&wrong, &base),
            Err(PublishError::BadConfig(_))
        ));
    }

    #[test]
    fn assert_authority_matches_ignores_host_case() {
        let base = Url::parse("https://Blog.Example.COM").unwrap();
        let url = Url::parse("https://blog.example.com/hello/").unwrap();
        assert!(assert_authority_matches(&url, &base).is_ok());
    }

    #[test]
    fn assert_authority_matches_accepts_ipv6_authority() {
        let base = Url::parse("http://[::1]:8080").unwrap();
        let url = Url::parse("http://[::1]:8080/hello/").unwrap();
        assert!(assert_authority_matches(&url, &base).is_ok());
    }

    #[test]
    fn assert_authority_matches_rejects_ipv6_port_mismatch() {
        let base = Url::parse("http://[::1]:8080").unwrap();
        let url = Url::parse("http://[::1]:9090/hello/").unwrap();
        assert!(matches!(
            assert_authority_matches(&url, &base),
            Err(PublishError::BadConfig(_))
        ));
    }

    #[test]
    fn parse_channel_base_rejects_creds_or_fragment_in_config() {
        assert!(matches!(
            parse_channel_base("https://alice:pw@x.com"),
            Err(PublishError::BadConfig(_))
        ));
        assert!(matches!(
            parse_channel_base("https://x.com#fragment"),
            Err(PublishError::BadConfig(_))
        ));
        assert!(matches!(
            parse_channel_base(""),
            Err(PublishError::BadConfig(_))
        ));
    }

    #[test]
    fn parse_channel_base_rejects_non_http_query_secret_and_traversal() {
        for bad in [
            "ftp://x.com",
            "https://x.com/?access_token=abc123",
            "https://x.com/a/%2e%2e/b",
        ] {
            assert!(
                matches!(parse_channel_base(bad), Err(PublishError::BadConfig(_))),
                "expected bad channel base to be rejected: {bad}"
            );
        }
    }

    #[test]
    fn parse_channel_base_accepts_trailing_slash_and_path_prefix() {
        assert!(parse_channel_base("https://x.com/").is_ok());
        assert!(parse_channel_base("https://x.com/blog").is_ok());
    }

    #[test]
    fn decoded_last_segment_percent_decodes_cjk_slug() {
        let url = Url::parse("https://blog.example.com/%E7%AC%AC%E4%B8%80%E7%AB%A0/").unwrap();
        assert_eq!(
            decoded_last_segment(&url).unwrap().unwrap(),
            "\u{7b2c}\u{4e00}\u{7ae0}"
        );
    }

    #[test]
    fn decoded_last_segment_rejects_invalid_percent_encoding() {
        // Lone %E7 is not valid UTF-8 without a continuation byte.
        let url = Url::parse("https://blog.example.com/%E7%FF/").unwrap();
        assert!(matches!(
            decoded_last_segment(&url),
            Err(PublishError::BadConfig(_))
        ));
    }

    #[test]
    fn decoded_last_segment_returns_none_for_root() {
        let url = Url::parse("https://blog.example.com/").unwrap();
        assert_eq!(decoded_last_segment(&url).unwrap(), None);
    }

    #[test]
    fn decoded_last_segment_strips_trailing_slash() {
        let url = Url::parse("https://blog.example.com/hello/").unwrap();
        assert_eq!(decoded_last_segment(&url).unwrap().unwrap(), "hello");
    }

    #[test]
    fn wordpress_query_id_reads_p_and_page_id() {
        let u = Url::parse("https://blog.example.com/?p=42").unwrap();
        assert_eq!(wordpress_query_id(&u).as_deref(), Some("42"));
        let u = Url::parse("https://blog.example.com/?page_id=99").unwrap();
        assert_eq!(wordpress_query_id(&u).as_deref(), Some("99"));
        let u = Url::parse("https://blog.example.com/?P=42").unwrap();
        assert_eq!(wordpress_query_id(&u).as_deref(), Some("42"));
    }

    #[test]
    fn wordpress_query_id_absent_returns_none() {
        let u = Url::parse("https://blog.example.com/hello/").unwrap();
        assert!(wordpress_query_id(&u).is_none());
    }

    #[test]
    fn verified_binding_round_trips_updatable_shape() {
        let vb = VerifiedBinding {
            channel_id: "ghost-personal".into(),
            provider: "ghost".into(),
            remote_id: "abc123".into(),
            url: "https://blog.example.com/hello/".into(),
            revision: Some(ProviderRevision::Ghost {
                updated_at: "2026-07-16T00:00:00Z".into(),
            }),
            capability: BindingCapability::Updatable,
        };
        let json = serde_json::to_string(&vb).unwrap();
        let parsed: VerifiedBinding = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, vb);
    }

    #[test]
    fn verified_binding_unsupported_update_has_typed_reason() {
        let vb = VerifiedBinding {
            channel_id: "medium-personal".into(),
            provider: "medium".into(),
            remote_id: "abc123".into(),
            url: "https://medium.com/@x/abc-abc123".into(),
            revision: None,
            capability: BindingCapability::UnsupportedUpdate {
                reason: UnsupportedUpdateReason::CreateOnlyApi,
            },
        };
        let json = serde_json::to_string(&vb).unwrap();
        assert!(json.contains("unsupported_update"));
        assert!(json.contains("create_only_api"));
    }
}
