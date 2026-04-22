import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * [contract] extensionStore — backs the sidebar icon strip + file-handler
 * registry. Built-in panels (AI Talk, AI Agent) are always present; plugin
 * panels are merged in from `commands.listPlugins()` at startup.
 */

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    listPlugins: vi.fn(),
    getPluginsDir: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  // Tests assert entryUrl carries the plugin-dir prefix; a trivial
  // convertFileSrc lets us verify without spinning up the asset scope.
  convertFileSrc: (p: string) => `asset://${p}`,
}));

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn().mockResolvedValue('/home/test'),
}));

import { extensionStore } from '$lib/stores/extensions.svelte';
import { commands } from '$lib/ipc/commands';

function resetStore() {
  // Re-seed the built-ins so each test starts from the published contract.
  extensionStore.panels = [
    { pluginId: 'ai-talk', type: 'panel', label: 'AI Talk', entryUrl: '', builtin: true },
    { pluginId: 'ai-agent', type: 'panel', label: 'AI Agent', entryUrl: '', builtin: true },
  ];
  extensionStore.fileHandlers = [];
  extensionStore.activePanelId = null;
}

describe('[contract] extensionStore — initial state', () => {
  it('exposes the two built-in panels (ai-talk + ai-agent)', () => {
    resetStore();
    const ids = extensionStore.panels.map(p => p.pluginId);
    expect(ids).toContain('ai-talk');
    expect(ids).toContain('ai-agent');
    expect(extensionStore.panels.every(p => p.builtin)).toBe(true);
  });

  it('starts with no active panel and no file handlers', () => {
    resetStore();
    expect(extensionStore.activePanelId).toBeNull();
    expect(extensionStore.fileHandlers).toEqual([]);
  });
});

describe('[contract] extensionStore.togglePanel / openPanel', () => {
  beforeEach(resetStore);

  it('togglePanel opens a panel when none is active', () => {
    extensionStore.togglePanel('ai-talk');
    expect(extensionStore.activePanelId).toBe('ai-talk');
  });

  it('togglePanel closes the active panel when toggled again', () => {
    extensionStore.togglePanel('ai-talk');
    extensionStore.togglePanel('ai-talk');
    expect(extensionStore.activePanelId).toBeNull();
  });

  it('togglePanel switches directly to a different panel (active -> new active)', () => {
    extensionStore.togglePanel('ai-talk');
    // Toggling a different id should just replace (no close + reopen).
    extensionStore.togglePanel('ai-agent');
    expect(extensionStore.activePanelId).toBe('ai-agent');
  });

  it('openPanel always sets the active id (no close-on-repeat)', () => {
    extensionStore.openPanel('ai-talk');
    expect(extensionStore.activePanelId).toBe('ai-talk');
    extensionStore.openPanel('ai-talk');
    expect(extensionStore.activePanelId).toBe('ai-talk');
  });
});

describe('[contract] extensionStore.getFileHandler', () => {
  beforeEach(() => {
    resetStore();
    extensionStore.fileHandlers = [
      {
        pluginId: 'canvas',
        type: 'file-handler',
        label: 'Canvas',
        entryUrl: 'asset:///canvas/index.html',
        fileExtensions: ['.canvas'],
      },
      {
        pluginId: 'kanban',
        type: 'file-handler',
        label: 'Kanban',
        entryUrl: 'asset:///kanban/index.html',
        fileExtensions: ['.kanban', '.board'],
      },
    ];
  });

  it('returns the matching handler by extension', () => {
    const h = extensionStore.getFileHandler('map.canvas');
    expect(h?.pluginId).toBe('canvas');
  });

  it('matches case-insensitively on filename', () => {
    const h = extensionStore.getFileHandler('BOARD.KANBAN');
    expect(h?.pluginId).toBe('kanban');
  });

  it('matches any of a handler\'s registered extensions', () => {
    const h = extensionStore.getFileHandler('sprint.board');
    expect(h?.pluginId).toBe('kanban');
  });

  it('returns null for an unmatched filename', () => {
    expect(extensionStore.getFileHandler('plain.md')).toBeNull();
  });

  it('returns null for an empty filename (guard)', () => {
    expect(extensionStore.getFileHandler('')).toBeNull();
  });

  it('ignores handlers with no fileExtensions array', () => {
    extensionStore.fileHandlers = [
      { pluginId: 'x', type: 'file-handler', label: 'X', entryUrl: '' },
    ];
    expect(extensionStore.getFileHandler('anything.md')).toBeNull();
  });
});

describe('[contract] extensionStore.loadFromPlugins', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    (commands.getPluginsDir as any).mockResolvedValue({ status: 'ok', data: '/plugins' });
  });

  it('resets to built-ins only when IPC returns an error', async () => {
    (commands.listPlugins as any).mockResolvedValue({ status: 'error', error: 'boom' });
    // Seed some dirty state to prove it gets replaced.
    extensionStore.panels.push({
      pluginId: 'ghost', type: 'panel', label: 'Ghost', entryUrl: '',
    });
    extensionStore.fileHandlers.push({
      pluginId: 'ghost', type: 'file-handler', label: 'G', entryUrl: '',
    });

    await extensionStore.loadFromPlugins();

    expect(extensionStore.panels.map(p => p.pluginId)).toEqual(['ai-talk', 'ai-agent']);
    expect(extensionStore.fileHandlers).toEqual([]);
  });

  it('resets to built-ins only when listPlugins throws (caught by catch block)', async () => {
    (commands.listPlugins as any).mockRejectedValue(new Error('crash'));
    await extensionStore.loadFromPlugins();
    expect(extensionStore.panels.map(p => p.pluginId)).toEqual(['ai-talk', 'ai-agent']);
    expect(extensionStore.fileHandlers).toEqual([]);
  });

  it('merges discovered panel + file-handler plugins on top of built-ins', async () => {
    (commands.listPlugins as any).mockResolvedValue({
      status: 'ok',
      data: [
        {
          id: 'mindmap',
          name: 'Mindmap',
          version: '1.0.0',
          permissions: [],
          active: true,
          description: null,
          author: null,
          icon: null,
          builtin: false,
          enabled: true,
          ui: {
            type: 'panel',
            entry: 'index.html',
            width: 320,
            label: 'Mind Map',
            file_extensions: null,
          },
        },
        {
          id: 'canvas',
          name: 'Canvas',
          version: '1.0.0',
          permissions: [],
          active: true,
          description: null,
          author: null,
          icon: null,
          builtin: false,
          enabled: true,
          ui: {
            type: 'file-handler',
            entry: 'app.html',
            width: null,
            label: 'Canvas',
            file_extensions: ['.canvas'],
          },
        },
      ],
    });

    await extensionStore.loadFromPlugins();

    expect(extensionStore.panels.map(p => p.pluginId)).toEqual(['ai-talk', 'ai-agent', 'mindmap']);
    const mindmap = extensionStore.panels.find(p => p.pluginId === 'mindmap')!;
    expect(mindmap.width).toBe(320);
    expect(mindmap.label).toBe('Mind Map');
    expect(mindmap.entryUrl).toBe('asset:///plugins/mindmap/index.html');

    expect(extensionStore.fileHandlers).toHaveLength(1);
    expect(extensionStore.fileHandlers[0].pluginId).toBe('canvas');
    expect(extensionStore.fileHandlers[0].fileExtensions).toEqual(['.canvas']);
  });

  it('skips plugins that collide with a built-in id (avoid double-listing)', async () => {
    (commands.listPlugins as any).mockResolvedValue({
      status: 'ok',
      data: [
        {
          id: 'ai-talk', // collides with built-in
          name: 'Shadow AI Talk',
          version: '1.0.0',
          permissions: [],
          active: true,
          description: null,
          author: null,
          icon: null,
          builtin: false,
          enabled: true,
          ui: { type: 'panel', entry: 'idx.html', width: null, label: null, file_extensions: null },
        },
      ],
    });

    await extensionStore.loadFromPlugins();

    // Still only two entries (the built-in wins; no duplicate).
    expect(extensionStore.panels).toHaveLength(2);
    expect(extensionStore.panels.find(p => p.pluginId === 'ai-talk')?.builtin).toBe(true);
  });

  it('skips plugins with no ui block (non-UI plugins)', async () => {
    (commands.listPlugins as any).mockResolvedValue({
      status: 'ok',
      data: [
        {
          id: 'background-worker',
          name: 'Worker',
          version: '1.0.0',
          permissions: [],
          active: true,
          description: null,
          author: null,
          icon: null,
          builtin: false,
          enabled: true,
          ui: null,
        },
      ],
    });

    await extensionStore.loadFromPlugins();

    expect(extensionStore.panels).toHaveLength(2); // only built-ins
    expect(extensionStore.fileHandlers).toEqual([]);
  });

  it('falls back to homeDir-derived plugins dir when getPluginsDir returns error', async () => {
    (commands.getPluginsDir as any).mockResolvedValue({ status: 'error', error: 'no' });
    (commands.listPlugins as any).mockResolvedValue({
      status: 'ok',
      data: [
        {
          id: 'mindmap',
          name: 'Mindmap',
          version: '1.0.0',
          permissions: [],
          active: true,
          description: null,
          author: null,
          icon: null,
          builtin: false,
          enabled: true,
          ui: { type: 'panel', entry: 'index.html', width: null, label: null, file_extensions: null },
        },
      ],
    });

    await extensionStore.loadFromPlugins();

    const mindmap = extensionStore.panels.find(p => p.pluginId === 'mindmap')!;
    // The fallback path constructs `${home}/.novelist/plugins/<id>/<entry>`.
    expect(mindmap.entryUrl).toBe('asset:///home/test/.novelist/plugins/mindmap/index.html');
  });

  it('uses plugin.name as panel label when ui.label is missing', async () => {
    (commands.listPlugins as any).mockResolvedValue({
      status: 'ok',
      data: [
        {
          id: 'mindmap',
          name: 'Mindmap Plugin',
          version: '1.0.0',
          permissions: [],
          active: true,
          description: null,
          author: null,
          icon: null,
          builtin: false,
          enabled: true,
          ui: { type: 'panel', entry: 'index.html', width: null, label: null, file_extensions: null },
        },
      ],
    });

    await extensionStore.loadFromPlugins();

    const mindmap = extensionStore.panels.find(p => p.pluginId === 'mindmap')!;
    expect(mindmap.label).toBe('Mindmap Plugin');
  });
});
