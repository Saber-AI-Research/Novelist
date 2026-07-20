//! Shared types for publish adapters.
//!
//! [`PublishResult`] carries the outcome of both a create and an
//! update call, distinguished by [`PublishOperation`]. It defaults
//! to `Created` so legacy sidecars and older frontends that omit the
//! field still parse cleanly.
//!
//! [`ProviderRevision`] is a typed enum — not opaque
//! `serde_json::Value` — so the frontend can reason about update
//! stamps without string parsing. Only providers whose HTTP API
//! exposes a stable "modified" token appear as variants: Ghost's
//! `updated_at` and WordPress's `modified`/`modified_gmt`. Medium is
//! intentionally absent because its Integration API has no update
//! endpoint (see [`PublishError::UnsupportedUpdate`]).
//!
//! [`UpdateTarget`] is the optional field on [`PublishInput`] that
//! turns a create call into an update. Callers that omit it get
//! create semantics unchanged — the backward-compat contract.
//!
//! Typed errors carry only structured provider/post context —
//! `provider` name, `remote_id`, expected/actual [`ProviderRevision`].
//! They do NOT carry raw HTTP response bodies, request headers, or
//! request bodies. Diagnostic detail from a provider response MUST
//! be routed through [`redact_secrets`] before embedding.
//! [`redact_secrets`] strips `Authorization` headers, `Bearer`
//! tokens, `api_key=` / `access_token=` / `token=` query params, and
//! long hex/base64 strings that look like credentials.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Body format selector. Ghost / WordPress consume HTML; Medium
/// consumes Markdown natively.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum BodyFormat {
    Html,
    Markdown,
}

/// Whether an adapter created a new post or updated an existing one.
/// Defaults to [`PublishOperation::Created`] so legacy on-disk
/// sidecars and older frontends that omit the field parse cleanly.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PublishOperation {
    #[default]
    Created,
    Updated,
}

/// Provider-specific "modified" stamp echoed back on updates for
/// optimistic concurrency. Internally-tagged `provider` discriminant
/// mirrors [`crate::models::publish::PlatformConfig`] on the wire.
/// Medium is intentionally absent (see
/// [`PublishError::UnsupportedUpdate`]).
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(tag = "provider", rename_all = "lowercase")]
pub enum ProviderRevision {
    /// Ghost's `updated_at`, ISO-8601 UTC. Ghost's Admin API
    /// requires the caller to echo this exact string back in a
    /// `PUT /posts/:id` body or the update is rejected 409.
    Ghost { updated_at: String },
    /// WordPress's `modified` / `modified_gmt`. Both optional
    /// because the WP REST API does not enforce echoing them; they
    /// are informational for drift detection.
    WordPress {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        modified: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        modified_gmt: Option<String>,
    },
}

/// Boxed payload for [`PublishError::UpdateConflict`]. Split out
/// so `Result<_, PublishError>` stays under Clippy's
/// `result_large_err` size threshold and so the conflict shape can
/// be inspected as a stand-alone struct in tests and at IPC.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct UpdateConflictContext {
    pub provider: String,
    pub remote_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<ProviderRevision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<ProviderRevision>,
}

impl std::fmt::Display for UpdateConflictContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: post {} was modified since the expected revision",
            self.provider, self.remote_id
        )
    }
}

/// Optional update target on [`PublishInput`]. When present,
/// adapters MUST update the referenced post instead of creating a
/// new one. When absent (default), adapters behave exactly as
/// before — a create call.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct UpdateTarget {
    /// Platform post id — same format the adapter returned in
    /// [`PublishResult::remote_id`].
    pub remote_id: String,
    /// Revision the caller last observed. Providers that support
    /// optimistic concurrency (Ghost) require this and reject
    /// mismatches with [`PublishError::UpdateConflict`]; providers
    /// that don't (WordPress) accept `None` and always overwrite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<ProviderRevision>,
}

/// Inputs handed to a platform adapter's `publish()` function. The
/// frontend builds this from the publish dialog plus pre-publish
/// image rewrite. The optional [`Self::update_target`] field turns
/// a call into an update instead of a create.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PublishInput {
    pub title: String,
    /// Already-rewritten body. For Ghost / WordPress this is HTML
    /// (from Pandoc); for Medium this is Markdown.
    pub body: String,
    pub body_format: BodyFormat,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excerpt: Option<String>,
    /// Platform-specific status string. See per-platform spec.
    pub status: String,
    /// Already-uploaded feature image URL on the platform.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feature_image_url: Option<String>,
    /// WordPress-specific: pre-uploaded media attachment id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub featured_media_id: Option<u64>,
    /// Medium-only: when set, post to a publication instead of the
    /// authenticated user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication_id: Option<String>,
    /// When set, updates the referenced remote post instead of
    /// creating a new one. Absent (`None`) preserves legacy
    /// create-only behavior for every existing caller.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_target: Option<UpdateTarget>,
}

/// Result returned to the frontend on success. New fields
/// [`Self::operation`] and [`Self::provider_revision`] are additive
/// with `#[serde(default)]` so:
/// 1. Existing adapters using the [`Self::created`] builder stay
///    forward-compatible.
/// 2. Legacy on-disk sidecars/frontends without these fields still
///    deserialize (operation defaults to `Created`, revision to
///    `None`).
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct PublishResult {
    /// Canonical URL of the post on the platform.
    pub url: String,
    /// Platform post id (string for portability across platforms).
    pub remote_id: String,
    /// Whether this call created a new post or updated an existing
    /// one. Defaults to `Created` for backward compatibility.
    #[serde(default)]
    pub operation: PublishOperation,
    /// Provider-typed revision stamp — Ghost's `updated_at`,
    /// WordPress's `modified` fields. `None` for providers that
    /// don't expose one (Medium) or callers that don't need it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_revision: Option<ProviderRevision>,
}

impl PublishResult {
    /// Build a create-result with no revision. Preferred over
    /// struct-literal `PublishResult { url, remote_id, .. }` so
    /// future field additions don't force every adapter to spell
    /// out `..Default::default()`.
    pub fn created(url: impl Into<String>, remote_id: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            remote_id: remote_id.into(),
            operation: PublishOperation::Created,
            provider_revision: None,
        }
    }

    /// Build a create-result carrying the provider's revision.
    pub fn created_with_revision(
        url: impl Into<String>,
        remote_id: impl Into<String>,
        revision: ProviderRevision,
    ) -> Self {
        Self {
            url: url.into(),
            remote_id: remote_id.into(),
            operation: PublishOperation::Created,
            provider_revision: Some(revision),
        }
    }

    /// Build an update-result.
    pub fn updated(
        url: impl Into<String>,
        remote_id: impl Into<String>,
        revision: Option<ProviderRevision>,
    ) -> Self {
        Self {
            url: url.into(),
            remote_id: remote_id.into(),
            operation: PublishOperation::Updated,
            provider_revision: revision,
        }
    }
}

/// Closed enum of reasons a provider might not support an update
/// call. Deliberately closed (no free-form String) so downstream code
/// cannot leak provider response text through this variant. Callers
/// that need finer diagnostics should return
/// [`PublishError::Server`] or [`PublishError::UnexpectedResponse`]
/// with `require_success`-scrubbed content instead.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UnsupportedUpdateReason {
    /// Provider's API supports post creation but exposes no update
    /// endpoint on this integration flow (e.g. Medium's Integration
    /// Token API is create-only — publish works, PATCH/PUT do not).
    CreateOnlyApi,
    /// Adapter implementation for updates is not yet wired.
    NotImplemented,
    /// Credential lacks the OAuth scope / capability required to update.
    InsufficientScope,
    /// Underlying content type cannot be updated in place (e.g. a Ghost
    /// email newsletter that has already sent).
    ImmutableContentType,
}

impl std::fmt::Display for UnsupportedUpdateReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::CreateOnlyApi => "provider API is create-only and does not support updates",
            Self::NotImplemented => "adapter update path not implemented",
            Self::InsufficientScope => "credential lacks required scope for updates",
            Self::ImmutableContentType => "content type cannot be updated in place",
        };
        f.write_str(s)
    }
}

/// All errors a publish adapter can return. Mapped to
/// `AppError::Custom(...)` at the Tauri command boundary.
///
/// The new typed variants — [`Self::RemoteNotFound`],
/// [`Self::UpdateConflict`], [`Self::UnsupportedUpdate`] — carry
/// only structured provider/post context. No raw response bodies,
/// no headers, no request bodies. If diagnostic detail from a
/// provider response is ever added, it MUST be routed through
/// [`redact_secrets`] first.
///
/// Wire representation is internally-tagged (`kind` + `data`) so a
/// future command that wants to expose structured errors to the
/// frontend has a stable JSON shape to depend on without changing
/// the crate-wide `AppError` string contract. Existing publish
/// commands still funnel through `From<PublishError> for AppError`
/// as a Display string — see `core/src/commands/publish.rs`.
///
/// Display is implemented manually rather than via `#[error("...")]`
/// so the serde `content = "data"` tuple-variant representation and
/// the `Box<UpdateConflictContext>` payload access play together
/// without thiserror's positional-arg parser choking on `.0.field`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum PublishError {
    Network(String),
    Auth(String),
    QuotaExceeded(String),
    BadConfig(String),
    Server {
        status: u16,
        message: String,
    },
    UnexpectedResponse(String),
    PandocFailed(String),
    ImageUploadFailed {
        ref_path: String,
        cause: String,
    },
    /// Update targeted a post that no longer exists on the provider
    /// (or was never created there). Adapters map platform 404s on
    /// update endpoints to this. Safe by construction: only carries
    /// provider name and remote id.
    RemoteNotFound {
        provider: String,
        remote_id: String,
    },
    /// Optimistic-concurrency check failed: the caller's
    /// [`UpdateTarget::expected_revision`] does not match the
    /// provider's current revision. Adapters map platform 409s to
    /// this. Safe by construction: only structured revisions, not
    /// raw response bodies. Payload boxed so
    /// `Result<_, PublishError>` stays under Clippy's
    /// `result_large_err` size threshold.
    UpdateConflict(Box<UpdateConflictContext>),
    /// Provider does not support updates. `reason` is a typed enum
    /// (see [`UnsupportedUpdateReason`]) — never a free-form string —
    /// so provider response text cannot leak here.
    UnsupportedUpdate {
        provider: String,
        reason: UnsupportedUpdateReason,
    },
}

impl std::fmt::Display for PublishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(m) => write!(f, "Network error: {m}"),
            Self::Auth(m) => write!(f, "Authentication rejected: {m}"),
            Self::QuotaExceeded(m) => write!(f, "Quota exceeded: {m}"),
            Self::BadConfig(m) => write!(f, "Bad config: {m}"),
            Self::Server { status, message } => write!(f, "Platform returned {status}: {message}"),
            Self::UnexpectedResponse(m) => write!(f, "Unexpected response: {m}"),
            Self::PandocFailed(m) => write!(f, "Pandoc conversion failed: {m}"),
            Self::ImageUploadFailed { ref_path, cause } => {
                write!(f, "Image upload failed for {ref_path}: {cause}")
            }
            Self::RemoteNotFound {
                provider,
                remote_id,
            } => write!(f, "Post not found on {provider}: {remote_id}"),
            Self::UpdateConflict(ctx) => write!(f, "Update conflict on {ctx}"),
            Self::UnsupportedUpdate { provider, reason } => {
                write!(f, "Update not supported on {provider}: {reason}")
            }
        }
    }
}

impl std::error::Error for PublishError {}

/// Convert a `reqwest::Error` into `PublishError::Network` after
/// scrubbing credentials out of the error string. `reqwest`'s
/// `Display` embeds the request URL, which for provider APIs can
/// carry `?api_key=…` / `?access_token=…` query params — piping
/// through [`redact_secrets`] closes that leak channel. Adapter code
/// MUST prefer this helper over `.map_err(|e| PublishError::Network(
/// e.to_string()))`.
pub fn redact_reqwest_error(err: reqwest::Error) -> PublishError {
    PublishError::Network(redact_secrets(&err.to_string()))
}

/// Build a redacted [`PublishError`] from an HTTP status and raw
/// response body. Applies [`redact_secrets`] BEFORE the 800-char
/// truncation so a token that straddles the cut boundary cannot be
/// half-preserved. Callers on `reqwest::Response` should prefer
/// `require_success` (in the parent module), which routes here.
pub fn build_error_from_body(status: u16, raw_body: &str) -> PublishError {
    let redacted = redact_secrets(raw_body);
    let truncated = if redacted.chars().count() > 800 {
        let mut t: String = redacted.chars().take(800).collect();
        t.push_str(" …(truncated)");
        t
    } else {
        redacted
    };
    let combined = if truncated.is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {truncated}")
    };
    match status {
        401 | 403 => PublishError::Auth(combined),
        429 => PublishError::QuotaExceeded(combined),
        _ => PublishError::Server {
            status,
            message: truncated,
        },
    }
}

/// Strip common credential patterns out of a provider-response
/// string so it is safe to embed in an error message. Defence in
/// depth — adapters should prefer to pull typed fields out of a
/// provider response rather than embed the whole body.
///
/// Redacted patterns:
/// - `Authorization`, `X-Api-Key`, `X-Auth-Token`, `Cookie`,
///   `Set-Cookie` header lines → value replaced with `<redacted>`
/// - `Bearer`/`Ghost`/`Basic`/`Token` scheme prefixes → token after
///   the scheme replaced with `<redacted>`
/// - Query/form credentials `api_key=`, `apikey=`, `access_token=`,
///   `client_secret=`, `app_password=`, `secret_key=`, `token=`,
///   `secret=`, `password=` → value replaced with `<redacted>`
/// - JSON string values keyed by `access_token`, `api_key`,
///   `apikey`, `secret`, `secret_key`, `password`, `app_password`,
///   `token`, `bearer`, `client_secret` → value replaced with
///   `<redacted>`
/// - Long runs (>= 24 chars) of URL-safe base64/JWT-alphabet chars
///   that contain both a digit and a letter → replaced with
///   `<redacted>`, catching stray JWTs / raw tokens
pub fn redact_secrets(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for line in input.split_inclusive('\n') {
        let lower = line.to_ascii_lowercase();
        if let Some(colon_pos) = lower.find(':') {
            let header_name = lower[..colon_pos].trim();
            if matches!(
                header_name,
                "authorization" | "x-api-key" | "x-auth-token" | "cookie" | "set-cookie"
            ) {
                let colon_end = colon_pos + 1;
                let (before, after) = line.split_at(colon_end);
                let trailing_ws_end = after
                    .rfind(|c: char| !c.is_whitespace())
                    .map_or(0, |i| i + 1);
                let (secret, trailing) = after.split_at(trailing_ws_end);
                let leading_ws_end = secret
                    .find(|c: char| !c.is_whitespace())
                    .unwrap_or(secret.len());
                let leading = &secret[..leading_ws_end];
                out.push_str(before);
                out.push_str(leading);
                out.push_str("<redacted>");
                out.push_str(trailing);
                continue;
            }
        }
        out.push_str(line);
    }

    out = redact_prefixed_token(&out, "Bearer ");
    out = redact_prefixed_token(&out, "bearer ");
    out = redact_prefixed_token(&out, "Ghost ");
    out = redact_prefixed_token(&out, "Basic ");
    out = redact_prefixed_token(&out, "Token ");
    out = redact_prefixed_token(&out, "token ");

    for key in [
        "api_key",
        "apikey",
        "access_token",
        "client_secret",
        "app_password",
        "secret_key",
        "token",
        "secret",
        "password",
    ] {
        out = redact_kv_pair(&out, key);
    }

    for key in [
        "access_token",
        "api_key",
        "apikey",
        "secret",
        "secret_key",
        "password",
        "app_password",
        "token",
        "bearer",
        "client_secret",
    ] {
        out = redact_json_value(&out, key);
    }

    redact_long_credential_runs(&out)
}

fn redact_prefixed_token(s: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find(prefix) {
        out.push_str(&rest[..idx]);
        out.push_str(prefix);
        rest = &rest[idx + prefix.len()..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',' || c == ')')
            .unwrap_or(rest.len());
        if end == 0 {
            continue;
        }
        let token = &rest[..end];
        let bytes = token.as_bytes();
        let has_digit = bytes.iter().any(|b| b.is_ascii_digit());
        let has_alpha = bytes.iter().any(|b| b.is_ascii_alphabetic());
        let has_url_special = bytes
            .iter()
            .any(|b| matches!(b, b'.' | b'-' | b'_' | b'+' | b'/' | b'='));
        let cred_shaped = (has_digit && has_alpha) || token.len() >= 16 || has_url_special;
        if cred_shaped {
            out.push_str("<redacted>");
            rest = &rest[end..];
        }
    }
    out.push_str(rest);
    out
}

fn redact_kv_pair(s: &str, key: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let Some(idx) = find_key_boundary(rest, key) else {
            out.push_str(rest);
            break;
        };
        let after_key = &rest[idx + key.len()..];
        let (ws_len, tail) = split_leading_whitespace(after_key);
        if !tail.starts_with('=') {
            out.push_str(&rest[..idx + key.len()]);
            rest = &rest[idx + key.len()..];
            continue;
        }
        let value_start = ws_len + 1;
        let (_, value_area) = after_key.split_at(value_start);
        let value_end = value_area
            .find(|c: char| {
                c.is_whitespace() || c == '&' || c == ';' || c == ',' || c == '"' || c == '}'
            })
            .unwrap_or(value_area.len());
        if value_end == 0 {
            out.push_str(&rest[..idx + key.len() + value_start]);
            rest = &rest[idx + key.len() + value_start..];
            continue;
        }
        out.push_str(&rest[..idx + key.len() + value_start]);
        out.push_str("<redacted>");
        rest = &rest[idx + key.len() + value_start + value_end..];
    }
    out
}

fn find_key_boundary(s: &str, key: &str) -> Option<usize> {
    let lower = s.to_ascii_lowercase();
    let key_lower = key.to_ascii_lowercase();
    let mut start = 0;
    while let Some(rel) = lower[start..].find(&key_lower) {
        let abs = start + rel;
        let boundary_ok = abs == 0
            || matches!(
                s.as_bytes()[abs - 1],
                b' ' | b'\t' | b'\n' | b'\r' | b'?' | b'&' | b';' | b','
            );
        if boundary_ok {
            return Some(abs);
        }
        start = abs + key.len();
    }
    None
}

fn split_leading_whitespace(s: &str) -> (usize, &str) {
    let end = s.find(|c: char| !c.is_whitespace()).unwrap_or(s.len());
    (end, &s[end..])
}

fn redact_json_value(s: &str, key: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    let needle_lower = format!("\"{}\"", key.to_ascii_lowercase());
    loop {
        let lower_rest = rest.to_ascii_lowercase();
        let Some(rel) = lower_rest.find(&needle_lower) else {
            out.push_str(rest);
            break;
        };
        let after_key_idx = rel + needle_lower.len();
        let after_key = &rest[after_key_idx..];
        let (ws, tail) = split_leading_whitespace(after_key);
        if !tail.starts_with(':') {
            out.push_str(&rest[..after_key_idx]);
            rest = after_key;
            continue;
        }
        let after_colon = &tail[1..];
        let (ws2, val_area) = split_leading_whitespace(after_colon);
        if !val_area.starts_with('"') {
            out.push_str(&rest[..after_key_idx + ws + 1 + ws2]);
            rest = val_area;
            continue;
        }
        let val_start = 1;
        let bytes = val_area.as_bytes();
        let mut i = val_start;
        while i < bytes.len() {
            match bytes[i] {
                b'\\' => i += 2,
                b'"' => break,
                _ => i += 1,
            }
        }
        if i >= bytes.len() {
            out.push_str(rest);
            break;
        }
        out.push_str(&rest[..after_key_idx + ws + 1 + ws2 + 1]);
        out.push_str("<redacted>");
        let consumed = after_key_idx + ws + 1 + ws2 + 1 + (i - val_start);
        rest = &rest[consumed..];
    }
    out
}

fn redact_long_credential_runs(s: &str) -> String {
    const MIN: usize = 24;
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        let non_start = i;
        while i < bytes.len() && !is_credential_char(bytes[i]) {
            i += 1;
        }
        out.push_str(&s[non_start..i]);
        let run_start = i;
        while i < bytes.len() && is_credential_char(bytes[i]) {
            i += 1;
        }
        if i == run_start {
            continue;
        }
        let slice = &bytes[run_start..i];
        let has_digit = slice.iter().any(|b| b.is_ascii_digit());
        let has_upper = slice.iter().any(|b| b.is_ascii_uppercase());
        let has_lower = slice.iter().any(|b| b.is_ascii_lowercase());
        let mixed = has_digit && (has_upper || has_lower);
        if slice.len() >= MIN && mixed {
            out.push_str("<redacted>");
        } else {
            out.push_str(&s[run_start..i]);
        }
    }
    out
}

fn is_credential_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'+' | b'/' | b'=')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publish_operation_defaults_to_created() {
        assert_eq!(PublishOperation::default(), PublishOperation::Created);
    }

    #[test]
    fn publish_operation_serializes_as_lowercase_strings() {
        assert_eq!(
            serde_json::to_string(&PublishOperation::Created).unwrap(),
            "\"created\""
        );
        assert_eq!(
            serde_json::to_string(&PublishOperation::Updated).unwrap(),
            "\"updated\""
        );
    }

    #[test]
    fn publish_operation_round_trips_through_json() {
        for op in [PublishOperation::Created, PublishOperation::Updated] {
            let json = serde_json::to_string(&op).unwrap();
            let parsed: PublishOperation = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed, op);
        }
    }

    #[test]
    fn provider_revision_ghost_serializes_with_provider_tag() {
        let rev = ProviderRevision::Ghost {
            updated_at: "2026-07-16T00:00:00.000Z".into(),
        };
        let v = serde_json::to_value(&rev).unwrap();
        assert_eq!(v["provider"], "ghost");
        assert_eq!(v["updated_at"], "2026-07-16T00:00:00.000Z");
    }

    #[test]
    fn provider_revision_wordpress_serializes_with_both_modified_fields() {
        let rev = ProviderRevision::WordPress {
            modified: Some("2026-07-16T12:00:00".into()),
            modified_gmt: Some("2026-07-16T12:00:00".into()),
        };
        let v = serde_json::to_value(&rev).unwrap();
        assert_eq!(v["provider"], "wordpress");
        assert_eq!(v["modified"], "2026-07-16T12:00:00");
        assert_eq!(v["modified_gmt"], "2026-07-16T12:00:00");
    }

    #[test]
    fn provider_revision_wordpress_omits_absent_modified_fields() {
        let rev = ProviderRevision::WordPress {
            modified: None,
            modified_gmt: None,
        };
        let v = serde_json::to_value(&rev).unwrap();
        assert_eq!(v["provider"], "wordpress");
        assert!(v.get("modified").is_none());
        assert!(v.get("modified_gmt").is_none());
    }

    #[test]
    fn provider_revision_round_trips_both_variants() {
        let g = ProviderRevision::Ghost {
            updated_at: "iso".into(),
        };
        let g2: ProviderRevision =
            serde_json::from_str(&serde_json::to_string(&g).unwrap()).unwrap();
        assert_eq!(g, g2);
        let w = ProviderRevision::WordPress {
            modified: Some("m".into()),
            modified_gmt: None,
        };
        let w2: ProviderRevision =
            serde_json::from_str(&serde_json::to_string(&w).unwrap()).unwrap();
        assert_eq!(w, w2);
    }

    #[test]
    fn publish_result_created_default_carries_operation_created_and_no_revision() {
        let r = PublishResult::created("https://blog.example.com/hello/", "post-1");
        assert_eq!(r.operation, PublishOperation::Created);
        assert!(r.provider_revision.is_none());
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["url"], "https://blog.example.com/hello/");
        assert_eq!(v["remote_id"], "post-1");
        assert_eq!(v["operation"], "created");
        assert!(v.get("provider_revision").is_none());
    }

    #[test]
    fn publish_result_created_with_ghost_revision_serializes_provider_and_updated_at() {
        let r = PublishResult::created_with_revision(
            "https://blog.example.com/hello/",
            "post-1",
            ProviderRevision::Ghost {
                updated_at: "2026-07-16T00:00:00.000Z".into(),
            },
        );
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["operation"], "created");
        assert_eq!(v["provider_revision"]["provider"], "ghost");
        assert_eq!(
            v["provider_revision"]["updated_at"],
            "2026-07-16T00:00:00.000Z"
        );
    }

    #[test]
    fn publish_result_updated_with_wordpress_revision_round_trips() {
        let r = PublishResult::updated(
            "https://example.com/?p=99",
            "99",
            Some(ProviderRevision::WordPress {
                modified: Some("2026-07-16T09:15:00".into()),
                modified_gmt: Some("2026-07-16T09:15:00".into()),
            }),
        );
        let json = serde_json::to_string(&r).unwrap();
        let parsed: PublishResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, r);
        assert_eq!(parsed.operation, PublishOperation::Updated);
    }

    #[test]
    fn publish_result_deserializes_legacy_shape_without_operation_or_revision() {
        let legacy = r#"{"url":"https://blog.example.com/x/","remote_id":"p42"}"#;
        let parsed: PublishResult = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.url, "https://blog.example.com/x/");
        assert_eq!(parsed.remote_id, "p42");
        assert_eq!(parsed.operation, PublishOperation::Created);
        assert!(parsed.provider_revision.is_none());
    }

    #[test]
    fn publish_result_deserializes_explicit_updated_with_ghost_revision() {
        let wire = r#"{
            "url":"https://blog.example.com/x/",
            "remote_id":"p42",
            "operation":"updated",
            "provider_revision":{"provider":"ghost","updated_at":"2026-07-16T00:00:00Z"}
        }"#;
        let parsed: PublishResult = serde_json::from_str(wire).unwrap();
        assert_eq!(parsed.operation, PublishOperation::Updated);
        match parsed.provider_revision {
            Some(ProviderRevision::Ghost { updated_at }) => {
                assert_eq!(updated_at, "2026-07-16T00:00:00Z");
            }
            other => panic!("expected Ghost revision, got {other:?}"),
        }
    }

    fn sample_input() -> PublishInput {
        PublishInput {
            title: "Hello".into(),
            body: "<p>x</p>".into(),
            body_format: BodyFormat::Html,
            tags: vec!["rust".into()],
            slug: None,
            excerpt: None,
            status: "draft".into(),
            feature_image_url: None,
            featured_media_id: None,
            publication_id: None,
            update_target: None,
        }
    }

    #[test]
    fn publish_input_serializes_without_update_target_by_default() {
        let inp = sample_input();
        let v = serde_json::to_value(&inp).unwrap();
        assert!(v.get("update_target").is_none());
    }

    #[test]
    fn publish_input_deserializes_legacy_json_without_update_target() {
        let legacy = r#"{
            "title":"Hello","body":"x","body_format":"html","tags":[],
            "status":"draft"
        }"#;
        let parsed: PublishInput = serde_json::from_str(legacy).unwrap();
        assert!(parsed.update_target.is_none());
        assert_eq!(parsed.title, "Hello");
    }

    #[test]
    fn publish_input_round_trips_with_update_target_and_expected_revision() {
        let mut inp = sample_input();
        inp.update_target = Some(UpdateTarget {
            remote_id: "post-1".into(),
            expected_revision: Some(ProviderRevision::Ghost {
                updated_at: "2026-07-16T00:00:00Z".into(),
            }),
        });
        let json = serde_json::to_string(&inp).unwrap();
        let parsed: PublishInput = serde_json::from_str(&json).unwrap();
        assert!(parsed.update_target.is_some());
        let ut = parsed.update_target.unwrap();
        assert_eq!(ut.remote_id, "post-1");
        match ut.expected_revision {
            Some(ProviderRevision::Ghost { updated_at }) => {
                assert_eq!(updated_at, "2026-07-16T00:00:00Z")
            }
            other => panic!("expected Ghost revision, got {other:?}"),
        }
    }

    #[test]
    fn update_target_serializes_without_expected_revision_when_absent() {
        let ut = UpdateTarget {
            remote_id: "abc".into(),
            expected_revision: None,
        };
        let v = serde_json::to_value(&ut).unwrap();
        assert_eq!(v["remote_id"], "abc");
        assert!(v.get("expected_revision").is_none());
    }

    #[test]
    fn remote_not_found_display_contains_provider_and_id_only() {
        let err = PublishError::RemoteNotFound {
            provider: "ghost".into(),
            remote_id: "post-1".into(),
        };
        let msg = err.to_string();
        assert!(msg.contains("ghost"));
        assert!(msg.contains("post-1"));
    }

    #[test]
    fn update_conflict_display_contains_provider_and_id_only() {
        let err = PublishError::UpdateConflict(Box::new(UpdateConflictContext {
            provider: "ghost".into(),
            remote_id: "post-1".into(),
            expected: Some(ProviderRevision::Ghost {
                updated_at: "2026-07-16T00:00:00Z".into(),
            }),
            actual: Some(ProviderRevision::Ghost {
                updated_at: "2026-07-16T00:00:01Z".into(),
            }),
        }));
        let msg = err.to_string();
        assert!(msg.contains("ghost"));
        assert!(msg.contains("post-1"));
        assert!(msg.contains("conflict"));
    }

    #[test]
    fn unsupported_update_display_contains_reason() {
        let err = PublishError::UnsupportedUpdate {
            provider: "medium".into(),
            reason: UnsupportedUpdateReason::CreateOnlyApi,
        };
        let msg = err.to_string();
        assert!(msg.contains("medium"));
        assert!(msg.contains("create-only"), "got: {msg}");
    }

    #[test]
    fn typed_error_variants_do_not_carry_raw_response_bodies() {
        let token = "sk-super-secret-DEADBEEF00000000";
        let e1 = PublishError::RemoteNotFound {
            provider: "ghost".into(),
            remote_id: "id-x".into(),
        };
        assert!(!format!("{e1}").contains(token));
        let e2 = PublishError::UpdateConflict(Box::new(UpdateConflictContext {
            provider: "ghost".into(),
            remote_id: "id-y".into(),
            expected: Some(ProviderRevision::Ghost {
                updated_at: "iso".into(),
            }),
            actual: None,
        }));
        assert!(!format!("{e2}").contains(token));
        let e3 = PublishError::UnsupportedUpdate {
            provider: "medium".into(),
            reason: UnsupportedUpdateReason::CreateOnlyApi,
        };
        assert!(!format!("{e3}").contains(token));
    }

    #[test]
    fn redact_authorization_header_line() {
        let raw =
            "GET /posts HTTP/1.1\nAuthorization: Bearer sk-live-DEADBEEF1234567890\nAccept: */*\n";
        let out = redact_secrets(raw);
        assert!(!out.contains("sk-live-DEADBEEF1234567890"));
        assert!(out.contains("Authorization:"));
        assert!(out.contains("<redacted>"));
    }

    #[test]
    fn redact_ghost_scheme_prefix() {
        let raw = "Authorization: Ghost eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3MDB9.abcDEF";
        let out = redact_secrets(raw);
        assert!(!out.contains("eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3MDB9.abcDEF"));
        assert!(out.contains("<redacted>"));
    }

    #[test]
    fn redact_basic_auth_scheme() {
        let raw = "Authorization: Basic YWxpY2U6c2VjcmV0MTIz";
        let out = redact_secrets(raw);
        assert!(!out.contains("YWxpY2U6c2VjcmV0MTIz"));
    }

    #[test]
    fn redact_bearer_token_inline() {
        let raw = "curl -H \"Authorization: Bearer sk-DEADBEEF-1234\" https://api.example.com";
        let out = redact_secrets(raw);
        assert!(!out.contains("sk-DEADBEEF-1234"));
    }

    #[test]
    fn redact_query_string_api_key() {
        let raw = "https://api.example.com/upload?api_key=abc123DEADBEEF&other=safe";
        let out = redact_secrets(raw);
        assert!(!out.contains("abc123DEADBEEF"));
        assert!(out.contains("other=safe"));
    }

    #[test]
    fn redact_access_token_query_param() {
        let raw = "https://public-api.wordpress.com/rest/v1/me?access_token=WPCOM_SECRET_12345";
        let out = redact_secrets(raw);
        assert!(!out.contains("WPCOM_SECRET_12345"));
    }

    #[test]
    fn redact_json_access_token_field() {
        let raw = r#"{"posts":[{"id":"p1","updated_at":"2026-07-16"}],"access_token":"sk-secret-12345XYZabc"}"#;
        let out = redact_secrets(raw);
        assert!(
            !out.contains("sk-secret-12345XYZabc"),
            "expected token stripped, got: {out}"
        );
        assert!(out.contains("p1"));
        assert!(out.contains("2026-07-16"));
    }

    #[test]
    fn redact_json_password_field() {
        let raw = r#"{"user":"alice","password":"hunter2SUPERSECRET"}"#;
        let out = redact_secrets(raw);
        assert!(!out.contains("hunter2SUPERSECRET"));
        assert!(out.contains("alice"));
    }

    #[test]
    fn redact_leaves_ordinary_text_alone() {
        let raw = "Ghost returned 500: internal server error";
        let out = redact_secrets(raw);
        assert_eq!(out, raw);
    }

    #[test]
    fn redact_scrubs_long_jwt_like_run() {
        let raw =
            "session=eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3MDB9.abcDEF01234567890QRSTUV; other=safe";
        let out = redact_secrets(raw);
        assert!(
            !out.contains("eyJhbGciOiJIUzI1NiJ9.eyJpYXQiOjE3MDB9.abcDEF01234567890QRSTUV"),
            "expected JWT stripped, got: {out}"
        );
    }

    #[test]
    fn redact_preserves_short_alphanumeric_ids() {
        let raw = r#"{"id":"p1","slug":"hello-world","updated_at":"2026-07-16T00:00:00Z"}"#;
        let out = redact_secrets(raw);
        assert!(out.contains("p1"));
        assert!(out.contains("hello-world"));
        assert!(out.contains("2026-07-16T00:00:00Z"));
    }

    #[test]
    fn redact_is_idempotent() {
        let raw = "Authorization: Bearer sk-secret-12345XYZabc";
        let once = redact_secrets(raw);
        let twice = redact_secrets(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn secret_safe_provider_error_scenario_mock_ghost_409_with_token_in_body() {
        let raw_body = r#"{
            "posts":[{"id":"p42","updated_at":"2026-07-16T00:00:00Z"}],
            "errors":[{"message":"Saving failed! Post updated","code":"OUTDATED"}],
            "request":{"headers":{"Authorization":"Ghost eyJhbGciSUPERSECRETTOKEN.payload.sig"}}
        }"#;
        let redacted = redact_secrets(raw_body);
        assert!(
            !redacted.contains("eyJhbGciSUPERSECRETTOKEN"),
            "token leaked into redacted context: {redacted}"
        );
        let err = PublishError::UpdateConflict(Box::new(UpdateConflictContext {
            provider: "ghost".into(),
            remote_id: "p42".into(),
            expected: Some(ProviderRevision::Ghost {
                updated_at: "2026-07-15T23:59:59Z".into(),
            }),
            actual: Some(ProviderRevision::Ghost {
                updated_at: "2026-07-16T00:00:00Z".into(),
            }),
        }));
        let display = err.to_string();
        assert!(!display.contains("eyJhbGciSUPERSECRETTOKEN"));
        assert!(display.contains("ghost"));
        assert!(display.contains("p42"));
    }

    #[test]
    fn existing_error_variants_still_construct() {
        let _n = PublishError::Network("boom".into());
        let _a = PublishError::Auth("bad creds".into());
        let _q = PublishError::QuotaExceeded("429".into());
        let _b = PublishError::BadConfig("missing url".into());
        let _s = PublishError::Server {
            status: 500,
            message: "internal".into(),
        };
        let _u = PublishError::UnexpectedResponse("no id".into());
        let _p = PublishError::PandocFailed("not on PATH".into());
        let _i = PublishError::ImageUploadFailed {
            ref_path: "img.png".into(),
            cause: "network".into(),
        };
    }

    #[test]
    fn publish_error_remote_not_found_serializes_with_stable_tag_and_fields() {
        let err = PublishError::RemoteNotFound {
            provider: "ghost".into(),
            remote_id: "p42".into(),
        };
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["kind"], "remote_not_found");
        assert_eq!(v["data"]["provider"], "ghost");
        assert_eq!(v["data"]["remote_id"], "p42");
    }

    #[test]
    fn publish_error_remote_not_found_round_trips_exactly() {
        let err = PublishError::RemoteNotFound {
            provider: "wordpress".into(),
            remote_id: "99".into(),
        };
        let json = serde_json::to_string(&err).unwrap();
        let parsed: PublishError = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, err);
    }

    #[test]
    fn publish_error_update_conflict_serializes_with_boxed_context_data() {
        let err = PublishError::UpdateConflict(Box::new(UpdateConflictContext {
            provider: "ghost".into(),
            remote_id: "p42".into(),
            expected: Some(ProviderRevision::Ghost {
                updated_at: "2026-07-15T23:59:59Z".into(),
            }),
            actual: Some(ProviderRevision::Ghost {
                updated_at: "2026-07-16T00:00:00Z".into(),
            }),
        }));
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["kind"], "update_conflict");
        assert_eq!(v["data"]["provider"], "ghost");
        assert_eq!(v["data"]["remote_id"], "p42");
        assert_eq!(v["data"]["expected"]["provider"], "ghost");
        assert_eq!(v["data"]["expected"]["updated_at"], "2026-07-15T23:59:59Z");
        assert_eq!(v["data"]["actual"]["updated_at"], "2026-07-16T00:00:00Z");
    }

    #[test]
    fn publish_error_update_conflict_round_trips_exactly() {
        let err = PublishError::UpdateConflict(Box::new(UpdateConflictContext {
            provider: "wordpress".into(),
            remote_id: "77".into(),
            expected: Some(ProviderRevision::WordPress {
                modified: Some("2026-07-16T09:00:00".into()),
                modified_gmt: Some("2026-07-16T09:00:00".into()),
            }),
            actual: None,
        }));
        let json = serde_json::to_string(&err).unwrap();
        let parsed: PublishError = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, err);
    }

    #[test]
    fn publish_error_unsupported_update_serializes_with_typed_reason_enum() {
        let err = PublishError::UnsupportedUpdate {
            provider: "medium".into(),
            reason: UnsupportedUpdateReason::CreateOnlyApi,
        };
        let v = serde_json::to_value(&err).unwrap();
        assert_eq!(v["kind"], "unsupported_update");
        assert_eq!(v["data"]["provider"], "medium");
        assert_eq!(v["data"]["reason"], "create_only_api");
    }

    #[test]
    fn publish_error_unsupported_update_round_trips_all_reason_variants() {
        for reason in [
            UnsupportedUpdateReason::CreateOnlyApi,
            UnsupportedUpdateReason::NotImplemented,
            UnsupportedUpdateReason::InsufficientScope,
            UnsupportedUpdateReason::ImmutableContentType,
        ] {
            let err = PublishError::UnsupportedUpdate {
                provider: "x".into(),
                reason,
            };
            let json = serde_json::to_string(&err).unwrap();
            let parsed: PublishError = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed, err);
        }
    }

    #[test]
    fn publish_error_typed_variants_serialization_never_contains_secrets() {
        let token = "sk-super-secret-DEADBEEF1234567890";
        let e1 = PublishError::RemoteNotFound {
            provider: "ghost".into(),
            remote_id: "p1".into(),
        };
        let e2 = PublishError::UpdateConflict(Box::new(UpdateConflictContext {
            provider: "ghost".into(),
            remote_id: "p2".into(),
            expected: Some(ProviderRevision::Ghost {
                updated_at: "2026-07-16T00:00:00Z".into(),
            }),
            actual: None,
        }));
        let e3 = PublishError::UnsupportedUpdate {
            provider: "medium".into(),
            reason: UnsupportedUpdateReason::CreateOnlyApi,
        };
        for err in [&e1, &e2, &e3] {
            let json = serde_json::to_string(err).unwrap();
            assert!(!json.contains(token), "json leaked token: {json}");
            let display = err.to_string();
            assert!(!display.contains(token), "display leaked token: {display}");
        }
    }

    #[test]
    fn publish_error_existing_variants_also_serialize_with_tag_and_data() {
        let net = PublishError::Network("boom".into());
        let v = serde_json::to_value(&net).unwrap();
        assert_eq!(v["kind"], "network");
        assert_eq!(v["data"], "boom");

        let server = PublishError::Server {
            status: 503,
            message: "down".into(),
        };
        let v = serde_json::to_value(&server).unwrap();
        assert_eq!(v["kind"], "server");
        assert_eq!(v["data"]["status"], 503);
        assert_eq!(v["data"]["message"], "down");

        let img = PublishError::ImageUploadFailed {
            ref_path: "x.png".into(),
            cause: "timeout".into(),
        };
        let v = serde_json::to_value(&img).unwrap();
        assert_eq!(v["kind"], "image_upload_failed");
        assert_eq!(v["data"]["ref_path"], "x.png");
        assert_eq!(v["data"]["cause"], "timeout");
    }

    #[test]
    fn unsupported_update_reason_display_strings_are_human_readable() {
        assert!(UnsupportedUpdateReason::CreateOnlyApi
            .to_string()
            .contains("create-only"));
        assert!(UnsupportedUpdateReason::NotImplemented
            .to_string()
            .contains("not implemented"));
        assert!(UnsupportedUpdateReason::InsufficientScope
            .to_string()
            .contains("scope"));
        assert!(UnsupportedUpdateReason::ImmutableContentType
            .to_string()
            .contains("in place"));
    }

    #[test]
    fn build_error_from_body_redacts_authorization_before_truncation() {
        let raw = format!(
            "{}\nAuthorization: Bearer sk-live-DEADBEEF1234567890\n",
            "x".repeat(795)
        );
        let err = build_error_from_body(500, &raw);
        let display = err.to_string();
        assert!(
            !display.contains("sk-live-DEADBEEF1234567890"),
            "token leaked after truncation: {display}"
        );
    }

    #[test]
    fn build_error_from_body_401_maps_to_auth_error_with_redacted_body() {
        let raw = r#"{"error":"unauthorized","access_token":"sk-secret-12345XYZabc"}"#;
        let err = build_error_from_body(401, raw);
        assert!(matches!(err, PublishError::Auth(_)), "got {err:?}");
        assert!(!err.to_string().contains("sk-secret-12345XYZabc"));
    }

    #[test]
    fn build_error_from_body_429_maps_to_quota_exceeded_with_redacted_body() {
        let raw = "rate limited, retry after 60s, api_key=DEADBEEF01234567abcXYZ";
        let err = build_error_from_body(429, raw);
        assert!(matches!(err, PublishError::QuotaExceeded(_)), "got {err:?}");
        assert!(!err.to_string().contains("DEADBEEF01234567abcXYZ"));
    }

    #[test]
    fn build_error_from_body_generic_status_maps_to_server_with_redacted_body() {
        let raw = r#"Authorization: Basic YWxpY2U6c2VjcmV0MTIz encoded body"#;
        let err = build_error_from_body(503, raw);
        match &err {
            PublishError::Server { status, message } => {
                assert_eq!(*status, 503);
                assert!(!message.contains("YWxpY2U6c2VjcmV0MTIz"));
            }
            other => panic!("expected Server, got {other:?}"),
        }
    }

    #[test]
    fn build_error_from_body_empty_body_still_gives_http_status_line() {
        let err = build_error_from_body(500, "");
        assert_eq!(err.to_string(), "Platform returned 500: ");
    }

    #[test]
    fn build_error_from_body_truncates_after_redaction() {
        let raw = "A".repeat(2000);
        let err = build_error_from_body(500, &raw);
        let display = err.to_string();
        assert!(display.contains("…(truncated)"));
    }

    #[test]
    fn redact_secrets_scrubs_reqwest_style_url_error_string() {
        let simulated = "error sending request for url \
                         (https://public-api.wordpress.com/rest/v1/me?access_token=WPCOM_SECRET_ABC123): \
                         connection refused";
        let out = redact_secrets(simulated);
        assert!(
            !out.contains("WPCOM_SECRET_ABC123"),
            "token leaked in reqwest-style error string: {out}"
        );
        assert!(
            out.contains("connection refused"),
            "safe diagnostic dropped: {out}"
        );
    }

    #[test]
    fn redact_secrets_scrubs_reqwest_style_url_error_string_with_api_key_param() {
        let simulated =
            "error sending request for url (https://sms.api.example.com/upload?api_key=DEADBEEF1234567890abcXYZ): \
             dns error: failed to lookup address information";
        let out = redact_secrets(simulated);
        assert!(!out.contains("DEADBEEF1234567890abcXYZ"));
        assert!(out.contains("dns error"));
    }

    #[test]
    fn build_error_from_body_gh_conflict_body_with_authorization_header_is_scrubbed() {
        let raw = r#"HTTP/1.1 409 Conflict
Content-Type: application/json
Authorization: Ghost eyJhbGciSUPERSECRETTOKEN01234567890abcDEF.payload.sig

{"posts":[{"id":"p42","updated_at":"2026-07-16T00:00:00Z"}],
 "errors":[{"message":"Saving failed! Post updated","code":"OUTDATED"}]}"#;
        let err = build_error_from_body(409, raw);
        let display = err.to_string();
        assert!(
            !display.contains("eyJhbGciSUPERSECRETTOKEN01234567890abcDEF"),
            "JWT leaked from Authorization header: {display}"
        );
        assert!(display.contains("Saving failed"));
        assert!(display.contains("p42"));
    }
}
