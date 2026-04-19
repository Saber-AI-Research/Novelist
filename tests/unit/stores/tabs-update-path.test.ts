import { describe, it, expect, beforeEach } from 'vitest';
import { tabsStore } from '$lib/stores/tabs.svelte';

describe('tabsStore.updatePath', () => {
  beforeEach(() => {
    tabsStore.closeAll();
  });

  it('updates filePath and fileName on a single tab', () => {
    tabsStore.openTab('/proj/Untitled 1.md', '');
    const id = tabsStore.activeTabId!;
    tabsStore.updatePath('/proj/Untitled 1.md', '/proj/开篇.md');
    const tab = tabsStore.tabs.find(t => t.id === id);
    expect(tab?.filePath).toBe('/proj/开篇.md');
    expect(tab?.fileName).toBe('开篇.md');
  });

  it('updates ALL panes when same file open in split view', () => {
    tabsStore.openTab('/proj/foo.md', '');
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-2', '/proj/foo.md', '');
    tabsStore.updatePath('/proj/foo.md', '/proj/bar.md');
    const all = tabsStore.findAllByPath('/proj/bar.md');
    expect(all.length).toBe(2);
    const stillOld = tabsStore.findAllByPath('/proj/foo.md');
    expect(stillOld.length).toBe(0);
  });

  it('no-op when no matching tab', () => {
    tabsStore.openTab('/proj/a.md', '');
    expect(() => tabsStore.updatePath('/proj/missing.md', '/proj/x.md')).not.toThrow();
  });
});
