import { describe, it, expect, beforeEach } from 'vitest';
import { projectStore } from '$lib/stores/project.svelte';

describe('projectStore.sortMode', () => {
  beforeEach(() => {
    localStorage.clear();
    projectStore.close();
  });

  it('defaults to numeric-asc', () => {
    expect(projectStore.sortMode).toBe('numeric-asc');
  });

  it('persists per-project to localStorage', () => {
    projectStore.setProject('/tmp/proj-a', null, []);
    projectStore.setSortMode('name-desc');
    expect(projectStore.sortMode).toBe('name-desc');

    // Switch project — should fall back to default for new project
    projectStore.setProject('/tmp/proj-b', null, []);
    expect(projectStore.sortMode).toBe('numeric-asc');

    // Switch back — should restore name-desc
    projectStore.setProject('/tmp/proj-a', null, []);
    expect(projectStore.sortMode).toBe('name-desc');
  });
});
