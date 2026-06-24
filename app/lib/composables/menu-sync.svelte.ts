import { commands, type MenuLabels, type RecentEntry, type RecentProject } from '$lib/ipc/commands';
import { i18n, t } from '$lib/i18n/index.svelte';

/**
 * Build the label map for the native menu from the current i18n store.
 * Adds missing menu-specific keys (titles, Open Recent) on top of the
 * `command.*` strings shared with the command palette.
 */
function buildLabels(): MenuLabels {
  return {
    file_menu: t('menu.file'),
    edit_menu: t('menu.edit'),
    view_menu: t('menu.view'),
    window_menu: t('menu.window'),
    help_menu: t('menu.help'),

    about_novelist: t('menu.aboutNovelist'),
    settings: t('command.openSettings'),

    new_file: t('command.newFile'),
    new_window: t('command.newWindow'),
    new_project: t('command.newProject'),
    open_file: t('command.openFile'),
    open_directory: t('command.openDirectory'),
    open_recent: t('menu.openRecent'),
    no_recent: t('menu.noRecent'),
    open_containing_folder: t('command.openContainingFolder'),
    switch_project: t('command.switchProject'),
    rename_file: t('command.renameFile'),
    move_file: t('command.moveFile'),
    save_as_template: t('command.saveCurrentAsTemplate'),
    export_project: t('command.exportProject'),
    close_tab: t('command.closeTab'),

    find_in_project: t('command.projectSearch'),
    go_to_line: t('command.goToLine'),
    bold: t('command.bold'),
    italic: t('command.italic'),
    strikethrough: t('command.strikethrough'),
    insert_link: t('command.insertLink'),
    inline_code: t('command.inlineCode'),
    toggle_heading: t('command.toggleHeading'),
    copy_rich_text: t('command.copyRichText'),
    copy_plain_text: t('command.copyPlainText'),
    simplified_to_traditional: t('command.simplifiedToTraditional'),
    traditional_to_simplified: t('command.traditionalToSimplified'),
    generate_pinyin: t('command.generatePinyin'),

    command_palette: t('command.commandPalette'),
    toggle_sidebar: t('command.toggleSidebar'),
    toggle_outline: t('command.toggleOutline'),
    toggle_zen: t('command.toggleZen'),
    toggle_draft: t('command.toggleDraft'),
    toggle_snapshot: t('command.toggleSnapshot'),
    toggle_stats: t('command.toggleStats'),
    toggle_template: t('command.toggleTemplate'),
    toggle_mindmap: t('command.toggleMindmap'),
    toggle_split: t('command.toggleSplit'),

    check_for_updates: t('command.checkForUpdates'),
  };
}

function toRecentEntries(projects: RecentProject[]): RecentEntry[] {
  return projects.slice(0, 10).map((p) => ({ name: p.name, path: p.path }));
}

/**
 * Rebuild and install the native menu. Call on app init, after locale
 * changes, and after the recent-projects list changes. Errors are
 * swallowed because a failed menu rebuild should not break the app —
 * the previous menu stays installed.
 */
export async function syncMenu(recentProjects: RecentProject[]): Promise<void> {
  try {
    await commands.refreshMenu(buildLabels(), toRecentEntries(recentProjects));
  } catch (_) {
    // ignore — old menu remains
  }
}

/**
 * Reactive wrapper: rebuilds the native menu whenever the current
 * locale or the recent-projects list changes. Call from a component's
 * init (uses `$effect`). Initial sync runs on mount because `$effect`
 * evaluates once immediately after setup.
 */
export function useMenuSync(getRecentProjects: () => RecentProject[]): void {
  $effect(() => {
    // Establish reactive deps: locale triggers a rebuild so labels
    // follow the UI language; recentProjects drives the Open Recent
    // submenu.
    void i18n.locale;
    const recents = getRecentProjects();
    void syncMenu(recents);
  });
}
