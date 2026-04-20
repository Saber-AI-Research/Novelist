//! AI HTTP streaming bridge used by plugins that call OpenAI-compatible
//! (or similar) endpoints. The core editor never speaks to these APIs —
//! all requests must originate from a plugin with the `ai:http` permission.
//!
//! Design: start a streaming request and immediately return a `stream_id`.
//! Stream chunks and terminal status are pushed as Tauri events on the
//! channel `ai-stream://{stream_id}` so iframes can listen via the plugin
//! bridge. Cancellation is cooperative through a per-stream `Notify`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

use crate::error::AppError;

const REQUEST_TIMEOUT_SECS: u64 = 120;
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024; // 2 MB — guards against runaway requests.

/// Payload pushed on each SSE `data:` line (for `sse = true`) or the
/// single chunk that carries the full response body (for `sse = false`).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AiStreamEvent {
    Chunk { data: String },
    Done,
    Error { message: String, status: Option<u16> },
}

#[derive(Debug, Deserialize, Type)]
pub struct AiFetchRequest {
    /// Full URL. Must be https:// (http:// allowed only for localhost for
    /// self-hosted / ollama during development).
    pub url: String,
    pub headers: Vec<(String, String)>,
    /// Raw JSON body. The caller (plugin) owns the shape — we just POST it.
    pub body: String,
    /// When true, parse the response as SSE (split on `\n\n`, strip `data: `,
    /// skip `[DONE]`). When false, buffer the full body and emit one chunk.
    pub sse: bool,
}

/// State shared across commands — holds cancellation handles for in-flight
/// streams so `ai_fetch_stream_cancel` can poke them.
pub struct AiBridgeState {
    streams: Mutex<HashMap<String, Arc<Notify>>>,
}

impl AiBridgeState {
    pub fn new() -> Self {
        Self {
            streams: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for AiBridgeState {
    fn default() -> Self {
        Self::new()
    }
}

/// Validate the URL: only allow https, or http for localhost / 127.0.0.1 /
/// ::1 (common self-hosted dev endpoints). Rejects everything else so a
/// malicious plugin can't exfiltrate over plain http.
fn validate_url(raw: &str) -> Result<url::Url, AppError> {
    let parsed = url::Url::parse(raw)
        .map_err(|e| AppError::InvalidInput(format!("Invalid URL {raw}: {e}")))?;
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" => {
            let host = parsed.host_str().unwrap_or("");
            if host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]" {
                Ok(parsed)
            } else {
                Err(AppError::InvalidInput(format!(
                    "http:// only allowed for localhost, got host {host}"
                )))
            }
        }
        other => Err(AppError::InvalidInput(format!(
            "Unsupported URL scheme: {other}"
        ))),
    }
}

fn channel_name(stream_id: &str) -> String {
    format!("ai-stream://{stream_id}")
}

fn spawn_uuid() -> String {
    // Cheap, dependency-free UUID v4-ish identifier from system time + random
    // thread id bits. Collisions are astronomically unlikely for our scale.
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let thread = std::thread::current().id();
    format!("{now:x}-{thread:?}")
        .replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "")
}

#[tauri::command]
#[specta::specta]
pub async fn ai_fetch_stream_start(
    app: AppHandle,
    state: State<'_, AiBridgeState>,
    req: AiFetchRequest,
) -> Result<String, AppError> {
    let url = validate_url(&req.url)?;

    if req.body.len() > MAX_BODY_BYTES {
        return Err(AppError::InvalidInput(format!(
            "Request body too large ({} bytes, max {MAX_BODY_BYTES})",
            req.body.len()
        )));
    }

    let stream_id = spawn_uuid();
    let cancel = Arc::new(Notify::new());
    {
        let mut streams = state
            .streams
            .lock()
            .map_err(|e| AppError::Custom(format!("AiBridge lock poisoned: {e}")))?;
        streams.insert(stream_id.clone(), cancel.clone());
    }

    let app_for_task = app.clone();
    let stream_id_for_task = stream_id.clone();
    let stream_id_for_cleanup = stream_id.clone();

    tokio::spawn(async move {
        let channel = channel_name(&stream_id_for_task);
        let emit = |event: AiStreamEvent| {
            let _ = app_for_task.emit(&channel, event);
        };

        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                emit(AiStreamEvent::Error {
                    message: format!("Failed to build HTTP client: {e}"),
                    status: None,
                });
                return;
            }
        };

        let mut builder = client.post(url).body(req.body);
        for (k, v) in &req.headers {
            builder = builder.header(k, v);
        }

        let response = tokio::select! {
            _ = cancel.notified() => {
                emit(AiStreamEvent::Error { message: "cancelled".into(), status: None });
                return;
            }
            res = builder.send() => res,
        };
        let response = match response {
            Ok(r) => r,
            Err(e) => {
                emit(AiStreamEvent::Error {
                    message: format!("Request failed: {e}"),
                    status: None,
                });
                return;
            }
        };

        let status = response.status();
        if !status.is_success() {
            // Try to surface the body text so plugins can show useful error
            // messages to users (OpenAI puts errors in JSON bodies).
            let body = response.text().await.unwrap_or_else(|_| String::new());
            emit(AiStreamEvent::Error {
                message: body,
                status: Some(status.as_u16()),
            });
            return;
        }

        if !req.sse {
            // Non-SSE path: buffer the whole body and emit a single chunk.
            match response.text().await {
                Ok(text) => {
                    emit(AiStreamEvent::Chunk { data: text });
                    emit(AiStreamEvent::Done);
                }
                Err(e) => emit(AiStreamEvent::Error {
                    message: format!("Failed to read body: {e}"),
                    status: None,
                }),
            }
            return;
        }

        // SSE path: accumulate chunks, split on blank lines, extract `data:` payloads.
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        loop {
            let next = tokio::select! {
                _ = cancel.notified() => {
                    emit(AiStreamEvent::Error { message: "cancelled".into(), status: None });
                    return;
                }
                item = stream.next() => item,
            };
            match next {
                None => break,
                Some(Err(e)) => {
                    emit(AiStreamEvent::Error {
                        message: format!("Stream error: {e}"),
                        status: None,
                    });
                    return;
                }
                Some(Ok(bytes)) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(idx) = buffer.find("\n\n") {
                        let event_block = buffer[..idx].to_string();
                        buffer.drain(..idx + 2);
                        for line in event_block.lines() {
                            let line = line.trim_end_matches('\r');
                            if let Some(data) = line.strip_prefix("data:") {
                                let data = data.trim_start();
                                if data == "[DONE]" {
                                    emit(AiStreamEvent::Done);
                                    return;
                                }
                                emit(AiStreamEvent::Chunk {
                                    data: data.to_string(),
                                });
                            }
                            // Other fields (event:, id:, retry:, comments) are
                            // ignored — plugins don't use them.
                        }
                    }
                }
            }
        }
        emit(AiStreamEvent::Done);

        // Best-effort cleanup of cancellation entry on natural termination.
        if let Some(state) = app_for_task.try_state::<AiBridgeState>() {
            if let Ok(mut map) = state.streams.lock() {
                map.remove(&stream_id_for_cleanup);
            }
        }
    });

    Ok(stream_id)
}

#[tauri::command]
#[specta::specta]
pub fn ai_fetch_stream_cancel(
    state: State<'_, AiBridgeState>,
    stream_id: String,
) -> Result<(), AppError> {
    let mut streams = state
        .streams
        .lock()
        .map_err(|e| AppError::Custom(format!("AiBridge lock poisoned: {e}")))?;
    if let Some(notify) = streams.remove(&stream_id) {
        notify.notify_waiters();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https() {
        assert!(validate_url("https://api.openai.com/v1/chat/completions").is_ok());
    }

    #[test]
    fn rejects_plain_http_for_remote() {
        assert!(validate_url("http://api.example.com/v1").is_err());
    }

    #[test]
    fn accepts_localhost_http() {
        assert!(validate_url("http://localhost:11434/api/chat").is_ok());
        assert!(validate_url("http://127.0.0.1:8080/v1").is_ok());
    }

    #[test]
    fn rejects_ftp() {
        assert!(validate_url("ftp://files.example.com/").is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert!(validate_url("not a url").is_err());
    }

    #[test]
    fn channel_name_embeds_stream_id() {
        assert_eq!(channel_name("abc123"), "ai-stream://abc123");
    }

    #[test]
    fn spawn_uuid_is_nonempty_and_unique() {
        let a = spawn_uuid();
        let b = spawn_uuid();
        assert!(!a.is_empty());
        assert_ne!(a, b);
    }
}
