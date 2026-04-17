/**
 * GFM table rendering for CodeMirror 6.
 *
 * When the cursor is outside the table, replaces the raw markdown with
 * a rendered HTML <table> widget (same pattern as math.ts / mermaid.ts).
 * When the cursor moves into the table, the widget is removed and the
 * raw markdown is shown with a styled background for editing.
 *
 * Architecture: block decorations (Decoration.replace with block: true)
 * MUST be provided via a StateField, not a ViewPlugin — CM6 enforces
 * this so it can account for block widget heights in the height map.
 * Inline/line decorations (marks, line classes) are provided by a
 * separate ViewPlugin.
 */
import {
  ViewPlugin, Decoration, type DecorationSet, EditorView,
  type ViewUpdate, WidgetType,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Range } from '@codemirror/state';
import { imeComposingField } from './ime-guard';

/* ── Table parsing ────────────────────────────────────────── */

interface ParsedTable {
  headers: string[];
  alignments: ('left' | 'center' | 'right' | 'default')[];
  rows: string[][];
}

function parseCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map(c => c.trim());
}

function parseMarkdownTable(text: string): ParsedTable | null {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) return null;

  const headers = parseCells(lines[0]);

  // Parse alignment from separator row
  const sepCells = parseCells(lines[1]);
  // Validate separator row — every cell must be dashes (with optional colons)
  const isSep = sepCells.every(c => /^:?\s*-+\s*:?$/.test(c.trim()));
  if (!isSep) return null;

  const alignments: ParsedTable['alignments'] = sepCells.map(cell => {
    const c = cell.trim();
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    if (c.endsWith(':')) return 'right';
    if (c.startsWith(':')) return 'left';
    return 'default';
  });

  const rows = lines.slice(2).map(parseCells);

  return { headers, alignments, rows };
}

/* ── Inline markdown → HTML (for cell content) ───────────── */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render basic inline markdown (bold, italic, code, strikethrough) to HTML. */
function renderInlineMarkdown(text: string): string {
  let html = escapeHtml(text);
  // Order matters: bold before italic to avoid ** matching as two *
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
  html = html.replace(/`(.+?)`/g, '<code class="cm-novelist-table-code">$1</code>');
  return html;
}

/* ── Table widget ─────────────────────────────────────────── */

class TableWidget extends WidgetType {
  constructor(
    private table: ParsedTable,
    private raw: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-novelist-table-widget';

    const tableEl = document.createElement('table');
    tableEl.className = 'cm-novelist-rendered-table';

    // Header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    this.table.headers.forEach((header, i) => {
      const th = document.createElement('th');
      th.innerHTML = renderInlineMarkdown(header);
      const align = this.table.alignments[i];
      if (align && align !== 'default') th.style.textAlign = align;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    tableEl.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    this.table.rows.forEach(row => {
      const tr = document.createElement('tr');
      this.table.headers.forEach((_, i) => {
        const td = document.createElement('td');
        td.innerHTML = renderInlineMarkdown(row[i] ?? '');
        const align = this.table.alignments[i];
        if (align && align !== 'default') td.style.textAlign = align;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tableEl.appendChild(tbody);

    wrapper.appendChild(tableEl);
    return wrapper;
  }

  eq(other: TableWidget): boolean {
    return this.raw === other.raw;
  }

  get estimatedHeight(): number {
    // ~30px header + ~28px per body row
    return 30 + this.table.rows.length * 28;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/* ── Cursor helpers (reused from wysiwyg.ts / math.ts pattern) ── */

function makeCursorSet(state: EditorState): number[] {
  return state.selection.ranges.map(r => r.head).sort((a, b) => a - b);
}

function cursorInRangeFast(heads: number[], from: number, to: number): boolean {
  let lo = 0, hi = heads.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (heads[mid] < from) lo = mid + 1; else hi = mid;
  }
  return lo < heads.length && heads[lo] <= to;
}

/* ── Collect Table node ranges from syntax tree ───────────── */

function getTableRanges(state: EditorState): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'Table') {
        ranges.push({ from: node.from, to: node.to });
        return false;
      }
    },
  });
  return ranges;
}

/* ── Block decorations (StateField) ─────────────────────── */

/**
 * Block-level table decorations provided via StateField.
 * CM6 requires block decorations to come from StateField, not ViewPlugin.
 * Replaces table markdown with rendered HTML widget when cursor is outside.
 */
function buildTableBlockDecos(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const cursorHeads = makeCursorSet(state);

  for (const range of getTableRanges(state)) {
    const cursorInside = cursorInRangeFast(cursorHeads, range.from, range.to);
    if (cursorInside) continue;

    const raw = state.doc.sliceString(range.from, range.to);
    const parsed = parseMarkdownTable(raw);
    if (parsed && parsed.headers.length > 0) {
      decos.push(
        Decoration.replace({
          widget: new TableWidget(parsed, raw),
          block: true,
        }).range(range.from, range.to)
      );
    }
  }

  return Decoration.set(decos, true);
}

const tableBlockDecoField = StateField.define<DecorationSet>({
  create(state) { return buildTableBlockDecos(state); },
  update(value, tr) {
    if (tr.state.field(imeComposingField, false)) return value;
    // Rebuild on doc change
    if (tr.docChanged) return buildTableBlockDecos(tr.state);
    // Rebuild when incremental parser finishes
    if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildTableBlockDecos(tr.state);
    }
    // Rebuild on selection change — cursor entering/leaving a table
    // toggles between rendered widget and raw markdown
    if (tr.selection) return buildTableBlockDecos(tr.state);
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

/* ── Inline/line decorations (ViewPlugin) ────────────────── */

/**
 * Non-block decorations: line styling and mark decorations
 * for tables where the cursor is inside (editing mode).
 * These are safe in a ViewPlugin since they're not block-level.
 */
function buildTableInlineDecos(view: EditorView): DecorationSet {
  const { state } = view;
  const decos: Range<Decoration>[] = [];
  const cursorHeads = makeCursorSet(state);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'Table') return;
        if (!cursorInRangeFast(cursorHeads, node.from, node.to)) return false;

        // Cursor inside: show raw markdown with table line styling
        const lineDeco = Decoration.line({ class: 'cm-novelist-table-line' });
        let pos = node.from;
        while (pos <= node.to) {
          const line = state.doc.lineAt(pos);
          decos.push(lineDeco.range(line.from));
          pos = line.to + 1;
        }

        // Dim the separator row (|---|---|)
        const raw = state.doc.sliceString(node.from, node.to);
        const lines = raw.split('\n');
        if (lines.length >= 2) {
          const firstLineEnd = node.from + lines[0].length;
          const sepFrom = firstLineEnd + 1;
          const sepTo = sepFrom + lines[1].length;
          if (sepFrom < sepTo) {
            decos.push(
              Decoration.mark({ class: 'cm-novelist-table-separator' }).range(sepFrom, sepTo)
            );
          }
        }

        return false;
      },
    });
  }

  return Decoration.set(decos, true);
}

class TableInlinePluginClass {
  decorations: DecorationSet;
  private lastCursorLine = -1;

  constructor(view: EditorView) {
    this.decorations = buildTableInlineDecos(view);
    this.lastCursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  }

  update(update: ViewUpdate) {
    const wasComposing = update.startState.field(imeComposingField, false);
    const isComposing = update.state.field(imeComposingField, false);
    if (isComposing) return;

    if (update.docChanged || update.viewportChanged || (wasComposing && !isComposing)) {
      this.decorations = buildTableInlineDecos(update.view);
      this.lastCursorLine = update.state.doc.lineAt(update.state.selection.main.head).number;
      return;
    }

    if (syntaxTree(update.state) !== syntaxTree(update.startState)) {
      this.decorations = buildTableInlineDecos(update.view);
      this.lastCursorLine = update.state.doc.lineAt(update.state.selection.main.head).number;
      return;
    }

    if (update.selectionSet) {
      const newLine = update.state.doc.lineAt(update.state.selection.main.head).number;
      if (newLine !== this.lastCursorLine) {
        this.decorations = buildTableInlineDecos(update.view);
        this.lastCursorLine = newLine;
      }
    }
  }
}

const tableInlinePlugin = ViewPlugin.fromClass(TableInlinePluginClass, {
  decorations: (v) => v.decorations,
});

/* ── Exported extension ──────────────────────────────────── */

export const tablePlugin = [tableBlockDecoField, tableInlinePlugin];
