import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * [contract] wireMenuEvents — subscribes to `menu-command` events and
 * dispatches the payload (command ID) through `commandRegistry.execute`.
 * This is the bridge that preserves the "one dispatch map" invariant:
 * native menu clicks go through the same registry as shortcuts and the
 * command palette.
 */

const { hoisted } = vi.hoisted(() => {
  const listeners = new Map<string, (ev: { payload: any }) => any>();
  const unlisten = vi.fn();
  const listen = vi.fn(async (name: string, handler: (ev: { payload: any }) => any) => {
    listeners.set(name, handler);
    return unlisten;
  });

  const execute = vi.fn();

  return {
    hoisted: {
      listeners,
      listen,
      unlisten,
      execute,
    },
  };
});

vi.mock('@tauri-apps/api/event', () => ({ listen: hoisted.listen }));
vi.mock('$lib/stores/commands.svelte', () => ({
  commandRegistry: { execute: hoisted.execute },
}));

describe('[contract] wireMenuEvents', () => {
  let onOpenRecent: ((path: string) => void) & { mock: { calls: unknown[][] } };

  beforeEach(() => {
    hoisted.listeners.clear();
    hoisted.listen.mockClear();
    hoisted.unlisten.mockClear();
    hoisted.execute.mockClear();
    onOpenRecent = vi.fn() as unknown as typeof onOpenRecent;
  });

  it('registers a listener for the menu-command event', async () => {
    const { wireMenuEvents } = await import('$lib/composables/menu-events.svelte');
    wireMenuEvents({ onOpenRecent });

    // The listener is registered inside a .then on a pending promise; flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.listen).toHaveBeenCalledOnce();
    expect(hoisted.listen.mock.calls[0][0]).toBe('menu-command');
    expect(hoisted.listeners.has('menu-command')).toBe(true);
  });

  it('dispatches the payload command ID through commandRegistry.execute as a menu source', async () => {
    const { wireMenuEvents } = await import('$lib/composables/menu-events.svelte');
    wireMenuEvents({ onOpenRecent });
    await Promise.resolve();

    const handler = hoisted.listeners.get('menu-command')!;
    handler({ payload: 'new-file' });
    handler({ payload: 'open-settings' });
    handler({ payload: 'toggle-zen' });

    expect(hoisted.execute).toHaveBeenCalledTimes(3);
    expect(hoisted.execute).toHaveBeenNthCalledWith(1, 'new-file', 'menu');
    expect(hoisted.execute).toHaveBeenNthCalledWith(2, 'open-settings', 'menu');
    expect(hoisted.execute).toHaveBeenNthCalledWith(3, 'toggle-zen', 'menu');
    expect(onOpenRecent).not.toHaveBeenCalled();
  });

  it('cleanup function unlistens the menu-command handler', async () => {
    const { wireMenuEvents } = await import('$lib/composables/menu-events.svelte');
    const teardown = wireMenuEvents({ onOpenRecent });
    // Let the async listen() resolve so `unlisten` is captured.
    await Promise.resolve();
    await Promise.resolve();

    teardown();
    expect(hoisted.unlisten).toHaveBeenCalledOnce();
  });

  it('unknown command IDs pass through unchanged (registry.execute is tolerant)', async () => {
    const { wireMenuEvents } = await import('$lib/composables/menu-events.svelte');
    wireMenuEvents({ onOpenRecent });
    await Promise.resolve();

    const handler = hoisted.listeners.get('menu-command')!;
    handler({ payload: 'does-not-exist' });

    // The bridge must not filter — commandRegistry.execute is a no-op
    // for unknown IDs (tested in stores/commands.test), and we don't
    // want to centralise "known commands" in a second place.
    expect(hoisted.execute).toHaveBeenCalledWith('does-not-exist', 'menu');
  });

  it('routes `open-recent:<path>` IDs to ctx.onOpenRecent, bypassing registry', async () => {
    const { wireMenuEvents } = await import('$lib/composables/menu-events.svelte');
    wireMenuEvents({ onOpenRecent });
    await Promise.resolve();

    const handler = hoisted.listeners.get('menu-command')!;
    handler({ payload: 'open-recent:/Users/me/projects/novel-a' });

    expect(onOpenRecent).toHaveBeenCalledTimes(1);
    expect(onOpenRecent).toHaveBeenCalledWith('/Users/me/projects/novel-a');
    // Must not also hit the registry — Open Recent is dynamic state,
    // not a registered command.
    expect(hoisted.execute).not.toHaveBeenCalled();
  });

  it('ignores the placeholder `open-recent:__none__` item (disabled menu entry)', async () => {
    const { wireMenuEvents } = await import('$lib/composables/menu-events.svelte');
    wireMenuEvents({ onOpenRecent });
    await Promise.resolve();

    const handler = hoisted.listeners.get('menu-command')!;
    handler({ payload: 'open-recent:__none__' });

    expect(onOpenRecent).not.toHaveBeenCalled();
    expect(hoisted.execute).not.toHaveBeenCalled();
  });
});
