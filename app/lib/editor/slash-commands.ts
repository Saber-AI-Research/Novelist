import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { StateField, StateEffect, Prec } from '@codemirror/state';

/**
 * Slash command menu — Notion-style "/" block insertion.
 *
 * When the user types "/" at the start of a line (or on an otherwise empty line),
 * a floating menu appears with block type options. Selecting an option replaces
 * the "/" (and any filter text) with the appropriate markdown syntax.
 */

interface SlashMenuItem {
  id: string;
  label: string;
  description: string;
  /** Inline SVG markup (rendered via innerHTML — always author-controlled, never user input). */
  icon: string;
  /** The markdown text to insert. "{cursor}" marks where the cursor should land. */
  insert: string;
  /** Search keywords for filtering */
  keywords: string[];
}

// ── SVG icons ───────────────────────────────────────────────────────────
// 24×24 viewBox, 1.75 stroke, currentColor — scale/tint via CSS.
// Kept inline as strings so the whole slash extension stays a single file.
const svgHeading = (n: number) => `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <text x="12" y="17" text-anchor="middle" font-size="13" font-weight="700" font-family="var(--novelist-editor-font, system-ui, sans-serif)" fill="currentColor">H${n}</text>
</svg>`;

const svgBulletList = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="5" cy="7" r="1.3" fill="currentColor" stroke="none"/>
  <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/>
  <circle cx="5" cy="17" r="1.3" fill="currentColor" stroke="none"/>
  <line x1="10" y1="7" x2="19" y2="7"/>
  <line x1="10" y1="12" x2="19" y2="12"/>
  <line x1="10" y1="17" x2="19" y2="17"/>
</svg>`;

const svgNumberedList = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <line x1="10" y1="7" x2="19" y2="7"/>
  <line x1="10" y1="12" x2="19" y2="12"/>
  <line x1="10" y1="17" x2="19" y2="17"/>
  <text x="4.5" y="9.3" text-anchor="middle" font-size="6.5" font-weight="700" fill="currentColor" stroke="none">1</text>
  <text x="4.5" y="14.3" text-anchor="middle" font-size="6.5" font-weight="700" fill="currentColor" stroke="none">2</text>
  <text x="4.5" y="19.3" text-anchor="middle" font-size="6.5" font-weight="700" fill="currentColor" stroke="none">3</text>
</svg>`;

const svgTaskList = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="4" y="4" width="16" height="16" rx="3"/>
  <path d="M8.5 12.25l2.75 2.75L16 9.75"/>
</svg>`;

const svgCodeBlock = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M9 7l-5 5 5 5"/>
  <path d="M15 7l5 5-5 5"/>
  <line x1="13.5" y1="5" x2="10.5" y2="19" opacity="0.5"/>
</svg>`;

const svgQuote = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <line x1="5" y1="5" x2="5" y2="19" stroke-width="2.5"/>
  <line x1="10" y1="8" x2="19" y2="8"/>
  <line x1="10" y1="12" x2="17" y2="12"/>
  <line x1="10" y1="16" x2="18" y2="16"/>
</svg>`;

const svgDivider = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <line x1="3" y1="8" x2="21" y2="8" opacity="0.45"/>
  <line x1="3" y1="12" x2="21" y2="12" stroke-width="2"/>
  <line x1="3" y1="16" x2="21" y2="16" opacity="0.45"/>
</svg>`;

const svgImage = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="3.25" y="4.5" width="17.5" height="15" rx="2.25"/>
  <circle cx="9" cy="10" r="1.5" fill="currentColor" stroke="none"/>
  <path d="M3.5 17l4.5-4.5 3.5 3.5L15.5 12l5 5"/>
</svg>`;

const svgTable = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="3.5" y="4.5" width="17" height="15" rx="2"/>
  <line x1="3.5" y1="9.25" x2="20.5" y2="9.25"/>
  <line x1="3.5" y1="14.5" x2="20.5" y2="14.5"/>
  <line x1="9.5" y1="4.5" x2="9.5" y2="19.5"/>
  <line x1="14.5" y1="4.5" x2="14.5" y2="19.5"/>
</svg>`;

const svgMath = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M18 5H6.5l5.5 7-5.5 7H18"/>
</svg>`;

const svgCallout = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M9 17.5h6"/>
  <path d="M10 20.5h4"/>
  <path d="M12 3a6 6 0 00-4 10.5c.75.75 1 1.5 1 2.5h6c0-1 .25-1.75 1-2.5A6 6 0 0012 3z"/>
</svg>`;

const slashItems: SlashMenuItem[] = [
  {
    id: 'heading1', label: 'Heading 1', description: 'Large section heading',
    icon: svgHeading(1), insert: '# {cursor}', keywords: ['h1', 'heading', 'title', '标题'],
  },
  {
    id: 'heading2', label: 'Heading 2', description: 'Medium section heading',
    icon: svgHeading(2), insert: '## {cursor}', keywords: ['h2', 'heading', '标题'],
  },
  {
    id: 'heading3', label: 'Heading 3', description: 'Small section heading',
    icon: svgHeading(3), insert: '### {cursor}', keywords: ['h3', 'heading', '标题'],
  },
  {
    id: 'bulletList', label: 'Bullet List', description: 'Unordered list item',
    icon: svgBulletList, insert: '- {cursor}', keywords: ['bullet', 'list', 'unordered', '列表', '无序'],
  },
  {
    id: 'numberedList', label: 'Numbered List', description: 'Ordered list item',
    icon: svgNumberedList, insert: '1. {cursor}', keywords: ['number', 'ordered', 'list', '列表', '有序'],
  },
  {
    id: 'taskList', label: 'Task List', description: 'Checkbox todo item',
    icon: svgTaskList, insert: '- [ ] {cursor}', keywords: ['task', 'todo', 'checkbox', '任务', '待办'],
  },
  {
    id: 'codeBlock', label: 'Code Block', description: 'Fenced code block',
    icon: svgCodeBlock, insert: '```\n{cursor}\n```', keywords: ['code', 'fence', '代码'],
  },
  {
    id: 'quote', label: 'Quote', description: 'Block quotation',
    icon: svgQuote, insert: '> {cursor}', keywords: ['quote', 'blockquote', '引用'],
  },
  {
    id: 'divider', label: 'Divider', description: 'Horizontal rule',
    icon: svgDivider, insert: '---\n{cursor}', keywords: ['divider', 'hr', 'horizontal', 'rule', '分割线'],
  },
  {
    id: 'image', label: 'Image', description: 'Insert image',
    icon: svgImage, insert: '![{cursor}]()', keywords: ['image', 'img', 'picture', '图片'],
  },
  {
    id: 'table', label: 'Table', description: 'Insert a table',
    icon: svgTable, insert: '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| {cursor} |  |  |', keywords: ['table', '表格'],
  },
  {
    id: 'math', label: 'Math Block', description: 'LaTeX math expression',
    icon: svgMath, insert: '$$\n{cursor}\n$$', keywords: ['math', 'latex', 'equation', '数学', '公式'],
  },
  {
    id: 'callout', label: 'Callout', description: 'Highlighted note block',
    icon: svgCallout, insert: '> [!NOTE]\n> {cursor}', keywords: ['callout', 'note', 'tip', 'warning', '提示', '高亮'],
  },
];

/** Apply i18n labels if available. Called once at extension init. */
let _i18nLabels: Map<string, { label: string; description: string }> | null = null;
export function setSlashCommandI18n(labels: Map<string, { label: string; description: string }>) {
  _i18nLabels = labels;
}

function getItems(): SlashMenuItem[] {
  if (!_i18nLabels) return slashItems;
  return slashItems.map(item => {
    const override = _i18nLabels!.get(item.id);
    if (override) return { ...item, label: override.label, description: override.description };
    return item;
  });
}

function filterItems(query: string): SlashMenuItem[] {
  const items = getItems();
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter(item =>
    item.label.toLowerCase().includes(q) ||
    item.description.toLowerCase().includes(q) ||
    item.keywords.some(k => k.includes(q))
  );
}

// --- State management ---

const showSlashMenu = StateEffect.define<{ pos: number; lineStart: number } | null>();

interface SlashMenuState {
  /** Position of the "/" character */
  pos: number;
  /** Start of the line containing "/" */
  lineStart: number;
  /** Whether menu is active */
  active: boolean;
}

const slashMenuField = StateField.define<SlashMenuState | null>({
  create() { return null; },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(showSlashMenu)) {
        return effect.value ? { ...effect.value, active: true } : null;
      }
    }
    if (value && tr.docChanged) {
      // If the doc changed, check if the slash context is still valid
      const mapped = tr.changes.mapPos(value.pos, -1);
      if (mapped < 0) return null;
      // Check if the "/" is still there
      const line = tr.state.doc.lineAt(mapped);
      const textBeforeSlash = tr.state.doc.sliceString(line.from, mapped);
      if (textBeforeSlash.trim() !== '') return null;
      const charAtPos = tr.state.doc.sliceString(mapped, mapped + 1);
      if (charAtPos !== '/' && charAtPos !== '\uFF0F') return null;
      return { ...value, pos: mapped, lineStart: line.from };
    }
    if (value && tr.selection) {
      // Close menu if cursor moves away from the slash line
      const head = tr.state.selection.main.head;
      const line = tr.state.doc.lineAt(value.pos);
      if (head < value.pos || head > line.to) return null;
    }
    return value;
  },
});

export function isSlashMenuOpen(state: EditorView['state']): boolean {
  return Boolean(state.field(slashMenuField, false)?.active);
}

// --- Menu DOM ---

class SlashMenuWidget {
  private dom: HTMLElement | null = null;
  private selectedIndex = 0;
  private filteredItems: SlashMenuItem[] = [];
  private view: EditorView;
  private slashPos: number;
  private positionRetries = 0;

  constructor(view: EditorView, slashPos: number) {
    this.view = view;
    this.slashPos = slashPos;
    this.filteredItems = getItems();
    this.createDOM();
    this.schedulePosition();
  }

  private schedulePosition() {
    // Defer to after CM6's measure phase; the newly-inserted "/" may not yet
    // be rendered in the DOM when we're called from inside a ViewPlugin.update().
    this.view.requestMeasure({
      read: (view) => view.coordsAtPos(this.slashPos) ?? view.coordsAtPos(Math.max(0, this.slashPos - 1)),
      write: (coords) => {
        if (!this.dom) return;
        if (coords) {
          this.applyPosition(coords);
          return;
        }
        // Still not measurable — retry via rAF. The menu stays in the DOM at
        // its last position (or default 0,0) so the user still sees it.
        if (this.positionRetries < 5) {
          this.positionRetries++;
          requestAnimationFrame(() => this.schedulePosition());
        }
      },
    });
  }

  private createDOM() {
    this.dom = document.createElement('div');
    this.dom.className = 'cm-slash-menu';
    this.dom.setAttribute('role', 'listbox');
    // Hide until first successful positioning to avoid a (0,0) flash while
    // CM6's measure cycle catches up to the newly-inserted "/".
    this.dom.style.visibility = 'hidden';
    this.render();
    document.body.appendChild(this.dom);
  }

  private render() {
    if (!this.dom) return;
    this.dom.innerHTML = '';

    if (this.filteredItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cm-slash-menu-empty';
      empty.textContent = 'No results';
      this.dom.appendChild(empty);
      return;
    }

    this.filteredItems.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'cm-slash-menu-item' + (i === this.selectedIndex ? ' cm-slash-menu-item-selected' : '');
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', String(i === this.selectedIndex));

      const icon = document.createElement('span');
      icon.className = 'cm-slash-menu-icon';
      // Author-controlled SVG markup (see constants at top of file).
      icon.innerHTML = item.icon;
      el.appendChild(icon);

      const text = document.createElement('div');
      text.className = 'cm-slash-menu-text';
      const label = document.createElement('div');
      label.className = 'cm-slash-menu-label';
      label.textContent = item.label;
      text.appendChild(label);
      const desc = document.createElement('div');
      desc.className = 'cm-slash-menu-desc';
      desc.textContent = item.description;
      text.appendChild(desc);
      el.appendChild(text);

      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.apply(item);
      });
      el.addEventListener('mouseenter', () => {
        this.selectedIndex = i;
        this.render();
      });

      this.dom!.appendChild(el);
    });

    // Scroll selected item into view
    const selected = this.dom.querySelector('.cm-slash-menu-item-selected');
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  position() {
    this.schedulePosition();
  }

  private applyPosition(coords: { left: number; top: number; bottom: number; right: number }) {
    if (!this.dom) return;

    // Measure the hidden menu (layout runs on-demand for getBoundingClientRect).
    // Fallback to CSS caps (max-height 320 / width 280) when happy-dom / pre-
    // layout paths return zero-sized rects.
    const rect = this.dom.getBoundingClientRect();
    const menuH = rect.height || 320;
    const menuW = rect.width || 280;
    const gap = 6;
    const margin = 8;

    const spaceBelow = window.innerHeight - coords.bottom - margin;
    const spaceAbove = coords.top - margin;

    // Prefer below (menu top aligned with cursor bottom). Flip above (menu
    // bottom aligned with cursor top) when the cursor sits in the lower
    // half and there isn't enough room below. If neither side fits we keep
    // the side with more room and clamp into the viewport.
    let top: number;
    if (spaceBelow >= menuH + gap) {
      top = coords.bottom + gap;
    } else if (spaceAbove >= menuH + gap) {
      top = coords.top - menuH - gap;
    } else if (spaceAbove > spaceBelow) {
      top = Math.max(margin, coords.top - menuH - gap);
    } else {
      top = coords.bottom + gap;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - menuH - margin));

    // Horizontal: anchor to cursor left, clamp into viewport.
    let left = coords.left;
    if (left + menuW > window.innerWidth - margin) {
      left = window.innerWidth - menuW - margin;
    }
    left = Math.max(margin, left);

    this.dom.style.top = `${top}px`;
    this.dom.style.left = `${left}px`;
    this.dom.style.visibility = 'visible';
  }

  updateQuery(query: string) {
    this.filteredItems = filterItems(query);
    this.selectedIndex = 0;
    this.render();
    // Height changes with the filtered item count; re-evaluate flip direction
    // so the menu doesn't end up half off-screen at the bottom of the viewport.
    this.positionRetries = 0;
    this.schedulePosition();
  }

  handleKey(key: string): boolean {
    if (key === 'ArrowDown') {
      this.selectedIndex = (this.selectedIndex + 1) % Math.max(1, this.filteredItems.length);
      this.render();
      return true;
    }
    if (key === 'ArrowUp') {
      this.selectedIndex = (this.selectedIndex - 1 + this.filteredItems.length) % Math.max(1, this.filteredItems.length);
      this.render();
      return true;
    }
    if (key === 'Enter' || key === 'Tab') {
      if (this.filteredItems.length > 0) {
        this.apply(this.filteredItems[this.selectedIndex]);
        return true;
      }
    }
    if (key === 'Escape') {
      this.close();
      return true;
    }
    return false;
  }

  private apply(item: SlashMenuItem) {
    const state = this.view.state;
    const menuState = state.field(slashMenuField);
    if (!menuState) return;

    // Find the range to replace: from "/" to current cursor position
    const head = state.selection.main.head;
    const from = menuState.pos;
    const to = head;

    const insertText = item.insert;
    const cursorOffset = insertText.indexOf('{cursor}');
    const cleanText = insertText.replace('{cursor}', '');

    this.view.dispatch({
      changes: { from, to, insert: cleanText },
      selection: { anchor: from + (cursorOffset >= 0 ? cursorOffset : cleanText.length) },
      effects: showSlashMenu.of(null),
    });

    this.destroy();
  }

  close() {
    this.view.dispatch({
      effects: showSlashMenu.of(null),
    });
    this.destroy();
  }

  destroy() {
    if (this.dom) {
      this.dom.remove();
      this.dom = null;
    }
  }

  get isActive() { return this.dom !== null; }
}

// --- Editor plugin ---

const slashMenuPlugin = ViewPlugin.fromClass(class {
  menu: SlashMenuWidget | null = null;

  constructor(_view: EditorView) {}

  update(update: ViewUpdate) {
    const menuState = update.state.field(slashMenuField);

    if (!menuState) {
      if (this.menu) { this.menu.destroy(); this.menu = null; }

      // Fallback: detect "/" at line start when inputHandler was bypassed (e.g. IME)
      if (update.docChanged && !update.startState.field(slashMenuField)) {
        const head = update.state.selection.main.head;
        if (head > 0) {
          const charBefore = update.state.doc.sliceString(head - 1, head);
          if (charBefore === '/' || charBefore === '\uFF0F') {
            const line = update.state.doc.lineAt(head);
            const textBeforeSlash = update.state.doc.sliceString(line.from, head - 1);
            if (textBeforeSlash.trim() === '') {
              // Defer dispatch — calling dispatch inside a plugin update is not allowed
              const view = update.view;
              queueMicrotask(() => {
                view.dispatch({
                  effects: showSlashMenu.of({ pos: head - 1, lineStart: line.from }),
                });
              });
            }
          }
        }
      }
      return;
    }

    if (menuState.active && !this.menu) {
      this.menu = new SlashMenuWidget(update.view, menuState.pos);
    }

    if (this.menu && menuState.active) {
      // Update filter query based on text after "/"
      const head = update.state.selection.main.head;
      const query = update.state.doc.sliceString(menuState.pos + 1, head);
      this.menu.updateQuery(query);
    }
  }

  destroy() {
    if (this.menu) { this.menu.destroy(); this.menu = null; }
  }
});

// --- Key handler for "/" trigger ---

const slashTriggerHandler = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '/' && text !== '\uFF0F') return false;

  // Only trigger at the start of a line (empty or whitespace only before cursor)
  const line = view.state.doc.lineAt(from);
  const textBefore = view.state.doc.sliceString(line.from, from);
  if (textBefore.trim() !== '') return false;

  // Insert the "/" first, then show the menu
  view.dispatch({
    changes: { from, to, insert: '/' },
    selection: { anchor: from + 1 },
    effects: showSlashMenu.of({ pos: from, lineStart: line.from }),
  });
  return true;
});

// --- Key intercept for menu navigation ---

const slashKeyHandler = EditorView.domEventHandlers({
  keydown(event: KeyboardEvent, view: EditorView) {
    const menuState = view.state.field(slashMenuField, false);
    if (!menuState?.active) return false;

    // Find the active SlashMenuWidget via the plugin
    const plugin = view.plugin(slashMenuPlugin);
    if (!plugin) return false;

    const menu = plugin.menu;
    if (!menu?.isActive) return false;

    if (menu.handleKey(event.key)) {
      event.preventDefault();
      return true;
    }

    // Close on Backspace if we'd delete the "/"
    if (event.key === 'Backspace') {
      const head = view.state.selection.main.head;
      if (head <= menuState.pos + 1) {
        menu.close();
        // Don't prevent default — let Backspace delete the "/"
      }
    }

    return false;
  },
});

// --- CSS ---

const slashMenuTheme = EditorView.theme({
  // Theme just ensures our menu is properly styled
});

/**
 * Slash command extension — add to editor extensions to enable "/" menu.
 */
export const slashCommandExtension = [
  slashMenuField,
  slashMenuPlugin,
  slashTriggerHandler,
  // `defaultKeymap` binds ArrowUp/Down to cursor movement — raise the slash
  // key handler to highest precedence so it consumes navigation keys while
  // the menu is open.
  Prec.highest(slashKeyHandler),
  slashMenuTheme,
];
