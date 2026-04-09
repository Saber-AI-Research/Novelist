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

class UiStore {
  sidebarVisible = $state(true);
  outlineVisible = $state(false);
  draftVisible = $state(false);
  snapshotVisible = $state(false);
  statsVisible = $state(false);
  sidebarWidth = $state(240);
  zenMode = $state(false);
  settingsOpen = $state(false);
  editorSettings = $state<EditorSettings>(loadSettings());

  // Theme
  themeId = $state(loadThemeId());
  currentTheme = $state<Theme>(resolveTheme(loadThemeId()));

  toggleSidebar() { this.sidebarVisible = !this.sidebarVisible; }
  toggleOutline() { this.outlineVisible = !this.outlineVisible; }
  toggleDraft() { this.draftVisible = !this.draftVisible; }
  toggleSnapshot() { this.snapshotVisible = !this.snapshotVisible; }
  toggleStats() { this.statsVisible = !this.statsVisible; }
  toggleZen() { this.zenMode = !this.zenMode; }
  toggleSettings() { this.settingsOpen = !this.settingsOpen; }

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

// Apply saved settings and theme on load
if (typeof document !== 'undefined') {
  uiStore.applyEditorSettings();
  applyTheme(uiStore.currentTheme);

  // Listen for system theme changes when using "system" theme
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (uiStore.themeId === 'system') {
      uiStore.currentTheme = resolveTheme('system');
      applyTheme(uiStore.currentTheme);
    }
  });
}
