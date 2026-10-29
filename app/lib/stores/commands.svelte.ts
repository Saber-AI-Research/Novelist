interface Command {
  id: string;
  label: string;
  /**
   * Optional alternate-language label rendered as a small subscript in
   * the command palette and matched alongside `label` when the user
   * searches. Lets a Chinese-locale user find a command by typing its
   * English name (or vice versa) without switching locale.
   *
   * May be set directly OR resolved lazily via `secondaryLabelFn` —
   * the latter lets us look up the alternate-locale translation only
   * when the palette renders, after both locale chunks have loaded.
   */
  secondaryLabel?: string;
  secondaryLabelFn?: () => string | undefined;
  shortcut?: string;
  /**
   * Platform gate. When it returns false the command is hidden from the
   * palette and `execute` ignores it (shortcut, menu and touch toolbar
   * dispatches included), e.g. new-window or split on mobile.
   */
  available?: () => boolean;
  handler: () => void;
}

/** Resolve a command's secondary label, preferring the lazy fn when set. */
export function getSecondaryLabel(c: Command): string | undefined {
  if (c.secondaryLabelFn) {
    const v = c.secondaryLabelFn();
    if (v && v !== c.label) return v;
    return undefined;
  }
  return c.secondaryLabel;
}

/**
 * Who dispatched an `execute`. One physical keystroke on a shortcut with a
 * native menu equivalent can arrive twice — once as the OS menu accelerator
 * (`'menu'`) and once through the JS keydown handler (`'app'`). Two dispatches
 * from the same source are always distinct user actions (e.g. two quick
 * presses of the same shortcut) and must both run.
 */
export type CommandSource = 'menu' | 'app';

/**
 * Window (in milliseconds) during which an `execute(id)` from one source is
 * ignored after the same ID ran from the other source.
 */
const DEDUPE_WINDOW_MS = 50;

class CommandRegistry {
  commands = $state<Command[]>([]);
  private lastExecuted = new Map<string, { at: number; source: CommandSource }>();

  register(cmd: Command) {
    // Avoid duplicates
    if (!this.commands.find(c => c.id === cmd.id)) {
      this.commands.push(cmd);
    }
  }

  execute(id: string, source: CommandSource = 'app') {
    const now = Date.now();
    const last = this.lastExecuted.get(id);
    if (last && last.source !== source && now - last.at < DEDUPE_WINDOW_MS) {
      return;
    }
    this.lastExecuted.set(id, { at: now, source });

    const cmd = this.commands.find(c => c.id === id);
    if (cmd && (cmd.available?.() ?? true)) cmd.handler();
  }

  /** Whether a registered command can run on this platform right now. */
  isAvailable(id: string): boolean {
    const cmd = this.commands.find(c => c.id === id);
    return !!cmd && (cmd.available?.() ?? true);
  }

  search(query: string): Command[] {
    const available = this.commands.filter(c => c.available?.() ?? true);
    if (!query.trim()) return available;
    const q = query.toLowerCase();
    return available.filter(c => {
      if (c.label.toLowerCase().includes(q)) return true;
      const sec = getSecondaryLabel(c);
      if (sec && sec.toLowerCase().includes(q)) return true;
      return false;
    });
  }

  /**
   * Test helper — drops the dedupe window memory. Not called from
   * production code. Tests that mix menu and app dispatches of the same
   * command would otherwise trip the 50 ms cross-source dedupe window.
   */
  _resetDedupe() {
    this.lastExecuted.clear();
  }
}

export const commandRegistry = new CommandRegistry();
export type { Command };
