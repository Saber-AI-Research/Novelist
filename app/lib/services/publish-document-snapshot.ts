import type { EditorState } from '@codemirror/state';
import { projectStore } from '$lib/stores/project.svelte';
import {
  getEditorView,
  getViewportSnapshotMetadata,
  isTabViewportMode,
  tabsStore,
} from '$lib/stores/tabs.svelte';
import { pathDirname } from '$lib/utils/path';

export interface FrozenMainSelection {
  from: number;
  to: number;
  text: string;
}

export interface EditorPublishDocumentSnapshot {
  kind: 'editor';
  paneId: string;
  tabId: string;
  filePath: string;
  documentDir: string;
  projectDir: string | null;
  fullText: string;
  mainSelection: FrozenMainSelection | null;
  editorGeneration: EditorState;
}

export interface RopePublishDocumentSnapshot {
  kind: 'rope';
  paneId: string;
  tabId: string;
  fileId: string;
  filePath: string;
  documentDir: string;
  projectDir: string | null;
  mainSelection: FrozenMainSelection | null;
}

export type PublishDocumentSnapshotBlockerCode =
  | 'pane_not_found'
  | 'active_tab_not_found'
  | 'editor_view_unavailable'
  | 'viewport_snapshot_unavailable';

export interface PublishDocumentSnapshotBlocker {
  kind: 'blocked';
  code: PublishDocumentSnapshotBlockerCode;
  paneId: string;
  tabId?: string;
}

export type PublishDocumentSnapshotResult =
  | EditorPublishDocumentSnapshot
  | RopePublishDocumentSnapshot
  | PublishDocumentSnapshotBlocker;

export function capturePublishDocumentSnapshot(
  paneId: string,
): PublishDocumentSnapshotResult {
  if (!tabsStore.panes.some((pane) => pane.id === paneId)) {
    return { kind: 'blocked', code: 'pane_not_found', paneId };
  }

  const tab = tabsStore.getPaneActiveTab(paneId);
  if (!tab) {
    return { kind: 'blocked', code: 'active_tab_not_found', paneId };
  }

  const view = getEditorView(tab.id);
  if (!view) {
    return { kind: 'blocked', code: 'editor_view_unavailable', paneId, tabId: tab.id };
  }

  const state = view.state;
  const main = state.selection.main;
  const documentDir = pathDirname(tab.filePath);
  const projectDir = projectStore.dirPath;

  if (isTabViewportMode(tab.id)) {
    const metadata = getViewportSnapshotMetadata(tab.id);
    const manager = metadata?.manager;
    if (!manager?.fileId) {
      return {
        kind: 'blocked',
        code: 'viewport_snapshot_unavailable',
        paneId,
        tabId: tab.id,
      };
    }

    const offset = manager.baseCharOffset;
    const mainSelection = main.from < main.to
      ? {
          from: offset + main.from,
          to: offset + main.to,
          text: state.sliceDoc(main.from, main.to),
        }
      : null;

    return {
      kind: 'rope',
      paneId,
      tabId: tab.id,
      fileId: manager.fileId,
      filePath: tab.filePath,
      documentDir,
      projectDir,
      mainSelection,
    };
  }

  const mainSelection = main.from < main.to
    ? { from: main.from, to: main.to, text: state.sliceDoc(main.from, main.to) }
    : null;

  return {
    kind: 'editor',
    paneId,
    tabId: tab.id,
    filePath: tab.filePath,
    documentDir,
    projectDir,
    fullText: state.doc.toString(),
    mainSelection,
    editorGeneration: state,
  };
}
