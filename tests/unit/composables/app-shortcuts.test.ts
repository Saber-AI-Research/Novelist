import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createKeydownHandler } from '$lib/composables/app-shortcuts.svelte';
import { commandRegistry } from '$lib/stores/commands.svelte';
import { shortcutsStore } from '$lib/stores/shortcuts.svelte';

/** Minimal KeyboardEvent stub with a spy-able preventDefault. */
function keyEvent(opts: {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
}): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    key: opts.key,
    code: opts.code ?? '',
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    target: opts.target ?? null,
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

/** `.cm-editor > .cm-content > table widget > td[contenteditable]`, returning both editable hosts. */
function editorWithTableCell(): { content: HTMLElement; cell: HTMLElement } {
  const editor = document.createElement('div');
  editor.className = 'cm-editor';
  const content = document.createElement('div');
  content.className = 'cm-content';
  content.setAttribute('contenteditable', 'true');
  const widget = document.createElement('div');
  widget.setAttribute('contenteditable', 'false');
  widget.innerHTML = '<table><tbody><tr><td class="cm-novelist-table-cell" contenteditable="true">单元格</td></tr></tbody></table>';
  content.appendChild(widget);
  editor.appendChild(content);
  return { content, cell: widget.querySelector('td')! };
}

/** Build a handler with spy-able context functions. */
function makeHandler() {
  const ctx = {
    openNewWindow: vi.fn(),
    saveActiveFile: vi.fn(),
    toggleProjectSearch: vi.fn(),
    getRecentProjects: vi.fn(() => []),
    openProjectFromPath: vi.fn(),
  };
  const handler = createKeydownHandler(ctx);
  return { handler, ctx };
}

describe('createKeydownHandler — hardcoded shortcuts', () => {
  it('Cmd+Shift+N opens a new window', () => {
    const { handler, ctx } = makeHandler();
    const e = keyEvent({ key: 'N', metaKey: true, shiftKey: true });
    handler(e);
    expect(ctx.openNewWindow).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('Cmd+S saves the active file', () => {
    const { handler, ctx } = makeHandler();
    handler(keyEvent({ key: 's', metaKey: true }));
    expect(ctx.saveActiveFile).toHaveBeenCalledOnce();
  });

  it('Cmd+Shift+F toggles project search', () => {
    const { handler, ctx } = makeHandler();
    handler(keyEvent({ key: 'F', metaKey: true, shiftKey: true }));
    expect(ctx.toggleProjectSearch).toHaveBeenCalledOnce();
  });

  it('Cmd+1..9 switches to recent project by index', () => {
    const { handler, ctx } = makeHandler();
    ctx.getRecentProjects.mockReturnValue([
      { path: '/a', name: 'a', lastOpened: 0 },
      { path: '/b', name: 'b', lastOpened: 0 },
    ] as unknown as ReturnType<typeof ctx.getRecentProjects>);
    handler(keyEvent({ key: '2', metaKey: true }));
    expect(ctx.openProjectFromPath).toHaveBeenCalledWith('/b');
  });

  it('Cmd+Shift+1 (with shift) does NOT trigger recent-project switch', () => {
    const { handler, ctx } = makeHandler();
    ctx.getRecentProjects.mockReturnValue([
      { path: '/a', name: 'a', lastOpened: 0 },
    ] as unknown as ReturnType<typeof ctx.getRecentProjects>);
    handler(keyEvent({ key: '1', metaKey: true, shiftKey: true }));
    expect(ctx.openProjectFromPath).not.toHaveBeenCalled();
  });
});

describe('createKeydownHandler — customizable shortcuts via command registry', () => {
  // Populate the registry so the handler has something to dispatch to.
  // We register fresh spy handlers per test to avoid leakage.
  let paletteHandler: () => void;
  let outlineHandler: () => void;
  let boldHandler: () => void;

  beforeEach(() => {
    // Wipe the registry — the tests own what's in it for this suite.
    commandRegistry.commands.splice(0);
    commandRegistry._resetDedupe();
    paletteHandler = vi.fn() as unknown as () => void;
    outlineHandler = vi.fn() as unknown as () => void;
    boldHandler = vi.fn() as unknown as () => void;
    commandRegistry.register({ id: 'command-palette', label: 'Palette', shortcut: 'Cmd+Shift+P', handler: paletteHandler });
    commandRegistry.register({ id: 'toggle-outline', label: 'Outline', shortcut: 'Cmd+Shift+1', handler: outlineHandler });
    commandRegistry.register({ id: 'editor-bold', label: 'Bold', shortcut: 'Cmd+B', handler: boldHandler });
    shortcutsStore.resetAll();
  });

  it('Cmd+Shift+P dispatches the command-palette command (regression: "all shortcuts fail")', () => {
    const { handler } = makeHandler();
    handler(keyEvent({ key: 'P', metaKey: true, shiftKey: true }));
    expect(paletteHandler).toHaveBeenCalledOnce();
  });

  it('Cmd+Shift+1 dispatches toggle-outline (literal digit)', () => {
    const { handler } = makeHandler();
    handler(keyEvent({ key: '1', code: 'Digit1', metaKey: true, shiftKey: true }));
    expect(outlineHandler).toHaveBeenCalledOnce();
  });

  it('Cmd+Shift+1 with e.key="!" still dispatches via e.code fallback', () => {
    // On many keyboard layouts, Shift+1 produces "!". Without the e.code
    // fallback, right-rail panel shortcuts silently stop firing.
    const { handler } = makeHandler();
    handler(keyEvent({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true }));
    expect(outlineHandler).toHaveBeenCalledOnce();
  });

  it('Cmd+B dispatches the bold formatting command', () => {
    const { handler } = makeHandler();
    handler(keyEvent({ key: 'b', metaKey: true }));
    expect(boldHandler).toHaveBeenCalledOnce();
  });

  it('unknown shortcut does not dispatch anything', () => {
    const { handler } = makeHandler();
    handler(keyEvent({ key: 'q', metaKey: true }));
    expect(paletteHandler).not.toHaveBeenCalled();
    expect(outlineHandler).not.toHaveBeenCalled();
    expect(boldHandler).not.toHaveBeenCalled();
  });

  it('plain letter (no modifier) is ignored — does not hit the registry', () => {
    const { handler } = makeHandler();
    handler(keyEvent({ key: 'b' }));
    expect(boldHandler).not.toHaveBeenCalled();
  });

  it('Cmd+B from the CodeMirror content still dispatches the editor command', () => {
    const { handler } = makeHandler();
    const { content } = editorWithTableCell();
    handler(keyEvent({ key: 'b', metaKey: true, target: content }));
    expect(boldHandler).toHaveBeenCalledOnce();
  });

  it('Cmd+B typed in an editable table cell inside the editor does not fire editor commands', () => {
    const { handler } = makeHandler();
    const { cell } = editorWithTableCell();
    const e = keyEvent({ key: 'b', metaKey: true, target: cell });
    handler(e);
    expect(boldHandler).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('Cmd+S typed in an editable table cell still saves', () => {
    const { handler, ctx } = makeHandler();
    const { cell } = editorWithTableCell();
    handler(keyEvent({ key: 's', metaKey: true, target: cell }));
    expect(ctx.saveActiveFile).toHaveBeenCalledOnce();
  });
});

describe('createKeydownHandler — no-op paths', () => {
  it('bare Escape without zen mode does not crash', () => {
    const { handler } = makeHandler();
    expect(() => handler(keyEvent({ key: 'Escape' }))).not.toThrow();
  });

  it('Ctrl+Tab cycles pane tabs (metaKey=false)', () => {
    // Dummy registration so the registry isn't empty — the handler still
    // routes Ctrl+Tab explicitly and should not fall through.
    commandRegistry.commands.splice(0);
    const { handler } = makeHandler();
    // Just assert it doesn't throw and calls preventDefault.
    const e = keyEvent({ key: 'Tab', ctrlKey: true });
    handler(e);
    expect(e.preventDefault).toHaveBeenCalled();
  });
});
