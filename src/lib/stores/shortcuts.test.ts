import { describe, it, expect } from 'vitest';
import { matchesShortcut } from './shortcuts.svelte';

/** Create a minimal KeyboardEvent-like object for testing. */
function fakeKeyEvent(opts: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): KeyboardEvent {
  return {
    key: opts.key,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
  } as KeyboardEvent;
}

describe('matchesShortcut', () => {
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
