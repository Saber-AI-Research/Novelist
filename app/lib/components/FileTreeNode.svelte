<script lang="ts">
  import { projectStore, type FileNode } from '$lib/stores/project.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { compareByMode } from '$lib/utils/file-sort';

  interface Props {
    node: FileNode;
    depth: number;
    onContextMenu: (e: MouseEvent, node: FileNode) => void;
    onFileOpen: (node: FileNode) => void | Promise<void>;
    onDragStart: (e: DragEvent, node: FileNode) => void;
    onDragOver: (e: DragEvent, node: FileNode) => void;
    onDragLeave: (e: DragEvent, node: FileNode) => void;
    onDrop: (e: DragEvent, node: FileNode) => void | Promise<void>;
    isTextFile: (name: string) => boolean;
  }

  let {
    node,
    depth,
    onContextMenu,
    onFileOpen,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    isTextFile,
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
</script>

{#if node.is_dir}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    role="treeitem"
    aria-expanded={node.expanded}
    tabindex="0"
    class="tree-row tree-dir"
    class:drag-over={node.dragOver}
    style="padding-left: {indentPx}px;"
    data-testid="sidebar-folder-{node.name}"
    oncontextmenu={(e) => onContextMenu(e, node)}
    ondragover={(e) => onDragOver(e, node)}
    ondragleave={(e) => onDragLeave(e, node)}
    ondrop={(e) => onDrop(e, node)}
    draggable="true"
    ondragstart={(e) => onDragStart(e, node)}
    ondblclick={(e) => { e.preventDefault(); toggleFolder(); }}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFolder(); } }}
  >
    <button
      class="tree-chevron"
      aria-label={node.expanded ? 'Collapse' : 'Expand'}
      onclick={toggleFolder}
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
      <svelte:self
        node={child}
        depth={depth + 1}
        {onContextMenu}
        {onFileOpen}
        {onDragStart}
        {onDragOver}
        {onDragLeave}
        {onDrop}
        {isTextFile}
      />
    {/each}
  {/if}
{:else if isTextFile(node.name)}
  <button
    class="tree-row tree-file"
    class:tree-file-active={tabsStore.activeTab?.filePath === node.path}
    style="padding-left: {indentPx + 16}px;"
    data-testid="sidebar-file-{node.name}"
    draggable="true"
    ondragstart={(e) => onDragStart(e, node)}
    onclick={() => onFileOpen(node)}
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
    class="tree-row tree-file tree-disabled"
    style="padding-left: {indentPx + 16}px;"
    oncontextmenu={(e) => onContextMenu(e, node)}
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
    padding-top: 5px;
    padding-bottom: 5px;
    padding-right: 8px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--novelist-sidebar-text);
    font-size: 0.95rem;
    text-align: left;
    cursor: pointer;
    transition: background 80ms;
    white-space: nowrap;
    overflow: hidden;
    gap: 6px;
  }
  .tree-row:hover { background: var(--novelist-sidebar-hover); }
  .tree-dir {
    cursor: default;
    color: var(--novelist-text-secondary);
    font-size: 0.92rem;
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
  .tree-file-active {
    background: var(--novelist-sidebar-active) !important;
    color: var(--novelist-text);
  }
  .tree-file-active .tree-icon { opacity: 0.75; }
  .tree-disabled { cursor: default; opacity: 0.35; }
  .tree-name { overflow: hidden; text-overflow: ellipsis; }
  .tree-ext {
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
    font-size: 0.78rem;
    flex-shrink: 0;
  }
  .drag-over {
    background: color-mix(in srgb, var(--novelist-accent) 18%, transparent) !important;
    outline: 1px dashed var(--novelist-accent);
    outline-offset: -1px;
  }
</style>
