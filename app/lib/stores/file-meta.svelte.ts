/**
 * Per-file sidebar metadata: CJK-aware word counts (computed in Rust by
 * `get_writing_stats`) and a "last saved" timestamp that is fresher than the
 * tree's `mtime` for files saved in-app (self-writes don't refresh the tree).
 *
 * The sidebar shows "2,233 字 · 8 分钟前" under each text file when
 * `showFileMeta` is on — a per-device view preference kept in localStorage.
 */
import { commands } from '$lib/ipc/commands';

const SHOW_META_KEY = 'novelist:sidebar:show-file-meta';
const REFRESH_DEBOUNCE_MS = 600;

function readShowMeta(): boolean {
  try {
    return localStorage.getItem(SHOW_META_KEY) !== 'false';
  } catch {
    return true;
  }
}

class FileMetaStore {
  wordCounts = $state<Record<string, number>>({});
  savedAt = $state<Record<string, number>>({});
  showFileMeta = $state<boolean>(readShowMeta());
  /** Coarse clock so "8 minutes ago" labels age while the app is open. */
  now = $state(Date.now());

  #timer: ReturnType<typeof setTimeout> | null = null;
  #projectDir: string | null = null;
  #generation = 0;

  setShowFileMeta(on: boolean) {
    this.showFileMeta = on;
    try {
      localStorage.setItem(SHOW_META_KEY, String(on));
    } catch {
      /* storage unavailable — keep the in-memory value */
    }
    if (on && this.#projectDir) this.scheduleRefresh(this.#projectDir);
  }

  /** Start the relative-time clock; returns a stop function. */
  startClock(intervalMs = 30_000): () => void {
    this.now = Date.now();
    const id = setInterval(() => (this.now = Date.now()), intervalMs);
    return () => clearInterval(id);
  }

  /** Mark a file as just written by the app (drives the relative time). */
  touch(path: string, at = Date.now()) {
    this.savedAt = { ...this.savedAt, [path]: at };
  }

  /** Debounced reload of all word counts for `projectDir` (null clears). */
  scheduleRefresh(projectDir: string | null) {
    if (projectDir !== this.#projectDir) {
      this.#projectDir = projectDir;
      this.#generation++;
      this.wordCounts = {};
      this.savedAt = {};
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (!projectDir || !this.showFileMeta) return;
    this.#timer = setTimeout(() => void this.refreshNow(), REFRESH_DEBOUNCE_MS);
  }

  async refreshNow(): Promise<void> {
    const dir = this.#projectDir;
    if (!dir) return;
    const generation = this.#generation;
    const result = await commands.getWritingStats(dir);
    // A project switch while the walk was in flight must not leak counts.
    if (generation !== this.#generation || result.status !== 'ok') return;
    const next: Record<string, number> = {};
    for (const chapter of result.data.chapters) next[chapter.file_path] = chapter.word_count;
    this.wordCounts = next;
  }
}

export const fileMetaStore = new FileMetaStore();

/**
 * Compact relative time: "just now", "8 minutes ago", "3 days ago", or a
 * date for anything older than ~30 days. Uses Intl so CJK locales read
 * naturally ("8分钟前").
 */
export function formatRelativeTime(
  timestamp: number,
  locale: string,
  now = Date.now(),
  justNow = 'just now',
): string {
  const diffSec = Math.round((timestamp - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return justNow;
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  }
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diffSec / 86400), 'day');
  return new Date(timestamp).toLocaleDateString(locale);
}
