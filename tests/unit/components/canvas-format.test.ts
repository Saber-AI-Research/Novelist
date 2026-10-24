import { describe, expect, it } from 'vitest';
import type { Edge } from '@xyflow/svelte';
import {
  canvasToFlow,
  flowToCanvas,
  parseCanvas,
  serializeCanvas,
  type CanvasFlowHandlers,
} from '$lib/components/canvas/canvas-format';

const handlers: CanvasFlowHandlers = {
  onTextChange: () => {},
  onOpenFile: () => {},
  onGroupLabelChange: () => {},
  onGroupColorChange: () => {},
  onResize: () => {},
  groupPalette: ['#ef4444'],
};

/** Open → (editor) → save, exactly as CanvasInner does it. */
function openAndSave(raw: string, edit?: (edges: Edge[]) => Edge[]): unknown {
  const parsed = parseCanvas(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  const flow = canvasToFlow(parsed.data, handlers);
  const edges = edit ? edit(flow.edges) : flow.edges;
  return JSON.parse(serializeCanvas(flowToCanvas(flow.nodes, edges, parsed.data.extra)));
}

const obsidianCanvas = {
  nodes: [
    { id: 'n1', type: 'text', text: '主角', x: 0, y: 0, width: 250, height: 60, color: '1' },
    { id: 'n2', type: 'file', file: 'chapters/01.md', subpath: '#开头', x: 400, y: 0, width: 400, height: 400 },
    { id: 'n3', type: 'link', url: 'https://example.com', x: 0, y: 300, width: 300, height: 200 },
    { id: 'g1', type: 'group', label: '第一幕', x: -50, y: -50, width: 900, height: 700, color: '#22c55e', background: 'bg.png' },
  ],
  edges: [
    { id: 'e1', fromNode: 'n1', fromSide: 'bottom', toNode: 'n2', toSide: 'top', toEnd: 'arrow', color: '4', label: '出场' },
    { id: 'e2', fromNode: 'n2', toNode: 'n3' },
  ],
};

describe('canvas format', () => {
  it('keeps Obsidian edges (fromNode/toNode + sides) through open and save', () => {
    const saved = openAndSave(JSON.stringify(obsidianCanvas)) as typeof obsidianCanvas;
    expect(saved.edges).toEqual(obsidianCanvas.edges);
  });

  it('keeps Obsidian node fields this editor does not edit', () => {
    const saved = openAndSave(JSON.stringify(obsidianCanvas)) as typeof obsidianCanvas;
    expect(saved.nodes).toEqual(obsidianCanvas.nodes);
  });

  it('renders edges on the handle of the side named in the file', () => {
    const parsed = parseCanvas(JSON.stringify(obsidianCanvas));
    if (!parsed.ok) throw new Error(parsed.error);
    const [e1] = canvasToFlow(parsed.data, handlers).edges;
    expect(e1).toMatchObject({ source: 'n1', sourceHandle: 'bottom', target: 'n2', targetHandle: 'top' });
  });

  it('writes the side of an edge the user re-attached', () => {
    const saved = openAndSave(JSON.stringify(obsidianCanvas), (edges) =>
      edges.map((edge) => (edge.id === 'e2' ? { ...edge, sourceHandle: 'top' } : edge)),
    ) as { edges: Array<Record<string, unknown>> };
    expect(saved.edges[1]).toEqual({ id: 'e2', fromNode: 'n2', fromSide: 'top', toNode: 'n3' });
  });

  it('migrates legacy Novelist edges (from/to) to JSON Canvas fields', () => {
    const legacy = {
      nodes: [
        { id: 'a', type: 'text', content: 'legacy text', x: 0, y: 0, width: 220, height: 120 },
        { id: 'b', type: 'text', text: 'b', x: 300, y: 0, width: 220, height: 120 },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b', label: 'next' }],
    };
    const saved = openAndSave(JSON.stringify(legacy)) as { nodes: Array<Record<string, unknown>>; edges: unknown[] };
    expect(saved.edges).toEqual([{ id: 'e', fromNode: 'a', toNode: 'b', label: 'next' }]);
    expect(saved.nodes[0]).toEqual({ id: 'a', type: 'text', text: 'legacy text', x: 0, y: 0, width: 220, height: 120 });
  });

  it('accepts an empty file and an empty object as a new canvas', () => {
    expect(parseCanvas('')).toEqual({ ok: true, data: { nodes: [], edges: [], extra: {} } });
    expect(parseCanvas('{}')).toEqual({ ok: true, data: { nodes: [], edges: [], extra: {} } });
  });

  it('reports malformed files instead of returning an empty canvas', () => {
    expect(parseCanvas('<<<<<<< HEAD\n{"nodes":[]}\n=======\n{}\n>>>>>>> theirs').ok).toBe(false);
    expect(parseCanvas('{"nodes":[{"id":"a"').ok).toBe(false);
    expect(parseCanvas('[]').ok).toBe(false);
    expect(parseCanvas('{"nodes":{}}').ok).toBe(false);
    expect(parseCanvas('{"edges":[{"id":"e"}]}').ok).toBe(false);
  });
});
