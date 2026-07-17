import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));

vi.mock('$lib/ipc/commands', () => ({
  commands: { readFile },
}));

vi.mock('$lib/i18n', () => ({ t: (key: string) => key }));

import { commands } from '$lib/ipc/commands';
import { projectStore } from '$lib/stores/project.svelte';
import {
  registerEditorView,
  registerViewportSnapshotMetadata,
  tabsStore,
  unregisterEditorView,
} from '$lib/stores/tabs.svelte';
import { capturePublishDocumentSnapshot } from '$lib/services/publish-document-snapshot';

const registeredViews: Array<{ tabId: string; view: EditorView }> = [];

function mountView(
  tabId: string,
  doc: string,
  selection?: { anchor: number; head: number },
): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = EditorState.create({ doc, selection });
  const view = new EditorView({ state, parent });
  registerEditorView(tabId, view);
  registeredViews.push({ tabId, view });
  return view;
}

afterEach(() => {
  for (const { tabId, view } of registeredViews) {
    unregisterEditorView(tabId);
    view.destroy();
  }
  registeredViews.length = 0;
  tabsStore.closeAll();
  projectStore.dirPath = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('[contract] capturePublishDocumentSnapshot', () => {
  it('captures the invoking pane live text and exact CJK main selection', () => {
    tabsStore.openTab('/project/第一章.md', 'pane one disk text');
    const paneOneTab = tabsStore.activeTab!;
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-2', '/project/第二章.md', 'pane two disk text');
    const paneTwoTab = tabsStore.getPaneActiveTab('pane-2')!;
    tabsStore.setActivePane('pane-2');
    projectStore.dirPath = '/project';

    const liveText = 'before 未保存 SELECTED 文本 after';
    const selectionText = '未保存 SELECTED 文本';
    const from = liveText.indexOf(selectionText);
    const to = from + selectionText.length;
    const paneOneView = mountView(paneOneTab.id, liveText, { anchor: from, head: to });
    mountView(paneTwoTab.id, 'globally active pane two live text');

    const result = capturePublishDocumentSnapshot('pane-1');

    expect(result).toMatchObject({
      kind: 'editor',
      paneId: 'pane-1',
      tabId: paneOneTab.id,
      filePath: '/project/第一章.md',
      documentDir: '/project',
      projectDir: '/project',
      fullText: liveText,
      mainSelection: { from, to, text: selectionText },
    });
    expect(result.kind === 'editor' && result.editorGeneration).toBe(paneOneView.state);
    expect(commands.readFile).not.toHaveBeenCalled();
  });

  it('keeps frozen text, selection, and generation after later editor changes', () => {
    const originalText = 'prefix 未保存 SELECTED 文本 suffix';
    const selectionText = '未保存 SELECTED 文本';
    const from = originalText.indexOf(selectionText);
    const to = from + selectionText.length;
    tabsStore.openTab('/project/draft.md', 'disk text');
    const tab = tabsStore.activeTab!;
    const view = mountView(tab.id, originalText, { anchor: from, head: to });

    const result = capturePublishDocumentSnapshot('pane-1');
    expect(result.kind).toBe('editor');
    if (result.kind !== 'editor') return;
    const generation = result.editorGeneration;

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'later replacement' },
      selection: { anchor: 0 },
    });

    expect(result.fullText).toBe(originalText);
    expect(result.mainSelection).toEqual({ from, to, text: selectionText });
    expect(result.editorGeneration).toBe(generation);
    expect(view.state).not.toBe(generation);
  });

  it('uses a null selection for an empty main range', () => {
    tabsStore.openTab('C:\\project\\empty-selection.md', 'disk text');
    const tab = tabsStore.activeTab!;
    mountView(tab.id, 'whole live document', { anchor: 5, head: 5 });

    const result = capturePublishDocumentSnapshot('pane-1');

    expect(result).toMatchObject({
      kind: 'editor',
      documentDir: 'C:\\project',
      fullText: 'whole live document',
      mainSelection: null,
    });
  });

  it('returns a typed blocker when the pane does not exist', () => {
    expect(capturePublishDocumentSnapshot('pane-missing')).toEqual({
      kind: 'blocked',
      code: 'pane_not_found',
      paneId: 'pane-missing',
    });
  });

  it('returns a typed blocker when the pane has no active tab', () => {
    expect(capturePublishDocumentSnapshot('pane-1')).toEqual({
      kind: 'blocked',
      code: 'active_tab_not_found',
      paneId: 'pane-1',
    });
  });

  it('returns a typed blocker when the active tab has no registered view', () => {
    tabsStore.openTab('/project/no-view.md', 'stored text must not be used');
    const tab = tabsStore.activeTab!;

    expect(capturePublishDocumentSnapshot('pane-1')).toEqual({
      kind: 'blocked',
      code: 'editor_view_unavailable',
      paneId: 'pane-1',
      tabId: tab.id,
    });
    expect(commands.readFile).not.toHaveBeenCalled();
  });

  it('returns a complete Rope source only when viewport metadata is registered', () => {
    tabsStore.openTab('/project/large.md', 'stored partial text must not be used');
    const tab = tabsStore.activeTab!;
    const windowText = 'window 未保存片段 tail';
    const selectionText = '未保存片段';
    const localFrom = windowText.indexOf(selectionText);
    const localTo = localFrom + selectionText.length;
    const view = mountView(tab.id, windowText, { anchor: localFrom, head: localTo });
    const manager = { fileId: 'rope-file-1', baseCharOffset: 10_000 } as any;
    registerViewportSnapshotMetadata(tab.id, { fileId: 'rope-file-1', manager });

    const result = capturePublishDocumentSnapshot('pane-1');

    expect(result).toEqual({
      kind: 'rope',
      paneId: 'pane-1',
      tabId: tab.id,
      fileId: 'rope-file-1',
      filePath: '/project/large.md',
      documentDir: '/project',
      projectDir: null,
      mainSelection: {
        from: 10_000 + localFrom,
        to: 10_000 + localTo,
        text: selectionText,
      },
    });
    expect(view.state.doc.toString()).toBe(windowText);
    expect(commands.readFile).not.toHaveBeenCalled();
  });

  it('blocks a viewport source when snapshot metadata is absent', () => {
    tabsStore.openTab('/project/large.md', 'stored text must not be used');
    const tab = tabsStore.activeTab!;
    const view = mountView(tab.id, 'partial window');
    registerEditorView(tab.id, view, true);

    expect(capturePublishDocumentSnapshot('pane-1')).toEqual({
      kind: 'blocked',
      code: 'viewport_snapshot_unavailable',
      paneId: 'pane-1',
      tabId: tab.id,
    });
    expect(commands.readFile).not.toHaveBeenCalled();
  });

  it('blocks a viewport source when registered metadata lacks a file ID or manager', () => {
    tabsStore.openTab('/project/large.md', 'stored text must not be used');
    const tab = tabsStore.activeTab!;
    mountView(tab.id, 'partial window');
    registerViewportSnapshotMetadata(tab.id, {
      fileId: '',
      manager: null as any,
    });

    expect(capturePublishDocumentSnapshot('pane-1')).toEqual({
      kind: 'blocked',
      code: 'viewport_snapshot_unavailable',
      paneId: 'pane-1',
      tabId: tab.id,
    });
    expect(commands.readFile).not.toHaveBeenCalled();
  });
});
