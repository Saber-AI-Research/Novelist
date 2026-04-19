mod commands;
mod error;
mod models;
mod services;

pub use error::AppError;

use std::sync::Mutex;

use commands::draft::{delete_draft_note, has_draft_note, read_draft_note, write_draft_note};
use commands::export::{check_pandoc, export_project};
use commands::file::{
    broadcast_file_renamed, create_directory, create_file, create_scratch_file, delete_item,
    duplicate_file, get_file_encoding, list_directory, move_item, read_file, read_image_data_uri,
    rename_item, reveal_in_file_manager, search_in_project, write_binary_file, write_file,
    EncodingState,
};
use commands::plugin::{
    get_plugin_commands, get_plugins_dir, invoke_plugin_command, list_plugins, load_plugin,
    scaffold_plugin, set_plugin_document_state, set_plugin_enabled, unload_plugin,
};
use commands::project::{detect_project, read_project_config};
use commands::recent::{add_recent_project, get_recent_projects, remove_recent_project};
use commands::snapshot::{create_snapshot, delete_snapshot, list_snapshots, restore_snapshot};
use commands::stats::{get_writing_stats, record_writing_stats};
#[cfg(feature = "sync")]
use commands::sync::{get_sync_config, save_sync_config, sync_now, test_sync_connection};
use commands::template::{
    create_project_from_template, delete_template, import_template_zip, list_templates,
    save_project_as_template,
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
use tauri::{Emitter, Manager};
use tauri_specta::{collect_commands, Builder};

/// Files queued for opening before the frontend listener is ready.
/// Populated by CLI args and macOS `RunEvent::Opened`; drained by the
/// frontend via `get_pending_open_files` on mount.
pub struct PendingOpenFiles(Mutex<Vec<String>>);

impl PendingOpenFiles {
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
fn get_pending_open_files(state: tauri::State<'_, PendingOpenFiles>) -> Vec<String> {
    state.drain()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "novelist=debug".into()),
        )
        .init();

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
        export_project,
        detect_project,
        read_project_config,
        start_file_watcher,
        stop_file_watcher,
        register_open_file,
        unregister_open_file,
        register_write_ignore,
        get_recent_projects,
        add_recent_project,
        remove_recent_project,
        list_plugins,
        load_plugin,
        unload_plugin,
        get_plugin_commands,
        invoke_plugin_command,
        set_plugin_document_state,
        set_plugin_enabled,
        scaffold_plugin,
        get_plugins_dir,
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
        get_pending_open_files,
        read_image_data_uri,
        write_binary_file,
        reveal_in_file_manager,
        duplicate_file,
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
        export_project,
        detect_project,
        read_project_config,
        start_file_watcher,
        stop_file_watcher,
        register_open_file,
        unregister_open_file,
        register_write_ignore,
        get_recent_projects,
        add_recent_project,
        remove_recent_project,
        list_plugins,
        load_plugin,
        unload_plugin,
        get_plugin_commands,
        invoke_plugin_command,
        set_plugin_document_state,
        set_plugin_enabled,
        scaffold_plugin,
        get_plugins_dir,
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
        get_pending_open_files,
        read_image_data_uri,
        write_binary_file,
        reveal_in_file_manager,
        duplicate_file,
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(feature = "e2e-testing")]
    {
        app_builder = app_builder.plugin(tauri_plugin_playwright::init());
    }

    app_builder
        .manage(FileWatcherState::new())
        .manage(PluginHostState::new())
        .manage(RopeDocumentState::new())
        .manage(EncodingState::new())
        .manage(PendingOpenFiles::new())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);

            // Check CLI args for a file path to open in single-file mode.
            // Push to PendingOpenFiles so the frontend can pick them up on mount.
            let pending = app.state::<PendingOpenFiles>();
            let args: Vec<String> = std::env::args().skip(1).collect();
            let text_extensions = [".md", ".markdown", ".txt", ".json", ".jsonl", ".csv"];
            for arg in &args {
                let path = std::path::Path::new(arg);
                if path.exists()
                    && text_extensions
                        .iter()
                        .any(|ext| arg.to_lowercase().ends_with(ext))
                {
                    let file_path = path
                        .canonicalize()
                        .unwrap_or_else(|_| path.to_path_buf())
                        .to_string_lossy()
                        .to_string();
                    pending.push(file_path);
                    break;
                }
            }

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
                                pending.push(file_path.clone());
                                // Also emit for the hot path (app already running,
                                // listener active)
                                let _ = app.emit("open-file", file_path);
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
