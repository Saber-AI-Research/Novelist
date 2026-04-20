//! Lightweight startup instrumentation command.
//!
//! The frontend calls `log_startup_phase` at phase boundaries so its timing
//! lands in the same `tracing` log as the backend's own phase marks. This
//! makes it trivial to read one log and see the full end-to-end timeline.

/// Record a frontend startup phase in the backend tracing log.
/// `since_start_ms` is the frontend-observed time relative to the first mark.
#[tauri::command]
#[specta::specta]
pub fn log_startup_phase(name: String, since_start_ms: f64) {
    tracing::info!(
        target: "novelist::startup",
        phase = %name,
        since_start_ms = since_start_ms,
        "frontend phase"
    );
}
