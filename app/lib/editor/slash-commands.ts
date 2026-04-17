import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';

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
  icon: string;
  /** The markdown text to insert. "{cursor}" marks where the cursor should land. */
  insert: string;
  /** Search keywords for filtering */
  keywords: string[];
}

const slashItems: SlashMenuItem[] = [
  {
    id: 'heading1', label: 'Heading 1', description: 'Large section heading',
    icon: 'H1', insert: '# {cursor}', keywords: ['h1', 'heading', 'title', '标题'],
  },
  {
    id: 'heading2', label: 'Heading 2', description: 'Medium section heading',
    icon: 'H2', insert: '## {cursor}', keywords: ['h2', 'heading', '标题'],
  },
  {
    id: 'heading3', label: 'Heading 3', description: 'Small section heading',
    icon: 'H3', insert: '### {cursor}', keywords: ['h3', 'heading', '标题'],
  },
  {
    id: 'bulletList', label: 'Bullet List', description: 'Unordered list item',
    icon: '•', insert: '- {cursor}', keywords: ['bullet', 'list', 'unordered', '列表', '无序'],
  },
  {
    id: 'numberedList', label: 'Numbered List', description: 'Ordered list item',
    icon: '1.', insert: '1. {cursor}', keywords: ['number', 'ordered', 'list', '列表', '有序'],
  },
  {
    id: 'taskList', label: 'Task List', description: 'Checkbox todo item',
    icon: '☐', insert: '- [ ] {cursor}', keywords: ['task', 'todo', 'checkbox', '任务', '待办'],
  },
  {
    id: 'codeBlock', label: 'Code Block', description: 'Fenced code block',
    icon: '<>', insert: '```\n{cursor}\n```', keywords: ['code', 'fence', '代码'],
  },
  {
    id: 'quote', label: 'Quote', description: 'Block quotation',
    icon: '"', insert: '> {cursor}', keywords: ['quote', 'blockquote', '引用'],
  },
  {
    id: 'divider', label: 'Divider', description: 'Horizontal rule',
    icon: '—', insert: '---\n{cursor}', keywords: ['divider', 'hr', 'horizontal', 'rule', '分割线'],
  },
  {
    id: 'image', label: 'Image', description: 'Insert image',
    icon: '🖼', insert: '![{cursor}]()', keywords: ['image', 'img', 'picture', '图片'],
  },
  {
    id: 'table', label: 'Table', description: 'Insert a table',
    icon: '⊞', insert: '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| {cursor} |  |  |', keywords: ['table', '表格'],
  },
  {
    id: 'math', label: 'Math Block', description: 'LaTeX math expression',
    icon: '∑', insert: '$$\n{cursor}\n$$', keywords: ['math', 'latex', 'equation', '数学', '公式'],
  },
  {
    id: 'callout', label: 'Callout', description: 'Highlighted note block',
    icon: '💡', insert: '> [!NOTE]\n> {cursor}', keywords: ['callout', 'note', 'tip', 'warning', '提示', '高亮'],
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

// --- Menu DOM ---

class SlashMenuWidget {
  private dom: HTMLElement | null = null;
  private selectedIndex = 0;
  private filteredItems: SlashMenuItem[] = [];
  private view: EditorView;
  private slashPos: number;

  constructor(view: EditorView, slashPos: number) {
    this.view = view;
    this.slashPos = slashPos;
    this.filteredItems = getItems();
    this.createDOM();
    this.position();
  }

  private createDOM() {
    this.dom = document.createElement('div');
    this.dom.className = 'cm-slash-menu';
    this.dom.setAttribute('role', 'listbox');
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
      icon.textContent = item.icon;
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
    if (!this.dom) return;
    const coords = this.view.coordsAtPos(this.slashPos);
    if (!coords) { this.destroy(); return; }

    this.dom.style.left = `${coords.left}px`;
    this.dom.style.top = `${coords.bottom + 4}px`;

    // Ensure menu doesn't go off-screen
    requestAnimationFrame(() => {
      if (!this.dom) return;
      const rect = this.dom.getBoundingClientRect();
      if (rect.bottom > window.innerHeight) {
        this.dom.style.top = `${coords.top - rect.height - 4}px`;
      }
      if (rect.right > window.innerWidth) {
        this.dom.style.left = `${window.innerWidth - rect.width - 8}px`;
      }
    });
  }

  updateQuery(query: string) {
    this.filteredItems = filterItems(query);
    this.selectedIndex = 0;
    this.render();
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
  slashKeyHandler,
  slashMenuTheme,
];
