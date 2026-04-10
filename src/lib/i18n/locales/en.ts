import type { TranslationMap } from '../types';

export const en: TranslationMap = {
  // --- App ---
  'app.name': 'Novelist',
  'app.subtitle': 'A desktop writing app for novelists',
  'app.openFolder': 'Open a folder to get started',
  'app.openFile': 'Open a file in this pane',

  // --- Welcome ---
  'welcome.recentProjects': 'Recent Projects',
  'welcome.noRecent': 'No recent projects yet.',
  'welcome.openDirectory': 'Open Directory...',

  // --- Sidebar ---
  'sidebar.openFolder': 'Open Folder',
  'sidebar.newFile': 'New File (Cmd+N)',
  'sidebar.newFolder': 'New Folder',
  'sidebar.projects': 'Projects',
  'sidebar.openFolderEllipsis': 'Open Folder...',
  'sidebar.noProject': 'No project open',
  'sidebar.fileNamePlaceholder': 'File name...',
  'sidebar.folderNamePlaceholder': 'Folder name...',
  'sidebar.openInOtherPane': 'Open in Other Pane',
  'sidebar.rename': 'Rename',
  'sidebar.delete': 'Delete',
  'sidebar.deleteConfirm': 'Delete "{name}"? This cannot be undone.',
  'sidebar.switchProject': 'Switch Project (Cmd+1~9)',

  // --- TabBar ---
  'tab.unsaved': 'Unsaved changes',
  'tab.close': 'Close tab',

  // --- StatusBar ---
  'status.words': { one: '{count} word', other: '{count} words' },
  'status.goalProgress': '{percent}% of {goal}',
  'status.lineCol': 'Ln {line}, Col {col}',

  // --- Outline ---
  'outline.title': 'OUTLINE',
  'outline.empty': 'No headings found',

  // --- Draft ---
  'draft.title': 'DRAFT',
  'draft.placeholder': 'Draft notes for this file...',

  // --- Zen Mode ---
  'zen.words': '{count} words',
  'zen.exit': 'Exit Zen Mode (Esc)',

  // --- Error ---
  'error.title': 'Something went wrong',
  'error.message': 'The editor encountered an unexpected error.',
  'error.tryAgain': 'Try Again',
  'error.reload': 'Reload',

  // --- Conflict Dialog ---
  'conflict.title': 'External Change Detected',
  'conflict.message': 'File {fileName} was changed externally. You have unsaved changes. What would you like to do?',
  'conflict.keepMine': 'Keep Mine',
  'conflict.loadTheirs': 'Load Theirs',

  // --- Command Palette ---
  'palette.placeholder': 'Type a command...',

  // --- Project Search ---
  'search.title': 'PROJECT SEARCH',
  'search.close': 'Close (Escape)',
  'search.placeholder': 'Search in project...',
  'search.searching': 'Searching...',
  'search.noResults': 'No results found',
  'search.showingFirst200': 'Showing first 200 matches',

  // --- Snapshot ---
  'snapshot.title': 'SNAPS',
  'snapshot.namePlaceholder': 'Snapshot name...',
  'snapshot.create': 'Create',
  'snapshot.empty': 'No snapshots yet',
  'snapshot.restore': 'Restore',
  'snapshot.delete': 'Delete',
  'snapshot.restoreConfirm': 'Restore will overwrite current files. Continue?',
  'snapshot.yesRestore': 'Yes, Restore',
  'snapshot.cancel': 'Cancel',

  // --- Stats ---
  'stats.title': 'STATS',
  'stats.loading': 'Loading...',
  'stats.today': 'Today',
  'stats.words': 'words',
  'stats.last7Days': 'Last 7 Days',
  'stats.projectTotal': 'Project Total',
  'stats.chapters': 'Chapters',
  'stats.streak': '{days}-day streak',
  'stats.goalProgress': '{percent}% of {goal} goal',
  'stats.day.0': 'Sun',
  'stats.day.1': 'Mon',
  'stats.day.2': 'Tue',
  'stats.day.3': 'Wed',
  'stats.day.4': 'Thu',
  'stats.day.5': 'Fri',
  'stats.day.6': 'Sat',

  // --- Mindmap ---
  'mindmap.title': 'MAP',
  'mindmap.fitToView': 'Fit to view',

  // --- Export ---
  'export.title': 'Export Project',
  'export.pandocAvailable': 'Pandoc available',
  'export.pandocNotFound': 'Pandoc not found',
  'export.pandocInstall': 'Install pandoc from pandoc.org/installing to enable export.',
  'export.format': 'Export format',
  'export.includeTheme': 'Include current theme styling',
  'export.exporting': { one: 'Exporting {count} file...', other: 'Exporting {count} files...' },
  'export.noFiles': 'No markdown files to export',
  'export.close': 'Close',
  'export.export': 'Export',
  'export.exportingButton': 'Exporting...',

  // --- Editor ---
  'editor.readOnly': 'Read-only — file is {size}MB. Use "Split into Chunks" to edit in smaller files.',
  'editor.splitChunks': 'Split into Chunks',
  'editor.splitResult': 'Split into {count} files in {name}-chunks/',

  // --- Unsaved changes ---
  'dialog.unsavedChanges': 'Unsaved Changes',
  'dialog.unsavedInFiles': 'You have unsaved changes in: {names}\n\nClick "OK" to save, or "Cancel" to discard changes.',
  'dialog.unsavedBeforeClose': 'You have unsaved changes in: {names}\n\nSave before closing?',
  'dialog.save': 'Save',
  'dialog.dontSave': "Don't Save",

  // --- Go to line ---
  'gotoline.prompt': 'Go to line:',

  // --- Commands ---
  'command.newWindow': 'New Window',
  'command.toggleSidebar': 'Toggle Sidebar',
  'command.toggleOutline': 'Toggle Outline',
  'command.toggleZen': 'Toggle Zen Mode',
  'command.toggleDraft': 'Toggle Draft Note',
  'command.toggleSnapshot': 'Toggle Snapshots',
  'command.toggleStats': 'Toggle Writing Stats',
  'command.toggleMindmap': 'Toggle Mindmap',
  'command.commandPalette': 'Command Palette',
  'command.projectSearch': 'Search in Project',
  'command.toggleSplit': 'Toggle Split View',
  'command.newFile': 'New File',
  'command.exportProject': 'Export Project',
  'command.closeTab': 'Close Tab',
  'command.openSettings': 'Open Settings',
  'command.goToLine': 'Go to Line',
  'command.bold': 'Bold',
  'command.italic': 'Italic',
  'command.insertLink': 'Insert Link',
  'command.toggleHeading': 'Toggle Heading',
  'command.inlineCode': 'Inline Code',
  'command.strikethrough': 'Strikethrough',
  'command.runBenchmark': 'Run Performance Benchmark (150K lines)',
  'command.runScrollTest': 'Run Scroll+Edit Stability Test',

  // --- Settings ---
  'settings.editor': 'Editor',
  'settings.theme': 'Theme',
  'settings.shortcuts': 'Shortcuts',
  'settings.plugins': 'Plugins',
  'settings.sync': 'Sync',
  'settings.close': 'Close (Esc)',
  'settings.language': 'Language',

  'settings.font': 'Font',
  'settings.size': 'Size',
  'settings.lineHeight': 'Line Height',
  'settings.width': 'Width',
  'settings.autoSave': 'Auto-save',
  'settings.tabIndent': 'Tab / Indent',

  'settings.autoSave.off': 'Off',
  'settings.autoSave.1min': '1 min',
  'settings.autoSave.2min': '2 min',
  'settings.autoSave.5min': '5 min (Default)',
  'settings.autoSave.10min': '10 min',

  'settings.indent.2spaces': '2 Spaces',
  'settings.indent.4spaces': '4 Spaces (Default)',
  'settings.indent.8spaces': '8 Spaces',
  'settings.indent.tab': 'Tab Character',

  'settings.theme.system': 'System (Auto)',
  'settings.theme.dark': 'Dark',
  'settings.theme.light': 'Light',
  'settings.theme.importTypora': 'Import Typora Theme (.css)',
  'settings.theme.importHint': 'colors are auto-mapped',
  'settings.theme.forCustom': 'for custom themes',

  'settings.shortcuts.application': 'Application',
  'settings.shortcuts.editorFormatting': 'Editor Formatting',
  'settings.shortcuts.pressKeys': 'Press keys...',
  'settings.shortcuts.clickToChange': 'Click to change shortcut',
  'settings.shortcuts.resetToDefault': 'Reset to default',
  'settings.shortcuts.reset': 'reset',
  'settings.shortcuts.resetAll': 'Reset All to Defaults',
  'settings.shortcuts.hint': 'Click a shortcut badge to record a new key combination. Press Esc to cancel recording.',

  'settings.plugins.noPlugins': 'No plugins installed.',
  'settings.plugins.createPlugin': 'Create a plugin',
  'settings.plugins.pluginPath': 'Plugins live in ~/.novelist/plugins/<id>/',
  'settings.plugins.pluginNeeds': 'Each plugin needs:',
  'settings.plugins.manifest': 'manifest.toml — metadata & permissions',
  'settings.plugins.indexJs': 'index.js — plugin code',
  'settings.plugins.aiSuggestion': 'Use Claude Code: "Create a Novelist plugin that counts sentences"',
  'settings.plugins.active': 'Active',
  'settings.plugins.enable': 'Enable',
  'settings.plugins.loading': 'Loading...',

  'settings.sync.webdav': 'WebDAV Sync',
  'settings.sync.openProject': 'Open a project to configure sync.',
  'settings.sync.enabled': 'Enabled',
  'settings.sync.on': 'On',
  'settings.sync.off': 'Off',
  'settings.sync.url': 'WebDAV URL',
  'settings.sync.username': 'Username',
  'settings.sync.password': 'Password',
  'settings.sync.interval': 'Interval',
  'settings.sync.15min': '15 min',
  'settings.sync.30min': '30 min (Default)',
  'settings.sync.60min': '60 min',
  'settings.sync.120min': '120 min',
  'settings.sync.testConnection': 'Test Connection',
  'settings.sync.testing': 'Testing...',
  'settings.sync.syncNow': 'Sync Now',
  'settings.sync.syncing': 'Syncing...',
  'settings.sync.connectionSuccess': 'Connection successful.',
  'settings.sync.connectionFailed': 'Connection failed. Check URL and credentials.',
  'settings.sync.lastSync': 'Last sync: {time}',
  'settings.sync.syncPath': 'Files are synced to <webdav-url>/novelist/<project-name>/.',
};
