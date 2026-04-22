import { describe, it, expect, beforeEach } from 'vitest';
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
