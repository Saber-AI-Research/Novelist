<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { builtinThemes, loadCustomThemes, addCustomTheme, removeCustomTheme } from '$lib/themes';
  import { commands } from '$lib/ipc/commands';
  import { shortcutsStore, editorCommandIds } from '$lib/stores/shortcuts.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { convertTyporaTheme } from '$lib/utils/typora-theme';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let activeSection = $state<'editor' | 'theme' | 'shortcuts' | 'plugins' | 'sync'>('editor');

  // Editor settings
  const fontOptions = [
    { label: 'LXGW WenKai', value: '"LXGW WenKai", "Noto Serif SC", Georgia, serif' },
    { label: 'Noto Serif SC', value: '"Noto Serif SC", Georgia, serif' },
    { label: 'System Serif', value: 'Georgia, "Times New Roman", serif' },
    { label: 'System Sans', value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
    { label: 'Source Han Serif', value: '"Source Han Serif SC", "Noto Serif SC", Georgia, serif' },
    { label: 'PingFang SC', value: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif' },
  ];
  const fontSizeOptions = [13, 14, 15, 16, 17, 18, 20, 22, 24];
  const lineHeightOptions = [1.4, 1.5, 1.6, 1.8, 2.0, 2.2];
  const maxWidthOptions = [
    { label: '600px (Narrow)', value: 600 },
    { label: '680px', value: 680 },
    { label: '720px (Default)', value: 720 },
    { label: '800px', value: 800 },
    { label: '900px (Wide)', value: 900 },
    { label: '100% (Full)', value: 9999 },
  ];

  let settings = $derived(uiStore.editorSettings);

  // Theme options: system + builtins + custom (imported)
  let customThemes = $state(loadCustomThemes());
  let themeOptions = $derived([
    { id: 'system', name: 'System (Auto)', dark: false },
    ...builtinThemes,
    ...customThemes,
  ]);

  async function importTyporaTheme() {
    const selected = await openDialog({
      filters: [{ name: 'CSS Theme', extensions: ['css'] }],
      multiple: false,
    });
    if (!selected) return;
    const filePath = selected as string;
    const result = await commands.readFile(filePath);
    if (result.status !== 'ok') return;
    const css = result.data;
    // Derive name from filename
    const fileName = filePath.split('/').pop()?.replace(/\.css$/i, '') || 'Imported';
    const theme = convertTyporaTheme(css, fileName);
    addCustomTheme(theme);
    customThemes = loadCustomThemes();
    uiStore.setTheme(theme.id);
  }

  function deleteCustomTheme(id: string) {
    removeCustomTheme(id);
    customThemes = loadCustomThemes();
    // If the deleted theme was active, switch to system
    if (uiStore.themeId === id) uiStore.setTheme('system');
  }

  // Plugins
  type PluginInfo = { id: string; name: string; version: string; permissions: string[]; active: boolean };
  let plugins = $state<PluginInfo[]>([]);
  let pluginsLoaded = $state(false);

  async function loadPlugins() {
    const result = await commands.listPlugins();
    if (result.status === 'ok') {
      plugins = result.data;
    }
    pluginsLoaded = true;
  }

  async function togglePlugin(plugin: PluginInfo) {
    if (plugin.active) {
      await commands.unloadPlugin(plugin.id);
    } else {
      await commands.loadPlugin(plugin.id);
    }
    await loadPlugins();
  }

  // Sync settings
  type SyncConfig = {
    enabled: boolean;
    webdav_url: string;
    username: string;
    password: string;
    interval_minutes: number;
  };
  let syncConfig = $state<SyncConfig>({
    enabled: false,
    webdav_url: '',
    username: '',
    password: '',
    interval_minutes: 30,
  });
  let syncLoaded = $state(false);
  let syncTestResult = $state<'idle' | 'testing' | 'success' | 'fail'>('idle');
  let syncInProgress = $state(false);
  let lastSyncTime = $state<string | null>(null);
  let syncErrors = $state<string[]>([]);

  async function loadSyncConfig() {
    if (!projectStore.dirPath) return;
    try {
      const config = await invoke('get_sync_config', { projectDir: projectStore.dirPath }) as SyncConfig;
      syncConfig = config;
    } catch (e) {
      console.error('Failed to load sync config:', e);
    }
    syncLoaded = true;
  }

  async function saveSyncConfig() {
    if (!projectStore.dirPath) return;
    try {
      await invoke('save_sync_config', { projectDir: projectStore.dirPath, config: syncConfig });
    } catch (e) {
      console.error('Failed to save sync config:', e);
    }
  }

  async function testConnection() {
    syncTestResult = 'testing';
    try {
      const ok = await invoke('test_sync_connection', {
        webdavUrl: syncConfig.webdav_url,
        username: syncConfig.username,
        password: syncConfig.password,
      }) as boolean;
      syncTestResult = ok ? 'success' : 'fail';
    } catch (e) {
      syncTestResult = 'fail';
    }
  }

  async function syncNow() {
    if (!projectStore.dirPath) return;
    syncInProgress = true;
    syncErrors = [];
    try {
      const status = await invoke('sync_now', { projectDir: projectStore.dirPath }) as {
        last_sync: string | null;
        files_uploaded: number;
        files_downloaded: number;
        errors: string[];
        in_progress: boolean;
      };
      lastSyncTime = status.last_sync;
      syncErrors = status.errors;
    } catch (e) {
      syncErrors = [String(e)];
    }
    syncInProgress = false;
  }

  // Shortcut recording state
  let recordingCommandId = $state<string | null>(null);

  function startRecording(commandId: string) {
    recordingCommandId = commandId;
  }

  function buildShortcutString(e: KeyboardEvent): string | null {
    // Ignore bare modifier keys
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null;

    const parts: string[] = [];
    if (e.metaKey || e.ctrlKey) parts.push('Cmd');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    // Normalize the key
    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();
    // Function keys and special keys stay as-is (F11, Escape, etc.)

    parts.push(key);
    return parts.join('+');
  }

  function handleKeydown(e: KeyboardEvent) {
    if (recordingCommandId) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        // Cancel recording
        recordingCommandId = null;
        return;
      }
      const shortcut = buildShortcutString(e);
      if (shortcut) {
        shortcutsStore.set(recordingCommandId, shortcut);
        recordingCommandId = null;
      }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  }

  $effect(() => {
    if (activeSection === 'plugins' && !pluginsLoaded) {
      loadPlugins();
    }
  });

  $effect(() => {
    if (activeSection === 'sync' && !syncLoaded) {
      loadSyncConfig();
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-50 flex items-center justify-center" style="background: rgba(0,0,0,0.4);" onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="rounded-lg shadow-xl w-full flex"
    style="max-width: 650px; background: var(--novelist-bg); color: var(--novelist-text); border: 1px solid var(--novelist-border); height: 520px;"
    onclick={(e) => e.stopPropagation()}
  >
    <!-- Left nav -->
    <div class="shrink-0 flex flex-col py-3" style="width: 140px; border-right: 1px solid var(--novelist-border); background: var(--novelist-bg-secondary); border-radius: 8px 0 0 8px;">
      {#each [
        { id: 'editor', label: 'Editor' },
        { id: 'theme', label: 'Theme' },
        { id: 'shortcuts', label: 'Shortcuts' },
        { id: 'plugins', label: 'Plugins' },
        { id: 'sync', label: 'Sync' },
      ] as section}
        <button
          class="text-left px-4 py-2 text-sm cursor-pointer"
          style="background: {activeSection === section.id ? 'var(--novelist-sidebar-active)' : 'transparent'}; color: {activeSection === section.id ? 'var(--novelist-accent)' : 'var(--novelist-text)'}; border: none; font-weight: {activeSection === section.id ? '600' : '400'};"
          onclick={() => activeSection = section.id as any}
        >{section.label}</button>
      {/each}

      <div class="flex-1"></div>
      <button
        class="text-xs px-4 py-2 cursor-pointer"
        style="color: var(--novelist-text-secondary); background: none; border: none;"
        onclick={onClose}
      >Close (Esc)</button>
    </div>

    <!-- Right content -->
    <div class="flex-1 overflow-y-auto px-5 py-4">

      {#if activeSection === 'editor'}
        <h3 class="text-xs font-semibold uppercase tracking-wide mb-4" style="color: var(--novelist-text-secondary);">Editor</h3>

        <div class="flex items-center justify-between mb-3">
          <label for="settings-font" class="text-sm">Font</label>
          <select id="settings-font" class="text-sm px-2 py-1 rounded cursor-pointer" style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border); max-width: 180px;" value={settings.fontFamily} onchange={(e) => uiStore.updateEditorSettings({ fontFamily: (e.target as HTMLSelectElement).value })}>
            {#each fontOptions as opt}<option value={opt.value}>{opt.label}</option>{/each}
          </select>
        </div>

        <div class="flex items-center justify-between mb-3">
          <label for="settings-size" class="text-sm">Size</label>
          <select id="settings-size" class="text-sm px-2 py-1 rounded cursor-pointer" style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);" value={settings.fontSize} onchange={(e) => uiStore.updateEditorSettings({ fontSize: Number((e.target as HTMLSelectElement).value) })}>
            {#each fontSizeOptions as size}<option value={size}>{size}px</option>{/each}
          </select>
        </div>

        <div class="flex items-center justify-between mb-3">
          <label for="settings-line-height" class="text-sm">Line Height</label>
          <select id="settings-line-height" class="text-sm px-2 py-1 rounded cursor-pointer" style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);" value={settings.lineHeight} onchange={(e) => uiStore.updateEditorSettings({ lineHeight: Number((e.target as HTMLSelectElement).value) })}>
            {#each lineHeightOptions as lh}<option value={lh}>{lh}</option>{/each}
          </select>
        </div>

        <div class="flex items-center justify-between mb-3">
          <label for="settings-width" class="text-sm">Width</label>
          <select id="settings-width" class="text-sm px-2 py-1 rounded cursor-pointer" style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);" value={settings.maxWidth} onchange={(e) => uiStore.updateEditorSettings({ maxWidth: Number((e.target as HTMLSelectElement).value) })}>
            {#each maxWidthOptions as opt}<option value={opt.value}>{opt.label}</option>{/each}
          </select>
        </div>

        <div class="flex items-center justify-between mb-3">
          <label for="settings-autosave" class="text-sm">Auto-save</label>
          <select id="settings-autosave" class="text-sm px-2 py-1 rounded cursor-pointer" style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);" value={settings.autoSaveMinutes} onchange={(e) => uiStore.updateEditorSettings({ autoSaveMinutes: Number((e.target as HTMLSelectElement).value) })}>
            <option value={0}>Off</option>
            <option value={1}>1 min</option>
            <option value={2}>2 min</option>
            <option value={5}>5 min (Default)</option>
            <option value={10}>10 min</option>
          </select>
        </div>

        <div class="flex items-center justify-between mb-3">
          <label for="settings-indent" class="text-sm">Tab / Indent</label>
          <select id="settings-indent" class="text-sm px-2 py-1 rounded cursor-pointer" style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);" value={settings.indentStyle} onchange={(e) => { const v = (e.target as HTMLSelectElement).value; uiStore.updateEditorSettings({ indentStyle: v === 'tab' ? 'tab' : Number(v) }); }}>
            <option value={2}>2 Spaces</option>
            <option value={4}>4 Spaces (Default)</option>
            <option value={8}>8 Spaces</option>
            <option value="tab">Tab Character</option>
          </select>
        </div>

        <div class="mt-4 rounded p-3 text-sm" style="background: var(--novelist-bg-secondary); font-family: {settings.fontFamily}; font-size: {settings.fontSize}px; line-height: {settings.lineHeight}; border: 1px solid var(--novelist-border);">
          The quick brown fox jumps over the lazy dog.<br/>
          落霞与孤鹜齐飞，秋水共长天一色。
        </div>

      {:else if activeSection === 'theme'}
        <h3 class="text-xs font-semibold uppercase tracking-wide mb-4" style="color: var(--novelist-text-secondary);">Theme</h3>

        <div class="grid grid-cols-2 gap-2">
          {#each themeOptions as theme}
            <div class="relative">
              <button
                class="rounded-lg p-3 text-left cursor-pointer w-full"
                style="
                  border: 2px solid {uiStore.themeId === theme.id ? 'var(--novelist-accent)' : 'var(--novelist-border)'};
                  background: {theme.id === 'system' ? 'var(--novelist-bg-secondary)' : theme.dark ? '#1e1e1e' : '#f8f8f8'};
                  color: {theme.id === 'system' ? 'var(--novelist-text)' : theme.dark ? '#d4d4d4' : '#2c2c2c'};
                "
                onclick={() => uiStore.setTheme(theme.id)}
              >
                <div class="text-sm font-medium mb-1">{theme.name}</div>
                <div class="text-xs" style="opacity: 0.6">{theme.id === 'system' ? 'Follow OS' : theme.dark ? 'Dark' : 'Light'}</div>
              </button>
              {#if theme.id.startsWith('typora-')}
                <button
                  class="absolute top-1 right-1 rounded-full cursor-pointer"
                  style="width: 18px; height: 18px; font-size: 10px; line-height: 1; background: rgba(255,0,0,0.15); color: #e55; border: none; display: flex; align-items: center; justify-content: center;"
                  onclick={(e) => { e.stopPropagation(); deleteCustomTheme(theme.id); }}
                  title="Delete imported theme"
                >&times;</button>
              {/if}
            </div>
          {/each}
        </div>

        <div class="mt-3">
          <button
            class="text-sm px-3 py-1.5 rounded cursor-pointer w-full"
            style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
            onclick={importTyporaTheme}
          >Import Typora Theme (.css)</button>
        </div>

        <div class="mt-4 text-xs" style="color: var(--novelist-text-secondary);">
          Import <code style="background: var(--novelist-code-bg); padding: 1px 4px; border-radius: 3px;">.css</code> themes from Typora — colors are auto-mapped. Or edit <code style="background: var(--novelist-code-bg); padding: 1px 4px; border-radius: 3px;">src/lib/themes.ts</code> for custom themes.
        </div>

      {:else if activeSection === 'shortcuts'}
        <h3 class="text-xs font-semibold uppercase tracking-wide mb-4" style="color: var(--novelist-text-secondary);">Keyboard Shortcuts</h3>

        <!-- App shortcuts -->
        <div class="mb-4">
          <div class="text-xs font-semibold mb-2" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary)); text-transform: uppercase; letter-spacing: 0.05em;">Application</div>
          <div class="space-y-1">
            {#each shortcutsStore.appCommandIds as cmdId}
              {@const currentShortcut = shortcutsStore.get(cmdId)}
              {@const isCustom = shortcutsStore.isCustomized(cmdId)}
              {@const isRecording = recordingCommandId === cmdId}
              <div class="flex items-center justify-between py-2 px-2 rounded" style="background: {isRecording ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'};">
                <span class="text-sm" style="color: var(--novelist-text);">{shortcutsStore.labels[cmdId]}</span>
                <div class="flex items-center gap-2">
                  {#if isRecording}
                    <span class="text-xs px-2 py-1 rounded" style="background: var(--novelist-accent); color: #fff; animation: pulse 1s infinite;">Press keys...</span>
                  {:else}
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <span
                      class="text-xs px-2 py-1 rounded cursor-pointer"
                      style="background: rgba(255, 255, 255, 0.08); color: {isCustom ? 'var(--novelist-accent)' : 'var(--novelist-text-secondary)'}; font-family: monospace; border: 1px solid {isCustom ? 'var(--novelist-accent)' : 'transparent'};"
                      onclick={() => startRecording(cmdId)}
                      title="Click to change shortcut"
                    >{currentShortcut || '—'}</span>
                  {/if}
                  {#if isCustom && !isRecording}
                    <button
                      class="text-xs px-1 py-0.5 rounded cursor-pointer"
                      style="background: none; border: 1px solid var(--novelist-border); color: var(--novelist-text-secondary); font-size: 10px;"
                      onclick={() => shortcutsStore.reset(cmdId)}
                      title="Reset to default"
                    >reset</button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>

        <!-- Editor shortcuts -->
        <div class="mb-4">
          <div class="text-xs font-semibold mb-2" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary)); text-transform: uppercase; letter-spacing: 0.05em;">Editor Formatting</div>
          <div class="space-y-1">
            {#each editorCommandIds as cmdId}
              {@const currentShortcut = shortcutsStore.get(cmdId)}
              {@const isCustom = shortcutsStore.isCustomized(cmdId)}
              {@const isRecording = recordingCommandId === cmdId}
              <div class="flex items-center justify-between py-2 px-2 rounded" style="background: {isRecording ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'};">
                <span class="text-sm" style="color: var(--novelist-text);">{shortcutsStore.labels[cmdId]}</span>
                <div class="flex items-center gap-2">
                  {#if isRecording}
                    <span class="text-xs px-2 py-1 rounded" style="background: var(--novelist-accent); color: #fff; animation: pulse 1s infinite;">Press keys...</span>
                  {:else}
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <span
                      class="text-xs px-2 py-1 rounded cursor-pointer"
                      style="background: rgba(255, 255, 255, 0.08); color: {isCustom ? 'var(--novelist-accent)' : 'var(--novelist-text-secondary)'}; font-family: monospace; border: 1px solid {isCustom ? 'var(--novelist-accent)' : 'transparent'};"
                      onclick={() => startRecording(cmdId)}
                      title="Click to change shortcut"
                    >{currentShortcut || '—'}</span>
                  {/if}
                  {#if isCustom && !isRecording}
                    <button
                      class="text-xs px-1 py-0.5 rounded cursor-pointer"
                      style="background: none; border: 1px solid var(--novelist-border); color: var(--novelist-text-secondary); font-size: 10px;"
                      onclick={() => shortcutsStore.reset(cmdId)}
                      title="Reset to default"
                    >reset</button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>

        <div class="mt-4 flex justify-end">
          <button
            class="text-xs px-3 py-1.5 rounded cursor-pointer"
            style="background: var(--novelist-bg-secondary); color: var(--novelist-text-secondary); border: 1px solid var(--novelist-border);"
            onclick={() => shortcutsStore.resetAll()}
          >Reset All to Defaults</button>
        </div>

        <div class="mt-3 text-xs" style="color: var(--novelist-text-secondary);">
          Click a shortcut badge to record a new key combination. Press <kbd style="background: var(--novelist-code-bg); padding: 1px 4px; border-radius: 3px;">Esc</kbd> to cancel recording.
        </div>

      {:else if activeSection === 'plugins'}
        <h3 class="text-xs font-semibold uppercase tracking-wide mb-4" style="color: var(--novelist-text-secondary);">Plugins</h3>

        {#if !pluginsLoaded}
          <p class="text-sm" style="color: var(--novelist-text-secondary);">Loading...</p>
        {:else if plugins.length === 0}
          <div class="text-sm" style="color: var(--novelist-text-secondary);">
            <p class="mb-3">No plugins installed.</p>
            <div class="rounded p-3" style="background: var(--novelist-bg-secondary); border: 1px solid var(--novelist-border);">
              <p class="font-medium mb-2">Create a plugin</p>
              <p class="text-xs mb-2">Plugins live in <code style="background: var(--novelist-code-bg); padding: 1px 4px; border-radius: 3px;">~/.novelist/plugins/&lt;id&gt;/</code></p>
              <p class="text-xs mb-1">Each plugin needs:</p>
              <ul class="text-xs list-disc pl-4 space-y-1">
                <li><code style="background: var(--novelist-code-bg); padding: 1px 4px; border-radius: 3px;">manifest.toml</code> — metadata &amp; permissions</li>
                <li><code style="background: var(--novelist-code-bg); padding: 1px 4px; border-radius: 3px;">index.js</code> — plugin code</li>
              </ul>
              <p class="text-xs mt-2">Use Claude Code: <em>"Create a Novelist plugin that counts sentences"</em></p>
            </div>
          </div>
        {:else}
          <div class="space-y-2">
            {#each plugins as plugin}
              <div class="flex items-center justify-between rounded p-3" style="background: var(--novelist-bg-secondary); border: 1px solid var(--novelist-border);">
                <div>
                  <div class="text-sm font-medium">{plugin.name}</div>
                  <div class="text-xs" style="color: var(--novelist-text-secondary);">
                    {plugin.id} v{plugin.version}
                    {#if plugin.permissions.length > 0}
                      &middot; {plugin.permissions.join(', ')}
                    {/if}
                  </div>
                </div>
                <button
                  class="text-xs px-3 py-1 rounded cursor-pointer"
                  style="background: {plugin.active ? 'var(--novelist-accent)' : 'var(--novelist-bg-tertiary)'}; color: {plugin.active ? '#fff' : 'var(--novelist-text)'}; border: none;"
                  onclick={() => togglePlugin(plugin)}
                >{plugin.active ? 'Active' : 'Enable'}</button>
              </div>
            {/each}
          </div>
        {/if}
      {:else if activeSection === 'sync'}
        <h3 class="text-xs font-semibold uppercase tracking-wide mb-4" style="color: var(--novelist-text-secondary);">WebDAV Sync</h3>

        {#if !projectStore.dirPath}
          <p class="text-sm" style="color: var(--novelist-text-secondary);">Open a project to configure sync.</p>
        {:else if !syncLoaded}
          <p class="text-sm" style="color: var(--novelist-text-secondary);">Loading...</p>
        {:else}
          <div class="flex items-center justify-between mb-3">
            <label for="sync-enabled" class="text-sm">Enabled</label>
            <button
              id="sync-enabled"
              class="text-xs px-3 py-1 rounded cursor-pointer"
              style="background: {syncConfig.enabled ? 'var(--novelist-accent)' : 'var(--novelist-bg-tertiary, var(--novelist-bg-secondary))'}; color: {syncConfig.enabled ? '#fff' : 'var(--novelist-text)'}; border: none;"
              onclick={() => { syncConfig.enabled = !syncConfig.enabled; saveSyncConfig(); }}
            >{syncConfig.enabled ? 'On' : 'Off'}</button>
          </div>

          <div class="mb-3">
            <label for="sync-webdav-url" class="text-sm block mb-1">WebDAV URL</label>
            <input
              id="sync-webdav-url"
              type="text"
              class="text-sm px-2 py-1 rounded w-full"
              style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
              placeholder="https://dav.example.com"
              value={syncConfig.webdav_url}
              oninput={(e) => { syncConfig.webdav_url = (e.target as HTMLInputElement).value; }}
              onblur={saveSyncConfig}
            />
          </div>

          <div class="mb-3">
            <label for="sync-username" class="text-sm block mb-1">Username</label>
            <input
              id="sync-username"
              type="text"
              class="text-sm px-2 py-1 rounded w-full"
              style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
              value={syncConfig.username}
              oninput={(e) => { syncConfig.username = (e.target as HTMLInputElement).value; }}
              onblur={saveSyncConfig}
            />
          </div>

          <div class="mb-3">
            <label for="sync-password" class="text-sm block mb-1">Password</label>
            <input
              id="sync-password"
              type="password"
              class="text-sm px-2 py-1 rounded w-full"
              style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
              value={syncConfig.password}
              oninput={(e) => { syncConfig.password = (e.target as HTMLInputElement).value; }}
              onblur={saveSyncConfig}
            />
          </div>

          <div class="flex items-center justify-between mb-3">
            <label for="sync-interval" class="text-sm">Interval</label>
            <select
              id="sync-interval"
              class="text-sm px-2 py-1 rounded cursor-pointer"
              style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
              value={syncConfig.interval_minutes}
              onchange={(e) => { syncConfig.interval_minutes = Number((e.target as HTMLSelectElement).value); saveSyncConfig(); }}
            >
              <option value={15}>15 min</option>
              <option value={30}>30 min (Default)</option>
              <option value={60}>60 min</option>
              <option value={120}>120 min</option>
            </select>
          </div>

          <div class="flex gap-2 mb-3">
            <button
              class="text-xs px-3 py-1.5 rounded cursor-pointer"
              style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
              onclick={testConnection}
              disabled={syncTestResult === 'testing'}
            >{syncTestResult === 'testing' ? 'Testing...' : 'Test Connection'}</button>
            <button
              class="text-xs px-3 py-1.5 rounded cursor-pointer"
              style="background: var(--novelist-accent); color: #fff; border: none;"
              onclick={syncNow}
              disabled={syncInProgress}
            >{syncInProgress ? 'Syncing...' : 'Sync Now'}</button>
          </div>

          {#if syncTestResult === 'success'}
            <div class="text-xs mb-2" style="color: #22c55e;">Connection successful.</div>
          {:else if syncTestResult === 'fail'}
            <div class="text-xs mb-2" style="color: #ef4444;">Connection failed. Check URL and credentials.</div>
          {/if}

          {#if lastSyncTime}
            <div class="text-xs mb-2" style="color: var(--novelist-text-secondary);">Last sync: {lastSyncTime}</div>
          {/if}

          {#if syncErrors.length > 0}
            <div class="rounded p-2 mb-2 text-xs" style="background: color-mix(in srgb, #ef4444 10%, transparent); color: #ef4444; border: 1px solid #ef4444;">
              {#each syncErrors as err}
                <div>{err}</div>
              {/each}
            </div>
          {/if}

          <div class="mt-3 text-xs" style="color: var(--novelist-text-secondary);">
            Files are synced to <code style="background: var(--novelist-code-bg); padding: 1px 4px; border-radius: 3px;">{"<webdav-url>/novelist/<project-name>/"}</code>. Only .md, .markdown, and .txt files are synced.
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>
