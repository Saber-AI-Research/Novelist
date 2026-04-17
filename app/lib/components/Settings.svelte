<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { builtinThemes, loadCustomThemes, addCustomTheme, removeCustomTheme } from '$lib/themes';
  import { commands } from '$lib/ipc/commands';
  import { shortcutsStore, editorCommandIds } from '$lib/stores/shortcuts.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { convertTyporaTheme } from '$lib/utils/typora-theme';
  import { t, i18n } from '$lib/i18n';
  import type { Locale } from '$lib/i18n';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let activeSection = $state<'editor' | 'theme' | 'shortcuts' | 'templates' | 'plugins' | 'sync'>('editor');

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

  // Templates
  import type { TemplateInfo } from '$lib/ipc/commands';
  let userTemplates = $state<TemplateInfo[]>([]);
  let templatesLoaded = $state(false);
  let savingTemplate = $state(false);
  let saveTemplateName = $state('');
  let templateError = $state('');

  async function loadUserTemplates() {
    const result = await commands.listTemplates();
    if (result.status === 'ok') {
      userTemplates = result.data.filter(t => !t.builtin);
    }
    templatesLoaded = true;
  }

  async function handleDeleteTemplate(id: string) {
    await commands.deleteTemplate(id);
    await loadUserTemplates();
  }

  async function handleSaveAsTemplate() {
    if (!projectStore.dirPath || !saveTemplateName.trim()) return;
    savingTemplate = true;
    templateError = '';
    const result = await commands.saveProjectAsTemplate(projectStore.dirPath, saveTemplateName.trim());
    if (result.status === 'ok') {
      saveTemplateName = '';
      await loadUserTemplates();
    } else {
      templateError = result.error;
    }
    savingTemplate = false;
  }

  async function handleImportTemplateZip() {
    const selected = await openDialog({
      filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
      multiple: false,
    });
    if (!selected) return;
    templateError = '';
    const result = await commands.importTemplateZip(selected as string);
    if (result.status === 'ok') {
      await loadUserTemplates();
    } else {
      templateError = result.error;
    }
  }

  // Plugins
  import type { PluginInfo } from '$lib/ipc/commands';
  let plugins = $state<PluginInfo[]>([]);
  let pluginsLoaded = $state(false);

  let builtinPlugins = $derived(plugins.filter(p => p.builtin));
  let communityPlugins = $derived(plugins.filter(p => !p.builtin));

  async function loadPlugins() {
    const result = await commands.listPlugins();
    if (result.status === 'ok') {
      plugins = result.data;
    }
    pluginsLoaded = true;
  }

  async function togglePluginEnabled(plugin: PluginInfo) {
    const newEnabled = !plugin.enabled;
    await commands.setPluginEnabled(plugin.id, newEnabled);
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
    if (activeSection === 'templates' && !templatesLoaded) {
      loadUserTemplates();
    }
  });

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

{#snippet pluginCard(plugin: PluginInfo)}
  <div class="rounded p-3" style="background: var(--novelist-bg-secondary); border: 1px solid var(--novelist-border);">
    <div class="flex items-center justify-between">
      <div class="flex-1 min-w-0 mr-3">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium">{plugin.name}</span>
          <span class="text-xs" style="color: var(--novelist-text-secondary);">v{plugin.version}</span>
          {#if plugin.builtin}
            <span class="text-xs px-1.5 py-0.5 rounded" style="background: color-mix(in srgb, var(--novelist-accent) 15%, transparent); color: var(--novelist-accent); font-size: 10px;">{t('settings.plugins.builtinBadge')}</span>
          {/if}
        </div>
        {#if plugin.description}
          <div class="text-xs mt-1" style="color: var(--novelist-text-secondary);">{plugin.description}</div>
        {/if}
        <div class="text-xs mt-1" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary)); opacity: 0.7;">
          {#if plugin.author}{plugin.author} &middot; {/if}{plugin.permissions.join(', ')}
        </div>
      </div>
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="shrink-0 w-10 h-5 rounded-full cursor-pointer relative transition-colors"
        style="background: {plugin.enabled ? 'var(--novelist-accent)' : 'var(--novelist-bg-tertiary, #555)'};"
        onclick={() => togglePluginEnabled(plugin)}
      >
        <div
          class="absolute top-0.5 w-4 h-4 rounded-full transition-transform"
          style="background: #fff; left: {plugin.enabled ? '22px' : '2px'}; box-shadow: 0 1px 2px rgba(0,0,0,0.2);"
        ></div>
      </div>
    </div>
  </div>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-50 flex items-center justify-center" data-testid="settings-overlay" style="background: rgba(0,0,0,0.4);" onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="rounded-lg shadow-xl w-full flex"
    data-testid="settings-dialog"
    style="max-width: 650px; background: var(--novelist-bg); color: var(--novelist-text); border: 1px solid var(--novelist-border); height: 520px;"
    onclick={(e) => e.stopPropagation()}
  >
    <!-- Left nav -->
    <div class="shrink-0 flex flex-col py-3" style="width: 140px; border-right: 1px solid var(--novelist-border); background: var(--novelist-bg-secondary); border-radius: 8px 0 0 8px;">
      {#each [
        { id: 'editor', label: t('settings.editor') },
        { id: 'theme', label: t('settings.theme') },
        { id: 'shortcuts', label: t('settings.shortcuts') },
        { id: 'templates', label: t('settings.templates') },
        { id: 'plugins', label: t('settings.plugins') },
        { id: 'sync', label: t('settings.sync') },
      ] as section}
        <button
          class="text-left px-4 py-2 text-sm cursor-pointer"
          data-testid="settings-section-{section.id}"
          style="background: {activeSection === section.id ? 'var(--novelist-sidebar-active)' : 'transparent'}; color: {activeSection === section.id ? 'var(--novelist-accent)' : 'var(--novelist-text)'}; border: none; font-weight: {activeSection === section.id ? '600' : '400'};"
          onclick={() => activeSection = section.id as any}
        >{section.label}</button>
      {/each}

      <div class="flex-1"></div>
      <button
        class="text-xs px-4 py-2 cursor-pointer"
        style="color: var(--novelist-text-secondary); background: none; border: none;"
        onclick={onClose}
      >{t('settings.close')}</button>
    </div>

    <!-- Right content -->
    <div class="flex-1 overflow-y-auto px-5 py-4">

      <div class="flex items-center justify-between mb-3">
        <label for="settings-language" class="text-sm" style="color: var(--novelist-text-secondary);">Language / 语言</label>
        <select
          id="settings-language"
          class="text-sm px-2 py-1 rounded cursor-pointer"
          style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
          value={i18n.locale}
          onchange={(e) => i18n.setLocale((e.target as HTMLSelectElement).value as Locale)}
        >
          {#each i18n.availableLocales as loc}
            <option value={loc.code}>{loc.nativeName}</option>
          {/each}
        </select>
      </div>

      {#if activeSection === 'editor'}
        <h3 class="text-xs font-semibold uppercase tracking-wide mb-4" style="color: var(--novelist-text-secondary);">{t('settings.editor')}</h3>

        <div class="flex items-center justify-between mb-3">
          <label for="settings-font" class="text-sm">{t('settings.font')}</label>
          <select id="settings-font" class="text-sm px-2 py-1 rounded cursor-pointer" style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border); max-width: 180px;" value={settings.fontFamily} onchange={(e) => uiStore.updateEditorSettings({ fontFamily: (e.target as HTMLSelectElement).value })}>
            {#each fontOptions as opt}<option value={opt.value}>{opt.label}</option>{/each}
          </select>
        </div>

        <div class="flex items-center justify-between mb-3">
          <label for="settings-size" class="text-sm">{t('settings.size')}</label>
          <select id="settings-size" class="text-sm px-2 py-1 rounded cursor-pointer" style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);" value={settings.fontSize} onchange={(e) => uiStore.updateEditorSettings({ fontSize: Number((e.target as HTMLSelectElement).value) })}>
            {#each fontSizeOptions as size}<option value={size}>{size}px</option>{/each}
          </select>
        </div>

        <div class="flex items-center justify-between mb-3">
          <label for="settings-line-height" class="text-sm">{t('settings.lineHeight')}</label>
          <select id="settings-line-height" class="text-sm px-2 py-1 rounded cursor-pointer" style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);" value={settings.lineHeight} onchange={(e) => uiStore.updateEditorSettings({ lineHeight: Number((e.target as HTMLSelectElement).value) })}>
            {#each lineHeightOptions as lh}<option value={lh}>{lh}</option>{/each}
          </select>
        </div>

        <div class="flex items-center justify-between mb-3">
          <label for="settings-width" class="text-sm">{t('settings.width')}</label>
          <select id="settings-width" class="text-sm px-2 py-1 rounded cursor-pointer" style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);" value={settings.maxWidth} onchange={(e) => uiStore.updateEditorSettings({ maxWidth: Number((e.target as HTMLSelectElement).value) })}>
            {#each maxWidthOptions as opt}<option value={opt.value}>{opt.label}</option>{/each}
          </select>
        </div>

        <div class="flex items-center justify-between mb-3">
          <label for="settings-autosave" class="text-sm">{t('settings.autoSave')}</label>
          <select id="settings-autosave" class="text-sm px-2 py-1 rounded cursor-pointer" style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);" value={settings.autoSaveMinutes} onchange={(e) => uiStore.updateEditorSettings({ autoSaveMinutes: Number((e.target as HTMLSelectElement).value) })}>
            <option value={0}>{t('settings.autoSave.off')}</option>
            <option value={1}>{t('settings.autoSave.1min')}</option>
            <option value={2}>{t('settings.autoSave.2min')}</option>
            <option value={5}>{t('settings.autoSave.5min')}</option>
            <option value={10}>{t('settings.autoSave.10min')}</option>
          </select>
        </div>

        <div class="flex items-center justify-between mb-3">
          <label for="settings-indent" class="text-sm">{t('settings.tabIndent')}</label>
          <select id="settings-indent" class="text-sm px-2 py-1 rounded cursor-pointer" style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);" value={settings.indentStyle} onchange={(e) => { const v = (e.target as HTMLSelectElement).value; uiStore.updateEditorSettings({ indentStyle: v === 'tab' ? 'tab' : Number(v) }); }}>
            <option value={2}>{t('settings.indent.2spaces')}</option>
            <option value={4}>{t('settings.indent.4spaces')}</option>
            <option value={8}>{t('settings.indent.8spaces')}</option>
            <option value="tab">{t('settings.indent.tab')}</option>
          </select>
        </div>

        <div class="flex items-center justify-between mb-3">
          <label for="settings-highlight" class="text-sm">{t('settings.highlightMatches')}</label>
          <button
            id="settings-highlight"
            class="text-xs px-3 py-1 rounded cursor-pointer"
            style="background: {settings.highlightMatches ? 'var(--novelist-accent)' : 'var(--novelist-bg-tertiary, var(--novelist-bg-secondary))'}; color: {settings.highlightMatches ? '#fff' : 'var(--novelist-text)'}; border: none;"
            onclick={() => uiStore.updateEditorSettings({ highlightMatches: !settings.highlightMatches })}
          >{settings.highlightMatches ? t('settings.on') : t('settings.off')}</button>
        </div>

        <div class="flex items-center justify-between mb-3">
          <label for="settings-render-images" class="text-sm">{t('settings.renderImages')}</label>
          <button
            id="settings-render-images"
            class="text-xs px-3 py-1 rounded cursor-pointer"
            style="background: {settings.renderImages ? 'var(--novelist-accent)' : 'var(--novelist-bg-tertiary, var(--novelist-bg-secondary))'}; color: {settings.renderImages ? '#fff' : 'var(--novelist-text)'}; border: none;"
            onclick={() => uiStore.updateEditorSettings({ renderImages: !settings.renderImages })}
          >{settings.renderImages ? t('settings.on') : t('settings.off')}</button>
        </div>

        <div class="mt-4 rounded p-3 text-sm" style="background: var(--novelist-bg-secondary); font-family: {settings.fontFamily}; font-size: {settings.fontSize}px; line-height: {settings.lineHeight}; border: 1px solid var(--novelist-border);">
          The quick brown fox jumps over the lazy dog.<br/>
          落霞与孤鹜齐飞，秋水共长天一色。
        </div>

      {:else if activeSection === 'theme'}
        <h3 class="text-xs font-semibold uppercase tracking-wide mb-4" style="color: var(--novelist-text-secondary);">{t('settings.theme')}</h3>

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
                <div class="text-xs" style="opacity: 0.6">{theme.id === 'system' ? t('settings.theme.system') : theme.dark ? t('settings.theme.dark') : t('settings.theme.light')}</div>
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
          >{t('settings.theme.importTypora')}</button>
        </div>

        <div class="mt-4 text-xs" style="color: var(--novelist-text-secondary);">
          {t('settings.theme.importHint')} <code style="background: var(--novelist-code-bg); padding: 1px 4px; border-radius: 3px;">src/lib/themes.ts</code> {t('settings.theme.forCustom')}
        </div>

      {:else if activeSection === 'shortcuts'}
        <h3 class="text-xs font-semibold uppercase tracking-wide mb-4" style="color: var(--novelist-text-secondary);">{t('settings.shortcuts')}</h3>

        <!-- App shortcuts -->
        <div class="mb-4">
          <div class="text-xs font-semibold mb-2" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary)); text-transform: uppercase; letter-spacing: 0.05em;">{t('settings.shortcuts.application')}</div>
          <div class="space-y-1">
            {#each shortcutsStore.appCommandIds as cmdId}
              {@const currentShortcut = shortcutsStore.get(cmdId)}
              {@const isCustom = shortcutsStore.isCustomized(cmdId)}
              {@const isRecording = recordingCommandId === cmdId}
              <div class="flex items-center justify-between py-2 px-2 rounded" style="background: {isRecording ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'};">
                <span class="text-sm" style="color: var(--novelist-text);">{shortcutsStore.labels[cmdId]}</span>
                <div class="flex items-center gap-2">
                  {#if isRecording}
                    <span class="text-xs px-2 py-1 rounded" style="background: var(--novelist-accent); color: #fff; animation: pulse 1s infinite;">{t('settings.shortcuts.pressKeys')}</span>
                  {:else}
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <span
                      class="text-xs px-2 py-1 rounded cursor-pointer"
                      style="background: rgba(255, 255, 255, 0.08); color: {isCustom ? 'var(--novelist-accent)' : 'var(--novelist-text-secondary)'}; font-family: monospace; border: 1px solid {isCustom ? 'var(--novelist-accent)' : 'transparent'};"
                      onclick={() => startRecording(cmdId)}
                      title={t('settings.shortcuts.clickToChange')}
                    >{currentShortcut || '—'}</span>
                  {/if}
                  {#if isCustom && !isRecording}
                    <button
                      class="text-xs px-1 py-0.5 rounded cursor-pointer"
                      style="background: none; border: 1px solid var(--novelist-border); color: var(--novelist-text-secondary); font-size: 10px;"
                      onclick={() => shortcutsStore.reset(cmdId)}
                      title={t('settings.shortcuts.resetToDefault')}
                    >{t('settings.shortcuts.reset')}</button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>

        <!-- Editor shortcuts -->
        <div class="mb-4">
          <div class="text-xs font-semibold mb-2" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary)); text-transform: uppercase; letter-spacing: 0.05em;">{t('settings.shortcuts.editorFormatting')}</div>
          <div class="space-y-1">
            {#each editorCommandIds as cmdId}
              {@const currentShortcut = shortcutsStore.get(cmdId)}
              {@const isCustom = shortcutsStore.isCustomized(cmdId)}
              {@const isRecording = recordingCommandId === cmdId}
              <div class="flex items-center justify-between py-2 px-2 rounded" style="background: {isRecording ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'};">
                <span class="text-sm" style="color: var(--novelist-text);">{shortcutsStore.labels[cmdId]}</span>
                <div class="flex items-center gap-2">
                  {#if isRecording}
                    <span class="text-xs px-2 py-1 rounded" style="background: var(--novelist-accent); color: #fff; animation: pulse 1s infinite;">{t('settings.shortcuts.pressKeys')}</span>
                  {:else}
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <span
                      class="text-xs px-2 py-1 rounded cursor-pointer"
                      style="background: rgba(255, 255, 255, 0.08); color: {isCustom ? 'var(--novelist-accent)' : 'var(--novelist-text-secondary)'}; font-family: monospace; border: 1px solid {isCustom ? 'var(--novelist-accent)' : 'transparent'};"
                      onclick={() => startRecording(cmdId)}
                      title={t('settings.shortcuts.clickToChange')}
                    >{currentShortcut || '—'}</span>
                  {/if}
                  {#if isCustom && !isRecording}
                    <button
                      class="text-xs px-1 py-0.5 rounded cursor-pointer"
                      style="background: none; border: 1px solid var(--novelist-border); color: var(--novelist-text-secondary); font-size: 10px;"
                      onclick={() => shortcutsStore.reset(cmdId)}
                      title={t('settings.shortcuts.resetToDefault')}
                    >{t('settings.shortcuts.reset')}</button>
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
          >{t('settings.shortcuts.resetAll')}</button>
        </div>

        <div class="mt-3 text-xs" style="color: var(--novelist-text-secondary);">
          {t('settings.shortcuts.hint')}
        </div>

      {:else if activeSection === 'templates'}
        <h3 class="text-xs font-semibold uppercase tracking-wide mb-4" style="color: var(--novelist-text-secondary);">{t('settings.templates')}</h3>

        {#if !templatesLoaded}
          <p class="text-sm" style="color: var(--novelist-text-secondary);">{t('settings.plugins.loading')}</p>
        {:else}
          <!-- User templates list -->
          {#if userTemplates.length > 0}
            <div class="space-y-2 mb-4">
              {#each userTemplates as tpl}
                <div class="flex items-center justify-between rounded p-3" style="background: var(--novelist-bg-secondary); border: 1px solid var(--novelist-border);">
                  <div>
                    <div class="text-sm font-medium">{tpl.name}</div>
                    <div class="text-xs" style="color: var(--novelist-text-secondary);">
                      {tpl.id}{tpl.description ? ` — ${tpl.description}` : ''}
                    </div>
                  </div>
                  <button
                    class="text-xs px-2 py-1 rounded cursor-pointer"
                    style="background: transparent; color: var(--novelist-text-tertiary, var(--novelist-text-secondary)); border: 1px solid var(--novelist-border); transition: color 0.15s, border-color 0.15s;"
                    onmouseenter={(e) => { (e.target as HTMLElement).style.color = '#e5484d'; (e.target as HTMLElement).style.borderColor = '#e5484d'; }}
                    onmouseleave={(e) => { (e.target as HTMLElement).style.color = ''; (e.target as HTMLElement).style.borderColor = ''; }}
                    onclick={() => handleDeleteTemplate(tpl.id)}
                  >{t('settings.templates.delete')}</button>
                </div>
              {/each}
            </div>
          {:else}
            <div class="text-sm mb-4" style="color: var(--novelist-text-secondary);">
              {t('settings.templates.noTemplates')}
            </div>
          {/if}

          <!-- Save current project as template -->
          {#if projectStore.dirPath}
            <div class="rounded p-3 mb-3" style="background: var(--novelist-bg-secondary); border: 1px solid var(--novelist-border);">
              <div class="text-xs font-semibold mb-2" style="color: var(--novelist-text-secondary); text-transform: uppercase; letter-spacing: 0.05em;">{t('settings.templates.saveFromProject')}</div>
              <div class="flex gap-2">
                <input
                  type="text"
                  class="text-sm px-2 py-1 rounded flex-1"
                  style="background: var(--novelist-bg); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
                  placeholder={t('settings.templates.namePlaceholder')}
                  bind:value={saveTemplateName}
                  onkeydown={(e) => { if (e.key === 'Enter') handleSaveAsTemplate(); }}
                />
                <button
                  class="text-xs px-3 py-1 rounded cursor-pointer"
                  style="background: var(--novelist-accent); color: #fff; border: none;"
                  onclick={handleSaveAsTemplate}
                  disabled={savingTemplate || !saveTemplateName.trim()}
                >{savingTemplate ? t('settings.templates.saving') : t('settings.templates.save')}</button>
              </div>
            </div>
          {/if}

          <!-- Import from zip -->
          <div class="mb-3">
            <button
              class="text-sm px-3 py-1.5 rounded cursor-pointer w-full"
              style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
              onclick={handleImportTemplateZip}
            >{t('settings.templates.importZip')}</button>
          </div>

          {#if templateError}
            <div class="rounded p-2 mb-2 text-xs" style="background: color-mix(in srgb, #ef4444 10%, transparent); color: #ef4444; border: 1px solid #ef4444;">
              {templateError}
            </div>
          {/if}

          <div class="mt-3 text-xs" style="color: var(--novelist-text-secondary);">
            {t('settings.templates.hint')}
          </div>
        {/if}

      {:else if activeSection === 'plugins'}
        <h3 class="text-xs font-semibold uppercase tracking-wide mb-4" style="color: var(--novelist-text-secondary);">{t('settings.plugins')}</h3>

        {#if !pluginsLoaded}
          <p class="text-sm" style="color: var(--novelist-text-secondary);">{t('settings.plugins.loading')}</p>
        {:else}
          {#if builtinPlugins.length > 0}
            <div class="text-xs font-semibold mb-2" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary)); text-transform: uppercase; letter-spacing: 0.05em;">{t('settings.plugins.builtin')}</div>
            <div class="space-y-2 mb-4">
              {#each builtinPlugins as plugin}
                {@render pluginCard(plugin)}
              {/each}
            </div>
          {/if}

          {#if communityPlugins.length > 0}
            <div class="text-xs font-semibold mb-2" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary)); text-transform: uppercase; letter-spacing: 0.05em;">{t('settings.plugins.community')}</div>
            <div class="space-y-2 mb-4">
              {#each communityPlugins as plugin}
                {@render pluginCard(plugin)}
              {/each}
            </div>
          {/if}

          {#if plugins.length === 0}
            <div class="text-sm" style="color: var(--novelist-text-secondary);">
              <p class="mb-3">{t('settings.plugins.noPlugins')}</p>
            </div>
          {/if}

          <div class="rounded p-3 mt-3" style="background: var(--novelist-bg-secondary); border: 1px solid var(--novelist-border);">
            <p class="text-xs font-medium mb-1">{t('settings.plugins.createPlugin')}</p>
            <p class="text-xs" style="color: var(--novelist-text-secondary);">
              {t('settings.plugins.pluginPath')} <code style="background: var(--novelist-code-bg); padding: 1px 4px; border-radius: 3px;">~/.novelist/plugins/&lt;id&gt;/</code>
            </p>
            <p class="text-xs mt-1" style="color: var(--novelist-text-secondary);">{t('settings.plugins.aiSuggestion')}</p>
          </div>
        {/if}
      {:else if activeSection === 'sync'}
        <h3 class="text-xs font-semibold uppercase tracking-wide mb-4" style="color: var(--novelist-text-secondary);">{t('settings.sync.webdav')}</h3>

        {#if !projectStore.dirPath}
          <p class="text-sm" style="color: var(--novelist-text-secondary);">{t('settings.sync.openProject')}</p>
        {:else if !syncLoaded}
          <p class="text-sm" style="color: var(--novelist-text-secondary);">{t('settings.plugins.loading')}</p>
        {:else}
          <div class="flex items-center justify-between mb-3">
            <label for="sync-enabled" class="text-sm">{t('settings.sync.enabled')}</label>
            <button
              id="sync-enabled"
              class="text-xs px-3 py-1 rounded cursor-pointer"
              style="background: {syncConfig.enabled ? 'var(--novelist-accent)' : 'var(--novelist-bg-tertiary, var(--novelist-bg-secondary))'}; color: {syncConfig.enabled ? '#fff' : 'var(--novelist-text)'}; border: none;"
              onclick={() => { syncConfig.enabled = !syncConfig.enabled; saveSyncConfig(); }}
            >{syncConfig.enabled ? t('settings.sync.on') : t('settings.sync.off')}</button>
          </div>

          <div class="mb-3">
            <label for="sync-webdav-url" class="text-sm block mb-1">{t('settings.sync.url')}</label>
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
            <label for="sync-username" class="text-sm block mb-1">{t('settings.sync.username')}</label>
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
            <label for="sync-password" class="text-sm block mb-1">{t('settings.sync.password')}</label>
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
            <label for="sync-interval" class="text-sm">{t('settings.sync.interval')}</label>
            <select
              id="sync-interval"
              class="text-sm px-2 py-1 rounded cursor-pointer"
              style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
              value={syncConfig.interval_minutes}
              onchange={(e) => { syncConfig.interval_minutes = Number((e.target as HTMLSelectElement).value); saveSyncConfig(); }}
            >
              <option value={15}>{t('settings.sync.15min')}</option>
              <option value={30}>{t('settings.sync.30min')}</option>
              <option value={60}>{t('settings.sync.60min')}</option>
              <option value={120}>{t('settings.sync.120min')}</option>
            </select>
          </div>

          <div class="flex gap-2 mb-3">
            <button
              class="text-xs px-3 py-1.5 rounded cursor-pointer"
              style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
              onclick={testConnection}
              disabled={syncTestResult === 'testing'}
            >{syncTestResult === 'testing' ? t('settings.sync.testing') : t('settings.sync.testConnection')}</button>
            <button
              class="text-xs px-3 py-1.5 rounded cursor-pointer"
              style="background: var(--novelist-accent); color: #fff; border: none;"
              onclick={syncNow}
              disabled={syncInProgress}
            >{syncInProgress ? t('settings.sync.syncing') : t('settings.sync.syncNow')}</button>
          </div>

          {#if syncTestResult === 'success'}
            <div class="text-xs mb-2" style="color: #22c55e;">{t('settings.sync.connectionSuccess')}</div>
          {:else if syncTestResult === 'fail'}
            <div class="text-xs mb-2" style="color: #ef4444;">{t('settings.sync.connectionFailed')}</div>
          {/if}

          {#if lastSyncTime}
            <div class="text-xs mb-2" style="color: var(--novelist-text-secondary);">{t('settings.sync.lastSync', { time: lastSyncTime })}</div>
          {/if}

          {#if syncErrors.length > 0}
            <div class="rounded p-2 mb-2 text-xs" style="background: color-mix(in srgb, #ef4444 10%, transparent); color: #ef4444; border: 1px solid #ef4444;">
              {#each syncErrors as err}
                <div>{err}</div>
              {/each}
            </div>
          {/if}

          <div class="mt-3 text-xs" style="color: var(--novelist-text-secondary);">
            {t('settings.sync.syncPath')} <code style="background: var(--novelist-code-bg); padding: 1px 4px; border-radius: 3px;">{"<webdav-url>/novelist/<project-name>/"}</code>
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>
