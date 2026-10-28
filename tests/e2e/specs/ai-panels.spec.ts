import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/app-fixture';

async function enterProject(app: Page) {
  // MOCK_RECENT_PROJECTS[0] is always seeded; clicking it opens the project
  // and leaves us past the Welcome screen so the right-side toggle column
  // with the AI Talk button is visible.
  const recent = app.getByTestId('recent-project-0');
  await expect(recent).toBeVisible({ timeout: 5000 });
  await recent.click();
  await app.getByTestId('app-layout').waitFor({ state: 'visible', timeout: 5000 });
}

async function clearAiTalkStorage(app: Page) {
  // Wipe session + preset persistence so each test starts with the default
  // "one empty chat" state regardless of what a previous test left behind.
  await app.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('novelist:ai-talk:')) {
        localStorage.removeItem(k);
      }
    }
  });
  await app.reload();
  await app.waitForSelector('#app > *');
}

test.describe('AI Talk panel', () => {
  test('toggle button appears and opens the panel', async ({ app }) => {
    await enterProject(app);
    const toggle = app.getByTestId('panel-toggle-ai-talk');
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(app.getByTestId('ai-talk-panel')).toBeVisible();
  });

  test('send button is disabled with empty input, enabled with text', async ({ app }) => {
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-talk').click();
    const input = app.getByTestId('ai-talk-input');
    const send = app.getByTestId('ai-talk-send');
    await expect(send).toBeDisabled();
    await input.fill('hello there');
    await expect(send).toBeEnabled();
  });

  test('send triggers a streamed response when API key is set', async ({ app }) => {
    await app.evaluate(() => {
      localStorage.setItem(
        'novelist:ai-talk:settings:v1',
        JSON.stringify({
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          model: 'gpt-4o-mini',
          temperature: 0.7,
          systemPrompt: '',
          includeCurrentFile: false,
          includeSelection: false,
        }),
      );
    });
    await app.reload();
    await app.waitForSelector('#app > *');
    await enterProject(app);

    await app.getByTestId('panel-toggle-ai-talk').click();
    await app.getByTestId('ai-talk-input').fill('hi');
    await app.getByTestId('ai-talk-send').click();

    await app.evaluate(() => {
      const mock = (window as any).__TAURI_MOCK_STATE__;
      mock.emitAiChunk('mock-stream-1', 'Hello ');
      mock.emitAiChunk('mock-stream-1', 'world!');
      mock.emitAiDone('mock-stream-1');
    });

    const assistant = app.getByTestId('ai-talk-msg-assistant');
    await expect(assistant).toContainText('Hello world!');
  });
});

test.describe('AI Talk — sessions', () => {
  test('tab bar renders with one default session', async ({ app }) => {
    await clearAiTalkStorage(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-talk').click();

    const tabs = app.getByTestId('ai-talk-session-tabs');
    await expect(tabs).toBeVisible();
    // ensureOne() in onMount → always at least one tab
    await expect(tabs.locator('[data-testid^="ai-talk-session-tab-"]')).toHaveCount(1);
  });

  test('clicking + creates a new session tab and activates it', async ({ app }) => {
    await clearAiTalkStorage(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-talk').click();

    await app.getByTestId('ai-talk-session-new').click();
    const tabs = app.locator('[data-testid^="ai-talk-session-tab-"]');
    await expect(tabs).toHaveCount(2);
  });

  test('× deletes a session; panel keeps at least one tab', async ({ app }) => {
    await clearAiTalkStorage(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-talk').click();

    await app.getByTestId('ai-talk-session-new').click();
    const tabs = app.locator('[data-testid^="ai-talk-session-tab-"]');
    await expect(tabs).toHaveCount(2);

    // Delete one — hover the tab to reveal the × button
    const firstTab = tabs.first();
    await firstTab.hover();
    await firstTab.locator('[data-testid^="ai-talk-session-close-"]').click();
    await expect(tabs).toHaveCount(1);

    // Delete the remaining one — the component auto-creates a fresh session
    const last = tabs.first();
    await last.hover();
    await last.locator('[data-testid^="ai-talk-session-close-"]').click();
    await expect(tabs).toHaveCount(1);
  });

  test('preset picker lists built-in presets', async ({ app }) => {
    await clearAiTalkStorage(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-talk').click();

    const picker = app.getByTestId('ai-talk-preset-picker');
    await expect(picker).toBeVisible();
    const values = await picker.locator('option').evaluateAll((opts) =>
      (opts as HTMLOptionElement[]).map((o) => o.value),
    );
    expect(values).toContain('none');
    expect(values).toContain('builtin:default');
    expect(values).toContain('builtin:editor');
  });

  test('selecting a preset persists to the active session', async ({ app }) => {
    await clearAiTalkStorage(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-talk').click();

    await app.getByTestId('ai-talk-preset-picker').selectOption('builtin:editor');
    const stored = await app.evaluate(() =>
      JSON.parse(localStorage.getItem('novelist:ai-talk:sessions:v1') || 'null'),
    );
    // localStorage key holds a plain array of sessions (see sessions.svelte.ts).
    expect(stored?.[0]?.presetId).toBe('builtin:editor');
  });
});

test.describe('AI Talk — save chat', () => {
  test('save button is disabled when no messages exist', async ({ app }) => {
    await clearAiTalkStorage(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-talk').click();
    await expect(app.getByTestId('ai-talk-save')).toBeDisabled();
  });

  test('save creates fresh chat storage, preserves CJK, and collision-bumps through save_ai_chat', async ({ app, mockState }) => {
    await app.clock.setFixedTime(new Date('2026-07-17T12:34:56.000Z'));
    await app.evaluate(() => {
      localStorage.setItem(
        'novelist:ai-talk:settings:v1',
        JSON.stringify({
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          model: 'gpt-4o-mini',
          temperature: 0.7,
          systemPrompt: '',
          includeCurrentFile: false,
          includeSelection: false,
        }),
      );
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('novelist:ai-talk:sessions') || k.startsWith('novelist:ai-talk:prompt-presets')) {
          localStorage.removeItem(k);
        }
      }
    });
    await app.reload();
    await app.waitForSelector('#app > *');
    await enterProject(app);
    expect((await mockState.getFiles()).some((file) => file.path.includes('/.novelist/chats'))).toBe(false);

    await app.getByTestId('panel-toggle-ai-talk').click();
    await app.getByTestId('ai-talk-input').fill('你好，保存原文。');
    await app.getByTestId('ai-talk-send').click();

    await app.evaluate(() => {
      const mock = (window as any).__TAURI_MOCK_STATE__;
      mock.emitAiChunk('mock-stream-1', '回复正文。');
      mock.emitAiDone('mock-stream-1');
    });

    await expect(app.getByTestId('ai-talk-msg-assistant')).toContainText('回复正文。');

    await app.getByTestId('ai-talk-save').click();
    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'save_ai_chat').length).toBe(1);
    const firstCall = (await mockState.getInvokeCalls()).find((call) => call.command === 'save_ai_chat');
    expect(firstCall).toBeTruthy();
    const firstFilename = String(firstCall?.args.filename);
    const body = [
      '# 你好，保存原文。',
      '',
      '_Exported from AI Talk · 2026-07-17T12:34:56.000Z_',
      '',
      '## You',
      '',
      '你好，保存原文。',
      '',
      '## Assistant',
      '',
      '回复正文。',
      '',
    ].join('\n');
    expect(firstCall?.args).toEqual({
      projectDir: '/tmp/novelist-test-project',
      filename: firstFilename,
      body,
    });
    await expect(app.getByTestId('ai-talk-save-status'))
      .toContainText(`Saved · .novelist/chats/${firstFilename}`);

    await app.getByTestId('ai-talk-save').click();
    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'save_ai_chat').length).toBe(2);
    const stem = firstFilename.slice(0, -3);
    const resolvedNames = Object.keys(await mockState.getWrittenFiles())
      .filter((path) => path.includes('/.novelist/chats/'))
      .map((path) => path.split('/').at(-1))
      .sort();
    expect(resolvedNames).toEqual([`${stem} 2.md`, firstFilename].sort());
    await expect(app.getByTestId('ai-talk-save-status'))
      .toContainText(`Saved · .novelist/chats/${stem} 2.md`);

    const written = await mockState.getWrittenFiles();
    expect(written[`/tmp/novelist-test-project/.novelist/chats/${firstFilename}`]).toBe(body);
    expect(written[`/tmp/novelist-test-project/.novelist/chats/${stem} 2.md`]).toBe(body);
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'create_file_with_body')).toHaveLength(0);
  });

  test('generic create_file_with_body rejects an absent parent', async ({ app }) => {
    const rejection = app.evaluate(async () => {
      const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
      if (typeof internals !== 'object' || internals === null) throw new Error('Tauri internals unavailable');
      const invoke: unknown = Reflect.get(internals, 'invoke');
      if (typeof invoke !== 'function') throw new Error('Tauri invoke unavailable');
      await invoke.call(internals, 'create_file_with_body', {
        dir: '/tmp/novelist-test-project/missing-parent',
        filename: 'should-fail.md',
        body: '正文',
      });
    });

    await expect(rejection).rejects.toThrow('parent directory does not exist');
  });
});

test.describe('Settings → Plugin settings nav', () => {
  test('AI Talk appears as a dedicated section in left nav', async ({ app }) => {
    await app.keyboard.press('Meta+,');
    await expect(app.getByTestId('settings-dialog')).toBeVisible();
    await expect(app.getByTestId('settings-section-plugin:ai-talk')).toBeVisible();
  });

  test('clicking plugin section loads the settings component inline', async ({ app }) => {
    await app.keyboard.press('Meta+,');
    await app.getByTestId('settings-section-plugin:ai-talk').click();

    await expect(app.getByTestId('ai-talk-profile-openai')).toBeVisible();
    await expect(app.getByTestId('ai-talk-profile-anthropic')).toBeVisible();
  });

  test('Configure button from Plugins list navigates to plugin settings section', async ({ app }) => {
    await app.keyboard.press('Meta+,');
    await app.getByTestId('settings-section-plugins').click();

    await expect(app.getByTestId('plugin-configure-ai-talk')).toBeVisible();
    await app.getByTestId('plugin-configure-ai-talk').click();

    // Dialog should still be open and the provider chips (part of AiTalkSettings)
    // should now be rendered in the right content pane.
    await expect(app.getByTestId('settings-dialog')).toBeVisible();
    await expect(app.getByTestId('ai-talk-profile-openai')).toBeVisible();
  });

  test('selecting an AI Talk provider updates baseUrl + model', async ({ app }) => {
    await app.keyboard.press('Meta+,');
    await app.getByTestId('settings-section-plugin:ai-talk').click();
    await app.getByTestId('ai-talk-profile-anthropic').click();

    const baseUrlInput = app.locator('input[type="text"]').first();
    await expect(baseUrlInput).toHaveValue('https://api.anthropic.com/v1');
  });
});
