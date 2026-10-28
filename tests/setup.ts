import { beforeEach } from 'vitest';
import { platform } from '$lib/stores/platform.svelte';

/**
 * Production mounts only after `initPlatform()`; unit/integration tests run
 * without the IPC probe, so they start from the desktop (macOS) capability
 * set. Mobile-specific tests call `platform.setCapabilities(...)` themselves.
 */
export const DESKTOP_TEST_CAPABILITIES = {
  os: 'macos',
  is_mobile: false,
  native_menu: true,
  multi_window: true,
  pick_directory: true,
  external_processes: true,
  self_update: true,
  cli_shim: true,
  file_watcher: true,
  plugin_install: true,
  export_formats: ['html', 'pdf', 'docx', 'epub'],
} as const;

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

const storage = new MemoryStorage();

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

if (typeof window !== 'undefined' && typeof window.localStorage === 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: globalThis.localStorage,
  });
}

beforeEach(() => {
  localStorage.clear();
  platform.setCapabilities({ ...DESKTOP_TEST_CAPABILITIES, export_formats: [...DESKTOP_TEST_CAPABILITIES.export_formats] });
});
