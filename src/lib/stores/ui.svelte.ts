class UiStore {
  sidebarVisible = $state(true);
  outlineVisible = $state(false);
  sidebarWidth = $state(240);

  toggleSidebar() { this.sidebarVisible = !this.sidebarVisible; }
  toggleOutline() { this.outlineVisible = !this.outlineVisible; }
}

export const uiStore = new UiStore();
