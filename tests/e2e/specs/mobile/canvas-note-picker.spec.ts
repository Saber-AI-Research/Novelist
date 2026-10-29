import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/app-fixture';
import { MOCK_FILES, MOCK_PROJECT_DIR } from '../../fixtures/mock-data';

/**
 * Canvas "Link a note" on mobile (iphone / ipad / ipad-landscape /
 * android-phone projects). The system picker there returns sandbox copies or
 * content:// URIs outside the project, so the canvas browses the project
 * itself and only links a note it could read. In-project links are stored
 * relative to the project root so the canvas survives relocation and sync.
 */

const CANVAS = `${MOCK_PROJECT_DIR}/board.canvas`;
const LOCKED = `${MOCK_PROJECT_DIR}/Notes/locked.md`;
/** The same project at another device/container root (still in the mock library). */
const RELOCATED = '/tmp/relocated-novel';

async function openCanvas(app: Page, mockState: { setFileContent: (p: string, c: string) => Promise<void>; openProject: (d: string, f: typeof MOCK_FILES) => Promise<void> }) {
  await mockState.setFileContent(CANVAS, JSON.stringify({ nodes: [], edges: [] }));
  await mockState.setFileContent(LOCKED, '# Locked\n');
  await mockState.openProject(MOCK_PROJECT_DIR, [
    ...MOCK_FILES,
    { name: 'locked.md', path: LOCKED, is_dir: false, size: 16 },
    { name: 'board.canvas', path: CANVAS, is_dir: false, size: 32 },
  ]);
  await app.getByTestId('library-project-0').tap();
  await expect(app.getByTestId('app-layout')).toBeVisible();
  await app.getByTestId('sidebar-file-board.canvas').tap();
  await expect(app.locator('.canvas-editor .svelte-flow')).toBeVisible();
}

function linkedFiles(content: string | null): string[] {
  const canvas = JSON.parse(content ?? '{"nodes":[]}') as { nodes: Array<{ type: string; file?: string }> };
  return canvas.nodes.filter((node) => node.type === 'file').map((node) => node.file ?? '');
}

test.describe('canvas note picker (mobile)', () => {
  test('links a project note by browsing folders, and the card persists', async ({ app, mockState }) => {
    await openCanvas(app, mockState);

    await app.getByTestId('canvas-add-note').tap();
    const picker = app.getByTestId('canvas-note-picker');
    await expect(picker).toBeVisible();
    // Only folders and Markdown/text notes are offered; the canvas and kanban are not.
    await expect(picker.getByTestId('canvas-note-picker-entry')).toHaveText(['Notes', 'Chapter 1.md', 'Chapter 2.md', 'Chapter 3.md']);

    await picker.getByTestId('canvas-note-picker-entry').filter({ hasText: 'Notes' }).tap();
    await expect(picker.getByRole('button', { name: 'Notes' })).toBeVisible(); // breadcrumb
    await picker.getByTestId('canvas-note-picker-entry').filter({ hasText: 'outline.md' }).tap();

    await expect(picker).toHaveCount(0);
    const card = app.locator('.svelte-flow__node-file');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('outline.md');
    await expect(card).toContainText('# Outline');
    await expect.poll(async () => linkedFiles(await mockState.getFileContent(CANVAS))).toEqual(['Notes/outline.md']);

    const dialogCalls = (await mockState.getInvokeCalls()).filter((call) => call.command.startsWith('plugin:dialog'));
    expect(dialogCalls).toEqual([]);
  });

  test('an unreadable note never becomes a card; up and cancel leave the canvas unchanged', async ({ app, mockState }) => {
    await openCanvas(app, mockState);
    await mockState.setReadFileBlocked(LOCKED, true);

    await app.getByTestId('canvas-add-note').tap();
    const picker = app.getByTestId('canvas-note-picker');
    await picker.getByTestId('canvas-note-picker-entry').filter({ hasText: 'Notes' }).tap();
    await picker.getByTestId('canvas-note-picker-entry').filter({ hasText: 'locked.md' }).tap();
    await expect(picker.getByTestId('canvas-note-picker-entry').first()).toBeDisabled();
    await mockState.failNextBlockedRead('Permission denied');

    await expect(picker.getByRole('alert')).toContainText('Permission denied');
    await expect(app.locator('.svelte-flow__node-file')).toHaveCount(0);

    await picker.getByRole('button', { name: 'Up one folder' }).tap();
    await expect(picker.getByTestId('canvas-note-picker-entry').first()).toHaveText('Notes');
    await picker.getByRole('button', { name: 'Cancel' }).tap();
    await expect(picker).toHaveCount(0);
    await mockState.setReadFileBlocked(LOCKED, false);

    expect(linkedFiles(await mockState.getFileContent(CANVAS))).toEqual([]);
    await expect(app.locator('.svelte-flow__node-file')).toHaveCount(0);
  });
});

// Seed the mock before boot: the project now lives at RELOCATED and its canvas
// was written elsewhere (relative link, an older absolute link into this
// project's new root, and a stale absolute link from the old device root).
const relocatedTest = test.extend({
  page: async ({ page }, use) => {
    const canvas = JSON.stringify({
      nodes: [
        { id: 'rel', type: 'file', x: 0, y: 0, width: 260, height: 160, file: 'Notes/outline.md' },
        { id: 'stale', type: 'file', x: 300, y: 0, width: 260, height: 160, file: `${MOCK_PROJECT_DIR}/Notes/outline.md` },
        { id: 'abs', type: 'file', x: 600, y: 0, width: 260, height: 160, file: `${RELOCATED}/Notes/outline.md` },
      ],
      edges: [],
    });
    await page.addInitScript(({ root, canvas }) => {
      if (localStorage.getItem('__novelist_mock_recent_seed__')) return;
      localStorage.setItem('__novelist_mock_recent_seed__', JSON.stringify([
        { path: root, name: 'Relocated Novel', last_opened: '2026-10-01T10:00:00Z', pinned: false, sort_order: null },
      ]));
      localStorage.setItem('__novelist_mock_files__', JSON.stringify([
        { name: 'Notes', path: `${root}/Notes`, is_dir: true, size: 0 },
        { name: 'outline.md', path: `${root}/Notes/outline.md`, is_dir: false, size: 32 },
        { name: 'board.canvas', path: `${root}/board.canvas`, is_dir: false, size: canvas.length },
      ]));
      localStorage.setItem('__novelist_mock_contents__', JSON.stringify({
        [`${root}/Notes/outline.md`]: '# Outline at the new root\n',
        [`${root}/board.canvas`]: canvas,
      }));
    }, { root: RELOCATED, canvas });
    await use(page);
  },
});

relocatedTest('a relative note link still loads after the project moves to a new root', async ({ app, mockState }) => {
  await app.getByTestId('library-project-0').tap();
  await expect(app.getByTestId('app-layout')).toBeVisible();
  await app.getByTestId('sidebar-file-board.canvas').tap();

  const cards = app.locator('.svelte-flow__node-file');
  await expect(cards).toHaveCount(3);
  // The relative link and this root's absolute link both read the note here.
  await expect(cards.filter({ hasText: '# Outline at the new root' })).toHaveCount(2);
  // A path outside the current project is shown unavailable and never read.
  await expect(cards.filter({ hasText: 'File unavailable' })).toHaveCount(1);
  const staleReads = (await mockState.getInvokeCalls())
    .filter((call) => call.command === 'read_file' && JSON.stringify(call.args ?? {}).includes(MOCK_PROJECT_DIR));
  expect(staleReads).toEqual([]);
  // Opening migrates this project's absolute link to relative; the old
  // device's path is kept verbatim, never reinterpreted.
  await expect.poll(async () => linkedFiles(await mockState.getFileContent(`${RELOCATED}/board.canvas`))).toEqual([
    'Notes/outline.md',
    `${MOCK_PROJECT_DIR}/Notes/outline.md`,
    'Notes/outline.md',
  ]);
});
