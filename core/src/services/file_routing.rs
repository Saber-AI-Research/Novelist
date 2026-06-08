//! Routes a single-file open request to the window that already owns the
//! file's directory (project root or single-file-mode parent dir). Each
//! webview is asked to bid; the winner receives a targeted `open-file-deliver`
//! event. If nobody claims, the caller spawns a fresh single-file window.
//!
//! Flow:
//!   1. FE entry point invokes `route_single_file_open` (one per file).
//!   2. Rust emits `file-open-bid-request` to every webview window.
//!   3. Each window's FE computes `canClaim` against its own state and
//!      replies via `submit_file_open_bid`.
//!   4. Rust waits up to ~250ms for replies, picks a winner by priority,
//!      and either:
//!        - emits `open-file-deliver` to the winner + focuses it, OR
//!        - returns `winner: None`, telling FE to spawn a new window.
//!
//! See: docs/superpowers/specs/2026-05-19-single-file-open-routing-design.md

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Bid {
    pub window_label: String,
    pub can_claim: bool,
    pub has_project: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct BidRequest {
    pub bid_id: u64,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct OpenFileDeliver {
    pub path: String,
    pub line: Option<u32>,
    pub col: Option<u32>,
    /// Winner window label. On Windows `emit_to` broadcasts to every webview,
    /// so the frontend filters delivery on this to open the file in exactly one.
    pub target_label: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct RouteResult {
    /// `Some(label)` — Rust has delivered to the winner; FE caller may stop.
    /// `None` — no window claimed; FE caller should spawn a new window.
    pub winner_label: Option<String>,
}

struct BidCollector {
    expected: usize,
    bids: Vec<Bid>,
    waker: Option<oneshot::Sender<Vec<Bid>>>,
}

pub struct FileRoutingState {
    inner: Arc<Mutex<HashMap<u64, BidCollector>>>,
    next_id: AtomicU64,
}

impl Default for FileRoutingState {
    fn default() -> Self {
        Self::new()
    }
}

impl FileRoutingState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        }
    }
}

const BID_TIMEOUT: Duration = Duration::from_millis(250);

/// Pick the winning bid by priority. Public for unit testing.
///
/// Priority:
///   1. The source window itself, if it bids true.
///   2. Any project-owning window (`has_project = true`) that bids true.
///   3. Any other claiming window.
pub fn pick_winner(bids: &[Bid], source_label: Option<&str>) -> Option<String> {
    if let Some(src) = source_label {
        if bids.iter().any(|b| b.can_claim && b.window_label == src) {
            return Some(src.to_string());
        }
    }
    if let Some(b) = bids.iter().find(|b| b.can_claim && b.has_project) {
        return Some(b.window_label.clone());
    }
    bids.iter()
        .find(|b| b.can_claim)
        .map(|b| b.window_label.clone())
}

/// Pick one webview to receive app-level external-open events.
///
/// Tauri app events are broadcast to every webview by default. For
/// `cli-open` / macOS `open-file`, broadcasting would make every window start
/// its own routing round. We instead pick a single coordinator window, and
/// let the normal bid router decide the final owner from there.
pub fn pick_open_event_target(mut labels: Vec<String>) -> Option<String> {
    if labels.iter().any(|label| label == "main") {
        return Some("main".to_string());
    }
    labels.sort();
    labels.into_iter().next()
}

/// Run a single bid round and resolve the winner. Async because we wait on
/// frontend replies. Callers from a synchronous context (e.g. the
/// single-instance callback) should `tauri::async_runtime::spawn` this.
pub async fn route_single_file_open(
    app: AppHandle,
    source_label: Option<String>,
    path: String,
    line: Option<u32>,
    col: Option<u32>,
    force_new: bool,
) -> RouteResult {
    if force_new {
        return RouteResult { winner_label: None };
    }

    let state = match app.try_state::<FileRoutingState>() {
        Some(s) => s,
        None => {
            tracing::warn!(
                target: "novelist::file-routing",
                "FileRoutingState missing; falling back to new-window spawn"
            );
            return RouteResult { winner_label: None };
        }
    };

    let bid_id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let labels: Vec<String> = app.webview_windows().keys().cloned().collect();

    if labels.is_empty() {
        // No windows up — caller will spawn a new one.
        return RouteResult { winner_label: None };
    }

    let (tx_done, rx_done) = oneshot::channel();
    {
        let mut map = state.inner.lock().await;
        map.insert(
            bid_id,
            BidCollector {
                expected: labels.len(),
                bids: Vec::with_capacity(labels.len()),
                waker: Some(tx_done),
            },
        );
    }

    let req = BidRequest {
        bid_id,
        path: path.clone(),
    };
    if let Err(e) = app.emit("file-open-bid-request", req) {
        tracing::warn!(
            target: "novelist::file-routing",
            error = %e,
            "failed to emit file-open-bid-request"
        );
    }

    // Wait for all bids OR timeout, then drain whatever we have.
    let bids = match tokio::time::timeout(BID_TIMEOUT, rx_done).await {
        Ok(Ok(bids)) => bids,
        _ => {
            let mut map = state.inner.lock().await;
            map.remove(&bid_id).map(|c| c.bids).unwrap_or_default()
        }
    };

    let winner = pick_winner(&bids, source_label.as_deref());

    if let Some(label) = winner.clone() {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
        let payload = OpenFileDeliver {
            path,
            line,
            col,
            target_label: label.clone(),
        };
        if let Err(e) = app.emit_to(label.as_str(), "open-file-deliver", payload) {
            tracing::warn!(
                target: "novelist::file-routing",
                window = %label,
                error = %e,
                "failed to emit open-file-deliver"
            );
        }
    }

    RouteResult {
        winner_label: winner,
    }
}

/// Tauri command — FE wrapper around `route_single_file_open`.
#[tauri::command]
#[specta::specta]
pub async fn route_single_file_open_cmd(
    app: AppHandle,
    source_label: Option<String>,
    path: String,
    line: Option<u32>,
    col: Option<u32>,
    force_new: bool,
) -> RouteResult {
    route_single_file_open(app, source_label, path, line, col, force_new).await
}

/// Tauri command — each window reports its bid in response to a
/// `file-open-bid-request` event.
#[tauri::command]
#[specta::specta]
pub async fn submit_file_open_bid(
    state: tauri::State<'_, FileRoutingState>,
    bid_id: u64,
    window_label: String,
    can_claim: bool,
    has_project: bool,
) -> Result<(), String> {
    let mut map = state.inner.lock().await;
    let collector = match map.get_mut(&bid_id) {
        Some(c) => c,
        None => return Ok(()), // already resolved or timed out
    };

    collector.bids.push(Bid {
        window_label,
        can_claim,
        has_project,
    });

    if collector.bids.len() >= collector.expected {
        if let Some(entry) = map.remove(&bid_id) {
            if let Some(tx) = entry.waker {
                let _ = tx.send(entry.bids);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bid(label: &str, can_claim: bool, has_project: bool) -> Bid {
        Bid {
            window_label: label.into(),
            can_claim,
            has_project,
        }
    }

    #[test]
    fn no_claimers_returns_none() {
        let bids = vec![bid("a", false, true), bid("b", false, false)];
        assert!(pick_winner(&bids, Some("a")).is_none());
    }

    #[test]
    fn source_window_wins_when_it_claims() {
        let bids = vec![
            bid("a", true, false),
            bid("b", true, true), // has_project but not source
        ];
        assert_eq!(pick_winner(&bids, Some("a")), Some("a".into()));
    }

    #[test]
    fn project_owner_beats_single_file_when_source_does_not_claim() {
        let bids = vec![
            bid("a", false, false), // source, doesn't claim
            bid("b", true, false),  // single-file claimer
            bid("c", true, true),   // project owner — wins
        ];
        assert_eq!(pick_winner(&bids, Some("a")), Some("c".into()));
    }

    #[test]
    fn falls_through_to_any_claimer() {
        let bids = vec![bid("a", false, true), bid("b", true, false)];
        assert_eq!(pick_winner(&bids, Some("a")), Some("b".into()));
    }

    #[test]
    fn no_source_label_picks_project_first() {
        let bids = vec![bid("a", true, false), bid("b", true, true)];
        assert_eq!(pick_winner(&bids, None), Some("b".into()));
    }

    #[test]
    fn open_event_target_prefers_main_window() {
        let labels = vec![
            "novelist-2".to_string(),
            "main".to_string(),
            "novelist-1".to_string(),
        ];
        assert_eq!(pick_open_event_target(labels), Some("main".into()));
    }

    #[test]
    fn open_event_target_uses_stable_fallback_when_main_is_missing() {
        let labels = vec!["novelist-2".to_string(), "novelist-1".to_string()];
        assert_eq!(pick_open_event_target(labels), Some("novelist-1".into()));
    }

    #[test]
    fn open_event_target_returns_none_without_windows() {
        let labels: Vec<String> = vec![];
        assert_eq!(pick_open_event_target(labels), None);
    }
}
