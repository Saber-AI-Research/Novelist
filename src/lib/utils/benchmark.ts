/**
 * In-editor performance benchmark for large files.
 * Run via Command Palette → "Run Benchmark" or from devtools console.
 */
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { createEditorExtensions, createEditorState } from '$lib/editor/setup';
import { countWords } from './wordcount';
import { extractHeadings } from '$lib/editor/outline';

function generateDoc(lines: number): string {
  const parts: string[] = [];
  for (let i = 0; i < lines; i++) {
    if (i % 100 === 0) parts.push(`# Chapter ${(i / 100) + 1}`);
    else if (i % 20 === 0) parts.push(`## Section ${(i / 20) + 1}`);
    else if (i % 5 === 0) parts.push('');
    else parts.push('The quick brown fox jumps over the lazy dog and then runs away from the big cat in the dark forest.');
  }
  return parts.join('\n');
}

function time<T>(label: string, fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  return { result, ms };
}

export async function runBenchmark(lineCount = 150000): Promise<string> {
  const results: string[] = [];
  results.push(`=== Novelist Benchmark: ${lineCount} lines ===\n`);

  // 1. Generate document
  const { result: doc, ms: genMs } = time('Generate doc', () => generateDoc(lineCount));
  results.push(`Doc generation: ${genMs.toFixed(1)}ms (${(doc.length / 1024 / 1024).toFixed(1)} MB)`);

  // 2. Create EditorState (no WYSIWYG)
  const extPlain = createEditorExtensions({ wysiwyg: false });
  const { result: statePlain, ms: stateMs } = time('Create EditorState (plain)', () =>
    createEditorState(doc, extPlain)
  );
  results.push(`EditorState creation (plain): ${stateMs.toFixed(1)}ms`);

  // 3. Create EditorState (with WYSIWYG)
  const extWysiwyg = createEditorExtensions({ wysiwyg: true });
  const { result: stateWysiwyg, ms: stateWysMs } = time('Create EditorState (WYSIWYG)', () =>
    createEditorState(doc, extWysiwyg)
  );
  results.push(`EditorState creation (WYSIWYG): ${stateWysMs.toFixed(1)}ms`);

  // 4. Mount EditorView
  const container = document.createElement('div');
  container.style.cssText = 'width:800px;height:600px;position:fixed;top:-9999px;left:-9999px;';
  document.body.appendChild(container);

  const { result: view, ms: mountMs } = time('Mount EditorView', () =>
    new EditorView({ state: statePlain, parent: container })
  );
  results.push(`EditorView mount: ${mountMs.toFixed(1)}ms`);

  // 5. doc.toString()
  const { ms: toStringMs } = time('doc.toString()', () => view.state.doc.toString());
  results.push(`doc.toString(): ${toStringMs.toFixed(1)}ms`);

  // 6. countWords (full doc)
  const { ms: wcMs } = time('countWords', () => countWords(view.state.doc.toString()));
  results.push(`countWords (full doc): ${wcMs.toFixed(1)}ms`);

  // 7. extractHeadings
  const { ms: headMs } = time('extractHeadings', () => extractHeadings(view.state));
  results.push(`extractHeadings: ${headMs.toFixed(1)}ms`);

  // 8. Single character insert
  const insertPos = Math.floor(view.state.doc.length / 2);
  const { ms: insertMs } = time('Insert char', () => {
    view.dispatch({ changes: { from: insertPos, insert: 'x' } });
  });
  results.push(`Single char insert (mid-doc): ${insertMs.toFixed(1)}ms`);

  // 9. Rapid typing simulation (20 chars)
  const typingTimes: number[] = [];
  for (let i = 0; i < 20; i++) {
    const pos = view.state.selection.main.head;
    const start = performance.now();
    view.dispatch({ changes: { from: pos, insert: 'a' } });
    typingTimes.push(performance.now() - start);
  }
  const avgType = typingTimes.reduce((a, b) => a + b, 0) / typingTimes.length;
  const maxType = Math.max(...typingTimes);
  const p95Type = typingTimes.sort((a, b) => a - b)[Math.floor(typingTimes.length * 0.95)];
  results.push(`Typing (20 chars): avg=${avgType.toFixed(1)}ms, p95=${p95Type.toFixed(1)}ms, max=${maxType.toFixed(1)}ms`);

  // 10. Scroll to end
  const { ms: scrollMs } = time('Scroll to end', () => {
    view.dispatch({ selection: { anchor: view.state.doc.length } , scrollIntoView: true });
  });
  results.push(`Scroll to end: ${scrollMs.toFixed(1)}ms`);

  // 11. Selection change (click simulation)
  const midPos = Math.floor(view.state.doc.length / 3);
  const { ms: selMs } = time('Selection change (mid-doc)', () => {
    view.dispatch({ selection: { anchor: midPos }, scrollIntoView: true });
  });
  results.push(`Selection change (mid-doc): ${selMs.toFixed(1)}ms`);

  // Cleanup
  view.destroy();
  container.remove();

  // 12. Memory estimate
  if ('memory' in performance) {
    const mem = (performance as any).memory;
    results.push(`JS heap: ${(mem.usedJSHeapSize / 1024 / 1024).toFixed(1)} MB / ${(mem.totalJSHeapSize / 1024 / 1024).toFixed(1)} MB`);
  }

  results.push(`\n--- Summary ---`);
  results.push(`Target: typing < 16ms (60fps), insert < 5ms`);
  results.push(`Typing avg: ${avgType.toFixed(1)}ms ${avgType < 16 ? '✓' : '✗ SLOW'}`);
  results.push(`Typing p95: ${p95Type.toFixed(1)}ms ${p95Type < 16 ? '✓' : '✗ SLOW'}`);

  const output = results.join('\n');
  console.log(output);
  return output;
}

/**
 * Release benchmark: compare small vs large file performance.
 * Measures EditorState creation, typing latency, scroll speed, and memory.
 */
export async function runReleaseBenchmark(): Promise<string> {
  const sizes = [
    { label: 'Small (100)', lines: 100 },
    { label: 'Large (50K)', lines: 50000 },
  ];

  const rows: Record<string, string[]> = {};
  const metrics = [
    'EditorState create',
    'Typing avg',
    'Typing p95',
    'Typing max',
    'Scroll to end',
    'Heap after create',
  ];
  const thresholds: Record<string, number> = {
    'EditorState create': 200,
    'Typing avg': 16,
    'Typing p95': 16,
    'Typing max': 50,
    'Scroll to end': 50,
    'Heap after create': 100,
  };

  for (const metric of metrics) rows[metric] = [];

  for (const { label, lines } of sizes) {
    const doc = generateDoc(lines);
    const ext = createEditorExtensions({ wysiwyg: lines <= 5000 });

    // Memory before
    const heapBefore = getHeapMB();

    // EditorState creation
    const { result: state, ms: createMs } = time('create', () => createEditorState(doc, ext));
    rows['EditorState create'].push(`${createMs.toFixed(1)}ms`);

    // Heap after create
    const heapAfter = getHeapMB();
    rows['Heap after create'].push(heapAfter !== null ? `${(heapAfter - (heapBefore ?? 0)).toFixed(1)} MB` : 'N/A');

    // Mount view off-screen
    const container = document.createElement('div');
    container.style.cssText = 'width:800px;height:600px;position:fixed;top:-9999px;left:-9999px;';
    document.body.appendChild(container);
    const view = new EditorView({ state, parent: container });

    // Typing simulation (20 chars)
    const typingTimes: number[] = [];
    for (let i = 0; i < 20; i++) {
      const pos = view.state.selection.main.head;
      const start = performance.now();
      view.dispatch({ changes: { from: pos, insert: 'a' } });
      typingTimes.push(performance.now() - start);
    }
    const avg = typingTimes.reduce((a, b) => a + b, 0) / typingTimes.length;
    const sorted = [...typingTimes].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const max = sorted[sorted.length - 1];
    rows['Typing avg'].push(`${avg.toFixed(1)}ms`);
    rows['Typing p95'].push(`${p95.toFixed(1)}ms`);
    rows['Typing max'].push(`${max.toFixed(1)}ms`);

    // Scroll to end
    const { ms: scrollMs } = time('scroll', () => {
      view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    });
    rows['Scroll to end'].push(`${scrollMs.toFixed(1)}ms`);

    view.destroy();
    container.remove();
  }

  // Format table
  const lines: string[] = [];
  lines.push('=== Release Benchmark: Small vs Large ===\n');
  lines.push(padRow('Metric', sizes.map(s => s.label), 'Threshold'));
  lines.push(padRow('---', sizes.map(() => '---'), '---'));
  for (const metric of metrics) {
    const threshold = metric === 'Heap after create' ? `< ${thresholds[metric]} MB` : `< ${thresholds[metric]}ms`;
    lines.push(padRow(metric, rows[metric], threshold));
  }

  const output = lines.join('\n');
  console.log(output);
  return output;
}

function getHeapMB(): number | null {
  if ('memory' in performance) {
    return (performance as any).memory.usedJSHeapSize / 1024 / 1024;
  }
  return null;
}

function padRow(label: string, values: string[], threshold: string): string {
  return `| ${label.padEnd(20)} | ${values.map(v => v.padEnd(12)).join(' | ')} | ${threshold} |`;
}
