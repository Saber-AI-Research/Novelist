import { WidgetType, EditorView, Decoration, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Range } from '@codemirror/state';
import { imeComposingField } from './ime-guard';

/**
 * Lazy-loaded mermaid module reference.
 * Mermaid is ~2.5 MB so we only import it when a mermaid block is first encountered.
 */
let mermaidModule: typeof import('mermaid') | null = null;
let mermaidInitialized = false;
let mermaidLoadPromise: Promise<typeof import('mermaid')> | null = null;

/**
 * Monotonically increasing counter for unique mermaid render IDs.
 * Mermaid requires unique IDs for each render call.
 */
let renderCounter = 0;

/**
 * Detect whether the current theme is dark by checking the CSS variable
 * or the computed background luminance.
 */
function isDarkTheme(): boolean {
  if (typeof window === 'undefined') return false;
  const scheme = document.documentElement.style.getPropertyValue('color-scheme');
  if (scheme === 'dark') return true;
  if (scheme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Lazily load and initialize mermaid.
 * Returns the mermaid default export. Thread-safe via shared promise.
 */
async function ensureMermaid(): Promise<typeof import('mermaid')['default']> {
  if (!mermaidLoadPromise) {
    mermaidLoadPromise = import('mermaid');
  }
  if (!mermaidModule) {
    mermaidModule = await mermaidLoadPromise;
  }
  if (!mermaidInitialized) {
    mermaidModule.default.initialize({
      startOnLoad: false,
      theme: isDarkTheme() ? 'dark' : 'default',
      // Suppress mermaid's own console warnings
      suppressErrorRendering: true,
    });
    mermaidInitialized = true;
  }
  return mermaidModule.default;
}

/**
 * Re-initialize mermaid with the current theme.
 * Called when theme changes are detected.
 */
function reinitMermaidTheme() {
  if (mermaidModule && mermaidInitialized) {
    mermaidModule.default.initialize({
      startOnLoad: false,
      theme: isDarkTheme() ? 'dark' : 'default',
      suppressErrorRendering: true,
    });
  }
}

/**
 * Widget that renders a mermaid diagram from source code.
 *
 * Because mermaid's render() is async, the widget creates a container div
 * in toDOM() and then kicks off the async render, updating innerHTML
 * when the SVG is ready.
 *
 * NOTE: This is used as a block widget (Decoration.widget with `block: true`)
 * placed AFTER the fenced code block. The code block itself is hidden via
 * Decoration.replace when the cursor is not inside it.
 *
 * Height drift concern: Block widgets add height that only exists when
 * visible in the viewport. For mermaid diagrams this is acceptable because:
 * (1) mermaid blocks are rare (typically <10 per document), so cumulative
 * drift is negligible; (2) the code block text they replace has comparable
 * height. For documents with many mermaid blocks, users can disable WYSIWYG.
 */
class MermaidWidget extends WidgetType {
  constructor(private source: string) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-novelist-mermaid-widget';

    // Placeholder while loading
    const loading = document.createElement('div');
    loading.className = 'cm-novelist-mermaid-loading';
    loading.textContent = 'Rendering diagram\u2026';
    container.appendChild(loading);

    // Kick off async render
    const source = this.source;
    const id = `mermaid-${Date.now()}-${renderCounter++}`;

    (async () => {
      try {
        const mermaid = await ensureMermaid();
        const { svg } = await mermaid.render(id, source);
        container.innerHTML = '';
        const svgContainer = document.createElement('div');
        svgContainer.className = 'cm-novelist-mermaid-svg';
        svgContainer.innerHTML = svg;
        container.appendChild(svgContainer);
      } catch (err) {
        container.innerHTML = '';
        const errorDiv = document.createElement('div');
        errorDiv.className = 'cm-novelist-mermaid-error';
        errorDiv.textContent = `Mermaid error: ${err instanceof Error ? err.message : String(err)}`;
        container.appendChild(errorDiv);
      }
    })();

    return container;
  }

  eq(other: MermaidWidget): boolean {
    return this.source === other.source;
  }

  get estimatedHeight(): number {
    return 300;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Pre-compute cursor positions into a sorted array for fast range checks.
 */
function makeCursorSet(state: EditorState): number[] {
  return state.selection.ranges.map(r => r.head).sort((a, b) => a - b);
}

function cursorInRange(heads: number[], from: number, to: number): boolean {
  let lo = 0, hi = heads.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (heads[mid] < from) lo = mid + 1; else hi = mid;
  }
  return lo < heads.length && heads[lo] <= to;
}

/**
 * Extract the info string (language) from a FencedCode node.
 * Returns the language name or empty string.
 */
function getCodeInfo(node: any, state: EditorState): string {
  const cursor = node.cursor();
  if (cursor.firstChild()) {
    do {
      if (cursor.name === 'CodeInfo') {
        return state.doc.sliceString(cursor.from, cursor.to).trim().toLowerCase();
      }
    } while (cursor.nextSibling());
  }
  return '';
}

/**
 * Extract the code content from a FencedCode node (between the opening
 * and closing fence lines, excluding CodeMark and CodeInfo).
 */
function getCodeContent(node: any, state: EditorState): string {
  // Find the range between the first CodeMark's line end and the last CodeMark's line start
  const cursor = node.cursor();
  let firstMarkEnd = -1;
  let lastMarkFrom = -1;

  if (cursor.firstChild()) {
    do {
      if (cursor.name === 'CodeMark') {
        if (firstMarkEnd === -1) {
          // First code mark — content starts after its line
          firstMarkEnd = state.doc.lineAt(cursor.to).to;
        }
        // Track the last code mark — content ends before its line
        lastMarkFrom = state.doc.lineAt(cursor.from).from;
      }
    } while (cursor.nextSibling());
  }

  if (firstMarkEnd >= 0 && lastMarkFrom > firstMarkEnd) {
    // Content is between end of first fence line and start of last fence line
    const contentStart = firstMarkEnd + 1; // skip the newline
    const contentEnd = lastMarkFrom;
    if (contentStart < contentEnd) {
      return state.doc.sliceString(contentStart, contentEnd);
    }
  }

  return '';
}

/**
 * Build block decorations for mermaid code blocks.
 * Full-doc scan is acceptable — mermaid blocks are rare (typically <10).
 */
function buildMermaidBlockDecos(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const cursorHeads = makeCursorSet(state);

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'FencedCode') return;

      const info = getCodeInfo(node.node, state);
      if (info !== 'mermaid') return;

      if (cursorInRange(cursorHeads, node.from, node.to)) return false;

      const source = getCodeContent(node.node, state);
      if (!source.trim()) return false;

      decos.push(
        Decoration.replace({
          widget: new MermaidWidget(source),
          block: true,
        }).range(node.from, node.to)
      );

      return false;
    },
  });

  return Decoration.set(decos, true);
}

/**
 * Block decorations via StateField — CM6 requires block decorations
 * to come from StateField, not ViewPlugin.
 */
export const mermaidPlugin = StateField.define<DecorationSet>({
  create(state) { return buildMermaidBlockDecos(state); },
  update(value, tr) {
    if (tr.state.field(imeComposingField, false)) return value;
    if (tr.docChanged) return buildMermaidBlockDecos(tr.state);
    if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildMermaidBlockDecos(tr.state);
    }
    if (tr.selection) return buildMermaidBlockDecos(tr.state);
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

// Listen for theme changes and re-initialize mermaid
if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    mermaidInitialized = false;
    reinitMermaidTheme();
  });

  // Also watch for Novelist's own theme changes via color-scheme property
  const observer = new MutationObserver(() => {
    mermaidInitialized = false;
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });
}
