<script lang="ts">
  import TabBar from '$lib/components/TabBar.svelte';
  import ErrorBoundary from '$lib/components/ErrorBoundary.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { extensionStore } from '$lib/stores/extensions.svelte';
  import { SIDEBAR_PATH_MIME, handlePaneDrop, type PaneDropEdge } from '$lib/services/pane-drop';
  import { t } from '$lib/i18n';
  import type { HeadingItem } from '$lib/editor/outline';

  const loadEditor = () => import('$lib/components/Editor.svelte');
  const loadPluginFileEditor = () => import('$lib/components/PluginFileEditor.svelte');
  const loadCanvasFileEditor = () => import('$lib/components/CanvasFileEditor.svelte');
  const loadKanbanFileEditor = () => import('$lib/components/KanbanFileEditor.svelte');

  type EditorRef = {
    scrollToPosition: (from: number) => void;
    jumpToAbsoluteLine: (line: number) => void;
    renameCurrentFile: () => void;
    saveCurrentFile: () => Promise<void>;
  } | undefined;

  export type PaneMetrics = {
    wordCount: number;
    cursorLine: number;
    cursorCol: number;
    headings: HeadingItem[];
    editorRef: EditorRef;
  };

  let {
    paneId,
    index,
    isActive,
    isPrimary = false,
    onmetrics,
  }: {
    paneId: string;
    index: number;
    isActive: boolean;
    isPrimary?: boolean;
    onmetrics: (paneId: string, m: PaneMetrics) => void;
  } = $props();

  // Per-pane editor metrics, bound from the Editor and pushed up to App.svelte
  // (which keys them by paneId so the status bar / outline read the active one).
  let wordCount = $state(0);
  let cursorLine = $state(1);
  let cursorCol = $state(1);
  let headings = $state<HeadingItem[]>([]);
  let editorRef = $state<EditorRef>(undefined);

  $effect(() => {
    onmetrics(paneId, { wordCount, cursorLine, cursorCol, headings, editorRef });
  });

  const activeTab = $derived(tabsStore.getPaneActiveTab(paneId));
  const fileName = $derived(activeTab?.fileName ?? '');
  const lower = $derived(fileName.toLowerCase());

  // Edge drop zones (left/center/right) shown while a file or tab is dragging.
  const dragActive = $derived(uiStore.sidebarFileDragActive || uiStore.tabDragActive);
  let hotEdge = $state<PaneDropEdge | null>(null);

  function accepts(types: ReadonlyArray<string> | DOMStringList | undefined): boolean {
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      const ty = (types as ArrayLike<string>)[i].toLowerCase();
      if (ty === SIDEBAR_PATH_MIME || ty === 'novelist/tab-id') return true;
    }
    return false;
  }

  function onZoneOver(e: DragEvent, edge: PaneDropEdge) {
    if (!accepts(e.dataTransfer?.types)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    hotEdge = edge;
  }

  function onZoneLeave(edge: PaneDropEdge) {
    if (hotEdge === edge) hotEdge = null;
  }

  async function onZoneDrop(e: DragEvent, edge: PaneDropEdge) {
    if (!accepts(e.dataTransfer?.types)) return;
    e.preventDefault();
    hotEdge = null;
    uiStore.sidebarFileDragActive = false;
    uiStore.tabDragActive = false;
    await handlePaneDrop({ paneId, paneIndex: index, edge }, e.dataTransfer);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex flex-col min-w-0 h-full"
  style={isActive && tabsStore.panes.length > 1 ? 'box-shadow: inset 0 2px 0 0 var(--novelist-accent);' : ''}
  onclick={() => tabsStore.setActivePane(paneId)}
>
  <TabBar {paneId} />

  <div class="flex-1 min-h-0 overflow-hidden relative">
    {#if activeTab}
      {#if lower.endsWith('.canvas')}
        {#await loadCanvasFileEditor() then { default: CanvasFileEditor }}
          <ErrorBoundary><CanvasFileEditor {paneId} /></ErrorBoundary>
        {/await}
      {:else if lower.endsWith('.kanban')}
        {#await loadKanbanFileEditor() then { default: KanbanFileEditor }}
          <ErrorBoundary><KanbanFileEditor {paneId} /></ErrorBoundary>
        {/await}
      {:else}
        {@const fileHandler = extensionStore.getFileHandler(fileName)}
        {#if fileHandler}
          {#await loadPluginFileEditor() then { default: PluginFileEditor }}
            <ErrorBoundary><PluginFileEditor extension={fileHandler} {paneId} /></ErrorBoundary>
          {/await}
        {:else}
          {#await loadEditor() then { default: Editor }}
            <ErrorBoundary>
              <Editor
                {paneId}
                bind:wordCount
                bind:cursorLine
                bind:cursorCol
                bind:headings
                bind:this={editorRef}
              />
            </ErrorBoundary>
          {/await}
        {/if}
      {/if}
    {:else}
      <div class="flex items-center justify-center h-full" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary));">
        <div class="text-center">
          {#if isPrimary}
            <p style="font-size: 1.3rem; font-weight: 500; margin-bottom: 6px; color: var(--novelist-text-secondary);">{t('app.name')}</p>
            <p style="font-size: 0.95rem;">{t('app.openFolder')}</p>
          {:else}
            <p style="font-size: 0.95rem;">{t('app.openFile')}</p>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Drag-to-split edge zones: left/right create a new column, center
         opens/moves into this pane. Shown only while a drag is in flight. -->
    {#if dragActive}
      <div
        class="pane-drop-zone pane-drop-left"
        class:pane-drop-active={hotEdge === 'left'}
        data-testid="pane-drop-{paneId}-left"
        ondragover={(e) => onZoneOver(e, 'left')}
        ondragleave={() => onZoneLeave('left')}
        ondrop={(e) => onZoneDrop(e, 'left')}
      ><span class="pane-drop-label">{t('pane.drop.splitLeft')}</span></div>
      <div
        class="pane-drop-zone pane-drop-center"
        class:pane-drop-active={hotEdge === 'center'}
        data-testid="pane-drop-{paneId}-center"
        ondragover={(e) => onZoneOver(e, 'center')}
        ondragleave={() => onZoneLeave('center')}
        ondrop={(e) => onZoneDrop(e, 'center')}
      ><span class="pane-drop-label">{t('pane.drop.openHere')}</span></div>
      <div
        class="pane-drop-zone pane-drop-right"
        class:pane-drop-active={hotEdge === 'right'}
        data-testid="pane-drop-{paneId}-right"
        ondragover={(e) => onZoneOver(e, 'right')}
        ondragleave={() => onZoneLeave('right')}
        ondrop={(e) => onZoneDrop(e, 'right')}
      ><span class="pane-drop-label">{t('pane.drop.splitRight')}</span></div>
    {/if}
  </div>
</div>

<style>
  .pane-drop-zone {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
    background: transparent;
    border: 2px dashed transparent;
    border-radius: 6px;
    transition: background 120ms, border-color 120ms;
  }
  .pane-drop-left {
    left: 0;
    width: 25%;
  }
  .pane-drop-center {
    left: 25%;
    width: 50%;
  }
  .pane-drop-right {
    right: 0;
    width: 25%;
  }
  .pane-drop-active {
    background: color-mix(in srgb, var(--novelist-accent) 12%, transparent);
    border-color: var(--novelist-accent);
  }
  .pane-drop-label {
    color: var(--novelist-text-secondary);
    font-size: 0.85rem;
    letter-spacing: 0.02em;
    opacity: 0;
    transition: opacity 120ms;
    pointer-events: none;
  }
  .pane-drop-active .pane-drop-label {
    opacity: 1;
    color: var(--novelist-accent);
  }
</style>
