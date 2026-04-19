/** Reusable mock data for Tauri IPC responses */

export interface MockFileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime?: number;
}

export interface MockRecentProject {
  path: string;
  name: string;
  last_opened: string;
  pinned?: boolean;
  sort_order?: number | null;
}

export const MOCK_PROJECT_DIR = '/tmp/novelist-test-project';

export const MOCK_FILES: MockFileEntry[] = [
  { name: 'Chapter 1.md', path: `${MOCK_PROJECT_DIR}/Chapter 1.md`, is_dir: false, size: 1024 },
  { name: 'Chapter 2.md', path: `${MOCK_PROJECT_DIR}/Chapter 2.md`, is_dir: false, size: 2048 },
  { name: 'Notes', path: `${MOCK_PROJECT_DIR}/Notes`, is_dir: true, size: 0 },
  { name: 'outline.md', path: `${MOCK_PROJECT_DIR}/Notes/outline.md`, is_dir: false, size: 128 },
  { name: 'Chapter 3.md', path: `${MOCK_PROJECT_DIR}/Chapter 3.md`, is_dir: false, size: 512 },
  { name: 'board.kanban', path: `${MOCK_PROJECT_DIR}/board.kanban`, is_dir: false, size: 64 },
];

export const MOCK_FILE_CONTENTS: Record<string, string> = {
  [`${MOCK_PROJECT_DIR}/Chapter 1.md`]: '# Chapter 1\n\nIt was a dark and stormy night.\n\nThe wind howled through the trees.\n',
  [`${MOCK_PROJECT_DIR}/Chapter 2.md`]: '# Chapter 2\n\nThe next morning dawned bright and clear.\n',
  [`${MOCK_PROJECT_DIR}/Chapter 3.md`]: '# Chapter 3\n\n这是第三章的内容。\n\n中文测试文本。\n',
  [`${MOCK_PROJECT_DIR}/Notes/outline.md`]: '# Outline\n\nNotes on story arc.\n',
  [`${MOCK_PROJECT_DIR}/board.kanban`]: JSON.stringify({
    columns: [
      { id: 'todo', name: 'To Do', cards: [{ id: 'c1', text: 'First task' }] },
      { id: 'doing', name: 'Doing', cards: [] },
      { id: 'done', name: 'Done', cards: [] },
    ],
  }, null, 2),
};

export const MOCK_RECENT_PROJECTS: MockRecentProject[] = [
  { path: MOCK_PROJECT_DIR, name: 'Test Novel', last_opened: '2026-04-14T10:00:00Z', pinned: false, sort_order: null },
  { path: '/tmp/another-project', name: 'Another Story', last_opened: '2026-04-13T09:00:00Z', pinned: false, sort_order: null },
  { path: '/tmp/third-project', name: 'Third Draft', last_opened: '2026-04-12T09:00:00Z', pinned: false, sort_order: null },
];

export const MOCK_PROJECT_CONFIG = {
  project: { name: 'Test Novel', type: 'novel', version: '1.0' },
  outline: null,
  writing: null,
};
