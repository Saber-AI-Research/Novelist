/**
 * Typora-style editable GFM tables for CodeMirror 6.
 *
 * Unlike math.ts / mermaid.ts (which show raw source when the cursor enters),
 * the table is ALWAYS rendered as a styled <table> widget. Cells are
 * `contenteditable` and edited in place; the rendered table never drops to a
 * raw plain-text view. Edits are serialized back to the markdown source —
 * committed on blur and on every structural change (add/remove row or column,
 * alignment). Hover-anchored toolbars and a right-click context menu provide
 * the structural operations.
 *
 * Architecture: block decorations (Decoration.replace with block: true) MUST
 * be provided via a StateField, not a ViewPlugin — CM6 enforces this so it can
 * account for block widget heights in the height map. A small companion
 * ViewPlugin (`tableFocusPlugin`) only flushes a pending cell-focus request
 * after a structural rebuild.
 */
import {
  ViewPlugin, Decoration, type DecorationSet, EditorView,
  type ViewUpdate, WidgetType,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Range } from '@codemirror/state';
import { imeComposingField } from './ime-guard';

/* ── Model ────────────────────────────────────────────────── */

export type Align = 'left' | 'center' | 'right' | 'default';

export interface ParsedTable {
  headers: string[];
  alignments: Align[];
  rows: string[][];
}

interface BlockRange {
  from: number;
  to: number;
}

interface TableBlockState {
  decorations: DecorationSet;
  ranges: BlockRange[];
}

/* ── Parsing (cell strings keep `\|` escapes verbatim) ─────── */

export function parseCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);
  // Split on unescaped pipes only.
  return trimmed.split(/(?<!\\)\|/).map(c => c.trim());
}

export function parseMarkdownTable(text: string): ParsedTable | null {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) return null;

  const headers = parseCells(lines[0]);

  // Parse alignment from separator row; validate it's a real separator.
  const sepCells = parseCells(lines[1]);
  const isSep = sepCells.every(c => /^:?\s*-+\s*:?$/.test(c.trim()));
  if (!isSep) return null;

  const alignments: Align[] = sepCells.map(cell => {
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
export function renderInlineMarkdown(text: string): string {
  // Unescape source-level pipe escapes before rendering.
  let html = escapeHtml(text.replace(/\\\|/g, '|'));
  // Order matters: bold before italic to avoid ** matching as two *
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
  html = html.replace(/`(.+?)`/g, '<code class="cm-novelist-table-code">$1</code>');
  return html;
}

/* ── DOM → markdown (serialize an edited cell) ───────────── */

/** Escape characters that would break a cell's GFM source. */
function escapeCellText(t: string): string {
  return t.replace(/\|/g, '\\|');
}

function nodeToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeCellText(node.textContent ?? '');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const inner = Array.from(el.childNodes).map(nodeToMarkdown).join('');
  switch (tag) {
    case 'strong': case 'b': return `**${inner}**`;
    case 'em': case 'i': return `*${inner}*`;
    case 's': case 'del': case 'strike': return `~~${inner}~~`;
    case 'code': return '`' + inner + '`';
    case 'br': return ' ';
    default: return inner; // unknown wrapper → keep its text only (no corruption)
  }
}

/** Convert a contenteditable cell's DOM into GFM cell source. */
export function cellDomToMarkdown(el: HTMLElement): string {
  const md = Array.from(el.childNodes).map(nodeToMarkdown).join('');
  // Collapse any stray newlines/runs of whitespace into single spaces.
  return md.replace(/\s+/g, ' ').trim();
}

/* ── Serialize model → compact GFM markdown ──────────────── */

function alignToken(a: Align): string {
  switch (a) {
    case 'left': return ':---';
    case 'center': return ':---:';
    case 'right': return '---:';
    default: return '---';
  }
}

export function serializeTable(t: ParsedTable): string {
  const ncols = Math.max(1, t.headers.length);
  const cell = (s: string) => (s ?? '').trim();

  const headerLine =
    '| ' + Array.from({ length: ncols }, (_, i) => cell(t.headers[i] ?? '')).join(' | ') + ' |';
  const sepLine =
    '| ' + Array.from({ length: ncols }, (_, i) => alignToken(t.alignments[i] ?? 'default')).join(' | ') + ' |';
  const rowLines = t.rows.map(r =>
    '| ' + Array.from({ length: ncols }, (_, i) => cell(r[i] ?? '')).join(' | ') + ' |'
  );

  return [headerLine, sepLine, ...rowLines].join('\n');
}

/* ── Model mutations (pure; each returns a new table) ────── */

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function padRow(row: string[], ncols: number): string[] {
  const out = row.slice(0, ncols);
  while (out.length < ncols) out.push('');
  return out;
}

export function insertRow(t: ParsedTable, idx: number): ParsedTable {
  const rows = t.rows.map(r => padRow(r, t.headers.length));
  rows.splice(clamp(idx, 0, rows.length), 0, padRow([], t.headers.length));
  return { ...t, rows };
}

export function deleteRow(t: ParsedTable, idx: number): ParsedTable {
  if (idx < 0 || idx >= t.rows.length) return t;
  const rows = t.rows.slice();
  rows.splice(idx, 1);
  return { ...t, rows };
}

export function insertColumn(t: ParsedTable, idx: number): ParsedTable {
  const ncols = t.headers.length;
  const at = clamp(idx, 0, ncols);
  const headers = t.headers.slice(); headers.splice(at, 0, '');
  const alignments = t.alignments.slice(); alignments.splice(at, 0, 'default');
  const rows = t.rows.map(r => { const rr = padRow(r, ncols); rr.splice(at, 0, ''); return rr; });
  return { headers, alignments, rows };
}

export function deleteColumn(t: ParsedTable, idx: number): ParsedTable {
  const ncols = t.headers.length;
  if (ncols <= 1 || idx < 0 || idx >= ncols) return t; // keep at least one column
  const headers = t.headers.slice(); headers.splice(idx, 1);
  const alignments = t.alignments.slice(); alignments.splice(idx, 1);
  const rows = t.rows.map(r => { const rr = padRow(r, ncols); rr.splice(idx, 1); return rr; });
  return { headers, alignments, rows };
}

export function setAlignment(t: ParsedTable, col: number, align: Align): ParsedTable {
  if (col < 0 || col >= t.headers.length) return t;
  const alignments = t.alignments.slice();
  while (alignments.length < t.headers.length) alignments.push('default');
  alignments[col] = align;
  return { ...t, alignments };
}

/* ── Collect Table node ranges from syntax tree ───────────── */

function getTableRanges(state: EditorState): BlockRange[] {
  const ranges: BlockRange[] = [];
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

/* ── Pending cell-focus across a structural rebuild ───────── */

interface PendingFocus { from: number; row: number; col: number; }
let pendingFocus: PendingFocus | null = null;

/* ── Table widget ─────────────────────────────────────────── */

function applyAlign(cell: HTMLElement, align: Align | undefined) {
  cell.style.textAlign = align && align !== 'default' ? align : '';
}

/** Locate the current document range of the Table backing a rendered DOM table. */
function currentTableRange(view: EditorView, tableEl: HTMLElement): BlockRange | null {
  let pos: number;
  try { pos = view.posAtDOM(tableEl); } catch { return null; }
  const tree = syntaxTree(view.state);
  let found: BlockRange | null = null;
  tree.iterate({
    from: pos,
    to: Math.min(pos + 1, view.state.doc.length),
    enter(n) {
      if (n.name === 'Table') { found = { from: n.from, to: n.to }; return false; }
    },
  });
  if (found) return found;
  // Fallback: walk ancestors of the node resolved at pos.
  let node: ReturnType<typeof tree.resolve> | null = tree.resolve(pos, 1);
  while (node) {
    if (node.name === 'Table') return { from: node.from, to: node.to };
    node = node.parent;
  }
  return null;
}

/** Read the editable text of every cell back into a {headers, rows} pair. */
function readDomText(tableEl: HTMLElement): { headers: string[]; rows: string[][] } {
  const headers = Array.from(tableEl.querySelectorAll('thead th'))
    .map(th => cellDomToMarkdown(th as HTMLElement));
  const rows = Array.from(tableEl.querySelectorAll('tbody tr')).map(tr =>
    Array.from(tr.querySelectorAll('td')).map(td => cellDomToMarkdown(td as HTMLElement))
  );
  return { headers, rows };
}

/** Serialize the DOM (folding pending text edits) and replace the source. */
function commitFromDom(view: EditorView, tableEl: HTMLElement): boolean {
  const range = currentTableRange(view, tableEl);
  if (!range) return false;
  const src = view.state.doc.sliceString(range.from, range.to);
  const parsed = parseMarkdownTable(src);
  if (!parsed) return false;
  const { headers, rows } = readDomText(tableEl);
  const next: ParsedTable = { headers, alignments: parsed.alignments, rows };
  const md = serializeTable(next);
  if (md === src) return false; // no change — avoid history churn
  view.dispatch({ changes: { from: range.from, to: range.to, insert: md } });
  return true;
}

/**
 * Apply a structural change: fold pending DOM text edits, transform the model,
 * and replace the source. Optionally request focus on a cell afterwards.
 */
function applyStructural(
  view: EditorView,
  tableEl: HTMLElement,
  fn: (t: ParsedTable) => ParsedTable,
  focusCell?: (t: ParsedTable) => { row: number; col: number },
): void {
  const range = currentTableRange(view, tableEl);
  if (!range) return;
  const src = view.state.doc.sliceString(range.from, range.to);
  const parsed = parseMarkdownTable(src);
  if (!parsed) return;
  const { headers, rows } = readDomText(tableEl);
  const base: ParsedTable = { headers, alignments: parsed.alignments, rows };
  const next = fn(base);
  const md = serializeTable(next);
  if (focusCell) {
    const target = focusCell(next);
    pendingFocus = { from: range.from, row: target.row, col: target.col };
  }
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: md },
    scrollIntoView: true,
  });
}

/* ── Structural toolbars + context menu ──────────────────── */

const ICON = {
  rowAbove: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v6M9 8h6"/><rect x="4" y="13" width="16" height="6" rx="1"/></svg>',
  rowBelow: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="6" rx="1"/><path d="M12 13v6M9 16h6"/></svg>',
  colLeft: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h6M8 9v6"/><rect x="13" y="4" width="6" height="16" rx="1"/></svg>',
  colRight: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="6" height="16" rx="1"/><path d="M13 12h6M16 9v6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
  alignLeft: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h10M4 18h13"/></svg>',
  alignCenter: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M7 12h10M5 18h14"/></svg>',
  alignRight: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M10 12h10M7 18h13"/></svg>',
};

function makeToolButton(html: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cm-novelist-table-tool-btn';
  btn.title = title;
  btn.innerHTML = html;
  // mousedown + preventDefault so the focused cell doesn't blur before the op.
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
  return btn;
}

/** i18n-agnostic labels — kept inline (no emoji, WebKit-stable). */
const MENU = {
  rowAbove: 'Insert row above',
  rowBelow: 'Insert row below',
  colLeft: 'Insert column left',
  colRight: 'Insert column right',
  delRow: 'Delete row',
  delCol: 'Delete column',
  alignLeft: 'Align left',
  alignCenter: 'Align center',
  alignRight: 'Align right',
  delTable: 'Delete table',
};

class TableWidget extends WidgetType {
  /** Active cell coordinates (header row uses row = -1). */
  private active: { row: number; col: number } | null = null;
  private rowToolbar: HTMLElement | null = null;
  private colToolbar: HTMLElement | null = null;
  private menu: HTMLElement | null = null;
  private composing = false;
  private commitOnComposeEnd = false;

  constructor(
    private table: ParsedTable,
    private raw: string,
  ) {
    super();
  }

  /* — Rendering — */

  private renderCell(cell: HTMLTableCellElement, text: string, col: number, row: number) {
    cell.contentEditable = 'true';
    cell.spellcheck = false;
    cell.className = 'cm-novelist-table-cell';
    cell.dataset.r = String(row);
    cell.dataset.c = String(col);
    cell.innerHTML = renderInlineMarkdown(text);
    applyAlign(cell, this.table.alignments[col]);
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-novelist-table-widget';
    // The wrapper is a non-editable island; only cells re-enable editing.
    wrapper.contentEditable = 'false';

    const tableEl = document.createElement('table');
    tableEl.className = 'cm-novelist-rendered-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    this.table.headers.forEach((header, i) => {
      const th = document.createElement('th');
      this.renderCell(th, header, i, -1);
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    tableEl.appendChild(thead);

    const tbody = document.createElement('tbody');
    this.table.rows.forEach((row, r) => {
      const tr = document.createElement('tr');
      tr.dataset.r = String(r);
      this.table.headers.forEach((_, c) => {
        const td = document.createElement('td');
        this.renderCell(td, row[c] ?? '', c, r);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tableEl.appendChild(tbody);

    wrapper.appendChild(tableEl);
    this.attachHandlers(wrapper, tableEl, view);
    return wrapper;
  }

  /* — Event wiring (delegated; survives updateDOM DOM reuse) — */

  private attachHandlers(wrapper: HTMLElement, tableEl: HTMLElement, view: EditorView) {
    const cellOf = (t: EventTarget | null): HTMLTableCellElement | null => {
      const el = t as HTMLElement | null;
      return (el?.closest?.('td,th') as HTMLTableCellElement) ?? null;
    };

    wrapper.addEventListener('compositionstart', () => { this.composing = true; });
    wrapper.addEventListener('compositionend', () => {
      this.composing = false;
      if (this.commitOnComposeEnd) {
        this.commitOnComposeEnd = false;
        commitFromDom(view, tableEl);
      }
    });

    wrapper.addEventListener('focusin', (e) => {
      const cell = cellOf(e.target);
      if (!cell) return;
      this.active = { row: Number(cell.dataset.r), col: Number(cell.dataset.c) };
      this.showToolbars(wrapper, tableEl, view, cell);
    });

    // Commit when focus leaves the whole table.
    wrapper.addEventListener('focusout', (e) => {
      const next = (e as FocusEvent).relatedTarget as Node | null;
      if (next && wrapper.contains(next)) return; // moving between cells/toolbars
      this.hideToolbars();
      if (this.composing) { this.commitOnComposeEnd = true; return; }
      commitFromDom(view, tableEl);
    });

    // Isolate the cell's editing context from CM6: keyboard/input events that
    // originate inside a cell must not reach CM6's keymap / input handling
    // (otherwise Mod-A select-all, Mod-B bold, typing, etc. hijack the main
    // editor and steal focus from the cell). The cell behaves as its own
    // contenteditable island; we only intercept Tab/Enter/Escape ourselves.
    for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'cut', 'copy', 'compositionupdate']) {
      wrapper.addEventListener(type, (e) => {
        if (cellOf(e.target)) e.stopPropagation();
      });
    }

    wrapper.addEventListener('keydown', (e) => {
      const cell = cellOf(e.target);
      if (!cell) return;
      this.onCellKeydown(e, cell, tableEl, view);
    });

    wrapper.addEventListener('contextmenu', (e) => {
      const cell = cellOf(e.target);
      if (!cell) return;
      e.preventDefault();
      e.stopPropagation();
      this.active = { row: Number(cell.dataset.r), col: Number(cell.dataset.c) };
      this.openContextMenu(e as MouseEvent, tableEl, view);
    });
  }

  /* — Keyboard navigation — */

  private focusCell(tableEl: HTMLElement, row: number, col: number, atEnd = false) {
    const sel = row < 0
      ? tableEl.querySelector(`thead th[data-c="${col}"]`)
      : tableEl.querySelector(`tbody tr[data-r="${row}"] td[data-c="${col}"]`);
    const cell = sel as HTMLElement | null;
    if (!cell) return;
    cell.focus();
    // Place caret at end of the cell content.
    if (atEnd) {
      const range = document.createRange();
      range.selectNodeContents(cell);
      range.collapse(false);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(range);
    }
  }

  private onCellKeydown(e: KeyboardEvent, cell: HTMLTableCellElement, tableEl: HTMLElement, view: EditorView) {
    const row = Number(cell.dataset.r);
    const col = Number(cell.dataset.c);
    const ncols = this.table.headers.length;
    const nrows = this.table.rows.length;

    // Mod+A: select only this cell's contents. Without this, WebKit's native
    // select-all targets the outer .cm-content editing host (selecting the
    // whole document and stealing focus from the cell).
    if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      const r = document.createRange();
      r.selectNodeContents(cell);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      // Linear order: header cells, then body row-major.
      const order = (r: number, c: number) => (r < 0 ? c : (1 + r) * ncols + c);
      const idx = order(row, col);
      const last = order(nrows - 1, ncols - 1);
      if (!e.shiftKey && idx >= last) {
        // Past the final cell → append a row and focus its first cell.
        applyStructural(view, tableEl, t => insertRow(t, t.rows.length), t => ({ row: t.rows.length - 1, col: 0 }));
        return;
      }
      const nextIdx = idx + (e.shiftKey ? -1 : 1);
      if (nextIdx < 0) return;
      // Decode back to (row, col).
      let nr: number, nc: number;
      if (nextIdx < ncols) { nr = -1; nc = nextIdx; }
      else { const b = nextIdx - ncols; nr = Math.floor(b / ncols); nc = b % ncols; }
      this.focusCell(tableEl, nr, nc, true);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (row < 0) { this.focusCell(tableEl, 0, col, true); return; }      // header → first body row
      if (row >= nrows - 1) {
        // Last row → append and move down.
        applyStructural(view, tableEl, t => insertRow(t, t.rows.length), () => ({ row: nrows, col }));
        return;
      }
      this.focusCell(tableEl, row + 1, col, true);
      return;
    }

    if (e.key === 'Enter' && e.shiftKey) {
      // Soft line break inside the cell.
      e.preventDefault();
      document.execCommand('insertHTML', false, '<br>');
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      const committed = commitFromDom(view, tableEl);
      const range = currentTableRange(view, tableEl);
      // After commit the range may have shifted by the length delta; re-resolve.
      const anchor = range ? Math.min(range.to, view.state.doc.length) : view.state.selection.main.head;
      void committed;
      view.focus();
      view.dispatch({ selection: { anchor } });
      return;
    }
  }

  /* — Toolbars (focus-anchored) — */

  private buildRowToolbar(tableEl: HTMLElement, view: EditorView): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cm-novelist-table-toolbar cm-novelist-table-toolbar-row';
    bar.contentEditable = 'false';
    bar.appendChild(makeToolButton(ICON.rowAbove, MENU.rowAbove, () => {
      const r = this.active?.row ?? 0;
      applyStructural(view, tableEl, t => insertRow(t, Math.max(0, r)), () => ({ row: Math.max(0, r), col: this.active?.col ?? 0 }));
    }));
    bar.appendChild(makeToolButton(ICON.rowBelow, MENU.rowBelow, () => {
      const r = this.active?.row ?? -1;
      applyStructural(view, tableEl, t => insertRow(t, r + 1), () => ({ row: r + 1, col: this.active?.col ?? 0 }));
    }));
    bar.appendChild(makeToolButton(ICON.trash, MENU.delRow, () => {
      const r = this.active?.row ?? -1;
      if (r < 0) return; // header isn't a deletable body row
      applyStructural(view, tableEl, t => deleteRow(t, r));
    }));
    return bar;
  }

  private buildColToolbar(tableEl: HTMLElement, view: EditorView): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cm-novelist-table-toolbar cm-novelist-table-toolbar-col';
    bar.contentEditable = 'false';
    bar.appendChild(makeToolButton(ICON.colLeft, MENU.colLeft, () => {
      const c = this.active?.col ?? 0;
      applyStructural(view, tableEl, t => insertColumn(t, c), () => ({ row: this.active?.row ?? -1, col: c }));
    }));
    bar.appendChild(makeToolButton(ICON.colRight, MENU.colRight, () => {
      const c = this.active?.col ?? -1;
      applyStructural(view, tableEl, t => insertColumn(t, c + 1), () => ({ row: this.active?.row ?? -1, col: c + 1 }));
    }));
    bar.appendChild(makeToolButton(ICON.trash, MENU.delCol, () => {
      const c = this.active?.col ?? 0;
      applyStructural(view, tableEl, t => deleteColumn(t, c));
    }));
    const setAlign = (a: Align) => {
      const c = this.active?.col ?? 0;
      applyStructural(view, tableEl, t => setAlignment(t, c, a), () => ({ row: this.active?.row ?? -1, col: c }));
    };
    bar.appendChild(makeToolButton(ICON.alignLeft, MENU.alignLeft, () => setAlign('left')));
    bar.appendChild(makeToolButton(ICON.alignCenter, MENU.alignCenter, () => setAlign('center')));
    bar.appendChild(makeToolButton(ICON.alignRight, MENU.alignRight, () => setAlign('right')));
    return bar;
  }

  private showToolbars(wrapper: HTMLElement, tableEl: HTMLElement, view: EditorView, cell: HTMLElement) {
    if (!this.rowToolbar) { this.rowToolbar = this.buildRowToolbar(tableEl, view); wrapper.appendChild(this.rowToolbar); }
    if (!this.colToolbar) { this.colToolbar = this.buildColToolbar(tableEl, view); wrapper.appendChild(this.colToolbar); }
    // Anchor relative to the wrapper using offset geometry.
    const top = cell.offsetTop;
    const left = cell.offsetLeft;
    this.rowToolbar.style.top = `${top}px`;
    this.rowToolbar.style.left = '0px';
    this.rowToolbar.style.transform = 'translateX(-100%)';
    this.colToolbar.style.left = `${left}px`;
    this.colToolbar.style.top = '0px';
    this.colToolbar.style.transform = 'translateY(-100%)';
    this.rowToolbar.style.display = 'flex';
    this.colToolbar.style.display = 'flex';
  }

  private hideToolbars() {
    if (this.rowToolbar) this.rowToolbar.style.display = 'none';
    if (this.colToolbar) this.colToolbar.style.display = 'none';
  }

  /* — Context menu — */

  private openContextMenu(e: MouseEvent, tableEl: HTMLElement, view: EditorView) {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className = 'context-menu cm-novelist-table-menu';
    menu.contentEditable = 'false';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    const r = this.active?.row ?? -1;
    const c = this.active?.col ?? 0;

    const item = (label: string, onClick: () => void, danger = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'context-menu-item' + (danger ? ' context-menu-item-danger' : '');
      b.textContent = label;
      b.addEventListener('mousedown', (ev) => ev.preventDefault());
      b.addEventListener('click', (ev) => { ev.preventDefault(); this.closeMenu(); onClick(); });
      menu.appendChild(b);
    };
    const sep = () => { const d = document.createElement('div'); d.className = 'context-menu-separator'; menu.appendChild(d); };

    item(MENU.rowAbove, () => applyStructural(view, tableEl, t => insertRow(t, Math.max(0, r))));
    item(MENU.rowBelow, () => applyStructural(view, tableEl, t => insertRow(t, r + 1)));
    item(MENU.colLeft, () => applyStructural(view, tableEl, t => insertColumn(t, c)));
    item(MENU.colRight, () => applyStructural(view, tableEl, t => insertColumn(t, c + 1)));
    sep();
    if (r >= 0) item(MENU.delRow, () => applyStructural(view, tableEl, t => deleteRow(t, r)), true);
    item(MENU.delCol, () => applyStructural(view, tableEl, t => deleteColumn(t, c)), true);
    sep();
    item(MENU.alignLeft, () => applyStructural(view, tableEl, t => setAlignment(t, c, 'left')));
    item(MENU.alignCenter, () => applyStructural(view, tableEl, t => setAlignment(t, c, 'center')));
    item(MENU.alignRight, () => applyStructural(view, tableEl, t => setAlignment(t, c, 'right')));
    sep();
    item(MENU.delTable, () => {
      const range = currentTableRange(view, tableEl);
      if (!range) return;
      // Remove the table block (and a trailing newline if present).
      const to = Math.min(range.to + 1, view.state.doc.length);
      view.dispatch({ changes: { from: range.from, to, insert: '' }, selection: { anchor: range.from } });
      view.focus();
    }, true);

    document.body.appendChild(menu);
    this.menu = menu;

    const close = (ev: Event) => {
      if (ev instanceof KeyboardEvent && ev.key !== 'Escape') return;
      if (ev instanceof MouseEvent && menu.contains(ev.target as Node)) return;
      this.closeMenu();
    };
    // Defer so the opening click doesn't immediately close it.
    setTimeout(() => {
      document.addEventListener('mousedown', close);
      document.addEventListener('keydown', close);
      (menu as any)._close = close;
    }, 0);
  }

  private closeMenu() {
    if (!this.menu) return;
    const close = (this.menu as any)._close;
    if (close) {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    }
    this.menu.remove();
    this.menu = null;
  }

  /* — CM6 lifecycle — */

  eq(other: TableWidget): boolean {
    return this.raw === other.raw;
  }

  /**
   * Reuse the existing DOM when the table shape is unchanged (text-only edit).
   * This preserves cell focus and caret across the StateField rebuild that a
   * commit triggers. Returns false on a shape change so CM6 rebuilds fresh.
   */
  updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    const tableEl = dom.querySelector('table');
    if (!tableEl) return false;
    const ncols = this.table.headers.length;
    const headerCells = tableEl.querySelectorAll('thead th');
    const bodyRows = tableEl.querySelectorAll('tbody tr');
    if (headerCells.length !== ncols || bodyRows.length !== this.table.rows.length) return false;
    for (const tr of Array.from(bodyRows)) {
      if (tr.querySelectorAll('td').length !== ncols) return false;
    }

    const active = document.activeElement;
    headerCells.forEach((th, i) => {
      if (th === active) return;
      const html = renderInlineMarkdown(this.table.headers[i] ?? '');
      if (th.innerHTML !== html) th.innerHTML = html;
      applyAlign(th as HTMLElement, this.table.alignments[i]);
    });
    bodyRows.forEach((tr, r) => {
      tr.querySelectorAll('td').forEach((td, c) => {
        if (td === active) return;
        const html = renderInlineMarkdown(this.table.rows[r]?.[c] ?? '');
        if (td.innerHTML !== html) td.innerHTML = html;
        applyAlign(td as HTMLElement, this.table.alignments[c]);
      });
    });
    return true;
  }

  destroy() {
    this.closeMenu();
  }

  get estimatedHeight(): number {
    // ~34px header + ~30px per body row + toolbar gutter.
    return 40 + this.table.rows.length * 30;
  }

  ignoreEvent(): boolean {
    // We own all interaction inside the widget; keep CM6 out of it.
    return true;
  }
}

/* ── Block decorations (StateField) — always rendered ────── */

function buildTableBlockState(state: EditorState): TableBlockState {
  const decos: Range<Decoration>[] = [];
  const ranges = getTableRanges(state);

  for (const range of ranges) {
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

  return { decorations: Decoration.set(decos, true), ranges };
}

const tableBlockDecoField = StateField.define<TableBlockState>({
  create(state) { return buildTableBlockState(state); },
  update(value, tr) {
    if (tr.state.field(imeComposingField, false)) return value;
    if (tr.docChanged) return buildTableBlockState(tr.state);
    if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildTableBlockState(tr.state);
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f, value => value.decorations),
});

/* ── Pending-focus flusher (after structural rebuild) ────── */

class TableFocusPluginClass {
  update(update: ViewUpdate) {
    if (!pendingFocus) return;
    if (!update.docChanged && !update.viewportChanged) return;
    const target = pendingFocus;
    const view = update.view;
    // Find the rendered table whose source range starts at the recorded offset.
    const tables = view.dom.querySelectorAll<HTMLElement>('table.cm-novelist-rendered-table');
    for (const tableEl of Array.from(tables)) {
      const range = currentTableRange(view, tableEl);
      if (!range || range.from !== target.from) continue;
      const sel = target.row < 0
        ? tableEl.querySelector(`thead th[data-c="${target.col}"]`)
        : tableEl.querySelector(`tbody tr[data-r="${target.row}"] td[data-c="${target.col}"]`);
      const cell = sel as HTMLElement | null;
      if (cell) {
        cell.focus();
        const r = document.createRange();
        r.selectNodeContents(cell);
        r.collapse(false);
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(r);
      }
      break;
    }
    pendingFocus = null;
  }
}

const tableFocusPlugin = ViewPlugin.fromClass(TableFocusPluginClass);

/* ── Exported extension ──────────────────────────────────── */

export const tablePlugin = [tableBlockDecoField, tableFocusPlugin];
