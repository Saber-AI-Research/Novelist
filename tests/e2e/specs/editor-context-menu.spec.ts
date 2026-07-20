import { test, expect } from '../fixtures/app-fixture';
import type { Page } from '@playwright/test';
import { MOCK_FILE_CONTENTS, MOCK_PROJECT_DIR } from '../fixtures/mock-data';

async function waitForActiveEditor(app: Page, filePath: string) {
  await expect.poll(() => app.evaluate((expectedPath) => {
    const editor = (window as any).__test_api__?.getActiveEditor?.();
    if (!editor || !editor.view.dom.isConnected) return null;
    return editor.filePath === expectedPath ? editor.view.state.doc.toString() : null;
  }, filePath)).toBe(MOCK_FILE_CONTENTS[filePath]);
}

/**
 * Right-clicking inside the editor (.cm-content) should open a styled
 * custom menu that matches the app theme instead of the native WKWebView
 * "Reload / Inspect Element" menu or the OS text menu.
 *
 * Menu items depend on whether there is a selection:
 *   - no selection  → Paste, Select All
 *   - has selection → Cut, Copy, Copy as Rich / Plain Text, Paste, Select All
 */
test.describe('Editor context menu', () => {
  test.beforeEach(async ({ app }) => {
    const recentItem = app.getByTestId('recent-project-0');
    await expect(recentItem).toBeVisible();
    await recentItem.click();
    await expect(app.getByTestId('sidebar')).toBeVisible();
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await waitForActiveEditor(app, `${MOCK_PROJECT_DIR}/Chapter 1.md`);
  });

  test('active editor readiness follows a blocked selected-file lifecycle @task23', async ({ app, mockState }) => {
    const chapter1 = `${MOCK_PROJECT_DIR}/Chapter 1.md`;
    const chapter2 = `${MOCK_PROJECT_DIR}/Chapter 2.md`;
    await mockState.setReadFileBlocked(chapter2, true);

    try {
      await app.getByTestId('sidebar-file-Chapter 2.md').click();
      await expect.poll(async () => (await mockState.getInvokeCalls()).some(
        call => call.command === 'read_file' && call.args.path === chapter2,
      )).toBe(true);

      await expect(app.locator('.cm-editor')).toBeVisible();
      expect(await app.evaluate(() => {
        const editor = (window as any).__test_api__?.getActiveEditor?.();
        return editor?.filePath ?? null;
      })).toBe(chapter1);

      await mockState.releaseNextBlockedRead();
      await waitForActiveEditor(app, chapter2);
    } finally {
      await mockState.setReadFileBlocked(chapter2, false);
    }
  });

  test('right-click with no selection shows paste + select-all only', async ({ app }) => {
    // Make sure there is no selection.
    await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      view.dispatch({ selection: { anchor: 0, head: 0 } });
    });

    await app.locator('.cm-content').click({ button: 'right' });

    const menu = app.getByTestId('editor-context-menu');
    await expect(menu).toBeVisible();

    await expect(app.getByTestId('editor-ctx-paste')).toBeVisible();
    await expect(app.getByTestId('editor-ctx-select-all')).toBeVisible();
    // Selection-only items must be hidden.
    await expect(app.getByTestId('editor-ctx-cut')).toHaveCount(0);
    await expect(app.getByTestId('editor-ctx-copy')).toHaveCount(0);

    await app.keyboard.press('Escape');
  });

  test('right-click with a selection adds cut + copy items', async ({ app }) => {
    await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      // Select "Chapter" on the first line.
      view.dispatch({ selection: { anchor: 2, head: 9 } });
    });

    await app.locator('.cm-content').click({ button: 'right' });

    const menu = app.getByTestId('editor-context-menu');
    await expect(menu).toBeVisible();

    await expect(app.getByTestId('editor-ctx-cut')).toBeVisible();
    await expect(app.getByTestId('editor-ctx-copy')).toBeVisible();
    await expect(app.getByTestId('editor-ctx-paste')).toBeVisible();
    await expect(app.getByTestId('editor-ctx-select-all')).toBeVisible();

    await app.keyboard.press('Escape');
  });

  test('Escape closes the menu', async ({ app }) => {
    await app.locator('.cm-content').click({ button: 'right' });
    const menu = app.getByTestId('editor-context-menu');
    await expect(menu).toBeVisible();

    await app.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('clicking outside the menu closes it', async ({ app }) => {
    await app.locator('.cm-content').click({ button: 'right' });
    const menu = app.getByTestId('editor-context-menu');
    await expect(menu).toBeVisible();

    // Click somewhere outside the menu.
    await app.getByTestId('status-word-count').click();
    await expect(menu).toHaveCount(0);
  });

  test('select all via menu selects the whole document', async ({ app }) => {
    await app.locator('.cm-content').click({ button: 'right' });
    await app.getByTestId('editor-ctx-select-all').click();

    const { anchor, head, len } = await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      const sel = view.state.selection.main;
      return { anchor: sel.anchor, head: sel.head, len: view.state.doc.length };
    });
    expect(anchor).toBe(0);
    expect(head).toBe(len);
    expect(len).toBeGreaterThan(0);
  });

  test('cut via menu removes selected text from the document', async ({ app, appKeys, browserErrors, clipboardCapture }) => {
    await clipboardCapture.startDeferred();
    const initial = await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      const doc = '序章\n你好，world\n尾声';
      const selection = { anchor: 3, head: 11 };
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        selection,
      });
      return { doc, selection };
    });

    await app.locator('.cm-content').click({ button: 'right' });
    await app.getByTestId('editor-ctx-cut').click();

    expect(await clipboardCapture.getWrites()).toEqual(['你好，world']);
    expect(await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      const selection = view.state.selection.main;
      return {
        doc: view.state.doc.toString(),
        selection: { anchor: selection.anchor, head: selection.head },
        focused: view.hasFocus,
      };
    })).toEqual({
      doc: '序章\n\n尾声',
      selection: { anchor: 3, head: 3 },
      focused: true,
    });
    await expect(app.locator('.cm-content')).not.toContainText('你好，world');
    await expect(app.getByTestId('editor-context-menu')).toHaveCount(0);

    await clipboardCapture.releaseNext();
    await appKeys.pressMod('z');
    expect(await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      const selection = view.state.selection.main;
      return {
        doc: view.state.doc.toString(),
        selection: { anchor: selection.anchor, head: selection.head },
      };
    })).toEqual(initial);
    await expect(app.locator('.cm-content')).toContainText('你好，world');
    expect(browserErrors).toEqual([]);
  });

  test('cut keeps deletion and undo state when clipboard rejects', async ({ app, appKeys, browserErrors, clipboardCapture }) => {
    await clipboardCapture.startRejected('denied: token=secret');
    const initial = await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      const doc = 'plain 文本 tail';
      const selection = { anchor: 6, head: 8 };
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        selection,
      });
      return { doc, selection };
    });

    await app.locator('.cm-content').click({ button: 'right' });
    await app.getByTestId('editor-ctx-cut').click();
    await app.evaluate(() => Promise.resolve());

    expect(await clipboardCapture.getWrites()).toEqual(['文本']);
    expect(await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      const selection = view.state.selection.main;
      return {
        doc: view.state.doc.toString(),
        selection: { anchor: selection.anchor, head: selection.head },
        focused: view.hasFocus,
      };
    })).toEqual({
      doc: 'plain  tail',
      selection: { anchor: 6, head: 6 },
      focused: true,
    });
    await expect(app.locator('.cm-content')).not.toContainText('文本');
    await expect(app.getByTestId('editor-context-menu')).toHaveCount(0);
    expect(browserErrors).toEqual([]);

    await appKeys.pressMod('z');
    expect(await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      const selection = view.state.selection.main;
      return {
        doc: view.state.doc.toString(),
        selection: { anchor: selection.anchor, head: selection.head },
      };
    })).toEqual(initial);
    await expect(app.locator('.cm-content')).toContainText('文本');
  });

  test('Block Type > Quote restores a three-line CJK selection and remains one-step undoable @task23', async ({ app, appKeys }) => {
    const initial = await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      const doc = '第一章\n第二幕\n终章';
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        selection: { anchor: 0, head: doc.length },
      });
      return {
        doc,
        selection: {
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
        },
      };
    });

    await app.locator('.cm-content').click({ button: 'right' });
    const blockType = app.getByTestId('editor-ctx-block-type');
    await expect(blockType).toBeVisible();
    await blockType.click();

    const submenu = app.getByTestId('editor-ctx-block-submenu');
    await expect(submenu).toBeVisible();
    const submenuBox = await submenu.boundingBox();
    const viewport = app.viewportSize();
    expect(submenuBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(submenuBox!.x).toBeGreaterThanOrEqual(0);
    expect(submenuBox!.y).toBeGreaterThanOrEqual(0);
    expect(submenuBox!.x + submenuBox!.width).toBeLessThanOrEqual(viewport!.width);
    expect(submenuBox!.y + submenuBox!.height).toBeLessThanOrEqual(viewport!.height);
    await app.screenshot({ path: '.sisyphus/evidence/task-15-context-block.png' });

    // Model WKWebView collapsing the live range after right-click. The menu
    // command must restore the captured range before registry execution.
    await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      view.dispatch({ selection: { anchor: 0, head: 0 } });
    });
    await app.getByTestId('editor-ctx-block-quote').click();

    const transformed = await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      return {
        doc: view.state.doc.toString(),
        selection: {
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
        },
      };
    });
    expect(transformed.doc).toBe('> 第一章\n> 第二幕\n> 终章');
    expect(transformed.selection).toEqual({ anchor: 2, head: initial.doc.length + 6 });

    await app.locator('.cm-content').focus();
    await appKeys.pressMod('z');
    const restored = await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      return {
        doc: view.state.doc.toString(),
        selection: {
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
        },
      };
    });
    expect(restored).toEqual(initial);
  });

  test('typing > over selected CJK text converts whole lines and preserves focus @task23', async ({ app, appKeys }) => {
    const doc = '你好\n世界\n终章';
    const initial = await app.evaluate(async (content) => {
      const api = (window as any).__test_api__;
      await api.setActiveEditorDocument(content, { anchor: 0, head: content.length });
      const view = api.getActiveEditor().view;
      return {
        doc: view.state.doc.toString(),
        selection: {
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
        },
      };
    }, doc);
    await expect(app.locator('.cm-content')).toBeFocused();

    await app.keyboard.type('>');

    const transformed = await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      return {
        doc: view.state.doc.toString(),
        selection: {
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
        },
        focused: view.hasFocus,
      };
    });
    expect(transformed).toEqual({
      doc: '> 你好\n> 世界\n> 终章',
      selection: { anchor: 2, head: initial.doc.length + 6 },
      focused: true,
    });

    await appKeys.pressMod('z');
    expect(await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      const selection = view.state.selection.main;
      return {
        doc: view.state.doc.toString(),
        selection: { anchor: selection.anchor, head: selection.head },
      };
    })).toEqual(initial);

    await expect(app.locator('.cm-content')).toBeFocused();
    await app.keyboard.type('>');
    expect(await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      const selection = view.state.selection.main;
      return {
        doc: view.state.doc.toString(),
        selection: { anchor: selection.anchor, head: selection.head },
        focused: view.hasFocus,
      };
    })).toEqual({
      doc: '> 你好\n> 世界\n> 终章',
      selection: { anchor: 2, head: initial.doc.length + 6 },
      focused: true,
    });
    await app.screenshot({ path: '.sisyphus/evidence/task-16-selected-quote.png' });
  });

  test('Tab and Shift+Tab preserve list and task hierarchy selection and focus @task23', async ({ app }) => {
    const initial = await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      const doc = '* 星号项目\n- [x] 已完成\n> 引文';
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        selection: { anchor: 0, head: doc.length },
      });
      view.focus();
      return { doc, selection: { anchor: 0, head: doc.length } };
    });

    await app.keyboard.press('Tab');
    expect(await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      const selection = view.state.selection.main;
      return {
        doc: view.state.doc.toString(),
        selection: { anchor: selection.anchor, head: selection.head },
        focused: view.hasFocus,
      };
    })).toEqual({
      doc: '  * 星号项目\n  - [x] 已完成\n> > 引文',
      selection: { anchor: 2, head: initial.doc.length + 6 },
      focused: true,
    });
    await app.keyboard.press('Shift+Tab');
    expect(await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      const selection = view.state.selection.main;
      return {
        doc: view.state.doc.toString(),
        selection: { anchor: selection.anchor, head: selection.head },
        focused: view.hasFocus,
      };
    })).toEqual({ ...initial, focused: true });

    await app.keyboard.press('Tab');
    expect(await app.evaluate(() => {
      const view = (window as any).__test_api__.getActiveEditor().view;
      const selection = view.state.selection.main;
      return {
        doc: view.state.doc.toString(),
        selection: { anchor: selection.anchor, head: selection.head },
        focused: view.hasFocus,
      };
    })).toEqual({
      doc: '  * 星号项目\n  - [x] 已完成\n> > 引文',
      selection: { anchor: 2, head: initial.doc.length + 6 },
      focused: true,
    });
    await app.screenshot({ path: '.sisyphus/evidence/task-16-tab-hierarchy.png' });
  });

  test('Block Type submenu keyboard navigation returns focus without reopening', async ({ app }) => {
    await app.locator('.cm-content').click({ button: 'right' });
    const trigger = app.getByTestId('editor-ctx-block-type');
    await trigger.focus();
    await app.keyboard.press('ArrowRight');

    const firstItem = app.getByTestId('editor-ctx-block-paragraph');
    await expect(firstItem).toBeFocused();
    await app.keyboard.press('End');
    await expect(app.getByTestId('editor-ctx-block-code-fence')).toBeFocused();

    await app.keyboard.press('ArrowLeft');
    await expect(app.getByTestId('editor-ctx-block-submenu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('native context menu is suppressed on non-editable chrome', async ({ app }) => {
    // Right-clicking outside the editor must NOT show the editor context menu.
    const sidebar = app.getByTestId('sidebar-region');
    await sidebar.click({ button: 'right' });
    await expect(app.getByTestId('editor-context-menu')).toHaveCount(0);
  });
});
