import { test, expect, openRecentProject } from '../fixtures/app-fixture';

test.describe('Mindmap overlay', () => {
  test.beforeEach(async ({ app }) => {
    await openRecentProject(app);
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });

    // Replace doc with a deterministic multi-level heading tree so level
    // buttons have something meaningful to fold.
    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      const doc =
        '# Book\n' +
        '## Part 1\n' +
        '### Chapter 1\n' +
        '#### Scene 1\n' +
        '### Chapter 2\n' +
        '## Part 2\n';
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
    });
  });

  async function openOverlay(app: import('@playwright/test').Page, appKeys: { press: (k: string, opts?: object) => Promise<void> }) {
    await appKeys.press('m', { metaKey: true, shiftKey: true });
    await app.getByTestId('mindmap-overlay').waitFor({ state: 'visible', timeout: 5000 });
  }

  test('opens with Cmd+Shift+M and closes with Esc', async ({ app, appKeys }) => {
    await openOverlay(app, appKeys);
    await expect(app.getByTestId('mindmap-overlay')).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(app.getByTestId('mindmap-overlay')).toBeHidden();
  });

  test('close button dismisses the overlay', async ({ app, appKeys }) => {
    await openOverlay(app, appKeys);
    await app.getByTestId('mindmap-close').click();
    await expect(app.getByTestId('mindmap-overlay')).toBeHidden();
  });

  test('level buttons toggle the active state', async ({ app, appKeys }) => {
    await openOverlay(app, appKeys);
    const lvl1 = app.getByTestId('mindmap-level-1');
    const lvl2 = app.getByTestId('mindmap-level-2');
    const lvlAll = app.getByTestId('mindmap-level-∞');
    await expect(lvlAll).toHaveClass(/active/);
    await lvl1.click();
    await expect(lvl1).toHaveClass(/active/);
    await expect(lvlAll).not.toHaveClass(/active/);
    await lvl2.click();
    await expect(lvl2).toHaveClass(/active/);
    await expect(lvl1).not.toHaveClass(/active/);
  });

  test('fit and reset buttons stay interactive', async ({ app, appKeys }) => {
    await openOverlay(app, appKeys);
    await app.getByTestId('mindmap-fit').click();
    await app.getByTestId('mindmap-reset').click();
    // Overlay still visible — buttons didn't dismiss or crash the view.
    await expect(app.getByTestId('mindmap-overlay')).toBeVisible();
  });

  test('minimap toggle hides and reshows the minimap', async ({ app, appKeys }) => {
    await openOverlay(app, appKeys);
    const toggle = app.getByTestId('mindmap-minimap-toggle');
    const minimap = app.locator('.overlay div.minimap');
    await expect(minimap).toBeVisible();
    await toggle.click();
    await expect(minimap).toBeHidden();
    await toggle.click();
    await expect(minimap).toBeVisible();
  });

  test('switching fold levels without errors leaves the overlay responsive', async ({ app, appKeys }) => {
    // Fold-correctness is covered by the applyFoldLevel unit tests; this spec
    // only guarantees the UI survives rapid level switching and re-renders.
    await openOverlay(app, appKeys);
    for (const level of ['1', '2', '3', '∞']) {
      await app.getByTestId(`mindmap-level-${level}`).click();
      await expect(app.getByTestId(`mindmap-level-${level}`)).toHaveClass(/active/);
    }
    await expect(app.getByTestId('mindmap-overlay')).toBeVisible();
    // The markmap svg stays in the DOM across re-renders.
    expect(await app.locator('.overlay > .frame > .content > svg').count()).toBe(1);
  });
});
