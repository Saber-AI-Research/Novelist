import type { Page, TestInfo } from '@playwright/test';
import { expect } from './app-fixture';

/** Same visible deletion/persistence contract on desktop, iOS and Android. */
export async function verifyAiTalkProfileDeletion(app: Page, mobile: boolean, testInfo: TestInfo) {
  const activate = (id: string) => mobile ? app.getByTestId(id).tap() : app.getByTestId(id).click();
  async function openSettings() {
    await app.getByTestId(mobile ? 'library-project-0' : 'recent-project-0').click();
    await expect(app.getByTestId('app-layout')).toBeVisible();
    if (mobile) await app.getByTestId('mobile-settings').click();
    else await app.keyboard.press('Meta+,');
    await app.getByTestId('settings-section-plugin:ai-talk').click();
  }
  await openSettings();
  // Editing and duplicating must keep each connection independent. A newly
  // selected profile must never inherit the previous profile's revealed key.
  await app.getByTestId('ai-talk-api-key').fill('sk-deletion-fixture');
  await activate('ai-talk-key-visibility');
  await expect(app.getByTestId('ai-talk-api-key')).toHaveAttribute('type', 'text');
  await activate('ai-talk-profile-duplicate');
  await expect(app.getByTestId('ai-talk-api-key')).toHaveAttribute('type', 'password');
  await expect(app.getByTestId('ai-talk-api-key')).toHaveValue('sk-deletion-fixture');
  await app.getByTestId('ai-talk-api-key').fill('sk-copy-fixture');
  await activate('ai-talk-profile-delete');
  await activate('ai-talk-profile-delete-confirm');
  await expect(app.getByTestId('ai-talk-api-key')).toHaveValue('sk-deletion-fixture');
  await activate('ai-talk-profile-delete');
  // A cancelled deletion must keep the connection and its key.
  await app.getByRole('group').filter({ has: app.getByTestId('ai-talk-profile-delete-confirm') })
    .getByRole('button', { name: /Cancel|取消/ }).click();
  await expect(app.getByTestId('ai-talk-api-key')).toHaveValue('sk-deletion-fixture');
  for (const id of ['openai', 'anthropic', 'deepseek', 'ollama']) {
    await activate(`ai-talk-profile-${id}`);
    await activate('ai-talk-profile-delete');
    await activate('ai-talk-profile-delete-confirm');
    await expect(app.getByTestId(`ai-talk-profile-${id}`)).toHaveCount(0);
  }
  await expect(app.getByTestId('ai-talk-no-profiles')).toBeVisible();
  expect(await app.evaluate(() => localStorage.getItem('novelist:ai-talk:settings:v1'))).not.toContain('sk-deletion-fixture');
  await app.reload();
  await openSettings();
  await expect(app.getByTestId('ai-talk-no-profiles')).toBeVisible();
  await activate('ai-talk-profile-add');
  await activate('ai-talk-template-openai');
  await expect(app.getByTestId('ai-talk-api-key')).toHaveValue('');
  await expect(app.getByTestId('ai-talk-base-url')).toHaveValue('https://api.openai.com/v1');
  await app.getByTestId('ai-talk-profile-name').fill('写作连接');
  await app.getByTestId('ai-talk-profile-name').press('Tab');
  await expect(app.getByTestId('ai-talk-profile-openai')).toHaveText('写作连接');
  // Check the actual controls in the scrolled Settings pane; document width
  // alone misses overflow hidden by the dialog's scroll container.
  const bounds = await app.getByTestId('ai-talk-settings').evaluate((root) => {
    const outer = root.getBoundingClientRect();
    return Array.from(root.querySelectorAll('input, textarea, button')).map((control) => {
      const rect = control.getBoundingClientRect();
      return { left: rect.left - outer.left, right: rect.right - outer.right, height: rect.height };
    });
  });
  expect(bounds.every((r) => r.left >= -1 && r.right <= 1)).toBe(true);
  if (mobile) expect(bounds.every((r) => r.height >= 44)).toBe(true);
  await app.getByTestId('ai-talk-profile-name').scrollIntoViewIfNeeded();
  const settingsShot = testInfo.outputPath('ai-talk-settings.png');
  await app.screenshot({ path: settingsShot });
  await testInfo.attach('ai-talk-settings', { path: settingsShot, contentType: 'image/png' });
  await activate('ai-talk-profile-delete');
  await app.getByTestId('ai-talk-profile-delete-confirm').scrollIntoViewIfNeeded();
  const deleteShot = testInfo.outputPath('ai-talk-delete-confirmation.png');
  await app.screenshot({ path: deleteShot });
  await testInfo.attach('ai-talk-delete-confirmation', { path: deleteShot, contentType: 'image/png' });
}
