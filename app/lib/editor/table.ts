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

/* ── DOM-owned lifecycle and per-editor focus ─────────────── */

interface PendingFocus { from: number; row: number; col: number; }
// CodeMirror may replace the WidgetType instance while retaining its DOM.
// Event listeners and their composition/focus state belong to that DOM's owner.
const tableOwners = new WeakMap<HTMLElement, TableWidget>();

/* ── Table widget ─────────────────────────────────────────── */

function applyAlign(cell: HTMLElement, align: Align | undefined) {
  cell.style.textAlign = align && align !== 'default' ? align : '';
}

/** Locate the current document range of the Table backing a rendered DOM table. */
function currentTableRange(view: EditorView, tableEl: HTMLElement): BlockRange | null {
  if (!view.dom.contains(tableEl)) return null;
  let pos: number;
  try { pos = view.posAtDOM(tableEl); } catch { return null; }
  // posAtDOM can resolve to either edge of a block replacement. The field's
  // ranges describe the same decorations as the current document.
  return view.state.field(tableBlockDecoField).ranges.find(range =>
    range.from <= pos && pos <= range.to
  ) ?? null;
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

/** Commit and leave a blank, editable paragraph outside the replaced block. */
function exitTable(view: EditorView, tableEl: HTMLElement): void {
  const range = currentTableRange(view, tableEl);
  if (!range) return;
  const parsed = parseMarkdownTable(view.state.doc.sliceString(range.from, range.to));
  if (!parsed) return;
  const md = serializeTable({ ...readDomText(tableEl), alignments: parsed.alignments });
  const doc = view.state.doc;
  let after = range.to;
  while (after < doc.length && doc.sliceString(after, after + 1) === '\n') after++;
  // Keep a separator before the new paragraph, and (when there is following
  // content) after it too. Typing into the first newline would extend the table.
  const needed = after === doc.length ? 2 : 4;
  const padding = '\n'.repeat(Math.max(0, needed - (after - range.to)));
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: md + padding },
    selection: { anchor: range.from + md.length + 2 },
    scrollIntoView: true,
    userEvent: 'input',
  });
  view.focus();
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
  const active = tableEl.querySelector<HTMLElement>(':focus');
  const target = focusCell?.(next) ?? {
    row: Number(active?.dataset.r ?? -1),
    col: Number(active?.dataset.c ?? 0),
  };
  view.plugin(tableFocusPlugin)?.request({
    from: range.from,
    row: clamp(target.row, -1, next.rows.length - 1),
    col: clamp(target.col, 0, next.headers.length - 1),
  });
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: md },
    selection: { anchor: range.from },
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
  btn.setAttribute('aria-label', title);
  btn.innerHTML = html;
  btn.querySelector('svg')?.setAttribute('aria-hidden', 'true');
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
  private compositionTimer: number | undefined;
  private composingCell: HTMLElement | null = null;
  private controls: HTMLElement | null = null;
  private menuCleanup: (() => void) | null = null;

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
    cell.setAttribute('aria-label', row < 0 ? `Column ${col + 1} heading` : `Row ${row + 1}, column ${col + 1}`);
    cell.setAttribute('aria-keyshortcuts', 'Alt+F10 Shift+F10');
    if (row < 0) cell.scope = 'col';
    cell.innerHTML = renderInlineMarkdown(text);
    applyAlign(cell, this.table.alignments[col]);
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-novelist-table-widget';
    // The wrapper is a non-editable island; only cells re-enable editing.
    wrapper.contentEditable = 'false';
    tableOwners.set(wrapper, this);

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

    const controls = document.createElement('div');
    controls.className = 'cm-novelist-table-controls';
    this.controls = controls;
    this.rowToolbar = this.buildRowToolbar(tableEl, view);
    this.colToolbar = this.buildColToolbar(tableEl, view);
    controls.append(this.rowToolbar, this.colToolbar);
    const scroller = document.createElement('div');
    scroller.className = 'cm-novelist-table-scroll';
    scroller.appendChild(tableEl);
    wrapper.append(controls, scroller);
    this.attachHandlers(wrapper, tableEl, view);
    return wrapper;
  }

  /* — Event wiring (delegated; survives updateDOM DOM reuse) — */

  private attachHandlers(wrapper: HTMLElement, tableEl: HTMLElement, view: EditorView) {
    const cellOf = (t: EventTarget | null): HTMLTableCellElement | null => {
      const el = t as HTMLElement | null;
      return (el?.closest?.('td,th') as HTMLTableCellElement) ?? null;
    };

    wrapper.addEventListener('compositionstart', (e) => {
      e.stopPropagation();
      window.clearTimeout(this.compositionTimer);
      this.compositionTimer = undefined;
      this.composing = true;
      this.composingCell = cellOf(e.target);
      this.closeMenu();
      this.refreshToolbars();
    });
    wrapper.addEventListener('compositionend', (e) => {
      e.stopPropagation();
      // WebKit may send the confirming key and final input after compositionend.
      // Leave its DOM/caret untouched until that native event sequence settles.
      this.compositionTimer = window.setTimeout(() => {
        this.compositionTimer = undefined;
        this.composing = false;
        this.composingCell = null;
        this.refreshToolbars();
        if (this.commitOnComposeEnd) {
          this.commitOnComposeEnd = false;
          if (!wrapper.contains(view.root.activeElement)) commitFromDom(view, tableEl);
        }
      }, 0);
    });

    wrapper.addEventListener('focusin', (e) => {
      const cell = cellOf(e.target);
      if (!cell) return;
      this.active = { row: Number(cell.dataset.r), col: Number(cell.dataset.c) };
      this.refreshToolbars();
      this.controls?.classList.add('cm-novelist-table-controls-active');
    });

    // Commit when focus leaves the whole table.
    wrapper.addEventListener('focusout', (e) => {
      const next = (e as FocusEvent).relatedTarget as Node | null;
      if (next && this.menu?.contains(next)) return;
      if (next && wrapper.contains(next)) return; // moving between cells/toolbars
      this.hideToolbars();
      if (this.composing) { this.commitOnComposeEnd = true; return; }
      // Blurring can happen during a structural rebuild. Wait until CM has
      // reconciled DOM, then commit only a still-connected editing island.
      queueMicrotask(() => {
        if (this.composing) { this.commitOnComposeEnd = true; return; }
        if (!wrapper.contains(view.root.activeElement)) commitFromDom(view, tableEl);
      });
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
      if ((e.target as HTMLElement).closest('.cm-novelist-table-controls')) {
        e.stopPropagation();
        if (e.key === 'Escape' && !this.composing) {
          e.preventDefault();
          this.focusCell(tableEl, this.active?.row ?? -1, this.active?.col ?? 0, true);
        }
        return;
      }
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
    if (this.composing || e.isComposing || e.keyCode === 229) return;
    // Keep Tab's cell navigation while making structural controls keyboard reachable.
    if (e.altKey && e.key === 'F10') {
      e.preventDefault();
      this.controls?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
      return;
    }
    if (e.key === 'Escape' && this.menu) {
      e.preventDefault();
      this.closeMenu();
      return;
    }
    if (e.shiftKey && e.key === 'F10') {
      e.preventDefault();
      const rect = cell.getBoundingClientRect();
      this.openContextMenu(new MouseEvent('contextmenu', { clientX: rect.left, clientY: rect.bottom }), tableEl, view);
      this.menu?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
      return;
    }
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
      if (row < 0 && nrows > 0) { this.focusCell(tableEl, 0, col, true); return; }
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
      exitTable(view, tableEl);
      return;
    }
  }

  /* — Toolbars (focus-anchored) — */

  private buildRowToolbar(tableEl: HTMLElement, view: EditorView): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cm-novelist-table-toolbar cm-novelist-table-toolbar-row';
    bar.contentEditable = 'false';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Table row actions');
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
      applyStructural(view, tableEl, t => deleteRow(t, r), () => ({ row: r, col: this.active?.col ?? 0 }));
    }));
    return bar;
  }

  private buildColToolbar(tableEl: HTMLElement, view: EditorView): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'cm-novelist-table-toolbar cm-novelist-table-toolbar-col';
    bar.contentEditable = 'false';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Table column actions');
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
      applyStructural(view, tableEl, t => deleteColumn(t, c), () => ({ row: this.active?.row ?? -1, col: c }));
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

  private refreshToolbars() {
    if (!this.rowToolbar || !this.colToolbar) return;
    const row = this.active?.row ?? -1;
    const col = this.active?.col ?? 0;
    const rowButtons = this.rowToolbar.querySelectorAll('button');
    rowButtons.forEach(button => { button.disabled = this.composing; });
    rowButtons[2].disabled = this.composing || row < 0;
    const colButtons = this.colToolbar.querySelectorAll('button');
    colButtons.forEach(button => { button.disabled = this.composing; });
    colButtons[2].disabled = this.composing || this.table.headers.length <= 1;
    const align = this.table.alignments[col] ?? 'default';
    for (const [index, value] of ['left', 'center', 'right'].entries()) {
      colButtons[index + 3].setAttribute('aria-pressed', String(align === value || (value === 'left' && align === 'default')));
    }
    this.rowToolbar.setAttribute('aria-label', row < 0 ? 'Table header actions' : `Table row ${row + 1} actions`);
    this.colToolbar.setAttribute('aria-label', `Table column ${col + 1} actions`);
  }

  private hideToolbars() {
    this.controls?.classList.remove('cm-novelist-table-controls-active');
  }

  /* — Context menu — */

  private openContextMenu(e: MouseEvent, tableEl: HTMLElement, view: EditorView) {
    this.closeMenu();
    if (this.composing) return;
    const menu = document.createElement('div');
    menu.className = 'context-menu cm-novelist-table-menu';
    menu.contentEditable = 'false';
    const scale = parseFloat(document.documentElement.style.transform.match(/scale\(([^)]+)\)/)?.[1] || '1');
    menu.style.left = `${e.clientX / scale}px`;
    menu.style.top = `${e.clientY / scale}px`;

    const r = this.active?.row ?? -1;
    const c = this.active?.col ?? 0;

    const item = (label: string, onClick: () => void, danger = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'context-menu-item' + (danger ? ' context-menu-item-danger' : '');
      b.textContent = label;
      b.addEventListener('mousedown', (ev) => ev.preventDefault());
      b.disabled = label === MENU.delCol && this.table.headers.length <= 1;
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (this.composing) return;
        this.closeMenu();
        onClick();
      });
      menu.appendChild(b);
    };
    const sep = () => { const d = document.createElement('div'); d.className = 'context-menu-separator'; menu.appendChild(d); };

    item(MENU.rowAbove, () => applyStructural(view, tableEl, t => insertRow(t, Math.max(0, r)), () => ({ row: Math.max(0, r), col: c })));
    item(MENU.rowBelow, () => applyStructural(view, tableEl, t => insertRow(t, r + 1), () => ({ row: r + 1, col: c })));
    item(MENU.colLeft, () => applyStructural(view, tableEl, t => insertColumn(t, c), () => ({ row: r, col: c })));
    item(MENU.colRight, () => applyStructural(view, tableEl, t => insertColumn(t, c + 1), () => ({ row: r, col: c + 1 })));
    sep();
    if (r >= 0) item(MENU.delRow, () => applyStructural(view, tableEl, t => deleteRow(t, r), () => ({ row: r, col: c })), true);
    item(MENU.delCol, () => applyStructural(view, tableEl, t => deleteColumn(t, c), () => ({ row: r, col: c })), true);
    sep();
    item(MENU.alignLeft, () => applyStructural(view, tableEl, t => setAlignment(t, c, 'left'), () => ({ row: r, col: c })));
    item(MENU.alignCenter, () => applyStructural(view, tableEl, t => setAlignment(t, c, 'center'), () => ({ row: r, col: c })));
    item(MENU.alignRight, () => applyStructural(view, tableEl, t => setAlignment(t, c, 'right'), () => ({ row: r, col: c })));
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
    const viewport = window.visualViewport;
    const width = (viewport?.width ?? window.innerWidth) / scale;
    const height = (viewport?.height ?? window.innerHeight) / scale;
    menu.style.maxHeight = `${Math.max(0, height - 16)}px`;
    menu.style.left = `${clamp(e.clientX / scale, 8, Math.max(8, width - menu.offsetWidth - 8))}px`;
    menu.style.top = `${clamp(e.clientY / scale, 8, Math.max(8, height - menu.offsetHeight - 8))}px`;
    menu.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeMenu();
        this.focusCell(tableEl, r, c, true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      }
    });

    const close = (ev: Event) => {
      if (ev instanceof KeyboardEvent && ev.key !== 'Escape') return;
      if (ev instanceof MouseEvent && menu.contains(ev.target as Node)) return;
      this.closeMenu();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    this.menuCleanup = () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }

  private closeMenu() {
    if (!this.menu) return;
    this.menuCleanup?.();
    this.menuCleanup = null;
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
    const owner = tableOwners.get(dom);
    if (!owner) return false;
    const ncols = this.table.headers.length;
    const headerCells = tableEl.querySelectorAll('thead th');
    const bodyRows = tableEl.querySelectorAll('tbody tr');
    if (headerCells.length !== ncols || bodyRows.length !== this.table.rows.length) return false;
    for (const tr of Array.from(bodyRows)) {
      if (tr.querySelectorAll('td').length !== ncols) return false;
    }

    const active = document.activeElement;
    headerCells.forEach((th, i) => {
      applyAlign(th as HTMLElement, this.table.alignments[i]);
      if (th === active || th === owner.composingCell || this.table.headers[i] === owner.table.headers[i]) return;
      const html = renderInlineMarkdown(this.table.headers[i] ?? '');
      if (th.innerHTML !== html) th.innerHTML = html;
    });
    bodyRows.forEach((tr, r) => {
      tr.querySelectorAll('td').forEach((td, c) => {
        applyAlign(td as HTMLElement, this.table.alignments[c]);
        if (td === active || td === owner.composingCell || this.table.rows[r]?.[c] === owner.table.rows[r]?.[c]) return;
        const html = renderInlineMarkdown(this.table.rows[r]?.[c] ?? '');
        if (td.innerHTML !== html) td.innerHTML = html;
      });
    });
    owner.table = this.table;
    owner.raw = this.raw;
    owner.refreshToolbars();
    return true;
  }

  destroy(dom: HTMLElement) {
    const owner = tableOwners.get(dom);
    if (!owner) return;
    owner.closeMenu();
    window.clearTimeout(owner.compositionTimer);
    tableOwners.delete(dom);
  }

  get estimatedHeight(): number {
    // Header, reserved controls, padding, and compact body rows.
    return 84 + this.table.rows.length * 38;
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
    if (tr.docChanged) return buildTableBlockState(tr.state);
    if (tr.state.field(imeComposingField, false)) return value;
    if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildTableBlockState(tr.state);
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f, value => value.decorations),
});

/* ── Pending-focus flusher (after structural rebuild) ────── */

class TableFocusPluginClass {
  private pending: PendingFocus | null = null;
  private origin: Element | null = null;
  private scheduled = false;
  private destroyed = false;

  constructor(private view: EditorView) {}

  request(target: PendingFocus) {
    this.pending = target;
    this.origin = this.view.root.activeElement;
    this.schedule();
  }

  update(update: ViewUpdate) {
    if (!this.pending) return;
    if (update.docChanged) {
      this.pending.from = update.changes.mapPos(this.pending.from, -1);
    }
    this.schedule();
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    // ViewPlugin.update runs before CM reconciles widget DOM. Focus only after
    // that synchronous update finishes, never the soon-to-be-detached old cell.
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.destroyed || !this.pending) return;
      const active = this.view.root.activeElement;
      if (active && active !== this.origin && active !== document.body &&
          !(active === this.view.contentDOM && !this.origin?.isConnected)) {
        this.pending = null;
        return;
      }
      const target = this.pending;
      for (const tableEl of this.view.dom.querySelectorAll<HTMLElement>('table.cm-novelist-rendered-table')) {
        if (currentTableRange(this.view, tableEl)?.from !== target.from) continue;
        const cell = tableEl.querySelector<HTMLElement>(`[data-r="${target.row}"][data-c="${target.col}"]`);
        if (!cell) return;
        this.pending = null;
        cell.focus({ preventScroll: true });
        const range = document.createRange();
        range.selectNodeContents(cell);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return;
      }
      // A viewport update can render the target later; retain the request.
    });
  }

  destroy() {
    this.destroyed = true;
    this.pending = null;
  }
}

const tableFocusPlugin = ViewPlugin.fromClass(TableFocusPluginClass);

/* ── Exported extension ──────────────────────────────────── */

export const tablePlugin = [tableBlockDecoField, tableFocusPlugin];
