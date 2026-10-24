import { listen } from '@tauri-apps/api/event';
import { commandRegistry } from '$lib/stores/commands.svelte';

export type MenuEventContext = {
  /** Called when the user picks a path from the Open Recent submenu. */
  onOpenRecent: (path: string) => void;
};

const OPEN_RECENT_PREFIX = 'open-recent:';

/**
 * Subscribes to `menu-command` events emitted by the Rust side when a
 * native menu item is clicked. The payload is the menu item ID.
 *
 * For regular items the ID matches a command already registered in
 * `app-commands.ts` and we dispatch through `commandRegistry.execute`,
 * preserving the "one dispatch map" invariant.
 *
 * For Open Recent items the ID is prefixed with `open-recent:` and
 * carries the absolute project path. We strip the prefix and route to
 * `ctx.onOpenRecent(path)` so App.svelte can drive the project-open
 * flow with its full state (single-file exit, sidebar, tabs, etc.).
 *
 * Returns a teardown function; call it from the component's onMount
 * cleanup block.
 */
export function wireMenuEvents(ctx: MenuEventContext): () => void {
  let unlisten: (() => void) | null = null;

  try {
    listen<string>('menu-command', (event) => {
      try {
        const id = event.payload;
        if (id.startsWith(OPEN_RECENT_PREFIX)) {
          const path = id.slice(OPEN_RECENT_PREFIX.length);
          if (path && path !== '__none__') ctx.onOpenRecent(path);
          return;
        }
        commandRegistry.execute(id, 'menu');
      } catch (e) {
        console.error('[menu-events] handler failed:', e);
      }
    }).then((fn) => {
      unlisten = fn;
    }).catch((e) => {
      console.error('[menu-events] failed to register menu-command listener:', e);
    });
  } catch (e) {
    console.error('[menu-events] menu listener setup failed:', e);
  }

  return () => {
    unlisten?.();
  };
}
