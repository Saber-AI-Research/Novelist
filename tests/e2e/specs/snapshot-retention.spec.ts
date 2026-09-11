import { test, expect } from '../fixtures/app-fixture';

// Retention/data integrity is exercised against the real Rust service. This
// browser regression owns the panel's duplicate-submit and IME boundary.
test('[regression] snapshot panel submits once while pending and leaves IME Enter alone', async ({ app }) => {
  const recent = app.getByTestId('recent-project-0');
  if (await recent.isVisible()) await recent.click();
  await app.getByTestId('sidebar-file-Chapter 1.md').click();
  await app.getByRole('button', { name: 'SNAPS', exact: true }).click();
  const input = app.getByPlaceholder('Snapshot name...');
  await input.fill('中文快照');
  await app.evaluate(() => {
    const internals = Reflect.get(window, '__TAURI_INTERNALS__') as {
      invoke(command: string, args?: unknown): Promise<unknown>;
    };
    const invoke = internals.invoke.bind(internals);
    const state = { calls: 0, release: () => {} };
    Reflect.set(window, '__snapshotSubmitTest', state);
    internals.invoke = async (command, args) => {
      if (command === 'create_snapshot') {
        state.calls++;
        await new Promise<void>(resolve => { state.release = resolve; });
      }
      return invoke(command, args);
    };
  });
  await input.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', isComposing: true, bubbles: true, cancelable: true,
  })));
  expect(await app.evaluate(() => Reflect.get(window, '__snapshotSubmitTest').calls)).toBe(0);
  await input.press('Enter');
  await expect(input).toBeDisabled();
  await input.evaluate(el => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  expect(await app.evaluate(() => Reflect.get(window, '__snapshotSubmitTest').calls)).toBe(1);
  await app.evaluate(() => Reflect.get(window, '__snapshotSubmitTest').release());
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('');
  await expect(app.getByText('中文快照', { exact: true })).toHaveCount(1);
});
