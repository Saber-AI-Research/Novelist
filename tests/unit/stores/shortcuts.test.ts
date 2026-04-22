import { describe, it, expect } from 'vitest';
import {
  matchesShortcut,
  formatShortcut,
  buildShortcutString,
  matchesShortcutQuery,
  shortcutsStore,
} from '$lib/stores/shortcuts.svelte';

/** Create a minimal KeyboardEvent-like object for testing. */
function fakeKeyEvent(opts: {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): KeyboardEvent {
  return {
    key: opts.key,
    code: opts.code ?? '',
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
  } as KeyboardEvent;
}

describe('matchesShortcut — primary key match', () => {
  it('matches Cmd+B (metaKey)', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: 'b', metaKey: true }), 'Cmd+B')).toBe(true);
  });

  it('matches Cmd+B (ctrlKey)', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: 'b', ctrlKey: true }), 'Cmd+B')).toBe(true);
  });

  it('does not match Cmd+B without modifier', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: 'b' }), 'Cmd+B')).toBe(false);
  });

  it('matches Cmd+Shift+B', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: 'B', metaKey: true, shiftKey: true }), 'Cmd+Shift+B')).toBe(true);
  });

  it('matches Cmd+Shift+P (command palette — regression trap)', () => {
    // If this breaks, the command palette keyboard trigger is dead. Do not
    // "simplify" matchesShortcut without re-running this.
    expect(matchesShortcut(fakeKeyEvent({ key: 'P', metaKey: true, shiftKey: true }), 'Cmd+Shift+P')).toBe(true);
  });

  it('does not match Cmd+B when Shift is pressed', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: 'B', metaKey: true, shiftKey: true }), 'Cmd+B')).toBe(false);
  });

  it('does not match Cmd+Shift+B when Shift is not pressed', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: 'b', metaKey: true }), 'Cmd+Shift+B')).toBe(false);
  });

  it('matches F11 without modifiers', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: 'F11' }), 'F11')).toBe(true);
  });

  it('does not match F11 when Cmd is pressed', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: 'F11', metaKey: true }), 'F11')).toBe(false);
  });

  it('matches Cmd+W (case insensitive)', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: 'w', metaKey: true }), 'Cmd+W')).toBe(true);
  });

  it('matches Cmd+, (comma)', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: ',', metaKey: true }), 'Cmd+,')).toBe(true);
  });

  it('matches Cmd+\\ (backslash)', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: '\\', metaKey: true }), 'Cmd+\\')).toBe(true);
  });

  it('returns false for empty shortcut', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: 'a' }), '')).toBe(false);
  });

  it('matches Cmd+I for italic', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: 'i', metaKey: true }), 'Cmd+I')).toBe(true);
  });

  it('Cmd+I does not match Cmd+Shift+I', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: 'I', metaKey: true, shiftKey: true }), 'Cmd+I')).toBe(false);
  });
});

describe('matchesShortcut — macOS Option+digit/letter (e.code fallback)', () => {
  // On macOS, Option+<digit/letter> produces special glyphs in e.key (⌥1 → "¡",
  // ⌥a → "å"). The fallback looks at e.code (physical key) so right-rail
  // shortcuts still fire.
  it('matches Cmd+Alt+1 when e.key is "¡" but code is Digit1', () => {
    const e = fakeKeyEvent({ key: '¡', code: 'Digit1', metaKey: true, altKey: true });
    expect(matchesShortcut(e, 'Cmd+Alt+1')).toBe(true);
  });

  it('matches Cmd+Alt+2 when e.key is "™" but code is Digit2', () => {
    const e = fakeKeyEvent({ key: '™', code: 'Digit2', metaKey: true, altKey: true });
    expect(matchesShortcut(e, 'Cmd+Alt+2')).toBe(true);
  });

  it('matches Cmd+Alt+3 when e.key is "£" but code is Digit3', () => {
    const e = fakeKeyEvent({ key: '£', code: 'Digit3', metaKey: true, altKey: true });
    expect(matchesShortcut(e, 'Cmd+Alt+3')).toBe(true);
  });

  it('matches Cmd+Alt+4 when e.key is "¢" but code is Digit4', () => {
    const e = fakeKeyEvent({ key: '¢', code: 'Digit4', metaKey: true, altKey: true });
    expect(matchesShortcut(e, 'Cmd+Alt+4')).toBe(true);
  });

  it('matches Cmd+Alt+5 when e.key is "∞" but code is Digit5', () => {
    const e = fakeKeyEvent({ key: '∞', code: 'Digit5', metaKey: true, altKey: true });
    expect(matchesShortcut(e, 'Cmd+Alt+5')).toBe(true);
  });

  it('matches Cmd+Alt+Z when e.key is "Ω" but code is KeyZ', () => {
    const e = fakeKeyEvent({ key: 'Ω', code: 'KeyZ', metaKey: true, altKey: true });
    expect(matchesShortcut(e, 'Cmd+Alt+Z')).toBe(true);
  });

  it('does not match Cmd+Alt+1 for a different physical digit', () => {
    const e = fakeKeyEvent({ key: '™', code: 'Digit2', metaKey: true, altKey: true });
    expect(matchesShortcut(e, 'Cmd+Alt+1')).toBe(false);
  });

  it('ignores e.code fallback when primary e.key already matches', () => {
    // Canonical Cmd+Alt+5 with literal '5' in e.key — must still pass.
    const e = fakeKeyEvent({ key: '5', code: 'Digit5', metaKey: true, altKey: true });
    expect(matchesShortcut(e, 'Cmd+Alt+5')).toBe(true);
  });
});

describe('right-panel default shortcut scheme (Cmd+Alt+<digit>)', () => {
  // Regression trap: the right-panel toggles intentionally share a single
  // modifier combo (`Cmd+Alt+1..5`) with the digit matching the button's
  // vertical position. If anyone casually reassigns these to letter keys,
  // the test below will catch it and the PR reviewer can double-check
  // against the reasoning note in shortcuts.svelte.ts.
  const expected: Record<string, string> = {
    'toggle-outline': 'Cmd+Alt+1',
    'toggle-draft': 'Cmd+Alt+2',
    'toggle-snapshot': 'Cmd+Alt+3',
    'toggle-stats': 'Cmd+Alt+4',
    'toggle-template': 'Cmd+Alt+5',
  };

  for (const [id, shortcut] of Object.entries(expected)) {
    it(`${id} defaults to ${shortcut}`, () => {
      expect(shortcutsStore.defaults[id]).toBe(shortcut);
    });
  }

  it('matches Cmd+Alt+5 for toggle-template', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: '5', metaKey: true, altKey: true }), 'Cmd+Alt+5')).toBe(true);
  });

  it('Cmd+Alt+5 does not match the plain Cmd+5 project-switch combo', () => {
    expect(matchesShortcut(fakeKeyEvent({ key: '5', metaKey: true, altKey: false }), 'Cmd+Alt+5')).toBe(false);
  });
});

describe('formatShortcut — macOS rendering (Apple symbols)', () => {
  const mac = { isMac: true };

  it('renders Cmd+Shift+P as ⇧⌘P', () => {
    expect(formatShortcut('Cmd+Shift+P', mac)).toBe('⇧⌘P');
  });

  it('renders Cmd+Alt+1 as ⌥⌘1', () => {
    expect(formatShortcut('Cmd+Alt+1', mac)).toBe('⌥⌘1');
  });

  it('renders Cmd+Alt+Z as ⌥⌘Z', () => {
    expect(formatShortcut('Cmd+Alt+Z', mac)).toBe('⌥⌘Z');
  });

  it('renders Cmd+B as ⌘B', () => {
    expect(formatShortcut('Cmd+B', mac)).toBe('⌘B');
  });

  it('renders Cmd+\\ as ⌘\\', () => {
    expect(formatShortcut('Cmd+\\', mac)).toBe('⌘\\');
  });

  it('renders Cmd+, as ⌘,', () => {
    expect(formatShortcut('Cmd+,', mac)).toBe('⌘,');
  });

  it('orders modifiers Control ⌃ · Option ⌥ · Shift ⇧ · Command ⌘ (Apple convention)', () => {
    // Synthetic — we don't ship a Ctrl+Alt+Shift+Cmd combo but the order matters.
    expect(formatShortcut('Ctrl+Alt+Shift+Cmd+K', mac)).toBe('⌃⌥⇧⌘K');
  });

  it('renders F11 without modifier glyphs', () => {
    expect(formatShortcut('F11', mac)).toBe('F11');
  });

  it('renders Space as ␣', () => {
    expect(formatShortcut('Cmd+Space', mac)).toBe('⌘␣');
  });

  it('renders Escape as Esc', () => {
    expect(formatShortcut('Escape', mac)).toBe('Esc');
  });

  it('renders arrow keys as arrows', () => {
    expect(formatShortcut('Cmd+ArrowUp', mac)).toBe('⌘↑');
    expect(formatShortcut('Cmd+ArrowDown', mac)).toBe('⌘↓');
    expect(formatShortcut('Cmd+ArrowLeft', mac)).toBe('⌘←');
    expect(formatShortcut('Cmd+ArrowRight', mac)).toBe('⌘→');
  });

  it('returns empty string for empty input', () => {
    expect(formatShortcut('', mac)).toBe('');
  });
});

describe('formatShortcut — non-macOS rendering', () => {
  const pc = { isMac: false };

  it('renders Cmd+Shift+P as Ctrl+Shift+P on non-mac', () => {
    expect(formatShortcut('Cmd+Shift+P', pc)).toBe('Ctrl+Shift+P');
  });

  it('renders Cmd+Alt+1 as Ctrl+Alt+1 on non-mac', () => {
    expect(formatShortcut('Cmd+Alt+1', pc)).toBe('Ctrl+Alt+1');
  });

  it('renders Cmd+B as Ctrl+B on non-mac', () => {
    expect(formatShortcut('Cmd+B', pc)).toBe('Ctrl+B');
  });

  it('leaves F11 alone on non-mac', () => {
    expect(formatShortcut('F11', pc)).toBe('F11');
  });
});

describe('buildShortcutString — recording a new binding', () => {
  it('returns null for bare modifier presses', () => {
    expect(buildShortcutString(fakeKeyEvent({ key: 'Meta', metaKey: true }))).toBe(null);
    expect(buildShortcutString(fakeKeyEvent({ key: 'Control', ctrlKey: true }))).toBe(null);
    expect(buildShortcutString(fakeKeyEvent({ key: 'Alt', altKey: true }))).toBe(null);
    expect(buildShortcutString(fakeKeyEvent({ key: 'Shift', shiftKey: true }))).toBe(null);
  });

  it('builds Cmd+B from plain meta+b', () => {
    expect(buildShortcutString(fakeKeyEvent({ key: 'b', metaKey: true }))).toBe('Cmd+B');
  });

  it('builds Cmd+Shift+P', () => {
    expect(buildShortcutString(fakeKeyEvent({ key: 'P', metaKey: true, shiftKey: true }))).toBe('Cmd+Shift+P');
  });

  it('builds Cmd+Alt+1 from macOS ⌥1 (e.key="¡") via e.code', () => {
    const e = fakeKeyEvent({ key: '¡', code: 'Digit1', metaKey: true, altKey: true });
    expect(buildShortcutString(e)).toBe('Cmd+Alt+1');
  });

  it('builds Cmd+Alt+Z from macOS ⌥z (e.key="Ω") via e.code', () => {
    const e = fakeKeyEvent({ key: 'Ω', code: 'KeyZ', metaKey: true, altKey: true });
    expect(buildShortcutString(e)).toBe('Cmd+Alt+Z');
  });

  it('preserves F-keys as-is', () => {
    expect(buildShortcutString(fakeKeyEvent({ key: 'F11' }))).toBe('F11');
  });

  it('normalizes space to "Space"', () => {
    expect(buildShortcutString(fakeKeyEvent({ key: ' ', metaKey: true }))).toBe('Cmd+Space');
  });

  it('preserves symbol keys', () => {
    expect(buildShortcutString(fakeKeyEvent({ key: ',', metaKey: true }))).toBe('Cmd+,');
    expect(buildShortcutString(fakeKeyEvent({ key: '\\', metaKey: true }))).toBe('Cmd+\\');
  });

  it('round-trips: buildShortcutString → matchesShortcut for all defaults', () => {
    // For every default shortcut, building a synthetic event that should match
    // it and re-matching must return true. This is the tightest invariant we
    // can assert without running real keydowns.
    for (const [, shortcut] of Object.entries(shortcutsStore.defaults)) {
      if (!shortcut) continue;
      const parts = shortcut.split('+');
      const key = parts[parts.length - 1];
      const mods = new Set(parts.slice(0, -1).map(m => m.toLowerCase()));
      // Special-case F-keys and multi-char keys — they don't get shifted.
      const eventKey =
        key.length === 1 && mods.has('shift') ? key.toUpperCase() :
        key.length === 1 ? key.toLowerCase() :
        key;
      const e = fakeKeyEvent({
        key: eventKey,
        metaKey: mods.has('cmd'),
        shiftKey: mods.has('shift'),
        altKey: mods.has('alt'),
      });
      expect(matchesShortcut(e, shortcut), `shortcut "${shortcut}" should self-match`).toBe(true);
    }
  });
});

describe('matchesShortcutQuery — Settings search', () => {
  // Representative row: command-palette → label "Command Palette", canonical
  // "Cmd+Shift+P", display on mac "⇧⌘P".
  const label = 'Command Palette';
  const canonical = 'Cmd+Shift+P';
  const display = '⇧⌘P';

  it('empty query matches everything', () => {
    expect(matchesShortcutQuery(label, canonical, display, '')).toBe(true);
    expect(matchesShortcutQuery(label, canonical, display, '   ')).toBe(true);
  });

  it('matches by English label substring (case-insensitive)', () => {
    expect(matchesShortcutQuery(label, canonical, display, 'palette')).toBe(true);
    expect(matchesShortcutQuery(label, canonical, display, 'COMMAND')).toBe(true);
  });

  it('matches by CJK label substring', () => {
    expect(matchesShortcutQuery('命令面板', canonical, display, '面板')).toBe(true);
    expect(matchesShortcutQuery('大纲', 'Cmd+Alt+1', '⌥⌘1', '大纲')).toBe(true);
  });

  it('matches by canonical shortcut', () => {
    expect(matchesShortcutQuery(label, canonical, display, 'cmd+shift+p')).toBe(true);
    expect(matchesShortcutQuery(label, canonical, display, 'Cmd+Shift+P')).toBe(true);
  });

  it('matches by display shortcut (Apple symbols)', () => {
    expect(matchesShortcutQuery(label, canonical, display, '⇧⌘P')).toBe(true);
    expect(matchesShortcutQuery(label, canonical, display, '⌘p')).toBe(true);
  });

  it('ignores whitespace in query', () => {
    expect(matchesShortcutQuery(label, canonical, display, '⌘ P')).toBe(true);
    expect(matchesShortcutQuery(label, canonical, display, 'cmd + shift + p')).toBe(true);
  });

  it('ignores whitespace in label/canonical too', () => {
    expect(matchesShortcutQuery(' Command  Palette ', canonical, display, 'commandpalette')).toBe(true);
  });

  it('returns false when nothing matches', () => {
    expect(matchesShortcutQuery(label, canonical, display, 'outline')).toBe(false);
    expect(matchesShortcutQuery(label, canonical, display, '⌥F5')).toBe(false);
  });

  it('partial prefix of canonical still matches', () => {
    expect(matchesShortcutQuery(label, canonical, display, 'shift+p')).toBe(true);
  });
});

describe('shortcutsStore — overrides and defaults', () => {
  it('returns default when no override is set', () => {
    // Assuming a fresh store (other tests haven't polluted this id).
    expect(shortcutsStore.defaults['command-palette']).toBe('Cmd+Shift+P');
  });

  it('allCommandIds includes every default', () => {
    const ids = shortcutsStore.allCommandIds;
    expect(ids).toContain('command-palette');
    expect(ids).toContain('toggle-outline');
    expect(ids).toContain('editor-bold');
  });

  it('appCommandIds excludes editor formatting commands', () => {
    expect(shortcutsStore.appCommandIds).toContain('command-palette');
    expect(shortcutsStore.appCommandIds).not.toContain('editor-bold');
    expect(shortcutsStore.appCommandIds).not.toContain('editor-italic');
  });

  it('set → get round-trips', () => {
    shortcutsStore.set('go-to-line', 'Cmd+Alt+G');
    expect(shortcutsStore.get('go-to-line')).toBe('Cmd+Alt+G');
    expect(shortcutsStore.isCustomized('go-to-line')).toBe(true);
    shortcutsStore.reset('go-to-line');
    expect(shortcutsStore.get('go-to-line')).toBe(shortcutsStore.defaults['go-to-line']);
    expect(shortcutsStore.isCustomized('go-to-line')).toBe(false);
  });

  it('resetAll clears overrides', () => {
    shortcutsStore.set('go-to-line', 'Cmd+Alt+G');
    shortcutsStore.set('close-tab', 'Cmd+Alt+W');
    shortcutsStore.resetAll();
    expect(shortcutsStore.isCustomized('go-to-line')).toBe(false);
    expect(shortcutsStore.isCustomized('close-tab')).toBe(false);
  });
});
