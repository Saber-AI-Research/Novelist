class UiStore {
  sidebarVisible = $state(true);
  outlineVisible = $state(false);
  sidebarWidth = $state(240);
  zenMode = $state(false);

  toggleSidebar() { this.sidebarVisible = !this.sidebarVisible; }
  toggleOutline() { this.outlineVisible = !this.outlineVisible; }
  toggleZen() { this.zenMode = !this.zenMode; }
}

export const uiStore = new UiStore();
