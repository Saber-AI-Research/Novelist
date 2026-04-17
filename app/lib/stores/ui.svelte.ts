import { loadThemeId, saveThemeId, resolveTheme, applyTheme, type Theme } from '$lib/themes';

const SETTINGS_KEY = 'novelist-settings';

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

export type RightPanel = 'draft' | 'snapshot' | 'stats' | null;

class UiStore {
  sidebarVisible = $state(true);
  outlineVisible = $state(false);
  /** Which right panel is active. Draft/Snapshot/Stats are mutually exclusive. */
  activeRightPanel = $state<RightPanel>(null);
  sidebarWidth = $state(parseInt(localStorage.getItem('novelist-sidebar-width') || '240', 10));
  rightPanelWidth = $state(parseInt(localStorage.getItem('novelist-right-panel-width') || '280', 10));
  splitRatio = $state(parseFloat(localStorage.getItem('novelist-split-ratio') || '0.5'));
  zenMode = $state(false);
  settingsOpen = $state(false);
  editorSettings = $state<EditorSettings>(loadSettings());
  zoomLevel = $state(parseFloat(localStorage.getItem('novelist-zoom') || '1'));

  // Theme
  themeId = $state(loadThemeId());
  currentTheme = $state<Theme>(resolveTheme(loadThemeId()));

  // Derived visibility for each panel
  get draftVisible(): boolean { return this.activeRightPanel === 'draft'; }
  get snapshotVisible(): boolean { return this.activeRightPanel === 'snapshot'; }
  get statsVisible(): boolean { return this.activeRightPanel === 'stats'; }
  toggleSidebar() { this.sidebarVisible = !this.sidebarVisible; }
  toggleOutline() { this.outlineVisible = !this.outlineVisible; }

  /** Toggle a right panel. If it's already active, close it. Otherwise switch to it. */
  toggleRightPanel(panel: RightPanel) {
    this.activeRightPanel = this.activeRightPanel === panel ? null : panel;
  }

  toggleDraft() { this.toggleRightPanel('draft'); }
  toggleSnapshot() { this.toggleRightPanel('snapshot'); }
  toggleStats() { this.toggleRightPanel('stats'); }
  toggleZen() { this.zenMode = !this.zenMode; }
  toggleSettings() { this.settingsOpen = !this.settingsOpen; }

  setSidebarWidth(width: number) {
    this.sidebarWidth = Math.max(160, Math.min(480, width));
    localStorage.setItem('novelist-sidebar-width', String(this.sidebarWidth));
  }

  setRightPanelWidth(width: number) {
    this.rightPanelWidth = Math.max(180, Math.min(500, width));
    localStorage.setItem('novelist-right-panel-width', String(this.rightPanelWidth));
  }

  setSplitRatio(ratio: number) {
    this.splitRatio = Math.max(0.2, Math.min(0.8, ratio));
    localStorage.setItem('novelist-split-ratio', String(this.splitRatio));
  }

  zoomIn() { this.setZoom(Math.min(this.zoomLevel + 0.1, 2.0)); }
  zoomOut() { this.setZoom(Math.max(this.zoomLevel - 0.1, 0.5)); }
  resetZoom() { this.setZoom(1.0); }
  setZoom(level: number) {
    this.zoomLevel = Math.round(level * 10) / 10;
    const root = document.documentElement;
    root.style.transform = this.zoomLevel === 1 ? '' : `scale(${this.zoomLevel})`;
    root.style.transformOrigin = 'top left';
    root.style.width = this.zoomLevel === 1 ? '' : `${100 / this.zoomLevel}%`;
    root.style.height = this.zoomLevel === 1 ? '' : `${100 / this.zoomLevel}%`;
    localStorage.setItem('novelist-zoom', String(this.zoomLevel));
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

// Apply saved settings, theme, and zoom on load
if (typeof document !== 'undefined') {
  uiStore.applyEditorSettings();
  applyTheme(uiStore.currentTheme);
  if (uiStore.zoomLevel !== 1) uiStore.setZoom(uiStore.zoomLevel);

  // Listen for system theme changes when using "system" theme
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (uiStore.themeId === 'system') {
      uiStore.currentTheme = resolveTheme('system');
      applyTheme(uiStore.currentTheme);
    }
  });
}
