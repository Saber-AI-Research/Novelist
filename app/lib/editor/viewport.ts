/**
 * Viewport manager for large file editing with Rust Rope backend.
 *
 * CRITICAL: Window reloads use a CM6 Transaction Annotation to mark
 * the transaction as "not a user edit". The Editor's update listener
 * checks this annotation to skip dispatch to Rope.
 * This is MORE RELIABLE than an external flag because the annotation
 * travels WITH the transaction through CM6's synchronous dispatch.
 */

import { commands } from '$lib/ipc/commands';
import { EditorView, keymap } from '@codemirror/view';
import { Annotation, type Extension } from '@codemirror/state';

export const WINDOW_SIZE = 10000;
const OVERLAP = 500;

/**
 * CM6 Transaction Annotation: marks a transaction as a viewport window
 * replacement, NOT a user edit. The update listener MUST check this.
 */
export const viewportReplace = Annotation.define<boolean>();

export class ViewportManager {
  fileId: string;
  totalLines: number;

  windowStartLine = 0;
  windowEndLine = 0;
  baseCharOffset = 0;

  private view: EditorView | null = null;
  private editQueue: Promise<void> = Promise.resolve();
  private alive = true;

  constructor(fileId: string, totalLines: number) {
    this.fileId = fileId;
    this.totalLines = totalLines;
  }

  attach(view: EditorView) { this.view = view; }

  async loadWindow(centerLine: number): Promise<{ text: string; startLine: number }> {
    const half = Math.floor(WINDOW_SIZE / 2);
    let startLine = Math.max(0, centerLine - half);
    let endLine = Math.min(this.totalLines, startLine + WINDOW_SIZE);
    if (endLine - startLine < WINDOW_SIZE && startLine > 0) {
      startLine = Math.max(0, endLine - WINDOW_SIZE);
    }

    const result = await commands.ropeGetLines(this.fileId, startLine, endLine);
    if (result.status !== 'ok') throw new Error(result.error);

    this.windowStartLine = result.data.start_line;
    this.windowEndLine = result.data.end_line;
    this.totalLines = result.data.total_lines;

    const charResult = await commands.ropeLineToChar(this.fileId, this.windowStartLine);
    this.baseCharOffset = charResult.status === 'ok' ? charResult.data : 0;

    return { text: result.data.text, startLine: this.windowStartLine };
  }

  /** Replace CM6 content with new window, annotated so update listener skips it */
  private replaceWindow(text: string) {
    if (!this.view) return;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      annotations: viewportReplace.of(true),
    });
  }

  async navigateWindow(direction: 'up' | 'down'): Promise<boolean> {
    if (!this.view || !this.alive) return false;
    await this.editQueue;

    if (direction === 'down' && this.windowEndLine >= this.totalLines) return false;
    if (direction === 'up' && this.windowStartLine <= 0) return false;

    const targetCenter = direction === 'down'
      ? this.windowEndLine - OVERLAP + WINDOW_SIZE / 2
      : this.windowStartLine + OVERLAP - WINDOW_SIZE / 2;

    const { text } = await this.loadWindow(Math.max(0, targetCenter));

    this.replaceWindow(text);

    const targetLocalLine = direction === 'down' ? OVERLAP + 1 : this.view!.state.doc.lines - OVERLAP;
    const clampedLine = Math.max(1, Math.min(targetLocalLine, this.view!.state.doc.lines));
    const lineInfo = this.view!.state.doc.line(clampedLine);
    this.view!.dispatch({
      selection: { anchor: lineInfo.from },
      scrollIntoView: true,
      annotations: viewportReplace.of(true),
    });

    return true;
  }

  async jumpToLine(absLine: number): Promise<number | null> {
    if (!this.view || !this.alive) return null;

    if (absLine >= this.windowStartLine && absLine < this.windowEndLine) {
      const localLine = absLine - this.windowStartLine + 1;
      if (localLine >= 1 && localLine <= this.view.state.doc.lines) {
        return this.view.state.doc.line(localLine).from;
      }
    }

    await this.editQueue;
    const { text } = await this.loadWindow(absLine);

    this.replaceWindow(text);

    const localLine = absLine - this.windowStartLine + 1;
    if (localLine >= 1 && localLine <= this.view!.state.doc.lines) {
      return this.view!.state.doc.line(localLine).from;
    }
    return 0;
  }

  createKeyBindings(): Extension {
    const mgr = this;
    return keymap.of([
      {
        key: 'PageDown',
        run: (view) => {
          const curLine = view.state.doc.lineAt(view.state.selection.main.head).number;
          if (curLine >= view.state.doc.lines - 10 && mgr.windowEndLine < mgr.totalLines) {
            mgr.navigateWindow('down');
            return true;
          }
          return false;
        },
      },
      {
        key: 'PageUp',
        run: (view) => {
          const curLine = view.state.doc.lineAt(view.state.selection.main.head).number;
          if (curLine <= 10 && mgr.windowStartLine > 0) {
            mgr.navigateWindow('up');
            return true;
          }
          return false;
        },
      },
      {
        key: 'Mod-End',
        run: () => {
          mgr.jumpToLine(mgr.totalLines - 1).then(pos => {
            if (pos !== null && mgr.view) {
              mgr.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
            }
          });
          return true;
        },
      },
      {
        key: 'Mod-Home',
        run: () => {
          mgr.jumpToLine(0).then(pos => {
            if (pos !== null && mgr.view) {
              mgr.view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
            }
          });
          return true;
        },
      },
    ]);
  }

  /**
   * Create a DOM event handler that detects scroll-to-boundary and auto-pages.
   * Attach to the editor container element.
   */
  createScrollBoundaryHandler(): (e: WheelEvent) => void {
    let navigating = false;
    const mgr = this;

    return (e: WheelEvent) => {
      if (navigating || !mgr.view) return;
      const scroller = mgr.view.scrollDOM;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;
      const atTop = scroller.scrollTop <= 5;

      if (atBottom && e.deltaY > 0 && mgr.windowEndLine < mgr.totalLines) {
        e.preventDefault();
        navigating = true;
        mgr.navigateWindow('down').finally(() => { navigating = false; });
      } else if (atTop && e.deltaY < 0 && mgr.windowStartLine > 0) {
        e.preventDefault();
        navigating = true;
        mgr.navigateWindow('up').finally(() => { navigating = false; });
      }
    };
  }

  /** Get current scroll position as a fraction of the total document */
  getScrollFraction(): number {
    if (!this.view || this.totalLines === 0) return 0;
    const localLine = this.view.state.doc.lineAt(this.view.state.selection.main.head).number;
    const absLine = this.windowStartLine + localLine - 1;
    return absLine / this.totalLines;
  }

  dispatchEdit(fromLocal: number, toLocal: number, insertText: string) {
    if (!this.alive) return;

    const fromAbs = this.baseCharOffset + fromLocal;
    const toAbs = this.baseCharOffset + toLocal;

    this.editQueue = this.editQueue.then(async () => {
      if (!this.alive) return;
      const result = await commands.ropeApplyEdit(this.fileId, fromAbs, toAbs, insertText);
      if (result.status === 'ok') {
        this.totalLines = result.data;
      }
    });
  }

  async save(): Promise<boolean> {
    await this.editQueue;
    const result = await commands.ropeSave(this.fileId);
    return result.status === 'ok';
  }

  async close() {
    if (!this.alive) return;
    this.alive = false;
    await this.editQueue;
    await commands.ropeClose(this.fileId);
    this.view = null;
  }

  toAbsoluteLine(localLine: number): number {
    return this.windowStartLine + localLine - 1;
  }
}
