import { commands } from '$lib/ipc/commands';
import { projectStore } from '$lib/stores/project.svelte';
import { tabsStore, type TabState } from '$lib/stores/tabs.svelte';
import { parsePluginFileRevision } from '$lib/services/plugin-file-protocol';
import { pathsEqual } from '$lib/utils/path';

/**
 * Host-side document sessions for file-handler plugin iframes.
 *
 * Every `file-open` hands an iframe ("owner") a fresh `documentId` token for
 * one exact snapshot of one tab. A token stays writable only while that
 * snapshot is still the shared state of the real file: the tab is open, in the
 * same project, at the same path and reload version, and no other view has
 * replaced the content since. Accepted plugin states are mirrored into every
 * tab of the same file (active or not) and revoke every other snapshot of it,
 * so a sibling pane must take the new content before it can write. When the
 * sibling still shows the same tab, path, project and reload version, its new
 * snapshot is marked `sync`: the iframe may swap content in place (keeping
 * caret, mode, scroll and focus) instead of reopening the document.
 * Disk writes are serialized per file. Superseded queued snapshots are skipped;
 * an in-flight write never marks a newer replacement snapshot saved.
 *
 * There is no merge: a stale message that carries a genuinely unsynced local
 * edit becomes a `PluginDocumentConflict` the user can explicitly restore.
 */

const STALE_DOCUMENT_ERROR = 'Plugin document is no longer current';
/** Revoked snapshots remembered per owner to recognize racing local edits. */
const REVOKED_HISTORY = 8;

interface DocumentSession {
  readonly token: string;
  readonly ownerId: string;
  readonly tabId: string;
  readonly filePath: string;
  readonly projectPath: string | null;
  readonly tabVersion: number;
  /** Exact content the plugin holds for this snapshot. */
  content: string;
  /** Highest plugin revision announced for this snapshot. */
  revision: number;
}

interface RevokedSnapshot {
  readonly token: string;
  readonly tabId: string;
  readonly filePath: string;
  readonly projectPath: string | null;
  readonly content: string;
}

/** What an owner's iframe currently shows; kept after its token is revoked. */
interface DisplayedSnapshot {
  readonly token: string;
  readonly tabId: string;
  readonly filePath: string;
  readonly projectPath: string | null;
  readonly tabVersion: number;
}

interface DocumentOwner {
  readonly tokensByTab: Map<string, string>;
  displayed: DisplayedSnapshot | null;
  revoked: RevokedSnapshot[];
}

export interface PluginDocumentOpen {
  token: string;
  revision: number;
  filePath: string;
  content: string;
  projectPath: string | null;
  /**
   * The owner already displays an older snapshot of this same tab (same path,
   * project and reload version); only the shared content moved on.
   */
  sync: boolean;
}

export interface PluginDocumentTarget {
  tabId: string;
  filePath: string;
  projectPath: string | null;
}

/** A local plugin edit rejected because another view replaced its snapshot. */
export interface PluginDocumentConflict extends PluginDocumentTarget {
  content: string;
}

export interface PluginDocumentStateResult {
  accepted: boolean;
  conflict: PluginDocumentConflict | null;
}

export interface PluginDocumentSaveResult {
  ok: boolean;
  saved: boolean;
  error: string | null;
  filePath: string | null;
  conflict: PluginDocumentConflict | null;
}

function findTab(tabId: string): TabState | undefined {
  return tabsStore.allTabs.find((tab) => tab.id === tabId);
}

function tabsForFile(filePath: string): TabState[] {
  return tabsStore.allTabs.filter((tab) => pathsEqual(tab.filePath, filePath));
}

function isOpenTarget(target: PluginDocumentTarget): TabState | null {
  const tab = findTab(target.tabId);
  return tab && tab.filePath === target.filePath && projectStore.dirPath === target.projectPath
    ? tab
    : null;
}

/** The tab still holds exactly this snapshot: path, project, reload version, content. */
function snapshotTab(session: DocumentSession, content: string): TabState | null {
  const tab = isOpenTarget(session);
  return tab && tab.version === session.tabVersion && tab.content === content ? tab : null;
}

export class PluginDocumentSessions {
  private readonly sessions = new Map<string, DocumentSession>();
  private readonly owners = new Map<string, DocumentOwner>();
  private readonly writeQueues: Array<{ filePath: string; tail: Promise<unknown> }> = [];

  /**
   * Snapshot `tabId` for `ownerId`. Returns null when there is nothing to send:
   * the tab is gone, or the owner already displays this tab's live snapshot.
   */
  open(ownerId: string, tabId: string): PluginDocumentOpen | null {
    const tab = findTab(tabId);
    if (!tab) return null;
    let owner = this.owners.get(ownerId);
    if (!owner) {
      owner = { tokensByTab: new Map(), displayed: null, revoked: [] };
      this.owners.set(ownerId, owner);
    }
    const existingToken = owner.tokensByTab.get(tabId);
    let session = existingToken ? this.live(ownerId, existingToken)?.session ?? null : null;
    if (session && owner.displayed?.token === session.token) return null;
    if (!session) {
      this.adoptUnsavedSibling(tab);
      session = {
        token: crypto.randomUUID(),
        ownerId,
        tabId,
        filePath: tab.filePath,
        projectPath: projectStore.dirPath,
        tabVersion: tab.version,
        content: tab.content ?? '',
        revision: 0,
      };
      this.sessions.set(session.token, session);
      owner.tokensByTab.set(tabId, session.token);
    }
    const shown = owner.displayed;
    const sync = !!shown
      && shown.tabId === session.tabId
      && shown.filePath === session.filePath
      && shown.projectPath === session.projectPath
      && shown.tabVersion === session.tabVersion;
    owner.displayed = {
      token: session.token,
      tabId: session.tabId,
      filePath: session.filePath,
      projectPath: session.projectPath,
      tabVersion: session.tabVersion,
    };
    return {
      token: session.token,
      revision: session.revision,
      filePath: session.filePath,
      content: session.content,
      projectPath: session.projectPath,
      sync,
    };
  }

  /** Forget every token issued to an owner (iframe reload or unmount). */
  release(ownerId: string): void {
    const owner = this.owners.get(ownerId);
    if (!owner) return;
    for (const token of owner.tokensByTab.values()) this.sessions.delete(token);
    this.owners.delete(ownerId);
  }

  /** The tab/project a live token belongs to, or null for any stale token. */
  target(ownerId: string, token: unknown): PluginDocumentTarget | null {
    const live = this.live(ownerId, token);
    if (!live) return null;
    const { tabId, filePath, projectPath } = live.session;
    return { tabId, filePath, projectPath };
  }

  /**
   * The live token the owner currently displays for `target`, following any
   * in-place `sync` since the target's token was issued; null once the owner
   * shows another tab, path, project or reload of it.
   */
  displayedToken(ownerId: string, target: PluginDocumentTarget): string | null {
    const shown = this.owners.get(ownerId)?.displayed;
    if (
      !shown
      || shown.tabId !== target.tabId
      || shown.filePath !== target.filePath
      || shown.projectPath !== target.projectPath
    ) return null;
    return this.live(ownerId, shown.token) ? shown.token : null;
  }

  /** Accept a plugin `file-state` into every tab of the same file. */
  applyState(
    ownerId: string,
    token: unknown,
    revisionValue: unknown,
    content: string,
  ): PluginDocumentStateResult {
    const revision = parsePluginFileRevision(revisionValue);
    const live = revision === null ? null : this.live(ownerId, token);
    if (!live || revision === null) {
      return { accepted: false, conflict: this.rejectedEdit(ownerId, token, content) };
    }
    if (revision < live.session.revision) return { accepted: false, conflict: null };
    live.session.revision = revision;
    this.commit(live.session, content);
    return { accepted: true, conflict: null };
  }

  markDirty(ownerId: string, token: unknown): boolean {
    const live = this.live(ownerId, token);
    if (!live) return false;
    for (const tab of tabsForFile(live.session.filePath)) tabsStore.markDirty(tab.id);
    return true;
  }

  /** Persist a plugin `file-save`; the content also counts as its latest state. */
  async save(
    ownerId: string,
    token: unknown,
    revisionValue: unknown,
    content: string,
  ): Promise<PluginDocumentSaveResult> {
    const revision = parsePluginFileRevision(revisionValue);
    const live = revision === null ? null : this.live(ownerId, token);
    if (!live || revision === null) {
      return {
        ok: false,
        saved: false,
        error: STALE_DOCUMENT_ERROR,
        filePath: null,
        conflict: this.rejectedEdit(ownerId, token, content),
      };
    }
    const { session } = live;
    if (revision < session.revision) {
      return { ok: true, saved: false, error: null, filePath: session.filePath, conflict: null };
    }
    session.revision = revision;
    this.commit(session, content);
    // Checked against the tab rather than the token map, so a save already
    // accepted still lands if its iframe unmounts before the write runs.
    return this.persist(session.filePath, content, () => (
      session.revision === revision && !!snapshotTab(session, content)
    ));
  }

  /**
   * Explicitly replace the shared document with a rejected local edit. Only a
   * tab that is still open at the same path in the same project qualifies.
   */
  async restore(conflict: PluginDocumentConflict): Promise<PluginDocumentSaveResult> {
    if (!isOpenTarget(conflict)) {
      return { ok: false, saved: false, error: STALE_DOCUMENT_ERROR, filePath: null, conflict: null };
    }
    this.replaceFileContent(conflict.filePath, conflict.content);
    return this.persist(conflict.filePath, conflict.content, () => (
      isOpenTarget(conflict)?.content === conflict.content
    ));
  }

  /**
   * Wait for every queued plugin document write to finish (lifecycle flush
   * before the app is backgrounded). Writes enqueued meanwhile are included.
   */
  async settled(): Promise<void> {
    while (this.writeQueues.length > 0) {
      await Promise.all(this.writeQueues.map((queue) => queue.tail));
    }
  }

  private live(ownerId: string, token: unknown): { session: DocumentSession; tab: TabState } | null {
    if (typeof token !== 'string' || !token) return null;
    const session = this.sessions.get(token);
    if (!session || session.ownerId !== ownerId) return null;
    const tab = snapshotTab(session, session.content);
    if (tab) return { session, tab };
    this.revoke(session);
    return null;
  }

  private revoke(session: DocumentSession): void {
    this.sessions.delete(session.token);
    const owner = this.owners.get(session.ownerId);
    if (!owner) return;
    if (owner.tokensByTab.get(session.tabId) === session.token) owner.tokensByTab.delete(session.tabId);
    owner.revoked = [
      ...owner.revoked.slice(-(REVOKED_HISTORY - 1)),
      {
        token: session.token,
        tabId: session.tabId,
        filePath: session.filePath,
        projectPath: session.projectPath,
        content: session.content,
      },
    ];
  }

  /**
   * Make `content` the shared state of the file: every tab of it adopts the
   * content and every snapshot holding anything else is revoked.
   */
  private replaceFileContent(filePath: string, content: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.content !== content && pathsEqual(session.filePath, filePath)) this.revoke(session);
    }
    for (const tab of tabsForFile(filePath)) tabsStore.updateContent(tab.id, content);
  }

  private commit(session: DocumentSession, content: string): void {
    if (content === session.content) return;
    session.content = content;
    this.replaceFileContent(session.filePath, content);
  }

  /**
   * A view opened from disk must not hold an older writable snapshot while a
   * sibling tab of the same file has unsaved edits.
   */
  private adoptUnsavedSibling(tab: TabState): void {
    if (tab.isDirty) return;
    const sibling = tabsForFile(tab.filePath)
      .find((candidate) => candidate.id !== tab.id && candidate.isDirty && candidate.content !== tab.content);
    if (sibling) tabsStore.updateContent(tab.id, sibling.content);
  }

  /** A stale message is a conflict only when it carries an edit never synced. */
  private rejectedEdit(ownerId: string, token: unknown, content: string): PluginDocumentConflict | null {
    const snapshot = this.owners.get(ownerId)?.revoked.find((candidate) => candidate.token === token);
    if (!snapshot || snapshot.content === content) return null;
    const tab = isOpenTarget(snapshot);
    if (!tab || tab.content === content) return null;
    const { tabId, filePath, projectPath } = snapshot;
    return { tabId, filePath, projectPath, content };
  }

  private persist(
    filePath: string,
    content: string,
    isCurrent: () => boolean,
  ): Promise<PluginDocumentSaveResult> {
    return this.enqueueWrite(filePath, async (): Promise<PluginDocumentSaveResult> => {
      if (!isCurrent()) return { ok: true, saved: false, error: null, filePath, conflict: null };
      try {
        const result = await commands.writeFile(filePath, content);
        if (result.status === 'error') {
          return { ok: false, saved: false, error: result.error, filePath, conflict: null };
        }
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        return { ok: false, saved: false, error, filePath, conflict: null };
      }
      const saved = isCurrent();
      if (saved) {
        for (const tab of tabsForFile(filePath)) {
          if (tab.content === content) tabsStore.markSaved(tab.id);
        }
      }
      return { ok: true, saved, error: null, filePath, conflict: null };
    });
  }

  private enqueueWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
    let queue = this.writeQueues.find((candidate) => pathsEqual(candidate.filePath, filePath));
    if (!queue) {
      queue = { filePath, tail: Promise.resolve() };
      this.writeQueues.push(queue);
    }
    const run = queue.tail.then(task, task);
    const tail = run.catch(() => undefined);
    queue.tail = tail;
    const owned = queue;
    void tail.then(() => {
      if (owned.tail !== tail) return;
      const index = this.writeQueues.indexOf(owned);
      if (index >= 0) this.writeQueues.splice(index, 1);
    });
    return run;
  }
}

export const pluginDocumentSessions = new PluginDocumentSessions();
