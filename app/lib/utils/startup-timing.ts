/**
 * Lightweight startup instrumentation.
 *
 * Call `startupMark('phase.name')` at a phase boundary; the time is captured
 * via `performance.now()` relative to `performance.timeOrigin`. When the app
 * is ready enough to report, call `startupReport()` — it prints a table to
 * console and, if running in Tauri, mirrors the marks into the Rust tracing
 * stream so they show up alongside backend phases in the same log.
 *
 * Kept deliberately small so the instrumentation itself doesn't show up
 * in the numbers.
 */

type Mark = { name: string; at: number };

const marks: Mark[] = [];
let reported = false;

export function startupMark(name: string): void {
  marks.push({ name, at: performance.now() });
  // Also drop a `performance.mark` so devtools timelines can line up with our own.
  try {
    performance.mark(`novelist.${name}`);
  } catch {
    // Ignore — not all environments (e.g. vitest jsdom) have performance.mark
  }
}

export function getStartupMarks(): readonly Mark[] {
  return marks;
}

/**
 * Print the collected marks and forward each one to the Rust tracing log.
 * Safe to call more than once; subsequent calls are no-ops.
 */
export async function startupReport(): Promise<void> {
  if (reported) return;
  reported = true;

  if (marks.length === 0) return;

  // Compute cumulative + delta columns for easy reading.
  const first = marks[0].at;
  const rows = marks.map((m, i) => {
    const prev = i === 0 ? first : marks[i - 1].at;
    return {
      phase: m.name,
      'since_start (ms)': Number((m.at - first).toFixed(1)),
      'delta (ms)': Number((m.at - prev).toFixed(1)),
    };
  });

  // eslint-disable-next-line no-console
  console.table(rows);

  // Forward to Rust tracing so backend + frontend phases appear in one log.
  // Best-effort: swallow errors (e.g. running outside Tauri, or command missing).
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    for (const r of rows) {
      invoke('log_startup_phase', {
        name: r.phase,
        sinceStartMs: r['since_start (ms)'],
      }).catch(() => {});
    }
  } catch {
    // Not running inside Tauri (e.g. vitest or browser E2E); skip.
  }
}
