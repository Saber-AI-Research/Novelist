import { loadThemeId, saveThemeId, resolveTheme, applyTheme, type Theme } from '$lib/themes';

const SETTINGS_KEY = 'novelist-settings';
const SIDEBAR_WIDTH_KEY = 'novelist-sidebar-width';
const RIGHT_PANEL_WIDTH_KEY = 'novelist-right-panel-width';
const SPLIT_RATIO_KEY = 'novelist-split-ratio';
const ZOOM_KEY = 'novelist-zoom';
const ZOOM_AUTO_INIT_KEY = 'novelist-zoom-auto-inited';
const ZOOM_USER_SET_KEY = 'novelist-zoom-user-set';
const ZOOM_DPI_V2_MIGRATED_KEY = 'novelist-zoom-dpi-v2-migrated';
const DEVELOPER_MODE_KEY = 'novelist-developer-mode';

interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  maxWidth: number;
  autoSaveMinutes: number;
  /** 'tab' for real tab character, or number for spaces (2, 4, 8) */
  indentStyle: 'tab' | number;
  /** Highlight all matching words when text is selected */
  highlightMatches: boolean;
  /** Render inline image previews for ![alt](url) syntax */
  renderImages: boolean;
}

const defaultSettings: EditorSettings = {
  fontFamily: '"LXGW WenKai Screen", "LXGW WenKai", "Noto Serif SC", Georgia, serif',
  fontSize: 16,
  lineHeight: 1.8,
  maxWidth: 720,
  autoSaveMinutes: 5,
  indentStyle: 4,
  highlightMatches: true,
  renderImages: true,
};

function loadSettings(): EditorSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {}
  return { ...defaultSettings };
}

function saveSettings(s: EditorSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export type RightPanel = 'draft' | 'snapshot' | 'stats' | 'template' | 'literary' | null;

function readNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const value = parseFloat(localStorage.getItem(key) ?? '');
    if (Number.isFinite(value)) return Math.max(min, Math.min(max, value));
  } catch {
    // Corrupt or unavailable storage should never break startup.
  }
  return fallback;
}

class UiStore {
  sidebarVisible = $state(true);
  outlineVisible = $state(false);
  /** Which right panel is active. Draft/Snapshot/Stats are mutually exclusive. */
  activeRightPanel = $state<RightPanel>(null);
  sidebarWidth = $state(readNumber(SIDEBAR_WIDTH_KEY, 240, 160, 480));
  rightPanelWidth = $state(readNumber(RIGHT_PANEL_WIDTH_KEY, 280, 180, 500));
  splitRatio = $state(readNumber(SPLIT_RATIO_KEY, 0.5, 0.2, 0.8));
  zenMode = $state(false);
  settingsOpen = $state(false);
  /** When on, F12 opens the native WebView DevTools. Persisted per-machine. */
  developerMode = $state<boolean>(localStorage.getItem(DEVELOPER_MODE_KEY) === 'true');
  editorSettings = $state<EditorSettings>(loadSettings());
  zoomLevel = $state(readNumber(ZOOM_KEY, 1, 0.5, 2.0));

  /**
   * True while a draggable sidebar file (NOT a folder) is in flight. Used to
   * show pane drop overlays in App.svelte. Set in Sidebar.handleDragStart,
   * cleared on the global window dragend handler.
   */
  sidebarFileDragActive = $state(false);

  /**
   * True while a tab is being dragged (set in TabBar dragstart, cleared on the
   * global window dragend). Drives the per-pane edge drop zones the same way
   * `sidebarFileDragActive` does for sidebar files.
   */
  tabDragActive = $state(false);

  // Theme
  themeId = $state(loadThemeId());
  currentTheme = $state<Theme>(resolveTheme(loadThemeId()));

  // Derived visibility for each panel
  get draftVisible(): boolean { return this.activeRightPanel === 'draft'; }
  get snapshotVisible(): boolean { return this.activeRightPanel === 'snapshot'; }
  get statsVisible(): boolean { return this.activeRightPanel === 'stats'; }
  get templateVisible(): boolean { return this.activeRightPanel === 'template'; }
  get literaryVisible(): boolean { return this.activeRightPanel === 'literary'; }
  toggleSidebar() { this.sidebarVisible = !this.sidebarVisible; }
  toggleOutline() { this.outlineVisible = !this.outlineVisible; }

  /** Toggle a right panel. If it's already active, close it. Otherwise switch to it. */
  toggleRightPanel(panel: RightPanel) {
    this.activeRightPanel = this.activeRightPanel === panel ? null : panel;
  }

  toggleDraft() { this.toggleRightPanel('draft'); }
  toggleSnapshot() { this.toggleRightPanel('snapshot'); }
  toggleStats() { this.toggleRightPanel('stats'); }
  toggleTemplate() { this.toggleRightPanel('template'); }
  toggleLiterary() { this.toggleRightPanel('literary'); }
  toggleZen() { this.zenMode = !this.zenMode; }
  toggleSettings() { this.settingsOpen = !this.settingsOpen; }
  setDeveloperMode(on: boolean) {
    this.developerMode = on;
    localStorage.setItem(DEVELOPER_MODE_KEY, String(on));
  }

  setSidebarWidth(width: number) {
    this.sidebarWidth = Math.max(160, Math.min(480, width));
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(this.sidebarWidth));
  }

  setRightPanelWidth(width: number) {
    this.rightPanelWidth = Math.max(180, Math.min(500, width));
    localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(this.rightPanelWidth));
  }

  setSplitRatio(ratio: number) {
    this.splitRatio = Math.max(0.2, Math.min(0.8, ratio));
    localStorage.setItem(SPLIT_RATIO_KEY, String(this.splitRatio));
  }

  zoomIn() { this.setZoom(Math.min(this.zoomLevel + 0.1, 2.0), { userInitiated: true }); }
  zoomOut() { this.setZoom(Math.max(this.zoomLevel - 0.1, 0.5), { userInitiated: true }); }
  resetZoom() { this.setZoom(1.0, { userInitiated: true }); }
  setZoom(level: number, options: { userInitiated?: boolean } = {}) {
    const safeLevel = Number.isFinite(level) ? level : 1;
    this.zoomLevel = Math.round(Math.max(0.5, Math.min(2.0, safeLevel)) * 10) / 10;
    const root = document.documentElement;
    root.style.transform = this.zoomLevel === 1 ? '' : `scale(${this.zoomLevel})`;
    root.style.transformOrigin = 'top left';
    root.style.width = this.zoomLevel === 1 ? '' : `${100 / this.zoomLevel}%`;
    root.style.height = this.zoomLevel === 1 ? '' : `${100 / this.zoomLevel}%`;
    localStorage.setItem(ZOOM_KEY, String(this.zoomLevel));
    if (options.userInitiated) localStorage.setItem(ZOOM_USER_SET_KEY, '1');
  }

  setTheme(id: string) {
    this.themeId = id;
    this.currentTheme = resolveTheme(id);
    saveThemeId(id);
    applyTheme(this.currentTheme);
  }

  updateEditorSettings(partial: Partial<EditorSettings>) {
    this.editorSettings = { ...this.editorSettings, ...partial };
    this.applyEditorSettings();
    saveSettings(this.editorSettings);
  }

  applyEditorSettings() {
    const root = document.documentElement;
    root.style.setProperty('--novelist-editor-font', this.editorSettings.fontFamily);
    root.style.setProperty('--novelist-editor-font-size', `${this.editorSettings.fontSize}px`);
    root.style.setProperty('--novelist-editor-line-height', `${this.editorSettings.lineHeight}`);
    root.style.setProperty('--novelist-editor-max-width', `${this.editorSettings.maxWidth}px`);
  }
}

export const uiStore = new UiStore();

export interface AutoZoomScreen {
  /** CSS/logical screen width reported by the OS, not physical panel pixels. */
  logicalWidth: number;
  /** Browser/WebView devicePixelRatio. On Windows this usually reflects OS scale. */
  devicePixelRatio: number;
}

function normalizeScreenProfile(screen: AutoZoomScreen): AutoZoomScreen {
  const logicalWidth = Number.isFinite(screen.logicalWidth) ? Math.max(0, screen.logicalWidth) : 0;
  const devicePixelRatio = Number.isFinite(screen.devicePixelRatio) && screen.devicePixelRatio > 0
    ? screen.devicePixelRatio
    : 1;
  return { logicalWidth, devicePixelRatio };
}

function currentScreenProfile(): AutoZoomScreen {
  return {
    logicalWidth: window.screen?.width ?? window.innerWidth ?? 0,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

/**
 * Pure picker — given the OS logical screen profile, return the zoom level we
 * want to apply on a fresh install. Exported for unit tests.
 *
 * Do not multiply `screen.width` by DPR here. On Windows, DPR already means
 * the OS is scaling UI for readability; multiplying it back to physical 4K
 * pixels and then applying our own transform compounds the scaling and makes
 * text look overgrown or blurry.
 */
export function pickAutoZoomFromScreen(screen: AutoZoomScreen): number {
  const { logicalWidth, devicePixelRatio } = normalizeScreenProfile(screen);
  if (logicalWidth === 0) return 1.0;
  if (devicePixelRatio >= 1.5) return 1.0;
  if (logicalWidth >= 3840) return 1.2;
  if (logicalWidth >= 2560) return 1.1;
  return 1.0;
}

/**
 * One-time auto-pick of the initial zoom level on first launch. After this
 * runs once, `novelist-zoom-auto-inited` is set and we never touch zoom
 * again — Cmd +/- / Cmd+0 take full control.
 *
 * Existing users (v0.2.4 and earlier) who already have a `novelist-zoom`
 * value get the flag written without any zoom change, so we don't override
 * their explicit choice.
 *
 * Exported for unit tests; runs automatically below in the document init
 * block. The store argument is injected so tests can supply a stub.
 */
export function autoInitZoomFromScreen(
  store: { setZoom: (level: number) => void },
  screen: AutoZoomScreen,
): void {
  if (localStorage.getItem(ZOOM_AUTO_INIT_KEY)) return;
  if (localStorage.getItem(ZOOM_KEY) !== null) {
    localStorage.setItem(ZOOM_AUTO_INIT_KEY, '1');
    return;
  }
  const level = pickAutoZoomFromScreen(screen);
  store.setZoom(level);
  localStorage.setItem(ZOOM_AUTO_INIT_KEY, '1');
}

/**
 * One-time repair for the first auto-zoom algorithm. v0.2.4 used physical
 * panel pixels (`screen.width * DPR`), so Windows 4K at 150-200% scaling got
 * an extra 1.5x transform on top of OS scaling. Correct only values that look
 * like the old automatic picks and leave explicit manual zoom alone going
 * forward via `novelist-zoom-user-set`.
 */
export function migrateLegacyAutoZoomFromScreen(
  store: { setZoom: (level: number) => void },
  screen: AutoZoomScreen,
): void {
  if (localStorage.getItem(ZOOM_DPI_V2_MIGRATED_KEY)) return;
  localStorage.setItem(ZOOM_DPI_V2_MIGRATED_KEY, '1');

  if (!localStorage.getItem(ZOOM_AUTO_INIT_KEY)) return;
  if (localStorage.getItem(ZOOM_USER_SET_KEY)) return;

  const current = parseFloat(localStorage.getItem(ZOOM_KEY) ?? '');
  const isLegacyAutoPick = Math.abs(current - 1.25) < 0.001 || Math.abs(current - 1.5) < 0.001;
  if (!isLegacyAutoPick) return;

  const next = pickAutoZoomFromScreen(screen);
  if (next < current) store.setZoom(next);
}

// Apply saved settings, theme, and zoom on load
if (typeof document !== 'undefined') {
  uiStore.applyEditorSettings();
  applyTheme(uiStore.currentTheme);
  const screen = currentScreenProfile();
  autoInitZoomFromScreen(uiStore, screen);
  migrateLegacyAutoZoomFromScreen(uiStore, screen);
  if (uiStore.zoomLevel !== 1) uiStore.setZoom(uiStore.zoomLevel);

  // Listen for system theme changes when using "system" theme
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (uiStore.themeId === 'system') {
      uiStore.currentTheme = resolveTheme('system');
      applyTheme(uiStore.currentTheme);
    }
  });
}
