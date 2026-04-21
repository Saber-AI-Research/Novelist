import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/app-fixture';

async function enterProject(app: Page) {
  // MOCK_RECENT_PROJECTS[0] is always seeded; clicking it opens the project
  // and leaves us past the Welcome screen so the right-side toggle column
  // with the AI Talk / AI Agent buttons is visible.
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
      if (k.startsWith('novelist:ai-talk:') || k.startsWith('novelist:ai-agent:')) {
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
    await firstTab.locator('[data-testid^="ai-talk-session-tab-close-"]').click();
    await expect(tabs).toHaveCount(1);

    // Delete the remaining one — the component auto-creates a fresh session
    const last = tabs.first();
    await last.hover();
    await last.locator('[data-testid^="ai-talk-session-tab-close-"]').click();
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
    expect(stored?.sessions?.[0]?.presetId).toBe('builtin:editor');
  });
});

test.describe('AI Talk — save chat', () => {
  test('save button is disabled when no messages exist', async ({ app }) => {
    await clearAiTalkStorage(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-talk').click();
    await expect(app.getByTestId('ai-talk-save')).toBeDisabled();
  });

  test('save writes a markdown file under .novelist/chats/', async ({ app, mockState }) => {
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

    await app.getByTestId('panel-toggle-ai-talk').click();
    await app.getByTestId('ai-talk-input').fill('Hi there');
    await app.getByTestId('ai-talk-send').click();

    await app.evaluate(() => {
      const mock = (window as any).__TAURI_MOCK_STATE__;
      mock.emitAiChunk('mock-stream-1', 'Reply text');
      mock.emitAiDone('mock-stream-1');
    });

    // Wait for stream completion before hitting save
    await expect(app.getByTestId('ai-talk-msg-assistant')).toContainText('Reply text');

    await app.getByTestId('ai-talk-save').click();
    await expect(app.getByTestId('ai-talk-save-status')).toContainText(/Saved|保存/i);

    const created = await mockState.getCreatedFiles();
    const chat = created.find((p) => p.includes('/.novelist/chats/') && p.endsWith('.md'));
    expect(chat).toBeTruthy();
  });
});

test.describe('AI Agent — sessions', () => {
  test('tab bar renders in the Agent panel', async ({ app }) => {
    await clearAiTalkStorage(app);
    await app.evaluate(() => {
      (window as any).__TAURI_MOCK_STATE__.setClaudeCliDetectResult({
        path: '/opt/homebrew/bin/claude',
        version: '1.0.0',
      });
    });
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    await expect(app.getByTestId('ai-agent-session-tabs')).toBeVisible();
    await expect(app.locator('[data-testid^="ai-agent-session-tab-"]')).toHaveCount(1);
  });

  test('clicking + on agent tabs creates a second session', async ({ app }) => {
    await clearAiTalkStorage(app);
    await app.evaluate(() => {
      (window as any).__TAURI_MOCK_STATE__.setClaudeCliDetectResult({
        path: '/opt/homebrew/bin/claude',
        version: '1.0.0',
      });
    });
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    await app.getByTestId('ai-agent-session-new').click();
    await expect(app.locator('[data-testid^="ai-agent-session-tab-"]')).toHaveCount(2);
  });

  test('save button is disabled when there are no turns yet', async ({ app }) => {
    await clearAiTalkStorage(app);
    await app.evaluate(() => {
      (window as any).__TAURI_MOCK_STATE__.setClaudeCliDetectResult({
        path: '/opt/homebrew/bin/claude',
        version: '1.0.0',
      });
    });
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    await expect(app.getByTestId('ai-agent-save')).toBeDisabled();
  });
});

test.describe('AI Agent panel', () => {
  test('empty state shows install link when Claude CLI is not detected', async ({ app }) => {
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const panel = app.getByTestId('ai-agent-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Claude Code CLI not found');
    await expect(panel.locator('a[href*="docs.claude.com"]')).toBeVisible();
  });

  test('composer renders when CLI is detected', async ({ app }) => {
    await app.evaluate(() => {
      (window as any).__TAURI_MOCK_STATE__.setClaudeCliDetectResult({
        path: '/opt/homebrew/bin/claude',
        version: '1.0.0',
      });
    });
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const panel = app.getByTestId('ai-agent-panel');
    await expect(panel).toBeVisible();
    await expect(panel).not.toContainText('Claude Code CLI not found');
    await expect(panel.locator('textarea')).toBeVisible();
  });
});

test.describe('Settings → Plugin settings nav', () => {
  test('AI Talk + AI Agent appear as dedicated sections in left nav', async ({ app }) => {
    await app.keyboard.press('Meta+,');
    await expect(app.getByTestId('settings-dialog')).toBeVisible();
    await expect(app.getByTestId('settings-section-plugin:ai-talk')).toBeVisible();
    await expect(app.getByTestId('settings-section-plugin:ai-agent')).toBeVisible();
  });

  test('clicking plugin section loads the settings component inline', async ({ app }) => {
    await app.keyboard.press('Meta+,');
    await app.getByTestId('settings-section-plugin:ai-talk').click();

    await expect(app.getByTestId('ai-talk-preset-openai')).toBeVisible();
    await expect(app.getByTestId('ai-talk-preset-anthropic')).toBeVisible();
  });

  test('Configure button from Plugins list navigates to plugin settings section', async ({ app }) => {
    await app.keyboard.press('Meta+,');
    await app.getByTestId('settings-section-plugins').click();

    await expect(app.getByTestId('plugin-configure-ai-talk')).toBeVisible();
    await app.getByTestId('plugin-configure-ai-talk').click();

    // Dialog should still be open and the preset chips (part of AiTalkSettings)
    // should now be rendered in the right content pane.
    await expect(app.getByTestId('settings-dialog')).toBeVisible();
    await expect(app.getByTestId('ai-talk-preset-openai')).toBeVisible();
  });

  test('AI Agent settings lists the detected CLI status', async ({ app }) => {
    await app.evaluate(() => {
      (window as any).__TAURI_MOCK_STATE__.setClaudeCliDetectResult({
        path: '/usr/local/bin/claude',
        version: '2.1.0',
      });
    });
    await app.keyboard.press('Meta+,');
    await app.getByTestId('settings-section-plugin:ai-agent').click();

    await expect(app.getByTestId('settings-dialog')).toContainText('/usr/local/bin/claude');
  });

  test('applying an AI Talk preset updates baseUrl + model', async ({ app }) => {
    await app.keyboard.press('Meta+,');
    await app.getByTestId('settings-section-plugin:ai-talk').click();
    await app.getByTestId('ai-talk-preset-anthropic').click();

    const baseUrlInput = app.locator('input[type="text"]').first();
    await expect(baseUrlInput).toHaveValue('https://api.anthropic.com/v1');
  });
});
