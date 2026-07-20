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

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

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

struct Turn {
    generation: u64,
    kill_tx: Option<oneshot::Sender<()>>,
    completion_rx: watch::Receiver<bool>,
    retiring: bool,
}

#[derive(Default)]
struct CodexRegistry {
    turns: HashMap<RuntimeKey, Turn>,
    closed_owners: HashSet<String>,
}

pub struct CodexBridgeState {
    /// In-flight turns keyed by `session_uuid`. A session has at most one
    /// live turn at a time (the frontend serializes turns).
    registry: Mutex<CodexRegistry>,
    next_generation: AtomicU64,
    /// Cached detection so repeated calls don't walk the filesystem.
    detected: Mutex<Option<Option<DetectedCli>>>,
}

impl CodexBridgeState {
    pub fn new() -> Self {
        Self {
            registry: Mutex::new(CodexRegistry::default()),
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
                .turns
                .iter_mut()
                .filter(|(key, _)| key.owner_label == owner_label)
                .map(|(_, turn)| {
                    let completion_rx = turn.completion_rx.clone();
                    if turn.retiring {
                        (None, completion_rx)
                    } else {
                        turn.retiring = true;
                        (turn.kill_tx.take(), completion_rx)
                    }
                })
                .collect::<Vec<_>>()
        };

        let mut completions = Vec::with_capacity(pending.len());
        for (kill_tx, completion_rx) in pending {
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

const CHILD_REAP_TIMEOUT: Duration = Duration::from_secs(2);
const PIPE_TASK_SETTLE_TIMEOUT: Duration = Duration::from_millis(250);

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

fn ensure_turn_key_available(registry: &CodexRegistry, key: &RuntimeKey) -> Result<(), AppError> {
    if registry.closed_owners.contains(&key.owner_label) {
        return Err(AppError::Custom("Owning window is closed".into()));
    }
    if registry.turns.contains_key(key) {
        return Err(AppError::Custom(format!(
            "Codex turn already active: {}",
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

async fn retire_turn_if_owned<F>(
    state: &CodexBridgeState,
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
    if registry.turns.get(key).map(|turn| turn.generation) != Some(generation) {
        return false;
    }
    if !registry.turns[key].retiring {
        emit_terminal();
    }
    registry.turns.remove(key);
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

async fn codex_cli_kill_inner(state: &CodexBridgeState, key: &RuntimeKey) -> Result<(), AppError> {
    let (kill_tx, completion_rx) = {
        let mut registry = state
            .registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(turn) = registry.turns.get_mut(key) else {
            return Ok(());
        };
        let completion_rx = turn.completion_rx.clone();
        if turn.retiring {
            (None, completion_rx)
        } else {
            turn.retiring = true;
            (turn.kill_tx.take(), completion_rx)
        }
    };

    if let Some(tx) = kill_tx {
        let _ = tx.send(());
    }
    await_watcher_completion(completion_rx).await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn codex_cli_turn(
    window: WebviewWindow,
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
    let key = RuntimeKey::new(window.label(), &session_id);
    let owner_label = key.owner_label.clone();
    let prompt = req.prompt.clone();
    let mut command = build_command(&req, &cli_path)?;
    let mut registry = state
        .registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ensure_turn_key_available(&registry, &key)?;
    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed);
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

    let channel = format!("codex-stream://{session_id}");

    // stdout reader — spawned BEFORE writing the prompt so stdout drains
    // concurrently. Writing the whole (possibly large) packed prompt to stdin
    // up front would otherwise deadlock: codex can begin emitting JSONL before
    // it finishes reading stdin, fill the stdout pipe buffer, block on its own
    // write, stop reading stdin, and leave our write_all stuck forever.
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
                    CodexStreamEvent::StdoutLine {
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
                    CodexStreamEvent::StderrLine {
                        target_label: owner_label.clone(),
                        data: line,
                    },
                );
            }
        })
    };

    // Write the prompt then CLOSE stdin so `codex exec -` stops waiting. Done in
    // a detached task so it runs concurrently with the stdout reader above.
    let stdin_task = {
        let app = app.clone();
        let channel = channel.clone();
        let owner_label = owner_label.clone();
        tokio::spawn(async move {
            if let Err(e) = stdin.write_all(prompt.as_bytes()).await {
                let _ = app.emit_to(
                    owner_label.as_str(),
                    &channel,
                    CodexStreamEvent::StderrLine {
                        target_label: owner_label.clone(),
                        data: format!("write to codex stdin failed: {e}"),
                    },
                );
            }
            drop(stdin);
        })
    };

    // Register the kill handle BEFORE starting the exit watcher so a kill that
    // races an instant exit can't leave a stale entry behind.
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let (completion_tx, completion_rx) = watch::channel(false);
    registry.turns.insert(
        key.clone(),
        Turn {
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
            settle_pipe_tasks(
                vec![stdout_task, stderr_task, stdin_task],
                explicitly_killed,
            )
            .await;
            if let Some(state) = app.try_state::<CodexBridgeState>() {
                let emit_app = app.clone();
                let emit_channel = channel.clone();
                let _ =
                    retire_turn_if_owned(&state, &watcher_key, generation, move || match result {
                        Ok(code) => {
                            let _ = emit_app.emit_to(
                                owner_label.as_str(),
                                &emit_channel,
                                CodexStreamEvent::Exit {
                                    target_label: owner_label.clone(),
                                    code,
                                },
                            );
                        }
                        Err(e) => {
                            let _ = emit_app.emit_to(
                                owner_label.as_str(),
                                &emit_channel,
                                CodexStreamEvent::Error {
                                    target_label: owner_label.clone(),
                                    message: format!("wait failed: {e}"),
                                },
                            );
                        }
                    })
                    .await;
            }
            let _ = completion_tx.send(true);
        });
    }

    Ok(session_id)
}

#[tauri::command]
#[specta::specta]
pub async fn codex_cli_kill(
    window: WebviewWindow,
    state: State<'_, CodexBridgeState>,
    session_id: String,
) -> Result<(), AppError> {
    let key = RuntimeKey::new(window.label(), &session_id);
    codex_cli_kill_inner(&state, &key).await
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

    fn fake_turn(
        generation: u64,
        kill_tx: oneshot::Sender<()>,
        completion_rx: watch::Receiver<bool>,
    ) -> Turn {
        Turn {
            generation,
            kill_tx: Some(kill_tx),
            completion_rx,
            retiring: false,
        }
    }

    fn test_key(session_uuid: &str) -> RuntimeKey {
        RuntimeKey::new("owner-a", session_uuid)
    }

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

    #[tokio::test]
    async fn kill_waits_for_watcher_completion() {
        let state = std::sync::Arc::new(CodexBridgeState::new());
        let (kill_tx, kill_rx) = oneshot::channel();
        let (completion_tx, completion_rx) = watch::channel(false);
        state
            .registry
            .lock()
            .unwrap()
            .turns
            .insert(test_key("session-1"), fake_turn(1, kill_tx, completion_rx));

        let kill_state = state.clone();
        let kill_task =
            tokio::spawn(
                async move { codex_cli_kill_inner(&kill_state, &test_key("session-1")).await },
            );

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
        let state = std::sync::Arc::new(CodexBridgeState::new());
        let (kill_tx, kill_rx) = oneshot::channel();
        let (completion_tx, completion_rx) = watch::channel(false);
        state.registry.lock().unwrap().turns.insert(
            test_key("stable-session"),
            fake_turn(1, kill_tx, completion_rx),
        );

        let kill_state = state.clone();
        let kill_task = tokio::spawn(async move {
            codex_cli_kill_inner(&kill_state, &test_key("stable-session")).await
        });
        tokio::time::timeout(TEST_TIMEOUT, kill_rx)
            .await
            .expect("kill signal timed out")
            .expect("kill signal sender dropped");

        {
            let registry = state.registry.lock().unwrap();
            assert!(
                registry.turns.contains_key(&test_key("stable-session")),
                "kill released UUID ownership before watcher completion"
            );
            assert!(ensure_turn_key_available(&registry, &test_key("stable-session")).is_err());
        }
        assert!(!kill_task.is_finished());

        let emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stale_emitted = emitted.clone();
        assert!(
            retire_turn_if_owned(&state, &test_key("stable-session"), 1, move || {
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
        assert!(ensure_turn_key_available(&registry, &test_key("stable-session")).is_ok());
    }

    #[tokio::test]
    async fn concurrent_kills_wait_for_the_same_retirement() {
        let state = std::sync::Arc::new(CodexBridgeState::new());
        let (kill_tx, kill_rx) = oneshot::channel();
        let (completion_tx, completion_rx) = watch::channel(false);
        state.registry.lock().unwrap().turns.insert(
            test_key("stable-session"),
            fake_turn(1, kill_tx, completion_rx),
        );

        let first_state = state.clone();
        let first_kill = tokio::spawn(async move {
            codex_cli_kill_inner(&first_state, &test_key("stable-session")).await
        });
        tokio::time::timeout(TEST_TIMEOUT, kill_rx)
            .await
            .expect("kill signal timed out")
            .expect("kill signal sender dropped");

        let second_state = state.clone();
        let second_kill = tokio::spawn(async move {
            codex_cli_kill_inner(&second_state, &test_key("stable-session")).await
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
            .turns
            .contains_key(&test_key("stable-session")));

        assert!(
            retire_turn_if_owned(&state, &test_key("stable-session"), 1, || {
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
        let state = CodexBridgeState::new();
        tokio::time::timeout(
            TEST_TIMEOUT,
            codex_cli_kill_inner(&state, &test_key("unknown-session")),
        )
        .await
        .expect("unknown kill timed out")
        .unwrap();
    }

    #[tokio::test]
    async fn stale_generation_cannot_emit_or_remove_replacement() {
        let state = CodexBridgeState::new();
        let (kill_tx, _kill_rx) = oneshot::channel();
        let (_completion_tx, completion_rx) = watch::channel(false);
        state.registry.lock().unwrap().turns.insert(
            test_key("stable-session"),
            fake_turn(2, kill_tx, completion_rx),
        );
        let emitted = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let stale_emitted = emitted.clone();
        let retired = retire_turn_if_owned(&state, &test_key("stable-session"), 1, move || {
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
                .turns
                .get(&test_key("stable-session"))
                .map(|turn| turn.generation),
            Some(2)
        );

        let current_emitted = emitted.clone();
        let retired = retire_turn_if_owned(&state, &test_key("stable-session"), 2, move || {
            current_emitted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
        .await;
        assert!(retired);
        assert_eq!(emitted.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(!state
            .registry
            .lock()
            .unwrap()
            .turns
            .contains_key(&test_key("stable-session")));
    }

    #[tokio::test]
    async fn active_uuid_is_rejected_instead_of_overwritten() {
        let state = CodexBridgeState::new();
        let (kill_tx, _kill_rx) = oneshot::channel();
        let (_completion_tx, completion_rx) = watch::channel(false);
        let mut registry = state.registry.lock().unwrap();
        registry.turns.insert(
            test_key("stable-session"),
            fake_turn(1, kill_tx, completion_rx),
        );

        assert!(ensure_turn_key_available(&registry, &test_key("stable-session")).is_err());
        assert_eq!(registry.turns[&test_key("stable-session")].generation, 1);
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
            CodexStreamEvent::StdoutLine {
                target_label: "owner-a".into(),
                data: "out".into(),
            },
            CodexStreamEvent::StderrLine {
                target_label: "owner-a".into(),
                data: "err".into(),
            },
            CodexStreamEvent::Exit {
                target_label: "owner-a".into(),
                code: Some(0),
            },
            CodexStreamEvent::Error {
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
        let state = CodexBridgeState::new();
        let key_a = RuntimeKey::new("owner-a", "shared-session");
        let key_b = RuntimeKey::new("owner-b", "shared-session");
        let (kill_a, _kill_a_rx) = oneshot::channel();
        let (_done_a, done_a_rx) = watch::channel(false);
        let (kill_b, _kill_b_rx) = oneshot::channel();
        let (_done_b, done_b_rx) = watch::channel(false);
        let mut registry = state.registry.lock().unwrap();
        registry
            .turns
            .insert(key_a.clone(), fake_turn(1, kill_a, done_a_rx));

        assert!(ensure_turn_key_available(&registry, &key_a).is_err());
        assert!(ensure_turn_key_available(&registry, &key_b).is_ok());
        registry
            .turns
            .insert(key_b.clone(), fake_turn(2, kill_b, done_b_rx));
        assert_eq!(registry.turns.len(), 2);
    }

    #[tokio::test]
    async fn foreign_kill_cannot_access_owner_turn() {
        let state = CodexBridgeState::new();
        let key_a = RuntimeKey::new("owner-a", "shared-session");
        let key_b = RuntimeKey::new("owner-b", "shared-session");
        let (kill_tx, mut kill_rx) = oneshot::channel();
        let (_done_tx, done_rx) = watch::channel(false);
        state
            .registry
            .lock()
            .unwrap()
            .turns
            .insert(key_a, fake_turn(1, kill_tx, done_rx));

        codex_cli_kill_inner(&state, &key_b).await.unwrap();
        assert!(matches!(
            kill_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn destroyed_owner_tombstone_rejects_delayed_reservation_only_for_owner() {
        let state = CodexBridgeState::new();
        state.tombstone_owner("owner-a");
        let registry = state.registry.lock().unwrap();
        assert!(
            ensure_turn_key_available(&registry, &RuntimeKey::new("owner-a", "late-session"))
                .is_err()
        );
        assert!(
            ensure_turn_key_available(&registry, &RuntimeKey::new("owner-b", "late-session"))
                .is_ok()
        );
    }

    #[tokio::test]
    async fn owner_drain_signals_only_owner_and_waits_for_completion() {
        let state = std::sync::Arc::new(CodexBridgeState::new());
        let key_a = RuntimeKey::new("owner-a", "shared-session");
        let key_b = RuntimeKey::new("owner-b", "shared-session");
        let (kill_a, kill_a_rx) = oneshot::channel();
        let (done_a, done_a_rx) = watch::channel(false);
        let (kill_b, mut kill_b_rx) = oneshot::channel();
        let (_done_b, done_b_rx) = watch::channel(false);
        {
            let mut registry = state.registry.lock().unwrap();
            registry
                .turns
                .insert(key_a.clone(), fake_turn(1, kill_a, done_a_rx));
            registry
                .turns
                .insert(key_b.clone(), fake_turn(2, kill_b, done_b_rx));
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

        assert!(retire_turn_if_owned(&state, &key_a, 1, || {}).await);
        done_a.send(true).unwrap();
        for drain in [drain, second_drain] {
            tokio::time::timeout(TEST_TIMEOUT, drain)
                .await
                .expect("owner drain did not finish")
                .unwrap();
        }
        let registry = state.registry.lock().unwrap();
        assert!(!registry.turns.contains_key(&key_a));
        assert!(registry.turns.contains_key(&key_b));
    }
}
