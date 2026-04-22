import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * [contract] registerAppCommands — central command registration site. We
 * capture every register() call, then exercise a representative sample of
 * handlers to prove wiring (not logic — the downstream units have their
 * own tests).
 */

type RegisterCall = {
  id: string;
  label: string;
  shortcut?: string;
  handler: (...args: unknown[]) => unknown;
};

const { register, shortcuts, uiCalls, projectState, tabsState, extensionState, aiTalkCreate, aiAgentCreate, fmt, translatedKeys } = vi.hoisted(() => {
  const register = vi.fn();
  const shortcuts = new Map<string, string>();
  const uiCalls: string[] = [];
  const projectState = { dirPath: null as null | string };
  const tabsState = {
    activeTab: null as null | { id: string; fileName: string },
    toggleSplit: vi.fn(),
  };
  const extensionState = {
    activePanelId: null as null | string,
    togglePanel: vi.fn(),
    openPanel: vi.fn((id: string) => { extensionState.activePanelId = id; }),
  };
  const aiTalkCreate = vi.fn();
  const aiAgentCreate = vi.fn();
  const fmt = {
    toggleWrap: vi.fn(),
    wrapSelection: vi.fn(),
    toggleLinePrefix: vi.fn(),
  };
  const translatedKeys: string[] = [];
  return { register, shortcuts, uiCalls, projectState, tabsState, extensionState, aiTalkCreate, aiAgentCreate, fmt, translatedKeys };
});

vi.mock('$lib/stores/commands.svelte', () => ({
  commandRegistry: { register },
}));

vi.mock('$lib/stores/shortcuts.svelte', () => ({
  shortcutsStore: { get: (id: string) => shortcuts.get(id) ?? `Stub+${id}` },
}));

vi.mock('$lib/stores/ui.svelte', () => ({
  uiStore: new Proxy({}, {
    get: (_t, prop: string) => (...args: unknown[]) => { uiCalls.push(`${prop}(${args.join(',')})`); },
  }),
}));

vi.mock('$lib/stores/tabs.svelte', () => ({
  tabsStore: {
    get activeTab() { return tabsState.activeTab; },
    toggleSplit: tabsState.toggleSplit,
  },
}));

vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: {
    get dirPath() { return projectState.dirPath; },
  },
}));

vi.mock('$lib/stores/extensions.svelte', () => ({
  extensionStore: {
    get activePanelId() { return extensionState.activePanelId; },
    togglePanel: extensionState.togglePanel,
    openPanel: extensionState.openPanel,
  },
}));

vi.mock('$lib/components/ai-talk/sessions.svelte', () => ({
  aiTalkSessions: { create: aiTalkCreate },
}));

vi.mock('$lib/components/ai-agent/sessions.svelte', () => ({
  aiAgentSessions: { create: aiAgentCreate },
}));

vi.mock('$lib/editor/formatting', () => fmt);

// Dynamic-import targets — vi.mock intercepts both static and dynamic imports.
const simplifiedToTraditional = vi.fn(async (s: string) => `T:${s}`);
const traditionalToSimplified = vi.fn(async (s: string) => `S:${s}`);
const toPinyin = vi.fn(async (s: string) => `P:${s}`);
const markdownToHtml = vi.fn((s: string) => `<p>${s}</p>`);
const markdownToPlainText = vi.fn((s: string) => `plain:${s}`);
const runBenchmark = vi.fn(async (_n: number) => 'bench-ok');
const runReleaseBenchmark = vi.fn(async () => 'release-ok');
const runScrollEditTest = vi.fn(async () => 'scroll-ok');
const checkForUpdates = vi.fn(async (_silent: boolean) => {});

vi.mock('$lib/utils/chinese', () => ({ simplifiedToTraditional, traditionalToSimplified, toPinyin }));
vi.mock('$lib/utils/markdown-copy', () => ({ markdownToHtml, markdownToPlainText }));
vi.mock('$lib/utils/benchmark', () => ({ runBenchmark, runReleaseBenchmark }));
vi.mock('$lib/utils/scroll-edit-test', () => ({ runScrollEditTest }));
vi.mock('$lib/updater', () => ({ checkForUpdates }));

import { registerAppCommands, type AppCommandContext } from '$lib/app-commands';

function ctx(over: Partial<AppCommandContext> = {}): AppCommandContext {
  const noop = vi.fn();
  return {
    t: (k: string) => { translatedKeys.push(k); return k; },
    getActiveEditorView: () => null,
    renameCurrentFile: noop,
    openNewWindow: noop,
    handleNewFile: noop,
    handleNewScratchFile: noop,
    handleOpenDirectory: noop,
    handleCloseTab: noop,
    handleGoToLine: noop,
    saveCurrentFileAsTemplate: noop,
    togglePalette: noop,
    openMovePalette: noop,
    toggleProjectSearch: noop,
    openExportDialog: noop,
    openNewProjectDialog: noop,
    toggleMindmapOverlay: noop,
    requestProjectSwitcher: noop,
    ...over,
  };
}

function registered(): RegisterCall[] {
  return register.mock.calls.map((call) => call[0] as RegisterCall);
}

function handlerFor(id: string): RegisterCall['handler'] {
  const h = registered().find((r) => r.id === id);
  if (!h) throw new Error(`command ${id} was not registered`);
  return h.handler;
}

beforeEach(() => {
  register.mockClear();
  shortcuts.clear();
  uiCalls.length = 0;
  translatedKeys.length = 0;
  projectState.dirPath = null;
  tabsState.activeTab = null;
  tabsState.toggleSplit.mockClear();
  extensionState.activePanelId = null;
  extensionState.togglePanel.mockClear();
  extensionState.openPanel.mockClear();
  aiTalkCreate.mockClear();
  aiAgentCreate.mockClear();
  fmt.toggleWrap.mockClear();
  fmt.wrapSelection.mockClear();
  fmt.toggleLinePrefix.mockClear();
  simplifiedToTraditional.mockClear();
  traditionalToSimplified.mockClear();
  toPinyin.mockClear();
  markdownToHtml.mockClear();
  markdownToPlainText.mockClear();
  runBenchmark.mockClear();
  runReleaseBenchmark.mockClear();
  runScrollEditTest.mockClear();
  checkForUpdates.mockClear();
});

describe('[contract] registerAppCommands — registration shape', () => {
  it('registers every known command exactly once with stable ids', () => {
    registerAppCommands(ctx());
    const ids = registered().map((r) => r.id);
    // Sanity: no dupes.
    expect(new Set(ids).size).toBe(ids.length);
    // Anchor a representative subset — add/remove freely, but core IDs should stay.
    for (const anchor of [
      'toggle-sidebar', 'toggle-outline', 'toggle-zen', 'command-palette',
      'new-file', 'new-project', 'open-directory', 'close-tab',
      'rename-file', 'open-settings', 'go-to-line', 'toggle-mindmap',
      'toggle-ai-talk', 'toggle-ai-agent', 'ai-talk-new-session', 'ai-agent-new-session',
      'editor-bold', 'editor-italic', 'editor-link', 'editor-heading',
      'chinese-s2t', 'chinese-t2s', 'chinese-pinyin',
      'copy-rich-text', 'copy-plain-text',
      'run-benchmark', 'run-scroll-test', 'check-for-updates',
    ]) {
      expect(ids).toContain(anchor);
    }
  });

  it('uses shortcutsStore.get for every command that has a shortcut slot', () => {
    shortcuts.set('toggle-sidebar', 'Mod-1');
    registerAppCommands(ctx());
    const r = registered().find((x) => x.id === 'toggle-sidebar')!;
    expect(r.shortcut).toBe('Mod-1');
  });
});

describe('[contract] ui toggles', () => {
  it('wires toggle-sidebar → uiStore.toggleSidebar', () => {
    registerAppCommands(ctx());
    handlerFor('toggle-sidebar')();
    expect(uiCalls).toContain('toggleSidebar()');
  });

  it('wires open-settings → uiStore.toggleSettings', () => {
    registerAppCommands(ctx());
    handlerFor('open-settings')();
    expect(uiCalls).toContain('toggleSettings()');
  });

  it('wires toggle-split → tabsStore.toggleSplit', () => {
    registerAppCommands(ctx());
    handlerFor('toggle-split')();
    expect(tabsState.toggleSplit).toHaveBeenCalled();
  });
});

describe('[contract] new-file branch', () => {
  it('dispatches to handleNewFile when a project is open', () => {
    const handleNewFile = vi.fn();
    const handleNewScratchFile = vi.fn();
    projectState.dirPath = '/proj';
    registerAppCommands(ctx({ handleNewFile, handleNewScratchFile }));
    handlerFor('new-file')();
    expect(handleNewFile).toHaveBeenCalled();
    expect(handleNewScratchFile).not.toHaveBeenCalled();
  });

  it('dispatches to handleNewScratchFile when no project is open', () => {
    const handleNewFile = vi.fn();
    const handleNewScratchFile = vi.fn();
    projectState.dirPath = null;
    registerAppCommands(ctx({ handleNewFile, handleNewScratchFile }));
    handlerFor('new-file')();
    expect(handleNewFile).not.toHaveBeenCalled();
    expect(handleNewScratchFile).toHaveBeenCalled();
  });
});

describe('[contract] move-file gating', () => {
  it('only opens the move palette when a tab is active AND a project is open', () => {
    const openMovePalette = vi.fn();
    registerAppCommands(ctx({ openMovePalette }));
    handlerFor('move-file')();
    expect(openMovePalette).not.toHaveBeenCalled();

    tabsState.activeTab = { id: 'a', fileName: 'a.md' };
    projectState.dirPath = '/proj';
    handlerFor('move-file')();
    expect(openMovePalette).toHaveBeenCalledTimes(1);
  });
});

describe('[contract] AI panel commands', () => {
  it('toggle-ai-talk and toggle-ai-agent flip the active panel', () => {
    registerAppCommands(ctx());
    handlerFor('toggle-ai-talk')();
    handlerFor('toggle-ai-agent')();
    expect(extensionState.togglePanel).toHaveBeenNthCalledWith(1, 'ai-talk');
    expect(extensionState.togglePanel).toHaveBeenNthCalledWith(2, 'ai-agent');
  });

  it('ai-talk-new-session opens the panel first if it is not already active', () => {
    extensionState.activePanelId = 'ai-agent';
    registerAppCommands(ctx());
    handlerFor('ai-talk-new-session')();
    expect(extensionState.openPanel).toHaveBeenCalledWith('ai-talk');
    expect(aiTalkCreate).toHaveBeenCalled();
  });

  it('ai-agent-new-session skips openPanel when already on ai-agent', () => {
    extensionState.activePanelId = 'ai-agent';
    registerAppCommands(ctx());
    handlerFor('ai-agent-new-session')();
    expect(extensionState.openPanel).not.toHaveBeenCalled();
    expect(aiAgentCreate).toHaveBeenCalled();
  });

  it('ai-talk-save-chat fires the DOM event for the active panel to catch', () => {
    registerAppCommands(ctx());
    const heard: string[] = [];
    const listener = (e: Event) => heard.push(e.type);
    window.addEventListener('novelist:ai-talk:save-chat', listener);
    try {
      handlerFor('ai-talk-save-chat')();
    } finally {
      window.removeEventListener('novelist:ai-talk:save-chat', listener);
    }
    expect(heard).toEqual(['novelist:ai-talk:save-chat']);
  });
});

describe('[contract] editor formatting commands', () => {
  it('editor-bold with an active view calls fmt.toggleWrap("**")', () => {
    const view = {} as any;
    registerAppCommands(ctx({ getActiveEditorView: () => view }));
    handlerFor('editor-bold')();
    expect(fmt.toggleWrap).toHaveBeenCalledWith(view, '**');
  });

  it('editor-bold with no active view does nothing', () => {
    registerAppCommands(ctx({ getActiveEditorView: () => null }));
    handlerFor('editor-bold')();
    expect(fmt.toggleWrap).not.toHaveBeenCalled();
  });

  it('editor-link wraps selection with `[` and `](url)`', () => {
    const view = {} as any;
    registerAppCommands(ctx({ getActiveEditorView: () => view }));
    handlerFor('editor-link')();
    expect(fmt.wrapSelection).toHaveBeenCalledWith(view, '[', '](url)');
  });

  it('editor-heading toggles the `#` line prefix', () => {
    const view = {} as any;
    registerAppCommands(ctx({ getActiveEditorView: () => view }));
    handlerFor('editor-heading')();
    expect(fmt.toggleLinePrefix).toHaveBeenCalledWith(view, '#');
  });
});

describe('[contract] chinese text commands', () => {
  function viewWith(doc: string, from: number, to: number) {
    return {
      state: {
        doc: { length: doc.length, toString: () => doc },
        selection: { main: { from, to } },
        sliceDoc: (a: number, b: number) => doc.slice(a, b),
      },
      dispatch: vi.fn(),
    } as any;
  }

  it('chinese-s2t replaces the whole doc when there is no selection', async () => {
    const v = viewWith('你好', 0, 0);
    registerAppCommands(ctx({ getActiveEditorView: () => v }));
    await (handlerFor('chinese-s2t')() as unknown as Promise<void>);
    expect(simplifiedToTraditional).toHaveBeenCalledWith('你好');
    expect(v.dispatch).toHaveBeenCalledWith({ changes: { from: 0, to: 2, insert: 'T:你好' } });
  });

  it('chinese-t2s replaces the selection and reselects the converted range', async () => {
    const v = viewWith('hello', 1, 4);
    registerAppCommands(ctx({ getActiveEditorView: () => v }));
    await (handlerFor('chinese-t2s')() as unknown as Promise<void>);
    expect(traditionalToSimplified).toHaveBeenCalledWith('ell');
    expect(v.dispatch).toHaveBeenCalledWith({
      changes: { from: 1, to: 4, insert: 'S:ell' },
      selection: { anchor: 1, head: 1 + 'S:ell'.length },
    });
  });

  it('chinese-pinyin no-ops when there is no selection', async () => {
    const v = viewWith('abc', 2, 2);
    registerAppCommands(ctx({ getActiveEditorView: () => v }));
    await (handlerFor('chinese-pinyin')() as unknown as Promise<void>);
    expect(toPinyin).not.toHaveBeenCalled();
  });

  it('chinese-pinyin writes the pinyin text to the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const v = viewWith('你好世界', 0, 4);
    registerAppCommands(ctx({ getActiveEditorView: () => v }));
    await (handlerFor('chinese-pinyin')() as unknown as Promise<void>);
    expect(toPinyin).toHaveBeenCalledWith('你好世界');
    expect(writeText).toHaveBeenCalledWith('P:你好世界');
  });

  it('every chinese command no-ops when there is no active view', async () => {
    registerAppCommands(ctx({ getActiveEditorView: () => null }));
    await (handlerFor('chinese-s2t')() as unknown as Promise<void>);
    await (handlerFor('chinese-t2s')() as unknown as Promise<void>);
    await (handlerFor('chinese-pinyin')() as unknown as Promise<void>);
    expect(simplifiedToTraditional).not.toHaveBeenCalled();
    expect(traditionalToSimplified).not.toHaveBeenCalled();
    expect(toPinyin).not.toHaveBeenCalled();
  });
});

describe('[contract] copy-rich-text / copy-plain-text', () => {
  function viewWith(doc: string, from: number, to: number) {
    return {
      state: {
        doc: { length: doc.length, toString: () => doc },
        selection: { main: { from, to } },
        sliceDoc: (a: number, b: number) => doc.slice(a, b),
      },
    } as any;
  }

  it('copy-rich-text writes HTML+plain when ClipboardItem succeeds', async () => {
    const write = vi.fn(async () => {});
    const writeText = vi.fn();
    // Provide ClipboardItem (happy-dom doesn't ship one by default).
    (globalThis as any).ClipboardItem = class { constructor(public data: Record<string, Blob>) {} };
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { write, writeText },
    });
    const v = viewWith('# hi', 0, 0);
    registerAppCommands(ctx({ getActiveEditorView: () => v }));
    await (handlerFor('copy-rich-text')() as unknown as Promise<void>);
    expect(markdownToHtml).toHaveBeenCalledWith('# hi');
    expect(write).toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('copy-rich-text falls back to writeText when ClipboardItem write rejects', async () => {
    const write = vi.fn(async () => { throw new Error('denied'); });
    const writeText = vi.fn(async () => {});
    (globalThis as any).ClipboardItem = class { constructor(public data: Record<string, Blob>) {} };
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { write, writeText },
    });
    const v = viewWith('hello', 0, 0);
    registerAppCommands(ctx({ getActiveEditorView: () => v }));
    await (handlerFor('copy-rich-text')() as unknown as Promise<void>);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('copy-plain-text writes the markdown-stripped text', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const v = viewWith('# Title\nbody', 0, 0);
    registerAppCommands(ctx({ getActiveEditorView: () => v }));
    await (handlerFor('copy-plain-text')() as unknown as Promise<void>);
    expect(markdownToPlainText).toHaveBeenCalledWith('# Title\nbody');
    expect(writeText).toHaveBeenCalledWith('plain:# Title\nbody');
  });

  it('both copy commands no-op with no active view', async () => {
    registerAppCommands(ctx({ getActiveEditorView: () => null }));
    await (handlerFor('copy-rich-text')() as unknown as Promise<void>);
    await (handlerFor('copy-plain-text')() as unknown as Promise<void>);
    expect(markdownToHtml).not.toHaveBeenCalled();
    expect(markdownToPlainText).not.toHaveBeenCalled();
  });
});

describe('[contract] diagnostics', () => {
  beforeEach(() => {
    (globalThis as any).alert = vi.fn();
  });

  it('run-benchmark alerts the runBenchmark result', async () => {
    registerAppCommands(ctx());
    await (handlerFor('run-benchmark')() as unknown as Promise<void>);
    expect(runBenchmark).toHaveBeenCalledWith(150000);
    expect((globalThis as any).alert).toHaveBeenCalledWith('bench-ok');
  });

  it('run-release-benchmark alerts the release result', async () => {
    registerAppCommands(ctx());
    await (handlerFor('run-release-benchmark')() as unknown as Promise<void>);
    expect(runReleaseBenchmark).toHaveBeenCalled();
    expect((globalThis as any).alert).toHaveBeenCalledWith('release-ok');
  });

  it('run-scroll-test alerts the scroll-edit result', async () => {
    registerAppCommands(ctx());
    await (handlerFor('run-scroll-test')() as unknown as Promise<void>);
    expect(runScrollEditTest).toHaveBeenCalled();
    expect((globalThis as any).alert).toHaveBeenCalledWith('scroll-ok');
  });

  it('check-for-updates delegates with silent=false', async () => {
    registerAppCommands(ctx());
    await (handlerFor('check-for-updates')() as unknown as Promise<void>);
    expect(checkForUpdates).toHaveBeenCalledWith(false);
  });
});

describe('[contract] high-level handlers delegate to ctx', () => {
  it.each([
    ['new-window', 'openNewWindow'],
    ['new-project', 'openNewProjectDialog'],
    ['switch-project', 'requestProjectSwitcher'],
    ['open-directory', 'handleOpenDirectory'],
    ['export-project', 'openExportDialog'],
    ['close-tab', 'handleCloseTab'],
    ['rename-file', 'renameCurrentFile'],
    ['go-to-line', 'handleGoToLine'],
    ['toggle-mindmap', 'toggleMindmapOverlay'],
    ['save-current-as-template', 'saveCurrentFileAsTemplate'],
    ['command-palette', 'togglePalette'],
    ['project-search', 'toggleProjectSearch'],
  ] as const)('%s → ctx.%s', (id, key) => {
    const fn = vi.fn();
    registerAppCommands(ctx({ [key]: fn } as any));
    handlerFor(id)();
    expect(fn).toHaveBeenCalled();
  });
});
