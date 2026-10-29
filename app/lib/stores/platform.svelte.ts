import type { PlatformCapabilities } from '$lib/ipc/commands';

/**
 * Platform capabilities + responsive shell layout.
 *
 * Native facts (OS, which desktop-only features exist) come from the
 * `get_platform_capabilities` IPC and are fetched once in `main.ts` BEFORE
 * the app mounts. There is deliberately no silent desktop fallback: reading
 * a capability before `initPlatform()` resolved throws, and a failed fetch
 * shows an explicit startup error instead of running desktop code paths on a
 * phone.
 *
 * Layout is derived from the window size, never from the user agent:
 * phone < 768px, tablet 768–1199px, desktop/wide >= 1200px. A desktop window
 * only switches to the phone shell when it is narrower than 768px, so a
 * normal desktop window keeps the docked sidebar/split/vertical rail it
 * always had.
 */

export type FormFactor = 'phone' | 'tablet' | 'desktop';
export type BooleanCapability =
  | 'native_menu'
  | 'multi_window'
  | 'pick_directory'
  | 'external_processes'
  | 'self_update'
  | 'cli_shim'
  | 'file_watcher'
  | 'plugin_install';

export const PHONE_MAX_WIDTH = 767;
export const TABLET_MAX_WIDTH = 1199;
/** Tablets narrower than this (iPad portrait) keep the sidebar as a drawer. */
export const TABLET_DOCKED_SIDEBAR_MIN_WIDTH = 1024;
/** Visual-viewport shrink beyond this is treated as an on-screen keyboard. */
const KEYBOARD_MIN_INSET = 120;

export function formFactorForWidth(width: number): FormFactor {
  if (width <= PHONE_MAX_WIDTH) return 'phone';
  if (width <= TABLET_MAX_WIDTH) return 'tablet';
  return 'desktop';
}

/**
 * Shell layout for a platform/width pair. Mobile follows the width-derived
 * form factor (an iPad Pro in landscape gets the wide layout); desktop
 * windows only collapse to the phone shell below 768px.
 */
export function shellLayoutFor(isMobile: boolean, width: number): FormFactor {
  const formFactor = formFactorForWidth(width);
  if (isMobile) return formFactor;
  return formFactor === 'phone' ? 'phone' : 'desktop';
}

class PlatformStore {
  #capabilities = $state<PlatformCapabilities | null>(null);
  viewportWidth = $state(typeof window === 'undefined' ? 1280 : window.innerWidth);
  /** Height of the visible viewport (excludes an on-screen keyboard). */
  viewportHeight = $state(typeof window === 'undefined' ? 800 : window.innerHeight);
  /** Pixels hidden by an on-screen keyboard (0 when closed). */
  keyboardInset = $state(0);
  /**
   * Mobile project library root (`get_library_path`), resolved during
   * `initPlatform`. Null on desktop, where projects live anywhere. The iOS
   * container path changes across updates, so persisted per-project state
   * is keyed relative to this root.
   */
  libraryRoot = $state<string | null>(null);

  get ready(): boolean {
    return this.#capabilities !== null;
  }

  get capabilities(): PlatformCapabilities {
    const caps = this.#capabilities;
    if (!caps) throw new Error('Platform capabilities were read before initPlatform() completed');
    return caps;
  }

  get os(): PlatformCapabilities['os'] { return this.capabilities.os; }
  get isMobile(): boolean { return this.capabilities.is_mobile; }
  get isIos(): boolean { return this.capabilities.os === 'ios'; }
  get isAndroid(): boolean { return this.capabilities.os === 'android'; }

  /** Whether a desktop-only feature exists on this platform. */
  can(capability: BooleanCapability): boolean {
    return this.capabilities[capability];
  }

  /**
   * Export formats offered here: Pandoc `export_project` formats on desktop,
   * `export_library_document` formats (markdown/html) on mobile. Pick the
   * command by `can('external_processes')`, not by this list.
   */
  get exportFormats(): readonly string[] {
    return this.capabilities.export_formats;
  }

  /** Window-size form factor, independent of the platform. */
  get formFactor(): FormFactor {
    return formFactorForWidth(this.viewportWidth);
  }

  /** Effective shell layout (see `shellLayoutFor`). */
  get layout(): FormFactor {
    return shellLayoutFor(this.isMobile, this.viewportWidth);
  }

  /**
   * Touch shell: top toolbar, horizontal panel strip and format bar replace
   * the native menu / 20px vertical rail. Always on for mobile; on desktop
   * only for phone-narrow windows.
   */
  get touchShell(): boolean {
    return this.isMobile || this.layout === 'phone';
  }

  /** Sidebar renders as a dismissible overlay drawer instead of docking. */
  get sidebarDrawer(): boolean {
    const layout = this.layout;
    return layout === 'phone'
      || (layout === 'tablet' && this.viewportWidth < TABLET_DOCKED_SIDEBAR_MIN_WIDTH);
  }

  /** Only the active editor pane is rendered (no visible split columns). */
  get singlePane(): boolean {
    return this.layout !== 'desktop';
  }

  /** Split view is a desktop-window feature. */
  get splitAvailable(): boolean {
    return !this.isMobile && this.layout === 'desktop';
  }

  get keyboardOpen(): boolean {
    return this.isMobile && this.keyboardInset > KEYBOARD_MIN_INSET;
  }

  /** @internal Set once by `initPlatform`; tests may inject fixtures. */
  setCapabilities(capabilities: PlatformCapabilities) {
    this.#capabilities = capabilities;
  }
}

export const platform = new PlatformStore();

let viewportTrackingStarted = false;

/**
 * Tracks window + visual viewport size. The visible height and top offset are
 * exported as CSS variables so the mobile shell sits above the on-screen
 * keyboard (iOS keeps the layout viewport full height and only shrinks the
 * visual viewport; Android usually resizes the window — both are handled by
 * comparing against the tallest height seen at the current width).
 */
function startViewportTracking() {
  if (viewportTrackingStarted || typeof window === 'undefined') return;
  viewportTrackingStarted = true;
  const root = document.documentElement;
  let baselineWidth = window.innerWidth;
  let baselineHeight = window.innerHeight;
  let frame = 0;

  const measure = () => {
    frame = 0;
    const vv = window.visualViewport;
    const width = window.innerWidth;
    const visibleHeight = vv?.height ?? window.innerHeight;
    const top = vv?.offsetTop ?? 0;
    if (width !== baselineWidth) {
      // Rotation / window resize: start a fresh baseline for this width.
      baselineWidth = width;
      baselineHeight = Math.max(window.innerHeight, visibleHeight);
    } else {
      baselineHeight = Math.max(baselineHeight, window.innerHeight, visibleHeight);
    }
    platform.viewportWidth = width;
    platform.viewportHeight = visibleHeight;
    platform.keyboardInset = Math.max(0, Math.round(baselineHeight - visibleHeight));
    root.style.setProperty('--novelist-vv-height', `${visibleHeight}px`);
    root.style.setProperty('--novelist-vv-top', `${top}px`);
    root.style.setProperty('--novelist-keyboard-inset', `${platform.keyboardOpen ? platform.keyboardInset : 0}px`);
    root.dataset.layout = platform.layout;
    root.dataset.keyboard = platform.keyboardOpen ? 'open' : 'closed';
  };
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(measure);
  };

  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  measure();
}

/**
 * Fetch native capabilities and start viewport tracking. Must resolve before
 * `mount(App)`. Rejects (no fallback) when the backend cannot answer.
 */
export async function initPlatform(): Promise<void> {
  // Dynamic on purpose: tests/setup.ts imports this store before test files
  // register `vi.mock('$lib/ipc/commands')`; a static import would pin the
  // real IPC module for every unit test.
  const { commands } = await import('$lib/ipc/commands');
  const capabilities = await commands.getPlatformCapabilities();
  if (!capabilities || typeof capabilities.is_mobile !== 'boolean' || typeof capabilities.os !== 'string') {
    throw new Error('get_platform_capabilities returned an invalid payload');
  }
  platform.setCapabilities(capabilities);
  if (capabilities.is_mobile) {
    const library = await commands.getLibraryPath();
    if (library.status === 'error') throw new Error(`get_library_path failed: ${library.error}`);
    platform.libraryRoot = library.data;
  }
  const root = document.documentElement;
  root.dataset.os = capabilities.os;
  root.dataset.mobile = String(capabilities.is_mobile);
  startViewportTracking();
}
