mod commands;
mod error;
#[cfg(target_os = "android")]
mod logcat;
mod menu;
mod models;
mod services;

pub use error::AppError;
pub use services::publish::cover_assets as publish_cover_assets;
pub use services::publish::sidecar as publish_sidecar;
pub use services::publish::types::{
    build_error_from_body, redact_reqwest_error, redact_secrets, ProviderRevision, PublishError,
    PublishOperation, PublishResult, UnsupportedUpdateReason, UpdateConflictContext, UpdateTarget,
};
pub use services::sidecar;

use std::sync::Mutex;

use commands::ai_bridge::{ai_fetch_stream_cancel, ai_fetch_stream_start, AiBridgeState};
use commands::ai_files::{
    list_ai_prompt_assets, list_ai_sessions, read_ai_session, save_ai_chat, write_ai_memory,
    write_ai_session,
};
use commands::bench::log_startup_phase;
use commands::book_translation::create_book_translation_project;
use commands::cli_shim::{cli_shim_status, install_cli_shim};
#[cfg(feature = "sync")]
use commands::cloud::{
    bind_cloud_project, check_cloud_account, connect_cloud_account, disconnect_cloud_account,
    download_cloud_project, get_cloud_account, get_cloud_project_binding, list_cloud_projects,
    unbind_cloud_project,
};
use commands::draft::{delete_draft_note, has_draft_note, read_draft_note, write_draft_note};
#[cfg(all(target_os = "macos", feature = "e2e-testing"))]
use commands::e2e::{
    capture_e2e_webview_snapshot, perform_e2e_native_command_v, perform_e2e_native_paste,
};
use commands::export::{
    cancel_export_project, check_pandoc, discard_staged_export_css, export_project,
    set_pandoc_path, stage_export_css, ExportState,
};
use commands::file::{
    broadcast_file_renamed, create_directory, create_file, create_scratch_file, delete_item,
    delete_scratch_file, duplicate_file, get_file_encoding, list_directory, move_item, read_file,
    rename_item, reveal_in_file_manager, search_in_project, write_binary_file, write_file,
    EncodingState,
};
use commands::image_host::{
    get_image_host_settings, read_image_bytes, set_image_host_settings, upload_image_aliyun_oss,
    upload_image_custom, upload_image_imgur, upload_image_qiniu, upload_image_s3,
    upload_image_smms, WindowImageCapabilities,
};
use commands::library::{
    export_library_document, export_library_project, get_library_path, import_library_file,
    import_library_project, list_library_projects, stage_import_file,
};
use commands::literary_study::{
    create_literary_study_project, inspect_literary_source, read_literary_study_overview,
    replace_literary_study_book,
};
use commands::menu::refresh_menu;
use commands::naming::{
    compute_document_key, delete_managed_name_state, read_managed_name_state,
    write_managed_name_state,
};
use commands::plugin::{
    get_plugin_commands, get_plugins_dir, invoke_plugin_command, list_plugins, load_plugin,
    reload_plugin, scaffold_plugin, set_plugin_document_state, set_plugin_enabled, unload_plugin,
};
use commands::portable::is_portable_mode;
use commands::project::{detect_project, read_project_config};
use commands::publish::{
    bind_legacy_publication, clear_publish_cover, convert_markdown_to_html, get_publish_settings,
    list_publish_tags, load_publish_cover, persist_publish_result, publish_to_ghost,
    publish_to_medium, publish_to_wordpress_com, publish_to_wordpress_self_hosted,
    read_clipboard_image, read_publish_form_drafts, read_publish_remote_state,
    set_publish_settings, store_publish_cover, upload_post_image_ghost, upload_post_image_medium,
    upload_post_image_wordpress_com, upload_post_image_wordpress_self_hosted,
    verify_publish_channel, verify_wordpress_com_update, verify_wordpress_self_hosted_update,
    write_publish_form_draft,
};
use commands::recent::{
    add_recent_project, get_recent_projects, remove_recent_project, reorder_recent_projects,
    set_project_pinned,
};
use commands::settings::{
    get_effective_settings, get_global_settings, write_global_settings, write_project_settings,
};
use commands::snapshot::{create_snapshot, delete_snapshot, list_snapshots, restore_snapshot};
use commands::stats::{get_writing_stats, record_writing_stats};
use commands::styled_copy::{
    convert_markdown_to_styled_html, read_styled_copy_image, write_styled_clipboard,
};
#[cfg(feature = "sync")]
use commands::sync::{
    adopt_sync_identity, get_sync_config, resolve_sync_conflict, save_sync_config, sync_now,
    test_sync_connection,
};
use commands::template::{
    create_project_from_template, delete_template, import_template_zip, list_templates,
    save_project_as_template,
};
use commands::template_files::{
    create_file_with_body, delete_template_file, duplicate_bundled_template, list_template_files,
    read_template_file, rename_template_file, write_template_file,
};
use commands::window::{open_devtools, set_window_appearance};
use serde::{Deserialize, Serialize};
#[cfg(desktop)]
use services::file_routing::pick_open_event_target;
use services::file_routing::{route_single_file_open_cmd, submit_file_open_bid, FileRoutingState};
use services::file_watcher::{
    poll_external_changes, register_open_file, register_write_ignore, start_file_watcher,
    stop_file_watcher, unregister_open_file, FileWatcherState,
};
use services::platform::get_platform_capabilities;
use services::plugin_host::sandbox::PluginHostState;
use specta::Type;
#[cfg(desktop)]
use tauri::Emitter;
use tauri::Manager;
use tauri_specta::{collect_commands, Builder};

#[cfg(feature = "codegen")]
fn normalize_generated_typescript(path: &std::path::Path) -> std::io::Result<()> {
    let source = std::fs::read_to_string(path)?;
    let mut normalized = source
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    normalized.push('\n');
    if normalized != source {
        std::fs::write(path, normalized)?;
    }
    Ok(())
}

#[cfg(desktop)]
use services::cli::{help_text, parse_argv, CliRequest, FileTarget};

#[cfg(feature = "e2e-testing")]
fn log_native_e2e_startup(message: &str) {
    use std::io::Write;

    let Ok(path) = std::env::var("NOVELIST_NATIVE_TAURI_LOG") else {
        return;
    };
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "native_e2e_startup={message}");
        let _ = file.sync_all();
    }
}

/// Files queued for opening before the frontend listener is ready.
/// Populated by CLI args and macOS `RunEvent::Opened`; drained by the
/// frontend via `get_pending_open_files` on mount.
pub struct PendingOpenFiles(Mutex<Vec<PendingFile>>);

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PendingFile {
    pub path: String,
    pub line: Option<u32>,
    pub col: Option<u32>,
}

impl PendingFile {
    #[cfg(desktop)]
    fn from_target(t: &FileTarget) -> Self {
        Self {
            path: t.path.to_string_lossy().to_string(),
            line: t.line,
            col: t.col,
        }
    }
    #[allow(dead_code)]
    fn from_path(path: String) -> Self {
        Self {
            path,
            line: None,
            col: None,
        }
    }
}

impl Default for PendingOpenFiles {
    fn default() -> Self {
        Self::new()
    }
}

impl PendingOpenFiles {
    pub fn new() -> Self {
        Self(Mutex::new(Vec::new()))
    }
    pub fn push(&self, file: PendingFile) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).push(file);
    }
    pub fn drain(&self) -> Vec<PendingFile> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// Project folders queued for opening before the frontend is ready.
/// Mirrors `PendingOpenFiles`; on cold start, the main window drains both.
pub struct PendingOpenProjects(Mutex<Vec<String>>);

impl Default for PendingOpenProjects {
    fn default() -> Self {
        Self::new()
    }
}

impl PendingOpenProjects {
    pub fn new() -> Self {
        Self(Mutex::new(Vec::new()))
    }
    pub fn push(&self, path: String) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).push(path);
    }
    pub fn drain(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

#[tauri::command]
#[specta::specta]
fn get_pending_open_files(state: tauri::State<'_, PendingOpenFiles>) -> Vec<PendingFile> {
    state.drain()
}

#[tauri::command]
#[specta::specta]
fn get_pending_open_projects(state: tauri::State<'_, PendingOpenProjects>) -> Vec<String> {
    state.drain()
}

/// Payload emitted as the `cli-open` event on hot path (existing instance
/// receives a second invocation). The frontend routes folders to new windows
/// and files to either the focused single-file window or a new window.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CliOpenPayload {
    pub files: Vec<PendingFile>,
    pub folders: Vec<String>,
    pub force_new_window: bool,
    /// Label of the single window meant to handle this event. On Windows,
    /// `emit_to` broadcasts to every webview, so the frontend filters on this
    /// to keep the "single coordinator" semantics (see app-events listeners).
    pub target_label: String,
}

#[cfg(desktop)]
impl CliOpenPayload {
    fn from_request(req: &CliRequest) -> Self {
        Self {
            files: req.files.iter().map(PendingFile::from_target).collect(),
            folders: req
                .folders
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect(),
            force_new_window: req.force_new_window,
            // Filled in by the caller once the coordinator window is chosen.
            target_label: String::new(),
        }
    }
}

/// Payload for the macOS `open-file` hot-path event (Finder "Open With" while
/// running). Carries `target_label` for the same reason as [`CliOpenPayload`]:
/// `emit_to` broadcasts on Windows, so the frontend filters on it.
/// macOS-only: the only emitter is the `RunEvent::Opened` handler below.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Serialize, Type)]
pub struct OpenFilePayload {
    pub path: String,
    pub target_label: String,
}

#[cfg(desktop)]
fn open_event_target_label(app: &tauri::AppHandle) -> Option<String> {
    let labels = app.webview_windows().keys().cloned().collect();
    pick_open_event_target(labels)
}

#[cfg(desktop)]
fn focus_open_event_target(app: &tauri::AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// macOS 11+ draws a 1px hairline under the titlebar even when the titlebar
/// itself is transparent (Overlay mode). That shows up as a thin white edge
/// at the very top of the window. Setting the style to `.none` removes it.
/// No-op on older macOS where the selector doesn't exist.
#[cfg(target_os = "macos")]
fn remove_titlebar_separator(window: &tauri::WebviewWindow) {
    use objc::runtime::{Object, Sel};
    use objc::{msg_send, sel, sel_impl};

    let ptr = match window.ns_window() {
        Ok(p) => p,
        Err(_) => return,
    };
    let ns_window = ptr as *mut Object;
    unsafe {
        let sel: Sel = sel!(setTitlebarSeparatorStyle:);
        let responds: bool = msg_send![ns_window, respondsToSelector: sel];
        if responds {
            // NSTitlebarSeparatorStyleNone = 1
            let _: () = msg_send![ns_window, setTitlebarSeparatorStyle: 1i64];
        }
    }
}

/// Parse argv early and short-circuit `--help` / `--version` so a CLI
/// invocation prints to stdout and exits without spinning up the GUI.
/// On macOS GUI launches argv has only the program name, so this is a no-op.
#[cfg(desktop)]
fn handle_early_exit_flags() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() <= 1 {
        return;
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let req = parse_argv(&argv, &cwd);
    let program = std::path::Path::new(&argv[0])
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("novelist")
        .to_string();
    if req.want_version {
        println!("novelist {}", env!("CARGO_PKG_VERSION"));
        std::process::exit(0);
    }
    if req.want_help {
        print!("{}", help_text(&program, env!("CARGO_PKG_VERSION")));
        std::process::exit(0);
    }
}

/// The one IPC command list (D2 in the mobile platform plan). Every platform
/// and feature set registers the same commands; platform gaps are reported
/// from command bodies as `AppError::Unsupported`, so the generated bindings
/// match every runtime. Feature-gated commands are appended as `extra`.
macro_rules! app_commands {
    ($($extra:ident),* $(,)?) => {
        collect_commands![
            read_file,
            write_file,
            get_file_encoding,
            list_directory,
            create_file,
            create_scratch_file,
            delete_scratch_file,
            create_directory,
            rename_item,
            compute_document_key,
            read_managed_name_state,
            write_managed_name_state,
            delete_managed_name_state,
            broadcast_file_renamed,
            move_item,
            delete_item,
            check_pandoc,
            set_pandoc_path,
            stage_export_css,
            discard_staged_export_css,
            cancel_export_project,
            export_project,
            detect_project,
            read_project_config,
            get_effective_settings,
            get_global_settings,
            write_global_settings,
            write_project_settings,
            start_file_watcher,
            stop_file_watcher,
            register_open_file,
            unregister_open_file,
            register_write_ignore,
            poll_external_changes,
            get_recent_projects,
            add_recent_project,
            remove_recent_project,
            set_project_pinned,
            reorder_recent_projects,
            list_plugins,
            load_plugin,
            unload_plugin,
            reload_plugin,
            get_plugin_commands,
            invoke_plugin_command,
            set_plugin_document_state,
            set_plugin_enabled,
            scaffold_plugin,
            get_plugins_dir,
            is_portable_mode,
            read_draft_note,
            write_draft_note,
            delete_draft_note,
            has_draft_note,
            search_in_project,
            create_snapshot,
            list_snapshots,
            restore_snapshot,
            delete_snapshot,
            record_writing_stats,
            get_writing_stats,
            list_templates,
            create_project_from_template,
            inspect_literary_source,
            create_book_translation_project,
            create_literary_study_project,
            read_literary_study_overview,
            replace_literary_study_book,
            save_project_as_template,
            delete_template,
            import_template_zip,
            list_template_files,
            read_template_file,
            write_template_file,
            rename_template_file,
            delete_template_file,
            duplicate_bundled_template,
            create_file_with_body,
            get_pending_open_files,
            get_pending_open_projects,
            route_single_file_open_cmd,
            submit_file_open_bid,
            cli_shim_status,
            install_cli_shim,
            read_image_bytes,
            upload_image_qiniu,
            upload_image_aliyun_oss,
            upload_image_s3,
            upload_image_imgur,
            upload_image_smms,
            upload_image_custom,
            get_image_host_settings,
            set_image_host_settings,
            publish_to_ghost,
            publish_to_wordpress_self_hosted,
            publish_to_wordpress_com,
            publish_to_medium,
            verify_wordpress_self_hosted_update,
            verify_wordpress_com_update,
            upload_post_image_ghost,
            upload_post_image_wordpress_self_hosted,
            upload_post_image_wordpress_com,
            upload_post_image_medium,
            convert_markdown_to_html,
            convert_markdown_to_styled_html,
            read_styled_copy_image,
            write_styled_clipboard,
            verify_publish_channel,
            list_publish_tags,
            read_clipboard_image,
            get_publish_settings,
            set_publish_settings,
            read_publish_form_drafts,
            read_publish_remote_state,
            write_publish_form_draft,
            persist_publish_result,
            store_publish_cover,
            load_publish_cover,
            clear_publish_cover,
            bind_legacy_publication,
            write_binary_file,
            reveal_in_file_manager,
            duplicate_file,
            log_startup_phase,
            ai_fetch_stream_start,
            ai_fetch_stream_cancel,
            list_ai_sessions,
            read_ai_session,
            write_ai_session,
            list_ai_prompt_assets,
            write_ai_memory,
            save_ai_chat,
            refresh_menu,
            set_window_appearance,
            open_devtools,
            get_platform_capabilities,
            get_library_path,
            list_library_projects,
            stage_import_file,
            import_library_file,
            import_library_project,
            export_library_project,
            export_library_document,
            $($extra,)*
        ]
    };
}

fn specta_builder() -> Builder<tauri::Wry> {
    // `dangerously_cast_bigints_to_number()` keeps u64/usize fields exported
    // as `number` (file sizes, epoch-ms timestamps — all far
    // below 2^53), matching the pre-rc.25 bindings; without it the export
    // refuses BigInt-style types outright.
    let builder = Builder::<tauri::Wry>::new()
        .dangerously_cast_bigints_to_number()
        // `cli-open` is emitted manually (not a command param/result), so the
        // payload type must be registered explicitly or it vanishes from the
        // generated bindings — app-events.svelte.ts imports it.
        .typ::<CliOpenPayload>()
        // PublishError + UnsupportedUpdateReason: no command currently
        // returns these directly (commands funnel through AppError string
        // per repo convention), so specta cannot infer they should be
        // exported. Register explicitly so Task 21's structured-error UI
        // has a stable typed contract to import when it lands.
        .typ::<crate::services::publish::types::PublishError>()
        .typ::<crate::services::publish::types::UnsupportedUpdateReason>()
        .typ::<crate::services::publish::sidecar::RemoteIdentity>()
        .typ::<crate::services::publish::sidecar::ChannelState>()
        .typ::<crate::services::publish::sidecar::PublishSidecar>();
    #[cfg(feature = "sync")]
    {
        builder.commands(app_commands![
            get_sync_config,
            save_sync_config,
            sync_now,
            test_sync_connection,
            adopt_sync_identity,
            resolve_sync_conflict,
            get_cloud_account,
            check_cloud_account,
            connect_cloud_account,
            disconnect_cloud_account,
            list_cloud_projects,
            download_cloud_project,
            get_cloud_project_binding,
            bind_cloud_project,
            unbind_cloud_project,
        ])
    }
    #[cfg(not(feature = "sync"))]
    {
        builder.commands(app_commands![])
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(feature = "e2e-testing")]
    log_native_e2e_startup(&format!(
        "run.begin socket={:?}",
        std::env::var("TAURI_PLAYWRIGHT_SOCKET")
    ));
    // Early-exit flags (--version, --help) must work even if the portable
    // data directory is unwritable. Run them before portable::init() so a
    // read-only USB stick doesn't crash CLI introspection. Mobile has no
    // command line and resolves its data root in `setup` (needs the app).
    #[cfg(desktop)]
    {
        handle_early_exit_flags();
        crate::services::portable::init();
    }

    let t0 = std::time::Instant::now();
    let subscriber = tracing_subscriber::fmt().with_env_filter(
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "novelist=debug".into()),
    );
    // Android discards stdout/stderr: send the same records (and panics) to
    // logcat. Logcat stamps time itself and does not render ANSI colors.
    #[cfg(target_os = "android")]
    {
        subscriber
            .with_ansi(false)
            .without_time()
            .with_writer(logcat::Logcat)
            .init();
        logcat::install_panic_hook();
    }
    #[cfg(not(target_os = "android"))]
    subscriber.init();
    tracing::info!(
        target: "novelist::startup",
        phase = "backend.run.begin",
        since_start_ms = 0.0_f64,
        "backend phase"
    );

    let builder = specta_builder();

    #[cfg(feature = "codegen")]
    {
        let bindings_path = std::path::Path::new("../app/lib/ipc/commands.ts");
        builder
            .export(
                specta_typescript::Typescript::new()
                    .header("// @ts-nocheck\n// Auto-generated by tauri-specta\n"),
                bindings_path,
            )
            .expect("Failed to export typescript bindings");
        normalize_generated_typescript(bindings_path)
            .expect("Failed to normalize generated typescript bindings");
    }

    #[cfg(all(target_os = "macos", feature = "e2e-testing"))]
    let invoke_handler = {
        let e2e_handler: Box<tauri::ipc::InvokeHandler<tauri::Wry>> =
            Box::new(tauri::generate_handler![
                capture_e2e_webview_snapshot,
                perform_e2e_native_command_v,
                perform_e2e_native_paste,
            ]);
        let core_handler = builder.invoke_handler();
        move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
            let is_e2e = matches!(
                invoke.message.command(),
                "capture_e2e_webview_snapshot"
                    | "perform_e2e_native_command_v"
                    | "perform_e2e_native_paste"
            );
            if is_e2e {
                e2e_handler(invoke)
            } else {
                core_handler(invoke)
            }
        }
    };
    #[cfg(not(all(target_os = "macos", feature = "e2e-testing")))]
    let invoke_handler = builder.invoke_handler();

    let mut app_builder = tauri::Builder::default();

    // Desktop shell: single-instance forwarding, the native menu bar, process
    // restart and self-update. iOS/Android have none of these (TestFlight and
    // APK reinstall replace self-update).
    #[cfg(desktop)]
    {
        app_builder = app_builder
            // Single-instance MUST be the first plugin registered (per the plugin's
            // README) so its IPC pipe is alive before any other setup work runs.
            // The callback is invoked in the *original* instance with the second
            // process's argv + cwd; we parse and emit `cli-open` for the frontend.
            .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
                tracing::info!(
                    target: "novelist::cli",
                    argv = ?argv,
                    cwd = %cwd,
                    "single-instance: forwarded args from second invocation"
                );
                let cwd_path = std::path::PathBuf::from(&cwd);
                let req = parse_argv(&argv, &cwd_path);
                let mut payload = CliOpenPayload::from_request(&req);
                match open_event_target_label(app) {
                    Some(label) => {
                        // Bring the coordinator to the front so the user sees the
                        // routed result, whether it lands there or in a new window.
                        focus_open_event_target(app, &label);
                        // On Windows `emit_to` broadcasts to every webview, so stamp
                        // the intended window's label and let the frontend filter.
                        payload.target_label = label.clone();
                        if let Err(e) = app.emit_to(label.as_str(), "cli-open", payload) {
                            tracing::warn!(
                                target: "novelist::cli",
                                window = %label,
                                error = %e,
                                "failed to emit cli-open event to frontend"
                            );
                        }
                    }
                    None => {
                        tracing::warn!(
                            target: "novelist::cli",
                            "no webview window available for cli-open event"
                        );
                    }
                }
            }))
            .menu(|handle| menu::build_menu(handle, &menu::MenuLabels::fallback(), &[]))
            .on_menu_event(|app, event| {
                // Menu item IDs match command IDs registered in
                // app/lib/app-commands.ts. Emit the ID to the webview;
                // the menu-events composable dispatches through
                // commandRegistry.execute so there is a single handler map.
                let _ = app.emit("menu-command", event.id().0.clone());
            });
    }

    app_builder = app_builder
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                release_window_resources(window.app_handle(), window.label());
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_mobile_support::init());

    #[cfg(desktop)]
    {
        app_builder = app_builder.plugin(tauri_plugin_process::init());
        if !crate::services::portable::is_portable() {
            app_builder = app_builder.plugin(tauri_plugin_updater::Builder::new().build());
        }
    }

    #[cfg(feature = "e2e-testing")]
    {
        log_native_e2e_startup(&format!(
            "plugin.configure socket={:?}",
            std::env::var("TAURI_PLAYWRIGHT_SOCKET")
        ));
        let plugin = match std::env::var("TAURI_PLAYWRIGHT_SOCKET") {
            Ok(path) if !path.trim().is_empty() => tauri_plugin_playwright::init_with_config(
                tauri_plugin_playwright::PluginConfig::new().socket_path(path),
            ),
            _ => tauri_plugin_playwright::init(),
        };
        app_builder = app_builder.plugin(plugin);
    }

    tracing::info!(
        target: "novelist::startup",
        phase = "backend.specta.ready",
        since_start_ms = t0.elapsed().as_secs_f64() * 1000.0,
        "backend phase"
    );
    app_builder
        .manage(FileWatcherState::new())
        .manage(WindowImageCapabilities::new())
        .manage(PluginHostState::new())
        .manage(EncodingState::new())
        .manage(ExportState::new())
        .manage(PendingOpenFiles::new())
        .manage(PendingOpenProjects::new())
        .manage(FileRoutingState::new())
        .manage(AiBridgeState::new())
        .invoke_handler(invoke_handler)
        .setup(move |app| {
            // The mobile data root lives in the app sandbox, which is only
            // known once the app exists; nothing may read it before this.
            #[cfg(mobile)]
            crate::services::portable::init_mobile(app.handle())?;
            // Cloud credentials live in the platform keychain/keystore through
            // the mobile-support plugin (initialized before this hook).
            #[cfg(all(mobile, feature = "sync"))]
            crate::services::cloud::install_native_vault(app.handle());

            #[cfg(feature = "e2e-testing")]
            log_native_e2e_startup("setup.begin");
            tracing::info!(
                target: "novelist::startup",
                phase = "backend.setup.begin",
                since_start_ms = t0.elapsed().as_secs_f64() * 1000.0,
                "backend phase"
            );

            if let Err(error) = crate::services::bundled_resources::prepare() {
                tracing::warn!(
                    target: "novelist::startup",
                    %error,
                    "bundled plugins and templates are unavailable"
                );
            }

            // Plugin iframes load through the asset protocol. The static
            // config scope names the default desktop and mobile roots; extend
            // it to the resolved data root wherever that can differ.
            if cfg!(mobile) || crate::services::portable::is_portable() {
                let plugins_dir = crate::services::portable::novelist_home().join("plugins");
                if let Err(e) = std::fs::create_dir_all(&plugins_dir) {
                    tracing::warn!(
                        target: "novelist::portable",
                        ?plugins_dir,
                        error = %e,
                        "failed to create plugins directory"
                    );
                }
                if let Err(e) = app
                    .asset_protocol_scope()
                    .allow_directory(&plugins_dir, true)
                {
                    tracing::warn!(
                        target: "novelist::portable",
                        ?plugins_dir,
                        error = %e,
                        "failed to extend asset protocol scope for plugins"
                    );
                }
            }

            builder.mount_events(app);

            // macOS chrome tweaks — run after the main window exists.
            #[cfg(target_os = "macos")]
            match app.get_webview_window("main") {
                Some(win) => {
                    remove_titlebar_separator(&win);
                    tracing::info!(
                        target: "novelist::startup",
                        phase = "backend.macos.titlebar-separator-tamed",
                        "called setTitlebarSeparatorStyle:.none on main window"
                    );
                }
                None => {
                    tracing::warn!(
                        target: "novelist::startup",
                        "main webview window not found during setup; macOS chrome tweaks skipped"
                    );
                }
            }

            // Cold-start CLI args: parse files + folders into the pending
            // queues so the main window drains them on first mount. Mobile
            // launch arguments are not user paths.
            #[cfg(desktop)]
            {
                let argv: Vec<String> = std::env::args().collect();
                let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
                let req = parse_argv(&argv, &cwd);
                let pending_files = app.state::<PendingOpenFiles>();
                for f in &req.files {
                    pending_files.push(PendingFile::from_target(f));
                }
                let pending_projects = app.state::<PendingOpenProjects>();
                for d in &req.folders {
                    pending_projects.push(d.to_string_lossy().to_string());
                }
            }

            tracing::info!(
                target: "novelist::startup",
                phase = "backend.setup.end",
                since_start_ms = t0.elapsed().as_secs_f64() * 1000.0,
                "backend phase"
            );
            #[cfg(feature = "e2e-testing")]
            log_native_e2e_startup("setup.end");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(feature = "e2e-testing")]
            if matches!(event, tauri::RunEvent::Ready) {
                log_native_e2e_startup("event.ready");
            }
            #[cfg(all(target_os = "macos", feature = "e2e-testing"))]
            if matches!(event, tauri::RunEvent::Ready) {
                commands::e2e::request_visual_native_activation_once(app);
            }
            // macOS: handle file-open Apple Events (Finder "Open With", double-click)
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                let text_extensions = ["md", "markdown", "txt", "json", "jsonl", "csv"];
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                            if text_extensions.contains(&ext.to_lowercase().as_str()) {
                                let file_path = path.to_string_lossy().to_string();
                                // Push to pending queue (for cold start when frontend
                                // hasn't registered its listener yet)
                                let pending = app.state::<PendingOpenFiles>();
                                pending.push(PendingFile::from_path(file_path.clone()));
                                // Also emit for the hot path (app already running,
                                // listener active)
                                match open_event_target_label(app) {
                                    Some(label) => {
                                        let payload = OpenFilePayload {
                                            path: file_path,
                                            target_label: label.clone(),
                                        };
                                        if let Err(e) =
                                            app.emit_to(label.as_str(), "open-file", payload)
                                        {
                                            tracing::warn!(
                                                target: "novelist::cli",
                                                window = %label,
                                                error = %e,
                                                "failed to emit open-file event to frontend"
                                            );
                                        }
                                    }
                                    None => {
                                        tracing::warn!(
                                            target: "novelist::cli",
                                            "no webview window available for open-file event"
                                        );
                                    }
                                }
                                break;
                            }
                        }
                    }
                }
            }
            // Suppress unused variable warnings on non-macOS
            let _ = (app, event);
        });
}

/// Free everything keyed by a destroyed window's label. Labels are never
/// reused (`novelist-${Date.now()}`), so anything left behind would leak for
/// the rest of the session — e.g. a recursive file watcher whose debounce task
/// keeps running for a window that no longer exists.
fn release_window_resources<R: tauri::Runtime>(app: &tauri::AppHandle<R>, owner_label: &str) {
    if let Some(state) = app.try_state::<FileWatcherState>() {
        if let Err(error) = services::file_watcher::stop_file_watcher_inner(owner_label, &state) {
            tracing::warn!(
                "failed to stop the file watcher of closed window {owner_label}: {error}"
            );
        }
    }
    if let Some(state) = app.try_state::<WindowImageCapabilities>() {
        state.clear_owner(owner_label);
    }
}

#[cfg(test)]
mod external_open_payload_tests {
    use super::*;
    use std::path::Path;

    // The frontend filters `cli-open` on this exact JSON key because Windows'
    // `emit_to` broadcasts to every webview (see app-events listeners). A
    // rename or serde attribute change would silently disable the filter and
    // reintroduce the file-opens-in-every-window bug.
    #[test]
    fn cli_open_payload_serializes_target_label_for_frontend_filter() {
        let req = parse_argv(
            &["novelist".to_string(), "/tmp/a.md".to_string()],
            Path::new("/tmp"),
        );
        let mut payload = CliOpenPayload::from_request(&req);
        payload.target_label = "main".into();
        let json = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(json["target_label"], "main");
    }

    // `from_request` must not invent a target: the label is stamped by the
    // emitter only after the coordinator window is chosen, and an empty label
    // means "unaddressed" (frontend guard lets it through for compatibility).
    #[test]
    fn cli_open_payload_target_is_empty_until_coordinator_is_chosen() {
        let req = parse_argv(
            &["novelist".to_string(), "/tmp/a.md".to_string()],
            Path::new("/tmp"),
        );
        let payload = CliOpenPayload::from_request(&req);
        assert!(payload.target_label.is_empty());
    }

    // Same wire contract for the macOS Finder "Open With" hot path.
    #[cfg(target_os = "macos")]
    #[test]
    fn open_file_payload_serializes_target_label_for_frontend_filter() {
        let payload = OpenFilePayload {
            path: "/tmp/a.md".into(),
            target_label: "main".into(),
        };
        let json = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(json["target_label"], "main");
    }
}
