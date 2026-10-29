import { describe, expect, it } from 'vitest';
import { canReadCanvasFile, resolveCanvasFileRef, toCanvasFileRef } from '$lib/components/canvas/file-ref';
import {
  canvasToFlow,
  flowToCanvas,
  parseCanvas,
  serializeCanvas,
  type CanvasFlowHandlers,
} from '$lib/components/canvas/canvas-format';

const DESKTOP_ROOT = '/Users/me/Novels/Test Novel';
const IOS_ROOT = '/var/mobile/Containers/Data/Application/8F2C/Documents/Novelist/Test Novel';

const handlers: CanvasFlowHandlers = {
  onTextChange: () => {},
  onOpenFile: () => {},
  onGroupLabelChange: () => {},
  onGroupColorChange: () => {},
  onResize: () => {},
  groupPalette: ['#000'],
};

/** Load a canvas under `root` and save it again, as CanvasInner does. */
function reopen(content: string, root: string | null) {
  const parsed = parseCanvas(content);
  if (!parsed.ok) throw new Error(parsed.error);
  const flow = canvasToFlow(parsed.data, handlers, root);
  const filePaths = flow.nodes.filter((n) => n.type === 'file').map((n) => String(n.data.filePath));
  const saved = JSON.parse(serializeCanvas(flowToCanvas(flow.nodes, flow.edges, parsed.data.extra, root))) as {
    nodes: Array<{ file?: string }>;
  };
  return { filePaths, storedRefs: saved.nodes.map((n) => n.file) };
}

const canvasWith = (...files: string[]) => JSON.stringify({
  nodes: files.map((file, i) => ({ id: `n${i}`, type: 'file', x: 0, y: 0, width: 260, height: 160, file })),
  edges: [],
});

describe('canvas file references', () => {
  it('stores notes inside the project relative to its root', () => {
    expect(toCanvasFileRef(`${DESKTOP_ROOT}/Notes/outline.md`, DESKTOP_ROOT)).toBe('Notes/outline.md');
    expect(toCanvasFileRef('C:\\Novels\\Test\\Notes\\a.md', 'C:\\Novels\\Test')).toBe('Notes/a.md');
  });

  it('keeps external links, sibling folders with a shared prefix and URIs exactly as given', () => {
    expect(toCanvasFileRef('/Users/me/elsewhere.md', DESKTOP_ROOT)).toBe('/Users/me/elsewhere.md');
    expect(toCanvasFileRef(`${DESKTOP_ROOT} 2/a.md`, DESKTOP_ROOT)).toBe(`${DESKTOP_ROOT} 2/a.md`);
    expect(toCanvasFileRef('content://media/a.md', DESKTOP_ROOT)).toBe('content://media/a.md');
    expect(resolveCanvasFileRef('/Users/me/elsewhere.md', IOS_ROOT)).toBe('/Users/me/elsewhere.md');
  });

  it('resolves the same stored link under whichever root the project now has', () => {
    expect(resolveCanvasFileRef('Notes/outline.md', DESKTOP_ROOT)).toBe(`${DESKTOP_ROOT}/Notes/outline.md`);
    expect(resolveCanvasFileRef('Notes/outline.md', IOS_ROOT)).toBe(`${IOS_ROOT}/Notes/outline.md`);
    expect(resolveCanvasFileRef('Notes/a.md', 'C:\\Novels\\Test')).toBe('C:\\Novels\\Test\\Notes\\a.md');
  });

  it('a canvas saved on one device loads its notes at a relocated root and stays relative', () => {
    const savedOnDesktop = reopen(canvasWith(`${DESKTOP_ROOT}/Notes/outline.md`), DESKTOP_ROOT);
    expect(savedOnDesktop.storedRefs).toEqual(['Notes/outline.md']);

    const onIos = reopen(canvasWith(...(savedOnDesktop.storedRefs as string[])), IOS_ROOT);
    expect(onIos.filePaths).toEqual([`${IOS_ROOT}/Notes/outline.md`]);
    expect(onIos.storedRefs).toEqual(['Notes/outline.md']);
  });

  it('does not reinterpret an old device absolute path or a link with no open project', () => {
    const stale = `${DESKTOP_ROOT}/Notes/outline.md`;
    expect(reopen(canvasWith(stale), IOS_ROOT)).toEqual({ filePaths: [stale], storedRefs: [stale] });
    expect(reopen(canvasWith('Notes/outline.md'), null)).toEqual({
      filePaths: ['Notes/outline.md'],
      storedRefs: ['Notes/outline.md'],
    });
  });
});

describe('canvas file read boundary', () => {
  it('never joins a traversal ref into a path outside the project', () => {
    expect(resolveCanvasFileRef('../Library/Preferences/secrets.plist', IOS_ROOT)).toBe('../Library/Preferences/secrets.plist');
    expect(resolveCanvasFileRef('Notes/../../x.md', IOS_ROOT)).toBe('Notes/../../x.md');
    expect(resolveCanvasFileRef('Notes/../outline.md', IOS_ROOT)).toBe(`${IOS_ROOT}/Notes/../outline.md`);
    expect(canReadCanvasFile('../Library/Preferences/secrets.plist', IOS_ROOT, false)).toBe(false);
  });

  it('on mobile reads only notes inside the open project', () => {
    expect(canReadCanvasFile(`${IOS_ROOT}/Notes/outline.md`, IOS_ROOT, true)).toBe(true);
    expect(canReadCanvasFile(`${DESKTOP_ROOT}/Notes/outline.md`, IOS_ROOT, true)).toBe(false);
    expect(canReadCanvasFile(`${IOS_ROOT}/../Library/settings.json`, IOS_ROOT, true)).toBe(false);
    expect(canReadCanvasFile('content://media/a.md', IOS_ROOT, true)).toBe(false);
    expect(canReadCanvasFile(`${IOS_ROOT}/Notes/outline.md`, null, true)).toBe(false);
  });

  it('on desktop keeps reading external links the user created', () => {
    expect(canReadCanvasFile('/Users/me/elsewhere.md', DESKTOP_ROOT, false)).toBe(true);
    expect(canReadCanvasFile('Notes/outline.md', null, false)).toBe(false);
  });
});
