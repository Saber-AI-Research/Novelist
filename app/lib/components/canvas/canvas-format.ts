import type { Edge, Node } from '@xyflow/svelte';
import { resolveCanvasFileRef, toCanvasFileRef } from './file-ref';

/**
 * `.canvas` on-disk format: JSON Canvas (https://jsoncanvas.org), the format
 * Obsidian writes, plus the legacy Novelist shape that used `from`/`to` on
 * edges and `content` on text nodes.
 *
 * Keys this editor does not understand (node `color`, edge `fromEnd`/`toEnd`,
 * vendor fields, …) are kept in `extra` and written back unchanged, so opening
 * and saving an Obsidian canvas does not strip anything.
 */

export const CANVAS_SIDES = ['top', 'right', 'bottom', 'left'] as const;
export type CanvasSide = (typeof CANVAS_SIDES)[number];

/** Handles used when an edge does not name a side (legacy files, JSON Canvas edges without sides). */
export const DEFAULT_FROM_SIDE: CanvasSide = 'right';
export const DEFAULT_TO_SIDE: CanvasSide = 'left';

type Extra = Record<string, unknown>;

interface CanvasNodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  extra: Extra;
}

export type CanvasDiskNode =
  | (CanvasNodeBase & { type: 'text'; text: string })
  | (CanvasNodeBase & { type: 'file'; file: string })
  | (CanvasNodeBase & { type: 'link'; url: string })
  | (CanvasNodeBase & { type: 'group'; label: string; color?: string });

export interface CanvasDiskEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  label?: string;
  extra: Extra;
}

export interface CanvasDiskData {
  nodes: CanvasDiskNode[];
  edges: CanvasDiskEdge[];
  /** Unknown top-level keys. */
  extra: Extra;
}

export type CanvasParseResult =
  | { ok: true; data: CanvasDiskData }
  | { ok: false; error: string };

const NODE_KEYS: Record<string, true> = {
  id: true, type: true, x: true, y: true, width: true, height: true,
  text: true, content: true, file: true, url: true, label: true, color: true,
};
const EDGE_KEYS: Record<string, true> = {
  id: true, fromNode: true, toNode: true, from: true, to: true, fromSide: true, toSide: true, label: true,
};

function canvasId(): string {
  return crypto.randomUUID();
}

function asObject(value: unknown): Extra | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Extra) : null;
}

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function extraFields(raw: Extra, known: Record<string, true>): Extra {
  const extra: Extra = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(known, key)) extra[key] = value;
  }
  return extra;
}

function asSide(value: unknown): CanvasSide | undefined {
  return CANVAS_SIDES.find((side) => side === value);
}

function parseNode(raw: Extra): CanvasDiskNode {
  const base: CanvasNodeBase = {
    id: typeof raw.id === 'string' ? raw.id : canvasId(),
    x: finiteOr(raw.x, 0),
    y: finiteOr(raw.y, 0),
    width: finiteOr(raw.width, 220),
    height: finiteOr(raw.height, 120),
    extra: extraFields(raw, NODE_KEYS),
  };
  // Only groups own `color` here; other node types keep it verbatim.
  if (raw.type !== 'group' && raw.color !== undefined) base.extra.color = raw.color;
  if (raw.type === 'file' && typeof raw.file === 'string') return { ...base, type: 'file', file: raw.file };
  if (raw.type === 'link' && typeof raw.url === 'string') return { ...base, type: 'link', url: raw.url };
  if (raw.type === 'group') {
    return {
      ...base,
      type: 'group',
      label: typeof raw.label === 'string' ? raw.label : '',
      color: typeof raw.color === 'string' ? raw.color : undefined,
    };
  }
  // Text, plus the legacy Novelist `content` field.
  const text = typeof raw.text === 'string' ? raw.text : typeof raw.content === 'string' ? raw.content : '';
  return { ...base, type: 'text', text };
}

function parseEdge(raw: Extra): CanvasDiskEdge | null {
  // JSON Canvas uses fromNode/toNode; older Novelist files used from/to.
  const fromNode = typeof raw.fromNode === 'string' ? raw.fromNode : typeof raw.from === 'string' ? raw.from : null;
  const toNode = typeof raw.toNode === 'string' ? raw.toNode : typeof raw.to === 'string' ? raw.to : null;
  if (fromNode === null || toNode === null) return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : canvasId(),
    fromNode,
    toNode,
    fromSide: asSide(raw.fromSide),
    toSide: asSide(raw.toSide),
    label: typeof raw.label === 'string' ? raw.label : undefined,
    extra: extraFields(raw, EDGE_KEYS),
  };
}

/**
 * Parse a `.canvas` file. An empty file is a new canvas. Anything that is not
 * a canvas object (invalid JSON, git conflict markers, a half-synced file) is
 * an error, so the caller can show it read-only instead of saving an empty
 * canvas over it.
 */
export function parseCanvas(content: string): CanvasParseResult {
  if (content.trim() === '') return { ok: true, data: { nodes: [], edges: [], extra: {} } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const root = asObject(parsed);
  if (!root) return { ok: false, error: 'Expected a JSON object.' };
  if (root.nodes !== undefined && !Array.isArray(root.nodes)) return { ok: false, error: '"nodes" must be an array.' };
  if (root.edges !== undefined && !Array.isArray(root.edges)) return { ok: false, error: '"edges" must be an array.' };
  const nodes: CanvasDiskNode[] = [];
  for (const rawNode of (root.nodes as unknown[] | undefined) ?? []) {
    const node = asObject(rawNode);
    if (!node) return { ok: false, error: 'Every node must be a JSON object.' };
    nodes.push(parseNode(node));
  }
  const edges: CanvasDiskEdge[] = [];
  for (const rawEdge of (root.edges as unknown[] | undefined) ?? []) {
    const edge = asObject(rawEdge);
    if (!edge) return { ok: false, error: 'Every edge must be a JSON object.' };
    const parsedEdge = parseEdge(edge);
    if (!parsedEdge) return { ok: false, error: 'Every edge needs "fromNode" and "toNode".' };
    edges.push(parsedEdge);
  }
  const extra: Extra = {};
  for (const [key, value] of Object.entries(root)) {
    if (key !== 'nodes' && key !== 'edges') extra[key] = value;
  }
  return { ok: true, data: { nodes, edges, extra } };
}

export function serializeCanvas(data: CanvasDiskData): string {
  const nodes = data.nodes.map((node) => {
    const base = { ...node.extra, id: node.id, type: node.type, x: node.x, y: node.y, width: node.width, height: node.height };
    switch (node.type) {
      case 'text': return { ...base, text: node.text };
      case 'file': return { ...base, file: node.file };
      case 'link': return { ...base, url: node.url };
      case 'group': return node.color === undefined
        ? { ...base, label: node.label }
        : { ...base, label: node.label, color: node.color };
    }
  });
  const edges = data.edges.map((edge) => ({
    ...edge.extra,
    id: edge.id,
    fromNode: edge.fromNode,
    ...(edge.fromSide ? { fromSide: edge.fromSide } : {}),
    toNode: edge.toNode,
    ...(edge.toSide ? { toSide: edge.toSide } : {}),
    ...(edge.label !== undefined ? { label: edge.label } : {}),
  }));
  return JSON.stringify({ ...data.extra, nodes, edges }, null, 2);
}

// --- Svelte Flow mapping ----------------------------------------------------

export interface CanvasFlowHandlers {
  onTextChange(nodeId: string, text: string): void;
  onOpenFile(path: string): void;
  onGroupLabelChange(nodeId: string, label: string): void;
  onGroupColorChange(nodeId: string, color: string): void;
  onResize(): void;
  groupPalette: readonly string[];
}

/** Edge `data` that remembers which sides the file never named. */
interface CanvasEdgeData extends Record<string, unknown> {
  extra?: Extra;
  implicitFromSide?: boolean;
  implicitToSide?: boolean;
}

/**
 * `projectRoot` resolves project-relative file-card references (see
 * `file-ref.ts`); `null` keeps every reference exactly as stored.
 */
export function canvasToFlow(
  data: CanvasDiskData,
  handlers: CanvasFlowHandlers,
  projectRoot: string | null = null,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = data.nodes.map((node) => {
    const common = {
      id: node.id,
      position: { x: node.x, y: node.y },
      width: node.width,
      height: node.height,
    };
    if (node.type === 'text' || node.type === 'link') {
      return {
        ...common,
        type: 'text',
        data: {
          text: node.type === 'text' ? node.text : node.url,
          // Link cards show and edit their URL.
          link: node.type === 'link',
          extra: node.extra,
          onChange: (text: string) => handlers.onTextChange(node.id, text),
          onResize: handlers.onResize,
        },
      };
    }
    if (node.type === 'file') {
      return {
        ...common,
        type: 'file',
        data: {
          filePath: resolveCanvasFileRef(node.file, projectRoot),
          extra: node.extra,
          onOpen: handlers.onOpenFile,
          onResize: handlers.onResize,
        },
      };
    }
    return {
      ...common,
      type: 'group',
      zIndex: -1,
      selectable: true,
      data: {
        label: node.label,
        color: node.color ?? handlers.groupPalette[0],
        palette: handlers.groupPalette,
        extra: node.extra,
        onLabelChange: (label: string) => handlers.onGroupLabelChange(node.id, label),
        onColorChange: (color: string) => handlers.onGroupColorChange(node.id, color),
        onResize: handlers.onResize,
      },
    };
  });
  const edges: Edge[] = data.edges.map((edge) => ({
    id: edge.id,
    source: edge.fromNode,
    target: edge.toNode,
    sourceHandle: edge.fromSide ?? DEFAULT_FROM_SIDE,
    targetHandle: edge.toSide ?? DEFAULT_TO_SIDE,
    label: edge.label,
    data: {
      extra: edge.extra,
      implicitFromSide: edge.fromSide === undefined,
      implicitToSide: edge.toSide === undefined,
    } satisfies CanvasEdgeData,
  }));
  return { nodes, edges };
}

function flowDimension(node: Node, key: 'width' | 'height', fallback: number): number {
  return Math.round(node[key] ?? node.measured?.[key] ?? fallback);
}

function sideForDisk(handle: string | null | undefined, implicit: boolean | undefined, implicitDefault: CanvasSide): CanvasSide | undefined {
  const side = asSide(handle);
  // Keep a side-less edge side-less unless the user re-attached it elsewhere.
  if (implicit && (side === undefined || side === implicitDefault)) return undefined;
  return side;
}

/** Notes inside `projectRoot` are written project-relative, including links loaded as absolute paths. */
export function flowToCanvas(
  nodes: readonly Node[],
  edges: readonly Edge[],
  extra: Extra,
  projectRoot: string | null = null,
): CanvasDiskData {
  const diskNodes: CanvasDiskNode[] = nodes.map((node) => {
    const data = node.data as Record<string, unknown>;
    const base: CanvasNodeBase = {
      id: node.id,
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
      width: flowDimension(node, 'width', 220),
      height: flowDimension(node, 'height', 120),
      extra: asObject(data.extra) ?? {},
    };
    if (node.type === 'file') {
      return { ...base, type: 'file', file: typeof data.filePath === 'string' ? toCanvasFileRef(data.filePath, projectRoot) : '' };
    }
    if (node.type === 'group') {
      return {
        ...base,
        type: 'group',
        label: typeof data.label === 'string' ? data.label : '',
        color: typeof data.color === 'string' ? data.color : undefined,
      };
    }
    const text = typeof data.text === 'string' ? data.text : '';
    return data.link === true ? { ...base, type: 'link', url: text } : { ...base, type: 'text', text };
  });
  const diskEdges: CanvasDiskEdge[] = edges.map((edge) => {
    const data = (edge.data ?? {}) as CanvasEdgeData;
    return {
      id: edge.id,
      fromNode: edge.source,
      toNode: edge.target,
      fromSide: sideForDisk(edge.sourceHandle, data.implicitFromSide, DEFAULT_FROM_SIDE),
      toSide: sideForDisk(edge.targetHandle, data.implicitToSide, DEFAULT_TO_SIDE),
      label: typeof edge.label === 'string' ? edge.label : undefined,
      extra: asObject(data.extra) ?? {},
    };
  });
  return { nodes: diskNodes, edges: diskEdges, extra };
}
