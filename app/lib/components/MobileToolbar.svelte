<script lang="ts">
  import Menu from '@lucide/svelte/icons/menu';
  import FilePlus from '@lucide/svelte/icons/file-plus';
  import Save from '@lucide/svelte/icons/save';
  import Command from '@lucide/svelte/icons/command';
  import Settings from '@lucide/svelte/icons/settings';
  import { commandRegistry } from '$lib/stores/commands.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { t } from '$lib/i18n';

  /**
   * Touch-shell top bar (mobile + phone-narrow desktop windows). Replaces the
   * native menu: file drawer, new file, save, command palette, settings.
   * Actions dispatch through the command registry where one exists so the
   * keyboard, palette and touch paths stay a single implementation.
   */
  interface Props {
    onSave: () => void;
  }
  let { onSave }: Props = $props();

  const activeTab = $derived(tabsStore.activeTab);
  const title = $derived(activeTab?.fileName ?? projectStore.config?.project?.name ?? t('app.name'));
</script>

<header class="mobile-toolbar" data-testid="mobile-toolbar">
  <button
    type="button"
    class="mobile-toolbar-btn"
    data-testid="mobile-files-button"
    aria-label={t('mobile.files')}
    title={t('mobile.files')}
    aria-expanded={uiStore.sidebarShown}
    onclick={() => uiStore.toggleSidebar()}
  >
    <Menu size={20} aria-hidden="true" />
  </button>

  <div class="mobile-toolbar-title" data-testid="mobile-toolbar-title">
    <span class="mobile-toolbar-title-text">{title}</span>
    {#if activeTab?.isDirty}
      <span class="mobile-toolbar-dirty" role="img" aria-label={t('tab.unsaved')} title={t('tab.unsaved')}></span>
    {/if}
  </div>

  <button
    type="button"
    class="mobile-toolbar-btn"
    data-testid="mobile-new-file"
    aria-label={t('command.newFile')}
    title={t('command.newFile')}
    onclick={() => commandRegistry.execute('new-file')}
  >
    <FilePlus size={20} aria-hidden="true" />
  </button>
  <button
    type="button"
    class="mobile-toolbar-btn"
    data-testid="mobile-save"
    aria-label={t('mobile.save')}
    title={t('mobile.save')}
    disabled={!activeTab}
    onclick={onSave}
  >
    <Save size={20} aria-hidden="true" />
  </button>
  <button
    type="button"
    class="mobile-toolbar-btn"
    data-testid="mobile-palette"
    aria-label={t('command.commandPalette')}
    title={t('command.commandPalette')}
    onclick={() => commandRegistry.execute('command-palette')}
  >
    <Command size={20} aria-hidden="true" />
  </button>
  <button
    type="button"
    class="mobile-toolbar-btn"
    data-testid="mobile-settings"
    aria-label={t('command.openSettings')}
    title={t('command.openSettings')}
    onclick={() => uiStore.openSettings()}
  >
    <Settings size={20} aria-hidden="true" />
  </button>
</header>

<style>
  .mobile-toolbar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 44px;
    padding: env(safe-area-inset-top, 0px) max(4px, env(safe-area-inset-right, 0px)) 0 max(4px, env(safe-area-inset-left, 0px));
    background: var(--novelist-bg-secondary);
    border-bottom: 1px solid var(--novelist-border-subtle, var(--novelist-border));
    color: var(--novelist-text);
    user-select: none;
    -webkit-user-select: none;
  }
  .mobile-toolbar-btn {
    flex: 0 0 44px;
    width: 44px;
    height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .mobile-toolbar-btn:active:not(:disabled),
  .mobile-toolbar-btn[aria-expanded='true'] {
    background: var(--novelist-sidebar-hover);
    color: var(--novelist-accent);
  }
  .mobile-toolbar-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .mobile-toolbar-btn:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--novelist-accent) 45%, transparent);
    outline-offset: -2px;
  }
  .mobile-toolbar-title {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px;
    font-size: 15px;
    font-weight: 500;
  }
  .mobile-toolbar-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mobile-toolbar-dirty {
    flex: 0 0 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--novelist-accent);
  }
</style>
