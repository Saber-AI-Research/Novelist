<script lang="ts">
  import { onMount } from 'svelte';
  import {
    SvelteFlow,
    Controls,
    Background,
    MiniMap,
    type Node,
    type Edge,
    type NodeTypes,
  } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import CanvasTextNode from './CanvasTextNode.svelte';
  import { connectToHost } from '../../host-channel';

  interface CanvasData {
    nodes: CanvasNodeData[];
    edges: CanvasEdgeData[];
  }
  interface CanvasNodeData {
    id: string;
    type: 'text' | 'file';
    x: number; y: number;
    width: number; height: number;
    content: string;
    filePath?: string;
  }
  interface CanvasEdgeData {
    id: string;
    from: string; to: string;
    label?: string;
  }

  let nodes = $state<Node[]>([]);
  let edges = $state<Edge[]>([]);
  let documentId = $state('');
  let revision = $state(0);
  // At most one debounced save exists: a new `file-open` flushes it with the
  // token it was scheduled for, so the host decides whether it still applies.
  let pendingSave: { timer: ReturnType<typeof setTimeout>; documentId: string; revision: number } | null = null;

  const nodeTypes: NodeTypes = {
    text: CanvasTextNode,
  } as unknown as NodeTypes;

  function parseCanvasData(content: string): CanvasData {
    try {
      const data = JSON.parse(content);
      return {
        nodes: Array.isArray(data.nodes) ? data.nodes : [],
        edges: Array.isArray(data.edges) ? data.edges : [],
      };
    } catch {
      return { nodes: [], edges: [] };
    }
  }

  function canvasDataToFlow(data: CanvasData): { nodes: Node[]; edges: Edge[] } {
    const flowNodes: Node[] = data.nodes.map((n) => ({
      id: n.id,
      type: 'text',
      position: { x: n.x, y: n.y },
      data: { content: n.content, width: n.width, height: n.height },
      style: `width: ${n.width}px; min-height: ${n.height}px;`,
    }));
    const flowEdges: Edge[] = data.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.label,
    }));
    return { nodes: flowNodes, edges: flowEdges };
  }

  function flowToCanvasData(): CanvasData {
    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: 'text' as const,
        x: n.position.x,
        y: n.position.y,
        width: (n.data as any).width ?? 200,
        height: (n.data as any).height ?? 100,
        content: (n.data as any).content ?? '',
      })),
      edges: edges.map((e) => ({
        id: e.id,
        from: e.source,
        to: e.target,
        label: typeof e.label === 'string' ? e.label : undefined,
      })),
    };
  }

  function serializeCanvas(): string {
    return JSON.stringify(flowToCanvasData(), null, 2);
  }

  function cancelPendingSave() {
    if (pendingSave) clearTimeout(pendingSave.timer);
    pendingSave = null;
  }

  function postSave(targetDocumentId: string, targetRevision: number) {
    host.post({
      type: 'file-save',
      documentId: targetDocumentId,
      revision: targetRevision,
      content: serializeCanvas(),
    });
  }

  function flushPendingSave() {
    const pending = pendingSave;
    if (!pending) return;
    cancelPendingSave();
    postSave(pending.documentId, pending.revision);
  }

  function scheduleSave() {
    if (!documentId) return;
    cancelPendingSave();
    const targetDocumentId = documentId;
    const targetRevision = revision;
    const timer = setTimeout(() => {
      pendingSave = null;
      postSave(targetDocumentId, targetRevision);
    }, 1000);
    pendingSave = { timer, documentId: targetDocumentId, revision: targetRevision };
  }

  function handleNodesChange() {
    if (!documentId) return;
    // Publish the live document so the host can mirror it to every view of
    // the same file and reject snapshots that another view has replaced.
    host.post({
      type: 'file-state',
      documentId,
      revision,
      content: serializeCanvas(),
    });
    scheduleSave();
  }

  function addNode(x: number, y: number) {
    const id = crypto.randomUUID();
    const newNode: Node = {
      id,
      type: 'text',
      position: { x, y },
      data: { content: 'New note', width: 200, height: 100 },
      style: 'width: 200px; min-height: 100px;',
    };
    nodes = [...nodes, newNode];
    handleNodesChange();
  }

  // Messages from the host arrive only on the host-issued MessagePort.
  const host = connectToHost((data: Record<string, any>) => {
    if (data.type === 'file-open') {
      flushPendingSave();
      documentId = typeof data.documentId === 'string' ? data.documentId : '';
      revision = Number.isInteger(data.revision) && data.revision >= 0 ? data.revision : 0;
      const canvasData = parseCanvasData(data.content ?? '');
      const flow = canvasDataToFlow(canvasData);
      nodes = flow.nodes;
      edges = flow.edges;
    } else if (data.type === 'theme-update' && data.theme) {
      const root = document.documentElement;
      for (const [key, value] of Object.entries(data.theme as Record<string, string>)) {
        const localKey = key.replace('--novelist-', '--novelist-');
        root.style.setProperty(localKey, value);
      }
    }
  });

  onMount(() => {
    host.post({ type: 'plugin-ready' });
    return () => {
      cancelPendingSave();
    };
  });
</script>

<div class="canvas-editor">
  <SvelteFlow
    {nodes}
    {edges}
    {nodeTypes}
    fitView
    onnodedragstop={() => handleNodesChange()}
    ondelete={() => handleNodesChange()}
  >
    <Controls />
    <Background />
    <MiniMap />
  </SvelteFlow>

  <div class="canvas-toolbar">
    <button
      class="canvas-toolbar-btn"
      onclick={() => addNode(100, 100)}
      title="Add text node"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3v10M3 8h10"/></svg>
      Add Node
    </button>
  </div>
</div>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .canvas-editor {
    width: 100%;
    height: 100%;
    position: relative;
  }

  .canvas-toolbar {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 10;
    display: flex;
    gap: 4px;
  }

  .canvas-toolbar-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    font-size: 0.75rem;
    border: 1px solid var(--novelist-border, #ddd);
    border-radius: 4px;
    background: var(--novelist-bg, #fff);
    color: var(--novelist-text, #333);
    cursor: pointer;
    transition: background 100ms;
  }
  .canvas-toolbar-btn:hover {
    background: var(--novelist-bg-secondary, #f4f3ef);
  }
</style>
