import { loadThemeId, saveThemeId, resolveTheme, applyTheme, type Theme } from '$lib/themes';

const SETTINGS_KEY = 'novelist-settings';

interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  maxWidth: number;
  autoSaveMinutes: number;
}

const defaultSettings: EditorSettings = {
  fontFamily: '"LXGW WenKai", "Noto Serif SC", Georgia, serif',
  fontSize: 16,
  lineHeight: 1.8,
  maxWidth: 720,
  autoSaveMinutes: 5,
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

export type RightPanel = 'draft' | 'snapshot' | 'stats' | 'mindmap' | null;

class UiStore {
  sidebarVisible = $state(true);
  outlineVisible = $state(false);
  /** Which right panel is active. Draft/Snapshot/Stats are mutually exclusive. */
  activeRightPanel = $state<RightPanel>(null);
  sidebarWidth = $state(240);
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
  get mindmapVisible(): boolean { return this.activeRightPanel === 'mindmap'; }

  toggleSidebar() { this.sidebarVisible = !this.sidebarVisible; }
  toggleOutline() { this.outlineVisible = !this.outlineVisible; }

  /** Toggle a right panel. If it's already active, close it. Otherwise switch to it. */
  toggleRightPanel(panel: RightPanel) {
    this.activeRightPanel = this.activeRightPanel === panel ? null : panel;
  }

  toggleDraft() { this.toggleRightPanel('draft'); }
  toggleSnapshot() { this.toggleRightPanel('snapshot'); }
  toggleStats() { this.toggleRightPanel('stats'); }
  toggleMindmap() { this.toggleRightPanel('mindmap'); }
  toggleZen() { this.zenMode = !this.zenMode; }
  toggleSettings() { this.settingsOpen = !this.settingsOpen; }

  setSplitRatio(ratio: number) {
    this.splitRatio = Math.max(0.2, Math.min(0.8, ratio));
    localStorage.setItem('novelist-split-ratio', String(this.splitRatio));
  }

  zoomIn() { this.setZoom(Math.min(this.zoomLevel + 0.1, 2.0)); }
  zoomOut() { this.setZoom(Math.max(this.zoomLevel - 0.1, 0.5)); }
  resetZoom() { this.setZoom(1.0); }
  setZoom(level: number) {
    this.zoomLevel = Math.round(level * 10) / 10;
    document.documentElement.style.zoom = `${this.zoomLevel}`;
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
  if (uiStore.zoomLevel !== 1) document.documentElement.style.zoom = `${uiStore.zoomLevel}`;

  // Listen for system theme changes when using "system" theme
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (uiStore.themeId === 'system') {
      uiStore.currentTheme = resolveTheme('system');
      applyTheme(uiStore.currentTheme);
    }
  });
}
