//! Bridge to the locally-installed OpenAI `codex` CLI.
//!
//! Unlike the Claude bridge (a long-lived process fed stream-JSON over stdin),
//! `codex exec` is **one-shot per turn**: it runs a single prompt, streams
//! JSONL events to stdout, then exits. A multi-turn conversation is continued
//! with `codex exec resume <thread_id>`. So each `codex_cli_turn` spawns a
//! fresh child, writes the prompt to its stdin (then closes stdin so Codex
//! stops waiting for input), and multiplexes stdout/stderr into Tauri events
//! on `codex-stream://{session_uuid}`. The frontend captures the `thread_id`
//! from the first `thread.started` event and passes it back as
//! `resume_thread_id` on subsequent turns.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;

use crate::commands::claude_bridge::DetectedCli;
use crate::error::AppError;

#[derive(Debug, Deserialize, Type)]
pub struct CodexTurnRequest {
    /// Override the auto-detected CLI path.
    pub cli_path: Option<String>,
    /// Working directory / agent workspace root.
    pub cwd: Option<String>,
    /// Model id (passed as `-m`). Empty/None → Codex picks its default.
    pub model: Option<String>,
    /// Sandbox policy: "read-only", "workspace-write", or "danger-full-access".
    pub sandbox: Option<String>,
    /// Extra writable directories (`--add-dir`).
    pub add_dirs: Vec<String>,
    /// The user prompt for this turn (sent via stdin).
    pub prompt: String,
    /// When set, resume the existing Codex conversation
    /// (`codex exec … resume <thread_id>`) instead of starting a new one.
    pub resume_thread_id: Option<String>,
    /// Caller-owned id used to key the Tauri event channel + kill registry.
    pub session_uuid: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CodexStreamEvent {
    StdoutLine { data: String },
    StderrLine { data: String },
    Exit { code: Option<i32> },
    Error { message: String },
}

struct Turn {
    kill_tx: Option<oneshot::Sender<()>>,
}

pub struct CodexBridgeState {
    /// In-flight turns keyed by `session_uuid`. A session has at most one
    /// live turn at a time (the frontend serializes turns).
    turns: AsyncMutex<HashMap<String, Turn>>,
    /// Cached detection so repeated calls don't walk the filesystem.
    detected: Mutex<Option<Option<DetectedCli>>>,
}

impl CodexBridgeState {
    pub fn new() -> Self {
        Self {
            turns: AsyncMutex::new(HashMap::new()),
            detected: Mutex::new(None),
        }
    }
}

impl Default for CodexBridgeState {
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

fn bin_name() -> &'static str {
    if cfg!(windows) {
        "codex.exe"
    } else {
        "codex"
    }
}

fn candidate_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let home = dirs::home_dir();
    let bin = bin_name();

    if let Ok(path_env) = std::env::var("PATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in path_env.split(sep) {
            if dir.is_empty() {
                continue;
            }
            let mut p = PathBuf::from(dir);
            p.push(bin);
            out.push(p);
        }
    }

    if let Some(h) = home.as_ref() {
        out.push(h.join(".local").join("bin").join(bin));
        // Volta / fnm / asdf / bun — stable bin dirs
        out.push(h.join(".volta").join("bin").join(bin));
        out.push(h.join(".fnm").join("current").join("bin").join(bin));
        out.push(h.join(".asdf").join("shims").join(bin));
        out.push(h.join(".bun").join("bin").join(bin));
        // nvm: iterate all installed Node versions under ~/.nvm/versions/node/
        let nvm_dir = h.join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(&nvm_dir) {
            for entry in entries.flatten() {
                out.push(entry.path().join("bin").join(bin));
            }
        }
        out.push(h.join(".npm-global").join("bin").join(bin));
    }

    // Homebrew (macOS Intel + Apple Silicon, Linux)
    out.push(PathBuf::from("/opt/homebrew/bin").join(bin));
    out.push(PathBuf::from("/usr/local/bin").join(bin));
    out.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin").join(bin));

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
pub fn codex_cli_detect(state: State<'_, CodexBridgeState>) -> Option<DetectedCli> {
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

// ------------------------- turn / kill -------------------------

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

/// Allowed sandbox values (passed through to `codex -s`).
fn normalize_sandbox(mode: &Option<String>) -> &'static str {
    match mode.as_deref() {
        Some("read-only") => "read-only",
        Some("danger-full-access") => "danger-full-access",
        // Default + "workspace-write" → workspace-write.
        _ => "workspace-write",
    }
}

fn build_command(req: &CodexTurnRequest, cli_path: &str) -> Result<Command, AppError> {
    validate_uuid(&req.session_uuid)?;
    if let Some(id) = &req.resume_thread_id {
        validate_uuid(id)?;
    }

    let mut cmd = Command::new(cli_path);
    // exec-level OPTIONS come before the optional `resume` subcommand and the
    // trailing PROMPT positional.
    cmd.arg("exec").arg("--json");

    if let Some(model) = &req.model {
        if !model.is_empty() {
            cmd.arg("-m").arg(model);
        }
    }
    cmd.arg("-s").arg(normalize_sandbox(&req.sandbox));

    if let Some(cwd) = &req.cwd {
        if !cwd.is_empty() {
            cmd.arg("-C").arg(cwd);
            cmd.current_dir(cwd);
        }
    }
    for dir in &req.add_dirs {
        if !dir.is_empty() {
            cmd.arg("--add-dir").arg(dir);
        }
    }
    // Novelist projects are often not git repos; don't let Codex refuse.
    cmd.arg("--skip-git-repo-check");

    if let Some(id) = &req.resume_thread_id {
        if !id.is_empty() {
            cmd.arg("resume").arg(id);
        }
    }

    // `-` makes Codex read the prompt from stdin (avoids arg-escaping and
    // shell length limits for large packed prompts).
    cmd.arg("-");

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    Ok(cmd)
}

#[tauri::command]
#[specta::specta]
pub async fn codex_cli_turn(
    app: AppHandle,
    state: State<'_, CodexBridgeState>,
    req: CodexTurnRequest,
) -> Result<String, AppError> {
    let cli_path = match req.cli_path.clone() {
        Some(p) if !p.is_empty() => p,
        _ => {
            let detected = codex_cli_detect(state.clone())
                .ok_or_else(|| AppError::Custom("codex CLI not found on PATH".into()))?;
            detected.path
        }
    };

    let session_id = req.session_uuid.clone();
    let prompt = req.prompt.clone();
    let mut command = build_command(&req, &cli_path)?;
    let mut child = command
        .spawn()
        .map_err(|e| AppError::Custom(format!("Failed to spawn codex CLI: {e}")))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Custom("codex CLI had no stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Custom("codex CLI had no stderr".into()))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Custom("codex CLI had no stdin".into()))?;

    // Write the prompt then CLOSE stdin so `codex exec -` stops waiting.
    stdin
        .write_all(prompt.as_bytes())
        .await
        .map_err(|e| AppError::Custom(format!("write to codex stdin failed: {e}")))?;
    drop(stdin);

    let channel = format!("codex-stream://{session_id}");

    // stdout reader
    {
        let app = app.clone();
        let channel = channel.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app.emit(&channel, CodexStreamEvent::StdoutLine { data: line });
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
                let _ = app.emit(&channel, CodexStreamEvent::StderrLine { data: line });
            }
        });
    }

    // Register the kill handle BEFORE starting the exit watcher so a kill that
    // races an instant exit can't leave a stale entry behind.
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    {
        let mut turns = state.turns.lock().await;
        // Replace any prior (stale) turn for this session.
        turns.insert(
            session_id.clone(),
            Turn {
                kill_tx: Some(kill_tx),
            },
        );
    }

    // exit watcher: owns the Child, listens for kill signal OR natural exit.
    {
        let app = app.clone();
        let channel = channel.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let result = tokio::select! {
                res = child.wait() => res.map(|s| s.code()),
                _ = kill_rx => {
                    let _ = child.start_kill();
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
                    let _ = app.emit(&channel, CodexStreamEvent::Exit { code });
                }
                Err(e) => {
                    let _ = app.emit(
                        &channel,
                        CodexStreamEvent::Error {
                            message: format!("wait failed: {e}"),
                        },
                    );
                }
            }
            if let Some(state) = app.try_state::<CodexBridgeState>() {
                let mut map = state.turns.lock().await;
                map.remove(&sid);
            }
        });
    }

    Ok(session_id)
}

#[tauri::command]
#[specta::specta]
pub async fn codex_cli_kill(
    state: State<'_, CodexBridgeState>,
    session_id: String,
) -> Result<(), AppError> {
    let mut turns = state.turns.lock().await;
    if let Some(mut turn) = turns.remove(&session_id) {
        if let Some(tx) = turn.kill_tx.take() {
            let _ = tx.send(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_req(session: &str) -> CodexTurnRequest {
        CodexTurnRequest {
            cli_path: None,
            cwd: Some("/tmp/project".into()),
            model: Some("gpt-5-codex".into()),
            sandbox: Some("workspace-write".into()),
            add_dirs: vec!["/tmp/extra".into()],
            prompt: "hello".into(),
            resume_thread_id: None,
            session_uuid: session.into(),
        }
    }

    fn args_of(cmd: &Command) -> Vec<String> {
        cmd.as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn build_command_fresh_turn_shape() {
        let req = mk_req("11111111-2222-3333-4444-555555555555");
        let cmd = build_command(&req, "/fake/codex").unwrap();
        let args = args_of(&cmd);
        assert_eq!(args.first().map(String::as_str), Some("exec"));
        assert!(args.iter().any(|a| a == "--json"));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-m" && w[1] == "gpt-5-codex"));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-s" && w[1] == "workspace-write"));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "-C" && w[1] == "/tmp/project"));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--add-dir" && w[1] == "/tmp/extra"));
        assert!(args.iter().any(|a| a == "--skip-git-repo-check"));
        assert!(!args.iter().any(|a| a == "resume"));
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn build_command_resume_inserts_subcommand() {
        let mut req = mk_req("11111111-2222-3333-4444-555555555555");
        req.resume_thread_id = Some("99999999-8888-7777-6666-555555555555".into());
        let cmd = build_command(&req, "/fake/codex").unwrap();
        let args = args_of(&cmd);
        assert!(args
            .windows(2)
            .any(|w| w[0] == "resume" && w[1] == "99999999-8888-7777-6666-555555555555"));
        // PROMPT positional `-` stays last (after the resume subcommand + id).
        assert_eq!(args.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn sandbox_defaults_to_workspace_write() {
        assert_eq!(normalize_sandbox(&None), "workspace-write");
        assert_eq!(
            normalize_sandbox(&Some("workspace-write".into())),
            "workspace-write"
        );
        assert_eq!(normalize_sandbox(&Some("read-only".into())), "read-only");
        assert_eq!(
            normalize_sandbox(&Some("danger-full-access".into())),
            "danger-full-access"
        );
        // Unknown values fall back to the safe-ish default.
        assert_eq!(
            normalize_sandbox(&Some("nonsense".into())),
            "workspace-write"
        );
    }

    #[test]
    fn plan_mode_read_only_sandbox() {
        let mut req = mk_req("11111111-2222-3333-4444-555555555555");
        req.sandbox = Some("read-only".into());
        let cmd = build_command(&req, "/fake/codex").unwrap();
        let args = args_of(&cmd);
        assert!(args.windows(2).any(|w| w[0] == "-s" && w[1] == "read-only"));
    }

    #[test]
    fn invalid_session_uuid_rejected() {
        let mut req = mk_req("has space!");
        req.session_uuid = "has space!".into();
        assert!(build_command(&req, "/fake/codex").is_err());
    }

    #[test]
    fn candidate_paths_includes_path_and_node_dirs() {
        use std::path::Path;
        // Use the platform PATH separator and the platform binary name so the
        // assertions hold on Windows too (where bin_name() is `codex.exe`).
        let sep = if cfg!(windows) { ";" } else { ":" };
        std::env::set_var("PATH", format!("/tmp/one{sep}/tmp/two"));
        let bin = bin_name();
        let c = candidate_paths();
        let strs: Vec<String> = c.iter().map(|p| p.to_string_lossy().to_string()).collect();
        assert!(strs.iter().any(|s| s.contains("/tmp/one")));
        assert!(c
            .iter()
            .any(|p| p.ends_with(Path::new(&format!(".volta/bin/{bin}")))));
        assert!(c
            .iter()
            .any(|p| p.ends_with(Path::new(&format!(".bun/bin/{bin}")))));
    }
}
