import { describe, it, expect } from 'vitest';
import { computeWindowTitle } from '$lib/composables/window-title.svelte';

/**
 * [precision] computeWindowTitle — pure helper extracted from the
 * `useWindowTitle` effect. Drives all five title-composition branches.
 */

describe('[precision] computeWindowTitle', () => {
  it('returns just app-name when no tab and no project', () => {
    expect(
      computeWindowTitle('Novelist', null, { name: 'No Project', isOpen: false, singleFileMode: false }),
    ).toBe('Novelist');
  });

  it('returns "project — app" when a project is open and no tab is active', () => {
    expect(
      computeWindowTitle('Novelist', null, { name: 'My Novel', isOpen: true, singleFileMode: false }),
    ).toBe('My Novel — Novelist');
  });

  it('returns plain app-name for single-file mode with no tab', () => {
    // single-file + no tab shouldn't surface the synthetic project name.
    expect(
      computeWindowTitle('Novelist', null, { name: 'ignored', isOpen: true, singleFileMode: true }),
    ).toBe('Novelist');
  });

  it('returns "tab — project — app" when a tab is active in a project', () => {
    expect(
      computeWindowTitle(
        'Novelist',
        { fileName: 'chapter.md', isDirty: false },
        { name: 'My Novel', isOpen: true, singleFileMode: false },
      ),
    ).toBe('chapter.md — My Novel — Novelist');
  });

  it('prefixes the dirty dot when the active tab has unsaved changes', () => {
    expect(
      computeWindowTitle(
        'Novelist',
        { fileName: 'chapter.md', isDirty: true },
        { name: 'My Novel', isOpen: true, singleFileMode: false },
      ),
    ).toBe('● chapter.md — My Novel — Novelist');
  });

  it('omits the project segment in single-file mode', () => {
    expect(
      computeWindowTitle(
        'Novelist',
        { fileName: 'draft.md', isDirty: false },
        { name: 'ignored', isOpen: true, singleFileMode: true },
      ),
    ).toBe('draft.md — Novelist');
  });

  it('still prefixes the dirty dot in single-file mode', () => {
    expect(
      computeWindowTitle(
        'Novelist',
        { fileName: 'draft.md', isDirty: true },
        { name: 'ignored', isOpen: true, singleFileMode: true },
      ),
    ).toBe('● draft.md — Novelist');
  });
});
