/**
 * Automated scroll + edit stability test for large files.
 *
 * Runs inside the WebView, directly manipulating the CM6 EditorView.
 * Simulates the multi-round scroll→click→edit pattern from the test skill.
 *
 * Usage: Command Palette → "Run Scroll+Edit Test"
 * Requires: a large file (>5000 lines) to be open in the active tab.
 */

import type { EditorView } from '@codemirror/view';

interface TestResult {
  pass: boolean;
  step: string;
  detail: string;
}

function getView(): EditorView {
  const v = (window as any).__novelist_view;
  if (!v) throw new Error('No active EditorView. Open a file first.');
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Jump to a line and "click" — set selection + scrollIntoView.
 * Returns the actual line the cursor landed on.
 */
function clickAtLine(view: EditorView, targetLine: number): number {
  const clamped = Math.max(1, Math.min(targetLine, view.state.doc.lines));
  const line = view.state.doc.line(clamped);
  view.dispatch({
    selection: { anchor: line.from + Math.min(5, line.length) },
    scrollIntoView: true,
  });
  view.focus();
  // Read back what line the cursor is actually on
  const actualPos = view.state.selection.main.head;
  return view.state.doc.lineAt(actualPos).number;
}

/**
 * Type text at the current cursor position.
 */
function typeText(view: EditorView, text: string) {
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
}

/**
 * Check if the viewport actually shows content near the expected line.
 * CM6's visible ranges tell us what lines are rendered.
 */
function getVisibleLineRange(view: EditorView): { from: number; to: number } {
  const ranges = view.visibleRanges;
  if (ranges.length === 0) return { from: 0, to: 0 };
  const fromLine = view.state.doc.lineAt(ranges[0].from).number;
  const toLine = view.state.doc.lineAt(ranges[ranges.length - 1].to).number;
  return { from: fromLine, to: toLine };
}

/**
 * Check if a click caused a "jump" — the cursor should be near where we clicked.
 */
function checkNoJump(actualLine: number, targetLine: number, tolerance: number = 50): TestResult {
  const diff = Math.abs(actualLine - targetLine);
  if (diff > tolerance) {
    return {
      pass: false,
      step: `Click at line ${targetLine}`,
      detail: `JUMP DETECTED: cursor landed at line ${actualLine} (off by ${diff} lines)`,
    };
  }
  return {
    pass: true,
    step: `Click at line ${targetLine}`,
    detail: `OK — cursor at line ${actualLine}`,
  };
}

/**
 * Verify an edit marker exists near the expected line.
 */
function verifyEditExists(view: EditorView, marker: string, expectedLine: number, tolerance: number = 100): TestResult {
  // Search the document for the marker
  const text = view.state.doc.toString();
  const idx = text.indexOf(marker);
  if (idx === -1) {
    return {
      pass: false,
      step: `Verify "${marker}" near line ${expectedLine}`,
      detail: `EDIT LOST: "${marker}" not found in document`,
    };
  }
  const actualLine = view.state.doc.lineAt(idx).number;
  const diff = Math.abs(actualLine - expectedLine);
  if (diff > tolerance) {
    return {
      pass: false,
      step: `Verify "${marker}" near line ${expectedLine}`,
      detail: `EDIT MISPLACED: found at line ${actualLine} (expected ~${expectedLine})`,
    };
  }
  return {
    pass: true,
    step: `Verify "${marker}" near line ${expectedLine}`,
    detail: `OK — found at line ${actualLine}`,
  };
}

export async function runScrollEditTest(): Promise<string> {
  const results: TestResult[] = [];
  const view = getView();
  const totalLines = view.state.doc.lines;

  const log = (msg: string) => console.log(`[ScrollTest] ${msg}`);

  log(`Starting test: ${totalLines} lines`);

  if (totalLines < 5000) {
    return `SKIP: Document has only ${totalLines} lines. Open a file with >5000 lines (e.g. novelist-150k.md).`;
  }

  // Define test waypoints as fractions of total document
  const waypoints = [
    { name: 'A', line: Math.round(totalLines * 0.2), marker: '___TEST_A___' },
    { name: 'B', line: Math.round(totalLines * 0.53), marker: '___TEST_B___' },
    { name: 'C', line: Math.round(totalLines * 0.33), marker: '___TEST_C___' },
    { name: 'D', line: Math.round(totalLines * 0.03), marker: '___TEST_D___' },
    { name: 'E', line: Math.round(totalLines * 0.97), marker: '___TEST_E___' },
  ];

  // === Phase 1: Scroll down + edit ===
  log('Phase 1: Scroll down + edit');

  // Waypoint A (scroll down)
  await sleep(200);
  let actual = clickAtLine(view, waypoints[0].line);
  results.push(checkNoJump(actual, waypoints[0].line));
  await sleep(150);
  typeText(view, waypoints[0].marker);
  log(`  A: clicked line ${waypoints[0].line} → cursor at ${actual}, typed ${waypoints[0].marker}`);

  // Waypoint B (scroll further down)
  await sleep(200);
  actual = clickAtLine(view, waypoints[1].line);
  results.push(checkNoJump(actual, waypoints[1].line));
  await sleep(150);
  typeText(view, waypoints[1].marker);
  log(`  B: clicked line ${waypoints[1].line} → cursor at ${actual}, typed ${waypoints[1].marker}`);

  // === Phase 2: Scroll up + edit ===
  log('Phase 2: Scroll up + edit');

  // Waypoint C (scroll up)
  await sleep(200);
  actual = clickAtLine(view, waypoints[2].line);
  results.push(checkNoJump(actual, waypoints[2].line));
  await sleep(150);
  typeText(view, waypoints[2].marker);
  log(`  C: clicked line ${waypoints[2].line} → cursor at ${actual}, typed ${waypoints[2].marker}`);

  // Waypoint D (scroll to near top)
  await sleep(200);
  actual = clickAtLine(view, waypoints[3].line);
  results.push(checkNoJump(actual, waypoints[3].line));
  await sleep(150);
  typeText(view, waypoints[3].marker);
  log(`  D: clicked line ${waypoints[3].line} → cursor at ${actual}, typed ${waypoints[3].marker}`);

  // === Phase 3: Scroll to bottom + edit ===
  log('Phase 3: Scroll to bottom');

  await sleep(200);
  actual = clickAtLine(view, waypoints[4].line);
  results.push(checkNoJump(actual, waypoints[4].line));
  await sleep(150);
  typeText(view, waypoints[4].marker);
  log(`  E: clicked line ${waypoints[4].line} → cursor at ${actual}, typed ${waypoints[4].marker}`);

  // === Phase 4: Scroll back to verify all edits ===
  log('Phase 4: Verify edits survived scrolling');

  for (const wp of waypoints) {
    await sleep(200);
    clickAtLine(view, wp.line);
    await sleep(100);
    results.push(verifyEditExists(view, wp.marker, wp.line));
  }

  // === Phase 5: Save and verify line count ===
  log('Phase 5: Save');
  const saveFn = (window as any).__novelist_save;
  if (saveFn) {
    await saveFn();
    await sleep(300);
    log(`  Saved. doc.lines = ${view.state.doc.lines}`);
  }

  results.push({
    pass: view.state.doc.lines === totalLines,
    step: 'Line count after edits',
    detail: `Expected ${totalLines}, got ${view.state.doc.lines}`,
  });

  // === Format output ===
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const lines: string[] = [
    `=== Scroll + Edit Test: ${totalLines} lines ===`,
    `Results: ${passed} passed, ${failed} failed`,
    '',
  ];

  for (const r of results) {
    lines.push(`${r.pass ? 'PASS' : 'FAIL'} | ${r.step} | ${r.detail}`);
  }

  if (failed > 0) {
    lines.push('', '!!! TEST FAILED — see FAIL lines above !!!');
  } else {
    lines.push('', 'ALL TESTS PASSED');
  }

  const output = lines.join('\n');
  console.log(output);
  return output;
}
