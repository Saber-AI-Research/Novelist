interface TabState {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  isDirty: boolean;
  scrollPosition: number;
  cursorPosition: number;
}

class TabsStore {
  tabs = $state<TabState[]>([]);
  activeTabId = $state<string | null>(null);

  get activeTab(): TabState | undefined {
    return this.tabs.find(t => t.id === this.activeTabId);
  }

  openTab(filePath: string, content: string) {
    const existing = this.tabs.find(t => t.filePath === filePath);
    if (existing) { this.activeTabId = existing.id; return; }

    const fileName = filePath.split('/').pop() || filePath;
    const id = crypto.randomUUID();
    this.tabs.push({ id, filePath, fileName, content, isDirty: false, scrollPosition: 0, cursorPosition: 0 });
    this.activeTabId = id;
  }

  closeTab(id: string) {
    const idx = this.tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    this.tabs.splice(idx, 1);
    if (this.activeTabId === id) {
      this.activeTabId = this.tabs.length > 0 ? this.tabs[Math.min(idx, this.tabs.length - 1)].id : null;
    }
  }

  activateTab(id: string) { this.activeTabId = id; }

  updateContent(id: string, content: string) {
    const tab = this.tabs.find(t => t.id === id);
    if (tab) { tab.content = content; tab.isDirty = true; }
  }

  markSaved(id: string) {
    const tab = this.tabs.find(t => t.id === id);
    if (tab) tab.isDirty = false;
  }

  closeAll() { this.tabs = []; this.activeTabId = null; }
}

export const tabsStore = new TabsStore();
