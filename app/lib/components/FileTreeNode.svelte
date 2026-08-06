<script lang="ts">
  import { projectStore, type FileNode } from '$lib/stores/project.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { compareByMode } from '$lib/utils/file-sort';
  // Self-import replaces <svelte:self> (deprecated in Svelte 5).
  import FileTreeNode from './FileTreeNode.svelte';

  interface Props {
    node: FileNode;
    depth: number;
    onContextMenu: (e: MouseEvent, node: FileNode) => void;
    onSelect: (e: MouseEvent, node: FileNode) => void;
    onFileOpen: (node: FileNode) => void | Promise<void>;
    onRenameRequest: (node: FileNode) => void;
    onDragStart: (e: DragEvent, node: FileNode) => void;
    onDragOver: (e: DragEvent, node: FileNode) => void;
    onDragLeave: (e: DragEvent, node: FileNode) => void;
    onDrop: (e: DragEvent, node: FileNode) => void | Promise<void>;
    isTextFile: (name: string) => boolean;
    selectedPaths: string[];
    renamingPath?: string | null;
    renameValue?: string;
    onRenameInput?: (value: string) => void;
    onRenameKeydown?: (e: KeyboardEvent) => void;
    onRenameBlur?: () => void | Promise<void>;
  }

  let {
    node,
    depth,
    onContextMenu,
    onSelect,
    onFileOpen,
    onRenameRequest,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    isTextFile,
    selectedPaths,
    renamingPath = null,
    renameValue = '',
    onRenameInput,
    onRenameKeydown,
    onRenameBlur,
  }: Props = $props();

  // Sort using the project-wide sort mode (folders-first is handled by compareByMode).
  function sortChildren(children: FileNode[]): FileNode[] {
    return [...children].sort((a, b) => compareByMode(a, b, projectStore.sortMode));
  }

  async function toggleFolder() {
    if (node.expanded) projectStore.collapseFolder(node.path);
    else await projectStore.expandFolder(node.path);
  }

  const indentPx = $derived(depth * 12 + 6);
  const selected = $derived(selectedPaths.includes(node.path));
  let renameInputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (renamingPath !== node.path || !renameInputEl) return;
    const input = renameInputEl;
    input.focus();
    const dotIdx = node.name.lastIndexOf('.');
    input.setSelectionRange(0, node.is_dir ? node.name.length : (dotIdx > 0 ? dotIdx : node.name.length));
  });
</script>

{#if renamingPath === node.path}
  <div class="tree-input-row" style="padding-left: {node.is_dir ? indentPx : indentPx + 16}px;">
    <input
      bind:this={renameInputEl}
      value={renameValue}
      oninput={(e) => onRenameInput?.((e.target as HTMLInputElement).value)}
      onkeydown={(e) => onRenameKeydown?.(e)}
      onblur={() => onRenameBlur?.()}
      class="tree-input"
      data-testid="sidebar-input"
    />
  </div>
{:else if node.is_dir}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    role="treeitem"
    aria-expanded={node.expanded}
    aria-selected={selected}
    tabindex="0"
    class="tree-row tree-dir"
    class:tree-row-selected={selected}
    class:drag-over={node.dragOver}
    class:tree-row-wrap={projectStore.wrapFileNames}
    style="padding-left: {indentPx}px;"
    data-testid="sidebar-folder-{node.name}"
    data-tree-path={node.path}
    oncontextmenu={(e) => onContextMenu(e, node)}
    ondragover={(e) => onDragOver(e, node)}
    ondragleave={(e) => onDragLeave(e, node)}
    ondrop={(e) => onDrop(e, node)}
    draggable="true"
    ondragstart={(e) => onDragStart(e, node)}
    onclick={(e) => {
      // Single click on the row toggles folder; the chevron stops propagation
      // so it doesn't double-fire there. Dblclick fires after click — Esc /
      // blur during the in-flight expand is fine because rename overwrites it.
      const target = e.target as HTMLElement;
      if (target.closest('.tree-chevron')) return;
      onSelect(e, node);
      if (e.shiftKey || e.metaKey || e.ctrlKey) return;
      toggleFolder();
    }}
    ondblclick={(e) => { e.preventDefault(); onRenameRequest(node); }}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFolder(); } }}
  >
    <button
      class="tree-chevron"
      aria-label={node.expanded ? 'Collapse' : 'Expand'}
      onclick={(e) => { e.stopPropagation(); toggleFolder(); }}
      ondblclick={(e) => e.stopPropagation()}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
        <path d={node.expanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} />
      </svg>
    </button>
    <svg class="tree-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
      <path d="M2 4h4l2 2h6v7H2z" />
    </svg>
    <span class="tree-name">{node.name}</span>
  </div>

  {#if node.expanded && node.children}
    {#each sortChildren(node.children) as child (child.path)}
      <FileTreeNode
        node={child}
        depth={depth + 1}
        {onContextMenu}
        {onSelect}
        {onFileOpen}
        {onRenameRequest}
        {onDragStart}
        {onDragOver}
        {onDragLeave}
        {onDrop}
        {isTextFile}
        {selectedPaths}
        {renamingPath}
        {renameValue}
        {onRenameInput}
        {onRenameKeydown}
        {onRenameBlur}
      />
    {/each}
  {/if}
{:else if isTextFile(node.name)}
  <button
    role="treeitem"
    aria-selected={selected}
    class="tree-row tree-file"
    class:tree-file-active={tabsStore.activeTab?.filePath === node.path}
    class:tree-row-selected={selected}
    class:tree-row-wrap={projectStore.wrapFileNames}
    style="padding-left: {indentPx + 16}px;"
    data-testid="sidebar-file-{node.name}"
    data-tree-path={node.path}
    draggable="true"
    ondragstart={(e) => onDragStart(e, node)}
    onclick={(e) => {
      onSelect(e, node);
      if (!e.shiftKey && !e.metaKey && !e.ctrlKey) onFileOpen(node);
    }}
    ondblclick={(e) => { e.preventDefault(); onRenameRequest(node); }}
    oncontextmenu={(e) => onContextMenu(e, node)}
  >
    <svg class="tree-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </svg>
    <span class="tree-name">{node.name.replace(/\.(md|markdown|txt|json|jsonl|csv)$/i, '')}</span>
    <span class="tree-ext">.{node.name.split('.').pop()}</span>
  </button>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    role="treeitem"
    aria-selected={selected}
    tabindex="-1"
    class="tree-row tree-file tree-disabled"
    class:tree-row-selected={selected}
    class:tree-row-wrap={projectStore.wrapFileNames}
    style="padding-left: {indentPx + 16}px;"
    data-tree-path={node.path}
    oncontextmenu={(e) => onContextMenu(e, node)}
    ondblclick={(e) => { e.preventDefault(); onRenameRequest(node); }}
  >
    <svg class="tree-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </svg>
    <span class="tree-name">{node.name}</span>
  </div>
{/if}

<style>
  .tree-row {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 30px;
    padding-top: 4px;
    padding-bottom: 4px;
    padding-right: 8px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--novelist-sidebar-text);
    font-family: var(--novelist-sidebar-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--novelist-sidebar-file-font-size, 14px);
    line-height: var(--novelist-sidebar-file-line-height, 1.35);
    text-align: left;
    cursor: pointer;
    transition: background 80ms;
    white-space: nowrap;
    overflow: hidden;
    gap: 6px;
  }
  .tree-input-row {
    padding-top: 2px;
    padding-bottom: 2px;
    padding-right: 6px;
  }
  .tree-input {
    width: 100%;
    padding: 4px 8px;
    border: 1px solid var(--novelist-accent);
    border-radius: 5px;
    background: var(--novelist-bg);
    color: var(--novelist-text);
    font-size: var(--novelist-sidebar-file-font-size, 14px);
    line-height: var(--novelist-sidebar-file-line-height, 1.35);
    outline: none;
    font-family: var(--novelist-sidebar-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  }
  .tree-row-wrap {
    align-items: flex-start;
    white-space: normal;
    min-height: 32px;
  }
  .tree-row:hover { background: var(--novelist-sidebar-hover); }
  .tree-row:focus-visible {
    outline: 1px solid var(--novelist-accent);
    outline-offset: -1px;
  }
  .tree-dir {
    cursor: default;
    color: var(--novelist-text-secondary);
    user-select: none;
  }
  .tree-chevron {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer;
    flex-shrink: 0;
  }
  .tree-chevron:hover { color: var(--novelist-text); }
  .tree-icon { flex-shrink: 0; opacity: 0.5; }
  .tree-row-selected {
    background: var(--novelist-sidebar-active) !important;
    color: var(--novelist-text);
  }
  .tree-file-active {
    background: color-mix(in srgb, var(--novelist-accent) 8%, var(--novelist-sidebar-bg));
    color: var(--novelist-accent);
    font-weight: 500;
  }
  .tree-file-active .tree-icon { opacity: 0.75; }
  .tree-disabled { cursor: default; opacity: 0.35; }
  .tree-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: inherit;
  }
  .tree-row-wrap .tree-name {
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .tree-ext {
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
    font-size: 12px;
    flex-shrink: 0;
    font-family: inherit;
  }
  .tree-row-wrap .tree-ext {
    padding-top: 2px;
  }
  .drag-over {
    background: color-mix(in srgb, var(--novelist-accent) 18%, transparent) !important;
    outline: 1px dashed var(--novelist-accent);
    outline-offset: -1px;
  }
</style>
