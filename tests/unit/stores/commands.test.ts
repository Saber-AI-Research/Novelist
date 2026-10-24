import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { commandRegistry, type Command } from '$lib/stores/commands.svelte';

/**
 * [contract] commandRegistry — the single dispatch map for every
 * keyboard shortcut and palette action (see `app-commands.ts` and
 * `CLAUDE.md`'s "one dispatch map per action" rule).
 *
 * The store is a module-level singleton, so each test resets it via
 * `commands.length = 0` rather than constructing a fresh instance.
 */
describe('[contract] commandRegistry', () => {
  beforeEach(() => {
    // Drain the singleton — splice mutates in place so the `$state` proxy
    // reacts correctly (assigning `[]` also works, but splice keeps identity).
    commandRegistry.commands.splice(0, commandRegistry.commands.length);
    commandRegistry._resetDedupe();
  });

  it('registers a command and makes it findable in `commands`', () => {
    const cmd: Command = { id: 'test.foo', label: 'Foo', handler: () => {} };
    commandRegistry.register(cmd);
    expect(commandRegistry.commands).toHaveLength(1);
    expect(commandRegistry.commands[0].id).toBe('test.foo');
  });

  it('execute() runs the handler for the given id', () => {
    let fired = 0;
    commandRegistry.register({
      id: 'test.fire',
      label: 'Fire',
      handler: () => { fired++; },
    });
    commandRegistry.execute('test.fire');
    expect(fired).toBe(1);
  });

  it('execute() is a silent no-op for an unknown id', () => {
    commandRegistry.register({ id: 'test.known', label: 'K', handler: () => {} });
    expect(() => commandRegistry.execute('test.ghost')).not.toThrow();
  });

  it('dedups by id — a second register() with the same id is ignored', () => {
    let callsA = 0;
    let callsB = 0;
    commandRegistry.register({ id: 'test.dup', label: 'A', handler: () => { callsA++; } });
    commandRegistry.register({ id: 'test.dup', label: 'B', handler: () => { callsB++; } });
    expect(commandRegistry.commands).toHaveLength(1);
    // The first registration wins (first-write-wins is the documented guard).
    expect(commandRegistry.commands[0].label).toBe('A');
    commandRegistry.execute('test.dup');
    expect(callsA).toBe(1);
    expect(callsB).toBe(0);
  });

  it('search() with an empty / whitespace query returns every command', () => {
    commandRegistry.register({ id: 'a', label: 'Alpha', handler: () => {} });
    commandRegistry.register({ id: 'b', label: 'Beta', handler: () => {} });
    expect(commandRegistry.search('').map(c => c.id)).toEqual(['a', 'b']);
    expect(commandRegistry.search('   ').map(c => c.id)).toEqual(['a', 'b']);
  });

  it('search() filters by label substring, case-insensitively', () => {
    commandRegistry.register({ id: 'a', label: 'Toggle Sidebar', handler: () => {} });
    commandRegistry.register({ id: 'b', label: 'Toggle Outline', handler: () => {} });
    commandRegistry.register({ id: 'c', label: 'New File', handler: () => {} });

    const sidebar = commandRegistry.search('sidebar');
    expect(sidebar.map(c => c.id)).toEqual(['a']);

    const toggle = commandRegistry.search('TOGGLE');
    expect(toggle.map(c => c.id)).toEqual(['a', 'b']);

    const miss = commandRegistry.search('nothing-matches-this');
    expect(miss).toEqual([]);
  });

  it('search() also matches the secondaryLabel for bilingual lookup', () => {
    commandRegistry.register({
      id: 'a', label: '切换侧边栏', secondaryLabel: 'Toggle Sidebar', handler: () => {},
    });
    commandRegistry.register({
      id: 'b', label: '新建文件', secondaryLabel: 'New File', handler: () => {},
    });
    // Chinese-locale label search
    expect(commandRegistry.search('侧边').map(c => c.id)).toEqual(['a']);
    // English-keyword search hits the secondary
    expect(commandRegistry.search('sidebar').map(c => c.id)).toEqual(['a']);
    // Case-insensitive secondary match
    expect(commandRegistry.search('NEW').map(c => c.id)).toEqual(['b']);
  });

  it('search() resolves secondaryLabelFn lazily for matching', () => {
    let resolved = '';
    commandRegistry.register({
      id: 'a',
      label: '切换大纲',
      secondaryLabelFn: () => { resolved = 'Toggle Outline'; return 'Toggle Outline'; },
      handler: () => {},
    });
    expect(commandRegistry.search('outline').map(c => c.id)).toEqual(['a']);
    expect(resolved).toBe('Toggle Outline');
  });

  it('preserves registration order (palette rendering depends on it)', () => {
    commandRegistry.register({ id: 'z', label: 'Zebra', handler: () => {} });
    commandRegistry.register({ id: 'a', label: 'Apple', handler: () => {} });
    commandRegistry.register({ id: 'm', label: 'Mango', handler: () => {} });
    expect(commandRegistry.commands.map(c => c.id)).toEqual(['z', 'a', 'm']);
  });

  it('keeps optional shortcut metadata intact for palette rendering', () => {
    commandRegistry.register({
      id: 'test.with-shortcut',
      label: 'Save',
      shortcut: 'Cmd+S',
      handler: () => {},
    });
    const cmd = commandRegistry.commands.find(c => c.id === 'test.with-shortcut');
    expect(cmd?.shortcut).toBe('Cmd+S');
  });
});

/**
 * [contract][regression] commandRegistry execute-dedupe — prevents
 * double-fire when the OS menu accelerator and the JS keydown handler
 * both dispatch the same command. A dispatch from the other source within
 * 50 ms is silently dropped; repeated dispatches from one source (two quick
 * presses of a shortcut) all run.
 *
 * Uses vi.useFakeTimers so the window can be advanced deterministically.
 * IDs are namespaced (`dedupe.*`) so they don't collide with the
 * broader [contract] suite above.
 */
describe('[contract][regression] commandRegistry.execute dedupe window', () => {
  beforeEach(() => {
    commandRegistry.commands.splice(0, commandRegistry.commands.length);
    commandRegistry._resetDedupe();
    vi.useFakeTimers();
    // Anchor Date.now to a deterministic starting point so earlier
    // test calls don't leave dedupe timestamps in the private Map
    // that would interact with these cases.
    vi.setSystemTime(1_700_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once on the first call', () => {
    let calls = 0;
    commandRegistry.register({
      id: 'dedupe.simple',
      label: 'Simple',
      handler: () => { calls++; },
    });
    commandRegistry.execute('dedupe.simple');
    expect(calls).toBe(1);
  });

  it('silently drops a menu dispatch within 50 ms of the keyboard dispatch', () => {
    let calls = 0;
    commandRegistry.register({
      id: 'dedupe.rapid',
      label: 'Rapid',
      handler: () => { calls++; },
    });
    commandRegistry.execute('dedupe.rapid');
    vi.advanceTimersByTime(20);
    commandRegistry.execute('dedupe.rapid', 'menu');
    expect(calls).toBe(1);
  });

  it('silently drops a keyboard dispatch within 50 ms of the menu dispatch', () => {
    let calls = 0;
    commandRegistry.register({
      id: 'dedupe.menu-first',
      label: 'Menu first',
      handler: () => { calls++; },
    });
    commandRegistry.execute('dedupe.menu-first', 'menu');
    vi.advanceTimersByTime(20);
    commandRegistry.execute('dedupe.menu-first');
    expect(calls).toBe(1);
  });

  it('runs every same-source dispatch, however quick (two shortcut presses)', () => {
    let calls = 0;
    commandRegistry.register({
      id: 'dedupe.same-source',
      label: 'Same source',
      handler: () => { calls++; },
    });
    commandRegistry.execute('dedupe.same-source');
    commandRegistry.execute('dedupe.same-source');
    vi.advanceTimersByTime(5);
    commandRegistry.execute('dedupe.same-source', 'menu');
    commandRegistry.execute('dedupe.same-source', 'menu');
    expect(calls).toBe(2);
  });

  it('allows the other source once the 50 ms window has elapsed', () => {
    let calls = 0;
    commandRegistry.register({
      id: 'dedupe.window',
      label: 'Window',
      handler: () => { calls++; },
    });
    commandRegistry.execute('dedupe.window');
    vi.advanceTimersByTime(60);
    commandRegistry.execute('dedupe.window', 'menu');
    expect(calls).toBe(2);
  });

  it('dedupe is per-id — different commands in rapid succession both fire', () => {
    let a = 0;
    let b = 0;
    commandRegistry.register({ id: 'dedupe.a', label: 'A', handler: () => { a++; } });
    commandRegistry.register({ id: 'dedupe.b', label: 'B', handler: () => { b++; } });
    commandRegistry.execute('dedupe.a');
    vi.advanceTimersByTime(5);
    commandRegistry.execute('dedupe.b');
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});
