import { describe, it, expect, beforeEach } from 'vitest';

/**
 * [contract] uiStore — layout / zoom / theme / right-panel toggles.
 *
 * The store's constructor reads a handful of `localStorage` keys; tests clear
 * them in `beforeEach` but don't re-import the store (it's a singleton, and
 * module-top-level `applyEditorSettings` is harmless).
 *
 * `setZoom` writes directly to `document.documentElement.style` — happy-dom
 * provides a working documentElement so these assertions are real.
 */

import { uiStore } from '$lib/stores/ui.svelte';

function resetStore() {
  localStorage.clear();
  uiStore.sidebarVisible = true;
  uiStore.outlineVisible = false;
  uiStore.activeRightPanel = null;
  uiStore.sidebarWidth = 240;
  uiStore.rightPanelWidth = 280;
  uiStore.splitRatio = 0.5;
  uiStore.zenMode = false;
  uiStore.settingsOpen = false;
  uiStore.zoomLevel = 1;
  // Reset any inline transforms from previous test runs.
  document.documentElement.style.transform = '';
  document.documentElement.style.width = '';
  document.documentElement.style.height = '';
}

describe('[contract] uiStore — sidebar + outline toggles', () => {
  beforeEach(resetStore);

  it('toggleSidebar flips sidebarVisible', () => {
    expect(uiStore.sidebarVisible).toBe(true);
    uiStore.toggleSidebar();
    expect(uiStore.sidebarVisible).toBe(false);
    uiStore.toggleSidebar();
    expect(uiStore.sidebarVisible).toBe(true);
  });

  it('toggleOutline flips outlineVisible', () => {
    uiStore.toggleOutline();
    expect(uiStore.outlineVisible).toBe(true);
    uiStore.toggleOutline();
    expect(uiStore.outlineVisible).toBe(false);
  });

  it('toggleZen + toggleSettings flip their respective booleans', () => {
    uiStore.toggleZen();
    expect(uiStore.zenMode).toBe(true);
    uiStore.toggleSettings();
    expect(uiStore.settingsOpen).toBe(true);
  });
});

describe('[contract] uiStore.toggleRightPanel (mutual exclusion)', () => {
  beforeEach(resetStore);

  it('opens the panel when none is active', () => {
    uiStore.toggleDraft();
    expect(uiStore.activeRightPanel).toBe('draft');
    expect(uiStore.draftVisible).toBe(true);
  });

  it('closes the active panel when the same id is toggled again', () => {
    uiStore.toggleDraft();
    uiStore.toggleDraft();
    expect(uiStore.activeRightPanel).toBeNull();
    expect(uiStore.draftVisible).toBe(false);
  });

  it('switches panels directly (draft -> snapshot without intermediate null)', () => {
    uiStore.toggleDraft();
    uiStore.toggleSnapshot();
    expect(uiStore.activeRightPanel).toBe('snapshot');
    expect(uiStore.draftVisible).toBe(false);
    expect(uiStore.snapshotVisible).toBe(true);
  });

  it('all four *Visible getters reflect the active panel (mutually exclusive)', () => {
    uiStore.toggleStats();
    expect(uiStore.statsVisible).toBe(true);
    expect(uiStore.templateVisible).toBe(false);
    expect(uiStore.snapshotVisible).toBe(false);
    expect(uiStore.draftVisible).toBe(false);

    uiStore.toggleTemplate();
    expect(uiStore.templateVisible).toBe(true);
    expect(uiStore.statsVisible).toBe(false);
  });
});

describe('[contract] uiStore.setSidebarWidth / setRightPanelWidth / setSplitRatio', () => {
  beforeEach(resetStore);

  it('setSidebarWidth clamps into [160, 480] and persists to localStorage', () => {
    uiStore.setSidebarWidth(50);
    expect(uiStore.sidebarWidth).toBe(160);
    expect(localStorage.getItem('novelist-sidebar-width')).toBe('160');

    uiStore.setSidebarWidth(9999);
    expect(uiStore.sidebarWidth).toBe(480);

    uiStore.setSidebarWidth(300);
    expect(uiStore.sidebarWidth).toBe(300);
    expect(localStorage.getItem('novelist-sidebar-width')).toBe('300');
  });

  it('setRightPanelWidth clamps into [180, 500] and persists', () => {
    uiStore.setRightPanelWidth(10);
    expect(uiStore.rightPanelWidth).toBe(180);
    uiStore.setRightPanelWidth(9999);
    expect(uiStore.rightPanelWidth).toBe(500);
    uiStore.setRightPanelWidth(300);
    expect(localStorage.getItem('novelist-right-panel-width')).toBe('300');
  });

  it('setSplitRatio clamps into [0.2, 0.8] and persists', () => {
    uiStore.setSplitRatio(0);
    expect(uiStore.splitRatio).toBe(0.2);
    uiStore.setSplitRatio(1);
    expect(uiStore.splitRatio).toBe(0.8);
    uiStore.setSplitRatio(0.4);
    expect(uiStore.splitRatio).toBeCloseTo(0.4);
    expect(localStorage.getItem('novelist-split-ratio')).toBe('0.4');
  });
});

describe('[contract] uiStore zoom', () => {
  beforeEach(resetStore);

  it('zoomIn steps up by 0.1, clamped at 2.0', () => {
    uiStore.zoomLevel = 1.95;
    uiStore.zoomIn();
    // Max ceiling is 2.0 (Math.min).
    expect(uiStore.zoomLevel).toBeLessThanOrEqual(2.0);
    expect(uiStore.zoomLevel).toBeGreaterThan(1.95);
    uiStore.zoomLevel = 2.0;
    uiStore.zoomIn();
    expect(uiStore.zoomLevel).toBe(2.0);
  });

  it('zoomOut steps down by 0.1, clamped at 0.5', () => {
    uiStore.zoomLevel = 0.55;
    uiStore.zoomOut();
    expect(uiStore.zoomLevel).toBeGreaterThanOrEqual(0.5);
    uiStore.zoomLevel = 0.5;
    uiStore.zoomOut();
    expect(uiStore.zoomLevel).toBe(0.5);
  });

  it('resetZoom sets 1.0 and clears transform inline styles', () => {
    uiStore.setZoom(1.5);
    expect(document.documentElement.style.transform).toBe('scale(1.5)');
    uiStore.resetZoom();
    expect(uiStore.zoomLevel).toBe(1);
    expect(document.documentElement.style.transform).toBe('');
    expect(localStorage.getItem('novelist-zoom')).toBe('1');
  });

  it('setZoom rounds to one decimal place', () => {
    uiStore.setZoom(1.23456);
    expect(uiStore.zoomLevel).toBe(1.2);
  });

  it('setZoom writes width/height inverse scale when zoom !== 1', () => {
    uiStore.setZoom(2);
    expect(document.documentElement.style.width).toBe('50%');
    expect(document.documentElement.style.height).toBe('50%');
  });
});

describe('[contract] uiStore.setTheme', () => {
  beforeEach(resetStore);

  it('updates themeId, persists, and refreshes currentTheme', () => {
    uiStore.setTheme('light');
    expect(uiStore.themeId).toBe('light');
    // loadThemeId reads back from the same localStorage key.
    expect(localStorage.getItem('novelist-theme')).toBe('light');
    expect(uiStore.currentTheme).toBeDefined();
  });
});

describe('[contract] uiStore.updateEditorSettings', () => {
  beforeEach(resetStore);

  it('merges the partial patch into editorSettings and persists to localStorage', () => {
    uiStore.updateEditorSettings({ fontSize: 20 });
    expect(uiStore.editorSettings.fontSize).toBe(20);
    // Other defaults preserved.
    expect(uiStore.editorSettings.fontFamily).toBeTruthy();
    const stored = JSON.parse(localStorage.getItem('novelist-settings')!);
    expect(stored.fontSize).toBe(20);
  });

  it('applies CSS custom properties for font + layout on the root', () => {
    uiStore.updateEditorSettings({ fontSize: 18, lineHeight: 2.0, maxWidth: 800 });
    const root = document.documentElement;
    expect(root.style.getPropertyValue('--novelist-editor-font-size')).toBe('18px');
    expect(root.style.getPropertyValue('--novelist-editor-line-height')).toBe('2');
    expect(root.style.getPropertyValue('--novelist-editor-max-width')).toBe('800px');
  });

  it('multiple partial updates accumulate', () => {
    uiStore.updateEditorSettings({ fontSize: 18 });
    uiStore.updateEditorSettings({ lineHeight: 2.2 });
    expect(uiStore.editorSettings.fontSize).toBe(18);
    expect(uiStore.editorSettings.lineHeight).toBe(2.2);
  });
});
