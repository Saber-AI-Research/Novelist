import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';
import { runScopeHandlers } from '@codemirror/view';
import {
  SearchQuery,
  getSearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  selectMatches,
  replaceNext,
  replaceAll,
  closeSearchPanel,
  openSearchPanel,
  searchPanelOpen,
} from '@codemirror/search';
import { t } from '$lib/i18n';

/**
 * Custom in-editor Find / Replace panel (Cmd+F).
 *
 * Replaces CodeMirror's default `SearchPanel` (see
 * node_modules/@codemirror/search/dist/index.js) for three reasons:
 *  1. Vertical layout — the search field sits above the replace field
 *     (VSCode-style), instead of one wrapping horizontal row.
 *  2. i18n — labels/placeholders come from the app's `t()` rather than
 *     CM6's hardcoded English `state.phrase(...)`.
 *  3. Works with the VSCode-style `openOrRefocusSearch` Cmd+F command below.
 *
 * The wiring (commit/keydown/update/setQuery/mount, the `main-field` marker,
 * and the `.cm-textfield` / `[name=close]` selectors) mirrors the default panel
 * so the rest of `@codemirror/search` keeps working unchanged.
 */

type El = HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> | null,
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'checked') {
        (node as HTMLInputElement).checked = Boolean(v);
      } else if (k === 'value') {
        (node as HTMLInputElement).value = String(v);
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

class NovelistSearchPanel implements Panel {
  dom: El;
  private searchField: HTMLInputElement;
  private replaceField: HTMLInputElement;
  private caseField: HTMLInputElement;
  private reField: HTMLInputElement;
  private wordField: HTMLInputElement;
  private query: SearchQuery;

  constructor(private view: EditorView) {
    const query = (this.query = getSearchQuery(view.state));
    this.commit = this.commit.bind(this);

    this.searchField = el('input', {
      value: query.search,
      placeholder: t('find.searchPlaceholder'),
      'aria-label': t('find.search'),
      class: 'cm-textfield',
      name: 'search',
      form: '',
      'main-field': 'true',
      onchange: this.commit,
      onkeyup: this.commit,
    }) as HTMLInputElement;

    this.replaceField = el('input', {
      value: query.replace,
      placeholder: t('find.replacePlaceholder'),
      'aria-label': t('find.replace'),
      class: 'cm-textfield',
      name: 'replace',
      form: '',
      onchange: this.commit,
      onkeyup: this.commit,
    }) as HTMLInputElement;

    this.caseField = el('input', { type: 'checkbox', name: 'case', form: '', checked: query.caseSensitive, onchange: this.commit }) as HTMLInputElement;
    this.reField = el('input', { type: 'checkbox', name: 're', form: '', checked: query.regexp, onchange: this.commit }) as HTMLInputElement;
    this.wordField = el('input', { type: 'checkbox', name: 'word', form: '', checked: query.wholeWord, onchange: this.commit }) as HTMLInputElement;

    const button = (name: string, onclick: () => void, label: string) =>
      el('button', { class: 'cm-button', name, onclick, type: 'button' }, [label]);

    const searchRow = el('div', { class: 'cm-search-row' }, [
      this.searchField,
      button('prev', () => findPrevious(view), t('find.previous')),
      button('next', () => findNext(view), t('find.next')),
      button('select', () => selectMatches(view), t('find.all')),
      el('label', null, [this.caseField, t('find.matchCase')]),
      el('label', null, [this.wordField, t('find.wholeWord')]),
      el('label', null, [this.reField, t('find.regexp')]),
    ]);

    const rows: (Node | string)[] = [searchRow];
    if (!view.state.readOnly) {
      rows.push(
        el('div', { class: 'cm-search-row' }, [
          this.replaceField,
          button('replace', () => replaceNext(view), t('find.replaceOne')),
          button('replaceAll', () => replaceAll(view), t('find.replaceAll')),
        ]),
      );
    }

    rows.push(
      el('button', { name: 'close', onclick: () => closeSearchPanel(view), 'aria-label': t('find.close'), title: t('find.close'), type: 'button' }, ['×']),
    );

    this.dom = el('div', { onkeydown: (e: KeyboardEvent) => this.keydown(e), class: 'cm-search' }, rows);
  }

  private commit() {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.caseField.checked,
      regexp: this.reField.checked,
      wholeWord: this.wordField.checked,
      replace: this.replaceField.value,
    });
    if (!query.eq(this.query)) {
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
  }

  private keydown(e: KeyboardEvent) {
    if (runScopeHandlers(this.view, e, 'search-panel')) {
      e.preventDefault();
    } else if (e.keyCode === 13 && e.target === this.searchField) {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.keyCode === 13 && e.target === this.replaceField) {
      e.preventDefault();
      replaceNext(this.view);
    }
  }

  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) this.setQuery(effect.value);
      }
    }
  }

  private setQuery(query: SearchQuery) {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseField.checked = query.caseSensitive;
    this.reField.checked = query.regexp;
    this.wordField.checked = query.wholeWord;
  }

  mount() {
    this.searchField.select();
  }

  get top() {
    return true;
  }
}

/** `createPanel` for `search({ createPanel })`. */
export function createNovelistSearchPanel(view: EditorView): Panel {
  return new NovelistSearchPanel(view);
}

/**
 * VSCode-style Cmd+F: opens the panel when closed; when already open it never
 * closes but reseeds the query from a non-empty editor selection and
 * select-all's the search field so the query can be overwritten immediately.
 * Escape remains the only way to close (CM6's built-in panel binding).
 */
export function openOrRefocusSearch(view: EditorView): boolean {
  if (!searchPanelOpen(view.state)) {
    return openSearchPanel(view);
  }
  const field = view.dom.querySelector<HTMLInputElement>('.cm-search [main-field]');
  if (!field) return openSearchPanel(view);

  const sel = view.state.selection.main;
  if (!sel.empty) {
    const selText = view.state.sliceDoc(sel.from, sel.to);
    const prev = getSearchQuery(view.state);
    const next = new SearchQuery({
      search: selText,
      caseSensitive: prev.caseSensitive,
      literal: prev.literal,
      regexp: prev.regexp,
      replace: prev.replace,
      wholeWord: prev.wholeWord,
    });
    if (next.valid) view.dispatch({ effects: setSearchQuery.of(next) });
    field.value = selText;
  }
  field.focus();
  field.select();
  return true;
}
