//! Bridge to the locally-installed `claude` Code CLI.
//!
//! Plugins with the `ai:claude-cli` permission can spawn a Claude session
//! and exchange stream-JSON messages. Each session is keyed by a plugin-
//! supplied UUID so callers can correlate output events. The Rust side
//! owns `tokio::process::Child` handles and multiplexes stdout/stderr into
//! Tauri events on `claude-stream://{session_id}`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Type)]
pub struct DetectedCli {
    pub path: String,
    pub version: Option<String>,
}

#[derive(Debug, Deserialize, Type)]
pub struct ClaudeSpawnRequest {
    /// Override the auto-detected CLI path.
    pub cli_path: Option<String>,
    /// Working directory for the spawned process. Default: inherit.
    pub cwd: Option<String>,
    pub system_prompt: Option<String>,
    /// Extra `--add-dir` values (plugin usually includes the project root).
    pub add_dirs: Vec<String>,
    /// One of: "acceptEdits", "auto", "bypassPermissions", "default",
    /// "dontAsk", "plan". Passed through as-is.
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    /// Plugin-owned UUID; must be a valid UUID string on the CLI side.
    pub session_uuid: String,
    /// Extra CLI args (escape hatch). Validated against a blocklist of
    /// flags we manage ourselves.
    pub extra_args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ClaudeStreamEvent {
    StdoutLine { data: String },
    StderrLine { data: String },
    Exit { code: Option<i32> },
    Error { message: String },
}

struct Session {
    stdin: ChildStdin,
    kill_tx: Option<oneshot::Sender<()>>,
}

pub struct ClaudeBridgeState {
    sessions: AsyncMutex<HashMap<String, Session>>,
    /// Cached detection so repeated calls don't walk the filesystem.
    detected: Mutex<Option<Option<DetectedCli>>>,
}

impl ClaudeBridgeState {
    pub fn new() -> Self {
        Self {
            sessions: AsyncMutex::new(HashMap::new()),
            detected: Mutex::new(None),
        }
    }
}

impl Default for ClaudeBridgeState {
    fn default() -> Self {
        Self::new()
    }
}

// ------------------------- detection -------------------------

fn is_executable(path: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|m| m.is_file() && (m.permissions().mode() & 0o111 != 0))
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

fn candidate_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let home = dirs::home_dir();

    if let Ok(path_env) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in path_env.split(sep) {
            if dir.is_empty() {
                continue;
            }
            let mut p = PathBuf::from(dir);
            p.push(if cfg!(windows) {
                "claude.exe"
            } else {
                "claude"
            });
            out.push(p);
        }
    }

    if let Some(h) = home.as_ref() {
        out.push(h.join(".claude").join("local").join("claude"));
        out.push(h.join(".local").join("bin").join("claude"));
        // Volta / fnm / asdf / bun — stable bin dirs
        out.push(h.join(".volta").join("bin").join("claude"));
        out.push(h.join(".fnm").join("current").join("bin").join("claude"));
        out.push(h.join(".asdf").join("shims").join("claude"));
        out.push(h.join(".bun").join("bin").join("claude"));
        // nvm: iterate all installed Node versions under ~/.nvm/versions/node/
        let nvm_dir = h.join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
            for entry in entries.flatten() {
                out.push(entry.path().join("bin").join("claude"));
            }
        }
        // Global npm prefixes (when set via NPM_CONFIG_PREFIX or default npm root -g)
        out.push(h.join(".npm-global").join("bin").join("claude"));
    }

    // Homebrew (macOS Intel + Apple Silicon, Linux)
    out.push(PathBuf::from("/opt/homebrew/bin/claude"));
    out.push(PathBuf::from("/usr/local/bin/claude"));
    out.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin/claude"));

    out
}

fn detect_cli_uncached() -> Option<DetectedCli> {
    for path in candidate_paths() {
        if !is_executable(&path) {
            continue;
        }
        let path_str = path.to_string_lossy().to_string();
        let version = std::process::Command::new(&path)
            .arg("--version")
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if s.is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                } else {
                    None
                }
            });
        return Some(DetectedCli {
            path: path_str,
            version,
        });
    }
    None
}

#[tauri::command]
#[specta::specta]
pub fn claude_cli_detect(state: State<'_, ClaudeBridgeState>) -> Option<DetectedCli> {
    if let Ok(mut slot) = state.detected.lock() {
        if let Some(cached) = slot.clone() {
            return cached;
        }
        let fresh = detect_cli_uncached();
        *slot = Some(fresh.clone());
        return fresh;
    }
    detect_cli_uncached()
}

// ------------------------- spawn / send / kill -------------------------

/// Args the plugin may NOT inject (we control them ourselves).
const DISALLOWED_FLAGS: &[&str] = &[
    "--input-format",
    "--output-format",
    "--include-partial-messages",
    "--session-id",
    "--print",
    "-p",
    "--resume",
    "--continue",
];

fn validate_extra_args(args: &[String]) -> Result<(), AppError> {
    for a in args {
        for bad in DISALLOWED_FLAGS {
            if a == bad {
                return Err(AppError::InvalidInput(format!(
                    "extra_args may not include {bad}"
                )));
            }
        }
    }
    Ok(())
}

fn validate_uuid(s: &str) -> Result<(), AppError> {
    if s.len() < 8 || s.len() > 64 {
        return Err(AppError::InvalidInput(format!(
            "session_uuid length out of range: {s}"
        )));
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::InvalidInput(format!(
            "session_uuid must be alphanumeric with dashes/underscores: {s}"
        )));
    }
    Ok(())
}

fn build_command(req: &ClaudeSpawnRequest, cli_path: &str) -> Result<Command, AppError> {
    validate_extra_args(&req.extra_args)?;
    validate_uuid(&req.session_uuid)?;

    let mut cmd = Command::new(cli_path);
    cmd.arg("-p")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--include-partial-messages")
        .arg("--verbose")
        .arg("--session-id")
        .arg(&req.session_uuid);

    if let Some(sp) = &req.system_prompt {
        if !sp.is_empty() {
            cmd.arg("--append-system-prompt").arg(sp);
        }
    }
    if let Some(mode) = &req.permission_mode {
        if !mode.is_empty() {
            cmd.arg("--permission-mode").arg(mode);
        }
    }
    if let Some(model) = &req.model {
        if !model.is_empty() {
            cmd.arg("--model").arg(model);
        }
    }
    for dir in &req.add_dirs {
        if !dir.is_empty() {
            cmd.arg("--add-dir").arg(dir);
        }
    }
    for arg in &req.extra_args {
        cmd.arg(arg);
    }

    if let Some(cwd) = &req.cwd {
        if !cwd.is_empty() {
            cmd.current_dir(cwd);
        }
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    Ok(cmd)
}

#[tauri::command]
#[specta::specta]
pub async fn claude_cli_spawn(
    app: AppHandle,
    state: State<'_, ClaudeBridgeState>,
    req: ClaudeSpawnRequest,
) -> Result<String, AppError> {
    let cli_path = match req.cli_path.clone() {
        Some(p) if !p.is_empty() => p,
        _ => {
            let detected = claude_cli_detect(state.clone())
                .ok_or_else(|| AppError::Custom("claude CLI not found on PATH".into()))?;
            detected.path
        }
    };

    let session_id = req.session_uuid.clone();
    let mut command = build_command(&req, &cli_path)?;
    let mut child = command
        .spawn()
        .map_err(|e| AppError::Custom(format!("Failed to spawn claude CLI: {e}")))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Custom("claude CLI had no stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Custom("claude CLI had no stderr".into()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Custom("claude CLI had no stdin".into()))?;

    let channel = format!("claude-stream://{session_id}");

    // stdout reader
    {
        let app = app.clone();
        let channel = channel.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app.emit(&channel, ClaudeStreamEvent::StdoutLine { data: line });
            }
        });
    }

    // stderr reader
    {
        let app = app.clone();
        let channel = channel.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app.emit(&channel, ClaudeStreamEvent::StderrLine { data: line });
            }
        });
    }

    // exit watcher: owns the Child, listens for kill signal OR natural exit.
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    {
        let app = app.clone();
        let channel = channel.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let result = tokio::select! {
                res = child.wait() => res.map(|s| s.code()),
                _ = kill_rx => {
                    let _ = child.start_kill();
                    // Give the process up to 2 seconds to terminate gracefully.
                    tokio::select! {
                        res = child.wait() => res.map(|s| s.code()),
                        _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {
                            let _ = child.kill().await;
                            child.wait().await.map(|s| s.code())
                        }
                    }
                }
            };
            match result {
                Ok(code) => {
                    let _ = app.emit(&channel, ClaudeStreamEvent::Exit { code });
                }
                Err(e) => {
                    let _ = app.emit(
                        &channel,
                        ClaudeStreamEvent::Error {
                            message: format!("wait failed: {e}"),
                        },
                    );
                }
            }
            // Remove our session entry post-exit (best effort).
            if let Some(state) = app.try_state::<ClaudeBridgeState>() {
                let mut map = state.sessions.lock().await;
                map.remove(&sid);
            }
        });
    }

    {
        let mut sessions = state.sessions.lock().await;
        sessions.insert(
            session_id.clone(),
            Session {
                stdin,
                kill_tx: Some(kill_tx),
            },
        );
    }

    Ok(session_id)
}

#[tauri::command]
#[specta::specta]
pub async fn claude_cli_send(
    state: State<'_, ClaudeBridgeState>,
    session_id: String,
    line: String,
) -> Result<(), AppError> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| AppError::Custom(format!("Unknown claude session: {session_id}")))?;
    session
        .stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| AppError::Custom(format!("write to claude stdin failed: {e}")))?;
    if !line.ends_with('\n') {
        session
            .stdin
            .write_all(b"\n")
            .await
            .map_err(|e| AppError::Custom(format!("write newline failed: {e}")))?;
    }
    session
        .stdin
        .flush()
        .await
        .map_err(|e| AppError::Custom(format!("flush claude stdin failed: {e}")))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn claude_cli_kill(
    state: State<'_, ClaudeBridgeState>,
    session_id: String,
) -> Result<(), AppError> {
    let mut sessions = state.sessions.lock().await;
    if let Some(mut session) = sessions.remove(&session_id) {
        if let Some(tx) = session.kill_tx.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_req(session: &str) -> ClaudeSpawnRequest {
        ClaudeSpawnRequest {
            cli_path: None,
            cwd: Some("/tmp".into()),
            system_prompt: Some("Be concise.".into()),
            add_dirs: vec!["/tmp/project".into()],
            permission_mode: Some("acceptEdits".into()),
            model: Some("sonnet".into()),
            session_uuid: session.into(),
            extra_args: vec!["--no-chrome".into()],
        }
    }

    #[test]
    fn valid_session_uuid_accepts_standard() {
        assert!(validate_uuid("11111111-2222-3333-4444-555555555555").is_ok());
    }

    #[test]
    fn valid_session_uuid_accepts_generated_ids() {
        assert!(validate_uuid("abc123-def_456").is_ok());
    }

    #[test]
    fn invalid_session_uuid_with_spaces_fails() {
        assert!(validate_uuid("has space").is_err());
    }

    #[test]
    fn invalid_session_uuid_too_short_fails() {
        assert!(validate_uuid("abc").is_err());
    }

    #[test]
    fn extra_args_rejects_managed_flags() {
        let args = vec!["--input-format".into(), "text".into()];
        assert!(validate_extra_args(&args).is_err());
    }

    #[test]
    fn extra_args_allows_benign_flags() {
        let args = vec!["--no-chrome".into()];
        assert!(validate_extra_args(&args).is_ok());
    }

    #[test]
    fn build_command_sets_required_flags() {
        let req = mk_req("11111111-2222-3333-4444-555555555555");
        let cmd = build_command(&req, "/fake/claude").unwrap();
        let std_cmd = cmd.as_std();
        let args: Vec<_> = std_cmd.get_args().collect();
        let mut saw_input = false;
        let mut saw_output = false;
        let mut saw_partial = false;
        let mut saw_session = false;
        for window in args.windows(2) {
            if window[0] == "--input-format" && window[1] == "stream-json" {
                saw_input = true;
            }
            if window[0] == "--output-format" && window[1] == "stream-json" {
                saw_output = true;
            }
            if window[0] == "--session-id" && window[1] == req.session_uuid.as_str() {
                saw_session = true;
            }
        }
        for a in &args {
            if *a == "--include-partial-messages" {
                saw_partial = true;
            }
        }
        assert!(saw_input, "missing --input-format stream-json");
        assert!(saw_output, "missing --output-format stream-json");
        assert!(saw_partial, "missing --include-partial-messages");
        assert!(saw_session, "missing --session-id");
    }

    #[test]
    fn candidate_paths_includes_path_entries() {
        std::env::set_var("PATH", "/tmp/one:/tmp/two");
        let c = candidate_paths();
        let strs: Vec<String> = c.iter().map(|p| p.to_string_lossy().to_string()).collect();
        assert!(strs.iter().any(|s| s.contains("/tmp/one")));
        assert!(strs.iter().any(|s| s.contains("/tmp/two")));
    }

    #[test]
    fn candidate_paths_includes_node_manager_dirs() {
        use std::path::Path;
        let c = candidate_paths();
        // Spot-check that we scan common Node version manager locations.
        // Use Path::ends_with so it compares components (cross-platform).
        assert!(c.iter().any(|p| p.ends_with(Path::new(".volta/bin/claude"))));
        assert!(c.iter().any(|p| p.ends_with(Path::new(".bun/bin/claude"))));
        assert!(c.iter().any(|p| p.ends_with(Path::new(".asdf/shims/claude"))));
    }
}
