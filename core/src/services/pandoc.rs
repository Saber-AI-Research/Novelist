//! Pandoc detection, invocation, and structured diagnostics.
//!
//! This module distinguishes every stage at which a Pandoc export can
//! fail so the UI (and future headless callers) can render actionable,
//! user-safe error messages rather than "Pandoc error: <opaque stderr>".
//!
//! # Resolution order for the pandoc binary
//!   1. The user's explicit override from `GlobalSettings.pandoc_path`,
//!      if it points at an executable that responds to `--version`.
//!   2. `pandoc` on `$PATH`.
//!   3. Common system install locations (Homebrew, /usr/local, etc.)
//!      so that GUI launches on macOS — which often have a stripped
//!      `$PATH` that excludes `/opt/homebrew/bin` — still find a
//!      Homebrew-installed pandoc.
//!   4. None — the caller surfaces a friendly install hint.
//!
//! # Failure stages
//! [`PandocStage`] enumerates every distinct point of failure. The
//! [`PandocFailure`] struct is the authoritative diagnostic and never
//! contains:
//!   - the raw document contents (only the source-file path, if any);
//!   - environment variables or full arg values that could contain
//!     tokens/passwords/keys — see [`redact_argv_summary`];
//!   - unbounded subprocess output — stderr is truncated to a byte
//!     budget on a UTF-8 code-point boundary via [`truncate_stderr`].
//!
//! Callers may still map a [`PandocFailure`] to `AppError::Custom` for
//! compatibility with existing `Result<String, AppError>` command
//! signatures via [`PandocFailure::into_app_error`], while internal
//! callers can consume the typed value directly.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::watch;

// ---------------------------------------------------------------------------
// Public contract types
// ---------------------------------------------------------------------------

/// One of the well-defined stages at which a Pandoc export can fail.
///
/// Serialization is `snake_case` so a frontend can pattern-match on
/// the string without a codegen dependency.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PandocStage {
    /// The binary could not be located via override, PATH, or the
    /// deterministic probe list.
    Discovery,
    /// Reading the input file or decoding its legacy-encoded bytes as
    /// text failed before Pandoc was spawned.
    InputRead,
    /// The child process could not be spawned (e.g. permission denied
    /// after resolution, missing dylib, or fork failure).
    Spawn,
    /// The wait on the child was aborted because it exceeded the
    /// caller-supplied timeout, or the caller cancelled the export.
    /// File export uses the 120-second default.
    TimeoutOrCancel,
    /// Pandoc returned a non-zero exit code. `exit_code` is populated
    /// with the OS-reported value (or `None` if killed by a signal).
    ExitNonZero,
    /// Pandoc succeeded but its stdout could not be decoded (only
    /// applicable to the stdin/stdout HTML variant). The file-output
    /// path never triggers this because Pandoc writes bytes directly.
    OutputDecode,
    /// Pandoc completed, but its sibling temporary output could not be
    /// durably committed to the user-selected destination.
    OutputCommit,
    /// Post-run cleanup (temp-file removal, kill/reap on cancel, etc.)
    /// failed. This is informational — the export itself may still
    /// have succeeded — but we surface it so the UI can hint at disk
    /// full / permission issues.
    Cleanup,
}

impl PandocStage {
    /// Short human tag used in the [`std::fmt::Display`] of
    /// [`PandocFailure`]. Matches the serde string.
    pub const fn tag(self) -> &'static str {
        match self {
            PandocStage::Discovery => "discovery",
            PandocStage::InputRead => "input_read",
            PandocStage::Spawn => "spawn",
            PandocStage::TimeoutOrCancel => "timeout_or_cancel",
            PandocStage::ExitNonZero => "exit_non_zero",
            PandocStage::OutputDecode => "output_decode",
            PandocStage::OutputCommit => "output_commit",
            PandocStage::Cleanup => "cleanup",
        }
    }
}

/// A structured diagnostic emitted by every failure path in this
/// module. Serializable to JSON for logs and IPC — safe by construction.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PandocFailure {
    /// Which point in the pipeline failed. Always populated.
    pub stage: PandocStage,
    /// User-facing English message. Never contains secrets or document
    /// contents — safe to render verbatim.
    pub message: String,
    /// Absolute path of the resolved Pandoc binary when known.
    /// `None` on `Discovery` failures.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_binary: Option<String>,
    /// Target output format ("html" / "pdf" / "docx" / "epub" / …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    /// Sanitized argv summary — each user-supplied `--flag=value` has
    /// its value redacted if the flag name suggests a secret. Positional
    /// paths remain visible; environment is NEVER included.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub argv_summary: Vec<String>,
    /// Exit code, when applicable (`ExitNonZero` and sometimes
    /// `TimeoutOrCancel`). Killed-by-signal → `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Truncated stderr, always <= [`STDERR_BUDGET`] bytes, cut at a
    /// UTF-8 code-point boundary. Empty when no stderr was emitted.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub stderr_excerpt: String,
    /// Whether `stderr_excerpt` was truncated below the original
    /// length. Lets callers show a "(truncated)" hint.
    #[serde(default, skip_serializing_if = "is_false")]
    pub stderr_truncated: bool,
    /// Optional source-file context (path only — never contents).
    /// Populated on `InputRead` and on export runs where the caller
    /// wants the diagnostic to name the offending file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    /// Optional list of paths probed during `Discovery`, so the UI
    /// can show "we looked here, here, and here" without a full
    /// environment dump.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub probed_paths: Vec<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl PandocFailure {
    /// Construct a bare failure with only the stage and message set.
    /// Prefer the more specific `discovery` / `spawn` / `exit_non_zero`
    /// constructors when the shape is known.
    pub fn new(stage: PandocStage, message: impl Into<String>) -> Self {
        Self {
            stage,
            message: message.into(),
            resolved_binary: None,
            format: None,
            argv_summary: Vec::new(),
            exit_code: None,
            stderr_excerpt: String::new(),
            stderr_truncated: false,
            source_path: None,
            probed_paths: Vec::new(),
        }
    }

    pub fn with_binary(mut self, bin: impl Into<String>) -> Self {
        self.resolved_binary = Some(bin.into());
        self
    }

    pub fn with_format(mut self, format: impl Into<String>) -> Self {
        self.format = Some(format.into());
        self
    }

    pub fn with_argv_summary(mut self, summary: Vec<String>) -> Self {
        self.argv_summary = summary;
        self
    }

    pub fn with_exit_code(mut self, code: Option<i32>) -> Self {
        self.exit_code = code;
        self
    }

    pub fn with_stderr(mut self, stderr_bytes: &[u8]) -> Self {
        let sanitized = sanitize_stderr(&String::from_utf8_lossy(stderr_bytes));
        let original_len = sanitized.len();
        let excerpt = truncate_str(&sanitized, STDERR_BUDGET);
        self.stderr_truncated = excerpt.len() < original_len;
        self.stderr_excerpt = excerpt;
        self
    }

    pub fn with_source_path(mut self, path: impl Into<String>) -> Self {
        self.source_path = Some(path.into());
        self
    }

    pub fn with_probed_paths(mut self, probed: Vec<String>) -> Self {
        self.probed_paths = probed;
        self
    }

    /// Serialize through `AppError::Custom` for Tauri command boundaries;
    /// the frontend recognizes the bounded structured envelope.
    pub fn into_app_error(self) -> AppError {
        match serde_json::to_string(&self) {
            Ok(json) => AppError::Custom(format!("NOVELIST_PANDOC_FAILURE_JSON:{json}")),
            Err(_) => AppError::Custom(self.to_string()),
        }
    }
}

impl std::fmt::Display for PandocFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Pandoc {stage}: {msg}",
            stage = self.stage.tag(),
            msg = self.message
        )?;
        if let Some(code) = self.exit_code {
            write!(f, " (exit {code})")?;
        }
        if let Some(fmtname) = &self.format {
            write!(f, " [format={fmtname}]")?;
        }
        if !self.stderr_excerpt.is_empty() {
            write!(f, "\nstderr: {}", self.stderr_excerpt)?;
            if self.stderr_truncated {
                write!(f, " …(truncated)")?;
            }
        }
        Ok(())
    }
}

impl std::error::Error for PandocFailure {}

/// Maximum byte length of `stderr_excerpt`. Chosen to fit comfortably
/// in a modal dialog while still preserving multiple wrapped lines.
/// Exposed publicly so callers can budget UI space.
pub const STDERR_BUDGET: usize = 4096;

/// Default limit for a single Pandoc invocation. Long enough for large novel
/// exports, short enough to avoid an unbounded hung process from the UI.
pub const DEFAULT_PANDOC_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_PANDOC_FILE_OUTPUT_BYTES: u64 = 1024 * 1024 * 1024;

/// Version checks must be fast and must never leave Settings or Export startup
/// waiting on a stale executable indefinitely.
pub const PANDOC_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

const PROBE_STDOUT_BUDGET: usize = 16 * 1024;
const PROBE_ATTEMPT_BUDGET: usize = 512;
const ARGV_SUMMARY_MAX_ITEMS: usize = 32;
const ARGV_SUMMARY_ITEM_BUDGET: usize = 512;
const PIPE_SETTLE_TIMEOUT: Duration = Duration::from_secs(1);
const OUTPUT_TEMP_ATTEMPTS: usize = 32;
static OUTPUT_TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

// ---------------------------------------------------------------------------
// Argv redaction and stderr truncation
// ---------------------------------------------------------------------------

/// Flag-name substrings that indicate a value is likely a credential.
/// Matched case-insensitively against the portion before `=`.
const SECRET_FLAG_HINTS: &[&str] = &[
    "token",
    "password",
    "passwd",
    "pass",
    "secret",
    "key",
    "auth",
    "credential",
    "api-key",
    "apikey",
    "bearer",
];

/// Redact user-supplied argv entries that look like credentials.
///
/// Two forms are recognized:
///   - Inline `--flag=value`: value is replaced with `<redacted>`.
///   - Split `--flag value`: when `--flag`'s name hints at a secret,
///     the FOLLOWING argv slot is replaced with `<redacted>`, but only
///     if it does not itself start with `-` (which would mean the
///     secret value was omitted and the next token is another flag).
///
/// Positional args (no leading `-`) pass through untouched — the
/// `export_project` command boundary never accepts positional secrets.
pub fn redact_argv_summary(argv: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(argv.len().min(ARGV_SUMMARY_MAX_ITEMS));
    let mut i = 0;
    while i < argv.len() && out.len() < ARGV_SUMMARY_MAX_ITEMS {
        let arg = &argv[i];
        if !arg.starts_with('-') {
            out.push(arg.clone());
            i += 1;
            continue;
        }
        if let Some(eq_idx) = arg.find('=') {
            let (flag, _value) = arg.split_at(eq_idx);
            if flag_name_hints_secret(flag) {
                out.push(format!("{flag}=<redacted>"));
            } else {
                out.push(arg.clone());
            }
            i += 1;
            continue;
        }
        // Bare flag like `--token` or `-p`. If it hints at a secret AND
        // the next slot is a value (not another flag), redact the next
        // slot but keep the flag itself visible.
        if flag_name_hints_secret(arg) {
            out.push(arg.clone());
            i += 1;
            if let Some(next) = argv.get(i) {
                if !next.starts_with('-') {
                    out.push("<redacted>".to_string());
                    i += 1;
                }
            }
            continue;
        }
        out.push(arg.clone());
        i += 1;
    }
    out.into_iter()
        .take(ARGV_SUMMARY_MAX_ITEMS)
        .map(|arg| truncate_str(&arg, ARGV_SUMMARY_ITEM_BUDGET))
        .collect()
}

fn flag_name_hints_secret(flag_with_dashes: &str) -> bool {
    let name = flag_with_dashes
        .trim_start_matches('-')
        .to_ascii_lowercase();
    SECRET_FLAG_HINTS.iter().any(|hint| name.contains(hint))
}

/// Truncate `raw` (which may or may not be valid UTF-8) to at most
/// `budget` bytes, cutting on a UTF-8 code-point boundary so no CJK or
/// emoji is split. Invalid bytes are replaced with U+FFFD via
/// `String::from_utf8_lossy` before the cut.
///
/// Kept public for backwards compatibility; callers that want
/// credential redaction should compose [`sanitize_stderr`] first.
#[allow(dead_code)]
pub fn truncate_stderr(raw: &[u8], budget: usize) -> String {
    let s = String::from_utf8_lossy(raw);
    truncate_str(&s, budget)
}

/// UTF-8-boundary-safe truncation for an already-decoded string.
fn truncate_str(s: &str, budget: usize) -> String {
    if s.len() <= budget {
        return s.to_string();
    }
    let mut end = budget;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Small local sanitizer that removes credential-looking substrings
/// from Pandoc/filter stderr before it enters `PandocFailure`.
///
/// This is intentionally narrower than
/// `services::publish::types::redact_secrets` — importing that would
/// invert the dependency direction (pandoc is a lower layer than
/// publish) and pull in ~500 lines for a use case that only needs to
/// catch what Pandoc-driven filters and pandoc-crossref stderr can
/// print. Coverage:
///   - `Authorization: <scheme> <token>` header lines
///   - `Bearer`/`Ghost`/`Basic`/`Token` scheme prefixes
///   - `?token=…`, `&api_key=…`, `access_token=…`, `password=…`,
///     `secret=…` query/form params
///   - `"token": "…"`, `"api_key": "…"`, `"password": "…"`,
///     `"access_token": "…"`, `"secret": "…"` JSON string fields
pub fn sanitize_stderr(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for line in input.split_inclusive('\n') {
        out.push_str(&sanitize_authorization_line(line));
    }
    let out = redact_prefixed_token(&out, "Bearer ");
    let out = redact_prefixed_token(&out, "bearer ");
    let out = redact_prefixed_token(&out, "Ghost ");
    let out = redact_prefixed_token(&out, "Basic ");
    let out = redact_prefixed_token(&out, "Token ");
    let mut out = out;
    for key in SANITIZE_KV_KEYS {
        out = redact_kv_pair(&out, key);
    }
    for key in SANITIZE_JSON_KEYS {
        out = redact_json_value(&out, key);
    }
    out
}

const SANITIZE_KV_KEYS: &[&str] = &[
    "api_key",
    "apikey",
    "access_token",
    "app_password",
    "client_secret",
    "password",
    "secret_key",
    "secret",
    "token",
];

const SANITIZE_JSON_KEYS: &[&str] = &[
    "access_token",
    "api_key",
    "apikey",
    "app_password",
    "bearer",
    "client_secret",
    "password",
    "secret",
    "secret_key",
    "token",
];

/// If `line` starts (after optional whitespace) with a recognized
/// credential-carrying header name followed by `:`, redact everything
/// after the colon.
fn sanitize_authorization_line(line: &str) -> String {
    let colon = match line.find(':') {
        Some(idx) => idx,
        None => return line.to_string(),
    };
    let header = line[..colon].trim().to_ascii_lowercase();
    if !matches!(
        header.as_str(),
        "authorization" | "x-api-key" | "x-auth-token" | "cookie" | "set-cookie"
    ) {
        return line.to_string();
    }
    let (before, after) = line.split_at(colon + 1);
    let trim_end = after.trim_end_matches(['\r', '\n']);
    let trailing_len = after.len() - trim_end.len();
    let trailing = &after[trim_end.len()..];
    let leading_ws_len = trim_end
        .find(|c: char| !c.is_whitespace())
        .unwrap_or(trim_end.len());
    let leading = &trim_end[..leading_ws_len];
    // Only redact if there is actual non-whitespace content, else keep as-is.
    if leading_ws_len == trim_end.len() {
        return line.to_string();
    }
    let _ = trailing_len;
    let mut result = String::with_capacity(line.len());
    result.push_str(before);
    result.push_str(leading);
    result.push_str("<redacted>");
    result.push_str(trailing);
    result
}

fn redact_prefixed_token(s: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find(prefix) {
        out.push_str(&rest[..idx]);
        out.push_str(prefix);
        rest = &rest[idx + prefix.len()..];
        if let Some(quote) = rest.chars().next().filter(|c| matches!(c, '"' | '\'')) {
            out.push(quote);
            out.push_str("<redacted>");
            let after_quote = &rest[quote.len_utf8()..];
            rest = match after_quote.find(quote) {
                Some(end) => &after_quote[end..],
                None => "",
            };
            continue;
        }
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',' || c == ')')
            .unwrap_or(rest.len());
        if end == 0 {
            continue;
        }
        out.push_str("<redacted>");
        rest = &rest[end..];
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
        // Optional whitespace, then an assignment delimiter.
        let ws_end = after_key
            .find(|c: char| !c.is_whitespace())
            .unwrap_or(after_key.len());
        let after_ws = &after_key[ws_end..];
        if !after_ws.starts_with('=') && !after_ws.starts_with(':') {
            out.push_str(&rest[..idx + key.len()]);
            rest = &rest[idx + key.len()..];
            continue;
        }
        let after_equals = &after_ws[1..];
        let value_ws = after_equals
            .find(|c: char| !c.is_whitespace())
            .unwrap_or(after_equals.len());
        let value_area = &after_equals[value_ws..];
        let consumed_before_value = idx + key.len() + ws_end + 1 + value_ws;
        out.push_str(&rest[..consumed_before_value]);
        if let Some(quote) = value_area
            .chars()
            .next()
            .filter(|c| matches!(c, '"' | '\''))
        {
            out.push(quote);
            out.push_str("<redacted>");
            let after_quote = &value_area[quote.len_utf8()..];
            let value_end = after_quote.find(quote).unwrap_or(after_quote.len());
            rest = &after_quote[value_end..];
        } else {
            let value_end = value_area
                .find(|c: char| {
                    c.is_whitespace() || matches!(c, '&' | ';' | ',' | '}' | '/' | '\\')
                })
                .unwrap_or(value_area.len());
            out.push_str("<redacted>");
            rest = &value_area[value_end..];
        }
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
                b' ' | b'\t' | b'\n' | b'\r' | b'?' | b'&' | b';' | b',' | b'/' | b'\\'
            );
        if boundary_ok {
            return Some(abs);
        }
        start = abs + key.len();
    }
    None
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
        let ws1 = after_key
            .find(|c: char| !c.is_whitespace())
            .unwrap_or(after_key.len());
        let after_ws1 = &after_key[ws1..];
        if !after_ws1.starts_with(':') {
            out.push_str(&rest[..after_key_idx]);
            rest = after_key;
            continue;
        }
        let after_colon = &after_ws1[1..];
        let ws2 = after_colon
            .find(|c: char| !c.is_whitespace())
            .unwrap_or(after_colon.len());
        let val_area = &after_colon[ws2..];
        if !val_area.starts_with('"') {
            let head_len = after_key_idx + ws1 + 1 + ws2;
            out.push_str(&rest[..head_len]);
            rest = val_area;
            continue;
        }
        let bytes = val_area.as_bytes();
        let mut i = 1;
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
        let head_len = after_key_idx + ws1 + 1 + ws2 + 1;
        out.push_str(&rest[..head_len]);
        out.push_str("<redacted>");
        rest = &rest[head_len + (i - 1)..];
    }
    out
}

// ---------------------------------------------------------------------------
// Injectable discovery — testable without a real Pandoc install
// ---------------------------------------------------------------------------

/// Common locations to probe when pandoc isn't on `$PATH`. Order
/// matters: Apple Silicon Homebrew first, then Intel Homebrew, then
/// system, then platform-typical Windows/Linux locations.
pub fn common_paths() -> Vec<PathBuf> {
    let mut v = Vec::with_capacity(8);
    #[cfg(target_os = "macos")]
    {
        v.push(PathBuf::from("/opt/homebrew/bin/pandoc"));
        v.push(PathBuf::from("/usr/local/bin/pandoc"));
        v.push(PathBuf::from("/usr/bin/pandoc"));
    }
    #[cfg(target_os = "linux")]
    {
        v.push(PathBuf::from("/usr/bin/pandoc"));
        v.push(PathBuf::from("/usr/local/bin/pandoc"));
        v.push(PathBuf::from("/snap/bin/pandoc"));
    }
    #[cfg(target_os = "windows")]
    {
        v.push(PathBuf::from(r"C:\Program Files\Pandoc\pandoc.exe"));
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            v.push(PathBuf::from(format!(r"{local}\Pandoc\pandoc.exe")));
        }
    }
    v
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PandocProbe {
    pub resolved_binary: String,
    pub version: String,
}

/// Real bounded `--version` probe. The candidate is resolved before spawn so
/// callers receive the executable path that was actually passed to the OS.
pub async fn probe(bin: &str) -> Option<PandocProbe> {
    probe_with_timeout(bin, PANDOC_PROBE_TIMEOUT).await
}

async fn probe_with_timeout(bin: &str, timeout: Duration) -> Option<PandocProbe> {
    let started = Instant::now();
    let bin = bin.to_string();
    let resolved = run_blocking_with_timeout(timeout, move || resolve_executable(&bin)).await??;
    let remaining = timeout.checked_sub(started.elapsed())?;
    let resolved_text = resolved.to_string_lossy().to_string();
    let mut command = Command::new(&resolved);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    isolate_process_group(&mut command);
    let mut child = command.spawn().ok()?;
    let process_tree = match ProcessTreeGuard::attach(&child) {
        Ok(process_tree) => process_tree,
        Err(_) => {
            let cleanup_errors = kill_unattached_child(&mut child).await;
            if !cleanup_errors.is_empty() {
                tracing::warn!(target: "novelist::pandoc", errors = ?cleanup_errors, "Pandoc probe isolation cleanup failed");
            }
            return None;
        }
    };
    let output = wait_with_timeout_and_cancel(
        child,
        process_tree,
        remaining,
        None,
        PROBE_STDOUT_BUDGET,
        0,
        None,
    )
    .await
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout);
    let version = version.lines().next()?.trim();
    if !is_pandoc_version_line(version) {
        return None;
    }
    Some(PandocProbe {
        resolved_binary: resolved_text,
        version: version.to_string(),
    })
}

async fn run_blocking_with_timeout<T, F>(timeout: Duration, task: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::time::timeout(timeout, tokio::task::spawn_blocking(task))
        .await
        .ok()?
        .ok()
}

fn is_pandoc_version_line(line: &str) -> bool {
    let Some(version) = line.strip_prefix("pandoc ") else {
        return false;
    };
    !version.is_empty()
        && version
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_digit())
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+' | b'_'))
}

fn resolve_executable(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH");
    resolve_executable_with_path(bin, path.as_deref())
}

fn resolve_executable_with_path(bin: &str, path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    let candidate = Path::new(bin);
    if candidate.components().count() > 1 {
        return executable_variants(candidate)
            .into_iter()
            .find_map(absolute_executable);
    }

    std::env::split_paths(path?)
        .flat_map(|dir| executable_variants(&dir.join(candidate)))
        .find_map(absolute_executable)
}

#[cfg(not(windows))]
fn executable_variants(path: &Path) -> Vec<PathBuf> {
    vec![path.to_path_buf()]
}

#[cfg(windows)]
fn executable_variants(path: &Path) -> Vec<PathBuf> {
    if path.extension().is_some() {
        return is_native_windows_executable(path)
            .then(|| path.to_path_buf())
            .into_iter()
            .collect();
    }
    let extensions = std::env::var_os("PATHEXT")
        .and_then(|value| value.into_string().ok())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
    extensions
        .split(';')
        .filter(|extension| !extension.is_empty())
        .map(|extension| path.with_extension(extension.trim_start_matches('.')))
        .filter(|candidate| is_native_windows_executable(candidate))
        .collect()
}

#[cfg(windows)]
fn is_native_windows_executable(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("com")
        })
}

fn absolute_executable(path: PathBuf) -> Option<PathBuf> {
    if !is_executable(&path) {
        return None;
    }
    if path.is_absolute() {
        Some(path)
    } else {
        std::env::current_dir().ok().map(|cwd| cwd.join(path))
    }
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Resolve using an injected async probe closure. This is the
/// deterministic core the tests exercise. Production code calls the
/// convenience wrapper [`resolve_pandoc`] which passes the real probe.
///
/// The resolution order is stable and observable:
///   1. `override_path` (if non-empty, trimmed)
///   2. bare `pandoc` (looked up via `$PATH` by the OS)
///   3. every entry in `probe_list` in order
///
/// Any candidate that returns `None` from the probe is skipped.
pub async fn resolve_with<F, Fut>(
    override_path: Option<&str>,
    probe_list: &[PathBuf],
    mut probe_fn: F,
) -> Result<(String, String), PandocFailure>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Option<PandocProbe>>,
{
    let mut probed: Vec<String> = Vec::new();

    if let Some(p) = override_path {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            probed.push(redact_probe_attempt(trimmed));
            if let Some(probe) = probe_fn(trimmed.to_string()).await {
                return Ok((probe.resolved_binary, probe.version));
            }
        }
    }

    probed.push("pandoc".to_string());
    if let Some(probe) = probe_fn("pandoc".to_string()).await {
        return Ok((probe.resolved_binary, probe.version));
    }

    for candidate in probe_list {
        let s = candidate.to_string_lossy().to_string();
        probed.push(redact_probe_attempt(&s));
        if let Some(probe) = probe_fn(s.clone()).await {
            return Ok((probe.resolved_binary, probe.version));
        }
    }

    Err(PandocFailure::new(
        PandocStage::Discovery,
        "Pandoc not found. Install Pandoc from https://pandoc.org/installing.html or set the binary path in Settings → Editor → Pandoc.",
    )
    .with_probed_paths(probed))
}

fn redact_probe_attempt(attempt: &str) -> String {
    truncate_str(&sanitize_stderr(attempt), PROBE_ATTEMPT_BUDGET)
}

/// Resolve the pandoc binary using the real `--version` probe.
///
/// Backwards-compatible signature — returns `Option<(path, version)>`
/// so existing callers (`check_pandoc`, publish adapters) do not need
/// to change. Structured failures are available via [`resolve_with`].
pub async fn resolve_pandoc(override_path: Option<&str>) -> Option<(String, String)> {
    let probe_list = common_paths();
    resolve_with(override_path, &probe_list, |bin| async move {
        probe(&bin).await
    })
    .await
    .ok()
}

/// Backwards-compatible: detect pandoc using the auto-discovery path
/// only (no override). Returns the version line on success.
#[allow(dead_code)]
pub async fn detect_pandoc() -> Option<String> {
    resolve_pandoc(None).await.map(|(_, v)| v)
}

/// Convenience: read the override from global settings and resolve.
pub async fn resolve_with_settings() -> Option<(String, String)> {
    let g = crate::commands::settings::read_global_settings().await;
    resolve_pandoc(g.pandoc_path.as_deref()).await
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Build the argv (excluding `input_path` and the output path) for a
/// given format. Extracted so tests can pin the exact args per format.
pub fn format_args(format: &str) -> Vec<String> {
    let mut args = vec![
        "-f".into(),
        "markdown-yaml_metadata_block-raw_tex-raw_attribute-raw_html".into(),
    ];
    match format {
        "html" => args.extend([
            "-t".into(),
            "html5".into(),
            "--standalone".into(),
            "--embed-resources".into(),
        ]),
        "pdf" => {}
        "docx" => args.extend(["-t".into(), "docx".into()]),
        "epub" => args.extend(["-t".into(), "epub".into()]),
        other => args.extend(["-t".into(), other.into()]),
    }
    args
}

/// Structured execution primitive. Runs Pandoc and returns either the
/// success message or a fully-populated [`PandocFailure`].
///
/// Applies the default 120-second timeout. Call
/// [`run_pandoc_structured_with_cancel`] when a UI cancellation channel is
/// available.
#[allow(dead_code)]
pub async fn run_pandoc_structured(
    bin: &str,
    input_path: &Path,
    output_path: &Path,
    format: &str,
    extra_args: &[String],
) -> Result<String, PandocFailure> {
    run_pandoc_structured_with_timeout(
        bin,
        input_path,
        output_path,
        format,
        extra_args,
        DEFAULT_PANDOC_TIMEOUT,
    )
    .await
}

pub async fn run_pandoc_structured_with_timeout(
    bin: &str,
    input_path: &Path,
    output_path: &Path,
    format: &str,
    extra_args: &[String],
    timeout: Duration,
) -> Result<String, PandocFailure> {
    run_pandoc_structured_with_cancel(
        bin,
        input_path,
        output_path,
        format,
        extra_args,
        timeout,
        None,
    )
    .await
}

pub async fn run_pandoc_structured_with_cancel(
    bin: &str,
    input_path: &Path,
    output_path: &Path,
    format: &str,
    extra_args: &[String],
    timeout: Duration,
    cancel: Option<watch::Receiver<bool>>,
) -> Result<String, PandocFailure> {
    let success = run_pandoc_structured_with_cancel_detailed(
        bin,
        input_path,
        output_path,
        format,
        extra_args,
        PandocRunControl {
            timeout,
            cancel,
            commit_gate: None,
        },
    )
    .await?;
    if let Some(warning) = success.warning.as_ref() {
        tracing::warn!(target: "novelist::pandoc", stage = warning.stage.tag(), message = %warning.message, "Pandoc process cleanup warning");
    }
    Ok(success.message)
}

#[derive(Debug)]
pub(crate) struct PandocRunSuccess {
    pub message: String,
    pub warning: Option<PandocFailure>,
}

#[derive(Default)]
pub(crate) struct CommitGate(std::sync::Mutex<CommitGateState>);

pub(crate) struct PandocRunControl {
    pub timeout: Duration,
    pub cancel: Option<watch::Receiver<bool>>,
    pub commit_gate: Option<std::sync::Arc<CommitGate>>,
}

#[derive(Default)]
enum CommitGateState {
    #[default]
    Running,
    Cancelled,
    Committing,
}

impl CommitGate {
    pub(crate) fn cancel(&self) -> bool {
        let Ok(mut state) = self.0.lock() else {
            return false;
        };
        if matches!(*state, CommitGateState::Running) {
            *state = CommitGateState::Cancelled;
            true
        } else {
            false
        }
    }

    pub(crate) fn begin_commit(&self) -> bool {
        let Ok(mut state) = self.0.lock() else {
            return false;
        };
        if matches!(*state, CommitGateState::Running) {
            *state = CommitGateState::Committing;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
type BeforeOutputCommitHook = Box<dyn FnOnce() + Send>;
#[cfg(test)]
static BEFORE_OUTPUT_COMMIT_HOOK: std::sync::Mutex<Option<BeforeOutputCommitHook>> =
    std::sync::Mutex::new(None);

#[cfg(test)]
fn run_before_output_commit_hook() {
    if let Some(hook) = BEFORE_OUTPUT_COMMIT_HOOK.lock().unwrap().take() {
        hook();
    }
}

pub(crate) async fn run_pandoc_structured_with_cancel_detailed(
    bin: &str,
    input_path: &Path,
    output_path: &Path,
    format: &str,
    extra_args: &[String],
    control: PandocRunControl,
) -> Result<PandocRunSuccess, PandocFailure> {
    let commit_cancel = control.cancel.clone();
    let temp_output = allocate_sibling_output(output_path)
        .await
        .map_err(|error| {
            PandocFailure::new(
                PandocStage::OutputCommit,
                format!("failed to allocate temporary export output: {error}"),
            )
            .with_binary(bin.to_string())
            .with_format(format.to_string())
            .with_source_path(input_path.to_string_lossy().to_string())
        })?;

    let process_warning = match run_pandoc_to_output(
        bin,
        input_path,
        PandocOutputPaths {
            diagnostic: output_path,
            process: &temp_output.path,
            limit: MAX_PANDOC_FILE_OUTPUT_BYTES,
        },
        format,
        extra_args,
        control.timeout,
        control.cancel,
    )
    .await
    {
        Ok(warning) => warning,
        Err(mut failure) => {
            append_cleanup_error(
                &mut failure,
                cleanup_sibling_output(&temp_output).await.err(),
                "temporary output",
            );
            return Err(failure);
        }
    };

    #[cfg(test)]
    run_before_output_commit_hook();
    let commit_allowed = control.commit_gate.as_ref().map_or_else(
        || {
            !commit_cancel
                .as_ref()
                .is_some_and(|cancel| *cancel.borrow())
        },
        |gate| gate.begin_commit(),
    );
    if !commit_allowed {
        let mut failure = PandocFailure::new(
            PandocStage::TimeoutOrCancel,
            "Pandoc export was cancelled before output commit.",
        )
        .with_binary(bin.to_string())
        .with_format(format.to_string())
        .with_source_path(input_path.to_string_lossy().to_string());
        append_cleanup_error(
            &mut failure,
            cleanup_sibling_output(&temp_output).await.err(),
            "cancelled temporary output",
        );
        return Err(failure);
    }
    if let Err(error) = commit_sibling_output(&temp_output.path, output_path).await {
        let mut failure = PandocFailure::new(
            PandocStage::OutputCommit,
            format!("failed to commit completed export: {error}"),
        )
        .with_binary(bin.to_string())
        .with_format(format.to_string())
        .with_source_path(input_path.to_string_lossy().to_string());
        append_cleanup_error(
            &mut failure,
            cleanup_sibling_output(&temp_output).await.err(),
            "temporary output after commit failure",
        );
        return Err(failure);
    }
    let mut warning = process_warning;
    if let Err(error) = remove_directory_if_exists(&temp_output.directory).await {
        let cleanup = PandocFailure::new(
            PandocStage::Cleanup,
            format!("failed to remove private temporary output directory: {error}"),
        )
        .with_binary(bin.to_string())
        .with_format(format.to_string())
        .with_source_path(input_path.to_string_lossy().to_string());
        warning = Some(match warning {
            Some(mut existing) => {
                existing.message.push(' ');
                existing.message.push_str(&cleanup.message);
                existing
            }
            None => cleanup,
        });
    }
    Ok(PandocRunSuccess {
        message: format!("Export complete: {}", output_path.display()),
        warning,
    })
}

fn append_cleanup_error(
    failure: &mut PandocFailure,
    cleanup_error: Option<std::io::Error>,
    resource: &str,
) {
    if let Some(cleanup_error) = cleanup_error {
        failure.message.push_str(&format!(
            " Cleanup also failed for {resource}: {cleanup_error}"
        ));
    }
}

async fn remove_file_if_exists(path: &Path) -> Result<(), std::io::Error> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

async fn remove_directory_if_exists(path: &Path) -> Result<(), std::io::Error> {
    match tokio::fs::remove_dir(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

async fn cleanup_sibling_output(output: &SiblingOutput) -> Result<(), std::io::Error> {
    let file_error = remove_file_if_exists(&output.path).await.err();
    let directory_error = remove_directory_if_exists(&output.directory).await.err();
    match (file_error, directory_error) {
        (Some(file), Some(directory)) => Err(std::io::Error::other(format!(
            "file cleanup failed: {file}; directory cleanup failed: {directory}"
        ))),
        (Some(error), None) | (None, Some(error)) => Err(error),
        (None, None) => Ok(()),
    }
}

struct PandocOutputPaths<'a> {
    diagnostic: &'a Path,
    process: &'a Path,
    limit: u64,
}

async fn run_pandoc_to_output(
    bin: &str,
    input_path: &Path,
    output_paths: PandocOutputPaths<'_>,
    format: &str,
    extra_args: &[String],
    timeout: Duration,
    cancel: Option<watch::Receiver<bool>>,
) -> Result<Option<PandocFailure>, PandocFailure> {
    let mut argv: Vec<String> = Vec::new();
    argv.push(input_path.to_string_lossy().to_string());
    argv.push("-o".into());
    argv.push(output_paths.diagnostic.to_string_lossy().to_string());
    argv.extend(format_args(format));
    argv.extend(extra_args.iter().cloned());
    let sanitized = redact_argv_summary(&argv);

    let mut cmd = Command::new(bin);
    cmd.arg(input_path);
    cmd.arg("-o").arg(output_paths.process);
    for a in format_args(format) {
        cmd.arg(a);
    }
    for a in extra_args {
        cmd.arg(a);
    }
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    isolate_process_group(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Err(PandocFailure::new(
                PandocStage::Spawn,
                format!("failed to spawn Pandoc: {e}"),
            )
            .with_binary(bin.to_string())
            .with_format(format.to_string())
            .with_argv_summary(sanitized)
            .with_source_path(input_path.to_string_lossy().to_string()));
        }
    };
    let process_tree = match ProcessTreeGuard::attach(&child) {
        Ok(process_tree) => process_tree,
        Err(error) => {
            let cleanup_errors = kill_unattached_child(&mut child).await;
            let cleanup_detail = if cleanup_errors.is_empty() {
                String::new()
            } else {
                format!(" Cleanup also failed: {}", cleanup_errors.join("; "))
            };
            return Err(PandocFailure::new(
                PandocStage::Spawn,
                format!("failed to isolate Pandoc process tree: {error}.{cleanup_detail}"),
            )
            .with_binary(bin.to_string())
            .with_format(format.to_string())
            .with_argv_summary(sanitized)
            .with_source_path(input_path.to_string_lossy().to_string()));
        }
    };

    let output = match wait_with_timeout_and_cancel(
        child,
        process_tree,
        timeout,
        cancel,
        0,
        STDERR_BUDGET.saturating_add(1),
        Some(OutputMonitor {
            path: output_paths.process,
            limit: output_paths.limit,
        }),
    )
    .await
    {
        Ok(o) => o,
        Err(mut e) => {
            e.resolved_binary = Some(bin.to_string());
            e.format = Some(format.to_string());
            e.argv_summary = sanitized;
            e.source_path = Some(input_path.to_string_lossy().to_string());
            return Err(e);
        }
    };

    if output.status.success() {
        return Ok(output.cleanup_warning.map(|failure| {
            failure
                .with_binary(bin.to_string())
                .with_format(format.to_string())
                .with_argv_summary(sanitized.clone())
                .with_source_path(input_path.to_string_lossy().to_string())
        }));
    }

    let code = output.status.code();
    let mut failure = PandocFailure::new(
        PandocStage::ExitNonZero,
        "Pandoc exited with a non-zero status.",
    );
    if let Some(cleanup_warning) = output.cleanup_warning {
        failure
            .message
            .push_str(&format!(" Cleanup warning: {}", cleanup_warning.message));
    }
    Err(failure
        .with_binary(bin.to_string())
        .with_format(format.to_string())
        .with_argv_summary(sanitized)
        .with_exit_code(code)
        .with_stderr(&output.stderr)
        .with_source_path(input_path.to_string_lossy().to_string()))
}

struct SiblingOutput {
    directory: PathBuf,
    path: PathBuf,
}

async fn allocate_sibling_output(output_path: &Path) -> Result<SiblingOutput, std::io::Error> {
    let output_path = output_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        use std::io::ErrorKind;

        let parent = output_path.parent().unwrap_or_else(|| Path::new("."));
        let file_name = output_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                std::io::Error::new(ErrorKind::InvalidInput, "output has no file name")
            })?;
        let extension = output_path
            .extension()
            .and_then(|extension| extension.to_str());
        let mut last_collision = None;
        for _ in 0..OUTPUT_TEMP_ATTEMPTS {
            let sequence = OUTPUT_TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let directory = parent.join(format!(
                ".{file_name}.novelist-export-{}-{sequence}",
                std::process::id()
            ));
            match create_private_output_directory(&directory) {
                Ok(()) => {
                    let output_name = extension
                        .map(|extension| format!("output.{extension}"))
                        .unwrap_or_else(|| "output.tmp".to_string());
                    let path = directory.join(output_name);
                    if let Err(error) = create_private_output_file(&path) {
                        return Err(allocation_error_with_cleanup(
                            error,
                            std::fs::remove_dir(&directory),
                        ));
                    }
                    return Ok(SiblingOutput { directory, path });
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    last_collision = Some(error);
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_collision.unwrap_or_else(|| {
            std::io::Error::new(ErrorKind::AlreadyExists, "temporary output names exhausted")
        }))
    })
    .await
    .map_err(std::io::Error::other)?
}

fn allocation_error_with_cleanup(
    allocation: std::io::Error,
    cleanup: Result<(), std::io::Error>,
) -> std::io::Error {
    match cleanup {
        Ok(()) => allocation,
        Err(cleanup) => std::io::Error::new(
            allocation.kind(),
            format!("{allocation}; temporary directory cleanup also failed: {cleanup}"),
        ),
    }
}

fn create_private_output_directory(path: &Path) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700).create(path)
    }
    #[cfg(windows)]
    {
        create_owner_only_directory(path)
    }
    #[cfg(not(any(unix, windows)))]
    {
        std::fs::create_dir(path)
    }
}

fn create_private_output_file(path: &Path) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map(drop)
    }
    #[cfg(windows)]
    {
        create_owner_only_file(path).map(drop)
    }
    #[cfg(not(any(unix, windows)))]
    {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map(drop)
    }
}

async fn commit_sibling_output(temp_path: &Path, output_path: &Path) -> Result<(), std::io::Error> {
    let temp_path = temp_path.to_path_buf();
    let output_path = output_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        (|| {
            // FlushFileBuffers requires a write-capable handle on Windows.
            let file = std::fs::OpenOptions::new().write(true).open(&temp_path)?;
            file.sync_all()?;
            drop(file);
            replace_sibling_output(&temp_path, &output_path)
        })()
    })
    .await
    .map_err(std::io::Error::other)?
}

fn replace_sibling_output(temp_path: &Path, output_path: &Path) -> Result<(), std::io::Error> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            REPLACEFILE_WRITE_THROUGH,
        };

        let temp = temp_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let output = output_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let replace_error = if output_path.exists() {
            let replaced = unsafe {
                ReplaceFileW(
                    output.as_ptr(),
                    temp.as_ptr(),
                    std::ptr::null(),
                    REPLACEFILE_WRITE_THROUGH,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            };
            if replaced != 0 {
                return Ok(());
            }
            Some(std::io::Error::last_os_error())
        } else {
            None
        };
        // ReplaceFileW can reject otherwise replaceable files because of
        // inherited ACL metadata. MoveFileExW provides the same same-volume
        // replace operation and is the required fallback for that case.
        let moved = unsafe {
            MoveFileExW(
                temp.as_ptr(),
                output.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            let move_error = std::io::Error::last_os_error();
            if let Some(replace_error) = replace_error {
                return Err(std::io::Error::new(
                    move_error.kind(),
                    format!(
                        "ReplaceFileW failed: {replace_error}; MoveFileExW failed: {move_error}"
                    ),
                ));
            }
            return Err(move_error);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(temp_path, output_path)
    }
}

#[cfg(windows)]
struct LocalSecurityDescriptor(windows_sys::Win32::Security::PSECURITY_DESCRIPTOR);

#[cfg(windows)]
impl Drop for LocalSecurityDescriptor {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::LocalFree(self.0.cast());
        }
    }
}

#[cfg(windows)]
fn owner_only_security_descriptor(
    inheritable: bool,
) -> Result<LocalSecurityDescriptor, std::io::Error> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };

    let sddl = if inheritable {
        "D:P(A;OICI;FA;;;OW)"
    } else {
        "D:P(A;;FA;;;OW)"
    };
    let wide = std::ffi::OsStr::new(sddl)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut descriptor = std::ptr::null_mut();
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    };
    if converted == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(LocalSecurityDescriptor(descriptor))
}

#[cfg(windows)]
pub(crate) fn create_owner_only_file(path: &Path) -> Result<std::fs::File, std::io::Error> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    };

    let descriptor = owner_only_security_descriptor(false)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0.cast(),
        bInheritHandle: 0,
    };
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            0,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    Ok(unsafe { std::fs::File::from_raw_handle(handle as RawHandle) })
}

#[cfg(windows)]
pub(crate) fn create_owner_only_directory(path: &Path) -> Result<(), std::io::Error> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;

    let descriptor = owner_only_security_descriptor(true)?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0.cast(),
        bInheritHandle: 0,
    };
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    if unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

pub struct PandocProcessOutput {
    pub status: std::process::ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub cleanup_warning: Option<PandocFailure>,
}

pub(crate) struct PipedPandocOutput {
    pub status: std::process::ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub cleanup_warning: Option<PandocFailure>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PipedPandocFailure {
    NotFound,
    Spawn,
    Wait,
    Write,
    Timeout,
    OutputOverflow,
    RetainedPipes,
}

pub(crate) async fn run_piped_pandoc(
    binary: &str,
    args: &[&str],
    input: Option<&[u8]>,
    stdout_limit: usize,
    stderr_limit: usize,
    timeout: Duration,
) -> Result<PipedPandocOutput, PipedPandocFailure> {
    use tokio::io::AsyncWriteExt;

    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    isolate_process_group(&mut command);
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            PipedPandocFailure::NotFound
        } else {
            PipedPandocFailure::Spawn
        }
    })?;
    let process_tree = match ProcessTreeGuard::attach(&child) {
        Ok(process_tree) => process_tree,
        Err(_) => {
            let cleanup_errors = kill_unattached_child(&mut child).await;
            if !cleanup_errors.is_empty() {
                tracing::warn!(target: "novelist::pandoc", errors = ?cleanup_errors, "Piped Pandoc isolation cleanup failed");
            }
            return Err(PipedPandocFailure::Spawn);
        }
    };

    let stdin_task = match (input, child.stdin.take()) {
        (Some(bytes), Some(mut stdin)) => {
            let bytes = bytes.to_vec();
            Some(tokio::spawn(async move {
                stdin
                    .write_all(&bytes)
                    .await
                    .map_err(|_| PipedPandocFailure::Write)?;
                stdin
                    .shutdown()
                    .await
                    .map_err(|_| PipedPandocFailure::Write)
            }))
        }
        _ => None,
    };
    let stdout = child.stdout.take().ok_or(PipedPandocFailure::Spawn)?;
    let stderr = child.stderr.take().ok_or(PipedPandocFailure::Spawn)?;
    let stdout_task = tokio::spawn(drain_limited_pipe(stdout, stdout_limit));
    let stderr_task = tokio::spawn(drain_limited_pipe(stderr, stderr_limit));

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            let cleanup_errors = terminate_and_reap(&mut child, &process_tree).await.1;
            if !cleanup_errors.is_empty() {
                tracing::warn!(target: "novelist::pandoc", errors = ?cleanup_errors, "Pandoc wait cleanup failed");
            }
            return Err(PipedPandocFailure::Wait);
        }
        Err(_) => {
            let cleanup_errors = terminate_and_reap(&mut child, &process_tree).await.1;
            if !cleanup_errors.is_empty() {
                tracing::warn!(target: "novelist::pandoc", errors = ?cleanup_errors, "Pandoc timeout cleanup failed");
            }
            return Err(PipedPandocFailure::Timeout);
        }
    };

    let retained_pipes = !wait_for_piped_tasks(&stdin_task, &stdout_task, &stderr_task).await;
    let mut cleanup_warning = None;
    if retained_pipes {
        process_tree
            .terminate()
            .map_err(|_| PipedPandocFailure::RetainedPipes)?;
        if !wait_for_piped_tasks(&stdin_task, &stdout_task, &stderr_task).await {
            return Err(PipedPandocFailure::RetainedPipes);
        }
        tracing::warn!(target: "novelist::pandoc", "Pandoc descendant retained output pipes and was terminated");
        cleanup_warning = Some(
            PandocFailure::new(
                PandocStage::Cleanup,
                "Pandoc descendants retained output pipes and were terminated.",
            )
            .with_binary(binary.to_string()),
        );
    }
    let (stdin_result, stdout, stderr) =
        collect_piped_tasks(stdin_task, stdout_task, stderr_task).await?;
    if let Err(error) = process_tree.terminate() {
        cleanup_warning = Some(
            PandocFailure::new(
                PandocStage::Cleanup,
                format!("Pandoc output completed, but final process-tree cleanup failed: {error}"),
            )
            .with_binary(binary.to_string()),
        );
    }
    if status.success() {
        stdin_result?;
    }
    if stdout.overflowed {
        return Err(PipedPandocFailure::OutputOverflow);
    }
    Ok(PipedPandocOutput {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        cleanup_warning,
    })
}

async fn wait_for_piped_tasks(
    stdin: &Option<tokio::task::JoinHandle<Result<(), PipedPandocFailure>>>,
    stdout: &tokio::task::JoinHandle<LimitedPipeOutput>,
    stderr: &tokio::task::JoinHandle<LimitedPipeOutput>,
) -> bool {
    tokio::time::timeout(PIPE_SETTLE_TIMEOUT, async {
        loop {
            if stdin
                .as_ref()
                .is_none_or(tokio::task::JoinHandle::is_finished)
                && stdout.is_finished()
                && stderr.is_finished()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .is_ok()
}

async fn collect_piped_tasks(
    stdin: Option<tokio::task::JoinHandle<Result<(), PipedPandocFailure>>>,
    stdout: tokio::task::JoinHandle<LimitedPipeOutput>,
    stderr: tokio::task::JoinHandle<LimitedPipeOutput>,
) -> Result<
    (
        Result<(), PipedPandocFailure>,
        LimitedPipeOutput,
        LimitedPipeOutput,
    ),
    PipedPandocFailure,
> {
    let stdin_result = match stdin {
        Some(task) => task.await.map_err(|_| PipedPandocFailure::Write)?,
        None => Ok(()),
    };
    let stdout = stdout.await.map_err(|_| PipedPandocFailure::Wait)?;
    let stderr = stderr.await.map_err(|_| PipedPandocFailure::Wait)?;
    Ok((stdin_result, stdout, stderr))
}

struct LimitedPipeOutput {
    bytes: Vec<u8>,
    overflowed: bool,
}

async fn drain_limited_pipe<R>(mut pipe: R, limit: usize) -> LimitedPipeOutput
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut total = 0usize;
    let mut chunk = [0u8; 8192];
    loop {
        let read = match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        total = total.saturating_add(read);
        let remaining = limit.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..read.min(remaining)]);
    }
    LimitedPipeOutput {
        bytes,
        overflowed: total > limit,
    }
}

async fn wait_with_timeout_and_cancel(
    mut child: tokio::process::Child,
    process_tree: ProcessTreeGuard,
    timeout: Duration,
    cancel: Option<watch::Receiver<bool>>,
    stdout_budget: usize,
    stderr_budget: usize,
    output_monitor: Option<OutputMonitor<'_>>,
) -> Result<PandocProcessOutput, PandocFailure> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        match stdout {
            Some(stdout) => drain_bounded_pipe(stdout, stdout_budget).await,
            None => Vec::new(),
        }
    });
    let stderr_task = tokio::spawn(async move {
        match stderr {
            Some(stderr) => drain_bounded_pipe(stderr, stderr_budget).await,
            None => Vec::new(),
        }
    });

    let status = match wait_status_or_abort(&mut child, timeout, cancel, output_monitor).await {
        Ok(status) => status,
        Err(mut failure) => {
            let (reaped, cleanup_errors) = terminate_and_reap(&mut child, &process_tree).await;
            if let Some(status) = reaped {
                failure.exit_code = status.code();
            }
            if !cleanup_errors.is_empty() {
                failure.message.push_str(&format!(
                    " Process cleanup also failed: {}",
                    cleanup_errors.join("; ")
                ));
            }
            let (_, stderr) = if wait_for_pipe_tasks(&stdout_task, &stderr_task).await {
                settle_pipe_tasks(stdout_task, stderr_task).await
            } else {
                (Vec::new(), Vec::new())
            };
            failure = failure.with_stderr(&stderr);
            return Err(failure);
        }
    };
    if output_monitor.is_some_and(output_limit_exceeded) {
        let (reaped, cleanup_errors) = terminate_and_reap(&mut child, &process_tree).await;
        let mut failure = PandocFailure::new(
            PandocStage::OutputCommit,
            "Pandoc output exceeded the 1 GiB limit.",
        );
        failure.exit_code = reaped.and_then(|status| status.code()).or(status.code());
        if !cleanup_errors.is_empty() {
            failure.message.push_str(&format!(
                " Process cleanup also failed: {}",
                cleanup_errors.join("; ")
            ));
        }
        return Err(failure);
    }

    let retained_pipes = !wait_for_pipe_tasks(&stdout_task, &stderr_task).await;
    let cleanup_warning = if retained_pipes {
        process_tree.terminate().map_err(|error| {
            PandocFailure::new(
                PandocStage::Cleanup,
                format!(
                    "Pandoc exited with retained output pipes, but its process tree could not be terminated: {error}"
                ),
            )
            .with_exit_code(status.code())
        })?;
        if !wait_for_pipe_tasks(&stdout_task, &stderr_task).await {
            return Err(PandocFailure::new(
                PandocStage::Cleanup,
                "Pandoc descendants retained output pipes after process-tree termination.",
            )
            .with_exit_code(status.code()));
        }
        Some(
            PandocFailure::new(
                PandocStage::Cleanup,
                "Pandoc exited but a descendant retained its output pipes; the process tree was terminated.",
            )
            .with_exit_code(status.code()),
        )
    } else {
        process_tree.terminate().err().map(|error| {
            PandocFailure::new(
                PandocStage::Cleanup,
                format!("failed to terminate remaining Pandoc descendants: {error}"),
            )
            .with_exit_code(status.code())
        })
    };
    let (stdout, stderr) = settle_pipe_tasks(stdout_task, stderr_task).await;
    Ok(PandocProcessOutput {
        status,
        stdout,
        stderr,
        cleanup_warning,
    })
}

async fn settle_pipe_tasks(
    stdout_task: tokio::task::JoinHandle<Vec<u8>>,
    stderr_task: tokio::task::JoinHandle<Vec<u8>>,
) -> (Vec<u8>, Vec<u8>) {
    let (stdout, stderr) = tokio::join!(stdout_task, stderr_task);
    (stdout.unwrap_or_default(), stderr.unwrap_or_default())
}

async fn wait_for_pipe_tasks(
    stdout: &tokio::task::JoinHandle<Vec<u8>>,
    stderr: &tokio::task::JoinHandle<Vec<u8>>,
) -> bool {
    tokio::time::timeout(PIPE_SETTLE_TIMEOUT, async {
        loop {
            if stdout.is_finished() && stderr.is_finished() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .is_ok()
}

async fn terminate_and_reap(
    child: &mut tokio::process::Child,
    process_tree: &ProcessTreeGuard,
) -> (Option<std::process::ExitStatus>, Vec<String>) {
    let mut errors = Vec::new();
    if let Err(error) = process_tree.terminate() {
        errors.push(format!("process-tree termination failed: {error}"));
        if let Err(error) = child.start_kill() {
            errors.push(format!("direct-child kill failed: {error}"));
        }
    }
    let reaped = match tokio::time::timeout(PIPE_SETTLE_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => Some(status),
        Ok(Err(error)) => {
            errors.push(format!("direct-child reap failed: {error}"));
            None
        }
        Err(_) => {
            errors.push("direct-child reap timed out".to_string());
            None
        }
    };
    (reaped, errors)
}

async fn kill_unattached_child(child: &mut tokio::process::Child) -> Vec<String> {
    let mut errors = Vec::new();
    if let Err(error) = child.start_kill() {
        errors.push(format!("direct-child kill failed: {error}"));
    }
    match tokio::time::timeout(PIPE_SETTLE_TIMEOUT, child.wait()).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => errors.push(format!("direct-child reap failed: {error}")),
        Err(_) => errors.push("direct-child reap timed out".to_string()),
    }
    errors
}

fn isolate_process_group(_command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        _command.as_std_mut().process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;
        _command.as_std_mut().creation_flags(CREATE_SUSPENDED);
    }
}

struct ProcessTreeGuard {
    #[cfg(unix)]
    process_id: Option<u32>,
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}

impl ProcessTreeGuard {
    fn attach(child: &tokio::process::Child) -> Result<Self, std::io::Error> {
        #[cfg(windows)]
        {
            use std::os::windows::io::RawHandle;
            use windows_sys::Win32::System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            };

            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(limits).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                let error = std::io::Error::last_os_error();
                unsafe {
                    windows_sys::Win32::Foundation::CloseHandle(job);
                }
                return Err(error);
            }
            let process = child
                .raw_handle()
                .map(|handle: RawHandle| handle.cast())
                .ok_or_else(|| std::io::Error::other("Pandoc process handle unavailable"))?;
            let assigned = unsafe { AssignProcessToJobObject(job, process) };
            if assigned == 0 {
                let error = std::io::Error::last_os_error();
                unsafe {
                    windows_sys::Win32::Foundation::CloseHandle(job);
                }
                return Err(error);
            }
            #[link(name = "ntdll")]
            unsafe extern "system" {
                fn NtResumeProcess(process: windows_sys::Win32::Foundation::HANDLE) -> i32;
            }
            let resumed = unsafe { NtResumeProcess(process) };
            if resumed < 0 {
                let error = std::io::Error::other("failed to resume isolated Pandoc process");
                unsafe {
                    windows_sys::Win32::Foundation::CloseHandle(job);
                }
                return Err(error);
            }
            Ok(Self { job })
        }
        #[cfg(not(windows))]
        {
            Ok(Self {
                process_id: child.id(),
            })
        }
    }

    fn terminate(&self) -> Result<(), std::io::Error> {
        #[cfg(unix)]
        {
            let Some(process_group_id) = self.process_id.and_then(|id| i32::try_from(id).ok())
            else {
                return Ok(());
            };
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }

            const SIGKILL: i32 = 9;
            // Each Pandoc child starts a fresh process group whose ID is its PID.
            // A negative target terminates that child and any descendants together.
            let result = unsafe { kill(-process_group_id, SIGKILL) };
            if result == 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(3) {
                return Ok(());
            }
            return Err(error);
        }
        #[cfg(windows)]
        {
            let result =
                unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1) };
            if result == 0 {
                return Err(std::io::Error::last_os_error());
            }
            return Ok(());
        }
        #[allow(unreachable_code)]
        Ok(())
    }
}

#[cfg(windows)]
unsafe impl Send for ProcessTreeGuard {}

#[cfg(windows)]
unsafe impl Sync for ProcessTreeGuard {}

impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        let _ = self.terminate();
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

async fn drain_bounded_pipe<R>(mut pipe: R, budget: usize) -> Vec<u8>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    let mut retained = Vec::with_capacity(budget.min(64 * 1024));
    let mut chunk = [0u8; 8192];
    loop {
        let read = match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let remaining = budget.saturating_sub(retained.len());
        retained.extend_from_slice(&chunk[..read.min(remaining)]);
    }
    retained
}

async fn wait_status_or_abort(
    child: &mut tokio::process::Child,
    timeout: Duration,
    cancel: Option<watch::Receiver<bool>>,
    output_monitor: Option<OutputMonitor<'_>>,
) -> Result<std::process::ExitStatus, PandocFailure> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut cancel = cancel;
    let mut output_poll = tokio::time::interval(Duration::from_millis(50));

    loop {
        let sleep = tokio::time::sleep_until(deadline);
        tokio::pin!(sleep);
        if let Some(cancel_rx) = cancel.as_mut() {
            if *cancel_rx.borrow() {
                return Err(PandocFailure::new(
                    PandocStage::TimeoutOrCancel,
                    "Pandoc export was cancelled.",
                ));
            }
            tokio::select! {
                status = child.wait() => return status.map_err(|e| PandocFailure::new(PandocStage::Spawn, format!("failed to wait on Pandoc: {e}"))),
                _ = &mut sleep => return Err(PandocFailure::new(PandocStage::TimeoutOrCancel, format!("Pandoc exceeded the {} second timeout.", timeout.as_secs()))),
                changed = cancel_rx.changed() => {
                    match changed {
                        Ok(()) if *cancel_rx.borrow() => return Err(PandocFailure::new(PandocStage::TimeoutOrCancel, "Pandoc export was cancelled.")),
                        Ok(()) => continue,
                        Err(_) => {
                            cancel = None;
                            continue;
                        }
                    }
                }
                _ = output_poll.tick(), if output_monitor.is_some() => {
                    if output_monitor.is_some_and(output_limit_exceeded) {
                        return Err(PandocFailure::new(PandocStage::OutputCommit, "Pandoc output exceeded the 1 GiB limit."));
                    }
                }
            }
        } else {
            tokio::select! {
                status = child.wait() => return status.map_err(|e| PandocFailure::new(PandocStage::Spawn, format!("failed to wait on Pandoc: {e}"))),
                _ = &mut sleep => return Err(PandocFailure::new(PandocStage::TimeoutOrCancel, format!("Pandoc exceeded the {} second timeout.", timeout.as_secs()))),
                _ = output_poll.tick(), if output_monitor.is_some() => {
                    if output_monitor.is_some_and(output_limit_exceeded) {
                        return Err(PandocFailure::new(PandocStage::OutputCommit, "Pandoc output exceeded the 1 GiB limit."));
                    }
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
struct OutputMonitor<'a> {
    path: &'a Path,
    limit: u64,
}

fn output_limit_exceeded(monitor: OutputMonitor<'_>) -> bool {
    std::fs::metadata(monitor.path).is_ok_and(|metadata| metadata.len() > monitor.limit)
}

/// Run pandoc export. Honors the user's `pandoc_path` override.
///
/// Preserves the legacy `Result<String, AppError>` signature so
/// existing callers (`export_project`) do not have to change. Internal
/// failures are constructed as typed [`PandocFailure`] first and then
/// downgraded via [`PandocFailure::into_app_error`].
#[allow(dead_code)]
pub async fn run_pandoc(
    input_path: &Path,
    output_path: &Path,
    format: &str,
    extra_args: &[String],
) -> Result<String, AppError> {
    let bin = match resolve_with_settings().await {
        Some((b, _)) => b,
        None => {
            return Err(PandocFailure::new(
                PandocStage::Discovery,
                "Pandoc not found. Install Pandoc from https://pandoc.org/installing.html or set the binary path in Settings → Editor → Pandoc.",
            )
            .with_format(format.to_string())
            .with_source_path(input_path.to_string_lossy().to_string())
            .into_app_error());
        }
    };
    run_pandoc_structured(&bin, input_path, output_path, format, extra_args)
        .await
        .map_err(PandocFailure::into_app_error)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::io::Write;
    use tempfile::TempDir;

    // -------------------------- stage/serialization --------------------------

    #[test]
    fn stage_tags_are_stable_snake_case() {
        assert_eq!(PandocStage::Discovery.tag(), "discovery");
        assert_eq!(PandocStage::InputRead.tag(), "input_read");
        assert_eq!(PandocStage::Spawn.tag(), "spawn");
        assert_eq!(PandocStage::TimeoutOrCancel.tag(), "timeout_or_cancel");
        assert_eq!(PandocStage::ExitNonZero.tag(), "exit_non_zero");
        assert_eq!(PandocStage::OutputDecode.tag(), "output_decode");
        assert_eq!(PandocStage::OutputCommit.tag(), "output_commit");
        assert_eq!(PandocStage::Cleanup.tag(), "cleanup");
    }

    #[test]
    fn stage_serializes_as_snake_case_string() {
        for (stage, expected) in [
            (PandocStage::Discovery, "\"discovery\""),
            (PandocStage::InputRead, "\"input_read\""),
            (PandocStage::Spawn, "\"spawn\""),
            (PandocStage::TimeoutOrCancel, "\"timeout_or_cancel\""),
            (PandocStage::ExitNonZero, "\"exit_non_zero\""),
            (PandocStage::OutputDecode, "\"output_decode\""),
            (PandocStage::OutputCommit, "\"output_commit\""),
            (PandocStage::Cleanup, "\"cleanup\""),
        ] {
            let json = serde_json::to_string(&stage).unwrap();
            assert_eq!(json, expected, "stage {stage:?}");
        }
    }

    #[test]
    fn probe_accepts_only_pandoc_version_signatures() {
        assert!(is_pandoc_version_line("pandoc 3.10"));
        assert!(is_pandoc_version_line("pandoc 3.1.11.1"));
        assert!(!is_pandoc_version_line("--version"));
        assert!(!is_pandoc_version_line("Python 3.13.5"));
        assert!(!is_pandoc_version_line("pandoc unknown"));
        assert!(!is_pandoc_version_line("pandoc 3.10 unexpected text"));
    }

    #[test]
    fn failure_serializes_omitting_unset_fields() {
        let f = PandocFailure::new(PandocStage::Discovery, "not found");
        let json = serde_json::to_value(&f).unwrap();
        assert_eq!(json["stage"], "discovery");
        assert_eq!(json["message"], "not found");
        // Optional fields must be absent (skip_serializing_if kicks in).
        assert!(json.get("resolved_binary").is_none());
        assert!(json.get("format").is_none());
        assert!(json.get("argv_summary").is_none());
        assert!(json.get("exit_code").is_none());
        assert!(json.get("stderr_excerpt").is_none());
        assert!(json.get("stderr_truncated").is_none());
        assert!(json.get("source_path").is_none());
        assert!(json.get("probed_paths").is_none());
    }

    #[test]
    fn failure_roundtrips_all_fields() {
        let f = PandocFailure::new(PandocStage::ExitNonZero, "exit 47")
            .with_binary("/opt/homebrew/bin/pandoc")
            .with_format("docx")
            .with_argv_summary(vec!["-o".into(), "out.docx".into()])
            .with_exit_code(Some(47))
            .with_source_path("/tmp/chapter.md")
            .with_stderr(b"unknown option --foo");
        let json = serde_json::to_string(&f).unwrap();
        let back: PandocFailure = serde_json::from_str(&json).unwrap();
        assert_eq!(back.stage, PandocStage::ExitNonZero);
        assert_eq!(back.exit_code, Some(47));
        assert_eq!(back.format.as_deref(), Some("docx"));
        assert_eq!(
            back.resolved_binary.as_deref(),
            Some("/opt/homebrew/bin/pandoc")
        );
        assert_eq!(back.source_path.as_deref(), Some("/tmp/chapter.md"));
        assert_eq!(back.stderr_excerpt, "unknown option --foo");
        assert!(!back.stderr_truncated);
    }

    #[test]
    fn display_includes_stage_and_optional_context() {
        let f = PandocFailure::new(PandocStage::ExitNonZero, "bad flag")
            .with_format("html")
            .with_exit_code(Some(47))
            .with_stderr(b"detail here");
        let s = f.to_string();
        assert!(s.contains("Pandoc exit_non_zero"), "got: {s}");
        assert!(s.contains("bad flag"), "got: {s}");
        assert!(s.contains("(exit 47)"), "got: {s}");
        assert!(s.contains("[format=html]"), "got: {s}");
        assert!(s.contains("stderr: detail here"), "got: {s}");
    }

    #[test]
    fn into_app_error_preserves_message() {
        let f = PandocFailure::new(PandocStage::Discovery, "not found");
        let err = f.into_app_error();
        let s = err.to_string();
        assert!(s.contains("discovery"));
        assert!(s.contains("not found"));
    }

    // -------------------------- redaction --------------------------

    #[test]
    fn redact_argv_leaves_positional_paths_visible() {
        let argv = vec![
            "chapter.md".to_string(),
            "-o".to_string(),
            "out.docx".to_string(),
        ];
        let out = redact_argv_summary(&argv);
        assert_eq!(out, argv);
    }

    #[test]
    fn redact_argv_masks_secretlike_flags() {
        let argv = vec![
            "--token=abc123secret".to_string(),
            "--password=hunter2".to_string(),
            "--api-key=xyz".to_string(),
            "--auth-header=Bearer%20xyz".to_string(),
            "--secret-value=42".to_string(),
        ];
        let out = redact_argv_summary(&argv);
        for entry in &out {
            assert!(
                entry.ends_with("=<redacted>"),
                "entry {entry} was not redacted"
            );
            assert!(!entry.contains("abc123secret"));
            assert!(!entry.contains("hunter2"));
            assert!(!entry.contains("xyz"));
            assert!(!entry.contains("Bearer"));
            assert!(!entry.contains("42"));
        }
    }

    #[test]
    fn redact_argv_preserves_ordinary_flags() {
        let argv = vec![
            "-t".to_string(),
            "html5".to_string(),
            "--standalone".to_string(),
            "--metadata=title=Chapter%201".to_string(),
        ];
        let out = redact_argv_summary(&argv);
        assert_eq!(out, argv);
    }

    #[test]
    fn redact_is_case_insensitive_on_flag_names() {
        let argv = vec![
            "--PASSWORD=hunter2".to_string(),
            "--Api-Key=xyz".to_string(),
        ];
        let out = redact_argv_summary(&argv);
        assert!(out[0].ends_with("=<redacted>"));
        assert!(out[1].ends_with("=<redacted>"));
    }

    #[test]
    fn redact_argv_masks_split_form_secret_value() {
        let argv = vec![
            "--token".to_string(),
            "SUPER_SECRET_TOKEN".to_string(),
            "-o".to_string(),
            "out.docx".to_string(),
        ];
        let out = redact_argv_summary(&argv);
        assert_eq!(
            out,
            vec![
                "--token".to_string(),
                "<redacted>".to_string(),
                "-o".to_string(),
                "out.docx".to_string(),
            ]
        );
    }

    #[test]
    fn redact_argv_split_form_is_case_insensitive() {
        let argv = vec![
            "--PASSWORD".to_string(),
            "hunter2".to_string(),
            "--Api-Key".to_string(),
            "xyz".to_string(),
        ];
        let out = redact_argv_summary(&argv);
        assert_eq!(out[1], "<redacted>");
        assert_eq!(out[3], "<redacted>");
        assert!(!out.iter().any(|a| a.contains("hunter2")));
        assert!(!out.iter().any(|a| a.contains("xyz")));
    }

    #[test]
    fn redact_argv_multiple_adjacent_secret_flags() {
        let argv = vec![
            "--token".to_string(),
            "T1".to_string(),
            "--password".to_string(),
            "P2".to_string(),
            "--api-key".to_string(),
            "K3".to_string(),
        ];
        let out = redact_argv_summary(&argv);
        assert_eq!(
            out,
            vec![
                "--token".to_string(),
                "<redacted>".to_string(),
                "--password".to_string(),
                "<redacted>".to_string(),
                "--api-key".to_string(),
                "<redacted>".to_string(),
            ]
        );
    }

    #[test]
    fn redact_argv_does_not_swallow_next_flag_when_secret_value_missing() {
        let argv = vec![
            "--token".to_string(),
            "--standalone".to_string(),
            "-t".to_string(),
            "html5".to_string(),
        ];
        let out = redact_argv_summary(&argv);
        assert_eq!(
            out,
            vec![
                "--token".to_string(),
                "--standalone".to_string(),
                "-t".to_string(),
                "html5".to_string(),
            ]
        );
    }

    #[test]
    fn redact_argv_leaves_ordinary_split_flags_alone() {
        let argv = vec![
            "--metadata".to_string(),
            "title=Chapter 1".to_string(),
            "-t".to_string(),
            "html5".to_string(),
        ];
        let out = redact_argv_summary(&argv);
        assert_eq!(out, argv);
    }

    #[test]
    fn redact_argv_summary_bounds_item_count_and_each_value() {
        let argv = (0..100)
            .map(|index| format!("--metadata=field{index}={}", "x".repeat(2048)))
            .collect::<Vec<_>>();
        let out = redact_argv_summary(&argv);

        assert!(out.len() <= ARGV_SUMMARY_MAX_ITEMS);
        assert!(out.iter().all(|arg| arg.len() <= ARGV_SUMMARY_ITEM_BUDGET));
    }

    // -------------------------- stderr credential sanitization --------------------------

    #[test]
    fn sanitize_stderr_removes_authorization_header_token() {
        let raw = "GET /posts HTTP/1.1\nAuthorization: Bearer sk-live-DEADBEEF1234567890\n";
        let out = sanitize_stderr(raw);
        assert!(!out.contains("sk-live-DEADBEEF1234567890"), "leaked: {out}");
        assert!(out.contains("Authorization:"));
        assert!(out.contains("<redacted>"));
    }

    #[test]
    fn sanitize_stderr_removes_ghost_scheme_token() {
        let raw = "curl -H 'Authorization: Ghost eyJhbGciOiJIUzI1NiJ9.PAYLOAD.SIG' https://x";
        let out = sanitize_stderr(raw);
        assert!(
            !out.contains("eyJhbGciOiJIUzI1NiJ9.PAYLOAD.SIG"),
            "leaked: {out}"
        );
    }

    #[test]
    fn sanitize_stderr_removes_basic_auth_token() {
        let raw = "Authorization: Basic YWxpY2U6c2VjcmV0MTIz";
        let out = sanitize_stderr(raw);
        assert!(!out.contains("YWxpY2U6c2VjcmV0MTIz"), "leaked: {out}");
    }

    #[test]
    fn sanitize_stderr_removes_query_string_credentials() {
        let raw = "fetch https://api.example.com/upload?api_key=abc123DEADBEEF&other=safe";
        let out = sanitize_stderr(raw);
        assert!(!out.contains("abc123DEADBEEF"), "leaked: {out}");
        assert!(out.contains("other=safe"));
    }

    #[test]
    fn sanitize_stderr_removes_access_token_form_param() {
        let raw = "POST access_token=WPCOM_SECRET_12345&title=hi";
        let out = sanitize_stderr(raw);
        assert!(!out.contains("WPCOM_SECRET_12345"), "leaked: {out}");
        assert!(out.contains("title=hi"));
    }

    #[test]
    fn sanitize_stderr_removes_quoted_and_spaced_credential_values() {
        let secrets = ["QUOTED_SECRET_123", "SPACED_SECRET_456"];
        let raw = format!(
            "token=\"{}\" next=safe\napi_key = {} next=safe",
            secrets[0], secrets[1]
        );

        let out = sanitize_stderr(&raw);

        for secret in secrets {
            assert!(!out.contains(secret), "leaked {secret}: {out}");
        }
        assert_eq!(out.matches("<redacted>").count(), 2, "{out}");
        assert_eq!(out.matches("next=safe").count(), 2, "{out}");
    }

    #[test]
    fn sanitize_stderr_removes_colon_delimited_secret_values() {
        let sanitized = sanitize_stderr("token: COLON_TOKEN_SECRET\npassword : quoted-secret\n");
        assert!(!sanitized.contains("COLON_TOKEN_SECRET"));
        assert!(!sanitized.contains("quoted-secret"));
        assert!(sanitized.contains("token: <redacted>"));
    }

    #[test]
    fn sanitize_stderr_removes_quoted_scheme_tokens() {
        let secrets = ["BEARER_QUOTED_SECRET", "TOKEN_QUOTED_SECRET"];
        let raw = format!("Bearer \"{}\" next=safe Token '{}'", secrets[0], secrets[1]);

        let out = sanitize_stderr(&raw);

        for secret in secrets {
            assert!(!out.contains(secret), "leaked {secret}: {out}");
        }
        assert_eq!(out.matches("<redacted>").count(), 2, "{out}");
        assert!(out.contains("next=safe"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_executable_variants_reject_shell_batch_files() {
        assert!(executable_variants(Path::new(r"C:\tools\pandoc.cmd")).is_empty());
        assert!(executable_variants(Path::new(r"C:\tools\pandoc.bat")).is_empty());
        assert_eq!(
            executable_variants(Path::new(r"C:\tools\pandoc.exe")),
            vec![PathBuf::from(r"C:\tools\pandoc.exe")]
        );
    }

    #[test]
    fn sanitize_stderr_removes_json_password_field() {
        let raw = r#"{"user":"alice","password":"hunter2SUPERSECRET"}"#;
        let out = sanitize_stderr(raw);
        assert!(!out.contains("hunter2SUPERSECRET"), "leaked: {out}");
        assert!(out.contains("alice"));
    }

    #[test]
    fn sanitize_stderr_leaves_ordinary_pandoc_error_alone() {
        let raw = "pandoc: parse error at 章节/第一章.md line 42: unexpected token";
        let out = sanitize_stderr(raw);
        assert_eq!(out, raw);
    }

    #[test]
    fn sanitize_stderr_is_idempotent() {
        let raw = "Authorization: Bearer sk-live-DEADBEEF";
        let once = sanitize_stderr(raw);
        let twice = sanitize_stderr(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn with_stderr_redacts_credentials_before_bounding() {
        let raw = b"pandoc filter fetch failed: Authorization: Bearer sk-live-DEADBEEF1234567890\n";
        let f = PandocFailure::new(PandocStage::ExitNonZero, "x").with_stderr(raw);
        assert!(
            !f.stderr_excerpt.contains("sk-live-DEADBEEF1234567890"),
            "excerpt leaked: {}",
            f.stderr_excerpt
        );
        assert!(f.stderr_excerpt.contains("<redacted>"));
    }

    #[test]
    fn display_never_leaks_raw_stderr_credentials() {
        let raw = b"pandoc: fetch failed access_token=SECRET_ABC_XYZ_1234567";
        let f = PandocFailure::new(PandocStage::ExitNonZero, "x")
            .with_format("html")
            .with_exit_code(Some(1))
            .with_stderr(raw);
        let d = f.to_string();
        assert!(!d.contains("SECRET_ABC_XYZ_1234567"), "Display leaked: {d}");
    }

    #[test]
    fn serialized_json_never_leaks_raw_stderr_credentials() {
        let raw = b"Authorization: Bearer sk-live-DEADBEEF-XYZ\n";
        let f = PandocFailure::new(PandocStage::ExitNonZero, "x").with_stderr(raw);
        let json = serde_json::to_string(&f).unwrap();
        assert!(
            !json.contains("sk-live-DEADBEEF-XYZ"),
            "JSON leaked: {json}"
        );
    }

    // -------------------------- stderr truncation --------------------------

    #[test]
    fn truncate_stderr_short_input_untouched() {
        let s = truncate_stderr(b"short message", 4096);
        assert_eq!(s, "short message");
    }

    #[test]
    fn truncate_stderr_bounds_huge_input() {
        let raw = vec![b'x'; STDERR_BUDGET * 4];
        let out = truncate_stderr(&raw, STDERR_BUDGET);
        assert!(out.len() <= STDERR_BUDGET, "over-budget: {}", out.len());
        assert!(
            out.len() >= STDERR_BUDGET - 4,
            "under-budget: {}",
            out.len()
        );
    }

    #[test]
    fn truncate_stderr_never_splits_utf8_codepoint() {
        // Fill with CJK so cuts must respect multi-byte boundaries.
        let cjk = "第一章".repeat(2048); // each char is 3 UTF-8 bytes
        let out = truncate_stderr(cjk.as_bytes(), STDERR_BUDGET);
        assert!(out.len() <= STDERR_BUDGET);
        // Round-trip: must be valid UTF-8 (implicit — String), and last
        // char boundary must not be mid-codepoint.
        assert!(out.chars().all(|c| c == '第' || c == '一' || c == '章'));
    }

    #[test]
    fn truncate_stderr_replaces_invalid_bytes() {
        let raw = b"\xff\xfe invalid";
        let out = truncate_stderr(raw, 4096);
        // \xff and \xfe are lone bytes; from_utf8_lossy replaces each
        // with U+FFFD, which serializes as the 3-byte UTF-8 sequence.
        assert!(out.contains('\u{FFFD}'));
        assert!(out.contains("invalid"));
    }

    #[test]
    fn failure_with_stderr_records_truncation_flag() {
        let raw = vec![b'A'; STDERR_BUDGET * 2];
        let f = PandocFailure::new(PandocStage::ExitNonZero, "x").with_stderr(&raw);
        assert!(f.stderr_truncated, "flag not set on truncation");
        assert!(f.stderr_excerpt.len() <= STDERR_BUDGET);

        let short = b"tiny";
        let f2 = PandocFailure::new(PandocStage::ExitNonZero, "x").with_stderr(short);
        assert!(!f2.stderr_truncated);
        assert_eq!(f2.stderr_excerpt, "tiny");
    }

    #[test]
    fn failure_with_stderr_truncation_flag_correct_when_lossy_expansion_exceeds_budget() {
        // Fill with lone \xff bytes; each expands to a 3-byte U+FFFD.
        // Choose a raw length so that raw < BUDGET < lossy: pick 2 KiB
        // of \xff so raw=2048 bytes (< 4096 budget) but lossy=6144
        // bytes (> 4096 budget). Old impl compared raw byte length to
        // budget-truncated string length and set `stderr_truncated=false`;
        // the correct behavior is `true`.
        let raw = vec![0xffu8; 2048];
        let f = PandocFailure::new(PandocStage::ExitNonZero, "x").with_stderr(&raw);
        assert!(f.stderr_truncated, "expansion should force truncation flag");
        assert!(
            f.stderr_excerpt.len() <= STDERR_BUDGET,
            "excerpt {} over budget",
            f.stderr_excerpt.len()
        );
        // Valid UTF-8 and only U+FFFD replacements — no split codepoint.
        assert!(f.stderr_excerpt.chars().all(|c| c == '\u{FFFD}'));
        assert!(f.stderr_excerpt.is_char_boundary(f.stderr_excerpt.len()));
    }

    // -------------------------- format_args pinning --------------------------

    #[test]
    fn format_args_are_deterministic_per_format() {
        assert_eq!(
            format_args("html"),
            vec![
                "-f",
                "markdown-yaml_metadata_block-raw_tex-raw_attribute-raw_html",
                "-t",
                "html5",
                "--standalone",
                "--embed-resources",
            ]
        );
        let prefix = vec![
            "-f",
            "markdown-yaml_metadata_block-raw_tex-raw_attribute-raw_html",
        ];
        assert_eq!(format_args("pdf"), prefix);
        assert_eq!(
            format_args("docx"),
            vec![
                "-f",
                "markdown-yaml_metadata_block-raw_tex-raw_attribute-raw_html",
                "-t",
                "docx"
            ]
        );
        assert_eq!(
            format_args("epub"),
            vec![
                "-f",
                "markdown-yaml_metadata_block-raw_tex-raw_attribute-raw_html",
                "-t",
                "epub"
            ]
        );
        assert_eq!(
            format_args("odt"),
            vec![
                "-f",
                "markdown-yaml_metadata_block-raw_tex-raw_attribute-raw_html",
                "-t",
                "odt"
            ]
        );
    }

    // -------------------------- injectable resolver --------------------------

    #[tokio::test]
    async fn resolver_honors_override_first() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let calls_clone = calls.clone();
        let result = resolve_with(
            Some("/my/override/pandoc"),
            &[PathBuf::from("/never/used")],
            |bin| {
                let calls = calls_clone.clone();
                async move {
                    calls.lock().unwrap().push(bin.clone());
                    if bin == "/my/override/pandoc" {
                        Some(PandocProbe {
                            resolved_binary: bin,
                            version: "pandoc 3.1".to_string(),
                        })
                    } else {
                        None
                    }
                }
            },
        )
        .await;
        let (path, version) = result.expect("override should resolve");
        assert_eq!(path, "/my/override/pandoc");
        assert_eq!(version, "pandoc 3.1");
        // Only one probe call — resolver stops after the override succeeds.
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn resolver_falls_back_to_path_then_probe_list_in_order() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen_clone = seen.clone();
        let probes = vec![
            PathBuf::from("/opt/homebrew/bin/pandoc"),
            PathBuf::from("/usr/local/bin/pandoc"),
        ];
        let result = resolve_with(None, &probes, |bin| {
            let seen = seen_clone.clone();
            async move {
                seen.lock().unwrap().push(bin.clone());
                if bin == "/usr/local/bin/pandoc" {
                    Some(PandocProbe {
                        resolved_binary: bin,
                        version: "pandoc 2.19".to_string(),
                    })
                } else {
                    None
                }
            }
        })
        .await;
        let (path, _) = result.expect("probe list should resolve");
        assert_eq!(path, "/usr/local/bin/pandoc");
        let order = seen.lock().unwrap().clone();
        assert_eq!(
            order,
            vec![
                "pandoc".to_string(),
                "/opt/homebrew/bin/pandoc".to_string(),
                "/usr/local/bin/pandoc".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn missing_and_stale_configured_path_reports_discovery_stage() {
        let probes = vec![PathBuf::from("/does/not/exist/pandoc")];
        let err = resolve_with(Some("/stale/configured/pandoc"), &probes, |_bin| async {
            None
        })
        .await
        .expect_err("resolution must fail with no working binary");
        assert_eq!(err.stage, PandocStage::Discovery);
        // Probed list must record what we tried, in the exact resolution order.
        assert_eq!(
            err.probed_paths,
            vec![
                "/stale/configured/pandoc".to_string(),
                "pandoc".to_string(),
                "/does/not/exist/pandoc".to_string(),
            ]
        );
        // No environment leak.
        assert!(!err.message.contains("PATH="));
        assert!(!err.message.contains("HOME="));
        // Message directs the user to Settings.
        assert!(err.message.contains("Pandoc not found"));
    }

    #[tokio::test]
    async fn discovery_attempts_are_bounded_and_redact_secret_path_segments() {
        let secret = "SUPER_SECRET_TOKEN_123";
        let configured = format!("/tmp/token={secret}/{}", "x".repeat(2048));
        let err = resolve_with(Some(&configured), &[], |_bin| async { None })
            .await
            .expect_err("resolution must fail with no working binary");

        assert_eq!(err.stage, PandocStage::Discovery);
        assert_eq!(err.probed_paths.len(), 2);
        assert!(!err.probed_paths[0].contains(secret));
        assert!(err.probed_paths[0].contains("token=<redacted>"));
        assert!(err.probed_paths[0].len() <= PROBE_ATTEMPT_BUDGET);
        assert_eq!(err.probed_paths[1], "pandoc");
    }

    #[tokio::test]
    async fn empty_or_whitespace_override_is_skipped() {
        let result_empty = resolve_with(Some(""), &[], |bin| async move {
            if bin == "pandoc" {
                Some(PandocProbe {
                    resolved_binary: "/resolved/pandoc".to_string(),
                    version: "pandoc 3.x".to_string(),
                })
            } else {
                None
            }
        })
        .await;
        assert!(result_empty.is_ok());
        let result_ws = resolve_with(Some("   "), &[], |bin| async move {
            if bin == "pandoc" {
                Some(PandocProbe {
                    resolved_binary: "/resolved/pandoc".to_string(),
                    version: "pandoc 3.x".to_string(),
                })
            } else {
                None
            }
        })
        .await;
        assert!(result_ws.is_ok());
    }

    // -------------------------- fake-executable exit tests --------------------------

    /// Build a tiny shell script that prints to stderr and exits with
    /// the given code. Payload is written to a sibling file and read
    /// via a fully-quoted `cat` invocation so no escaping is required
    /// and no external decoder (base64) is involved.
    #[cfg(unix)]
    fn make_fake_pandoc(dir: &TempDir, stderr_payload: &str, exit_code: i32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let payload_file = dir.path().join("fake-pandoc.stderr");
        std::fs::write(&payload_file, stderr_payload).unwrap();
        let script = dir.path().join("fake-pandoc.sh");
        let mut f = std::fs::File::create(&script).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "/bin/cat >/dev/null 2>&1 || true").unwrap();
        let payload_str = payload_file.to_string_lossy();
        assert!(
            !payload_str.contains('\''),
            "temp payload path contains single quote; refusing to build fake script"
        );
        writeln!(f, "/bin/cat '{payload_str}' 1>&2").unwrap();
        writeln!(f, "exit {exit_code}").unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        script
    }

    #[cfg(unix)]
    fn make_sleeping_pandoc(dir: &TempDir) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.path().join("fake-pandoc-sleep.sh");
        let mut f = std::fs::File::create(&script).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "/bin/cat >/dev/null 2>&1 || true").unwrap();
        writeln!(f, "/bin/sleep 30").unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        script
    }

    #[cfg(unix)]
    fn make_writing_pandoc(dir: &TempDir, payload: &str, exit_code: i32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.path().join(format!("fake-pandoc-write-{exit_code}.sh"));
        let mut f = std::fs::File::create(&script).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "out=''").unwrap();
        writeln!(f, "while [ \"$#\" -gt 0 ]; do").unwrap();
        writeln!(f, "  if [ \"$1\" = '-o' ]; then shift; out=$1; fi").unwrap();
        writeln!(f, "  shift || true").unwrap();
        writeln!(f, "done").unwrap();
        writeln!(f, "printf '%s' '{payload}' > \"$out\"").unwrap();
        writeln!(f, "exit {exit_code}").unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        script
    }

    #[cfg(unix)]
    fn make_writing_pandoc_with_detached_descendant(
        dir: &TempDir,
        payload: &str,
    ) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.path().join("fake-pandoc-detached-descendant.sh");
        let pid_file = dir.path().join("detached-descendant.pid");
        let mut f = std::fs::File::create(&script).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "out=''").unwrap();
        writeln!(f, "while [ \"$#\" -gt 0 ]; do").unwrap();
        writeln!(f, "  if [ \"$1\" = '-o' ]; then shift; out=$1; fi").unwrap();
        writeln!(f, "  shift || true").unwrap();
        writeln!(f, "done").unwrap();
        writeln!(f, "printf '%s' '{payload}' > \"$out\"").unwrap();
        writeln!(f, "/bin/sleep 30 </dev/null >/dev/null 2>&1 &").unwrap();
        writeln!(f, "printf '%s' \"$!\" > '{}'", pid_file.display()).unwrap();
        writeln!(f, "exit 0").unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        (script, pid_file)
    }

    #[cfg(unix)]
    fn export_temp_artifacts(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .contains(".novelist-export-")
            })
            .collect()
    }

    #[cfg(unix)]
    fn make_version_pandoc(dir: &TempDir, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.path().join("pandoc");
        let mut f = std::fs::File::create(&script).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "{body}").unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        script
    }

    #[cfg(unix)]
    fn process_is_alive(pid: u32) -> bool {
        std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(windows)]
    fn make_hanging_version_pandoc_windows(dir: &TempDir) -> (PathBuf, PathBuf) {
        let pid_file = dir.path().join("windows-probe.pid");
        let source = dir.path().join("pandoc_helper.rs");
        let binary = dir.path().join("pandoc.exe");
        std::fs::write(
            &source,
            r#"
use std::process::Command;
use std::time::Duration;

fn main() {
    let pid_file = std::env::current_exe().unwrap().with_file_name("windows-probe.pid");
    let child = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
        .spawn()
        .unwrap();
    std::fs::write(pid_file, child.id().to_string()).unwrap();
    std::thread::sleep(Duration::from_secs(30));
}
"#,
        )
        .unwrap();
        let status = std::process::Command::new("rustc")
            .arg(&source)
            .arg("-o")
            .arg(&binary)
            .status()
            .expect("rustc must be available in the Windows Rust CI job");
        assert!(
            status.success(),
            "failed to build native Pandoc test helper"
        );
        (binary, pid_file)
    }

    #[cfg(windows)]
    fn windows_process_is_alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return false;
        }
        let mut exit_code = 0;
        let read = unsafe { GetExitCodeProcess(process, &mut exit_code) };
        unsafe {
            CloseHandle(process);
        }
        read != 0 && exit_code == STILL_ACTIVE as u32
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_probe_timeout_terminates_job_descendant() {
        let dir = TempDir::new().unwrap();
        let (fake, pid_file) = make_hanging_version_pandoc_windows(&dir);

        let bounded = tokio::time::timeout(
            Duration::from_secs(5),
            probe_with_timeout(fake.to_str().unwrap(), Duration::from_secs(2)),
        )
        .await
        .expect("Windows version probe exceeded its outer bound");
        assert_eq!(bounded, None);

        let pid = std::fs::read_to_string(pid_file)
            .expect("PowerShell descendant should record its PID")
            .parse::<u32>()
            .unwrap();
        assert!(
            !windows_process_is_alive(pid),
            "timed-out Windows descendant {pid} survived its Job Object"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn path_discovery_reports_the_absolute_executable_that_was_invoked() {
        let dir = TempDir::new().unwrap();
        let fake = make_version_pandoc(&dir, "printf 'pandoc 3.10\\n'");
        let search_path = std::env::join_paths([dir.path()]).unwrap();
        assert_eq!(
            resolve_executable_with_path("pandoc", Some(&search_path)),
            Some(fake.clone())
        );
        let real_probe = probe(fake.to_str().unwrap())
            .await
            .expect("the fake binary should answer its version probe");

        let (resolved, version) = resolve_with(None, &[], move |_candidate| {
            let probe = real_probe.clone();
            async move { Some(probe) }
        })
        .await
        .expect("the injected PATH result should resolve");

        assert_eq!(resolved, fake.to_string_lossy());
        assert_eq!(version, "pandoc 3.10");
        assert_ne!(
            resolved, "pandoc",
            "a PATH placeholder is not an executable path"
        );
    }

    #[tokio::test]
    async fn executable_resolution_is_bounded_by_the_probe_deadline() {
        let started = std::time::Instant::now();
        let resolved = run_blocking_with_timeout(Duration::from_millis(20), || {
            std::thread::sleep(Duration::from_millis(250));
            Some(PathBuf::from("/too/late/pandoc"))
        })
        .await;

        assert_eq!(resolved, None);
        assert!(
            started.elapsed() < Duration::from_millis(150),
            "blocked executable resolution exceeded its deadline"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hung_version_probe_times_out_kills_and_reaps_the_child() {
        let dir = TempDir::new().unwrap();
        let pid_file = dir.path().join("probe.pid");
        let pid_file_text = pid_file.to_string_lossy();
        assert!(!pid_file_text.contains('\''));
        let fake = make_version_pandoc(
            &dir,
            &format!("printf '%s' \"$$\" > '{pid_file_text}'\nexec /bin/sleep 30"),
        );

        let bounded = tokio::time::timeout(
            Duration::from_secs(4),
            probe_with_timeout(fake.to_str().unwrap(), Duration::from_secs(2)),
        )
        .await;
        let pid = std::fs::read_to_string(&pid_file)
            .expect("the fake probe should record its pid")
            .parse::<u32>()
            .unwrap();
        if bounded.is_err() {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-9", &pid.to_string()])
                .status();
        }

        assert!(
            bounded.is_ok(),
            "version discovery exceeded its probe timeout"
        );
        assert_eq!(bounded.unwrap(), None);
        assert!(
            !process_is_alive(pid),
            "timed-out discovery child {pid} survived"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn version_probe_bounds_and_terminates_descendants_holding_pipes() {
        let dir = TempDir::new().unwrap();
        let pid_file = dir.path().join("descendant.pid");
        let pid_file_text = pid_file.to_string_lossy();
        assert!(!pid_file_text.contains('\''));
        let fake = make_version_pandoc(
            &dir,
            &format!("/bin/sleep 30 &\nprintf '%s' \"$!\" > '{pid_file_text}'\nexit 0"),
        );

        let bounded =
            tokio::time::timeout(Duration::from_secs(5), probe(fake.to_str().unwrap())).await;
        let descendant = std::fs::read_to_string(&pid_file)
            .expect("the fake probe should record its descendant pid")
            .parse::<u32>()
            .unwrap();
        if bounded.is_err() {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-9", &descendant.to_string()])
                .status();
        }

        assert!(
            bounded.is_ok(),
            "inherited pipes escaped the probe deadline"
        );
        assert_eq!(bounded.unwrap(), None);
        assert!(
            !process_is_alive(descendant),
            "probe descendant {descendant} survived lifecycle cleanup"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_pandoc_exit_47_reports_structured_diagnostic() {
        let dir = TempDir::new().unwrap();
        let fake = make_fake_pandoc(&dir, "unknown option --foo\n", 47);
        let input = dir.path().join("chapter.md");
        std::fs::write(&input, b"# hi\n").unwrap();
        let output = dir.path().join("out.docx");

        let err = run_pandoc_structured(fake.to_str().unwrap(), &input, &output, "docx", &[])
            .await
            .expect_err("fake pandoc must fail with structured error");

        assert_eq!(err.stage, PandocStage::ExitNonZero);
        assert_eq!(err.exit_code, Some(47));
        assert_eq!(err.format.as_deref(), Some("docx"));
        assert_eq!(err.resolved_binary.as_deref(), Some(fake.to_str().unwrap()));
        assert!(err.stderr_excerpt.contains("unknown option --foo"));
        assert!(!err.stderr_truncated);
        assert!(err.argv_summary.iter().any(|a| a == "-o"));
        assert_eq!(
            err.source_path.as_deref(),
            Some(input.to_string_lossy().as_ref())
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_export_preserves_existing_destination_and_removes_sibling_temp() {
        let dir = TempDir::new().unwrap();
        let fake = make_writing_pandoc(&dir, "partial output", 47);
        let input = dir.path().join("chapter.md");
        let output = dir.path().join("novel.html");
        std::fs::write(&input, "# 第一章\n").unwrap();
        std::fs::write(&output, "existing export").unwrap();

        let error = run_pandoc_structured_with_timeout(
            fake.to_str().unwrap(),
            &input,
            &output,
            "html",
            &[],
            Duration::from_secs(5),
        )
        .await
        .expect_err("the fake Pandoc exits non-zero");

        assert_eq!(error.stage, PandocStage::ExitNonZero);
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "existing export");
        assert!(
            export_temp_artifacts(dir.path()).is_empty(),
            "failed export leaked a sibling temporary output"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn file_output_limit_rejects_oversized_private_output_before_commit() {
        let dir = TempDir::new().unwrap();
        let payload = "x".repeat(2048);
        let fake = make_writing_pandoc(&dir, &payload, 0);
        let input = dir.path().join("chapter.md");
        let output = dir.path().join("novel.html");
        let private = allocate_sibling_output(&output).await.unwrap();
        std::fs::write(&input, "# chapter\n").unwrap();

        let error = run_pandoc_to_output(
            fake.to_str().unwrap(),
            &input,
            PandocOutputPaths {
                diagnostic: &output,
                process: &private.path,
                limit: 1024,
            },
            "html",
            &[],
            Duration::from_secs(5),
            None,
        )
        .await
        .expect_err("oversized output must fail before commit");

        assert_eq!(error.stage, PandocStage::OutputCommit);
        assert!(!output.exists());
        cleanup_sibling_output(&private).await.unwrap();
    }

    #[test]
    fn output_allocation_reports_directory_cleanup_failure() {
        let error = allocation_error_with_cleanup(
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "file create failed"),
            Err(std::io::Error::new(
                std::io::ErrorKind::DirectoryNotEmpty,
                "directory retained",
            )),
        );

        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("file create failed"));
        assert!(error.to_string().contains("cleanup also failed"));
        assert!(error.to_string().contains("directory retained"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_export_atomically_replaces_destination_without_temp_artifact() {
        let dir = TempDir::new().unwrap();
        let fake = make_writing_pandoc(&dir, "complete output", 0);
        let input = dir.path().join("chapter.md");
        let output = dir.path().join("novel.html");
        std::fs::write(&input, "# 第一章\n").unwrap();
        std::fs::write(&output, "existing export").unwrap();

        let message = run_pandoc_structured_with_timeout(
            fake.to_str().unwrap(),
            &input,
            &output,
            "html",
            &[],
            Duration::from_secs(5),
        )
        .await
        .expect("the fake Pandoc succeeds");

        assert_eq!(message, format!("Export complete: {}", output.display()));
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "complete output");
        assert!(
            export_temp_artifacts(dir.path()).is_empty(),
            "successful export leaked a sibling temporary output"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_before_output_commit_preserves_existing_destination() {
        let dir = TempDir::new().unwrap();
        let fake = make_writing_pandoc(&dir, "complete output", 0);
        let input = dir.path().join("chapter.md");
        let output = dir.path().join("novel.html");
        std::fs::write(&input, "# 第一章\n").unwrap();
        std::fs::write(&output, "existing export").unwrap();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let commit_gate = std::sync::Arc::new(CommitGate::default());
        let cancel_gate = commit_gate.clone();
        *BEFORE_OUTPUT_COMMIT_HOOK.lock().unwrap() = Some(Box::new(move || {
            assert!(cancel_gate.cancel());
            cancel_tx.send(true).unwrap();
        }));

        let result = run_pandoc_structured_with_cancel_detailed(
            fake.to_str().unwrap(),
            &input,
            &output,
            "html",
            &[],
            PandocRunControl {
                timeout: Duration::from_secs(5),
                cancel: Some(cancel_rx),
                commit_gate: Some(commit_gate),
            },
        )
        .await;
        let error = match result {
            Ok(_) => panic!("cancellation before commit must abort the export"),
            Err(error) => error,
        };

        assert_eq!(error.stage, PandocStage::TimeoutOrCancel);
        assert_eq!(std::fs::read_to_string(&output).unwrap(), "existing export");
        assert!(export_temp_artifacts(dir.path()).is_empty());
    }

    #[test]
    fn commit_gate_rejects_cancellation_after_commit_ownership() {
        let gate = CommitGate::default();
        assert!(gate.begin_commit());
        assert!(!gate.cancel());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_commit_atomically_replaces_existing_destination() {
        let dir = TempDir::new().unwrap();
        let temp_output = dir.path().join("novel.pending.html");
        let output = dir.path().join("novel.html");
        std::fs::write(&temp_output, "complete output").unwrap();
        std::fs::write(&output, "existing export").unwrap();

        commit_sibling_output(&temp_output, &output)
            .await
            .expect("Windows replacement must overwrite the existing destination atomically");

        assert_eq!(std::fs::read_to_string(&output).unwrap(), "complete output");
        assert!(!temp_output.exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_export_terminates_detached_descendants_before_returning() {
        let dir = TempDir::new().unwrap();
        let (fake, pid_file) =
            make_writing_pandoc_with_detached_descendant(&dir, "complete output");
        let input = dir.path().join("chapter.md");
        let output = dir.path().join("novel.html");
        std::fs::write(&input, "# 第一章\n").unwrap();

        let result = run_pandoc_structured_with_timeout(
            fake.to_str().unwrap(),
            &input,
            &output,
            "html",
            &[],
            Duration::from_secs(5),
        )
        .await;
        let descendant = std::fs::read_to_string(&pid_file)
            .expect("fake Pandoc should record its detached descendant")
            .parse::<u32>()
            .unwrap();
        let alive = process_is_alive(descendant);
        if alive {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-9", &descendant.to_string()])
                .status();
        }

        result.expect("conversion itself should succeed");
        assert!(!alive, "successful Pandoc descendant {descendant} survived");
        assert_eq!(std::fs::read_to_string(output).unwrap(), "complete output");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_pandoc_huge_stderr_is_truncated_bounded_and_flagged() {
        let dir = TempDir::new().unwrap();
        // 32 KiB of CJK + ASCII so we exercise UTF-8 boundary logic too.
        let mut payload = String::new();
        while payload.len() < 32 * 1024 {
            payload.push_str("Pandoc parse error at 章节/第一章.md: unexpected token\n");
        }
        let fake = make_fake_pandoc(&dir, &payload, 1);
        let input = dir.path().join("章节-第一章.md");
        std::fs::write(&input, b"# hi\n").unwrap();
        let output = dir.path().join("out.html");

        let err = run_pandoc_structured(fake.to_str().unwrap(), &input, &output, "html", &[])
            .await
            .expect_err("must fail");

        assert_eq!(err.stage, PandocStage::ExitNonZero);
        assert_eq!(err.exit_code, Some(1));
        assert!(
            err.stderr_excerpt.len() <= STDERR_BUDGET,
            "over-budget: {}",
            err.stderr_excerpt.len()
        );
        assert!(err.stderr_truncated, "expected truncation flag");
        // CJK source path in argv_summary must not be corrupted.
        assert!(
            err.argv_summary
                .iter()
                .any(|a| a.contains("章节-第一章.md")),
            "argv summary lost CJK: {:?}",
            err.argv_summary
        );
        // Source path context (CJK) is preserved verbatim.
        assert_eq!(
            err.source_path.as_deref(),
            Some(input.to_string_lossy().as_ref())
        );
        // Truncation must land on a char boundary (String type + no panic
        // during to_string_lossy already guarantees UTF-8).
        assert!(err
            .stderr_excerpt
            .is_char_boundary(err.stderr_excerpt.len()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_pandoc_argv_summary_redacts_secretlike_extra_args() {
        let dir = TempDir::new().unwrap();
        let fake = make_fake_pandoc(&dir, "boom", 2);
        let input = dir.path().join("in.md");
        std::fs::write(&input, b"# hi\n").unwrap();
        let output = dir.path().join("out.html");

        let extras = vec![
            "--metadata=title=Ok".to_string(),
            "--token=SUPER_SECRET_TOKEN".to_string(),
            "--api-key=SUPER_SECRET_KEY".to_string(),
        ];
        let err = run_pandoc_structured(fake.to_str().unwrap(), &input, &output, "html", &extras)
            .await
            .expect_err("must fail");

        for arg in &err.argv_summary {
            assert!(!arg.contains("SUPER_SECRET_TOKEN"), "leaked token: {arg}");
            assert!(!arg.contains("SUPER_SECRET_KEY"), "leaked key: {arg}");
        }
        assert!(err.argv_summary.iter().any(|a| a == "--token=<redacted>"));
        assert!(err.argv_summary.iter().any(|a| a == "--api-key=<redacted>"));
        // Non-secret metadata flag survives.
        assert!(err.argv_summary.iter().any(|a| a == "--metadata=title=Ok"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_hung_pandoc_timeout_reports_timeout_or_cancel_after_reap() {
        let dir = TempDir::new().unwrap();
        let fake = make_sleeping_pandoc(&dir);
        let input = dir.path().join("in.md");
        std::fs::write(&input, b"# hi\n").unwrap();
        let output = dir.path().join("out.html");

        let err = run_pandoc_structured_with_timeout(
            fake.to_str().unwrap(),
            &input,
            &output,
            "html",
            &[],
            Duration::from_millis(100),
        )
        .await
        .expect_err("hung fake pandoc should time out");

        assert_eq!(err.stage, PandocStage::TimeoutOrCancel);
        assert_eq!(err.format.as_deref(), Some("html"));
        assert_eq!(err.resolved_binary.as_deref(), Some(fake.to_str().unwrap()));
        assert!(err.message.contains("timeout"), "{}", err.message);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_hung_pandoc_cancel_reports_timeout_or_cancel_after_reap() {
        let dir = TempDir::new().unwrap();
        let fake = make_sleeping_pandoc(&dir);
        let input = dir.path().join("in.md");
        std::fs::write(&input, b"# hi\n").unwrap();
        let output = dir.path().join("out.html");
        let (tx, rx) = tokio::sync::watch::channel(false);
        let cancel_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = tx.send(true);
        });

        let err = run_pandoc_structured_with_cancel(
            fake.to_str().unwrap(),
            &input,
            &output,
            "html",
            &[],
            Duration::from_secs(30),
            Some(rx),
        )
        .await
        .expect_err("cancelled fake pandoc should fail");
        cancel_task.await.unwrap();

        assert_eq!(err.stage, PandocStage::TimeoutOrCancel);
        assert!(err.message.contains("cancelled"), "{}", err.message);
        assert_eq!(err.format.as_deref(), Some("html"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn closed_cancel_channel_keeps_original_timeout_active() {
        let dir = TempDir::new().unwrap();
        let fake = make_sleeping_pandoc(&dir);
        let input = dir.path().join("in.md");
        std::fs::write(&input, b"# hi\n").unwrap();
        let output = dir.path().join("out.html");
        let (tx, rx) = tokio::sync::watch::channel(false);
        drop(tx);
        let start = std::time::Instant::now();

        let err = run_pandoc_structured_with_cancel(
            fake.to_str().unwrap(),
            &input,
            &output,
            "html",
            &[],
            Duration::from_millis(100),
            Some(rx),
        )
        .await
        .expect_err("closed cancel sender should not disable timeout");

        assert_eq!(err.stage, PandocStage::TimeoutOrCancel);
        assert!(err.message.contains("timeout"), "{}", err.message);
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn spawn_error_reports_spawn_stage_with_source_context() {
        // A path that categorically cannot be spawned (does not exist).
        let dir = TempDir::new().unwrap();
        let input = dir.path().join("in.md");
        std::fs::write(&input, b"# hi\n").unwrap();
        let output = dir.path().join("out.html");

        let err = run_pandoc_structured(
            "/definitely/not/a/binary/pandoc-xyz",
            &input,
            &output,
            "html",
            &[],
        )
        .await
        .expect_err("nonexistent binary must fail");
        assert_eq!(err.stage, PandocStage::Spawn);
        assert_eq!(err.format.as_deref(), Some("html"));
        assert_eq!(
            err.source_path.as_deref(),
            Some(input.to_string_lossy().as_ref())
        );
    }

    // -------------------------- legacy skip-on-no-pandoc smoke tests --------------------------

    async fn pandoc_anywhere_on_system() -> bool {
        resolve_pandoc(None).await.is_some()
    }

    #[tokio::test]
    async fn resolve_with_no_override_finds_pandoc_when_installed() {
        if !pandoc_anywhere_on_system().await {
            eprintln!("skipping: pandoc not installed anywhere we recognize");
            return;
        }
        let result = resolve_pandoc(None).await;
        assert!(result.is_some(), "resolver should locate pandoc");
        let (path, version) = result.unwrap();
        assert!(!path.is_empty(), "resolved path empty");
        assert!(
            version.to_lowercase().contains("pandoc"),
            "version line should mention pandoc: {version}"
        );
    }

    #[tokio::test]
    async fn override_with_bad_path_falls_back_to_path_or_common() {
        if !pandoc_anywhere_on_system().await {
            eprintln!("skipping: pandoc not installed");
            return;
        }
        let result = resolve_pandoc(Some("/totally/nonexistent/pandoc-binary-xxxxx")).await;
        assert!(
            result.is_some(),
            "broken override should fall back, not return None"
        );
        let (resolved, _) = result.unwrap();
        assert_ne!(
            resolved, "/totally/nonexistent/pandoc-binary-xxxxx",
            "broken override path must NOT be returned"
        );
    }

    #[tokio::test]
    async fn probe_of_missing_binary_is_none() {
        let bogus = probe("totally-nonexistent-pandoc-xyz").await;
        assert!(bogus.is_none(), "probe of a fake binary must be None");
    }
}
