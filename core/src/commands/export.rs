use crate::commands::file::{decode_file_bytes, EncodingState};
use crate::error::AppError;
use crate::services::pandoc;
use base64::Engine;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions as CapOpenOptions};
use pulldown_cmark::{Event, LinkType, Parser, Tag};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;

/// Per-process counter so concurrent exports never share a temp filename.
static EXPORT_SEQ: AtomicU64 = AtomicU64::new(0);
static EXPORT_CANCEL_TOKEN: AtomicU64 = AtomicU64::new(1);
static STAGED_EXPORT_CSS: LazyLock<Mutex<HashMap<String, StagedExportCss>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const MAX_EXPORT_INPUT_BYTES: usize = 100 * 1024 * 1024;
const MAX_EXPORT_CSS_BYTES: usize = 1024 * 1024;
const MAX_EXPORT_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_PROJECT_EXPORT_FILES: usize = 10_000;
const MAX_PROJECT_EXPORT_ENTRIES: usize = 20_000;
const MAX_PROJECT_EXPORT_DEPTH: usize = 64;
const MAX_PROJECT_EXPORT_PATH_BYTES: usize = 4 * 1024 * 1024;
const MAX_PENDING_EXPORT_CANCELS: usize = 256;
const MAX_STAGED_EXPORT_CSS: usize = 256;
const PENDING_EXPORT_CANCEL_TTL: Duration = Duration::from_secs(300);

struct StagedExportCss {
    path: PathBuf,
    header: Vec<u8>,
    created: Instant,
}

pub struct ExportState {
    lifecycle: Mutex<ExportLifecycleState>,
}

#[derive(Default)]
struct ExportLifecycleState {
    active: HashMap<String, ExportCancelEntry>,
    pending: HashMap<String, Instant>,
    completed: HashMap<String, Instant>,
}

struct ExportCancelEntry {
    token: u64,
    sender: watch::Sender<bool>,
    commit_gate: Arc<pandoc::CommitGate>,
}

impl ExportState {
    pub fn new() -> Self {
        Self {
            lifecycle: Mutex::new(ExportLifecycleState::default()),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct PandocStatus {
    pub available: bool,
    pub version: Option<String>,
    /// Absolute path of the resolved binary, when found. Useful for
    /// the Settings UI to confirm what we're actually invoking.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    /// The user's saved override (mirrors `GlobalSettings.pandoc_path`)
    /// — surfaced so the Settings form can pre-fill the input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Type)]
pub struct ExportProjectResult {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<pandoc::PandocFailure>,
}

#[tauri::command]
#[specta::specta]
pub async fn check_pandoc() -> Result<PandocStatus, AppError> {
    let g = crate::commands::settings::read_global_settings().await;
    let resolved = pandoc::resolve_pandoc(g.pandoc_path.as_deref()).await;
    Ok(PandocStatus {
        available: resolved.is_some(),
        version: resolved.as_ref().map(|(_, v)| v.clone()),
        resolved_path: resolved.map(|(p, _)| p),
        override_path: g.pandoc_path,
    })
}

/// Persist the user's pandoc binary override. `None` clears it (revert
/// to auto-detection). Empty string is treated as `None`.
#[tauri::command]
#[specta::specta]
pub async fn set_pandoc_path(path: Option<String>) -> Result<(), AppError> {
    let mut g = crate::commands::settings::read_global_settings().await;
    g.pandoc_path = match path {
        Some(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    };
    crate::commands::settings::write_global_settings_to_disk(&g).await
}

#[tauri::command]
#[specta::specta]
pub async fn stage_export_css(request_id: String, css: String) -> Result<String, AppError> {
    let request_id = validate_export_request_id(&request_id)?.to_string();
    if css.len() > MAX_EXPORT_CSS_BYTES {
        return Err(AppError::InvalidInput(
            "export stylesheet exceeds the 1 MiB limit".to_string(),
        ));
    }
    validate_export_theme_css(&css)?;
    let path = std::env::temp_dir().join(format!("novelist-export-theme-{request_id}.html"));
    let header = format!("<style>\n{css}\n</style>\n").into_bytes();
    let staged_path = path.clone();
    let staged_header = header.clone();
    tokio::task::spawn_blocking(move || write_private_staged_css(&staged_path, &staged_header))
        .await
        .map_err(|error| AppError::Custom(format!("export stylesheet task failed: {error}")))??;
    if let Err(error) = register_staged_export_css(&request_id, path.clone(), header) {
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    Ok(path.to_string_lossy().to_string())
}

fn register_staged_export_css(
    request_id: &str,
    path: PathBuf,
    header: Vec<u8>,
) -> Result<(), AppError> {
    let mut staged = STAGED_EXPORT_CSS
        .lock()
        .map_err(|error| AppError::Custom(format!("Lock poisoned: {error}")))?;
    purge_expired_staged_export_css(&mut staged);
    if staged.len() >= MAX_STAGED_EXPORT_CSS && !staged.contains_key(request_id) {
        return Err(AppError::Custom(
            "too many staged export stylesheets".to_string(),
        ));
    }
    staged.insert(
        request_id.to_string(),
        StagedExportCss {
            path,
            header,
            created: Instant::now(),
        },
    );
    Ok(())
}

fn take_staged_export_css(
    request_id: &str,
    expected_path: &Path,
) -> Result<Option<StagedExportCss>, AppError> {
    let mut staged = STAGED_EXPORT_CSS
        .lock()
        .map_err(|error| AppError::Custom(format!("Lock poisoned: {error}")))?;
    purge_expired_staged_export_css(&mut staged);
    Ok(staged
        .remove(request_id)
        .filter(|entry| entry.path == expected_path))
}

fn purge_expired_staged_export_css(staged: &mut HashMap<String, StagedExportCss>) {
    let expired: Vec<String> = staged
        .iter()
        .filter(|(_, entry)| entry.created.elapsed() >= PENDING_EXPORT_CANCEL_TTL)
        .map(|(request_id, _)| request_id.clone())
        .collect();
    for request_id in expired {
        let Some(path) = staged.get(&request_id).map(|entry| entry.path.clone()) else {
            continue;
        };
        match std::fs::remove_file(&path) {
            Ok(()) => {
                staged.remove(&request_id);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                staged.remove(&request_id);
            }
            Err(error) => {
                tracing::warn!(
                    target: "novelist::export",
                    path = %path.display(),
                    %error,
                    "expired staged export stylesheet cleanup failed"
                );
            }
        }
    }
}

const EXPORT_THEME_CSS_SUFFIX: &str = r#"body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; background: var(--novelist-bg); color: var(--novelist-text); line-height: 1.7; }
h1, h2, h3, h4, h5, h6 { color: var(--novelist-heading-color); }
a { color: var(--novelist-link-color); }
code { background: var(--novelist-code-bg); padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
pre { background: var(--novelist-code-bg); padding: 16px; border-radius: 6px; overflow-x: auto; }
blockquote { border-left: 3px solid var(--novelist-blockquote-border); padding-left: 16px; color: var(--novelist-text-secondary); font-style: italic; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; }
th, td { border: 1px solid var(--novelist-border); padding: 8px 12px; text-align: left; }
th { background: var(--novelist-bg-secondary); font-weight: 600; }
hr { border: none; border-top: 1px solid var(--novelist-border); margin: 24px 0; }
img { max-width: 100%; border-radius: 6px; }"#;

fn validate_export_theme_css(css: &str) -> Result<(), AppError> {
    let closing = css
        .find("\n}")
        .ok_or_else(|| AppError::InvalidInput("export stylesheet is incomplete".to_string()))?;
    let root = &css[..closing];
    let suffix = css[closing + 2..]
        .strip_prefix('\n')
        .unwrap_or(&css[closing + 2..]);
    if !suffix.is_empty() && suffix != EXPORT_THEME_CSS_SUFFIX {
        return Err(AppError::InvalidInput(
            "export stylesheet contains unsupported syntax".to_string(),
        ));
    }

    let mut lines = root.lines().map(str::trim).filter(|line| !line.is_empty());
    if lines.next() != Some(":root {") {
        return Err(AppError::InvalidInput(
            "export stylesheet must contain only root theme variables".to_string(),
        ));
    }
    for line in lines {
        if !line.ends_with(';') {
            return Err(AppError::InvalidInput(
                "export stylesheet contains unsupported syntax".to_string(),
            ));
        }
        let Some((name, value)) = line[..line.len() - 1].split_once(':') else {
            return Err(AppError::InvalidInput(
                "export stylesheet contains an invalid theme variable".to_string(),
            ));
        };
        let name = name.trim();
        let value = value.trim();
        const THEME_COLOR_VARIABLES: [&str; 13] = [
            "--novelist-bg",
            "--novelist-bg-secondary",
            "--novelist-bg-tertiary",
            "--novelist-text",
            "--novelist-text-secondary",
            "--novelist-text-tertiary",
            "--novelist-accent",
            "--novelist-border",
            "--novelist-border-subtle",
            "--novelist-heading-color",
            "--novelist-link-color",
            "--novelist-code-bg",
            "--novelist-blockquote-border",
        ];
        if !THEME_COLOR_VARIABLES.contains(&name) || value.parse::<csscolorparser::Color>().is_err()
        {
            return Err(AppError::InvalidInput(
                "export stylesheet contains an invalid theme color".to_string(),
            ));
        }
    }
    Ok(())
}

fn write_private_staged_css(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let mut file = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)?
        }
        #[cfg(windows)]
        {
            pandoc::create_owner_only_file(path)?
        }
        #[cfg(not(any(unix, windows)))]
        {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)?
        }
    };
    let result = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) = result {
        if let Err(cleanup) = std::fs::remove_file(path) {
            if cleanup.kind() != std::io::ErrorKind::NotFound {
                return Err(AppError::Custom(format!(
                    "failed to write export stylesheet: {error}; cleanup also failed: {cleanup}"
                )));
            }
        }
        return Err(AppError::Io(error));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
// Six serialized fields plus Tauri's two injected states form this typed IPC boundary.
#[allow(clippy::too_many_arguments)]
pub async fn export_project(
    input_files: Vec<String>,
    output_path: String,
    format: String,
    mut extra_args: Vec<String>,
    request_id: Option<String>,
    project_dir: Option<String>,
    encoding_state: tauri::State<'_, EncodingState>,
    export_state: tauri::State<'_, ExportState>,
) -> Result<ExportProjectResult, AppError> {
    let css_temp_paths =
        validate_export_extra_args_with_cleanup(&format, &mut extra_args, request_id.as_deref())
            .await?;
    let cancel_guard = match request_id
        .as_deref()
        .map(|id| ExportCancelGuard::register(id, &export_state))
        .transpose()
    {
        Ok(guard) => guard,
        Err(error) => {
            let cleanup_error = cleanup_css_resources(&css_temp_paths, None).await;
            log_cleanup_warning(
                cleanup_error.as_ref(),
                "export request registration failure",
            );
            return Err(error);
        }
    };
    let cancel_rx = cancel_guard.as_ref().map(ExportCancelGuard::subscribe);
    let (input_files, prepared_input, canonical_project_root) = match project_dir.as_deref() {
        Some(project_dir) => {
            let batch = match collect_project_export_sources(Path::new(project_dir)).await {
                Ok(batch) => batch,
                Err(error) => {
                    cleanup_preflight_css(&css_temp_paths, "project source scan failure").await;
                    return Err(error);
                }
            };
            if batch.sources.is_empty() {
                cleanup_preflight_css(&css_temp_paths, "empty project export").await;
                return Err(AppError::InvalidInput(
                    "no Markdown files were found for export".to_string(),
                ));
            }
            let input_files = batch
                .sources
                .iter()
                .map(|source| source.absolute.to_string_lossy().to_string())
                .collect::<Vec<_>>();
            let prepared = match assemble_project_source_batch(&batch, &encoding_state) {
                Ok(prepared) => prepared,
                Err((source, error)) => {
                    cleanup_preflight_css(&css_temp_paths, "project source decode failure").await;
                    let failure = pandoc::PandocFailure::new(
                        pandoc::PandocStage::InputRead,
                        format!("failed to read export input: {error}"),
                    )
                    .with_format(format.clone())
                    .with_source_path(source);
                    return Err(failure.into_app_error());
                }
            };
            (input_files, Some(prepared), Some(batch.canonical_root))
        }
        None => {
            let input_files = resolve_export_input_files(input_files, &css_temp_paths).await?;
            (input_files, None, None)
        }
    };
    if cancel_rx.as_ref().is_some_and(|cancel| *cancel.borrow()) {
        cleanup_preflight_css(&css_temp_paths, "cancelled project source scan").await;
        return Err(cancelled_preflight_failure(&format, &input_files));
    }
    let bin = match resolve_pandoc_for_export(&format, None).await {
        Ok(bin) => bin,
        Err(error) => {
            let cleanup_error = cleanup_css_resources(&css_temp_paths, None)
                .await
                .map(|failure| {
                    contextualize_cleanup_without_binary(failure, &format, &input_files)
                });
            log_cleanup_warning(cleanup_error.as_ref(), "Pandoc discovery failure");
            return Err(error);
        }
    };
    if cancel_rx.as_ref().is_some_and(|cancel| *cancel.borrow()) {
        cleanup_preflight_css(&css_temp_paths, "cancelled Pandoc discovery").await;
        return Err(cancelled_preflight_failure(&format, &input_files));
    }
    export_project_with_pandoc(
        input_files,
        output_path,
        format,
        extra_args,
        &encoding_state,
        ExportRunOptions {
            pandoc_bin: &bin,
            timeout: pandoc::DEFAULT_PANDOC_TIMEOUT,
            cancel_rx,
            temp_workspace: None,
            source_root: canonical_project_root.as_deref(),
            prepared_input: prepared_input.as_deref(),
            commit_gate: cancel_guard.as_ref().map(ExportCancelGuard::commit_gate),
        },
    )
    .await
}

async fn resolve_export_input_files(
    input_files: Vec<String>,
    css_paths: &[PathBuf],
) -> Result<Vec<String>, AppError> {
    if input_files.is_empty() {
        cleanup_preflight_css(css_paths, "empty project export").await;
        return Err(AppError::InvalidInput(
            "no Markdown files were found for export".to_string(),
        ));
    }
    Ok(input_files)
}

async fn cleanup_preflight_css(css_paths: &[PathBuf], context: &'static str) {
    let cleanup_error = cleanup_css_resources(css_paths, None).await;
    log_cleanup_warning(cleanup_error.as_ref(), context);
}

fn cancelled_preflight_failure(format: &str, input_files: &[String]) -> AppError {
    let mut failure = pandoc::PandocFailure::new(
        pandoc::PandocStage::TimeoutOrCancel,
        "Pandoc export was cancelled before conversion started.",
    )
    .with_format(format.to_string());
    if let Some(source) = source_context(input_files) {
        failure = failure.with_source_path(source.to_string());
    }
    failure.into_app_error()
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_export_project(
    request_id: String,
    export_state: tauri::State<'_, ExportState>,
) -> Result<bool, AppError> {
    cancel_export_request(&export_state, &request_id)
}

fn cancel_export_request(export_state: &ExportState, request_id: &str) -> Result<bool, AppError> {
    let request_id = validate_export_request_id(request_id)?;
    let mut lifecycle = export_state
        .lifecycle
        .lock()
        .map_err(|e| AppError::Custom(format!("Lock poisoned: {e}")))?;
    if let Some(entry) = lifecycle.active.get(request_id) {
        if !entry.commit_gate.cancel() {
            return Ok(false);
        }
        let _ = entry.sender.send(true);
        Ok(true)
    } else {
        lifecycle
            .completed
            .retain(|_, finished| finished.elapsed() < PENDING_EXPORT_CANCEL_TTL);
        if lifecycle.completed.contains_key(request_id) {
            return Ok(false);
        }
        lifecycle
            .pending
            .retain(|_, created| created.elapsed() < PENDING_EXPORT_CANCEL_TTL);
        if lifecycle.pending.len() >= MAX_PENDING_EXPORT_CANCELS
            && !lifecycle.pending.contains_key(request_id)
        {
            return Err(AppError::Custom(
                "too many pending export cancellation requests".to_string(),
            ));
        }
        lifecycle
            .pending
            .insert(request_id.to_string(), Instant::now());
        Ok(true)
    }
}

struct ExportCancelGuard<'a> {
    request_id: String,
    token: u64,
    receiver: watch::Receiver<bool>,
    commit_gate: Arc<pandoc::CommitGate>,
    state: &'a ExportState,
}

impl<'a> ExportCancelGuard<'a> {
    fn register(request_id: &str, state: &'a ExportState) -> Result<Self, AppError> {
        let trimmed = validate_export_request_id(request_id)?;
        let token = EXPORT_CANCEL_TOKEN.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = watch::channel(false);
        let commit_gate = Arc::new(pandoc::CommitGate::default());
        let mut lifecycle = state
            .lifecycle
            .lock()
            .map_err(|e| AppError::Custom(format!("Lock poisoned: {e}")))?;
        lifecycle.completed.remove(trimmed);
        if lifecycle.active.contains_key(trimmed) {
            return Err(AppError::InvalidInput(
                "export request id is already active".to_string(),
            ));
        }
        lifecycle.active.insert(
            trimmed.to_string(),
            ExportCancelEntry {
                token,
                sender: sender.clone(),
                commit_gate: commit_gate.clone(),
            },
        );
        let guard = Self {
            request_id: trimmed.to_string(),
            token,
            receiver,
            commit_gate,
            state,
        };
        let was_pending = lifecycle.pending.remove(trimmed).is_some();
        if was_pending {
            guard.commit_gate.cancel();
            let _ = sender.send(true);
        }
        Ok(guard)
    }

    fn subscribe(&self) -> watch::Receiver<bool> {
        self.receiver.clone()
    }

    fn commit_gate(&self) -> Arc<pandoc::CommitGate> {
        self.commit_gate.clone()
    }
}

impl Drop for ExportCancelGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut lifecycle) = self.state.lifecycle.lock() {
            if lifecycle
                .active
                .get(&self.request_id)
                .is_some_and(|entry| entry.token == self.token)
            {
                lifecycle
                    .completed
                    .retain(|_, finished| finished.elapsed() < PENDING_EXPORT_CANCEL_TTL);
                if lifecycle.completed.len() >= MAX_PENDING_EXPORT_CANCELS {
                    if let Some(oldest) = lifecycle
                        .completed
                        .iter()
                        .min_by_key(|(_, finished)| **finished)
                        .map(|(request_id, _)| request_id.clone())
                    {
                        lifecycle.completed.remove(&oldest);
                    }
                }
                lifecycle
                    .completed
                    .insert(self.request_id.clone(), Instant::now());
                lifecycle.active.remove(&self.request_id);
            }
        }
    }
}

async fn resolve_pandoc_for_export(
    format: &str,
    source_path: Option<&Path>,
) -> Result<String, AppError> {
    let g = crate::commands::settings::read_global_settings().await;
    let probe_list = pandoc::common_paths();
    pandoc::resolve_with(g.pandoc_path.as_deref(), &probe_list, |bin| async move {
        pandoc::probe(&bin).await
    })
    .await
    .map(|(bin, _)| bin)
    .map_err(|failure| {
        let mut failure = failure.with_format(format.to_string());
        if let Some(source_path) = source_path {
            failure = failure.with_source_path(source_path.to_string_lossy().to_string());
        }
        failure.into_app_error()
    })
}

async fn export_project_with_pandoc(
    input_files: Vec<String>,
    output_path: String,
    format: String,
    extra_args: Vec<String>,
    encoding_state: &EncodingState,
    options: ExportRunOptions<'_>,
) -> Result<ExportProjectResult, AppError> {
    export_project_with_pandoc_inner(
        input_files,
        output_path,
        format,
        extra_args,
        encoding_state,
        options,
        None,
    )
    .await
}

#[cfg(test)]
#[allow(dead_code)]
async fn export_project_with_pandoc_and_cleanup_hook(
    input_files: Vec<String>,
    output_path: String,
    format: String,
    extra_args: Vec<String>,
    encoding_state: &EncodingState,
    options: ExportRunOptions<'_>,
    cleanup_failure_hook: &CleanupFailureHook<'_>,
) -> Result<ExportProjectResult, AppError> {
    export_project_with_pandoc_inner(
        input_files,
        output_path,
        format,
        extra_args,
        encoding_state,
        options,
        Some(cleanup_failure_hook),
    )
    .await
}

async fn export_project_with_pandoc_inner(
    input_files: Vec<String>,
    output_path: String,
    format: String,
    extra_args: Vec<String>,
    encoding_state: &EncodingState,
    options: ExportRunOptions<'_>,
    cleanup_failure_hook: Option<&CleanupFailureHook<'_>>,
) -> Result<ExportProjectResult, AppError> {
    let css_temp_paths = validate_export_extra_args_shape(&format, &extra_args)?;
    let allowed_formats = ["html", "pdf", "docx", "epub"];
    if !allowed_formats.contains(&format.as_str()) {
        cleanup_preflight_css(&css_temp_paths, "unsupported export format").await;
        return Err(AppError::InvalidInput(format!(
            "Unsupported export format: {}. Allowed: {:?}",
            format, allowed_formats
        )));
    }
    if let Err(error) = validate_output_not_input(&input_files, &output_path) {
        cleanup_preflight_css(&css_temp_paths, "export destination validation failure").await;
        return Err(error);
    }
    let resource_args = match resource_path_args(&input_files, options.source_root) {
        Ok(args) => args,
        Err(error) => {
            cleanup_preflight_css(&css_temp_paths, "export resource path validation failure").await;
            return Err(error);
        }
    };

    // Unique per-export temp name (pid + counter) so two windows exporting at
    // once don't read/delete each other's input or clobber a predictable path
    // in the shared temp dir.
    let temp_dir = match unique_export_temp_dir(options.temp_workspace).await {
        Ok(temp_dir) => temp_dir,
        Err(error) => {
            let cleanup_error = cleanup_css_resources(&css_temp_paths, cleanup_failure_hook).await;
            log_cleanup_warning(
                cleanup_error.as_ref(),
                "temporary workspace allocation failure",
            );
            return Err(error);
        }
    };
    let temp_input = temp_dir.join("input.md");

    let combined = match assemble_export_input(
        &input_files,
        encoding_state,
        options.source_root,
        options.prepared_input,
    )
    .await
    {
        Ok(combined) => combined,
        Err((source, err)) => {
            let cleanup_error = cleanup_temp_resources(
                &temp_input,
                Some(&temp_dir),
                &css_temp_paths,
                cleanup_failure_hook,
            )
            .await;
            log_cleanup_warning(cleanup_error.as_ref(), "input read failure");
            let mut failure = pandoc::PandocFailure::new(
                pandoc::PandocStage::InputRead,
                format!("failed to read export input: {err}"),
            )
            .with_format(format.clone());
            failure = failure.with_source_path(source);
            return Err(failure.into_app_error());
        }
    };
    if let Err(error) = validate_markdown_resource_references(&combined) {
        let cleanup_error = cleanup_temp_resources(
            &temp_input,
            Some(&temp_dir),
            &css_temp_paths,
            cleanup_failure_hook,
        )
        .await;
        log_cleanup_warning(cleanup_error.as_ref(), "unsafe Markdown resource reference");
        let mut failure = pandoc::PandocFailure::new(
            pandoc::PandocStage::InputRead,
            format!("export input contains an unsafe resource reference: {error}"),
        )
        .with_format(format.clone());
        if let Some(source_path) = source_context(&input_files) {
            failure = failure.with_source_path(source_path.to_string());
        }
        return Err(failure.into_app_error());
    }
    if let Err(err) = write_temp_input(&temp_input, &combined).await {
        let cleanup_error = cleanup_temp_resources(
            &temp_input,
            Some(&temp_dir),
            &css_temp_paths,
            cleanup_failure_hook,
        )
        .await;
        log_cleanup_warning(cleanup_error.as_ref(), "temporary input write failure");
        let mut failure = pandoc::PandocFailure::new(
            pandoc::PandocStage::InputRead,
            format!("failed to write temporary export input: {err}"),
        )
        .with_format(format.clone());
        if let Some(source_path) = source_context(&input_files) {
            failure = failure.with_source_path(source_path);
        }
        return Err(failure.into_app_error());
    }

    let mut pandoc_args = extra_args;
    pandoc_args.extend(resource_args);
    let result = pandoc::run_pandoc_structured_with_cancel_detailed(
        options.pandoc_bin,
        &temp_input,
        Path::new(&output_path),
        &format,
        &pandoc_args,
        pandoc::PandocRunControl {
            timeout: options.timeout,
            cancel: options.cancel_rx,
            commit_gate: options.commit_gate,
        },
    )
    .await
    .map_err(|mut failure| {
        failure.source_path = source_context(&input_files).map(str::to_string);
        failure.into_app_error()
    });

    let cleanup_error = cleanup_temp_resources(
        &temp_input,
        Some(&temp_dir),
        &css_temp_paths,
        cleanup_failure_hook,
    )
    .await
    .map(|failure| {
        contextualize_cleanup_failure(failure, options.pandoc_bin, &format, &input_files)
    });

    match result {
        Ok(success) => {
            let warning = merge_cleanup_warnings(success.warning, cleanup_error);
            log_cleanup_warning(warning.as_ref(), "successful export");
            Ok(ExportProjectResult {
                message: success.message,
                warning,
            })
        }
        Err(error) => {
            log_cleanup_warning(cleanup_error.as_ref(), "failed export");
            Err(error)
        }
    }
}

fn merge_cleanup_warnings(
    process_warning: Option<pandoc::PandocFailure>,
    resource_warning: Option<pandoc::PandocFailure>,
) -> Option<pandoc::PandocFailure> {
    match (process_warning, resource_warning) {
        (Some(mut process), Some(resource)) => {
            process.message.push(' ');
            process.message.push_str(&resource.message);
            Some(process)
        }
        (Some(process), None) => Some(process),
        (None, Some(resource)) => Some(resource),
        (None, None) => None,
    }
}

fn log_cleanup_warning(failure: Option<&pandoc::PandocFailure>, context: &'static str) {
    if let Some(failure) = failure {
        tracing::warn!(
            target: "novelist::export",
            stage = failure.stage.tag(),
            message = %failure.message,
            context,
            "Pandoc export cleanup warning"
        );
    }
}

fn contextualize_cleanup_failure(
    failure: pandoc::PandocFailure,
    pandoc_bin: &str,
    format: &str,
    input_files: &[String],
) -> pandoc::PandocFailure {
    let failure = failure
        .with_binary(pandoc_bin.to_string())
        .with_format(format.to_string());
    with_optional_source(failure, input_files)
}

fn contextualize_cleanup_without_binary(
    failure: pandoc::PandocFailure,
    format: &str,
    input_files: &[String],
) -> pandoc::PandocFailure {
    with_optional_source(failure.with_format(format.to_string()), input_files)
}

fn with_optional_source(
    mut failure: pandoc::PandocFailure,
    input_files: &[String],
) -> pandoc::PandocFailure {
    failure.source_path = source_context(input_files).map(str::to_string);
    failure
}

struct ExportRunOptions<'a> {
    pandoc_bin: &'a str,
    timeout: Duration,
    cancel_rx: Option<watch::Receiver<bool>>,
    temp_workspace: Option<&'a Path>,
    source_root: Option<&'a Path>,
    prepared_input: Option<&'a str>,
    commit_gate: Option<Arc<pandoc::CommitGate>>,
}

type CleanupFailureHook<'a> = dyn Fn(&Path) -> Option<std::io::Error> + Send + Sync + 'a;

async fn write_temp_input(temp_input: &Path, combined: &str) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        let path = temp_input.to_path_buf();
        let bytes = combined.as_bytes().to_vec();
        tokio::task::spawn_blocking(move || {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)?;
            file.write_all(&bytes)
        })
        .await
        .map_err(std::io::Error::other)?
    }
    #[cfg(windows)]
    {
        use std::io::Write;

        let path = temp_input.to_path_buf();
        let bytes = combined.as_bytes().to_vec();
        tokio::task::spawn_blocking(move || {
            let mut file = pandoc::create_owner_only_file(&path)?;
            file.write_all(&bytes)
        })
        .await
        .map_err(std::io::Error::other)?
    }
    #[cfg(not(any(unix, windows)))]
    {
        tokio::fs::write(temp_input, combined).await
    }
}

async fn unique_export_temp_dir(temp_workspace: Option<&Path>) -> Result<PathBuf, AppError> {
    let root = temp_workspace
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    for _ in 0..32 {
        let seq = EXPORT_SEQ.fetch_add(1, Ordering::Relaxed);
        let name = format!(
            "novelist-export-{}-{}-{}",
            std::process::id(),
            seq,
            random_suffix()
        );
        let candidate = root.join(name);
        match create_private_temp_dir(&candidate).await {
            Ok(()) => return Ok(candidate),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(AppError::Io(err)),
        }
    }
    Err(AppError::Custom(
        "failed to allocate unique export temp directory".to_string(),
    ))
}

async fn create_private_temp_dir(path: &Path) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;

        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            let mut builder = std::fs::DirBuilder::new();
            builder.mode(0o700).create(path)
        })
        .await
        .map_err(std::io::Error::other)?
    }
    #[cfg(windows)]
    {
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || pandoc::create_owner_only_directory(&path))
            .await
            .map_err(std::io::Error::other)?
    }
    #[cfg(not(any(unix, windows)))]
    {
        tokio::fs::create_dir(path).await
    }
}

fn random_suffix() -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut hasher);
    std::thread::current().id().hash(&mut hasher);
    EXPORT_SEQ.load(Ordering::Relaxed).hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn source_context(input_files: &[String]) -> Option<&str> {
    input_files.first().map(String::as_str)
}

fn validate_output_not_input(input_files: &[String], output_path: &str) -> Result<(), AppError> {
    let output = path_identity(Path::new(output_path))?;
    for input in input_files {
        if path_identity(Path::new(input))? == output {
            return Err(AppError::InvalidInput(
                "export destination conflicts with an input file".to_string(),
            ));
        }
    }
    Ok(())
}

fn path_identity(path: &Path) -> Result<PathBuf, AppError> {
    match std::fs::canonicalize(path) {
        Ok(canonical) => Ok(canonical),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if path.is_absolute() {
                Ok(path.to_path_buf())
            } else {
                Ok(std::env::current_dir()?.join(path))
            }
        }
        Err(error) => Err(AppError::Io(error)),
    }
}

fn resource_path_args(
    input_files: &[String],
    source_root: Option<&Path>,
) -> Result<Vec<String>, AppError> {
    if let Some(source_root) = source_root {
        return Ok(vec![
            "--resource-path".to_string(),
            source_root.to_string_lossy().to_string(),
        ]);
    }
    let mut parents = Vec::new();
    for input in input_files {
        let Some(parent) = Path::new(input).parent() else {
            continue;
        };
        if !parents.iter().any(|existing| existing == parent) {
            parents.push(parent.to_path_buf());
        }
    }
    if parents.is_empty() {
        return Ok(Vec::new());
    }
    let joined = std::env::join_paths(parents).map_err(|error| {
        AppError::InvalidInput(format!("failed to build Pandoc resource path: {error}"))
    })?;
    Ok(vec![
        "--resource-path".to_string(),
        joined.to_string_lossy().to_string(),
    ])
}

async fn assemble_export_input(
    input_files: &[String],
    encoding_state: &EncodingState,
    source_root: Option<&Path>,
    prepared_input: Option<&str>,
) -> Result<String, (String, AppError)> {
    if let Some(prepared_input) = prepared_input {
        return Ok(prepared_input.to_string());
    }
    let mut combined = String::new();
    for path in input_files {
        let remaining = MAX_EXPORT_INPUT_BYTES.saturating_sub(combined.len());
        let content = read_export_source(path, encoding_state, source_root, remaining)
            .await
            .map_err(|error| (path.clone(), error))?;
        if content.len().saturating_add(2) > remaining {
            return Err((
                path.clone(),
                AppError::InvalidInput("export input exceeds the 100 MiB limit".to_string()),
            ));
        }
        combined.push_str(&content);
        combined.push_str("\n\n");
    }
    Ok(combined)
}

async fn read_export_source(
    path: &str,
    encoding_state: &EncodingState,
    source_root: Option<&Path>,
    byte_limit: usize,
) -> Result<String, AppError> {
    let Some(source_root) = source_root else {
        let source = PathBuf::from(path);
        let read_path = source.clone();
        let bytes = tokio::task::spawn_blocking(move || {
            read_standalone_source_bounded(&read_path, byte_limit)
        })
        .await
        .map_err(|error| AppError::Custom(format!("export source read task failed: {error}")))??;
        let decoded = decode_file_bytes(&source, &bytes, encoding_state)?;
        let parent = source.parent().ok_or_else(|| {
            AppError::PathNotAllowed("export source has no parent directory".to_string())
        })?;
        let file_name = source
            .file_name()
            .ok_or_else(|| AppError::PathNotAllowed("export source path is invalid".to_string()))?;
        let root = Dir::open_ambient_dir(parent, ambient_authority())?;
        let mut image_bytes = 0;
        return embed_confined_image_destinations(
            &decoded,
            Path::new(file_name),
            &root,
            &mut image_bytes,
        );
    };

    let root = source_root.to_path_buf();
    let source = PathBuf::from(path);
    let bytes = tokio::task::spawn_blocking(move || {
        read_project_source_confined(&root, &source, byte_limit)
    })
    .await
    .map_err(|error| AppError::Custom(format!("export source read task failed: {error}")))??;
    decode_file_bytes(Path::new(path), &bytes, encoding_state)
}

fn read_standalone_source_bounded(path: &Path, byte_limit: usize) -> Result<Vec<u8>, AppError> {
    let mut file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(AppError::InvalidInput(
            "export source is not a regular file".to_string(),
        ));
    }
    if metadata.len() > byte_limit as u64 {
        return Err(AppError::InvalidInput(
            "export input exceeds the 100 MiB limit".to_string(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(byte_limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > byte_limit {
        return Err(AppError::InvalidInput(
            "export input exceeds the 100 MiB limit".to_string(),
        ));
    }
    Ok(bytes)
}

fn read_project_source_confined(
    project_dir: &Path,
    source_path: &Path,
    byte_limit: usize,
) -> Result<Vec<u8>, AppError> {
    let relative = source_path.strip_prefix(project_dir).map_err(|_| {
        AppError::PathNotAllowed("export source is outside the project".to_string())
    })?;
    let mut components = relative.components().collect::<Vec<_>>();
    let file_name = match components.pop() {
        Some(std::path::Component::Normal(name)) => name.to_owned(),
        _ => {
            return Err(AppError::PathNotAllowed(
                "export source path is invalid".to_string(),
            ));
        }
    };
    let canonical_root = std::fs::canonicalize(project_dir)?;
    let mut current = Dir::open_ambient_dir(&canonical_root, ambient_authority())?;
    for component in components {
        let std::path::Component::Normal(name) = component else {
            return Err(AppError::PathNotAllowed(
                "export source path is invalid".to_string(),
            ));
        };
        let metadata = current.symlink_metadata(name)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(AppError::PathNotAllowed(
                "export source contains an unsafe directory component".to_string(),
            ));
        }
        current = current.open_dir_nofollow(name)?;
    }
    let metadata = current.symlink_metadata(&file_name)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::PathNotAllowed(
            "export source is not a regular project file".to_string(),
        ));
    }
    if metadata.len() > byte_limit as u64 {
        return Err(AppError::InvalidInput(
            "export input exceeds the 100 MiB limit".to_string(),
        ));
    }
    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = current.open_with(&file_name, &options)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(byte_limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > byte_limit {
        return Err(AppError::InvalidInput(
            "export input exceeds the 100 MiB limit".to_string(),
        ));
    }
    Ok(bytes)
}

struct ProjectExportSource {
    absolute: PathBuf,
    relative: PathBuf,
    bytes: Vec<u8>,
}

struct ProjectExportBatch {
    canonical_root: PathBuf,
    root: Dir,
    sources: Vec<ProjectExportSource>,
}

#[derive(Default)]
struct ProjectScanBudget {
    entries: usize,
    files: usize,
    path_bytes: usize,
    content_bytes: usize,
}

async fn collect_project_export_sources(
    project_dir: &Path,
) -> Result<ProjectExportBatch, AppError> {
    let project_dir = project_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let canonical_root = std::fs::canonicalize(&project_dir)?;
        let root = Dir::open_ambient_dir(&canonical_root, ambient_authority())?;
        let mut sources = Vec::new();
        let mut budget = ProjectScanBudget::default();
        collect_markdown_files_from_dir(
            &root,
            &canonical_root,
            Path::new(""),
            0,
            &mut budget,
            &mut sources,
        )?;
        Ok(ProjectExportBatch {
            canonical_root,
            root,
            sources,
        })
    })
    .await
    .map_err(|error| AppError::Custom(format!("project export scan failed: {error}")))?
}

fn collect_markdown_files_from_dir(
    directory: &Dir,
    canonical_root: &Path,
    relative_dir: &Path,
    depth: usize,
    budget: &mut ProjectScanBudget,
    sources: &mut Vec<ProjectExportSource>,
) -> Result<(), AppError> {
    if depth > MAX_PROJECT_EXPORT_DEPTH {
        return Err(AppError::InvalidInput(
            "project export exceeds the directory depth limit".to_string(),
        ));
    }
    let mut entries = Vec::new();
    for entry in directory.entries()? {
        let name = entry?.file_name();
        let relative = relative_dir.join(&name);
        charge_project_entry_budget(budget, &relative)?;
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let metadata = directory.symlink_metadata(&name)?;
        if metadata.file_type().is_symlink() {
            return Err(AppError::PathNotAllowed(
                "project export does not follow symlink entries".to_string(),
            ));
        }
        entries.push((name, metadata));
    }
    entries.sort_by(|(left_name, left_meta), (right_name, right_meta)| {
        right_meta
            .is_dir()
            .cmp(&left_meta.is_dir())
            .then_with(|| {
                compare_export_names(&left_name.to_string_lossy(), &right_name.to_string_lossy())
            })
            .then_with(|| left_name.cmp(right_name))
    });

    for (name, metadata) in entries {
        let relative = relative_dir.join(&name);
        if metadata.is_dir() {
            let child = directory.open_dir_nofollow(&name)?;
            collect_markdown_files_from_dir(
                &child,
                canonical_root,
                &relative,
                depth + 1,
                budget,
                sources,
            )?;
            continue;
        }
        if !metadata.is_file() || !is_markdown_path(&relative) {
            continue;
        }
        budget.files += 1;
        if budget.files > MAX_PROJECT_EXPORT_FILES {
            return Err(AppError::InvalidInput(
                "project export exceeds the 10000-file limit".to_string(),
            ));
        }
        let remaining = MAX_EXPORT_INPUT_BYTES.saturating_sub(budget.content_bytes);
        if metadata.len() > remaining as u64 {
            return Err(AppError::InvalidInput(
                "export input exceeds the 100 MiB limit".to_string(),
            ));
        }
        let mut options = CapOpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        let mut file = directory.open_with(&name, &options)?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        Read::by_ref(&mut file)
            .take(remaining.saturating_add(1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > remaining {
            return Err(AppError::InvalidInput(
                "export input exceeds the 100 MiB limit".to_string(),
            ));
        }
        budget.content_bytes = budget.content_bytes.saturating_add(bytes.len());
        sources.push(ProjectExportSource {
            absolute: canonical_root.join(&relative),
            relative,
            bytes,
        });
    }
    Ok(())
}

fn charge_project_entry_budget(
    budget: &mut ProjectScanBudget,
    relative: &Path,
) -> Result<(), AppError> {
    budget.entries = budget.entries.saturating_add(1);
    if budget.entries > MAX_PROJECT_EXPORT_ENTRIES {
        return Err(AppError::InvalidInput(
            "project export exceeds the 20000-entry limit".to_string(),
        ));
    }
    budget.path_bytes = budget.path_bytes.saturating_add(relative.as_os_str().len());
    if budget.path_bytes > MAX_PROJECT_EXPORT_PATH_BYTES {
        return Err(AppError::InvalidInput(
            "project export exceeds the path budget".to_string(),
        ));
    }
    Ok(())
}

fn assemble_project_source_batch(
    batch: &ProjectExportBatch,
    encoding_state: &EncodingState,
) -> Result<String, (String, AppError)> {
    let mut combined = String::new();
    let mut image_bytes = 0;
    for source in &batch.sources {
        let path = source.absolute.to_string_lossy().to_string();
        let content = decode_file_bytes(&source.absolute, &source.bytes, encoding_state)
            .map_err(|error| (path.clone(), error))?;
        let content = embed_confined_image_destinations(
            &content,
            &source.relative,
            &batch.root,
            &mut image_bytes,
        )
        .map_err(|error| (path.clone(), error))?;
        let remaining = MAX_EXPORT_INPUT_BYTES.saturating_sub(combined.len());
        if content.len().saturating_add(2) > remaining {
            return Err((
                path,
                AppError::InvalidInput("export input exceeds the 100 MiB limit".to_string()),
            ));
        }
        combined.push_str(&content);
        combined.push_str("\n\n");
    }
    Ok(combined)
}

fn embed_confined_image_destinations(
    markdown: &str,
    source_relative: &Path,
    root: &Dir,
    aggregate_image_bytes: &mut usize,
) -> Result<String, AppError> {
    let source_parent = source_relative.parent().ok_or_else(|| {
        AppError::PathNotAllowed("export source has no parent directory".to_string())
    })?;

    let mut replacements = Vec::new();
    let mut events = Parser::new(markdown).into_offset_iter();
    while let Some((event, range)) = events.next() {
        let Event::Start(Tag::Image {
            link_type,
            dest_url,
            id,
            ..
        }) = event
        else {
            continue;
        };
        let destination = dest_url.as_ref();
        validate_markdown_resource_destination(destination)?;
        if destination.starts_with("data:image/") {
            let embedded_bytes = validate_embedded_image_destination(destination)?;
            *aggregate_image_bytes = aggregate_image_bytes.saturating_add(embedded_bytes);
            if *aggregate_image_bytes > MAX_EXPORT_INPUT_BYTES {
                return Err(AppError::InvalidInput(
                    "export images exceed the 100 MiB aggregate limit".to_string(),
                ));
            }
            continue;
        }
        let relative = normalize_project_image_path(source_parent, destination)?;
        let bytes = read_confined_image(root, &relative, MAX_EXPORT_IMAGE_BYTES)?;
        *aggregate_image_bytes = aggregate_image_bytes.saturating_add(bytes.len());
        if *aggregate_image_bytes > MAX_EXPORT_INPUT_BYTES {
            return Err(AppError::InvalidInput(
                "export images exceed the 100 MiB aggregate limit".to_string(),
            ));
        }
        let mime = export_image_mime(&bytes).ok_or_else(|| {
            AppError::InvalidInput("export image has an unsupported or invalid format".to_string())
        })?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        let embedded = format!("data:{mime};base64,{encoded}");
        let source = &markdown[range.clone()];
        if link_type == LinkType::Inline {
            let inline_start = source.find("](").map(|index| index + 2).ok_or_else(|| {
                AppError::PathNotAllowed(
                    "image destination could not be mapped to its source file".to_string(),
                )
            })?;
            let destination_offset = source[inline_start..]
                .find(destination)
                .map(|index| inline_start + index)
                .ok_or_else(|| {
                    AppError::PathNotAllowed(
                        "image destination could not be mapped to its source file".to_string(),
                    )
                })?;
            let already_bracketed = destination_offset > 0
                && source.as_bytes().get(destination_offset - 1) == Some(&b'<');
            let replacement = if already_bracketed {
                embedded.clone()
            } else {
                format!("<{embedded}>")
            };
            let start = range.start + destination_offset;
            replacements.push((start, start + destination.len(), replacement));
        } else {
            let definition = events
                .reference_definitions()
                .get(id.as_ref())
                .ok_or_else(|| {
                    AppError::PathNotAllowed(
                        "reference-style image definition could not be located".to_string(),
                    )
                })?;
            if definition.dest.as_ref() != destination {
                return Err(AppError::PathNotAllowed(
                    "reference-style image destination is inconsistent".to_string(),
                ));
            }
            let (start, end, already_bracketed) =
                reference_destination_offset(markdown, definition.span.clone(), destination)?;
            let replacement = if already_bracketed {
                embedded
            } else {
                format!("<{embedded}>")
            };
            replacements.push((start, end, replacement));
        }
    }

    let mut rebased = markdown.to_string();
    replacements.sort_by_key(|(start, _, _)| *start);
    replacements.dedup_by_key(|(start, end, _)| (*start, *end));
    for (start, end, destination) in replacements.into_iter().rev() {
        rebased.replace_range(start..end, &destination);
    }
    Ok(rebased)
}

fn normalize_project_image_path(
    source_parent: &Path,
    destination: &str,
) -> Result<PathBuf, AppError> {
    let decoded = percent_decode_image_destination(destination)?;
    let combined = source_parent.join(decoded.replace('\\', "/"));
    let mut normalized = PathBuf::new();
    for component in combined.components() {
        match component {
            std::path::Component::Normal(part) => normalized.push(part),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir if normalized.pop() => {}
            _ => {
                return Err(AppError::PathNotAllowed(
                    "image destination resolves outside the project".to_string(),
                ));
            }
        }
    }
    Ok(normalized)
}

fn percent_decode_image_destination(destination: &str) -> Result<String, AppError> {
    let bytes = destination.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len() {
            return Err(AppError::PathNotAllowed(
                "image destination contains invalid percent encoding".to_string(),
            ));
        }
        let (Some(high), Some(low)) = (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
        else {
            return Err(AppError::PathNotAllowed(
                "image destination contains invalid percent encoding".to_string(),
            ));
        };
        decoded.push((high << 4) | low);
        index += 3;
    }
    String::from_utf8(decoded)
        .map_err(|_| AppError::PathNotAllowed("image destination is not valid UTF-8".to_string()))
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn read_confined_image(
    root: &Dir,
    relative: &Path,
    byte_limit: usize,
) -> Result<Vec<u8>, AppError> {
    let mut components = relative.components().collect::<Vec<_>>();
    let file_name = match components.pop() {
        Some(std::path::Component::Normal(name)) => name.to_owned(),
        _ => {
            return Err(AppError::PathNotAllowed(
                "image destination is invalid".to_string(),
            ));
        }
    };
    let mut current = root.try_clone()?;
    for component in components {
        let std::path::Component::Normal(name) = component else {
            return Err(AppError::PathNotAllowed(
                "image destination is invalid".to_string(),
            ));
        };
        let metadata = current.symlink_metadata(name)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(AppError::PathNotAllowed(
                "image destination contains an unsafe directory component".to_string(),
            ));
        }
        current = current.open_dir_nofollow(name)?;
    }
    let metadata = current.symlink_metadata(&file_name)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::PathNotAllowed(
            "image destination is not a regular file".to_string(),
        ));
    }
    if metadata.len() > byte_limit as u64 {
        return Err(AppError::InvalidInput(
            "export image exceeds the 20 MiB limit".to_string(),
        ));
    }
    let mut options = CapOpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let mut file = current.open_with(&file_name, &options)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(byte_limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > byte_limit {
        return Err(AppError::InvalidInput(
            "export image exceeds the 20 MiB limit".to_string(),
        ));
    }
    Ok(bytes)
}

fn export_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn reference_destination_offset(
    markdown: &str,
    definition_span: std::ops::Range<usize>,
    destination: &str,
) -> Result<(usize, usize, bool), AppError> {
    let definition = markdown.get(definition_span.clone()).ok_or_else(|| {
        AppError::PathNotAllowed("reference-style image definition has an invalid span".to_string())
    })?;
    let marker = definition.find("]:").ok_or_else(|| {
        AppError::PathNotAllowed("reference-style image definition has invalid syntax".to_string())
    })?;
    let after_marker = marker + 2;
    let value_start = after_marker
        + definition[after_marker..]
            .find(|character: char| !character.is_whitespace())
            .ok_or_else(|| {
                AppError::PathNotAllowed(
                    "reference-style image definition has no destination".to_string(),
                )
            })?;
    let bracketed = definition.as_bytes().get(value_start) == Some(&b'<');
    let destination_start = value_start + usize::from(bracketed);
    if !definition[destination_start..].starts_with(destination) {
        return Err(AppError::PathNotAllowed(
            "reference-style image destination could not be mapped to its definition".to_string(),
        ));
    }
    let destination_end = destination_start + destination.len();
    let valid_terminator = if bracketed {
        definition.as_bytes().get(destination_end) == Some(&b'>')
    } else {
        definition[destination_end..]
            .chars()
            .next()
            .is_none_or(char::is_whitespace)
    };
    if !valid_terminator {
        return Err(AppError::PathNotAllowed(
            "reference-style image destination has an invalid boundary".to_string(),
        ));
    }
    Ok((
        definition_span.start + destination_start,
        definition_span.start + destination_end,
        bracketed,
    ))
}

fn compare_export_names(left: &str, right: &str) -> std::cmp::Ordering {
    match (extract_export_number(left), extract_export_number(right)) {
        (
            Some((left_prefix, left_value, left_suffix)),
            Some((right_prefix, right_value, right_suffix)),
        ) => left_prefix
            .cmp(&right_prefix)
            .then_with(|| left_value.cmp(&right_value))
            .then_with(|| left_suffix.cmp(&right_suffix))
            .then_with(|| left.cmp(right)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => left.to_lowercase().cmp(&right.to_lowercase()),
    }
}

fn extract_export_number(name: &str) -> Option<(String, u32, String)> {
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let chars = stem.char_indices().collect::<Vec<_>>();
    for (index, (start, first)) in chars.iter().copied().enumerate() {
        let ascii = first.is_ascii_digit();
        let chinese = is_chinese_number_char(first);
        if !ascii && !chinese {
            continue;
        }
        let mut end = start + first.len_utf8();
        for (_, next) in chars.iter().skip(index + 1).copied() {
            if (ascii && next.is_ascii_digit()) || (chinese && is_chinese_number_char(next)) {
                end += next.len_utf8();
            } else {
                break;
            }
        }
        let raw = &stem[start..end];
        let value = if ascii {
            raw.parse::<u32>().ok()
        } else {
            parse_chinese_export_number(raw)
        }?;
        return Some((
            stem[..start].to_lowercase(),
            value,
            stem[end..].to_lowercase(),
        ));
    }
    None
}

fn is_chinese_number_char(character: char) -> bool {
    matches!(
        character,
        '零' | '一' | '二' | '三' | '四' | '五' | '六' | '七' | '八' | '九' | '十' | '百'
    )
}

fn chinese_digit(character: char) -> Option<u32> {
    match character {
        '零' => Some(0),
        '一' => Some(1),
        '二' => Some(2),
        '三' => Some(3),
        '四' => Some(4),
        '五' => Some(5),
        '六' => Some(6),
        '七' => Some(7),
        '八' => Some(8),
        '九' => Some(9),
        _ => None,
    }
}

fn parse_chinese_export_number(raw: &str) -> Option<u32> {
    let chars = raw.chars().collect::<Vec<_>>();
    if chars.len() == 1 {
        return (chars[0] == '十')
            .then_some(10)
            .or_else(|| chinese_digit(chars[0]));
    }
    let mut total = 0;
    let mut current = 0;
    for character in chars {
        match character {
            '百' => {
                total += current.max(1) * 100;
                current = 0;
            }
            '十' => {
                total += current.max(1) * 10;
                current = 0;
            }
            other => current = chinese_digit(other)?,
        }
    }
    Some(total + current)
}

#[cfg(test)]
async fn collect_project_markdown_files(project_dir: &Path) -> Result<Vec<String>, AppError> {
    Ok(collect_project_export_sources(project_dir)
        .await?
        .sources
        .into_iter()
        .map(|source| source.absolute.to_string_lossy().to_string())
        .collect())
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
}

fn validate_markdown_resource_references(markdown: &str) -> Result<(), AppError> {
    for event in Parser::new(markdown) {
        let Event::Start(Tag::Image { dest_url, .. }) = event else {
            continue;
        };
        validate_markdown_resource_destination(dest_url.as_ref())?;
    }
    Ok(())
}

fn validate_markdown_resource_destination(destination: &str) -> Result<(), AppError> {
    let destination = destination.trim();
    if destination.is_empty()
        || destination.contains('\0')
        || destination.chars().any(char::is_control)
    {
        return Err(AppError::PathNotAllowed(
            "empty or invalid image destination".to_string(),
        ));
    }
    if destination.starts_with("data:image/") {
        validate_embedded_image_destination(destination)?;
        return Ok(());
    }
    if destination.starts_with('/')
        || destination.starts_with('\\')
        || destination.starts_with('~')
        || destination.contains(':')
        || destination.contains('?')
        || destination.contains('#')
    {
        return Err(AppError::PathNotAllowed(
            "image destination must be project-relative".to_string(),
        ));
    }
    Ok(())
}

fn validate_embedded_image_destination(destination: &str) -> Result<usize, AppError> {
    let (mime, encoded) = destination.split_once(";base64,").ok_or_else(|| {
        AppError::InvalidInput("inline export image must use base64 encoding".to_string())
    })?;
    let expected_mime = match mime {
        "data:image/png" => "image/png",
        "data:image/jpeg" => "image/jpeg",
        "data:image/gif" => "image/gif",
        "data:image/webp" => "image/webp",
        _ => {
            return Err(AppError::InvalidInput(
                "inline export image format is unsupported".to_string(),
            ));
        }
    };
    if encoded.len() > MAX_EXPORT_IMAGE_BYTES.saturating_mul(2) {
        return Err(AppError::InvalidInput(
            "inline export image exceeds the 20 MiB limit".to_string(),
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| AppError::InvalidInput("inline export image is invalid".to_string()))?;
    if bytes.len() > MAX_EXPORT_IMAGE_BYTES || export_image_mime(&bytes) != Some(expected_mime) {
        return Err(AppError::InvalidInput(
            "inline export image signature does not match its format".to_string(),
        ));
    }
    Ok(bytes.len())
}

fn export_options_error() -> AppError {
    AppError::InvalidInput(
        "Forbidden argument in extra_args: Unsupported export options".to_string(),
    )
}

fn validate_export_request_id(request_id: &str) -> Result<&str, AppError> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err(AppError::InvalidInput(
            "export request id cannot be empty".to_string(),
        ));
    }
    if request_id.len() > 128
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(AppError::InvalidInput(
            "export request id is invalid".to_string(),
        ));
    }
    Ok(request_id)
}

fn validate_export_extra_args_shape(
    format: &str,
    extra_args: &[String],
) -> Result<Vec<PathBuf>, AppError> {
    if extra_args.is_empty() {
        return Ok(Vec::new());
    }
    if format != "html" || extra_args.len() != 2 || extra_args[0] != "--include-in-header" {
        return Err(export_options_error());
    }

    let path = PathBuf::from(&extra_args[1]);
    let temp_dir = std::env::temp_dir();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(export_options_error)?;
    if path.parent() != Some(temp_dir.as_path())
        || !file_name.starts_with("novelist-export-theme-")
        || !file_name.ends_with(".html")
    {
        return Err(export_options_error());
    }
    Ok(vec![path])
}

fn validate_export_extra_args(
    format: &str,
    extra_args: &[String],
    request_id: Option<&str>,
) -> Result<Vec<PathBuf>, AppError> {
    let css_paths = validate_export_extra_args_shape(format, extra_args)?;
    if css_paths.is_empty() {
        return Ok(css_paths);
    }

    let request_id = validate_export_request_id(request_id.ok_or_else(export_options_error)?)?;
    let expected = std::env::temp_dir().join(format!("novelist-export-theme-{request_id}.html"));
    if css_paths[0] != expected {
        return Err(export_options_error());
    }
    Ok(css_paths)
}

async fn validate_export_extra_args_with_cleanup(
    format: &str,
    extra_args: &mut [String],
    request_id: Option<&str>,
) -> Result<Vec<PathBuf>, AppError> {
    match validate_export_extra_args(format, extra_args, request_id) {
        Ok(paths) if paths.is_empty() => Ok(paths),
        Ok(paths) => {
            let request_id =
                validate_export_request_id(request_id.ok_or_else(export_options_error)?)?;
            let Some(staged) = take_staged_export_css(request_id, &paths[0])? else {
                return Err(export_options_error());
            };
            let original_path = staged.path;
            let private_path =
                tokio::task::spawn_blocking(move || write_private_unpublished_css(&staged.header))
                    .await
                    .map_err(|error| {
                        AppError::Custom(format!("export stylesheet task failed: {error}"))
                    })??;
            if let Err(error) = tokio::fs::remove_file(&original_path).await {
                if error.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(
                        target: "novelist::export",
                        path = %original_path.display(),
                        %error,
                        "validated export stylesheet cleanup failed"
                    );
                }
            }
            extra_args[1] = private_path.to_string_lossy().to_string();
            Ok(vec![private_path])
        }
        Err(error) => {
            let owned_path = request_owned_staged_css(extra_args, request_id);
            let staged = match (request_id, owned_path.as_deref()) {
                (Some(request_id), Some(path)) => take_staged_export_css(request_id, path)?,
                _ => None,
            };
            let cleanup_failure = match staged {
                Some(staged) => cleanup_css_resources(&[staged.path], None).await,
                None => None,
            };
            if let Some(cleanup_failure) = cleanup_failure {
                log_cleanup_warning(Some(&cleanup_failure), "export option validation failure");
                return Err(AppError::Custom(format!(
                    "{error}; cleanup also failed: {}",
                    cleanup_failure.message
                )));
            }
            Err(error)
        }
    }
}

fn write_private_unpublished_css(bytes: &[u8]) -> Result<PathBuf, AppError> {
    let mut file = tempfile::Builder::new()
        .prefix(".novelist-export-theme-")
        .suffix(".html")
        .tempfile_in(std::env::temp_dir())?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    let (_, path) = file.keep().map_err(|error| AppError::Io(error.error))?;
    Ok(path)
}

fn request_owned_staged_css(extra_args: &[String], request_id: Option<&str>) -> Option<PathBuf> {
    let request_id = validate_export_request_id(request_id?).ok()?;
    let expected = std::env::temp_dir().join(format!("novelist-export-theme-{request_id}.html"));
    extra_args
        .iter()
        .any(|argument| Path::new(argument) == expected)
        .then_some(expected)
}

async fn cleanup_temp_resources(
    temp_input: &Path,
    temp_dir: Option<&Path>,
    css_paths: &[PathBuf],
    cleanup_failure_hook: Option<&CleanupFailureHook<'_>>,
) -> Option<pandoc::PandocFailure> {
    let mut failures = cleanup_css_failures(css_paths, cleanup_failure_hook).await;
    if temp_dir.is_none() {
        if let Err(err) = remove_if_exists(temp_input, cleanup_failure_hook).await {
            failures.push(format!("{}: {err}", temp_input.display()));
        }
    }
    if let Some(temp_dir) = temp_dir {
        let removal = match cleanup_failure_hook.and_then(|hook| hook(temp_dir)) {
            Some(err) => Err(err),
            None => tokio::fs::remove_dir_all(temp_dir).await,
        };
        if let Err(err) = removal {
            if err.kind() != std::io::ErrorKind::NotFound {
                failures.push(format!("{}: {err}", temp_dir.display()));
            }
        }
    }
    cleanup_failure_from_messages(failures)
}

async fn cleanup_css_resources(
    css_paths: &[PathBuf],
    cleanup_failure_hook: Option<&CleanupFailureHook<'_>>,
) -> Option<pandoc::PandocFailure> {
    let failures = cleanup_css_failures(css_paths, cleanup_failure_hook).await;
    cleanup_failure_from_messages(failures)
}

async fn cleanup_css_failures(
    css_paths: &[PathBuf],
    cleanup_failure_hook: Option<&CleanupFailureHook<'_>>,
) -> Vec<String> {
    let mut failures = Vec::new();
    for path in css_paths {
        if let Err(err) = remove_if_exists(path, cleanup_failure_hook).await {
            failures.push(format!("{}: {err}", path.display()));
        }
    }
    failures
}

fn cleanup_failure_from_messages(failures: Vec<String>) -> Option<pandoc::PandocFailure> {
    if failures.is_empty() {
        None
    } else {
        Some(pandoc::PandocFailure::new(
            pandoc::PandocStage::Cleanup,
            format!(
                "failed to remove temporary export resources: {}",
                failures.join("; ")
            ),
        ))
    }
}

async fn remove_if_exists(
    path: &Path,
    cleanup_failure_hook: Option<&CleanupFailureHook<'_>>,
) -> Result<(), std::io::Error> {
    if let Some(err) = cleanup_failure_hook.and_then(|hook| hook(path)) {
        return Err(err);
    }
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::io::Write;
    #[cfg(unix)]
    use std::process::Stdio;
    use tempfile::TempDir;

    #[allow(dead_code)]
    fn export_temp_dirs(root: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("novelist-export-"))
            })
            .collect()
    }

    #[test]
    fn test_pandoc_status_serialize() {
        let status = PandocStatus {
            available: true,
            version: Some("pandoc 3.1".to_string()),
            resolved_path: Some("/usr/local/bin/pandoc".to_string()),
            override_path: None,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["available"], true);
        assert_eq!(json["version"], "pandoc 3.1");
    }

    #[test]
    fn test_pandoc_status_unavailable() {
        let status = PandocStatus {
            available: false,
            version: None,
            resolved_path: None,
            override_path: None,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["available"], false);
        assert!(json["version"].is_null());
    }

    #[tokio::test]
    async fn test_export_rejects_unsupported_format() {
        let enc = EncodingState::new();
        let result = export_project_with_pandoc(
            vec![],
            "/tmp/out.xyz".to_string(),
            "xyz".to_string(),
            vec![],
            &enc,
            ExportRunOptions {
                pandoc_bin: "/bin/false",
                timeout: Duration::from_secs(1),
                cancel_rx: None,
                temp_workspace: None,
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
        )
        .await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Unsupported export format"));
    }

    #[tokio::test]
    async fn test_export_rejects_forbidden_args() {
        let enc = EncodingState::new();
        let result = export_project_with_pandoc(
            vec![],
            "/tmp/out.html".to_string(),
            "html".to_string(),
            vec!["--output=/tmp/evil".to_string()],
            &enc,
            ExportRunOptions {
                pandoc_bin: "/bin/false",
                timeout: Duration::from_secs(1),
                cancel_rx: None,
                temp_workspace: None,
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
        )
        .await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Forbidden argument"));
    }

    #[tokio::test]
    async fn test_export_rejects_extract_media() {
        let enc = EncodingState::new();
        let result = export_project_with_pandoc(
            vec![],
            "/tmp/out.html".to_string(),
            "html".to_string(),
            vec!["--extract-media=/tmp".to_string()],
            &enc,
            ExportRunOptions {
                pandoc_bin: "/bin/false",
                timeout: Duration::from_secs(1),
                cancel_rx: None,
                temp_workspace: None,
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
        )
        .await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Forbidden argument"));
    }

    #[test]
    fn export_extra_args_allow_only_request_owned_staged_css() {
        let request_id = "export-1234-abcd";
        let expected =
            std::env::temp_dir().join(format!("novelist-export-theme-{request_id}.html"));
        let args = vec![
            "--include-in-header".to_string(),
            expected.to_string_lossy().to_string(),
        ];

        assert_eq!(
            validate_export_extra_args("html", &args, Some(request_id)).unwrap(),
            vec![expected.clone()]
        );
        assert!(validate_export_extra_args("html", &[], Some(request_id))
            .unwrap()
            .is_empty());
        assert!(validate_export_extra_args("epub", &args, Some(request_id)).is_err());
    }

    #[test]
    fn export_extra_args_reject_process_output_and_response_file_controls() {
        for args in [
            vec!["-o", "/tmp/alternate.html"],
            vec!["--output", "/tmp/alternate.html"],
            vec!["--filter", "/tmp/run-me"],
            vec!["--lua-filter=/tmp/run.lua"],
            vec!["--pdf-engine", "/tmp/engine"],
            vec!["@/tmp/response-file"],
            vec!["--css=/tmp/novelist-export-theme-export-1234.css"],
        ] {
            let args = args.into_iter().map(str::to_string).collect::<Vec<_>>();
            let error = validate_export_extra_args("html", &args, Some("export-1234"))
                .expect_err("privileged Pandoc controls must be rejected");
            assert!(error.to_string().contains("Unsupported export options"));
        }
    }

    #[test]
    fn export_extra_args_reject_css_traversal_wrong_owner_and_wrong_format() {
        let request_id = "export-owner";
        let temp = std::env::temp_dir();
        let traversal = temp
            .join("nested")
            .join("..")
            .join(format!("novelist-export-theme-{request_id}.html"));
        let wrong_owner = temp.join("novelist-export-theme-export-other.html");

        for (format, path) in [
            ("html", traversal),
            ("html", wrong_owner),
            (
                "docx",
                temp.join(format!("novelist-export-theme-{request_id}.html")),
            ),
            (
                "epub",
                temp.join(format!("novelist-export-theme-{request_id}.html")),
            ),
        ] {
            let args = vec![
                "--include-in-header".to_string(),
                path.to_string_lossy().to_string(),
            ];
            assert!(validate_export_extra_args(format, &args, Some(request_id)).is_err());
        }
    }

    #[tokio::test]
    async fn option_validation_failure_cleans_request_owned_staged_css() {
        let request_id = format!(
            "invalid-options-{}-{}",
            std::process::id(),
            EXPORT_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let path = PathBuf::from(
            stage_export_css(
                request_id.clone(),
                ":root {\n--novelist-text: red;\n}".to_string(),
            )
            .await
            .unwrap(),
        );
        let mut args = vec![
            "--include-in-header".to_string(),
            path.to_string_lossy().to_string(),
            "--forbidden".to_string(),
        ];

        let result =
            validate_export_extra_args_with_cleanup("html", &mut args, Some(&request_id)).await;

        assert!(result.is_err());
        assert!(
            !path.exists(),
            "request-owned staged CSS leaked after validation failure"
        );
    }

    #[test]
    fn expired_staged_export_css_removes_registry_entry_and_file() {
        let request_id = format!(
            "expired-css-{}-{}",
            std::process::id(),
            EXPORT_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(format!("novelist-export-theme-{request_id}.html"));
        std::fs::write(&path, "<style>body { color: red; }</style>").unwrap();
        let mut staged = STAGED_EXPORT_CSS.lock().unwrap();
        staged.insert(
            request_id.clone(),
            StagedExportCss {
                path: path.clone(),
                header: b"<style>body { color: red; }</style>".to_vec(),
                created: Instant::now() - PENDING_EXPORT_CANCEL_TTL - Duration::from_secs(1),
            },
        );

        purge_expired_staged_export_css(&mut staged);

        assert!(!staged.contains_key(&request_id));
        drop(staged);
        assert!(!path.exists(), "expired staged CSS file was not removed");
    }

    #[test]
    fn expired_staged_export_css_keeps_registry_entry_when_cleanup_fails() {
        let request_id = format!(
            "expired-css-retry-{}-{}",
            std::process::id(),
            EXPORT_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(format!("novelist-export-theme-{request_id}"));
        std::fs::create_dir(&path).unwrap();
        let mut staged = STAGED_EXPORT_CSS.lock().unwrap();
        staged.insert(
            request_id.clone(),
            StagedExportCss {
                path: path.clone(),
                header: b"<style>body { color: red; }</style>".to_vec(),
                created: Instant::now() - PENDING_EXPORT_CANCEL_TTL - Duration::from_secs(1),
            },
        );

        purge_expired_staged_export_css(&mut staged);

        assert!(
            staged.contains_key(&request_id),
            "failed cleanup must remain registered for a later retry"
        );
        staged.remove(&request_id);
        drop(staged);
        std::fs::remove_dir(path).unwrap();
    }

    #[tokio::test]
    async fn matching_theme_path_without_backend_staging_is_rejected() {
        let request_id = format!(
            "forged-theme-{}-{}",
            std::process::id(),
            EXPORT_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let path = std::env::temp_dir().join(format!("novelist-export-theme-{request_id}.html"));
        std::fs::write(&path, "<style>:root { --novelist-text: red; }</style>").unwrap();
        let mut args = vec![
            "--include-in-header".to_string(),
            path.to_string_lossy().to_string(),
        ];

        let result =
            validate_export_extra_args_with_cleanup("html", &mut args, Some(&request_id)).await;

        assert!(result.is_err());
        let _ = std::fs::remove_file(path);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn export_temp_directory_and_plaintext_input_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let root = TempDir::new().unwrap();
        let temp_dir = unique_export_temp_dir(Some(root.path())).await.unwrap();
        let temp_input = temp_dir.join("input.md");
        write_temp_input(&temp_input, "# 私密正文\n").await.unwrap();

        assert_eq!(
            std::fs::metadata(&temp_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&temp_input).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(
            cleanup_temp_resources(&temp_input, Some(&temp_dir), &[], None)
                .await
                .is_none()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn staged_export_css_is_owner_only_create_new_and_bounded() {
        use std::os::unix::fs::PermissionsExt;

        let request_id = format!(
            "css-stage-{}-{}",
            std::process::id(),
            EXPORT_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let generated_css =
            format!(":root {{\n--novelist-text: red;\n}}\n{EXPORT_THEME_CSS_SUFFIX}");
        let path = stage_export_css(request_id.clone(), generated_css.clone())
            .await
            .unwrap();
        let path = PathBuf::from(path);

        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(
            stage_export_css(request_id, ":root {\n--novelist-text: blue;\n}".to_string())
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("<style>\n{generated_css}\n</style>\n")
        );
        std::fs::remove_file(path).unwrap();

        let oversized = "x".repeat(MAX_EXPORT_CSS_BYTES + 1);
        assert!(stage_export_css("css-too-large".to_string(), oversized)
            .await
            .is_err());
        assert!(stage_export_css(
            "css-external-url".to_string(),
            ":root {\n--novelist-bg: url(https://example.com/a.png);\n}".to_string(),
        )
        .await
        .is_err());
        assert!(stage_export_css(
            "css-external-import".to_string(),
            ":root {\n--novelist-bg: @import 'https://example.com/theme.css';\n}".to_string(),
        )
        .await
        .is_err());
        for (request_id, css) in [
            (
                "css-style-breakout",
                ":root {\n--novelist-text: red</style><script>alert(1)</script><style>;\n}",
            ),
            (
                "css-escaped-url",
                ":root {\n--novelist-bg: u\\72l(https://example.com);\n}",
            ),
            (
                "css-comment-url",
                ":root {\n--novelist-bg: u/**/rl(https://example.com);\n}",
            ),
            (
                "css-image-set",
                ":root {\n--novelist-bg: image-set('https://example.com/a.png' 1x);\n}",
            ),
        ] {
            assert!(stage_export_css(request_id.to_string(), css.to_string())
                .await
                .is_err());
        }
    }

    #[test]
    fn export_theme_css_accepts_only_the_generated_rule_suffix() {
        let generated = format!(":root {{\n--novelist-text: red;\n}}\n{EXPORT_THEME_CSS_SUFFIX}");
        assert!(validate_export_theme_css(&generated).is_ok());

        let arbitrary = ":root {\n--novelist-text: red;\n}\np { color: red; }";
        assert!(validate_export_theme_css(arbitrary).is_err());
    }

    #[tokio::test]
    async fn staged_css_is_cleaned_when_project_contains_no_markdown() {
        let project = TempDir::new().unwrap();
        let request_id = format!(
            "empty-project-{}-{}",
            std::process::id(),
            EXPORT_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let css = PathBuf::from(
            stage_export_css(request_id, ":root {\n--novelist-text: red;\n}".to_string())
                .await
                .unwrap(),
        );

        let batch = collect_project_export_sources(project.path())
            .await
            .unwrap();
        let input_files = batch
            .sources
            .into_iter()
            .map(|source| source.absolute.to_string_lossy().to_string())
            .collect();
        let error = resolve_export_input_files(input_files, std::slice::from_ref(&css))
            .await
            .expect_err("empty project must fail");

        assert!(matches!(error, AppError::InvalidInput(_)));
        assert!(!css.exists(), "staged CSS leaked after empty project scan");
    }

    #[tokio::test]
    async fn staged_css_is_cleaned_when_destination_conflicts_with_source() {
        let dir = TempDir::new().unwrap();
        let input = dir.path().join("第一章.md");
        std::fs::write(&input, "# 第一章\n").unwrap();
        let request_id = format!(
            "output-conflict-{}-{}",
            std::process::id(),
            EXPORT_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let css = PathBuf::from(
            stage_export_css(request_id, ":root {\n--novelist-text: red;\n}".to_string())
                .await
                .unwrap(),
        );
        let encoding_state = EncodingState::new();

        let result = export_project_with_pandoc(
            vec![input.to_string_lossy().to_string()],
            input.to_string_lossy().to_string(),
            "html".to_string(),
            vec![
                "--include-in-header".to_string(),
                css.to_string_lossy().to_string(),
            ],
            &encoding_state,
            ExportRunOptions {
                pandoc_bin: "/bin/false",
                timeout: Duration::from_secs(1),
                cancel_rx: None,
                temp_workspace: Some(dir.path()),
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
        )
        .await;

        assert!(result.is_err());
        assert!(!css.exists(), "staged CSS leaked after output collision");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn staged_css_is_cleaned_when_resource_path_is_invalid() {
        let dir = TempDir::new().unwrap();
        let source_dir = dir.path().join("invalid:resource");
        std::fs::create_dir(&source_dir).unwrap();
        let input = source_dir.join("chapter.md");
        std::fs::write(&input, "# chapter\n").unwrap();
        let request_id = format!(
            "resource-path-{}-{}",
            std::process::id(),
            EXPORT_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let css = PathBuf::from(
            stage_export_css(request_id, ":root {\n--novelist-text: red;\n}".to_string())
                .await
                .unwrap(),
        );
        let encoding_state = EncodingState::new();

        let result = export_project_with_pandoc(
            vec![input.to_string_lossy().to_string()],
            dir.path().join("out.html").to_string_lossy().to_string(),
            "html".to_string(),
            vec![
                "--include-in-header".to_string(),
                css.to_string_lossy().to_string(),
            ],
            &encoding_state,
            ExportRunOptions {
                pandoc_bin: "/bin/false",
                timeout: Duration::from_secs(1),
                cancel_rx: None,
                temp_workspace: Some(dir.path()),
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
        )
        .await;

        assert!(result.is_err());
        assert!(
            !css.exists(),
            "staged CSS leaked after resource-path rejection"
        );
        assert!(export_temp_dirs(dir.path()).is_empty());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_export_temp_directory_and_plaintext_have_owner_only_dacls() {
        let root = TempDir::new().unwrap();
        let temp_dir = unique_export_temp_dir(Some(root.path())).await.unwrap();
        let temp_input = temp_dir.join("input.md");
        write_temp_input(&temp_input, "# 私密正文\n").await.unwrap();

        assert!(windows_path_has_protected_single_ace_dacl(&temp_dir));
        assert!(windows_path_has_protected_single_ace_dacl(&temp_input));
        assert!(
            cleanup_temp_resources(&temp_input, Some(&temp_dir), &[], None)
                .await
                .is_none()
        );
    }

    #[cfg(windows)]
    fn windows_path_has_protected_single_ace_dacl(path: &Path) -> bool {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Security::{
            AclSizeInformation, GetAclInformation, GetFileSecurityW, GetSecurityDescriptorControl,
            GetSecurityDescriptorDacl, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
            SE_DACL_PROTECTED,
        };

        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let mut needed = 0;
        unsafe {
            GetFileSecurityW(
                wide.as_ptr(),
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                0,
                &mut needed,
            );
        }
        if needed == 0 {
            return false;
        }
        let mut descriptor = vec![0u8; needed as usize];
        if unsafe {
            GetFileSecurityW(
                wide.as_ptr(),
                DACL_SECURITY_INFORMATION,
                descriptor.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return false;
        }
        let mut control = 0;
        let mut revision = 0;
        if unsafe {
            GetSecurityDescriptorControl(
                descriptor.as_mut_ptr().cast(),
                &mut control,
                &mut revision,
            )
        } == 0
            || control & SE_DACL_PROTECTED == 0
        {
            return false;
        }
        let mut present = 0;
        let mut defaulted = 0;
        let mut dacl = std::ptr::null_mut();
        if unsafe {
            GetSecurityDescriptorDacl(
                descriptor.as_mut_ptr().cast(),
                &mut present,
                &mut dacl,
                &mut defaulted,
            )
        } == 0
            || present == 0
            || dacl.is_null()
        {
            return false;
        }
        let mut info = ACL_SIZE_INFORMATION::default();
        unsafe {
            GetAclInformation(
                dacl,
                std::ptr::addr_of_mut!(info).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            ) != 0
                && info.AceCount == 1
        }
    }

    #[tokio::test]
    async fn test_export_allows_valid_formats() {
        let enc = EncodingState::new();
        for fmt in &["html", "pdf", "docx", "epub"] {
            // These will fail because input_files is empty or pandoc isn't available,
            // but they should NOT fail on format validation
            let result = export_project_with_pandoc(
                vec!["/nonexistent/file.md".to_string()],
                "/tmp/out".to_string(),
                fmt.to_string(),
                vec![],
                &enc,
                ExportRunOptions {
                    pandoc_bin: "/bin/false",
                    timeout: Duration::from_secs(1),
                    cancel_rx: None,
                    temp_workspace: None,
                    source_root: None,
                    prepared_input: None,
                    commit_gate: None,
                },
            )
            .await;
            if let Err(e) = &result {
                let msg = e.to_string();
                assert!(
                    !msg.contains("Unsupported export format"),
                    "format '{}' was incorrectly rejected",
                    fmt
                );
            }
        }
    }

    #[cfg(unix)]
    fn make_copying_fake_pandoc(dir: &TempDir) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.path().join("fake-pandoc-copy.sh");
        let mut f = std::fs::File::create(&script).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "in=\"$1\"").unwrap();
        writeln!(f, "shift").unwrap();
        writeln!(f, "out=\"\"").unwrap();
        writeln!(f, "while [ \"$#\" -gt 0 ]; do").unwrap();
        writeln!(f, "  if [ \"$1\" = \"-o\" ]; then shift; out=\"$1\"; fi").unwrap();
        writeln!(f, "  shift || true").unwrap();
        writeln!(f, "done").unwrap();
        writeln!(f, "/bin/cat \"$in\" > \"$out\"").unwrap();
        writeln!(f, "exit 0").unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        script
    }

    #[cfg(unix)]
    fn make_recording_copying_fake_pandoc(dir: &TempDir) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.path().join("fake-pandoc-record.sh");
        let argv = dir.path().join("pandoc-argv.txt");
        let mut f = std::fs::File::create(&script).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "in=\"$1\"").unwrap();
        writeln!(f, "shift").unwrap();
        writeln!(f, "out=''").unwrap();
        writeln!(f, "printf '%s\\n' \"$@\" > '{}'", argv.display()).unwrap();
        writeln!(f, "while [ \"$#\" -gt 0 ]; do").unwrap();
        writeln!(f, "  if [ \"$1\" = '-o' ]; then shift; out=$1; fi").unwrap();
        writeln!(f, "  shift || true").unwrap();
        writeln!(f, "done").unwrap();
        writeln!(f, "/bin/cat \"$in\" > \"$out\"").unwrap();
        writeln!(f, "exit 0").unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        (script, argv)
    }

    #[cfg(unix)]
    fn make_sleeping_fake_pandoc(dir: &TempDir) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.path().join("fake-pandoc-sleep.sh");
        let mut f = std::fs::File::create(&script).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "/bin/sleep 30").unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        script
    }

    #[cfg(unix)]
    fn make_copying_fake_pandoc_with_retained_pipe(dir: &TempDir) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.path().join("fake-pandoc-retained-pipe.sh");
        let pid_file = dir.path().join("retained-pipe.pid");
        let mut f = std::fs::File::create(&script).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "in=\"$1\"").unwrap();
        writeln!(f, "shift").unwrap();
        writeln!(f, "out=''").unwrap();
        writeln!(f, "while [ \"$#\" -gt 0 ]; do").unwrap();
        writeln!(f, "  if [ \"$1\" = '-o' ]; then shift; out=$1; fi").unwrap();
        writeln!(f, "  shift || true").unwrap();
        writeln!(f, "done").unwrap();
        writeln!(f, "/bin/cat \"$in\" > \"$out\"").unwrap();
        writeln!(f, "/bin/sleep 30 &").unwrap();
        writeln!(f, "printf '%s' \"$!\" > '{}'", pid_file.display()).unwrap();
        writeln!(f, "exit 0").unwrap();
        drop(f);
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        (script, pid_file)
    }

    #[allow(dead_code)]
    fn write_encoded(path: &Path, encoding: &'static encoding_rs::Encoding, text: &str) {
        let (bytes, _, had_errors) = encoding.encode(text);
        assert!(!had_errors, "test fixture must be encodable");
        std::fs::write(path, bytes.as_ref()).unwrap();
    }

    fn pandoc_failure_from_error(err: AppError) -> pandoc::PandocFailure {
        let msg = err.to_string();
        let json = msg
            .strip_prefix("NOVELIST_PANDOC_FAILURE_JSON:")
            .expect("expected structured pandoc failure payload");
        serde_json::from_str(json).unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn export_decodes_legacy_cjk_inputs_before_pandoc_for_html_docx_and_epub() {
        let dir = TempDir::new().unwrap();
        let fake = make_copying_fake_pandoc(&dir);
        let enc = EncodingState::new();
        let gbk = dir.path().join("第一章-gbk.md");
        let big5 = dir.path().join("第二章-big5.md");
        let sjis = dir.path().join("第三章-sjis.md");
        let utf8 = dir.path().join("第四章-utf8.md");
        write_encoded(&gbk, encoding_rs::GBK, "# 第一章\n中文简体。\n");
        write_encoded(&big5, encoding_rs::BIG5, "# 第二章\n繁體中文。\n");
        write_encoded(&sjis, encoding_rs::SHIFT_JIS, "# 第三章\n日本語の段落。\n");
        std::fs::write(&utf8, "# 第四章\nUTF-8 mixed English 中文。\n").unwrap();

        for format in ["html", "docx", "epub"] {
            let out = dir.path().join(format!("out.{format}"));
            let result = export_project_with_pandoc(
                vec![
                    gbk.to_string_lossy().to_string(),
                    big5.to_string_lossy().to_string(),
                    sjis.to_string_lossy().to_string(),
                    utf8.to_string_lossy().to_string(),
                ],
                out.to_string_lossy().to_string(),
                format.to_string(),
                vec![],
                &enc,
                ExportRunOptions {
                    pandoc_bin: fake.to_str().unwrap(),
                    timeout: Duration::from_secs(10),
                    cancel_rx: None,
                    temp_workspace: Some(dir.path()),
                    source_root: None,
                    prepared_input: None,
                    commit_gate: None,
                },
            )
            .await;
            assert!(result.is_ok(), "{format}: {result:?}");
            let exported = std::fs::read_to_string(&out).unwrap();
            assert!(exported.contains("第一章"), "{format}: {exported}");
            assert!(exported.contains("繁體中文"), "{format}: {exported}");
            assert!(exported.contains("日本語"), "{format}: {exported}");
            assert!(exported.contains("UTF-8 mixed"), "{format}: {exported}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn export_passes_source_parent_as_internal_resource_path() {
        let dir = TempDir::new().unwrap();
        let source_dir = dir.path().join("稿件");
        std::fs::create_dir(&source_dir).unwrap();
        let input = source_dir.join("第一章.md");
        let image = source_dir.join("素材/封面.png");
        std::fs::create_dir_all(image.parent().unwrap()).unwrap();
        std::fs::write(&image, b"\x89PNG\r\n\x1a\nimage").unwrap();
        std::fs::write(&input, "![封面](素材/封面.png)\n").unwrap();
        let (fake, argv_path) = make_recording_copying_fake_pandoc(&dir);

        export_project_with_pandoc(
            vec![input.to_string_lossy().to_string()],
            dir.path().join("out.html").to_string_lossy().to_string(),
            "html".to_string(),
            vec![],
            &EncodingState::new(),
            ExportRunOptions {
                pandoc_bin: fake.to_str().unwrap(),
                timeout: Duration::from_secs(5),
                cancel_rx: None,
                temp_workspace: Some(dir.path()),
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
        )
        .await
        .expect("fake export should succeed");

        let argv = std::fs::read_to_string(argv_path).unwrap();
        assert!(argv.contains("--resource-path"), "argv was:\n{argv}");
        assert!(
            argv.contains(source_dir.to_string_lossy().as_ref()),
            "argv was:\n{argv}"
        );
    }

    #[tokio::test]
    #[ignore = "requires the pinned Pandoc 3.10 used by test:rust:pandoc"]
    async fn real_pandoc_3_10_exports_cjk_html_docx_and_epub() {
        use base64::Engine;

        let (binary, version) = pandoc::resolve_pandoc(None)
            .await
            .expect("the explicit real-Pandoc matrix requires Pandoc 3.10");
        assert_eq!(version, "pandoc 3.10");

        let dir = TempDir::new().unwrap();
        let enc = EncodingState::new();
        let input = dir.path().join("第一章.md");
        let assets = dir.path().join("素材");
        std::fs::create_dir(&assets).unwrap();
        std::fs::write(
            assets.join("封面.png"),
            base64::engine::general_purpose::STANDARD
                .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=")
                .unwrap(),
        )
        .unwrap();
        std::fs::write(
            &input,
            "# 第一章\n\n中文正文，mixed English.\n\n![封面](素材/封面.png)\n",
        )
        .unwrap();

        for format in ["html", "docx", "epub"] {
            let output = dir.path().join(format!("真实导出.{format}"));
            let result = export_project_with_pandoc(
                vec![input.to_string_lossy().to_string()],
                output.to_string_lossy().to_string(),
                format.to_string(),
                vec![],
                &enc,
                ExportRunOptions {
                    pandoc_bin: &binary,
                    timeout: Duration::from_secs(30),
                    cancel_rx: None,
                    temp_workspace: Some(dir.path()),
                    source_root: None,
                    prepared_input: None,
                    commit_gate: None,
                },
            )
            .await
            .unwrap_or_else(|error| panic!("real Pandoc {format} export failed: {error}"));
            assert!(result.warning.is_none(), "{format}: {result:?}");

            let bytes = std::fs::read(&output).unwrap();
            assert!(bytes.len() > 4, "{format} output was empty");
            if format == "html" {
                let html = String::from_utf8(bytes).unwrap();
                assert!(html.contains("第一章"), "CJK heading missing: {html}");
                assert!(html.contains("中文正文"), "CJK body missing: {html}");
                assert!(
                    html.contains("data:image/png;base64,"),
                    "image was not embedded: {html}"
                );
            } else {
                assert_eq!(&bytes[..4], b"PK\x03\x04", "{format} was not a ZIP file");
                let (archive_text, names) = zip_text_and_names(&bytes);
                assert!(
                    archive_text.contains("第一章"),
                    "{format} CJK heading missing"
                );
                assert!(
                    archive_text.contains("中文正文"),
                    "{format} CJK body missing"
                );
                assert!(
                    names.iter().any(|name| name.ends_with(".png")),
                    "{format} relative image missing: {names:?}"
                );
            }
        }

        let css = std::env::temp_dir().join(format!(
            "novelist-export-theme-real-{}-{}.html",
            std::process::id(),
            EXPORT_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let themed_output = dir.path().join("内嵌主题.html");
        std::fs::write(&css, "<style>body { color: rgb(12, 34, 56); }</style>\n").unwrap();
        export_project_with_pandoc(
            vec![input.to_string_lossy().to_string()],
            themed_output.to_string_lossy().to_string(),
            "html".to_string(),
            vec![
                "--include-in-header".to_string(),
                css.to_string_lossy().to_string(),
            ],
            &enc,
            ExportRunOptions {
                pandoc_bin: &binary,
                timeout: Duration::from_secs(30),
                cancel_rx: None,
                temp_workspace: Some(dir.path()),
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
        )
        .await
        .expect("real Pandoc themed HTML export failed");
        let themed_html = std::fs::read_to_string(themed_output).unwrap();
        assert!(themed_html.contains("rgb(12, 34, 56)"), "{themed_html}");
        assert!(
            !themed_html.contains("novelist-export-theme-"),
            "{themed_html}"
        );
        assert!(!css.exists(), "temporary stylesheet was not cleaned up");
    }

    fn zip_text_and_names(bytes: &[u8]) -> (String, Vec<String>) {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut text = String::new();
        let mut names = Vec::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let name = entry.name().to_string();
            if [".xml", ".xhtml", ".html", ".opf"]
                .iter()
                .any(|extension| name.ends_with(extension))
            {
                let _ = entry.read_to_string(&mut text);
            }
            names.push(name);
        }
        (text, names)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn export_timeout_kills_reaps_and_removes_temp_css() {
        let dir = TempDir::new().unwrap();
        let fake = make_sleeping_fake_pandoc(&dir);
        let enc = EncodingState::new();
        let input = dir.path().join("input.md");
        std::fs::write(&input, "# hi\n").unwrap();
        let css = std::env::temp_dir().join(format!(
            "novelist-export-theme-test-{}-{}.html",
            std::process::id(),
            EXPORT_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&css, "body{}").unwrap();

        let result = export_project_with_pandoc(
            vec![input.to_string_lossy().to_string()],
            dir.path().join("out.html").to_string_lossy().to_string(),
            "html".to_string(),
            vec![
                "--include-in-header".to_string(),
                css.to_string_lossy().to_string(),
            ],
            &enc,
            ExportRunOptions {
                pandoc_bin: fake.to_str().unwrap(),
                timeout: Duration::from_millis(100),
                cancel_rx: None,
                temp_workspace: Some(dir.path()),
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
        )
        .await;

        let failure = pandoc_failure_from_error(result.unwrap_err());
        assert_eq!(failure.stage, pandoc::PandocStage::TimeoutOrCancel);
        assert!(!css.exists(), "temporary css was not removed");
        let owned_temp_entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|entry| {
                entry
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .starts_with("novelist-export-")
            })
            .collect();
        assert!(
            owned_temp_entries.is_empty(),
            "leftover export temp entries from this test: {owned_temp_entries:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn export_cancel_request_kills_child_and_cleans_owned_temp_dir() {
        let dir = TempDir::new().unwrap();
        let fake = make_sleeping_fake_pandoc(&dir);
        let enc = EncodingState::new();
        let input = dir.path().join("input.md");
        std::fs::write(&input, "# hi\n").unwrap();
        let (tx, rx) = watch::channel(false);
        let cancel_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = tx.send(true);
        });

        let result = export_project_with_pandoc(
            vec![input.to_string_lossy().to_string()],
            dir.path().join("out.html").to_string_lossy().to_string(),
            "html".to_string(),
            vec![],
            &enc,
            ExportRunOptions {
                pandoc_bin: fake.to_str().unwrap(),
                timeout: Duration::from_secs(30),
                cancel_rx: Some(rx),
                temp_workspace: Some(dir.path()),
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
        )
        .await;
        cancel_task.await.unwrap();

        let failure = pandoc_failure_from_error(result.unwrap_err());
        assert_eq!(failure.stage, pandoc::PandocStage::TimeoutOrCancel);
        assert!(failure.message.contains("cancelled"), "{}", failure.message);
        let owned_temp_entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|entry| {
                entry
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .starts_with("novelist-export-")
            })
            .collect();
        assert!(
            owned_temp_entries.is_empty(),
            "leftover temp dirs: {owned_temp_entries:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn export_cancel_already_requested_before_pandoc_wait_is_honored() {
        let dir = TempDir::new().unwrap();
        let fake = make_copying_fake_pandoc(&dir);
        let enc = EncodingState::new();
        let input = dir.path().join("input.md");
        let output = dir.path().join("out.html");
        std::fs::write(&input, "# hi\n").unwrap();
        let (tx, rx) = watch::channel(false);
        tx.send(true).unwrap();

        let result = export_project_with_pandoc(
            vec![input.to_string_lossy().to_string()],
            output.to_string_lossy().to_string(),
            "html".to_string(),
            vec![],
            &enc,
            ExportRunOptions {
                pandoc_bin: fake.to_str().unwrap(),
                timeout: Duration::from_secs(10),
                cancel_rx: Some(rx),
                temp_workspace: Some(dir.path()),
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
        )
        .await;

        let failure = pandoc_failure_from_error(result.unwrap_err());
        assert_eq!(failure.stage, pandoc::PandocStage::TimeoutOrCancel);
        assert!(failure.message.contains("cancelled"), "{}", failure.message);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_export_survives_cleanup_warning() {
        let dir = TempDir::new().unwrap();
        let fake = make_copying_fake_pandoc(&dir);
        let enc = EncodingState::new();
        let input = dir.path().join("input.md");
        let output = dir.path().join("out.html");
        std::fs::write(&input, "# hi\n").unwrap();
        let css_dir = std::env::temp_dir().join(format!(
            "novelist-export-theme-cleanup-dir-{}-{}.html",
            std::process::id(),
            EXPORT_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&css_dir).unwrap();

        let result = export_project_with_pandoc(
            vec![input.to_string_lossy().to_string()],
            output.to_string_lossy().to_string(),
            "html".to_string(),
            vec![
                "--include-in-header".to_string(),
                css_dir.to_string_lossy().to_string(),
            ],
            &enc,
            ExportRunOptions {
                pandoc_bin: fake.to_str().unwrap(),
                timeout: Duration::from_secs(10),
                cancel_rx: None,
                temp_workspace: Some(dir.path()),
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
        )
        .await;
        let _ = std::fs::remove_dir_all(&css_dir);

        let result = result.expect("cleanup warning should not fail export");
        assert!(output.exists(), "successful Pandoc output was discarded");
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(
            value["message"],
            format!("Export complete: {}", output.display())
        );
        assert_eq!(value["warning"]["stage"], "cleanup");
        assert_eq!(value["warning"]["format"], "html");
        assert_eq!(
            value["warning"]["resolved_binary"],
            fake.to_string_lossy().as_ref()
        );
        assert_eq!(
            value["warning"]["source_path"],
            input.to_string_lossy().as_ref()
        );
        assert!(value["warning"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("temporary export resources")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn successful_export_surfaces_injected_cleanup_failure_without_losing_output() {
        let dir = TempDir::new().unwrap();
        let fake = make_copying_fake_pandoc(&dir);
        let enc = EncodingState::new();
        let input = dir.path().join("第一章.md");
        let output = dir.path().join("out.html");
        std::fs::write(&input, "# 第一章\n正文。\n").unwrap();
        let fail_cleanup = |_path: &Path| {
            Some(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected cleanup denial",
            ))
        };

        let result = export_project_with_pandoc_and_cleanup_hook(
            vec![input.to_string_lossy().to_string()],
            output.to_string_lossy().to_string(),
            "html".to_string(),
            vec![],
            &enc,
            ExportRunOptions {
                pandoc_bin: fake.to_str().unwrap(),
                timeout: Duration::from_secs(10),
                cancel_rx: None,
                temp_workspace: Some(dir.path()),
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
            &fail_cleanup,
        )
        .await
        .expect("cleanup failure must not hide a successful conversion");

        assert!(output.exists(), "successful Pandoc output was discarded");
        let warning = result.warning.expect("cleanup warning must be structured");
        assert_eq!(warning.stage, pandoc::PandocStage::Cleanup);
        assert!(warning.message.contains("injected cleanup denial"));
        assert_eq!(warning.resolved_binary.as_deref(), fake.to_str());
        assert_eq!(warning.source_path.as_deref(), input.to_str());

        for entry in std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
        {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("novelist-export-")
            {
                std::fs::remove_dir_all(entry.path()).unwrap();
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn retained_pipe_cleanup_warns_without_discarding_completed_output() {
        let dir = TempDir::new().unwrap();
        let (fake, pid_file) = make_copying_fake_pandoc_with_retained_pipe(&dir);
        let input = dir.path().join("第一章.md");
        let output = dir.path().join("out.html");
        std::fs::write(&input, "# 第一章\n正文。\n").unwrap();

        let result = export_project_with_pandoc(
            vec![input.to_string_lossy().to_string()],
            output.to_string_lossy().to_string(),
            "html".to_string(),
            vec![],
            &EncodingState::new(),
            ExportRunOptions {
                pandoc_bin: fake.to_str().unwrap(),
                timeout: Duration::from_secs(5),
                cancel_rx: None,
                temp_workspace: Some(dir.path()),
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
        )
        .await;
        let descendant = std::fs::read_to_string(&pid_file)
            .expect("fake Pandoc should record its pipe-retaining descendant")
            .parse::<u32>()
            .unwrap();
        let alive = std::process::Command::new("/bin/kill")
            .args(["-0", &descendant.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if alive {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-9", &descendant.to_string()])
                .status();
        }

        let result = result.expect("cleanup warning must not hide completed output");
        assert!(!alive, "pipe-retaining descendant {descendant} survived");
        assert!(output.exists(), "completed output was discarded");
        assert!(std::fs::read_to_string(&output).unwrap().contains("第一章"));
        let warning = result.warning.expect("cleanup warning must be structured");
        assert_eq!(warning.stage, pandoc::PandocStage::Cleanup);
        assert!(warning.message.contains("retained its output pipes"));
    }

    #[tokio::test]
    async fn temp_input_write_failure_cleanup_removes_owned_temp_dir() {
        let dir = TempDir::new().unwrap();
        let temp_dir = dir.path().join("owned-export-temp");
        std::fs::create_dir(&temp_dir).unwrap();
        let temp_input = temp_dir.join("input.md");
        std::fs::create_dir(&temp_input).unwrap();

        let write_result = write_temp_input(&temp_input, "# cannot write over directory\n").await;
        assert!(
            write_result.is_err(),
            "fixture should force temp input write failure"
        );
        let cleanup = cleanup_temp_resources(&temp_input, Some(&temp_dir), &[], None).await;

        assert!(
            cleanup.is_none(),
            "cleanup should remove directory tree without warning: {cleanup:?}"
        );
        assert!(
            !temp_dir.exists(),
            "owned temp dir survived input write failure"
        );
    }

    #[tokio::test]
    async fn temp_workspace_allocation_failure_removes_staged_css() {
        let dir = TempDir::new().unwrap();
        let blocked_workspace = dir.path().join("not-a-directory");
        std::fs::write(&blocked_workspace, "occupied").unwrap();
        let css = std::env::temp_dir().join(format!(
            "novelist-export-theme-allocation-failure-{}-{}.html",
            std::process::id(),
            EXPORT_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&css, "body{}").unwrap();

        let result = export_project_with_pandoc(
            vec![],
            dir.path().join("out.html").to_string_lossy().to_string(),
            "html".to_string(),
            vec![
                "--include-in-header".to_string(),
                css.to_string_lossy().to_string(),
            ],
            &EncodingState::new(),
            ExportRunOptions {
                pandoc_bin: "/bin/false",
                timeout: Duration::from_secs(1),
                cancel_rx: None,
                temp_workspace: Some(&blocked_workspace),
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
        )
        .await;

        assert!(result.is_err(), "workspace allocation should fail");
        assert!(!css.exists(), "staged CSS leaked before conversion started");
    }

    #[tokio::test]
    async fn input_read_failure_names_the_actual_failing_cjk_path() {
        let dir = TempDir::new().unwrap();
        let first = dir.path().join("第一章.md");
        let missing = dir.path().join("第二章-缺失.md");
        std::fs::write(&first, "# 第一章\n").unwrap();

        let result = export_project_with_pandoc(
            vec![
                first.to_string_lossy().to_string(),
                missing.to_string_lossy().to_string(),
            ],
            dir.path().join("out.html").to_string_lossy().to_string(),
            "html".to_string(),
            vec![],
            &EncodingState::new(),
            ExportRunOptions {
                pandoc_bin: "/bin/false",
                timeout: Duration::from_secs(1),
                cancel_rx: None,
                temp_workspace: Some(dir.path()),
                source_root: None,
                prepared_input: None,
                commit_gate: None,
            },
        )
        .await;

        let failure = pandoc_failure_from_error(result.unwrap_err());
        assert_eq!(failure.stage, pandoc::PandocStage::InputRead);
        assert_eq!(failure.source_path.as_deref(), missing.to_str());
    }

    #[test]
    fn multi_file_source_context_is_one_real_path_not_a_summary() {
        let inputs = vec!["/稿件/第一章.md".to_string(), "/稿件/第二章.md".to_string()];
        assert_eq!(source_context(&inputs), Some("/稿件/第一章.md"));
    }

    #[test]
    fn export_rejects_destination_that_is_an_input_file() {
        let dir = TempDir::new().unwrap();
        let input = dir.path().join("第一章.md");
        std::fs::write(&input, "# 第一章\n").unwrap();

        let error = validate_output_not_input(
            &[input.to_string_lossy().to_string()],
            &input.to_string_lossy(),
        )
        .expect_err("an export destination must not replace its source");
        assert!(error.to_string().contains("destination conflicts"));
    }

    #[cfg(unix)]
    #[test]
    fn export_rejects_destination_symlinked_to_an_input_file() {
        let dir = TempDir::new().unwrap();
        let input = dir.path().join("第一章.md");
        let output_alias = dir.path().join("alias.html");
        std::fs::write(&input, "# 第一章\n").unwrap();
        std::os::unix::fs::symlink(&input, &output_alias).unwrap();

        assert!(validate_output_not_input(
            &[input.to_string_lossy().to_string()],
            &output_alias.to_string_lossy(),
        )
        .is_err());
    }

    #[test]
    fn confined_project_source_preserves_nested_cjk_bytes() {
        let project = TempDir::new().unwrap();
        let chapters = project.path().join("章节");
        std::fs::create_dir(&chapters).unwrap();
        let source = chapters.join("第一章.md");
        let expected = "# 第一章\n中文正文。\n".as_bytes();
        std::fs::write(&source, expected).unwrap();

        let bytes = read_project_source_confined(project.path(), &source, 1024).unwrap();
        assert_eq!(bytes, expected);
    }

    #[cfg(unix)]
    #[test]
    fn confined_project_source_rejects_symlink_without_reading_external_bytes() {
        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let sentinel = outside.path().join("secret.md");
        let linked = project.path().join("linked.md");
        std::fs::write(&sentinel, "EXTERNAL_SECRET_SENTINEL").unwrap();
        std::os::unix::fs::symlink(&sentinel, &linked).unwrap();

        let error = read_project_source_confined(project.path(), &linked, 1024)
            .expect_err("project export must not follow source symlinks");
        assert!(matches!(error, AppError::PathNotAllowed(_)));
        assert_eq!(
            std::fs::read_to_string(&sentinel).unwrap(),
            "EXTERNAL_SECRET_SENTINEL"
        );
    }

    #[test]
    fn confined_project_source_rejects_path_outside_project() {
        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let source = outside.path().join("outside.md");
        std::fs::write(&source, "outside").unwrap();

        assert!(matches!(
            read_project_source_confined(project.path(), &source, 1024),
            Err(AppError::PathNotAllowed(_))
        ));
    }

    #[test]
    fn standalone_source_read_is_strictly_descriptor_bounded() {
        let dir = TempDir::new().unwrap();
        let source = dir.path().join("standalone.md");
        std::fs::write(&source, b"12345678").unwrap();
        assert_eq!(
            read_standalone_source_bounded(&source, 8).unwrap(),
            b"12345678"
        );

        std::fs::write(&source, b"123456789").unwrap();
        assert!(matches!(
            read_standalone_source_bounded(&source, 8),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[test]
    fn standalone_sparse_source_over_export_cap_is_rejected_without_allocation() {
        let dir = TempDir::new().unwrap();
        let source = dir.path().join("oversized.md");
        let file = std::fs::File::create(&source).unwrap();
        file.set_len((MAX_EXPORT_INPUT_BYTES + 1) as u64).unwrap();

        assert!(matches!(
            read_standalone_source_bounded(&source, MAX_EXPORT_INPUT_BYTES),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[tokio::test]
    async fn project_scan_collects_nested_markdown_in_stable_order() {
        let project = TempDir::new().unwrap();
        std::fs::create_dir(project.path().join("章节")).unwrap();
        std::fs::write(project.path().join("第二章.md"), "two").unwrap();
        std::fs::write(project.path().join("第一章.md"), "one").unwrap();
        std::fs::write(project.path().join("第十章.md"), "ten").unwrap();
        std::fs::write(project.path().join("Chapter 10.md"), "chapter ten").unwrap();
        std::fs::write(project.path().join("Chapter 2.md"), "chapter two").unwrap();
        std::fs::write(project.path().join("Chapter 1.md"), "chapter one").unwrap();
        std::fs::write(project.path().join("章节/第三章.markdown"), "three").unwrap();
        std::fs::write(project.path().join("notes.txt"), "ignore").unwrap();
        std::fs::create_dir(project.path().join(".novelist")).unwrap();
        std::fs::write(project.path().join(".novelist/hidden.md"), "ignore").unwrap();

        let files = collect_project_markdown_files(project.path())
            .await
            .unwrap();
        let canonical_project = std::fs::canonicalize(project.path()).unwrap();
        let relative = files
            .iter()
            .map(|path| {
                Path::new(path)
                    .strip_prefix(&canonical_project)
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            relative,
            vec![
                "章节/第三章.markdown",
                "Chapter 1.md",
                "Chapter 2.md",
                "Chapter 10.md",
                "第一章.md",
                "第二章.md",
                "第十章.md",
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn aliased_project_root_scans_and_reads_through_one_capability() {
        let parent = TempDir::new().unwrap();
        let project = parent.path().join("真实项目");
        let alias = parent.path().join("project-alias");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(project.join("第一章.md"), "# 第一章\n别名路径正文").unwrap();
        std::os::unix::fs::symlink(&project, &alias).unwrap();

        let batch = collect_project_export_sources(&alias).await.unwrap();
        let combined = assemble_project_source_batch(&batch, &EncodingState::new()).unwrap();

        assert_eq!(
            batch.canonical_root,
            std::fs::canonicalize(&project).unwrap()
        );
        assert!(combined.contains("别名路径正文"));
    }

    #[test]
    fn backend_export_name_order_is_numeric_for_arabic_and_cjk() {
        let mut names = vec![
            "Chapter 10.md",
            "第十章.md",
            "Chapter 2.md",
            "第二章.md",
            "Chapter 1.md",
            "第一章.md",
        ];
        names.sort_by(|left, right| compare_export_names(left, right));
        assert_eq!(
            names,
            vec![
                "Chapter 1.md",
                "Chapter 2.md",
                "Chapter 10.md",
                "第一章.md",
                "第二章.md",
                "第十章.md",
            ]
        );
    }

    #[test]
    fn non_markdown_entries_are_charged_before_directory_buffering() {
        let mut budget = ProjectScanBudget {
            entries: MAX_PROJECT_EXPORT_ENTRIES,
            ..ProjectScanBudget::default()
        };

        let error = charge_project_entry_budget(&mut budget, Path::new("asset.bin"))
            .expect_err("every non-Markdown entry must consume the scan budget");

        assert!(matches!(error, AppError::InvalidInput(_)));
    }

    #[test]
    fn markdown_resource_validation_allows_relative_cjk_and_data_images() {
        let markdown = "![封面](素材/封面.png)\n![参考][cover]\n[cover]: images/cover.webp\n![inline](data:image/png;base64,iVBORw0KGgppbWFnZQ==)";
        validate_markdown_resource_references(markdown).unwrap();
    }

    #[test]
    fn markdown_resource_validation_rejects_svg_and_mislabeled_data_images() {
        for destination in [
            "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+",
            "data:image/png;base64,R0lGODlh",
        ] {
            assert!(
                validate_markdown_resource_references(&format!("![x]({destination})")).is_err()
            );
        }
    }

    #[test]
    fn markdown_resource_validation_rejects_network_and_absolute_images() {
        for destination in [
            "https://example.com/image.png",
            "http://127.0.0.1/private",
            "file:///etc/passwd",
            "/etc/passwd",
            r"C:\\Users\\secret.png",
        ] {
            let markdown = format!("![unsafe]({destination})");
            assert!(
                validate_markdown_resource_references(&markdown).is_err(),
                "accepted unsafe destination: {destination}"
            );
        }
    }

    #[test]
    fn image_event_source_range_contains_inline_destination() {
        let markdown = "before ![封面](images/cover.png \"title\") after";
        let (_, range) = Parser::new(markdown)
            .into_offset_iter()
            .find(|(event, _)| matches!(event, Event::Start(Tag::Image { .. })))
            .expect("image event");

        assert!(markdown[range].contains("images/cover.png"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn project_scan_rejects_symlinked_markdown_entry() {
        let project = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let sentinel = outside.path().join("secret.md");
        std::fs::write(&sentinel, "EXTERNAL_SECRET_SENTINEL").unwrap();
        std::os::unix::fs::symlink(&sentinel, project.path().join("linked.md")).unwrap();

        assert!(matches!(
            collect_project_markdown_files(project.path()).await,
            Err(AppError::PathNotAllowed(_))
        ));
        assert_eq!(
            std::fs::read_to_string(sentinel).unwrap(),
            "EXTERNAL_SECRET_SENTINEL"
        );
    }

    #[test]
    fn export_cancel_guard_is_request_scoped_and_dropped_on_completion() {
        let state = ExportState::new();
        let first = ExportCancelGuard::register("req-1", &state).unwrap();
        let first_rx = first.subscribe();
        assert!(ExportCancelGuard::register("req-1", &state).is_err());
        assert!(cancel_export_request(&state, "req-1").unwrap());
        assert!(*first_rx.borrow());
        drop(first);

        let second = ExportCancelGuard::register("req-1", &state).unwrap();
        let second_rx = second.subscribe();
        assert!(
            !*second_rx.borrow(),
            "later request inherited stale cancellation"
        );
    }

    #[test]
    fn duplicate_registration_does_not_replace_original_sender() {
        let state = ExportState::new();
        let first = ExportCancelGuard::register("same-id", &state).unwrap();
        let first_rx = first.subscribe();

        let duplicate = ExportCancelGuard::register("same-id", &state);
        assert!(duplicate.is_err());
        assert!(cancel_export_request(&state, "same-id").unwrap());

        assert!(
            *first_rx.borrow(),
            "duplicate registration stole or replaced the original sender"
        );
    }

    #[test]
    fn cancel_after_registration_before_slow_setup_is_preserved() {
        let state = ExportState::new();
        let guard = ExportCancelGuard::register("early-cancel", &state).unwrap();

        assert!(cancel_export_request(&state, "early-cancel").unwrap());
        let rx = guard.subscribe();

        assert!(
            *rx.borrow(),
            "cancel sent after registration but before slow setup was not visible to export"
        );
    }

    #[test]
    fn cancel_before_registration_is_preserved() {
        let state = ExportState::new();

        assert!(cancel_export_request(&state, "pre-registration").unwrap());
        let guard = ExportCancelGuard::register("pre-registration", &state).unwrap();
        let receiver = guard.subscribe();

        assert!(
            *receiver.borrow(),
            "pending cancellation was not transferred into the registered export"
        );
        assert!(state.lifecycle.lock().unwrap().pending.is_empty());
    }

    #[test]
    fn cancel_after_request_completion_is_rejected() {
        let state = ExportState::new();
        let guard = ExportCancelGuard::register("completed-request", &state).unwrap();
        drop(guard);

        assert!(!cancel_export_request(&state, "completed-request").unwrap());
        assert!(state.lifecycle.lock().unwrap().pending.is_empty());
    }

    #[test]
    fn cancel_request_returns_false_after_commit_takes_ownership() {
        let state = ExportState::new();
        let guard = ExportCancelGuard::register("commit-owned", &state).unwrap();
        assert!(guard.commit_gate().begin_commit());

        assert!(!cancel_export_request(&state, "commit-owned").unwrap());
        assert!(!*guard.subscribe().borrow());
    }

    #[test]
    fn project_batch_rebases_same_relative_image_per_source_directory() {
        let project = TempDir::new().unwrap();
        for directory in ["Part One/images", "卷二/images", "卷三", "素材"] {
            std::fs::create_dir_all(project.path().join(directory)).unwrap();
        }
        std::fs::write(
            project.path().join("Part One/images/cover.png"),
            b"\x89PNG\r\n\x1a\nimage-one",
        )
        .unwrap();
        std::fs::write(
            project.path().join("卷二/images/cover.png"),
            b"\x89PNG\r\n\x1a\nimage-two",
        )
        .unwrap();
        std::fs::write(
            project.path().join("素材/封面.png"),
            b"\x89PNG\r\n\x1a\nimage-shared",
        )
        .unwrap();
        let root = std::fs::canonicalize(project.path()).unwrap();
        let batch = ProjectExportBatch {
            canonical_root: root.clone(),
            root: Dir::open_ambient_dir(&root, ambient_authority()).unwrap(),
            sources: vec![
                ProjectExportSource {
                    absolute: root.join("Part One/第一章.md"),
                    relative: PathBuf::from("Part One/第一章.md"),
                    bytes: b"![cover](images/cover.png)\n".to_vec(),
                },
                ProjectExportSource {
                    absolute: root.join("卷二/第一章.md"),
                    relative: PathBuf::from("卷二/第一章.md"),
                    bytes: b"![cover](images/cover.png)\n".to_vec(),
                },
                ProjectExportSource {
                    absolute: root.join("卷三/第三章.md"),
                    relative: PathBuf::from("卷三/第三章.md"),
                    bytes: concat!(
                        "```markdown\n",
                        "[example]: ../%E7%B4%A0%E6%9D%90/%E5%B0%81%E9%9D%A2.png\n",
                        "```\n\n",
                        "![共享封面][cover]\n\n",
                        "[other]: ../%E7%B4%A0%E6%9D%90/%E5%B0%81%E9%9D%A2.png.backup\n",
                        "[cover]: ../%E7%B4%A0%E6%9D%90/%E5%B0%81%E9%9D%A2.png\n",
                    )
                    .as_bytes()
                    .to_vec(),
                },
            ],
        };

        let combined = assemble_project_source_batch(&batch, &EncodingState::new()).unwrap();

        let destinations = Parser::new(&combined)
            .filter_map(|event| match event {
                Event::Start(Tag::Image { dest_url, .. }) => Some(dest_url.to_string()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(destinations.len(), 3);
        assert!(destinations
            .iter()
            .all(|destination| destination.starts_with("data:image/png;base64,")));
        assert_eq!(
            destinations
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3,
            "each source must embed its own image bytes"
        );
        assert!(combined.contains("[example]: ../%E7%B4%A0%E6%9D%90/%E5%B0%81%E9%9D%A2.png"));
        assert!(combined.contains("[other]: ../%E7%B4%A0%E6%9D%90/%E5%B0%81%E9%9D%A2.png.backup"));
        assert_eq!(
            resource_path_args(&[], Some(&root)).unwrap(),
            vec![
                "--resource-path".to_string(),
                root.to_string_lossy().to_string(),
            ]
        );
    }

    #[test]
    fn project_image_rebase_rejects_percent_encoded_escape() {
        let workspace = TempDir::new().unwrap();
        let project = workspace.path().join("project");
        let chapter_dir = project.join("chapters");
        std::fs::create_dir_all(&chapter_dir).unwrap();
        std::fs::write(workspace.path().join("outside.png"), b"secret").unwrap();
        let project = std::fs::canonicalize(project).unwrap();
        let markdown = "![unsafe](../../%6futside.png)";

        let root = Dir::open_ambient_dir(&project, ambient_authority()).unwrap();
        let mut image_bytes = 0;
        let error = embed_confined_image_destinations(
            markdown,
            Path::new("chapters/chapter.md"),
            &root,
            &mut image_bytes,
        )
        .expect_err("encoded traversal outside the project must be rejected");

        assert!(matches!(error, AppError::PathNotAllowed(_)));
    }

    #[cfg(unix)]
    #[test]
    fn project_image_embedding_rejects_hidden_symlink_components() {
        let workspace = TempDir::new().unwrap();
        let project = workspace.path().join("project");
        let outside = workspace.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.png"), b"\x89PNG\r\n\x1a\nsecret").unwrap();
        std::os::unix::fs::symlink(&outside, project.join(".assets")).unwrap();
        let root = Dir::open_ambient_dir(&project, ambient_authority()).unwrap();
        let mut image_bytes = 0;

        let error = embed_confined_image_destinations(
            "![secret](.assets/secret.png)",
            Path::new("chapter.md"),
            &root,
            &mut image_bytes,
        )
        .expect_err("hidden symlink image directory must be rejected");

        assert!(matches!(error, AppError::PathNotAllowed(_)));
    }

    #[test]
    fn stale_guard_drop_does_not_remove_new_owner_for_same_request_id() {
        let state = ExportState::new();
        let stale = ExportCancelGuard::register("reused-id", &state).unwrap();
        let (new_sender, _new_rx) = watch::channel(false);
        let new_token = EXPORT_CANCEL_TOKEN.fetch_add(1, Ordering::Relaxed);
        {
            let mut lifecycle = state.lifecycle.lock().unwrap();
            lifecycle.active.insert(
                "reused-id".to_string(),
                ExportCancelEntry {
                    token: new_token,
                    sender: new_sender.clone(),
                    commit_gate: Arc::new(pandoc::CommitGate::default()),
                },
            );
        }

        drop(stale);

        let lifecycle = state.lifecycle.lock().unwrap();
        assert!(
            lifecycle
                .active
                .get("reused-id")
                .is_some_and(|entry| entry.token == new_token),
            "stale guard removed a newer registration"
        );
    }

    #[test]
    fn empty_cancel_request_id_is_invalid_input() {
        let state = ExportState::new();
        let err = cancel_export_request(&state, "  ").unwrap_err();
        assert!(err
            .to_string()
            .contains("export request id cannot be empty"));
    }

    #[test]
    fn export_extra_args_reject_multiple_css_paths() {
        let first = std::env::temp_dir().join("novelist-export-theme-first.html");
        let second = std::env::temp_dir().join("novelist-export-theme-second.html");
        let args = vec![
            "--include-in-header".to_string(),
            first.to_string_lossy().to_string(),
            "--include-in-header".to_string(),
            second.to_string_lossy().to_string(),
        ];
        assert!(validate_export_extra_args_shape("html", &args).is_err());
    }
}
