<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import {
    SvelteFlow,
    Controls,
    Background,
    MiniMap,
    ConnectionMode,
    PanOnScrollMode,
    useSvelteFlow,
    type Node,
    type Edge,
    type NodeTypes,
  } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import CanvasTextNode from './CanvasTextNode.svelte';
  import CanvasFileNode from './CanvasFileNode.svelte';
  import CanvasGroupNode from './CanvasGroupNode.svelte';
  import CanvasNotePicker from './CanvasNotePicker.svelte';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { platform } from '$lib/stores/platform.svelte';
  import { commands } from '$lib/ipc/commands';
  import { t } from '$lib/i18n';
  import { createTabReloadGate } from '../structured-file';
  import { createTabsStructuredSaver } from '../structured-file-tab-saver';
  import { canvasToFlow, flowToCanvas, parseCanvas, serializeCanvas } from './canvas-format';
  import { canReadCanvasFile, toCanvasFileRef } from './file-ref';

  let { paneId = 'pane-1' }: { paneId?: string } = $props();

  const { screenToFlowPosition, getViewport, setViewport, deleteElements } = useSvelteFlow();

  // Fingers land less precisely than a mouse: snap a dragged connection to a
  // handle from farther away on touch-first devices.
  const connectionRadius =
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 40 : 20;

  // Curated 10-color palette for groups. Balanced for dark + light themes.
  const GROUP_COLORS = [
    '#ef4444', // red
    '#f97316', // orange
    '#eab308', // amber
    '#22c55e', // green
    '#14b8a6', // teal
    '#06b6d4', // cyan
    '#3b82f6', // blue
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#94a3b8', // slate (neutral)
  ];
  function randomGroupColor(): string {
    return GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)];
  }

  let editorEl = $state<HTMLDivElement | undefined>(undefined);

  // Shift+wheel → horizontal pan. We intercept in capture phase so SvelteFlow
  // doesn't consume the event first. Ctrl+wheel still reaches SvelteFlow for
  // zoom (via zoomActivationKeyCode="Control").
  $effect(() => {
    const el = editorEl;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (e.ctrlKey) return;
      if (!e.shiftKey) return;
      // Respect `.nowheel` — SvelteFlow's convention for elements that should
      // receive wheel events natively (scrollable node bodies).
      const target = e.target as Element | null;
      if (target && target.closest('.nowheel')) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      e.stopPropagation();
      const vp = getViewport();
      setViewport({ x: vp.x - e.deltaY, y: vp.y, zoom: vp.zoom });
    }
    el.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => el.removeEventListener('wheel', onWheel, { capture: true } as any);
  });

  let tab = $derived(tabsStore.getPaneActiveTab(paneId));

  let nodes = $state<Node[]>([]);
  let edges = $state<Edge[]>([]);
  /** Touch has no Delete key: the toolbar offers deletion while this holds. */
  let hasSelection = $derived(nodes.some((n) => n.selected) || edges.some((e) => e.selected));
  /** Unknown top-level keys of the loaded file, written back on save. */
  let fileExtra: Record<string, unknown> = {};
  /** Set when the file is not a canvas: shown read-only, never saved. */
  let parseError = $state<string | null>(null);
  const shouldReload = createTabReloadGate();
  const saver = createTabsStructuredSaver();

  const nodeTypes: NodeTypes = {
    text: CanvasTextNode,
    file: CanvasFileNode,
    group: CanvasGroupNode,
  } as unknown as NodeTypes;

  function uuid() { return crypto.randomUUID(); }

  const flowHandlers = {
    onTextChange: (nodeId: string, text: string) => updateTextContent(nodeId, text),
    onOpenFile: (path: string) => { void openFileInTab(path); },
    onGroupLabelChange: (nodeId: string, label: string) => updateGroupLabel(nodeId, label),
    onGroupColorChange: (nodeId: string, color: string) => updateGroupColor(nodeId, color),
    onResize: () => markDirtyAndSave(),
    groupPalette: GROUP_COLORS,
  };

  function updateTextContent(nodeId: string, text: string) {
    const idx = nodes.findIndex((n) => n.id === nodeId);
    if (idx < 0) return;
    const node = nodes[idx];
    nodes[idx] = { ...node, data: { ...node.data, text } };
    markDirtyAndSave();
  }

  function updateGroupLabel(nodeId: string, label: string) {
    const idx = nodes.findIndex((n) => n.id === nodeId);
    if (idx < 0) return;
    const node = nodes[idx];
    nodes[idx] = { ...node, data: { ...node.data, label } };
    markDirtyAndSave();
  }

  function updateGroupColor(nodeId: string, color: string) {
    const idx = nodes.findIndex((n) => n.id === nodeId);
    if (idx < 0) return;
    const node = nodes[idx];
    nodes[idx] = { ...node, data: { ...node.data, color } };
    markDirtyAndSave();
  }

  async function openFileInTab(filePath: string) {
    if (!canReadCanvasFile(filePath, projectStore.dirPath ?? null, platform.isMobile)) return;
    const r = await commands.readFile(filePath);
    if (r.status !== 'ok') return;
    tabsStore.openTab(filePath, r.data);
    await commands.registerOpenFile(filePath);
  }

  $effect(() => {
    const current = tab;
    if (!shouldReload(current)) return;
    if (!current) {
      nodes = [];
      edges = [];
      fileExtra = {};
      parseError = null;
      return;
    }
    // Content is read untracked: our own edits update it and must not reload.
    const parsed = parseCanvas(untrack(() => current.content ?? ''));
    if (!parsed.ok) {
      nodes = [];
      edges = [];
      fileExtra = {};
      parseError = parsed.error;
      return;
    }
    const projectRoot = untrack(() => projectStore.dirPath ?? null);
    const flow = canvasToFlow(parsed.data, flowHandlers, projectRoot);
    nodes = flow.nodes;
    edges = flow.edges;
    fileExtra = parsed.data.extra;
    parseError = null;
    // Migrate this project's absolute note links (older canvases, other
    // tools) to project-relative ones now, so the file keeps working after the
    // project moves or syncs to another device. External links stay as-is.
    const migrates = parsed.data.nodes.some(
      (node) => node.type === 'file' && toCanvasFileRef(node.file, projectRoot) !== node.file,
    );
    if (migrates) untrack(() => markDirtyAndSave());
  });

  /** Copy the canvas into the tab right away; the disk write is debounced. */
  function markDirtyAndSave() {
    const current = tab;
    if (!current || parseError !== null) return;
    const canvas = flowToCanvas(nodes, edges, fileExtra, projectStore.dirPath ?? null);
    tabsStore.updateContent(current.id, serializeCanvas(canvas));
    if (current.filePath) saver.schedule(current.id);
  }

  // Unmounting (tab switch to a non-canvas file, pane close) must write the
  // pending edit, not cancel it.
  onDestroy(() => {
    closeNotePicker(null);
    void saver.flush();
  });

  // --- Obsidian-style group drag: when a group moves, the nodes spatially
  // contained by the group at drag-start move along with it. No persisted
  // parent/child relationship — membership is re-evaluated on every drag.
  let groupDrag: {
    groupId: string;
    lastX: number;
    lastY: number;
    memberIds: Set<string>;
  } | null = null;

  function nodeInsideGroup(node: Node, group: Node): boolean {
    const gx = group.position.x;
    const gy = group.position.y;
    const gw = (group.width ?? (group as any).measured?.width ?? 0) as number;
    const gh = (group.height ?? (group as any).measured?.height ?? 0) as number;
    const nx = node.position.x;
    const ny = node.position.y;
    const nw = (node.width ?? (node as any).measured?.width ?? 0) as number;
    const nh = (node.height ?? (node as any).measured?.height ?? 0) as number;
    // Obsidian includes a node if its center lies inside the group rect.
    const cx = nx + nw / 2;
    const cy = ny + nh / 2;
    return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
  }

  function setGroupHighlight(targetGroupId: string | null) {
    let changed = false;
    nodes = nodes.map((n) => {
      if (n.type !== 'group') return n;
      const shouldHighlight = n.id === targetGroupId;
      if (!!(n.data as any).highlight === shouldHighlight) return n;
      changed = true;
      return { ...n, data: { ...n.data, highlight: shouldHighlight } };
    });
    void changed; // no-op; the assignment above already triggers reactivity when needed
  }

  function onNodeDragStart({ targetNode }: { event: MouseEvent | TouchEvent; targetNode: Node | null; nodes: Node[] }) {
    groupDrag = null;
    if (!targetNode) return;
    if (targetNode.type === 'group') {
      const members = new Set<string>();
      for (const n of nodes) {
        if (n.id === targetNode.id) continue;
        if (n.type === 'group') continue; // groups don't nest
        if (nodeInsideGroup(n, targetNode)) members.add(n.id);
      }
      groupDrag = {
        groupId: targetNode.id,
        lastX: targetNode.position.x,
        lastY: targetNode.position.y,
        memberIds: members,
      };
    }
  }

  function onNodeDrag({ targetNode }: { event: MouseEvent | TouchEvent; targetNode: Node | null; nodes: Node[] }) {
    if (!targetNode) return;

    if (groupDrag && targetNode.id === groupDrag.groupId) {
      // Dragging a group → move its spatial members by the same delta.
      const dx = targetNode.position.x - groupDrag.lastX;
      const dy = targetNode.position.y - groupDrag.lastY;
      if (dx === 0 && dy === 0) return;
      groupDrag.lastX = targetNode.position.x;
      groupDrag.lastY = targetNode.position.y;
      nodes = nodes.map((n) => {
        if (!groupDrag!.memberIds.has(n.id)) return n;
        return { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } };
      });
      return;
    }

    if (targetNode.type !== 'group') {
      // Dragging a regular node: highlight whichever group it is hovering over.
      let hoveredGroup: string | null = null;
      for (const n of nodes) {
        if (n.type !== 'group') continue;
        if (nodeInsideGroup(targetNode, n)) { hoveredGroup = n.id; break; }
      }
      setGroupHighlight(hoveredGroup);
    }
  }

  function onNodeDragStop() {
    groupDrag = null;
    setGroupHighlight(null);
    markDirtyAndSave();
  }

  // --- Node creation --------------------------------------------------------
  function createTextAt(x: number, y: number, initial = '') {
    const id = uuid();
    nodes = [...nodes, {
      id,
      type: 'text',
      position: { x, y },
      width: 220,
      height: 120,
      data: {
        text: initial || t('canvas.defaultNodeLabel'),
        onChange: (text: string) => updateTextContent(id, text),
        onResize: () => markDirtyAndSave(),
      },
    }];
    markDirtyAndSave();
  }

  function createFileNodeAt(x: number, y: number, filePath: string) {
    const id = uuid();
    nodes = [...nodes, {
      id,
      type: 'file',
      position: { x, y },
      width: 260,
      height: 160,
      data: {
        filePath,
        onOpen: (p: string) => openFileInTab(p),
        onResize: () => markDirtyAndSave(),
      },
    }];
    markDirtyAndSave();
  }

  function createGroupAt(x: number, y: number) {
    const id = uuid();
    const color = randomGroupColor();
    nodes = [...nodes, {
      id,
      type: 'group',
      position: { x, y },
      width: 360,
      height: 240,
      zIndex: -1,
      data: {
        label: t('canvas.newGroupLabel'),
        color,
        palette: GROUP_COLORS,
        onLabelChange: (label: string) => updateGroupLabel(id, label),
        onColorChange: (c: string) => updateGroupColor(id, c),
        onResize: () => markDirtyAndSave(),
      },
    }];
    markDirtyAndSave();
  }

  // --- Drag-drop from sidebar ------------------------------------------------
  // Note: dataTransfer.getData(...) is only readable during `drop`, not during
  // `dragover` (security). We always preventDefault on dragover to keep the
  // drop target "alive", and rely on the drop handler to filter by MIME.
  let dropZoneActive = $state(false);

  function hasOurPathType(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    // `types` contains the MIME even during dragover, but values are redacted.
    const types = Array.from(dt.types);
    return types.includes('application/x-novelist-path');
  }

  function handleDragOver(e: DragEvent) {
    // Always prevent default so the drop is accepted. Specific MIME filtering
    // happens in `handleDrop`.
    e.preventDefault();
    if (e.dataTransfer) {
      // Match the source's effectAllowed ('move' from the sidebar).
      e.dataTransfer.dropEffect = 'move';
    }
    if (hasOurPathType(e.dataTransfer)) dropZoneActive = true;
  }

  function handleDragLeave(e: DragEvent) {
    // Only clear if leaving the outer wrapper (not on internal crossings).
    const rt = e.relatedTarget as unknown as globalThis.Node | null;
    if (rt && (e.currentTarget as Element).contains(rt)) return;
    dropZoneActive = false;
  }

  function handleDrop(e: DragEvent) {
    dropZoneActive = false;
    if (!e.dataTransfer) return;
    const path = e.dataTransfer.getData('application/x-novelist-path');
    if (!path) return;
    e.preventDefault();
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    createFileNodeAt(pos.x - 130, pos.y - 80, path);
  }

  // --- Context menu ----------------------------------------------------------
  let ctxMenu = $state<{ screenX: number; screenY: number; flowX: number; flowY: number } | null>(null);

  async function openContextMenu(e: MouseEvent) {
    e.preventDefault();
    await tick();
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    ctxMenu = { screenX: e.clientX, screenY: e.clientY, flowX: pos.x, flowY: pos.y };
  }

  function closeContextMenu() { ctxMenu = null; }

  function onPaneContextMenu({ event }: { event: MouseEvent }) {
    openContextMenu(event);
  }

  async function ctxNewText() {
    if (!ctxMenu) return;
    const { flowX, flowY } = ctxMenu;
    closeContextMenu();
    createTextAt(flowX - 110, flowY - 60);
  }

  async function ctxNewGroup() {
    if (!ctxMenu) return;
    const { flowX, flowY } = ctxMenu;
    closeContextMenu();
    createGroupAt(flowX - 180, flowY - 120);
  }

  /** Resolves the open in-project note picker (mobile only). */
  let notePickerResolve = $state<((path: string | null) => void) | null>(null);

  function closeNotePicker(path: string | null) {
    const resolve = notePickerResolve;
    notePickerResolve = null;
    resolve?.(path);
  }

  async function pickNoteFile(): Promise<string | null> {
    // Mobile system pickers return sandbox copies or content:// URIs outside
    // the project that a file card can never read: browse the project instead.
    if (platform.isMobile) {
      if (!projectStore.dirPath) return null;
      closeNotePicker(null);
      return new Promise((resolve) => { notePickerResolve = resolve; });
    }
    const picked = await openDialog({
      multiple: false,
      directory: false,
      defaultPath: projectStore.dirPath ?? undefined,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
    });
    if (typeof picked === 'string') return picked;
    return null;
  }

  async function ctxAddNoteReference() {
    if (!ctxMenu) return;
    const { flowX, flowY } = ctxMenu;
    closeContextMenu();
    const path = await pickNoteFile();
    if (path) createFileNodeAt(flowX - 130, flowY - 80, path);
  }

  // --- Toolbar -------------------------------------------------------------
  /** Center of the visible canvas, not of the window: the pane may sit beside
   *  a sidebar or in one half of a split view. */
  function centerFlowPosition() {
    const rect = editorEl?.getBoundingClientRect();
    return screenToFlowPosition({
      x: rect ? rect.left + rect.width / 2 : (window.innerWidth ?? 800) / 2,
      y: rect ? rect.top + rect.height / 2 : (window.innerHeight ?? 600) / 2,
    });
  }

  function toolbarAddText() {
    const p = centerFlowPosition();
    createTextAt(p.x - 110, p.y - 60);
  }

  async function toolbarAddFile() {
    const path = await pickNoteFile();
    if (path) {
      const p = centerFlowPosition();
      createFileNodeAt(p.x - 130, p.y - 80, path);
    }
  }

  function toolbarAddGroup() {
    const p = centerFlowPosition();
    createGroupAt(p.x - 180, p.y - 120);
  }

  function toolbarDeleteSelection() {
    // Same path as the Delete key: connected edges go too, and SvelteFlow's
    // `ondelete` callback saves.
    void deleteElements({
      nodes: nodes.filter((n) => n.selected),
      edges: edges.filter((e) => e.selected),
    });
  }
</script>

<svelte:window onclick={closeContextMenu} />

{#if parseError !== null}
  <div class="canvas-editor parse-error" role="alert" data-testid="canvas-parse-error">
    <p class="parse-error-title">{t('canvas.parseErrorTitle')}</p>
    <p class="parse-error-hint">{t('canvas.parseErrorHint')}</p>
    <code class="parse-error-detail">{parseError}</code>
  </div>
{:else}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="canvas-editor"
  class:drop-active={dropZoneActive}
  bind:this={editorEl}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    fitView
    panOnScroll
    panOnScrollMode={PanOnScrollMode.Free}
    zoomActivationKey="Control"
    minZoom={0.3}
    maxZoom={2}
    elevateNodesOnSelect={false}
    connectionMode={ConnectionMode.Loose}
    {connectionRadius}
    onnodedragstart={onNodeDragStart}
    onnodedrag={onNodeDrag}
    onnodedragstop={onNodeDragStop}
    ondelete={() => markDirtyAndSave()}
    onconnect={() => markDirtyAndSave()}
    onpanecontextmenu={onPaneContextMenu}
    deleteKey={['Backspace', 'Delete']}
  >
    <Controls />
    <Background />
    <MiniMap pannable zoomable />
  </SvelteFlow>

  <!-- Obsidian-style floating toolbar, bottom-center -->
  <div class="toolbar" role="toolbar" aria-label={t('canvas.toolbar')}>
    <button type="button" class="tb-btn" onclick={toolbarAddText} title={t('canvas.addTextNode')}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 4h10M3 8h10M3 12h7"/></svg>
      <span>{t('canvas.text')}</span>
    </button>
    <button type="button" class="tb-btn" onclick={toolbarAddFile} title={t('canvas.addFileNode')} data-testid="canvas-add-note">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg>
      <span>{t('canvas.file')}</span>
    </button>
    <span class="tb-sep"></span>
    <button type="button" class="tb-btn" onclick={toolbarAddGroup} title={t('canvas.addGroup')}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/></svg>
      <span>{t('canvas.group')}</span>
    </button>
    {#if hasSelection}
      <span class="tb-sep"></span>
      <button type="button" class="tb-btn" onclick={toolbarDeleteSelection} title={t('canvas.deleteSelection')} aria-label={t('canvas.deleteSelection')} data-testid="canvas-delete-selection">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/></svg>
      </button>
    {/if}
  </div>

  {#if notePickerResolve && projectStore.dirPath}
    <CanvasNotePicker
      rootDir={projectStore.dirPath}
      onPick={(path) => closeNotePicker(path)}
      onCancel={() => closeNotePicker(null)}
    />
  {/if}

  {#if ctxMenu}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="ctx-menu"
      style="left: min({ctxMenu.screenX}px, calc(100vw - 216px)); top: min({ctxMenu.screenY}px, calc(100dvh - 168px));"
      role="menu"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <button role="menuitem" class="ctx-item" onclick={ctxNewText}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h10M3 8h10M3 12h7"/></svg>
        <span>{t('canvas.ctx.newText')}</span>
      </button>
      <button role="menuitem" class="ctx-item" onclick={ctxAddNoteReference}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg>
        <span>{t('canvas.ctx.addNoteRef')}</span>
      </button>
      <button role="menuitem" class="ctx-item" onclick={ctxNewGroup}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/></svg>
        <span>{t('canvas.ctx.newGroup')}</span>
      </button>
    </div>
  {/if}
</div>
{/if}

<style>
  .canvas-editor {
    flex: 1;
    position: relative;
    background: var(--novelist-bg);
    color: var(--novelist-text);
    overflow: hidden;
    /* Narrow rules below follow the pane (sidebar, split view), not the window. */
    container-type: inline-size;
  }
  .canvas-editor.drop-active::after {
    content: '';
    position: absolute;
    inset: 10px;
    border: 2px dashed var(--novelist-accent);
    border-radius: 10px;
    pointer-events: none;
    z-index: 20;
    background: color-mix(in srgb, var(--novelist-accent) 6%, transparent);
  }
  .canvas-editor.parse-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    text-align: center;
    color: var(--novelist-text-secondary);
  }
  .parse-error-title { margin: 0; font-size: 0.95rem; font-weight: 500; color: var(--novelist-text); }
  .parse-error-hint { margin: 0; font-size: 0.8rem; max-width: 460px; }
  .parse-error-detail {
    font-size: 0.75rem;
    max-width: 460px;
    overflow-wrap: anywhere;
    opacity: 0.8;
  }

  /* --- Floating toolbar ---------------------------------------------------- */
  .toolbar {
    position: absolute;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 7px;
    background: var(--novelist-bg-secondary);
    border: 1px solid var(--novelist-border);
    border-radius: 8px;
    box-shadow: 0 4px 12px color-mix(in srgb, var(--novelist-text) 10%, transparent);
    z-index: 15;
  }
  .tb-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 10px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--novelist-text-secondary);
    font-size: 0.78rem;
    cursor: pointer;
    line-height: 1;
  }
  .tb-btn:hover {
    background: color-mix(in srgb, var(--novelist-text) 8%, transparent);
    color: var(--novelist-text);
  }
  .tb-sep {
    width: 1px;
    height: 16px;
    background: var(--novelist-border);
    margin: 0 2px;
  }

  /* --- Context menu -------------------------------------------------------- */
  .ctx-menu {
    position: fixed;
    z-index: 100;
    min-width: 200px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 6px;
    box-shadow: 0 4px 14px color-mix(in srgb, var(--novelist-text) 15%, transparent);
    padding: 4px;
    font-size: 0.85rem;
  }
  .ctx-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--novelist-text);
    font-size: inherit;
    text-align: left;
    cursor: pointer;
  }
  .ctx-item:hover { background: color-mix(in srgb, var(--novelist-accent) 14%, transparent); }
  .ctx-item svg { opacity: 0.65; flex-shrink: 0; }

  /* --- Theme bridge for SvelteFlow ---------------------------------------- */
  .canvas-editor :global(.svelte-flow) {
    background: var(--novelist-bg);
    color: var(--novelist-text);
  }
  .canvas-editor :global(.svelte-flow__background) {
    color: color-mix(in srgb, var(--novelist-text) 10%, transparent);
  }
  .canvas-editor :global(.svelte-flow__edge-path) {
    stroke: color-mix(in srgb, var(--novelist-accent) 70%, transparent);
    stroke-width: 1.5;
  }
  .canvas-editor :global(.svelte-flow__controls) {
    background: var(--novelist-bg-secondary);
    border: 1px solid var(--novelist-border);
    border-radius: 6px;
    overflow: hidden;
    box-shadow: 0 1px 3px color-mix(in srgb, var(--novelist-text) 8%, transparent);
  }
  .canvas-editor :global(.svelte-flow__controls-button) {
    background: var(--novelist-bg-secondary);
    border-bottom: 1px solid var(--novelist-border);
    color: var(--novelist-text-secondary);
    fill: currentColor;
  }
  .canvas-editor :global(.svelte-flow__controls-button:hover) {
    background: var(--novelist-bg);
    color: var(--novelist-text);
  }
  .canvas-editor :global(.svelte-flow__minimap) {
    background: var(--novelist-bg-secondary);
    border: 1px solid var(--novelist-border);
    border-radius: 6px;
  }
  .canvas-editor :global(.svelte-flow__handle) {
    background: var(--novelist-accent);
    border: 1px solid var(--novelist-bg);
    width: 8px;
    height: 8px;
  }
  .canvas-editor :global(.svelte-flow__node) {
    font-family: inherit;
    /* Font clarity under CSS scale transforms (zoom). */
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: geometricPrecision;
  }
  .canvas-editor :global(.svelte-flow__node.selected) {
    box-shadow: 0 0 0 2px var(--novelist-accent);
    border-radius: 8px;
  }
  /* Hint browser to keep the viewport on its own layer only while the user is
     actively interacting. This reduces the chance of the composited bitmap
     being reused across zoom levels (which is what creates the blurry text). */
  .canvas-editor :global(.svelte-flow__viewport) {
    will-change: auto;
  }
  /* Groups must always render behind text/file nodes, even when selected.
     SvelteFlow writes z-index inline; we override it in CSS. */
  .canvas-editor :global(.svelte-flow__node-group) {
    z-index: -1 !important;
  }
  .canvas-editor :global(.svelte-flow__node-group.selected) {
    box-shadow: none !important;
  }

  /* --- Touch --------------------------------------------------------------- */
  /* The flow surface is a gesture canvas: SvelteFlow owns one-finger pan, node
     drag and pinch zoom, so the browser must not scroll or zoom the page here.
     Node textareas are their own scroll containers and keep native scrolling,
     caret placement and selection. */
  .canvas-editor :global(.svelte-flow) {
    touch-action: none;
  }
  @media (hover: none), (pointer: coarse) {
    .tb-btn {
      min-width: 44px;
      min-height: 44px;
      justify-content: center;
      touch-action: manipulation;
    }
    .ctx-item { min-height: 44px; }
    .canvas-editor :global(.svelte-flow__controls-button) {
      width: 44px;
      height: 44px;
    }
    .canvas-editor :global(.svelte-flow__handle),
    .canvas-editor :global(.svelte-flow__resize-control.handle) {
      width: 12px;
      height: 12px;
    }
    /* Invisible 44px hit area around connection and resize handles. */
    .canvas-editor :global(.svelte-flow__handle::after),
    .canvas-editor :global(.svelte-flow__resize-control.handle::after) {
      content: '';
      position: absolute;
      inset: -16px;
      border-radius: 50%;
    }
  }
  /* Narrow panes (phones, iPad portrait beside the sidebar, split view): the
     bottom-centre toolbar would overlap the 200px minimap, so the minimap
     goes; narrower still, the toolbar keeps only icons (names stay as
     accessible labels) so it clears the zoom controls. */
  @container (max-width: 740px) {
    .canvas-editor :global(.svelte-flow__minimap) { display: none; }
  }
  @container (max-width: 480px) {
    .tb-btn span {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }
</style>
