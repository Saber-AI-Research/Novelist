import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * [contract] platform store — native capabilities + window-size layout.
 * Layout is derived from the window width only (never the user agent):
 * phone < 768, tablet 768–1199, desktop >= 1200; desktop windows only
 * switch to the phone shell below 768px.
 */

const { getPlatformCapabilities, getLibraryPath } = vi.hoisted(() => ({
  getPlatformCapabilities: vi.fn(),
  getLibraryPath: vi.fn(),
}));
vi.mock('$lib/ipc/commands', () => ({ commands: { getPlatformCapabilities, getLibraryPath } }));

import {
  formFactorForWidth,
  initPlatform,
  platform,
  shellLayoutFor,
} from '$lib/stores/platform.svelte';

const IOS = {
  os: 'ios',
  is_mobile: true,
  native_menu: false,
  multi_window: false,
  pick_directory: false,
  external_processes: false,
  self_update: false,
  cli_shim: false,
  file_watcher: false,
  plugin_install: false,
  export_formats: [] as string[],
} as const;

beforeEach(() => {
  getPlatformCapabilities.mockReset();
  getLibraryPath.mockReset();
  platform.keyboardInset = 0;
  platform.libraryRoot = null;
});

describe('[precision] layout classification', () => {
  it.each([
    [320, 'phone'], [767, 'phone'], [768, 'tablet'], [1023, 'tablet'], [1199, 'tablet'], [1200, 'desktop'], [2560, 'desktop'],
  ] as const)('formFactorForWidth(%i) = %s', (width, expected) => {
    expect(formFactorForWidth(width)).toBe(expected);
  });

  it.each([
    [false, 390, 'phone'], [false, 900, 'desktop'], [false, 1280, 'desktop'],
    [true, 390, 'phone'], [true, 834, 'tablet'], [true, 1194, 'tablet'], [true, 1366, 'desktop'],
  ] as const)('shellLayoutFor(mobile=%s, %i) = %s', (mobile, width, expected) => {
    expect(shellLayoutFor(mobile, width)).toBe(expected);
  });
});

describe('[contract] shell policy getters', () => {
  it('keeps the desktop shell for normal desktop windows', () => {
    platform.viewportWidth = 1000;
    expect(platform.layout).toBe('desktop');
    expect(platform.touchShell).toBe(false);
    expect(platform.sidebarDrawer).toBe(false);
    expect(platform.singlePane).toBe(false);
    expect(platform.splitAvailable).toBe(true);
  });

  it('collapses a phone-narrow desktop window into the touch shell', () => {
    platform.viewportWidth = 600;
    expect(platform.layout).toBe('phone');
    expect(platform.touchShell).toBe(true);
    expect(platform.sidebarDrawer).toBe(true);
    expect(platform.singlePane).toBe(true);
    expect(platform.splitAvailable).toBe(false);
  });

  it('uses drawers in iPad portrait and docks the sidebar in landscape', () => {
    platform.setCapabilities({ ...IOS, export_formats: [] });
    platform.viewportWidth = 834;
    expect(platform.layout).toBe('tablet');
    expect(platform.touchShell).toBe(true);
    expect(platform.sidebarDrawer).toBe(true);
    platform.viewportWidth = 1194;
    expect(platform.sidebarDrawer).toBe(false);
    expect(platform.singlePane).toBe(true);
    platform.viewportWidth = 1366;
    expect(platform.layout).toBe('desktop');
    expect(platform.singlePane).toBe(false);
    // Split view never exists on mobile, even on a wide iPad.
    expect(platform.splitAvailable).toBe(false);
  });

  it('reports the on-screen keyboard only on mobile and above the threshold', () => {
    platform.keyboardInset = 300;
    expect(platform.keyboardOpen).toBe(false);
    platform.setCapabilities({ ...IOS, export_formats: [] });
    expect(platform.keyboardOpen).toBe(true);
    platform.keyboardInset = 60;
    expect(platform.keyboardOpen).toBe(false);
  });

  it('exposes capabilities for gating desktop-only features', () => {
    expect(platform.can('multi_window')).toBe(true);
    platform.setCapabilities({ ...IOS, export_formats: ['markdown', 'html'] });
    expect(platform.can('multi_window')).toBe(false);
    expect(platform.can('plugin_install')).toBe(false);
    expect(platform.can('external_processes')).toBe(false);
    expect(platform.exportFormats).toEqual(['markdown', 'html']);
  });
});

describe('[contract] initPlatform', () => {
  it('stores native capabilities and the library root and mirrors them onto <html>', async () => {
    getPlatformCapabilities.mockResolvedValue({ ...IOS, os: 'android', plugin_install: true, export_formats: [] });
    getLibraryPath.mockResolvedValue({ status: 'ok', data: '/data/user/0/com.novelist.app/files/Projects' });
    await initPlatform();
    expect(platform.isAndroid).toBe(true);
    expect(platform.libraryRoot).toBe('/data/user/0/com.novelist.app/files/Projects');
    expect(document.documentElement.dataset.mobile).toBe('true');
    expect(document.documentElement.dataset.os).toBe('android');
    expect(document.documentElement.dataset.layout).toBeDefined();
  });

  it('does not resolve a library on desktop', async () => {
    getPlatformCapabilities.mockResolvedValue({
      ...IOS, os: 'macos', is_mobile: false, export_formats: ['html'],
    });
    await initPlatform();
    expect(getLibraryPath).not.toHaveBeenCalled();
    expect(platform.libraryRoot).toBeNull();
  });

  it('fails startup when the mobile library root is unavailable', async () => {
    getPlatformCapabilities.mockResolvedValue({ ...IOS, export_formats: [] });
    getLibraryPath.mockResolvedValue({ status: 'error', error: 'sandbox unavailable' });
    await expect(initPlatform()).rejects.toThrow('sandbox unavailable');
  });

  it('rejects instead of guessing a platform when the probe fails', async () => {
    getPlatformCapabilities.mockRejectedValue(new Error('ipc down'));
    await expect(initPlatform()).rejects.toThrow('ipc down');
    getPlatformCapabilities.mockResolvedValue(null);
    await expect(initPlatform()).rejects.toThrow('invalid payload');
  });
});
