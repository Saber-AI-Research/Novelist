mod commands;
mod error;
mod menu;
mod models;
mod services;

pub use error::AppError;

use std::sync::Mutex;

use commands::ai_bridge::{ai_fetch_stream_cancel, ai_fetch_stream_start, AiBridgeState};
use commands::ai_files::{
    delete_ai_session, list_ai_prompt_assets, list_ai_sessions, read_ai_session, write_ai_memory,
    write_ai_session,
};
use commands::bench::log_startup_phase;
use commands::claude_bridge::{
    claude_cli_detect, claude_cli_kill, claude_cli_send, claude_cli_spawn, ClaudeBridgeState,
};
use commands::cli_shim::{cli_shim_status, install_cli_shim};
use commands::draft::{delete_draft_note, has_draft_note, read_draft_note, write_draft_note};
use commands::export::{check_pandoc, export_project, set_pandoc_path};
use commands::file::{
    broadcast_file_renamed, create_directory, create_file, create_scratch_file, delete_item,
    duplicate_file, get_file_encoding, list_directory, move_item, read_file, read_image_data_uri,
    rename_item, reveal_in_file_manager, search_in_project, write_binary_file, write_file,
    EncodingState,
};
use commands::image_host::{
    get_image_host_settings, read_image_bytes, set_image_host_settings, upload_image_aliyun_oss,
    upload_image_custom, upload_image_imgur, upload_image_qiniu, upload_image_s3,
    upload_image_smms,
};
use commands::menu::refresh_menu;
use commands::plugin::{
    get_plugin_commands, get_plugins_dir, invoke_plugin_command, list_plugins, load_plugin,
    reload_plugin, scaffold_plugin, set_plugin_document_state, set_plugin_enabled, unload_plugin,
};
use commands::portable::is_portable_mode;
use commands::project::{detect_project, read_project_config};
use commands::publish::{
    convert_markdown_to_html, get_publish_settings, list_publish_tags, publish_to_ghost,
    publish_to_medium, publish_to_wordpress_com, publish_to_wordpress_self_hosted,
    read_clipboard_image, set_publish_settings, upload_post_image_ghost, upload_post_image_medium,
    upload_post_image_wordpress_com, upload_post_image_wordpress_self_hosted,
    verify_publish_channel,
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
#[cfg(feature = "sync")]
use commands::sync::{get_sync_config, save_sync_config, sync_now, test_sync_connection};
use commands::template::{
    create_project_from_template, delete_template, import_template_zip, list_templates,
    save_project_as_template,
};
use commands::template_files::{
    create_file_with_body, delete_template_file, duplicate_bundled_template, list_template_files,
    read_template_file, rename_template_file, write_template_file,
};
use commands::window::set_window_appearance;
use serde::{Deserialize, Serialize};
use services::file_routing::{
    pick_open_event_target, route_single_file_open_cmd, submit_file_open_bid, FileRoutingState,
};
use services::file_watcher::{
    register_open_file, register_write_ignore, start_file_watcher, stop_file_watcher,
    unregister_open_file, FileWatcherState,
};
use services::plugin_host::sandbox::PluginHostState;
use services::rope_document::{
    rope_apply_edit, rope_close, rope_get_lines, rope_line_to_char, rope_open, rope_save,
    RopeDocumentState,
};
use specta::Type;
use tauri::{Emitter, Manager};
use tauri_specta::{collect_commands, Builder};

use services::cli::{help_text, parse_argv, CliRequest, FileTarget};

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
    fn from_target(t: &FileTarget) -> Self {
        Self {
            path: t.path.to_string_lossy().to_string(),
            line: t.line,
            col: t.col,
        }
    }
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

fn open_event_target_label(app: &tauri::AppHandle) -> Option<String> {
    let labels = app.webview_windows().keys().cloned().collect();
    pick_open_event_target(labels)
}

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Early-exit flags (--version, --help) must work even if the portable
    // data directory is unwritable. Run them before portable::init() so a
    // read-only USB stick doesn't crash CLI introspection.
    handle_early_exit_flags();

    crate::services::portable::init();

    let t0 = std::time::Instant::now();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "novelist=debug".into()),
        )
        .init();
    tracing::info!(
        target: "novelist::startup",
        phase = "backend.run.begin",
        since_start_ms = 0.0_f64,
        "backend phase"
    );

    #[cfg(feature = "sync")]
    let builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        read_file,
        write_file,
        get_file_encoding,
        list_directory,
        create_file,
        create_scratch_file,
        create_directory,
        rename_item,
        broadcast_file_renamed,
        move_item,
        delete_item,
        check_pandoc,
        set_pandoc_path,
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
        rope_open,
        rope_get_lines,
        rope_apply_edit,
        rope_save,
        rope_close,
        rope_line_to_char,
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
        read_image_data_uri,
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
        upload_post_image_ghost,
        upload_post_image_wordpress_self_hosted,
        upload_post_image_wordpress_com,
        upload_post_image_medium,
        convert_markdown_to_html,
        verify_publish_channel,
        list_publish_tags,
        read_clipboard_image,
        get_publish_settings,
        set_publish_settings,
        write_binary_file,
        reveal_in_file_manager,
        duplicate_file,
        log_startup_phase,
        ai_fetch_stream_start,
        ai_fetch_stream_cancel,
        list_ai_sessions,
        read_ai_session,
        write_ai_session,
        delete_ai_session,
        list_ai_prompt_assets,
        write_ai_memory,
        claude_cli_detect,
        claude_cli_spawn,
        claude_cli_send,
        claude_cli_kill,
        refresh_menu,
        set_window_appearance,
        get_sync_config,
        save_sync_config,
        sync_now,
        test_sync_connection,
    ]);
    #[cfg(not(feature = "sync"))]
    let builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        read_file,
        write_file,
        get_file_encoding,
        list_directory,
        create_file,
        create_scratch_file,
        create_directory,
        rename_item,
        broadcast_file_renamed,
        move_item,
        delete_item,
        check_pandoc,
        set_pandoc_path,
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
        rope_open,
        rope_get_lines,
        rope_apply_edit,
        rope_save,
        rope_close,
        rope_line_to_char,
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
        read_image_data_uri,
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
        upload_post_image_ghost,
        upload_post_image_wordpress_self_hosted,
        upload_post_image_wordpress_com,
        upload_post_image_medium,
        convert_markdown_to_html,
        verify_publish_channel,
        list_publish_tags,
        read_clipboard_image,
        get_publish_settings,
        set_publish_settings,
        write_binary_file,
        reveal_in_file_manager,
        duplicate_file,
        log_startup_phase,
        ai_fetch_stream_start,
        ai_fetch_stream_cancel,
        list_ai_sessions,
        read_ai_session,
        write_ai_session,
        delete_ai_session,
        list_ai_prompt_assets,
        write_ai_memory,
        claude_cli_detect,
        claude_cli_spawn,
        claude_cli_send,
        claude_cli_kill,
        refresh_menu,
        set_window_appearance,
    ]);

    #[cfg(feature = "codegen")]
    builder
        .export(
            specta_typescript::Typescript::new()
                .header("// @ts-nocheck\n// Auto-generated by tauri-specta\n"),
            "../app/lib/ipc/commands.ts",
        )
        .expect("Failed to export typescript bindings");

    #[allow(unused_mut)]
    let mut app_builder = tauri::Builder::default()
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
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init());

    if !crate::services::portable::is_portable() {
        app_builder = app_builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    #[cfg(feature = "e2e-testing")]
    {
        app_builder = app_builder.plugin(tauri_plugin_playwright::init());
    }

    tracing::info!(
        target: "novelist::startup",
        phase = "backend.specta.ready",
        since_start_ms = t0.elapsed().as_secs_f64() * 1000.0,
        "backend phase"
    );
    app_builder
        .manage(FileWatcherState::new())
        .manage(PluginHostState::new())
        .manage(RopeDocumentState::new())
        .manage(EncodingState::new())
        .manage(PendingOpenFiles::new())
        .manage(PendingOpenProjects::new())
        .manage(FileRoutingState::new())
        .manage(AiBridgeState::new())
        .manage(ClaudeBridgeState::new())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            tracing::info!(
                target: "novelist::startup",
                phase = "backend.setup.begin",
                since_start_ms = t0.elapsed().as_secs_f64() * 1000.0,
                "backend phase"
            );

            if crate::services::portable::is_portable() {
                let plugins_dir = crate::services::portable::novelist_home().join("plugins");
                if let Err(e) = std::fs::create_dir_all(&plugins_dir) {
                    tracing::warn!(
                        target: "novelist::portable",
                        ?plugins_dir,
                        error = %e,
                        "failed to create portable plugins directory"
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
                        "failed to extend asset protocol scope for portable plugins"
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
            // queues so the main window drains them on first mount.
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

            tracing::info!(
                target: "novelist::startup",
                phase = "backend.setup.end",
                since_start_ms = t0.elapsed().as_secs_f64() * 1000.0,
                "backend phase"
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
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
