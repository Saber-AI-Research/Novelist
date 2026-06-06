//! Native application menu.
//!
//! The menu is the OS menu bar (macOS primarily — also renders as a
//! window menu on Linux/Windows). Every custom item ID matches a
//! command ID registered in `app/lib/app-commands.ts`, so menu clicks
//! route through the single `commandRegistry.execute(id)` dispatch
//! map and do not duplicate handler logic.
//!
//! ## Accelerators
//!
//! Menu accelerators are set here and displayed as shortcut hints on
//! macOS (e.g. "New File ⌘N"). They also register as OS-level key
//! bindings. To prevent double-handling with the JS shortcut router in
//! `app-shortcuts.svelte.ts`, `commandRegistry.execute` debounces
//! repeated calls to the same ID within ~50 ms. The accelerators
//! intentionally match the *default* shortcut mapping; user-customised
//! shortcuts do not update the menu display (follow-up work).
//!
//! ## i18n
//!
//! Labels are passed in from the frontend via the `refresh_menu` IPC
//! command. The frontend builds the label map from the i18n store and
//! calls `refresh_menu` on init and whenever locale or recent-projects
//! state changes. A default English `MenuLabels::fallback()` is used
//! to build the very first menu at startup, before the frontend is
//! ready.
//!
//! ## Open Recent
//!
//! Recent project entries are passed in via the same IPC. Each becomes
//! a menu item with ID `open-recent:<absolute-path>`. The frontend
//! menu-events bridge strips the prefix and opens the directory.

use serde::Deserialize;
use specta::Type;
use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Runtime};

/// All human-readable labels used in the menu. The frontend builds
/// this from the i18n store for the current locale. Every field must
/// be present — fall back to the English string on the frontend if a
/// translation is missing.
#[derive(Debug, Clone, Deserialize, Type)]
pub struct MenuLabels {
    // Menu bar titles
    pub file_menu: String,
    pub edit_menu: String,
    pub view_menu: String,
    pub window_menu: String,
    pub help_menu: String,

    // Novelist (app) menu
    pub about_novelist: String,
    pub settings: String,

    // File menu
    pub new_file: String,
    pub new_window: String,
    pub new_project: String,
    pub open_directory: String,
    pub open_recent: String,
    pub no_recent: String,
    pub switch_project: String,
    pub rename_file: String,
    pub move_file: String,
    pub save_as_template: String,
    pub export_project: String,
    pub close_tab: String,

    // Edit menu (custom items — predefined items use OS defaults)
    pub find_in_project: String,
    pub go_to_line: String,
    pub bold: String,
    pub italic: String,
    pub strikethrough: String,
    pub insert_link: String,
    pub inline_code: String,
    pub toggle_heading: String,
    pub copy_rich_text: String,
    pub copy_plain_text: String,
    pub simplified_to_traditional: String,
    pub traditional_to_simplified: String,
    pub generate_pinyin: String,

    // View menu
    pub command_palette: String,
    pub toggle_sidebar: String,
    pub toggle_outline: String,
    pub toggle_zen: String,
    pub toggle_draft: String,
    pub toggle_snapshot: String,
    pub toggle_stats: String,
    pub toggle_template: String,
    pub toggle_mindmap: String,
    pub toggle_split: String,

    // Help menu
    pub check_for_updates: String,
}

impl MenuLabels {
    /// English fallback used to build the menu at startup, before the
    /// frontend has loaded its locale setting.
    pub fn fallback() -> Self {
        Self {
            file_menu: "File".into(),
            edit_menu: "Edit".into(),
            view_menu: "View".into(),
            window_menu: "Window".into(),
            help_menu: "Help".into(),

            about_novelist: "About Novelist".into(),
            settings: "Settings…".into(),

            new_file: "New File".into(),
            new_window: "New Window".into(),
            new_project: "New Project…".into(),
            open_directory: "Open Directory…".into(),
            open_recent: "Open Recent".into(),
            no_recent: "No Recent Projects".into(),
            switch_project: "Switch Project…".into(),
            rename_file: "Rename…".into(),
            move_file: "Move File…".into(),
            save_as_template: "Save as Template".into(),
            export_project: "Export Project…".into(),
            close_tab: "Close Tab".into(),

            find_in_project: "Find in Project…".into(),
            go_to_line: "Go to Line…".into(),
            bold: "Bold".into(),
            italic: "Italic".into(),
            strikethrough: "Strikethrough".into(),
            insert_link: "Insert Link".into(),
            inline_code: "Inline Code".into(),
            toggle_heading: "Toggle Heading".into(),
            copy_rich_text: "Copy as Rich Text".into(),
            copy_plain_text: "Copy as Plain Text".into(),
            simplified_to_traditional: "Simplified → Traditional".into(),
            traditional_to_simplified: "Traditional → Simplified".into(),
            generate_pinyin: "Generate Pinyin".into(),

            command_palette: "Command Palette".into(),
            toggle_sidebar: "Toggle Sidebar".into(),
            toggle_outline: "Toggle Outline".into(),
            toggle_zen: "Toggle Zen Mode".into(),
            toggle_draft: "Toggle Draft Panel".into(),
            toggle_snapshot: "Toggle Snapshot Panel".into(),
            toggle_stats: "Toggle Stats Panel".into(),
            toggle_template: "Toggle Template Panel".into(),
            toggle_mindmap: "Toggle Mindmap".into(),
            toggle_split: "Toggle Split View".into(),

            check_for_updates: "Check for Updates…".into(),
        }
    }
}

/// An entry shown under the Open Recent submenu. Name is the display
/// label; path is the absolute directory path used as the menu item ID
/// suffix.
#[derive(Debug, Clone, Deserialize, Type)]
pub struct RecentEntry {
    pub name: String,
    pub path: String,
}

fn item_with_accel<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let mut builder = MenuItemBuilder::with_id(id, label);
    if let Some(acc) = accelerator {
        builder = builder.accelerator(acc);
    }
    builder.build(app)
}

fn custom<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    item_with_accel(app, id, label, None)
}

fn non_macos_accel(accelerator: &'static str) -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        None
    } else {
        Some(accelerator)
    }
}

/// Build the full application menu. Called at startup with the English
/// fallback and re-called via the `refresh_menu` IPC whenever the
/// locale or recent-projects list changes.
pub fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    labels: &MenuLabels,
    recent: &[RecentEntry],
) -> tauri::Result<Menu<R>> {
    let about_metadata = AboutMetadataBuilder::new()
        .name(Some("Novelist"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .copyright(Some("© 2026 Chivier Humber"))
        .build();

    // ── Novelist (app) menu ──────────────────────────────────────────
    let app_menu = SubmenuBuilder::new(app, "Novelist")
        .items(&[
            &PredefinedMenuItem::about(app, Some(&labels.about_novelist), Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &item_with_accel(app, "open-settings", &labels.settings, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ])
        .build()?;

    // ── Open Recent submenu ──────────────────────────────────────────
    let open_recent = if recent.is_empty() {
        let placeholder = MenuItemBuilder::with_id("open-recent:__none__", &labels.no_recent)
            .enabled(false)
            .build(app)?;
        SubmenuBuilder::new(app, &labels.open_recent)
            .items(&[&placeholder])
            .build()?
    } else {
        let mut sub = SubmenuBuilder::new(app, &labels.open_recent);
        for entry in recent.iter().take(10) {
            let item = MenuItemBuilder::with_id(format!("open-recent:{}", entry.path), &entry.name)
                .build(app)?;
            sub = sub.item(&item);
        }
        sub.build()?
    };

    // ── File ─────────────────────────────────────────────────────────
    let file_menu = SubmenuBuilder::new(app, &labels.file_menu)
        .items(&[
            &item_with_accel(app, "new-file", &labels.new_file, Some("CmdOrCtrl+N"))?,
            &item_with_accel(
                app,
                "new-window",
                &labels.new_window,
                Some("CmdOrCtrl+Shift+N"),
            )?,
            &custom(app, "new-project", &labels.new_project)?,
            &PredefinedMenuItem::separator(app)?,
            &item_with_accel(
                app,
                "open-directory",
                &labels.open_directory,
                Some("CmdOrCtrl+O"),
            )?,
            &open_recent,
            &custom(app, "switch-project", &labels.switch_project)?,
            &PredefinedMenuItem::separator(app)?,
            &item_with_accel(
                app,
                "rename-file",
                &labels.rename_file,
                Some("CmdOrCtrl+Shift+R"),
            )?,
            // Cmd+M conflicts with macOS Minimize, but Windows/Linux users
            // should still see the native Ctrl+M menu accelerator.
            &item_with_accel(
                app,
                "move-file",
                &labels.move_file,
                non_macos_accel("CmdOrCtrl+M"),
            )?,
            &custom(app, "save-current-as-template", &labels.save_as_template)?,
            &PredefinedMenuItem::separator(app)?,
            &custom(app, "export-project", &labels.export_project)?,
            &PredefinedMenuItem::separator(app)?,
            &item_with_accel(app, "close-tab", &labels.close_tab, Some("CmdOrCtrl+W"))?,
            &PredefinedMenuItem::close_window(app, None)?,
        ])
        .build()?;

    // ── Edit ─────────────────────────────────────────────────────────
    let edit_menu = SubmenuBuilder::new(app, &labels.edit_menu)
        .items(&[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &item_with_accel(
                app,
                "project-search",
                &labels.find_in_project,
                Some("CmdOrCtrl+Shift+F"),
            )?,
            &item_with_accel(app, "go-to-line", &labels.go_to_line, Some("CmdOrCtrl+G"))?,
            &PredefinedMenuItem::separator(app)?,
            &item_with_accel(app, "editor-bold", &labels.bold, Some("CmdOrCtrl+B"))?,
            &item_with_accel(app, "editor-italic", &labels.italic, Some("CmdOrCtrl+I"))?,
            &item_with_accel(
                app,
                "editor-strikethrough",
                &labels.strikethrough,
                Some("CmdOrCtrl+Shift+X"),
            )?,
            &item_with_accel(app, "editor-link", &labels.insert_link, Some("CmdOrCtrl+K"))?,
            &item_with_accel(
                app,
                "editor-code-inline",
                &labels.inline_code,
                Some("CmdOrCtrl+E"),
            )?,
            // No accelerator: default Cmd+H conflicts with macOS Hide.
            &custom(app, "editor-heading", &labels.toggle_heading)?,
            &PredefinedMenuItem::separator(app)?,
            &custom(app, "copy-rich-text", &labels.copy_rich_text)?,
            &custom(app, "copy-plain-text", &labels.copy_plain_text)?,
            &PredefinedMenuItem::separator(app)?,
            &custom(app, "chinese-s2t", &labels.simplified_to_traditional)?,
            &custom(app, "chinese-t2s", &labels.traditional_to_simplified)?,
            &custom(app, "chinese-pinyin", &labels.generate_pinyin)?,
        ])
        .build()?;

    // ── View ─────────────────────────────────────────────────────────
    let view_menu = SubmenuBuilder::new(app, &labels.view_menu)
        .items(&[
            &item_with_accel(
                app,
                "command-palette",
                &labels.command_palette,
                Some("CmdOrCtrl+Shift+P"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &item_with_accel(
                app,
                "toggle-sidebar",
                &labels.toggle_sidebar,
                Some("CmdOrCtrl+Shift+B"),
            )?,
            &custom(app, "toggle-outline", &labels.toggle_outline)?,
            &custom(app, "toggle-zen", &labels.toggle_zen)?,
            &custom(app, "toggle-draft", &labels.toggle_draft)?,
            &custom(app, "toggle-snapshot", &labels.toggle_snapshot)?,
            &custom(app, "toggle-stats", &labels.toggle_stats)?,
            &custom(app, "toggle-template", &labels.toggle_template)?,
            &custom(app, "toggle-mindmap", &labels.toggle_mindmap)?,
            &PredefinedMenuItem::separator(app)?,
            &custom(app, "toggle-split", &labels.toggle_split)?,
        ])
        .build()?;

    // ── Window ───────────────────────────────────────────────────────
    let window_menu = SubmenuBuilder::new(app, &labels.window_menu)
        .items(&[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ])
        .build()?;

    // ── Help ─────────────────────────────────────────────────────────
    let help_menu = SubmenuBuilder::new(app, &labels.help_menu)
        .items(&[&custom(
            app,
            "check-for-updates",
            &labels.check_for_updates,
        )?])
        .build()?;

    MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ])
        .build()
}
