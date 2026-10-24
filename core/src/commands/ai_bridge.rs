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

/// Ceiling on the response we'll buffer from an (untrusted) endpoint. Caps the
/// non-SSE body and a single un-delimited SSE event so a hostile or buggy
/// server can't grow our memory without bound. 32 MB is generous for chat
/// completions while still bounding worst-case allocation.
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

/// Payload pushed on each SSE `data:` line (for `sse = true`) or the
/// single chunk that carries the full response body (for `sse = false`).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AiStreamEvent {
    Chunk {
        data: String,
    },
    Done,
    Error {
        message: String,
        status: Option<u16>,
    },
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
    format!("{now:x}-{thread:?}").replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "")
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
            // Non-SSE path: buffer the whole body (bounded) and emit one chunk.
            let mut stream = response.bytes_stream();
            let mut buf: Vec<u8> = Vec::new();
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
                            message: format!("Failed to read body: {e}"),
                            status: None,
                        });
                        return;
                    }
                    Some(Ok(bytes)) => {
                        if buf.len() + bytes.len() > MAX_RESPONSE_BYTES {
                            emit(AiStreamEvent::Error {
                                message: format!("Response exceeded {MAX_RESPONSE_BYTES} bytes"),
                                status: None,
                            });
                            return;
                        }
                        buf.extend_from_slice(&bytes);
                    }
                }
            }
            emit(AiStreamEvent::Chunk {
                data: String::from_utf8_lossy(&buf).into_owned(),
            });
            emit(AiStreamEvent::Done);
            return;
        }

        // SSE path: split complete events on raw bytes, then decode each.
        let mut stream = response.bytes_stream();
        let mut decoder = SseDecoder::default();
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
                Some(Ok(bytes)) => match decoder.push(&bytes) {
                    Err(message) => {
                        emit(AiStreamEvent::Error {
                            message,
                            status: None,
                        });
                        return;
                    }
                    Ok(items) => {
                        for item in items {
                            match item {
                                SseItem::Done => {
                                    emit(AiStreamEvent::Done);
                                    return;
                                }
                                SseItem::Data(data) => emit(AiStreamEvent::Chunk { data }),
                            }
                        }
                    }
                },
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

#[derive(Debug, PartialEq)]
enum SseItem {
    Data(String),
    Done,
}

/// Incremental SSE parser over raw bytes. Events are split on blank lines
/// before UTF-8 decoding, so a multi-byte (e.g. CJK) character split across
/// network chunks is decoded whole instead of becoming U+FFFD.
#[derive(Default)]
struct SseDecoder {
    buffer: Vec<u8>,
    /// Prefix of `buffer` already searched without finding a delimiter.
    scanned: usize,
}

impl SseDecoder {
    /// Feed one network chunk; returns the `data:` payloads of every event it
    /// completed. Other fields (event:, id:, retry:, comments) are ignored —
    /// plugins don't use them. Stops at `[DONE]`.
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseItem>, String> {
        self.buffer.extend_from_slice(bytes);
        let mut items = Vec::new();
        let mut consumed = 0;
        // Back up so a delimiter split across chunks is still found.
        let mut search_from = self.scanned.saturating_sub(3);
        while let Some((end, delimiter_len)) = find_event_end(&self.buffer[search_from..]) {
            let event_end = search_from + end;
            let block = String::from_utf8_lossy(&self.buffer[consumed..event_end]);
            for line in block.lines() {
                let line = line.trim_end_matches('\r');
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim_start();
                    if data == "[DONE]" {
                        items.push(SseItem::Done);
                        self.buffer.clear();
                        self.scanned = 0;
                        return Ok(items);
                    }
                    items.push(SseItem::Data(data.to_string()));
                }
            }
            consumed = event_end + delimiter_len;
            search_from = consumed;
        }
        self.buffer.drain(..consumed);
        self.scanned = self.buffer.len();
        // Bound a single un-delimited event: a server that streams forever
        // without a blank-line separator can't OOM us.
        if self.buffer.len() > MAX_RESPONSE_BYTES {
            return Err(format!(
                "SSE event exceeded {MAX_RESPONSE_BYTES} bytes without a delimiter"
            ));
        }
        Ok(items)
    }
}

/// Offset and length of the first blank line (`\n\n`, or `\r\n\r\n` from
/// CRLF servers).
fn find_event_end(bytes: &[u8]) -> Option<(usize, usize)> {
    let find = |needle: &[u8]| {
        bytes
            .windows(needle.len())
            .position(|window| window == needle)
    };
    match (find(b"\n\n"), find(b"\r\n\r\n")) {
        (Some(lf), Some(crlf)) if crlf < lf => Some((crlf, 4)),
        (Some(lf), _) => Some((lf, 2)),
        (None, Some(crlf)) => Some((crlf, 4)),
        (None, None) => None,
    }
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

    #[test]
    fn sse_decoder_keeps_cjk_split_across_chunks_intact() {
        let payload = "data: {\"delta\":\"落霞与孤鹜齐飞\"}\n\n".as_bytes();
        // Split inside the 3-byte encoding of "霞".
        let split = payload
            .iter()
            .position(|byte| *byte == "霞".as_bytes()[0])
            .unwrap()
            + 1;
        let mut decoder = SseDecoder::default();
        assert!(decoder.push(&payload[..split]).unwrap().is_empty());
        assert_eq!(
            decoder.push(&payload[split..]).unwrap(),
            vec![SseItem::Data("{\"delta\":\"落霞与孤鹜齐飞\"}".to_string())]
        );
    }

    #[test]
    fn sse_decoder_feeds_byte_by_byte_and_handles_crlf_and_done() {
        let stream =
            "data: 第一\r\n\r\nevent: ping\n\ndata:第二\n\ndata: [DONE]\n\ndata: ignored\n\n";
        let mut decoder = SseDecoder::default();
        let mut items = Vec::new();
        for byte in stream.as_bytes() {
            items.extend(decoder.push(std::slice::from_ref(byte)).unwrap());
            if items.last() == Some(&SseItem::Done) {
                break;
            }
        }
        assert_eq!(
            items,
            vec![
                SseItem::Data("第一".to_string()),
                SseItem::Data("第二".to_string()),
                SseItem::Done,
            ]
        );
    }

    #[test]
    fn sse_decoder_bounds_an_undelimited_event() {
        let mut decoder = SseDecoder::default();
        let chunk = vec![b'x'; 1024 * 1024];
        let mut result = Ok(Vec::new());
        for _ in 0..=(MAX_RESPONSE_BYTES / chunk.len()) {
            result = decoder.push(&chunk);
            if result.is_err() {
                break;
            }
        }
        assert!(result.unwrap_err().contains("without a delimiter"));
    }
}
