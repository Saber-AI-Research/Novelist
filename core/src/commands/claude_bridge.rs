//! Bridge to the locally-installed `claude` Code CLI.
//!
//! Plugins with the `ai:claude-cli` permission can spawn a Claude session
//! and exchange stream-JSON messages. Each session is keyed by the owning
//! webview label plus a plugin-supplied UUID so callers can correlate output events. The Rust side
//! owns `tokio::process::Child` handles and multiplexes stdout/stderr into
//! Tauri events on `claude-stream://{session_id}`.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

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
    /// Resume an existing CLI conversation instead of creating a new one.
    /// The CLI rejects `--session-id` values it has already seen (the
    /// process exits immediately, which surfaced as "Unknown claude
    /// session" on the next send), so re-spawns of a session that already
    /// produced output MUST pass `--resume` instead.
    #[serde(default)]
    pub resume: bool,
    /// Extra CLI args (escape hatch). Validated against a blocklist of
    /// flags we manage ourselves.
    pub extra_args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ClaudeStreamEvent {
    StdoutLine {
        target_label: String,
        data: String,
    },
    StderrLine {
        target_label: String,
        data: String,
    },
    Exit {
        target_label: String,
        code: Option<i32>,
    },
    Error {
        target_label: String,
        message: String,
    },
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RuntimeKey {
    owner_label: String,
    session_uuid: String,
}

impl RuntimeKey {
    fn new(owner_label: &str, session_uuid: &str) -> Self {
        Self {
            owner_label: owner_label.to_string(),
            session_uuid: session_uuid.to_string(),
        }
    }
}

struct Session {
    stdin: Option<Arc<AsyncMutex<ChildStdin>>>,
    generation: u64,
    kill_tx: Option<oneshot::Sender<()>>,
    completion_rx: watch::Receiver<bool>,
    retiring: bool,
}

#[derive(Default)]
struct ClaudeRegistry {
    sessions: HashMap<RuntimeKey, Session>,
    closed_owners: HashSet<String>,
}

pub struct ClaudeBridgeState {
    registry: Mutex<ClaudeRegistry>,
    next_generation: AtomicU64,
    /// Cached detection so repeated calls don't walk the filesystem.
    detected: Mutex<Option<Option<DetectedCli>>>,
}

impl ClaudeBridgeState {
    pub fn new() -> Self {
        Self {
            registry: Mutex::new(ClaudeRegistry::default()),
            next_generation: AtomicU64::new(1),
            detected: Mutex::new(None),
        }
    }

    pub(crate) fn tombstone_owner(&self, owner_label: &str) {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .closed_owners
            .insert(owner_label.to_string());
    }

    pub(crate) async fn drain_owner(&self, owner_label: &str) {
        let pending = {
            let mut registry = self
                .registry
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            registry.closed_owners.insert(owner_label.to_string());
            registry
                .sessions
                .iter_mut()
                .filter(|(key, _)| key.owner_label == owner_label)
                .map(|(_, session)| {
                    let completion_rx = session.completion_rx.clone();
                    if session.retiring {
                        (None, None, completion_rx)
                    } else {
                        session.retiring = true;
                        (session.stdin.take(), session.kill_tx.take(), completion_rx)
                    }
                })
                .collect::<Vec<_>>()
        };

        let mut completions = Vec::with_capacity(pending.len());
        for (stdin, kill_tx, completion_rx) in pending {
            drop(stdin);
            if let Some(tx) = kill_tx {
                let _ = tx.send(());
            }
            completions.push(completion_rx);
        }
        for completion_rx in completions {
            await_watcher_completion(completion_rx).await;
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

/// Platform binary name for the Claude CLI. On Windows the executable is
/// `claude.exe`; every candidate path must use this or detection silently
/// fails for CLIs installed outside PATH (volta/bun/nvm/npm-global/Homebrew).
fn bin_name() -> &'static str {
    if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
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
        out.push(h.join(".claude").join("local").join(bin));
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
        // Global npm prefixes (when set via NPM_CONFIG_PREFIX or default npm root -g)
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
const CHILD_REAP_TIMEOUT: Duration = Duration::from_secs(2);
const PIPE_TASK_SETTLE_TIMEOUT: Duration = Duration::from_millis(250);

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
        .arg("--verbose");
    if req.resume {
        cmd.arg("--resume").arg(&req.session_uuid);
    } else {
        cmd.arg("--session-id").arg(&req.session_uuid);
    }

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

fn ensure_session_key_available(
    registry: &ClaudeRegistry,
    key: &RuntimeKey,
) -> Result<(), AppError> {
    if registry.closed_owners.contains(&key.owner_label) {
        return Err(AppError::Custom("Owning window is closed".into()));
    }
    if registry.sessions.contains_key(key) {
        return Err(AppError::Custom(format!(
            "Claude session already active: {}",
            key.session_uuid
        )));
    }
    Ok(())
}

async fn settle_pipe_tasks(mut tasks: Vec<JoinHandle<()>>, explicitly_killed: bool) {
    if explicitly_killed {
        for task in &tasks {
            task.abort();
        }
        for task in &mut tasks {
            let _ = task.await;
        }
        return;
    }

    let joined = tokio::time::timeout(PIPE_TASK_SETTLE_TIMEOUT, async {
        for task in &mut tasks {
            let _ = task.await;
        }
    })
    .await;
    if joined.is_err() {
        for task in &tasks {
            task.abort();
        }
        for task in &mut tasks {
            let _ = task.await;
        }
    }
}

async fn retire_session_if_owned<F>(
    state: &ClaudeBridgeState,
    key: &RuntimeKey,
    generation: u64,
    emit_terminal: F,
) -> bool
where
    F: FnOnce(),
{
    let mut registry = state
        .registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if registry.sessions.get(key).map(|session| session.generation) != Some(generation) {
        return false;
    }
    if !registry.sessions[key].retiring {
        emit_terminal();
    }
    registry.sessions.remove(key);
    true
}

async fn await_watcher_completion(mut completion_rx: watch::Receiver<bool>) {
    loop {
        if *completion_rx.borrow_and_update() {
            return;
        }
        if completion_rx.changed().await.is_err() {
            return;
        }
    }
}

async fn claude_cli_kill_inner(
    state: &ClaudeBridgeState,
    key: &RuntimeKey,
) -> Result<(), AppError> {
    let (stdin, kill_tx, completion_rx) = {
        let mut registry = state
            .registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(session) = registry.sessions.get_mut(key) else {
            return Ok(());
        };
        let completion_rx = session.completion_rx.clone();
        if session.retiring {
            (None, None, completion_rx)
        } else {
            session.retiring = true;
            (session.stdin.take(), session.kill_tx.take(), completion_rx)
        }
    };

    drop(stdin);
    if let Some(tx) = kill_tx {
        let _ = tx.send(());
    }
    await_watcher_completion(completion_rx).await;
    Ok(())
}

async fn claude_cli_send_inner(
    state: &ClaudeBridgeState,
    key: &RuntimeKey,
    line: &str,
) -> Result<(), AppError> {
    let stdin = {
        let registry = state
            .registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if registry.closed_owners.contains(&key.owner_label) {
            None
        } else {
            registry
                .sessions
                .get(key)
                .filter(|session| !session.retiring)
                .and_then(|session| session.stdin.clone())
        }
    }
    .ok_or_else(|| AppError::Custom(format!("Unknown claude session: {}", key.session_uuid)))?;

    let mut stdin = stdin.lock().await;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| AppError::Custom(format!("write to claude stdin failed: {e}")))?;
    if !line.ends_with('\n') {
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| AppError::Custom(format!("write newline failed: {e}")))?;
    }
    stdin
        .flush()
        .await
        .map_err(|e| AppError::Custom(format!("flush claude stdin failed: {e}")))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn claude_cli_spawn(
    window: WebviewWindow,
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
    let key = RuntimeKey::new(window.label(), &session_id);
    let owner_label = key.owner_label.clone();
    let mut command = build_command(&req, &cli_path)?;
    let mut registry = state
        .registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ensure_session_key_available(&registry, &key)?;
    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed);
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

    let stdout_task = {
        let app = app.clone();
        let channel = channel.clone();
        let owner_label = owner_label.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app.emit_to(
                    owner_label.as_str(),
                    &channel,
                    ClaudeStreamEvent::StdoutLine {
                        target_label: owner_label.clone(),
                        data: line,
                    },
                );
            }
        })
    };

    let stderr_task = {
        let app = app.clone();
        let channel = channel.clone();
        let owner_label = owner_label.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let _ = app.emit_to(
                    owner_label.as_str(),
                    &channel,
                    ClaudeStreamEvent::StderrLine {
                        target_label: owner_label.clone(),
                        data: line,
                    },
                );
            }
        })
    };

    // Register the session BEFORE starting the exit watcher. If the CLI
    // dies instantly (bad flags, rejected --session-id), the watcher's
    // cleanup must not race ahead of the insertion and leave a stale
    // entry with a dead stdin behind.
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let (completion_tx, completion_rx) = watch::channel(false);
    registry.sessions.insert(
        key.clone(),
        Session {
            stdin: Some(Arc::new(AsyncMutex::new(stdin))),
            generation,
            kill_tx: Some(kill_tx),
            completion_rx,
            retiring: false,
        },
    );
    drop(registry);

    // exit watcher: owns the Child, listens for kill signal OR natural exit.
    {
        let app = app.clone();
        let channel = channel.clone();
        let watcher_key = key.clone();
        let owner_label = owner_label.clone();
        tokio::spawn(async move {
            let (result, explicitly_killed) = tokio::select! {
                res = child.wait() => (res.map(|s| s.code()), false),
                _ = kill_rx => {
                    let _ = child.start_kill();
                    let result = match tokio::time::timeout(CHILD_REAP_TIMEOUT, child.wait()).await {
                        Ok(res) => res.map(|s| s.code()),
                        Err(_) => {
                            let _ = child.kill().await;
                            child.wait().await.map(|s| s.code())
                        }
                    };
                    (result, true)
                }
            };
            settle_pipe_tasks(vec![stdout_task, stderr_task], explicitly_killed).await;
            if let Some(state) = app.try_state::<ClaudeBridgeState>() {
                let emit_app = app.clone();
                let emit_channel = channel.clone();
                let _ =
                    retire_session_if_owned(
                        &state,
                        &watcher_key,
                        generation,
                        move || match result {
                            Ok(code) => {
                                let _ = emit_app.emit_to(
                                    owner_label.as_str(),
                                    &emit_channel,
                                    ClaudeStreamEvent::Exit {
                                        target_label: owner_label.clone(),
                                        code,
                                    },
                                );
                            }
                            Err(e) => {
                                let _ = emit_app.emit_to(
                                    owner_label.as_str(),
                                    &emit_channel,
                                    ClaudeStreamEvent::Error {
                                        target_label: owner_label.clone(),
                                        message: format!("wait failed: {e}"),
                                    },
                                );
                            }
                        },
                    )
                    .await;
            }
            let _ = completion_tx.send(true);
        });
    }

    Ok(session_id)
}

#[tauri::command]
#[specta::specta]
pub async fn claude_cli_send(
    window: WebviewWindow,
    state: State<'_, ClaudeBridgeState>,
    session_id: String,
    line: String,
) -> Result<(), AppError> {
    let key = RuntimeKey::new(window.label(), &session_id);
    claude_cli_send_inner(&state, &key, &line).await
}

#[tauri::command]
#[specta::specta]
pub async fn claude_cli_kill(
    window: WebviewWindow,
    state: State<'_, ClaudeBridgeState>,
    session_id: String,
) -> Result<(), AppError> {
    let key = RuntimeKey::new(window.label(), &session_id);
    claude_cli_kill_inner(&state, &key).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);

    struct DropSignal(Option<oneshot::Sender<()>>);

    impl Drop for DropSignal {
        fn drop(&mut self) {
            if let Some(tx) = self.0.take() {
                let _ = tx.send(());
            }
        }
    }

    fn fake_session(
        generation: u64,
        kill_tx: oneshot::Sender<()>,
        completion_rx: watch::Receiver<bool>,
    ) -> Session {
        Session {
            stdin: None,
            generation,
            kill_tx: Some(kill_tx),
            completion_rx,
            retiring: false,
        }
    }

    fn test_key(session_uuid: &str) -> RuntimeKey {
        RuntimeKey::new("owner-a", session_uuid)
    }

    fn mk_req(session: &str) -> ClaudeSpawnRequest {
        ClaudeSpawnRequest {
            cli_path: None,
            cwd: Some("/tmp".into()),
            system_prompt: Some("Be concise.".into()),
            add_dirs: vec!["/tmp/project".into()],
            permission_mode: Some("acceptEdits".into()),
            model: Some("sonnet".into()),
            session_uuid: session.into(),
            resume: false,
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
    fn build_command_resume_uses_resume_flag() {
        let mut req = mk_req("11111111-2222-3333-4444-555555555555");
        req.resume = true;
        let cmd = build_command(&req, "/fake/claude").unwrap();
        let std_cmd = cmd.as_std();
        let args: Vec<_> = std_cmd.get_args().collect();
        let mut saw_resume = false;
        for window in args.windows(2) {
            if window[0] == "--resume" && window[1] == req.session_uuid.as_str() {
                saw_resume = true;
            }
        }
        assert!(saw_resume, "missing --resume <session_uuid>");
        assert!(
            !args.iter().any(|a| *a == "--session-id"),
            "--session-id must not be passed when resuming"
        );
    }

    #[test]
    fn candidate_paths_includes_path_entries() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        std::env::set_var("PATH", format!("/tmp/one{sep}/tmp/two"));
        let c = candidate_paths();
        let strs: Vec<String> = c.iter().map(|p| p.to_string_lossy().to_string()).collect();
        assert!(strs.iter().any(|s| s.contains("/tmp/one")));
        assert!(strs.iter().any(|s| s.contains("/tmp/two")));
    }

    #[test]
    fn candidate_paths_includes_node_manager_dirs() {
        use std::path::Path;
        let c = candidate_paths();
        let bin = bin_name();
        // Spot-check that we scan common Node version manager locations. Assert
        // against bin_name() (claude.exe on Windows) and Path::ends_with so the
        // check compares components and holds cross-platform.
        assert!(c
            .iter()
            .any(|p| p.ends_with(Path::new(&format!(".volta/bin/{bin}")))));
        assert!(c
            .iter()
            .any(|p| p.ends_with(Path::new(&format!(".bun/bin/{bin}")))));
        assert!(c
            .iter()
            .any(|p| p.ends_with(Path::new(&format!(".asdf/shims/{bin}")))));
    }

    #[tokio::test]
    async fn kill_waits_for_watcher_completion() {
        let state = std::sync::Arc::new(ClaudeBridgeState::new());
        let (kill_tx, kill_rx) = oneshot::channel();
        let (completion_tx, completion_rx) = watch::channel(false);
        state.registry.lock().unwrap().sessions.insert(
            test_key("session-1"),
            fake_session(1, kill_tx, completion_rx),
        );

        let kill_state = state.clone();
        let kill_task = tokio::spawn(async move {
            claude_cli_kill_inner(&kill_state, &test_key("session-1")).await
        });

        tokio::time::timeout(TEST_TIMEOUT, kill_rx)
            .await
            .expect("kill signal timed out")
            .expect("kill signal sender dropped");
        tokio::task::yield_now().await;
        assert!(
            !kill_task.is_finished(),
            "kill returned before watcher completion"
        );

        completion_tx.send(true).unwrap();
        tokio::time::timeout(TEST_TIMEOUT, kill_task)
            .await
            .expect("kill did not finish after completion")
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn retiring_uuid_stays_reserved_until_watcher_completion() {
        let state = std::sync::Arc::new(ClaudeBridgeState::new());
        let (kill_tx, kill_rx) = oneshot::channel();
        let (completion_tx, completion_rx) = watch::channel(false);
        state.registry.lock().unwrap().sessions.insert(
            test_key("stable-session"),
            fake_session(1, kill_tx, completion_rx),
        );

        let kill_state = state.clone();
        let kill_task = tokio::spawn(async move {
            claude_cli_kill_inner(&kill_state, &test_key("stable-session")).await
        });
        tokio::time::timeout(TEST_TIMEOUT, kill_rx)
            .await
            .expect("kill signal timed out")
            .expect("kill signal sender dropped");

        {
            let registry = state.registry.lock().unwrap();
            assert!(
                registry.sessions.contains_key(&test_key("stable-session")),
                "kill released UUID ownership before watcher completion"
            );
            assert!(ensure_session_key_available(&registry, &test_key("stable-session")).is_err());
        }
        assert!(!kill_task.is_finished());

        let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stale_emitted = emitted.clone();
        assert!(
            retire_session_if_owned(&state, &test_key("stable-session"), 1, move || {
                stale_emitted.store(true, std::sync::atomic::Ordering::SeqCst);
            })
            .await
        );
        assert!(!emitted.load(std::sync::atomic::Ordering::SeqCst));
        completion_tx.send(true).unwrap();
        tokio::time::timeout(TEST_TIMEOUT, kill_task)
            .await
            .expect("kill did not finish after completion")
            .unwrap()
            .unwrap();

        let registry = state.registry.lock().unwrap();
        assert!(ensure_session_key_available(&registry, &test_key("stable-session")).is_ok());
    }

    #[tokio::test]
    async fn concurrent_kills_wait_for_the_same_retirement() {
        let state = std::sync::Arc::new(ClaudeBridgeState::new());
        let (kill_tx, kill_rx) = oneshot::channel();
        let (completion_tx, completion_rx) = watch::channel(false);
        state.registry.lock().unwrap().sessions.insert(
            test_key("stable-session"),
            fake_session(1, kill_tx, completion_rx),
        );

        let first_state = state.clone();
        let first_kill = tokio::spawn(async move {
            claude_cli_kill_inner(&first_state, &test_key("stable-session")).await
        });
        tokio::time::timeout(TEST_TIMEOUT, kill_rx)
            .await
            .expect("kill signal timed out")
            .expect("kill signal sender dropped");

        let second_state = state.clone();
        let second_kill = tokio::spawn(async move {
            claude_cli_kill_inner(&second_state, &test_key("stable-session")).await
        });
        tokio::task::yield_now().await;
        assert!(!first_kill.is_finished());
        assert!(
            !second_kill.is_finished(),
            "duplicate kill returned before shared retirement completed"
        );
        assert!(state
            .registry
            .lock()
            .unwrap()
            .sessions
            .contains_key(&test_key("stable-session")));

        assert!(
            retire_session_if_owned(&state, &test_key("stable-session"), 1, || {
                panic!("explicit kill must not emit a terminal event")
            })
            .await
        );
        completion_tx.send(true).unwrap();
        for task in [first_kill, second_kill] {
            tokio::time::timeout(TEST_TIMEOUT, task)
                .await
                .expect("kill did not finish after shared completion")
                .unwrap()
                .unwrap();
        }
    }

    #[tokio::test]
    async fn unknown_kill_is_idempotent() {
        let state = ClaudeBridgeState::new();
        tokio::time::timeout(
            TEST_TIMEOUT,
            claude_cli_kill_inner(&state, &test_key("unknown-session")),
        )
        .await
        .expect("unknown kill timed out")
        .unwrap();
    }

    #[tokio::test]
    async fn stale_generation_cannot_emit_or_remove_replacement() {
        let state = ClaudeBridgeState::new();
        let (kill_tx, _kill_rx) = oneshot::channel();
        let (_completion_tx, completion_rx) = watch::channel(false);
        state.registry.lock().unwrap().sessions.insert(
            test_key("stable-session"),
            fake_session(2, kill_tx, completion_rx),
        );
        let emitted = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let stale_emitted = emitted.clone();
        let retired = retire_session_if_owned(&state, &test_key("stable-session"), 1, move || {
            stale_emitted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
        .await;
        assert!(!retired);
        assert_eq!(emitted.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(
            state
                .registry
                .lock()
                .unwrap()
                .sessions
                .get(&test_key("stable-session"))
                .map(|session| session.generation),
            Some(2)
        );

        let current_emitted = emitted.clone();
        let retired = retire_session_if_owned(&state, &test_key("stable-session"), 2, move || {
            current_emitted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
        .await;
        assert!(retired);
        assert_eq!(emitted.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(!state
            .registry
            .lock()
            .unwrap()
            .sessions
            .contains_key(&test_key("stable-session")));
    }

    #[tokio::test]
    async fn active_uuid_is_rejected_instead_of_overwritten() {
        let state = ClaudeBridgeState::new();
        let (kill_tx, _kill_rx) = oneshot::channel();
        let (_completion_tx, completion_rx) = watch::channel(false);
        let mut registry = state.registry.lock().unwrap();
        registry.sessions.insert(
            test_key("stable-session"),
            fake_session(1, kill_tx, completion_rx),
        );

        assert!(ensure_session_key_available(&registry, &test_key("stable-session")).is_err());
        assert_eq!(registry.sessions[&test_key("stable-session")].generation, 1);
    }

    #[tokio::test]
    async fn reader_settlement_delays_completion_until_reader_joins() {
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let reader = tokio::spawn(async move {
            let _ = started_tx.send(());
            let _ = release_rx.await;
        });
        tokio::time::timeout(TEST_TIMEOUT, started_rx)
            .await
            .expect("reader did not start")
            .unwrap();

        let (completion_tx, mut completion_rx) = oneshot::channel();
        let settle_task = tokio::spawn(async move {
            settle_pipe_tasks(vec![reader], false).await;
            let _ = completion_tx.send(());
        });
        tokio::task::yield_now().await;
        assert!(matches!(
            completion_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        release_tx.send(()).unwrap();
        tokio::time::timeout(TEST_TIMEOUT, &mut completion_rx)
            .await
            .expect("completion timed out")
            .unwrap();
        settle_task.await.unwrap();
    }

    #[tokio::test]
    async fn explicit_kill_aborts_and_awaits_reader_before_completion() {
        let (started_tx, started_rx) = oneshot::channel();
        let (dropped_tx, dropped_rx) = oneshot::channel();
        let reader = tokio::spawn(async move {
            let _drop_signal = DropSignal(Some(dropped_tx));
            let _ = started_tx.send(());
            std::future::pending::<()>().await;
        });
        tokio::time::timeout(TEST_TIMEOUT, started_rx)
            .await
            .expect("reader did not start")
            .unwrap();

        let (completion_tx, completion_rx) = oneshot::channel();
        let settle_task = tokio::spawn(async move {
            settle_pipe_tasks(vec![reader], true).await;
            let _ = completion_tx.send(());
        });
        tokio::time::timeout(TEST_TIMEOUT, dropped_rx)
            .await
            .expect("reader was not aborted")
            .unwrap();
        tokio::time::timeout(TEST_TIMEOUT, completion_rx)
            .await
            .expect("completion timed out")
            .unwrap();
        settle_task.await.unwrap();
    }

    #[test]
    fn stream_events_serialize_required_target_label() {
        let events = [
            ClaudeStreamEvent::StdoutLine {
                target_label: "owner-a".into(),
                data: "out".into(),
            },
            ClaudeStreamEvent::StderrLine {
                target_label: "owner-a".into(),
                data: "err".into(),
            },
            ClaudeStreamEvent::Exit {
                target_label: "owner-a".into(),
                code: Some(0),
            },
            ClaudeStreamEvent::Error {
                target_label: "owner-a".into(),
                message: "failed".into(),
            },
        ];
        for event in events {
            let json = serde_json::to_value(event).unwrap();
            assert_eq!(json["target_label"], "owner-a");
            assert!(json.get("targetLabel").is_none());
        }
    }

    #[tokio::test]
    async fn same_uuid_coexists_across_owners_but_duplicates_per_owner_fail() {
        let state = ClaudeBridgeState::new();
        let key_a = RuntimeKey::new("owner-a", "shared-session");
        let key_b = RuntimeKey::new("owner-b", "shared-session");
        let (kill_a, _kill_a_rx) = oneshot::channel();
        let (_done_a, done_a_rx) = watch::channel(false);
        let (kill_b, _kill_b_rx) = oneshot::channel();
        let (_done_b, done_b_rx) = watch::channel(false);
        let mut registry = state.registry.lock().unwrap();
        registry
            .sessions
            .insert(key_a.clone(), fake_session(1, kill_a, done_a_rx));

        assert!(ensure_session_key_available(&registry, &key_a).is_err());
        assert!(ensure_session_key_available(&registry, &key_b).is_ok());
        registry
            .sessions
            .insert(key_b.clone(), fake_session(2, kill_b, done_b_rx));
        assert_eq!(registry.sessions.len(), 2);
    }

    #[tokio::test]
    async fn foreign_send_and_kill_cannot_access_owner_session() {
        let state = ClaudeBridgeState::new();
        let key_a = RuntimeKey::new("owner-a", "shared-session");
        let key_b = RuntimeKey::new("owner-b", "shared-session");
        let (kill_tx, mut kill_rx) = oneshot::channel();
        let (_done_tx, done_rx) = watch::channel(false);
        state
            .registry
            .lock()
            .unwrap()
            .sessions
            .insert(key_a, fake_session(1, kill_tx, done_rx));

        let send_error = claude_cli_send_inner(&state, &key_b, "hello")
            .await
            .unwrap_err()
            .to_string();
        assert!(send_error.contains("Unknown claude session: shared-session"));
        claude_cli_kill_inner(&state, &key_b).await.unwrap();
        assert!(matches!(
            kill_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn destroyed_owner_tombstone_rejects_delayed_reservation_only_for_owner() {
        let state = ClaudeBridgeState::new();
        state.tombstone_owner("owner-a");
        let registry = state.registry.lock().unwrap();
        assert!(ensure_session_key_available(
            &registry,
            &RuntimeKey::new("owner-a", "late-session")
        )
        .is_err());
        assert!(ensure_session_key_available(
            &registry,
            &RuntimeKey::new("owner-b", "late-session")
        )
        .is_ok());
    }

    #[tokio::test]
    async fn owner_drain_signals_only_owner_and_waits_for_completion() {
        let state = std::sync::Arc::new(ClaudeBridgeState::new());
        let key_a = RuntimeKey::new("owner-a", "shared-session");
        let key_b = RuntimeKey::new("owner-b", "shared-session");
        let (kill_a, kill_a_rx) = oneshot::channel();
        let (done_a, done_a_rx) = watch::channel(false);
        let (kill_b, mut kill_b_rx) = oneshot::channel();
        let (_done_b, done_b_rx) = watch::channel(false);
        {
            let mut registry = state.registry.lock().unwrap();
            registry
                .sessions
                .insert(key_a.clone(), fake_session(1, kill_a, done_a_rx));
            registry
                .sessions
                .insert(key_b.clone(), fake_session(2, kill_b, done_b_rx));
        }
        state.tombstone_owner("owner-a");
        let drain_state = state.clone();
        let drain = tokio::spawn(async move { drain_state.drain_owner("owner-a").await });

        tokio::time::timeout(TEST_TIMEOUT, kill_a_rx)
            .await
            .expect("owner drain did not signal kill")
            .unwrap();
        let second_drain_state = state.clone();
        let second_drain =
            tokio::spawn(async move { second_drain_state.drain_owner("owner-a").await });
        tokio::task::yield_now().await;
        assert!(matches!(
            kill_b_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert!(!drain.is_finished());
        assert!(!second_drain.is_finished());

        assert!(retire_session_if_owned(&state, &key_a, 1, || {}).await);
        done_a.send(true).unwrap();
        for drain in [drain, second_drain] {
            tokio::time::timeout(TEST_TIMEOUT, drain)
                .await
                .expect("owner drain did not finish")
                .unwrap();
        }
        let registry = state.registry.lock().unwrap();
        assert!(!registry.sessions.contains_key(&key_a));
        assert!(registry.sessions.contains_key(&key_b));
    }
}
