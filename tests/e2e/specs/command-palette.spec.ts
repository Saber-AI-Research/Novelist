import { test, expect } from '../fixtures/app-fixture';

test.describe('Command Palette', () => {
  test.beforeEach(async ({ app }) => {
    const recentItem = app.getByTestId('recent-project-0');
    if (await recentItem.isVisible().catch(() => false)) {
      await recentItem.click();
      await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
    }
  });

  test('Cmd+Shift+P opens command palette', async ({ app }) => {
    await app.keyboard.press('Meta+Shift+p');

    const palette = app.getByTestId('command-palette');
    await expect(palette).toBeVisible({ timeout: 2000 });

    const input = app.getByTestId('palette-input');
    await expect(input).toBeFocused();
  });

  test('typing filters commands', async ({ app }) => {
    await app.keyboard.press('Meta+Shift+p');

    const input = app.getByTestId('palette-input');
    await input.fill('toggle');

    const results = app.locator('[data-testid^="palette-result-"]');
    const count = await results.count();
    expect(count).toBeGreaterThan(0);
  });

  test('Escape closes command palette', async ({ app }) => {
    await app.keyboard.press('Meta+Shift+p');
    const palette = app.getByTestId('command-palette');
    await expect(palette).toBeVisible();

    await app.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();
  });

  test('"Switch Project" command opens the sidebar switcher popup', async ({ app }) => {
    // Popup should be closed initially.
    await expect(app.getByTestId('project-switcher')).toHaveCount(0);

    await app.keyboard.press('Meta+Shift+p');
    const input = app.getByTestId('palette-input');
    await input.fill('switch project');

    const firstResult = app.locator('[data-testid="palette-result-0"]');
    await expect(firstResult).toBeVisible();
    await firstResult.click();

    // Popup is now visible with the recent projects.
    const switcher = app.getByTestId('project-switcher');
    await expect(switcher).toBeVisible();
    await expect(switcher).toContainText('Test Novel');
  });

  test('selecting a command executes it', async ({ app }) => {
    // Open a file so we have an editor
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });

    await app.keyboard.press('Meta+Shift+p');
    const input = app.getByTestId('palette-input');
    await input.fill('zen');

    const firstResult = app.locator('[data-testid="palette-result-0"]');
    if (await firstResult.isVisible()) {
      await firstResult.click();
      await expect(app.getByTestId('zen-mode')).toBeVisible({ timeout: 3000 });
      await app.keyboard.press('Escape');
    }
  });

  test('Convert to Task List matches the context command without duplicate dispatch @task23', async ({ app, appKeys }) => {
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });

    const initial = await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      const doc = '# 第一章\n> 第二幕\n3. 终章';
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
    await app.getByTestId('editor-ctx-block-type').click();
    await app.getByTestId('editor-ctx-block-task-list').click();
    const contextResult = await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      return {
        doc: view.state.doc.toString(),
        selection: {
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
        },
      };
    });

    await app.locator('.cm-content').focus();
    await appKeys.pressMod('z');
    await expect.poll(() => app.evaluate(() => (window as any).__novelist_view.state.doc.toString())).toBe(initial.doc);

    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      const dispatch = view.dispatch.bind(view);
      (window as any).__task15DocDispatches = 0;
      view.dispatch = (...specs: unknown[]) => {
        const before = view.state.doc.toString();
        dispatch(...specs);
        if (view.state.doc.toString() !== before) (window as any).__task15DocDispatches += 1;
      };
    });

    await app.keyboard.press('Meta+Shift+p');
    const input = app.getByTestId('palette-input');
    await input.fill('Convert to Task List');
    const result = app.getByTestId('palette-result-0');
    await expect(result).toContainText('Convert to Task List');
    await app.evaluate(async () => {
      const modulePath = '/app/lib/stores/commands.svelte.ts';
      const { commandRegistry } = await import(/* @vite-ignore */ modulePath);
      const execute = commandRegistry.execute.bind(commandRegistry);
      (window as any).__task15RegistryExecutions = [];
      commandRegistry.execute = (id: string) => {
        (window as any).__task15RegistryExecutions.push(id);
        execute(id);
      };
    });
    await app.screenshot({ path: '.sisyphus/evidence/task-15-palette-parity.png' });
    await result.click();

    const paletteResult = await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      return {
        doc: view.state.doc.toString(),
        selection: {
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
        },
        docDispatches: (window as any).__task15DocDispatches,
        registryExecutions: (window as any).__task15RegistryExecutions,
      };
    });
    expect(paletteResult.doc).toBe('- [ ] 第一章\n- [ ] 第二幕\n- [ ] 终章');
    expect({ doc: paletteResult.doc, selection: paletteResult.selection }).toEqual(contextResult);
    expect(paletteResult.docDispatches).toBe(1);
    expect(paletteResult.registryExecutions).toEqual(['editor-block-task-list']);
  });

  test('Enter dispatches the selected Block Type command through the registry exactly once', async ({ app }) => {
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });
    await app.keyboard.press('Meta+Shift+p');
    const input = app.getByTestId('palette-input');
    await input.fill('Convert to Quote');
    await expect(app.getByTestId('palette-result-0')).toContainText('Convert to Quote');

    await app.evaluate(async () => {
      const modulePath = '/app/lib/stores/commands.svelte.ts';
      const { commandRegistry } = await import(/* @vite-ignore */ modulePath);
      const execute = commandRegistry.execute.bind(commandRegistry);
      (window as any).__task15RegistryExecutions = [];
      commandRegistry.execute = (id: string) => {
        (window as any).__task15RegistryExecutions.push(id);
        execute(id);
      };
    });

    await app.keyboard.press('Enter');
    await expect(app.getByTestId('command-palette')).toHaveCount(0);
    expect(await app.evaluate(() => (window as any).__task15RegistryExecutions)).toEqual([
      'editor-block-quote',
    ]);
  });

});
