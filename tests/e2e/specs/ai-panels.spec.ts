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

async function setClaudeCliDetected(app: Page) {
  await app.evaluate(() => {
    const mockState: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
    if (typeof mockState !== 'object' || mockState === null) {
      throw new Error('Tauri mock state is unavailable');
    }
    const setDetectResult: unknown = Reflect.get(mockState, 'setClaudeCliDetectResult');
    if (typeof setDetectResult !== 'function') {
      throw new Error('Claude CLI mock setter is unavailable');
    }
    setDetectResult.call(mockState, {
      path: '/opt/homebrew/bin/claude',
      version: '1.0.0',
    });
  });
}

async function useCodexProvider(app: Page) {
  await app.evaluate(() => {
    localStorage.setItem('novelist:ai-agent:settings:v1', JSON.stringify({
      providerId: 'codex',
      codexCliPath: '/usr/local/bin/codex',
    }));
  });
  await app.reload();
  await app.waitForSelector('#app > *');
}

async function activeAgentSessionUuid(app: Page): Promise<string> {
  return app.evaluate(() => {
    const sessions = JSON.parse(
      localStorage.getItem('novelist:ai-agent:sessions:v1') || '[]',
    ) as Array<{ sessionUuid?: string }>;
    const sessionUuid = sessions[0]?.sessionUuid;
    if (!sessionUuid) throw new Error('No active AI Agent session UUID');
    return sessionUuid;
  });
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

  test('session menu disables transcript actions when there are no turns yet', async ({ app }) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const trigger = app.getByTestId('ai-agent-session-menu-trigger');
    await trigger.focus();
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('ai-agent-session-menu-save')).toBeDisabled();
    await expect(app.getByTestId('ai-agent-session-menu-fork')).toBeDisabled();
    await expect(app.getByTestId('ai-agent-session-menu-compact')).toBeDisabled();
    await expect(app.getByTestId('ai-agent-session-menu-clear')).toBeDisabled();
  });

  test('keyboard session menu exposes actions, confirms destructive work, and restores focus', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('整理第一章');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: '已整理。' }),
    });
    await expect(panel).toContainText('已整理。');

    const trigger = app.getByTestId('ai-agent-session-menu-trigger');
    await trigger.focus();
    await app.keyboard.press('Enter');
    const menu = app.getByTestId('ai-agent-session-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveCount(6);
    await expect(menu.getByRole('menuitem', { name: 'Rename session' })).toBeFocused();
    await expect(menu.getByRole('menuitem', { name: 'Save transcript' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Fork session' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Compact session' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Clear transcript' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Delete session' })).toBeVisible();

    await app.keyboard.press('Enter');
    const renameInput = app.getByTestId('ai-agent-session-rename-input');
    await expect(renameInput).toBeFocused();
    await renameInput.fill('第一章会话');
    await renameInput.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(renameInput).toBeFocused();
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-testid^="ai-agent-session-tab-"]').first()).toContainText('第一章会话');
    await expect(trigger).toBeFocused();

    await app.keyboard.press('Enter');
    await expect(menu.getByRole('menuitem', { name: 'Rename session' })).toBeFocused();
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('ai-agent-save-status')).toContainText('Saved');
    await expect(trigger).toBeFocused();

    await app.keyboard.press('Enter');
    await expect(menu.getByRole('menuitem', { name: 'Rename session' })).toBeFocused();
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('ArrowDown');
    let compactPromptSeen = false;
    app.once('dialog', async (dialog) => {
      compactPromptSeen = true;
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toContain('Compact session');
      await dialog.dismiss();
    });
    await app.keyboard.press('Enter');
    expect(compactPromptSeen).toBe(true);
    await expect(panel).toContainText('已整理。');
    await expect(trigger).toBeFocused();

    await app.keyboard.press('Enter');
    await expect(menu.getByRole('menuitem', { name: 'Rename session' })).toBeFocused();
    await app.keyboard.press('End');
    await app.keyboard.press('ArrowUp');
    app.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toContain('Clear transcript');
      await dialog.dismiss();
    });
    await app.keyboard.press('Enter');
    await expect(panel).toContainText('已整理。');
    await expect(trigger).toBeFocused();

    await app.keyboard.press('Enter');
    await expect(menu.getByRole('menuitem', { name: 'Rename session' })).toBeFocused();
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('ArrowDown');
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-testid^="ai-agent-session-tab-"]')).toHaveCount(2);
    await expect(trigger).toBeFocused();

    await app.keyboard.press('Enter');
    await expect(menu.getByRole('menuitem', { name: 'Rename session' })).toBeFocused();
    await app.keyboard.press('End');
    app.once('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toContain('Delete session');
      await dialog.accept();
    });
    await app.keyboard.press('Enter');
    await expect(app.locator('[data-testid^="ai-agent-session-tab-"]')).toHaveCount(1);
    await expect(trigger).toBeFocused();
  });

  test('session menu mutations persist only their owned session ids', async ({ app, mockState, browserErrors }) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const panel = app.getByTestId('ai-agent-panel');
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();

    await panel.locator('textarea').fill('会话 A 第一轮');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionAUuid = await activeAgentSessionUuid(app);
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(1);
    await mockState.emitEvent(`claude-stream://${sessionAUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: 'A 第一轮完成' }),
    });
    await expect(panel).toContainText('A 第一轮完成');
    await panel.locator('textarea').fill('会话 A 第二轮');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(2);
    await mockState.emitEvent(`claude-stream://${sessionAUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: 'A 第二轮完成' }),
    });
    await expect(panel).toContainText('A 第二轮完成');
    const sessionAId = await app.evaluate(() => localStorage.getItem('novelist:ai-agent:active-session:v1'));
    expect(sessionAId).toBeTruthy();

    await app.getByTestId('ai-agent-session-new').click();
    await expect(app.locator('[data-testid^="ai-agent-session-tab-"]')).toHaveCount(2);
    await panel.locator('textarea').fill('会话 B');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionBUuid = await activeAgentSessionUuid(app);
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(3);
    await mockState.emitEvent(`claude-stream://${sessionBUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: 'B 完成' }),
    });
    await expect(panel).toContainText('B 完成');
    const sessionBId = await app.evaluate(() => localStorage.getItem('novelist:ai-agent:active-session:v1'));
    expect(sessionBId).toBeTruthy();
    expect(sessionBId).not.toBe(sessionAId);

    const writeIds = async () => (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'write_ai_session')
      .map((call) => call.args.id);

    await mockState.reset();
    await app.getByTestId('ai-agent-session-menu-trigger').click();
    await app.getByTestId('ai-agent-session-menu-rename').click();
    await app.getByTestId('ai-agent-session-rename-input').fill('会话 B 已重命名');
    await app.getByTestId('ai-agent-session-rename-input').press('Enter');
    await expect.poll(writeIds).toEqual([sessionBId]);

    await mockState.reset();
    await app.getByTestId('ai-agent-session-menu-trigger').click();
    await app.getByTestId('ai-agent-session-menu-fork').click();
    await expect(app.locator('[data-testid^="ai-agent-session-tab-"]')).toHaveCount(3);
    const forkId = await app.evaluate(() => localStorage.getItem('novelist:ai-agent:active-session:v1'));
    expect(forkId).toBeTruthy();
    expect(forkId).not.toBe(sessionBId);
    await expect.poll(writeIds).toEqual([forkId]);

    const sessionATab = app.getByTestId(`ai-agent-session-tab-${sessionAId}`);
    await sessionATab.getByRole('button').click();
    await expect(sessionATab).toHaveClass(/\bactive\b/);
    await mockState.reset();
    await app.getByTestId('ai-agent-session-menu-trigger').click();
    app.once('dialog', (dialog) => dialog.accept());
    await app.getByTestId('ai-agent-session-menu-compact').click();
    await expect(panel).toContainText('Session compacted.');
    await expect.poll(writeIds).toEqual([sessionAId]);
    await expect(app.getByTestId('ai-agent-session-menu-trigger')).toBeFocused();

    const sessionBTab = app.getByTestId(`ai-agent-session-tab-${sessionBId}`);
    const sessionBButton = sessionBTab.getByRole('button');
    await sessionBButton.scrollIntoViewIfNeeded();
    await expect(app.getByTestId('ai-agent-session-tabs').locator('.scroll'))
      .not.toHaveClass(/\bis-scrolling\b/);
    await sessionBButton.click();
    await expect(sessionBTab).toHaveClass(/\bactive\b/);
    await mockState.reset();
    await app.getByTestId('ai-agent-session-menu-trigger').click();
    app.once('dialog', (dialog) => dialog.accept());
    await app.getByTestId('ai-agent-session-menu-clear').click();
    await expect(panel).not.toContainText('B 完成');
    await expect.poll(writeIds).toEqual([sessionBId]);

    await mockState.reset();
    await mockState.setAiSessionWriteError('target delete rejected');
    await app.getByTestId('ai-agent-session-menu-trigger').click();
    app.once('dialog', (dialog) => dialog.accept());
    await app.getByTestId('ai-agent-session-menu-delete').click();
    await expect(app.getByTestId('ai-agent-action-error')).toContainText('target delete rejected');
    await expect(app.locator('[data-testid^="ai-agent-session-tab-"]')).toHaveCount(3);
    await expect(app.getByTestId(`ai-agent-session-tab-${sessionBId}`)).toBeVisible();
    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'delete_ai_session')
      .map((call) => call.args.id)).toEqual([sessionBId]);
    expect(await writeIds()).toEqual([]);

    await mockState.setAiSessionWriteError(null);
    await mockState.reset();
    await app.getByTestId('ai-agent-session-menu-trigger').click();
    app.once('dialog', (dialog) => dialog.accept());
    await app.getByTestId('ai-agent-session-menu-delete').click();
    await expect(app.locator('[data-testid^="ai-agent-session-tab-"]')).toHaveCount(2);
    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'delete_ai_session')
      .map((call) => call.args.id)).toEqual([sessionBId]);
    expect(await writeIds()).toEqual([]);
    expect(browserErrors).toEqual([]);
  });

  test('failed session B rename and fork preserve delayed CJK stream deltas in session A @task23 @task23-negative', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const panel = app.getByTestId('ai-agent-panel');
    const pageErrors: Error[] = [];
    app.on('pageerror', (pageError) => pageErrors.push(pageError));

    await panel.locator('textarea').fill('并发会话 A');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionAUuid = await activeAgentSessionUuid(app);
    const sessionAId = await app.evaluate(() => localStorage.getItem('novelist:ai-agent:active-session:v1'));
    expect(sessionAId).toBeTruthy();

    await app.getByTestId('ai-agent-session-new').click();
    await panel.locator('textarea').fill('并发会话 B');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionBUuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${sessionBUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: 'B 可执行操作' }),
    });
    const sessionBId = await app.evaluate(() => localStorage.getItem('novelist:ai-agent:active-session:v1'));
    expect(sessionBId).toBeTruthy();

    const storedSession = (id: string | null) => app.evaluate((sessionId) => {
      const sessions = JSON.parse(localStorage.getItem('novelist:ai-agent:sessions:v1') ?? '[]');
      return sessions.find((session: { id: string }) => session.id === sessionId);
    }, id);
    const rejectedMessage = 'target persistence rejected';
    const trigger = app.getByTestId('ai-agent-session-menu-trigger');
    const actionError = app.getByTestId('ai-agent-action-error');

    await mockState.reset();
    await mockState.setAiSessionWritesBlocked(true);
    await trigger.click();
    await app.getByTestId('ai-agent-session-menu-rename').click();
    await app.getByTestId('ai-agent-session-rename-input').fill('失败的 B 重命名');
    await app.getByTestId('ai-agent-session-rename-input').press('Enter');
    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'write_ai_session').length).toBeGreaterThan(0);
    await mockState.emitEvent(`claude-stream://${sessionAUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '甲并发增量' } },
      }),
    });
    await mockState.setAiSessionWriteError(rejectedMessage);
    await mockState.setAiSessionWritesBlocked(false);
    await expect(actionError).toContainText(rejectedMessage);
    expect(JSON.stringify(await storedSession(sessionAId))).toContain('甲并发增量');
    expect((await mockState.getInvokeCalls())
      .filter((call) => call.command === 'write_ai_session')
      .map((call) => call.args.id)).toEqual([sessionBId]);
    await expect(app.getByTestId(`ai-agent-session-tab-${sessionBId}`)).toContainText('并发会话 B');

    await mockState.reset();
    await mockState.setAiSessionWritesBlocked(true);
    await trigger.click();
    await app.getByTestId('ai-agent-session-menu-fork').click();
    const forkId = await app.evaluate(() => localStorage.getItem('novelist:ai-agent:active-session:v1'));
    expect(forkId).not.toBe(sessionBId);
    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'write_ai_session').length).toBeGreaterThan(0);
    await mockState.emitEvent(`claude-stream://${sessionAUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '乙并发增量' } },
      }),
    });
    await mockState.setAiSessionWritesBlocked(false);
    await expect(actionError).toContainText(rejectedMessage);
    const sessionA = await storedSession(sessionAId);
    expect(JSON.stringify(sessionA)).toContain('甲并发增量乙并发增量');
    expect((await mockState.getInvokeCalls())
      .filter((call) => call.command === 'write_ai_session')
      .map((call) => call.args.id)).toEqual([forkId]);
    await expect(app.locator('[data-testid^="ai-agent-session-tab-"]')).toHaveCount(2);
    expect(await app.evaluate(() => localStorage.getItem('novelist:ai-agent:active-session:v1'))).toBe(sessionBId);
    expect(pageErrors).toEqual([]);
  });

  test('Agent menu save reports collision-bumped basename through save_ai_chat', async ({ app, mockState, browserErrors }) => {
    await app.clock.setFixedTime(new Date('2026-07-17T12:34:56.000Z'));
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    await mockState.reset();
    await mockState.setAiSessionWritesBlocked(true);
    await panel.locator('textarea').fill('保存第一章对话');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'write_ai_session').length).toBeGreaterThan(0);
    expect(await mockState.getClaudeCliSendCount()).toBe(0);
    await mockState.setAiSessionWritesBlocked(false);
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(1);
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: '已保存正文。' }),
    });
    await expect(panel).toContainText('已保存正文。');

    const trigger = app.getByTestId('ai-agent-session-menu-trigger');
    await trigger.click();
    await app.getByTestId('ai-agent-session-menu-save').click();
    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'save_ai_chat').length).toBe(1);
    const firstCall = (await mockState.getInvokeCalls()).find((call) => call.command === 'save_ai_chat');
    expect(firstCall).toBeTruthy();
    const firstFilename = String(firstCall?.args.filename);
    const body = [
      '# 保存第一章对话',
      '',
      '_Exported from AI Agent · 2026-07-17T12:34:56.000Z_',
      '',
      '## You',
      '',
      '保存第一章对话',
      '',
      '## Claude',
      '',
      '已保存正文。',
      '',
    ].join('\n');
    expect(firstCall?.args).toEqual({
      projectDir: '/tmp/novelist-test-project',
      filename: firstFilename,
      body,
    });

    await trigger.click();
    await app.getByTestId('ai-agent-session-menu-save').click();
    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'save_ai_chat').length).toBe(2);
    const stem = firstFilename.slice(0, -3);
    await expect(app.getByTestId('ai-agent-save-status'))
      .toContainText(`Saved · .novelist/chats/${stem} 2.md`);
    const written = await mockState.getWrittenFiles();
    expect(written[`/tmp/novelist-test-project/.novelist/chats/${firstFilename}`]).toBe(body);
    expect(written[`/tmp/novelist-test-project/.novelist/chats/${stem} 2.md`]).toBe(body);
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'create_file_with_body')).toHaveLength(0);
    expect(browserErrors).toEqual([]);
  });

  test('running session disables unsafe menu actions and inline Stop is recoverable', async ({ app }) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('持续生成');
    await panel.getByRole('button', { name: 'Send' }).click();

    const trigger = app.getByTestId('ai-agent-session-menu-trigger');
    await trigger.focus();
    await app.keyboard.press('Enter');
    await expect(app.getByTestId('ai-agent-session-menu-rename')).toBeFocused();
    await expect(app.getByTestId('ai-agent-session-menu-fork')).toBeDisabled();
    await expect(app.getByTestId('ai-agent-session-menu-compact')).toBeDisabled();
    await expect(app.getByTestId('ai-agent-session-menu-clear')).toBeDisabled();
    await expect(app.getByTestId('ai-agent-session-menu-delete')).toBeDisabled();
    await app.keyboard.press('Escape');

    await panel.locator('[data-testid^="ai-agent-turn-stop-"]').click();
    const stopped = panel.locator('[data-testid^="ai-agent-turn-stopped-"]');
    await expect(stopped).toContainText('Stopped');
    await expect(stopped.getByRole('button', { name: 'Retry turn' })).toBeEnabled();
  });

  test('disabled Delete cannot mutate a running session through a synthetic click', async ({ app }) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('不得删除的运行会话');
    await panel.getByRole('button', { name: 'Send' }).click();
    await app.getByTestId('ai-agent-session-menu-trigger').click();
    const deleteItem = app.getByTestId('ai-agent-session-menu-delete');
    await expect(deleteItem).toBeDisabled();

    app.once('dialog', (dialog) => dialog.accept());
    await deleteItem.dispatchEvent('click');

    await expect(panel).toContainText('不得删除的运行会话');
    await expect(panel.locator('[data-testid^="ai-agent-turn-stop-"]')).toBeVisible();
  });

  test('Stop keeps attempt ownership until persistent runtime cancellation drains', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    await mockState.setAiSessionWritesBlocked(true);
    await panel.locator('textarea').fill('等待停止完成');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sendsBeforeStop = await mockState.getClaudeCliSendCount();
    await mockState.setClaudeCliKillBlocked(true);
    await panel.locator('[data-testid^="ai-agent-turn-stop-"]').click();

    await expect(panel.locator('[data-testid^="ai-agent-turn-stop-"]')).toBeVisible();
    await mockState.setAiSessionWritesBlocked(false);
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(sendsBeforeStop);

    await mockState.setClaudeCliKillBlocked(false);
    await expect(panel.locator('[data-testid^="ai-agent-turn-stopped-"]')).toContainText('Stopped');
    await expect(panel.getByRole('button', { name: 'Retry turn' })).toBeEnabled();
  });

  test('delayed Delete never persists destination sessions into the source project', async ({ app, mockState }) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const panel = app.getByTestId('ai-agent-panel');
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();

    await panel.locator('textarea').fill('项目 A 删除来源');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sourceUuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${sourceUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: '项目 A 完成' }),
    });

    await mockState.setAiSessionDeletesBlocked(true);
    await app.getByTestId('ai-agent-session-menu-trigger').click();
    app.once('dialog', (dialog) => dialog.accept());
    await app.getByTestId('ai-agent-session-menu-delete').click();
    await expect(panel).not.toContainText('项目 A 删除来源');
    await expect.poll(async () => Object.keys(await mockState.getWrittenFiles())
      .filter((path) => path.startsWith('/tmp/novelist-test-project/.novelist/ai/sessions/agent-')).length,
    ).toBe(2);

    await app.getByTestId('sidebar-switch-btn').click();
    await app.getByText('Another Story', { exact: true }).click();
    await expect(app.getByTestId('sidebar-switch-btn')).toContainText('another-project');
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    await panel.locator('textarea').fill('项目 B 不得写入 A');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () =>
      Object.values(await mockState.getWrittenFiles()).some((body) => body.includes('项目 B 不得写入 A')),
    ).toBe(true);

    const writesBeforeDeleteCompletes = await mockState.getAiSessionWriteCount();
    await mockState.setAiSessionDeletesBlocked(false);
    await expect.poll(() => mockState.getAiSessionWriteCount()).toBe(writesBeforeDeleteCompletes);
    const sourceBodies = Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.startsWith('/tmp/novelist-test-project/.novelist/ai/sessions/agent-'))
      .map(([, body]) => body);
    expect(sourceBodies.every((body) => !body.includes('项目 B 不得写入 A'))).toBe(true);
  });

  test('clear tears down the old runtime before rotating the session id', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('第一轮');
    await panel.getByRole('button', { name: 'Send' }).click();
    const oldUuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${oldUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: '旧回复' }),
    });

    await app.getByTestId('ai-agent-session-menu-trigger').click();
    app.once('dialog', (dialog) => dialog.accept());
    await app.getByTestId('ai-agent-session-menu-clear').click();
    await expect(panel).not.toContainText('旧回复');

    await panel.locator('textarea').fill('第二轮');
    await panel.getByRole('button', { name: 'Send' }).click();
    const newUuid = await activeAgentSessionUuid(app);
    expect(newUuid).not.toBe(oldUuid);
    await mockState.emitEvent(`claude-stream://${oldUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'STALE_OLD_RUNTIME' } },
      }),
    });
    await expect(panel).not.toContainText('STALE_OLD_RUNTIME');
  });

  test('global new-session command creates exactly one persisted session from a closed panel and focused composer', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const panel = app.getByTestId('ai-agent-panel');
    const tabs = app.locator('[data-testid^="ai-agent-session-tab-"]');
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    await expect(tabs).toHaveCount(1);
    await expect.poll(async () => Object.keys(await mockState.getWrittenFiles())
      .filter((path) => path.startsWith('/tmp/novelist-test-project/.novelist/ai/sessions/agent-')).length).toBe(1);

    await app.getByTestId('panel-toggle-ai-agent').click();
    await expect(panel).toHaveCount(0);
    await app.keyboard.press('Meta+Alt+Shift+n');
    await expect(app.getByTestId('ai-agent-panel')).toBeVisible();
    await expect(tabs).toHaveCount(2);
    await expect.poll(async () => Object.keys(await mockState.getWrittenFiles())
      .filter((path) => path.startsWith('/tmp/novelist-test-project/.novelist/ai/sessions/agent-')).length).toBe(2);

    const composer = app.getByTestId('ai-agent-panel').locator('textarea');
    await composer.focus();
    await app.waitForTimeout(60);
    await app.keyboard.press('Meta+Alt+Shift+n');
    await expect(tabs).toHaveCount(3);
    await expect.poll(async () => Object.keys(await mockState.getWrittenFiles())
      .filter((path) => path.startsWith('/tmp/novelist-test-project/.novelist/ai/sessions/agent-')).length).toBe(3);
  });

  test('global new-session command waits for blocked destination lifecycle before persisting', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    await expect.poll(async () => Object.keys(await mockState.getWrittenFiles())
      .filter((path) => path.startsWith('/tmp/novelist-test-project/.novelist/ai/sessions/agent-')).length).toBe(1);

    await mockState.setClaudeCliKillBlocked(true);
    await app.getByTestId('sidebar-switch-btn').evaluate((button) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await app.getByText('Another Story', { exact: true }).click();
    await expect(app.getByTestId('sidebar-switch-btn')).toContainText('another-project');
    await expect(app.getByTestId('ai-agent-session-new')).toBeDisabled();
    await app.keyboard.press('Meta+Alt+Shift+n');

    const blockedWrites = await mockState.getWrittenFiles();
    expect(Object.keys(blockedWrites).filter((path) =>
      path.startsWith('/tmp/another-project/.novelist/ai/sessions/agent-'),
    )).toHaveLength(0);
    expect(Object.keys(blockedWrites).filter((path) =>
      path.startsWith('/tmp/novelist-test-project/.novelist/ai/sessions/agent-'),
    )).toHaveLength(1);

    await mockState.setClaudeCliKillBlocked(false);
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    await expect(app.locator('[data-testid^="ai-agent-session-tab-"]')).toHaveCount(2);
    await expect.poll(async () => Object.keys(await mockState.getWrittenFiles())
      .filter((path) => path.startsWith('/tmp/another-project/.novelist/ai/sessions/agent-')).length).toBe(2);
    const sourceBodies = Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.startsWith('/tmp/novelist-test-project/.novelist/ai/sessions/agent-'))
      .map(([, body]) => body);
    expect(sourceBodies).toHaveLength(1);
    expect(sourceBodies.every((body) => !body.includes('/tmp/another-project'))).toBe(true);
  });

  test('lazy remount waits for predecessor retirement before flushing one global session request', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    const tabs = app.locator('[data-testid^="ai-agent-session-tab-"]');
    await expect(tabs).toHaveCount(1);
    await expect.poll(async () => Object.keys(await mockState.getWrittenFiles())
      .filter((path) => path.startsWith('/tmp/novelist-test-project/.novelist/ai/sessions/agent-')).length).toBe(1);
    const baselineWrites = await mockState.getAiSessionWriteCount();

    await mockState.setClaudeCliKillBlocked(true);
    await mockState.setAiSessionWritesBlocked(true);
    await app.getByTestId('panel-toggle-ai-agent').click();
    await expect(app.getByTestId('ai-agent-panel')).toHaveCount(0);
    await app.keyboard.press('Meta+Alt+Shift+n');
    await expect(app.getByTestId('ai-agent-panel')).toBeVisible();
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(0);
    await expect(tabs).toHaveCount(1);
    await expect(app.getByTestId('ai-agent-session-new')).toBeDisabled();
    expect(await mockState.getAiSessionWriteCount()).toBe(baselineWrites);

    await mockState.setClaudeCliKillBlocked(false);
    await expect(app.getByTestId('ai-agent-session-new')).toBeDisabled();
    expect(await mockState.getAiSessionWriteCount()).toBe(baselineWrites);

    await mockState.setAiSessionWritesBlocked(false);
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    await expect(tabs).toHaveCount(2);
    await expect.poll(async () => Object.keys(await mockState.getWrittenFiles())
      .filter((path) => path.startsWith('/tmp/novelist-test-project/.novelist/ai/sessions/agent-')).length).toBe(2);

    const killCountAfterRetirement = await mockState.getClaudeCliKillCount();
    await app.getByTestId('ai-agent-panel').locator('textarea').fill('replacement runtime');
    await app.getByTestId('ai-agent-panel').getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(1);
    expect(await mockState.getClaudeCliKillCount()).toBe(killCountAfterRetirement);
  });

  test('Claude kill drain blocks lazy remount and then reuses the same session UUID', async ({ app, mockState, browserErrors }) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const panel = app.getByTestId('ai-agent-panel');
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();

    await panel.locator('textarea').fill('first Claude turn');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => (await mockState.getClaudeCliSpawnUuidHistory()).length).toBe(1);
    const [sessionUuid] = await mockState.getClaudeCliSpawnUuidHistory();
    expect(sessionUuid).toBeTruthy();
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(1);
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: 'First turn complete' }),
    });
    await expect(panel).toContainText('First turn complete');
    await expect(panel.locator('[data-testid^="ai-agent-turn-stop-"]')).toHaveCount(0);

    await mockState.setClaudeCliKillBlocked(true);
    await app.getByTestId('panel-toggle-ai-agent').click();
    await expect(panel).toHaveCount(0);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const replacement = app.getByTestId('ai-agent-panel');
    await expect(replacement).toBeVisible();
    await expect.poll(() => mockState.getClaudeCliKillCount()).toBe(1);
    await expect(app.getByTestId('ai-agent-session-new')).toBeDisabled();
    await expect(app.getByTestId('ai-agent-session-menu-trigger')).toBeDisabled();
    expect(await mockState.getClaudeCliSpawnUuidHistory()).toEqual([sessionUuid]);
    expect(await mockState.getClaudeCliSendCount()).toBe(1);

    await mockState.setClaudeCliKillBlocked(false);
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    expect(await mockState.getClaudeCliSpawnUuidHistory()).toEqual([sessionUuid]);
    expect(await mockState.getClaudeCliSendCount()).toBe(1);

    await replacement.locator('textarea').fill('fresh turn after drain');
    await replacement.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => (await mockState.getClaudeCliSpawnUuidHistory()).length).toBe(2);
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(2);
    expect(await mockState.getClaudeCliSpawnUuidHistory()).toEqual([sessionUuid, sessionUuid]);
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: 'Fresh same-UUID response' }),
    });

    await expect(replacement).toContainText('Fresh same-UUID response');
    await expect(replacement.locator('[data-testid^="ai-agent-turn-error-"]')).toHaveCount(0);
    await expect(replacement.locator('[data-testid^="ai-agent-turn-stopped-"]')).toHaveCount(0);
    await expect(replacement.locator('[data-testid^="ai-agent-turn-stop-"]')).toHaveCount(0);
    await expect(replacement).not.toContainText('interrupted');
    expect(browserErrors).toEqual([]);
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

  test('AI stream mock targets the current window and can simulate a foreign broadcast', async ({ app, mockState }) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('route this response');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);

    await mockState.emitEvent(
      `claude-stream://${sessionUuid}`,
      {
        kind: 'stdout-line',
        data: JSON.stringify({ type: 'result', subtype: 'success', result: 'FOREIGN_STREAM_TEXT' }),
      },
      'novelist-foreign',
    );
    await expect(panel).not.toContainText('FOREIGN_STREAM_TEXT');

    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: 'CURRENT_STREAM_TEXT' }),
    });
    await expect(panel).toContainText('CURRENT_STREAM_TEXT');
  });

  test('Agent displays clean user text while sending attached context', async ({ app }) => {
    await app.evaluate(() => {
      (window as any).__TAURI_MOCK_STATE__.setClaudeCliDetectResult({
        path: '/opt/homebrew/bin/claude',
        version: '1.0.0',
      });
    });
    await enterProject(app);
    await app.getByText('Chapter 1', { exact: true }).click();
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('@current summarize this');
    await panel.getByRole('button', { name: 'Send' }).click();

    await expect(panel).toContainText('summarize this');
    await expect(panel).not.toContainText('## Context 1');
  });

  test('Agent @ picker attaches a project file by search', async ({ app }) => {
    await app.evaluate(() => {
      (window as any).__TAURI_MOCK_STATE__.setClaudeCliDetectResult({
        path: '/opt/homebrew/bin/claude',
        version: '1.0.0',
      });
    });
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('@chap');
    await panel.getByRole('button', { name: /Chapter 1.md/ }).click();

    await expect(panel.getByTestId('ai-context-bar')).toContainText('Chapter 1.md');
  });

  test('Agent renders Apply Changes card from a structured result', async ({ app }) => {
    await app.evaluate(() => {
      (window as any).__TAURI_MOCK_STATE__.setClaudeCliDetectResult({
        path: '/opt/homebrew/bin/claude',
        version: '1.0.0',
      });
    });
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('tighten chapter');
    await panel.getByRole('button', { name: 'Send' }).click();

    const uuid = await app.evaluate(() => {
      const stored = JSON.parse(localStorage.getItem('novelist:ai-agent:sessions:v1') || '[]');
      return stored[0]?.sessionUuid;
    });
    await app.evaluate((sessionId) => {
      const payload = {
        type: 'result',
        subtype: 'success',
        result: [
          'Done.',
          '```novelist-change-set',
          JSON.stringify({
            summary: 'Tighten Chapter 1',
            files: [{
              path: '/tmp/novelist-test-project/Chapter 1.md',
              status: 'modify',
              originalText: '# Chapter 1\\n\\nIt was a dark and stormy night.\\n\\nThe wind howled through the trees.\\n',
              proposedText: '# Chapter 1\\n\\nNight pressed against the windows.\\n\\nThe wind worried the trees.\\n',
            }],
          }),
          '```',
        ].join('\n'),
      };
      (window as any).__TAURI_MOCK_STATE__.emitClaudeStdout(sessionId, JSON.stringify(payload));
    }, uuid);

    await expect(panel.getByTestId('ai-apply-changes-card')).toBeVisible();
    await expect(panel.getByTestId('ai-apply-changes-card')).toContainText('Tighten Chapter 1');
  });

  test('two Agent turns keep independent failures and retry only the selected turn @task23 @task23-negative', async ({ app, mockState }) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    const input = panel.locator('textarea');
    await input.fill('第一轮');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await expect(panel.locator('[data-testid^="ai-agent-turn-stop-"]')).toBeVisible();
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'error',
      message: '第一轮流失败',
    });

    await input.fill('第二轮');
    await panel.getByRole('button', { name: 'Send' }).click();
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', content: '第二轮工具失败', is_error: true }],
        },
      }),
    });
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: '部分完成' }),
    });

    const errors = panel.locator('[data-testid^="ai-agent-turn-error-"]');
    await expect(errors).toHaveCount(2);
    await expect(errors.nth(0)).toContainText('第一轮流失败');
    await expect(errors.nth(1)).toContainText('第二轮工具失败');

    await errors.nth(0).getByRole('button', { name: 'Retry turn' }).click();
    await expect(errors).toHaveCount(1);
    await expect(errors.first()).toContainText('第二轮工具失败');
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'error',
      message: '第一轮重试仍失败',
    });

    await expect(errors).toHaveCount(2);
    await expect(errors.nth(0)).toContainText('第一轮重试仍失败');
    await expect(errors.nth(1)).toContainText('第二轮工具失败');
  });

  test('double Retry behind blocked persistence dispatches one exact attempt', async ({ app, mockState }) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('只重试一次');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'error',
      message: '首次失败',
    });
    await expect(panel.locator('[data-testid^="ai-agent-turn-error-"]')).toBeVisible();
    const sendsBeforeRetry = await mockState.getClaudeCliSendCount();
    await mockState.setAiSessionWritesBlocked(true);

    const retry = panel.getByRole('button', { name: 'Retry turn' });
    await retry.evaluate((button) => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(sendsBeforeRetry);

    await mockState.setAiSessionWritesBlocked(false);
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(sendsBeforeRetry + 1);
  });

  test('Codex delayed exit drains the completed attempt before dispatching the next one', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await useCodexProvider(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    const input = panel.locator('textarea');
    await input.fill('Codex 第一轮');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(1);
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    });

    await input.fill('Codex 第二轮');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(1);

    await mockState.emitEvent(`codex-stream://${sessionUuid}`, { kind: 'exit', code: 0 });
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(2);
    await expect(panel.locator('[data-testid^="ai-agent-turn-error-"]')).toHaveCount(0);
    await expect(panel.locator('[data-testid^="ai-agent-turn-stop-"]')).toBeVisible();
  });

  test('Codex Stop holds ownership until explicit kill drains before Retry', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await useCodexProvider(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('Codex stop drain');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(1);

    await mockState.setCodexCliKillBlocked(true);
    await panel.locator('[data-testid^="ai-agent-turn-stop-"]').click();
    await expect.poll(() => mockState.getCodexCliKillCount()).toBe(1);
    await expect(panel.locator('[data-testid^="ai-agent-turn-stop-"]')).toBeVisible();
    await expect(panel.locator('[data-testid^="ai-agent-turn-stopped-"]')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Retry turn' })).toHaveCount(0);
    expect(await mockState.getCodexCliTurnCount()).toBe(1);

    await mockState.setCodexCliKillBlocked(false);
    const stopped = panel.locator('[data-testid^="ai-agent-turn-stopped-"]');
    await expect(stopped).toContainText('Stopped');
    await stopped.getByRole('button', { name: 'Retry turn' }).click();
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(2);
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Fresh after Stop drain' } }),
    });
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, { kind: 'exit', code: 0 });

    await expect(panel).toContainText('Fresh after Stop drain');
    await expect(panel.locator('[data-testid^="ai-agent-turn-error-"]')).toHaveCount(0);
    await expect(panel.locator('[data-testid^="ai-agent-turn-stop-"]')).toHaveCount(0);
  });

  test('Codex mode switch resolves explicit kill drain before the next send', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await useCodexProvider(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('Codex mode drain');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(1);

    await mockState.setCodexCliKillBlocked(true);
    await app.getByTestId('ai-agent-mode-toggle').click();
    await expect.poll(() => mockState.getCodexCliKillCount()).toBe(1);
    await expect(app.getByTestId('ai-agent-mode-toggle')).toHaveText('Plan');
    expect(await mockState.getCodexCliTurnCount()).toBe(1);

    await mockState.setCodexCliKillBlocked(false);
    await expect(app.getByTestId('ai-agent-mode-toggle')).toHaveText('Act');
    await panel.locator('textarea').fill('Codex after mode drain');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(2);
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, { kind: 'exit', code: 0 });
    await expect(panel.locator('[data-testid^="ai-agent-turn-error-"]')).toHaveCount(0);
  });

  test('Codex mode switch retires a completed turn that has no raw exit', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await useCodexProvider(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    const input = panel.locator('textarea');
    await input.fill('Codex completed without exit');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(1);
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    await expect(panel.locator('[data-testid^="ai-agent-turn-stop-"]')).toHaveCount(0);

    await mockState.setCodexCliKillBlocked(true);
    await app.getByTestId('ai-agent-mode-toggle').click();
    await expect.poll(() => mockState.getCodexCliKillCount()).toBe(1);
    await expect(app.getByTestId('ai-agent-mode-toggle')).toHaveText('Plan');
    await input.fill('Codex after completed drain');
    expect(await mockState.getCodexCliTurnCount()).toBe(1);

    await mockState.setCodexCliKillBlocked(false);
    await expect(app.getByTestId('ai-agent-mode-toggle')).toHaveText('Act');
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'STALE_POST_RESULT_OUTPUT' },
      }),
    });
    await expect(panel).not.toContainText('STALE_POST_RESULT_OUTPUT');

    await panel.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(2);
    expect(await mockState.getCodexCliTurnCount()).toBe(2);
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Fresh after completed drain' },
      }),
    });
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, { kind: 'exit', code: 0 });

    await expect(panel).toContainText('Fresh after completed drain');
    await expect(panel).not.toContainText('STALE_POST_RESULT_OUTPUT');
    await expect(panel.locator('[data-testid^="ai-agent-turn-error-"]')).toHaveCount(0);
  });

  test('Codex bridge error without exit reaps the old runtime before Retry', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await useCodexProvider(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('Codex 无退出错误');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(1);

    await mockState.setCodexCliKillBlocked(true);
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'error',
      message: 'bridge reader failed',
    });
    await panel.getByRole('button', { name: 'Retry turn' }).click();

    await expect.poll(() => mockState.getCodexCliKillCount()).toBe(1);
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(1);
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'STALE_CODEX_OUTPUT' } }),
    });
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, { kind: 'exit', code: 1 });
    await expect(panel).not.toContainText('STALE_CODEX_OUTPUT');
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(1);

    await mockState.setCodexCliKillBlocked(false);
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(2);
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    await expect(panel.locator('[data-testid^="ai-agent-turn-error-"]')).toHaveCount(0);
  });

  test('Codex runTurn rejection retires the attached listener before Retry', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await useCodexProvider(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await mockState.setCodexCliTurnError('codex start rejected');
    await mockState.setCodexCliKillBlocked(true);
    await panel.locator('textarea').fill('Codex 启动拒绝');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(1);
    await expect(panel.locator('[data-testid^="ai-agent-turn-error-"]')).toContainText('codex start rejected');

    await mockState.setCodexCliTurnError(null);
    await panel.getByRole('button', { name: 'Retry turn' }).click();
    await expect.poll(() => mockState.getCodexCliKillCount()).toBe(1);
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(1);
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'STALE_START_OUTPUT' } }),
    });
    await expect(panel).not.toContainText('STALE_START_OUTPUT');

    await mockState.setCodexCliKillBlocked(false);
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(2);
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Fresh retry output' } }),
    });
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, { kind: 'exit', code: 0 });

    await expect(panel).toContainText('Fresh retry output');
    await expect(panel.locator('[data-testid^="ai-agent-turn-error-"]')).toHaveCount(0);
    await expect(panel.locator('[data-testid^="ai-agent-turn-stop-"]')).toHaveCount(0);
  });

  test('Apply conflict is represented on the originating Agent turn', async ({ app, mockState }) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('修改第一章');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: [
          'Done.',
          '```novelist-change-set',
          JSON.stringify({
            summary: 'Update Chapter 1',
            files: [{
              path: '/tmp/novelist-test-project/Chapter 1.md',
              status: 'modify',
              originalText: '# stale version\n',
              proposedText: '# 第一章\n\n新内容\n',
            }],
          }),
          '```',
        ].join('\n'),
      }),
    });

    const card = panel.getByTestId('ai-apply-changes-card');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Accept file' }).click();
    await expect(card).toContainText('conflict');
    await expect(panel.locator('[data-testid^="ai-agent-turn-error-"]')).toContainText('Apply failed');
  });

  test('Apply conditional write preserves an external CJK edit and marks the source card conflict', async ({ app, mockState }) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    const filePath = '/tmp/novelist-test-project/Chapter 1.md';
    const originalText = '# Chapter 1\n\nIt was a dark and stormy night.\n\nThe wind howled through the trees.\n';
    const externalText = '# 外部修改\n\n并发内容不得覆盖。\n';
    await panel.locator('textarea').fill('应用并发修改');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: [
          'Done.',
          '```novelist-change-set',
          JSON.stringify({
            summary: 'Concurrent source update',
            files: [{
              path: filePath,
              status: 'modify',
              originalText,
              proposedText: '# 第一章\n\n代理建议内容。\n',
            }],
          }),
          '```',
        ].join('\n'),
      }),
    });

    const card = panel.getByTestId('ai-apply-changes-card');
    await expect(card).toContainText('Concurrent source update');
    await mockState.scheduleConditionalWriteMutation(filePath, externalText);
    await card.getByRole('button', { name: 'Accept file' }).click();

    await expect(card).toContainText('conflict');
    await expect(card).toContainText('File changed since proposal was generated.');
    await expect(panel.locator('[data-testid^="ai-agent-turn-error-"]')).toContainText('Apply failed');
    expect((await mockState.getWrittenFiles())[filePath]).toBe(externalText);
    const conditionalCall = (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'write_file_if_unchanged')
      .at(-1);
    expect(conditionalCall?.args).toMatchObject({
      projectDir: '/tmp/novelist-test-project',
      path: filePath,
      expectedContent: originalText,
      content: '# 第一章\n\n代理建议内容。\n',
    });
  });

  test('Apply rejects a project symlink resolving to an external CJK file without modifying it', async ({ app, mockState }) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    const linkedPath = '/tmp/novelist-test-project/linked.md';
    const externalPath = '/tmp/novelist-external/secret.md';
    const externalText = '# 外部文件\n\n绝不能被覆盖。\n';
    await mockState.setConditionalWriteResolvedTarget(linkedPath, externalPath, externalText);
    await panel.locator('textarea').fill('尝试修改链接文件');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: [
          'Done.',
          '```novelist-change-set',
          JSON.stringify({
            summary: 'Unsafe linked update',
            files: [{
              path: linkedPath,
              status: 'modify',
              originalText: externalText,
              proposedText: '# 被拒绝的修改\n',
            }],
          }),
          '```',
        ].join('\n'),
      }),
    });

    const card = panel.getByTestId('ai-apply-changes-card');
    await expect(card).toContainText('Unsafe linked update');
    await card.getByRole('button', { name: 'Accept file' }).click();

    await expect(panel.locator('[data-testid^="ai-agent-turn-error-"]')).toContainText('outside active project');
    await expect(card).not.toContainText('Applied');
    expect(await mockState.getFileContent(externalPath)).toBe(externalText);
    expect((await mockState.getInvokeCalls()).filter(
      (call) => call.command === 'read_file' && call.args.path === linkedPath,
    )).toHaveLength(0);
  });

  test('Apply completion stays on its source session after switching tabs during a blocked conditional write', async ({ app, mockState }) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    const filePath = '/tmp/novelist-test-project/Chapter 1.md';
    await panel.locator('textarea').fill('修改第一章并保留来源');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: [
          'Done.',
          '```novelist-change-set',
          JSON.stringify({
            summary: 'Source-bound update',
            files: [{
              path: filePath,
              status: 'modify',
              originalText: '# stale version\n',
              proposedText: '# 第一章\n\n来源会话内容\n',
            }],
          }),
          '```',
        ].join('\n'),
      }),
    });
    await mockState.setConditionalWriteBlocked(filePath, true);
    await panel.getByTestId('ai-apply-changes-card').getByRole('button', { name: 'Accept file' }).click();

    await app.getByTestId('ai-agent-session-new').click();
    await expect(panel).not.toContainText('Source-bound update');
    await mockState.setConditionalWriteBlocked(filePath, false);
    const sourceTab = app.locator('[data-testid^="ai-agent-session-tab-"]').filter({ hasText: '修改第一章并保留来源' });
    await sourceTab.getByRole('button').click();

    await expect(panel.getByTestId('ai-apply-changes-card')).toContainText('conflict');
    await expect(panel.locator('[data-testid^="ai-agent-turn-error-"]')).toContainText('Apply failed');
  });

  test('rejected async session actions report safely, restore focus and state, and remain retryable', async ({ app, mockState }) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const pageErrors: Error[] = [];
    app.on('pageerror', (pageError) => pageErrors.push(pageError));
    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('异步回调');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: '完成' }),
    });
    await expect(panel).toContainText('完成');
    const storedState = () => app.evaluate(() => ({
      sessions: JSON.parse(localStorage.getItem('novelist:ai-agent:sessions:v1') ?? '[]'),
      activeId: localStorage.getItem('novelist:ai-agent:active-session:v1'),
    }));
    const credential = 'sk-session-action-secret';
    const rejectedMessage = `session persistence rejected Authorization: Bearer ${credential} ${'x'.repeat(900)}`;
    await mockState.setAiSessionWriteError(rejectedMessage);

    const trigger = app.getByTestId('ai-agent-session-menu-trigger');
    const actionError = app.getByTestId('ai-agent-action-error');
    const beforeRename = await storedState();
    await trigger.click();
    await app.getByTestId('ai-agent-session-menu-rename').click();
    const renameInput = app.getByTestId('ai-agent-session-rename-input');
    await renameInput.fill('失败后仍聚焦');
    await renameInput.press('Enter');
    await expect(actionError).toContainText('session persistence rejected');
    await expect(actionError).toContainText('[REDACTED]');
    await expect(panel).not.toContainText(credential);
    expect((await actionError.textContent())?.length).toBeLessThanOrEqual(560);
    expect(await storedState()).toEqual(beforeRename);
    await expect(trigger).toBeFocused();

    await mockState.setAiSessionWriteError(null);
    await trigger.click();
    await app.getByTestId('ai-agent-session-menu-rename').click();
    await app.getByTestId('ai-agent-session-rename-input').fill('失败后可重试');
    await app.getByTestId('ai-agent-session-rename-input').press('Enter');
    await expect(app.locator('[data-testid^="ai-agent-session-tab-"]').first()).toContainText('失败后可重试');
    await expect(actionError).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await mockState.setAiSessionWriteError(rejectedMessage);
    const beforeFork = await storedState();
    await trigger.click();
    await app.getByTestId('ai-agent-session-menu-fork').click();
    await expect(actionError).toContainText('session persistence rejected');
    await expect(app.locator('[data-testid^="ai-agent-session-tab-"]')).toHaveCount(1);
    expect(await storedState()).toEqual(beforeFork);
    await expect(trigger).toBeFocused();

    await mockState.setAiSessionWriteError(null);
    await trigger.click();
    await app.getByTestId('ai-agent-session-menu-fork').click();
    await expect(app.locator('[data-testid^="ai-agent-session-tab-"]')).toHaveCount(2);
    await expect(actionError).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await mockState.setAiSessionWriteError(rejectedMessage);
    const beforeClear = await storedState();
    await trigger.click();
    app.once('dialog', (dialog) => dialog.accept());
    await app.getByTestId('ai-agent-session-menu-clear').click();
    await expect(actionError).toContainText('session persistence rejected');
    await expect(panel).toContainText('完成');
    expect(await storedState()).toEqual(beforeClear);
    await expect(trigger).toBeFocused();

    await mockState.setAiSessionWriteError(null);
    await trigger.click();
    app.once('dialog', (dialog) => dialog.accept());
    await app.getByTestId('ai-agent-session-menu-clear').click();
    await expect(actionError).toHaveCount(0);
    await expect(panel).not.toContainText('完成');
    await expect(trigger).toBeFocused();
    expect(pageErrors).toEqual([]);
  });

  test('send failure is represented on the affected Agent turn', async ({ app, mockState }) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    await mockState.setClaudeCliSendError('send pipe failed');

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('发送失败测试');
    await panel.getByRole('button', { name: 'Send' }).click();

    const error = panel.locator('[data-testid^="ai-agent-turn-error-"]');
    await expect(error).toContainText('Send failed');
    await expect(error).toContainText('send pipe failed');
    await expect(error.getByRole('button', { name: 'Retry turn' })).toBeEnabled();
    await mockState.setClaudeCliSendError(null);
  });

  test('pre-send context rejection creates one sanitized retryable turn and retries once with current context @task23 @task23-negative', async ({ app, mockState }, testInfo) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    const filePath = '/tmp/novelist-test-project/Chapter 1.md';
    const sourcePrompt = '@file:Chapter 请根据当前章节继续写：雨夜重逢。';
    const staleContext = '# 第一章\n\nSTALE_CONTEXT_BYTES';
    const currentContext = '# 第一章\n\nCURRENT_AUTHORITATIVE_CONTEXT 雨夜重逢';
    await mockState.setFileContent(filePath, staleContext);
    await mockState.setReadFileBlocked(filePath, true);

    await panel.locator('textarea').fill(sourcePrompt);
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => (
      call.command === 'read_file' && call.args.path === filePath
    )).length).toBe(1);
    expect(await mockState.getClaudeCliSendCount()).toBe(0);

    await mockState.failNextBlockedRead(
      `读取上下文失败 Authorization: Bearer CONTEXT_READ_SECRET token=SECOND_CONTEXT_SECRET ${'x'.repeat(700)}`,
    );

    const turnError = panel.locator('[data-testid^="ai-agent-turn-error-"]');
    await expect(turnError).toContainText('Context failed');
    await expect(turnError).toContainText('读取上下文失败');
    await expect(turnError).toContainText('[REDACTED]');
    await expect(turnError).not.toContainText('CONTEXT_READ_SECRET');
    await expect(turnError).not.toContainText('SECOND_CONTEXT_SECRET');
    expect(Array.from((await turnError.textContent()) ?? '').length).toBeLessThanOrEqual(560);
    await expect(panel).toContainText(sourcePrompt);
    await expect(panel.locator('.banner')).toHaveCount(0);

    const preRetryCalls = await mockState.getInvokeCalls();
    expect(preRetryCalls.filter((call) => [
      'claude_cli_spawn',
      'claude_cli_send',
      'codex_cli_turn',
      'write_file',
      'write_file_if_unchanged',
    ].includes(call.command))).toEqual([]);
    const persistedFailure = await app.evaluate(() => (
      localStorage.getItem('novelist:ai-agent:sessions:v1') ?? ''
    ));
    expect(persistedFailure).toContain(sourcePrompt);
    expect(persistedFailure).toContain('[REDACTED]');
    expect(persistedFailure).not.toMatch(/CONTEXT_READ_SECRET|SECOND_CONTEXT_SECRET/u);
    const failedTurns = JSON.parse(persistedFailure)[0].turns;
    expect(failedTurns.filter((turn: { role: string }) => turn.role === 'user')).toHaveLength(1);
    expect(failedTurns.filter((turn: { role: string }) => turn.role === 'assistant')).toHaveLength(1);
    const projectFailures = Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.startsWith('/tmp/novelist-test-project/.novelist/ai/sessions/agent-'))
      .map(([, body]) => body);
    expect(projectFailures.some((body) => (
      body.includes(sourcePrompt)
      && body.includes('[REDACTED]')
      && body.includes('"contextState":"pending"')
      && body.includes('"stage":"context"')
    ))).toBe(true);
    expect(projectFailures.every((body) => !/CONTEXT_READ_SECRET|SECOND_CONTEXT_SECRET/u.test(body))).toBe(true);
    await app.screenshot({
      path: `.sisyphus/evidence/task-13-context-failure-${testInfo.project.name}.png`,
    });

    await mockState.setFileContent(filePath, currentContext);
    await mockState.setReadFileBlocked(filePath, false);
    await turnError.getByRole('button', { name: 'Retry turn' }).click();

    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(1);
    const sendCalls = (await mockState.getInvokeCalls()).filter((call) => call.command === 'claude_cli_send');
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].args.line).toContain('CURRENT_AUTHORITATIVE_CONTEXT');
    expect(sendCalls[0].args.line).not.toContain('STALE_CONTEXT_BYTES');
    expect(sendCalls[0].args.line).toContain('请根据当前章节继续写：雨夜重逢。');
    const retriedTurns = JSON.parse(await app.evaluate(() => (
      localStorage.getItem('novelist:ai-agent:sessions:v1') ?? '[]'
    )))[0].turns;
    expect(retriedTurns.filter((turn: { role: string }) => turn.role === 'user')).toHaveLength(1);
    expect(retriedTurns.filter((turn: { role: string }) => turn.role === 'assistant')).toHaveLength(1);
  });

  test('resolved legacy context failure retries stored outbound text without re-resolving context', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await app.evaluate(async () => {
      const session = {
        id: 'legacy-resolved-context',
        providerId: 'claude',
        mode: 'act',
        title: 'Legacy resolved context',
        createdAt: 1,
        updatedAt: 1,
        sessionUuid: 'legacy-resolved-context-uuid',
        turns: [{
          role: 'user',
          turnId: 'legacy-resolved-turn',
          text: 'STORED_OUTBOUND_PROMPT',
          displayText: '旧上下文失败',
          sourceText: '@file:Chapter 不应重新读取',
          contextState: 'resolved',
        }, {
          role: 'assistant',
          turnId: 'legacy-resolved-turn',
          text: '',
          cards: [],
          status: 'failed',
          failure: { stage: 'context', message: 'Legacy context failure' },
        }],
      };
      const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
      if (typeof internals !== 'object' || internals === null) throw new Error('Tauri internals unavailable');
      const invoke: unknown = Reflect.get(internals, 'invoke');
      if (typeof invoke !== 'function') throw new Error('Tauri invoke unavailable');
      await invoke.call(internals, 'write_ai_session', {
        projectDir: '/tmp/novelist-test-project',
        kind: 'agent',
        id: session.id,
        bodyJson: JSON.stringify(session),
      });
    });
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await expect(panel).toContainText('旧上下文失败');
    await panel.locator('[data-testid^="ai-agent-turn-error-"]')
      .getByRole('button', { name: 'Retry turn' })
      .click();

    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(1);
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'read_file')).toEqual([]);
    const sends = calls.filter((call) => call.command === 'claude_cli_send');
    expect(sends).toHaveLength(1);
    expect(sends[0].args.line).toContain('STORED_OUTBOUND_PROMPT');
    expect(sends[0].args.line).not.toContain('不应重新读取');
  });

  test('project session restore rejects a body whose id does not match its file identity', async ({ app }) => {
    await clearAiTalkStorage(app);
    await app.evaluate(async () => {
      const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
      if (typeof internals !== 'object' || internals === null) throw new Error('Tauri internals unavailable');
      const invoke: unknown = Reflect.get(internals, 'invoke');
      if (typeof invoke !== 'function') throw new Error('Tauri invoke unavailable');
      await invoke.call(internals, 'write_ai_session', {
        projectDir: '/tmp/novelist-test-project',
        kind: 'agent',
        id: 'owned-file-id',
        bodyJson: JSON.stringify({
          id: 'forged-body-id',
          providerId: 'claude',
          mode: 'act',
          title: 'FORGED_SESSION_TITLE',
          createdAt: 1,
          updatedAt: 1,
          sessionUuid: 'forged-session-uuid',
          turns: [{ role: 'user', text: 'FORGED_SESSION_PROMPT' }],
        }),
      });
    });
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await expect(panel).not.toContainText('FORGED_SESSION_TITLE');
    await expect(panel).not.toContainText('FORGED_SESSION_PROMPT');
  });

  test('pending context failure stays with its renamed session while delayed output lands in another session @task23 @task23-negative', async ({ app, mockState }) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    const filePath = '/tmp/novelist-test-project/Chapter 1.md';
    const sourcePrompt = '@file:Chapter 会话甲的上下文失败提示';
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    const sourceSessionId = await app.evaluate(() => localStorage.getItem('novelist:ai-agent:active-session:v1'));
    expect(sourceSessionId).toBeTruthy();
    await mockState.setReadFileBlocked(filePath, true);
    await panel.locator('textarea').fill(sourcePrompt);
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => (
      call.command === 'read_file' && call.args.path === filePath
    )).length).toBe(1);
    expect(await mockState.getClaudeCliSendCount()).toBe(0);

    await app.getByTestId('ai-agent-session-menu-trigger').click();
    await app.getByTestId('ai-agent-session-menu-rename').click();
    await app.getByTestId('ai-agent-session-rename-input').fill('已重命名的会话甲');
    await app.getByTestId('ai-agent-session-rename-input').press('Enter');
    await expect(app.getByTestId(`ai-agent-session-tab-${sourceSessionId}`)).toContainText('已重命名的会话甲');

    await app.getByTestId('ai-agent-session-new').click();
    const otherSessionId = await app.evaluate(() => localStorage.getItem('novelist:ai-agent:active-session:v1'));
    expect(otherSessionId).toBeTruthy();
    expect(otherSessionId).not.toBe(sourceSessionId);
    await panel.locator('textarea').fill('会话乙等待延迟输出');
    await panel.getByRole('button', { name: 'Send' }).click();
    const otherSessionUuid = await activeAgentSessionUuid(app);
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(1);

    await mockState.failNextBlockedRead('会话甲读取失败 token=SESSION_A_SECRET');
    await expect(panel).not.toContainText('会话甲读取失败');
    await expect(panel).not.toContainText(sourcePrompt);
    await mockState.emitEvent(`claude-stream://${otherSessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: '会话乙的延迟中文输出' }),
    });
    await expect(panel).toContainText('会话乙的延迟中文输出');

    await app.getByTestId(`ai-agent-session-tab-${sourceSessionId}`).click();
    await expect(panel).toContainText(sourcePrompt);
    await expect(panel.locator('[data-testid^="ai-agent-turn-error-"]')).toContainText('会话甲读取失败');
    await expect(panel).not.toContainText('SESSION_A_SECRET');
    await expect(panel).not.toContainText('会话乙的延迟中文输出');

    await app.getByTestId('ai-agent-session-menu-trigger').click();
    app.once('dialog', (dialog) => dialog.accept());
    await app.getByTestId('ai-agent-session-menu-delete').click();
    await expect(app.getByTestId(`ai-agent-session-tab-${sourceSessionId}`)).toHaveCount(0);
    await expect(app.getByTestId(`ai-agent-session-tab-${otherSessionId}`)).toBeVisible();
    await expect(panel).toContainText('会话乙的延迟中文输出');
    expect(await mockState.getClaudeCliSendCount()).toBe(1);
  });

  test('component destruction preserves a pending CJK context turn for explicit current-context retry @task23 @task23-negative', async ({ app, mockState }) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    const filePath = '/tmp/novelist-test-project/Chapter 1.md';
    const sourcePrompt = '@file:Chapter 组件销毁后仍可恢复的中文提示';
    await mockState.setReadFileBlocked(filePath, true);
    await panel.locator('textarea').fill(sourcePrompt);
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => (
      call.command === 'read_file' && call.args.path === filePath
    )).length).toBe(1);

    await app.getByTestId('panel-toggle-ai-agent').click();
    await expect(app.getByTestId('ai-agent-panel')).toHaveCount(0);
    await mockState.failNextBlockedRead('销毁后的读取失败 Authorization: Bearer DESTROY_SECRET');
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(0);

    await app.getByTestId('panel-toggle-ai-agent').click();
    const replacement = app.getByTestId('ai-agent-panel');
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    await expect(replacement).toContainText(sourcePrompt);
    const stopped = replacement.locator('[data-testid^="ai-agent-turn-stopped-"]');
    await expect(stopped).toContainText('Stopped');
    await expect(replacement).not.toContainText('DESTROY_SECRET');

    await mockState.setFileContent(filePath, '# 第一章\n\nDESTROY_RETRY_CURRENT_CONTEXT');
    await mockState.setReadFileBlocked(filePath, false);
    await stopped.getByRole('button', { name: 'Retry turn' }).click();
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(1);
    const sendCalls = (await mockState.getInvokeCalls()).filter((call) => call.command === 'claude_cli_send');
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].args.line).toContain('DESTROY_RETRY_CURRENT_CONTEXT');
  });

  test('provider diagnostics and failed tool results are sanitized before every output boundary', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('普通用户提示保持原样');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            content: '工具失败 password=abc;TOOL_TAIL_SECRET; 后续中文 https://alice:URL_SECRET@example.com/?api_key=QUERY_SECRET\nAuthorization: Bearer TOOL_RESULT_SECRET',
            is_error: true,
          }],
        },
      }),
    });
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            content: 'Authorization: Bearer SUCCESS_TOOL_RESULT_SECRET\n成功工具中文',
            is_error: false,
          }],
        },
      }),
    });
    await expect(panel.locator('.card.tool-result')).toHaveCount(2);
    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: '普通助手正文保持原样。' }),
    });
    await expect(panel).toContainText('普通用户提示保持原样');
    await expect(panel).toContainText('普通助手正文保持原样。');

    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'stderr-line',
      data: `fatal Authorization: Bearer STDERR_SECRET ${'x'.repeat(700)}`,
    });
    const banner = panel.locator('.banner');
    await expect(banner).toContainText('[REDACTED]');
    await expect(banner).not.toContainText('STDERR_SECRET');
    expect(Array.from((await banner.textContent()) ?? '').length).toBeLessThanOrEqual(512);

    await mockState.emitEvent(`claude-stream://${sessionUuid}`, {
      kind: 'error',
      message: `Authorization: Bearer BRIDGE_SECRET\n Signature=FOLDED_BRIDGE_SECRET ${'y'.repeat(700)}`,
    });
    await expect(banner).toContainText('Authorization: [REDACTED]');
    await expect(banner).not.toContainText('BRIDGE_SECRET');
    await expect(banner).not.toContainText('FOLDED_BRIDGE_SECRET');
    expect(Array.from((await banner.textContent()) ?? '').length).toBeLessThanOrEqual(512);

    await expect(panel).not.toContainText('TOOL_RESULT_SECRET');
    await expect(panel).not.toContainText('TOOL_TAIL_SECRET');
    await expect(panel).not.toContainText('URL_SECRET');
    await expect(panel).not.toContainText('QUERY_SECRET');
    await expect(panel).not.toContainText('SUCCESS_TOOL_RESULT_SECRET');
    await expect(panel).toContainText('后续中文');
    await expect.poll(async () => Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.includes('/.novelist/ai/sessions/agent-'))
      .some(([, body]) => body.includes('普通助手正文保持原样。'))).toBe(true);

    const persisted = Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.includes('/.novelist/ai/sessions/agent-'))
      .map(([, body]) => body)
      .join('\n');
    expect(persisted).not.toMatch(/TOOL_RESULT_SECRET|TOOL_TAIL_SECRET|URL_SECRET|QUERY_SECRET|SUCCESS_TOOL_RESULT_SECRET/u);
    expect(persisted).toContain('普通用户提示保持原样');
    expect(persisted).toContain('普通助手正文保持原样。');
    expect(persisted).toContain('后续中文');
    expect(persisted).toContain('成功工具中文');

    await app.getByTestId('ai-agent-session-menu-trigger').click();
    await app.getByTestId('ai-agent-session-menu-save').click();
    await expect(app.getByTestId('ai-agent-save-status')).toContainText('Saved');
    const transcript = Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.includes('/.novelist/chats/'))
      .map(([, body]) => body)
      .join('\n');
    expect(transcript).not.toMatch(/TOOL_RESULT_SECRET|TOOL_TAIL_SECRET|URL_SECRET|QUERY_SECRET|SUCCESS_TOOL_RESULT_SECRET/u);
    expect(transcript).toContain('普通用户提示保持原样');
    expect(transcript).toContain('普通助手正文保持原样。');
    expect(transcript).toContain('后续中文');
    expect(transcript).toContain('成功工具中文');
  });

  test('legacy restored diagnostics are sanitized before render, rewrite, and transcript export', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    const legacySecrets = [
      'LEGACY_FAILURE_SECRET',
      'LEGACY_PASSWORD_SECRET',
      'LEGACY_AWS_SECRET',
      'LEGACY_TOOL_RESULT_SECRET',
    ];
    await app.evaluate(async () => {
      const session = {
        id: 'legacy-security-session',
        providerId: 'claude',
        mode: 'plan',
        title: '历史安全会话',
        createdAt: 1,
        updatedAt: 1,
        sessionUuid: 'legacy-security-uuid',
        turns: [{
          role: 'user',
          turnId: 'legacy-turn',
          text: '用户原文 password=用户秘密保持',
          displayText: '用户显示 token=显示原文保持',
        }, {
          role: 'assistant',
          turnId: 'legacy-turn',
          text: '助手原文 password=助手秘密保持',
          cards: [{
            kind: 'tool',
            name: 'legacy-tool',
            input: {
              password: 'LEGACY_PASSWORD_SECRET',
              nested: { AWS_SECRET_ACCESS_KEY: ['LEGACY_AWS_SECRET'] },
              token_count: 17,
              note: '工具普通中文',
            },
          }, {
            kind: 'tool-result',
            content: 'Authorization: Bearer LEGACY_TOOL_RESULT_SECRET',
            status: 'success',
          }, {
            kind: 'apply-changes',
            changeSet: {
              summary: 'Apply 内容保持',
              files: [{
                path: '/tmp/novelist-test-project/Chapter 1.md',
                status: 'modify',
                originalText: 'password=Apply 原始文本保持',
                proposedText: 'token=Apply 建议文本保持',
              }],
            },
          }],
          status: 'failed',
          failure: { stage: 'tool', message: 'Bearer LEGACY_FAILURE_SECRET' },
        }],
      };
      const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
      if (typeof internals !== 'object' || internals === null) throw new Error('Tauri internals unavailable');
      const invoke: unknown = Reflect.get(internals, 'invoke');
      if (typeof invoke !== 'function') throw new Error('Tauri invoke unavailable');
      await invoke.call(internals, 'write_ai_session', {
        projectDir: '/tmp/novelist-test-project',
        kind: 'agent',
        id: session.id,
        bodyJson: JSON.stringify(session),
      });
    });
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await expect(panel).toContainText('用户显示 token=显示原文保持');
    await expect(panel).toContainText('助手原文 password=助手秘密保持');
    await expect(panel).toContainText('工具普通中文');
    await expect(panel).toContainText('Apply 内容保持');
    for (const secret of legacySecrets) await expect(panel).not.toContainText(secret);
    await expect.poll(async () => Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.includes('agent-legacy-security-session.json'))
      .some(([, body]) =>
        body.includes('助手原文 password=助手秘密保持')
        && body.includes('[REDACTED]')
        && !legacySecrets.some((secret) => body.includes(secret)),
      )).toBe(true);

    const persisted = Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.includes('agent-legacy-security-session.json'))
      .map(([, body]) => body)
      .join('\n');
    for (const secret of legacySecrets) expect(persisted).not.toContain(secret);
    expect(persisted).toContain('用户原文 password=用户秘密保持');
    expect(persisted).toContain('助手原文 password=助手秘密保持');
    expect(persisted).toContain('password=Apply 原始文本保持');
    expect(persisted).toContain('token=Apply 建议文本保持');
    expect(persisted).toContain('"token_count":17');

    await app.getByTestId('ai-agent-session-menu-trigger').click();
    await app.getByTestId('ai-agent-session-menu-save').click();
    await expect(app.getByTestId('ai-agent-save-status')).toContainText('Saved');
    const transcript = Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.includes('/.novelist/chats/'))
      .map(([, body]) => body)
      .join('\n');
    for (const secret of legacySecrets) expect(transcript).not.toContain(secret);
    expect(transcript).toContain('用户显示 token=显示原文保持');
    expect(transcript).toContain('助手原文 password=助手秘密保持');
    expect(transcript).toContain('工具普通中文');
    expect(transcript).toContain('Apply 内容保持');
  });

  test('Codex command inputs are recursively sanitized before persistence and transcript export', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await useCodexProvider(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('普通 Codex 用户提示');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sessionUuid = await activeAgentSessionUuid(app);
    await expect.poll(() => mockState.getCodexCliTurnCount()).toBe(1);
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'curl -H "Authorization: Bearer CODEX_COMMAND_SECRET" https://example.com',
          metadata: {
            env: ['password=abc;CODEX_ENV_SECRET', { token: 'token=CODEX_TOKEN_SECRET' }],
            endpoint: 'https://alice:CODEX_URL_SECRET@example.com/?api_key=CODEX_QUERY_SECRET',
          },
          exit_code: 0,
        },
      }),
    });
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '普通 Codex 助手正文。' },
      }),
    });
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    });
    await mockState.emitEvent(`codex-stream://${sessionUuid}`, { kind: 'exit', code: 0 });

    await expect(panel).toContainText('普通 Codex 用户提示');
    await expect(panel).toContainText('普通 Codex 助手正文。');
    await expect(panel).not.toContainText('CODEX_COMMAND_SECRET');
    await expect(panel).not.toContainText('CODEX_ENV_SECRET');
    await expect(panel).not.toContainText('CODEX_TOKEN_SECRET');
    await expect(panel).not.toContainText('CODEX_URL_SECRET');
    await expect(panel).not.toContainText('CODEX_QUERY_SECRET');
    await expect.poll(async () => Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.includes('/.novelist/ai/sessions/agent-'))
      .some(([, body]) => body.includes('普通 Codex 助手正文。'))).toBe(true);

    const persisted = Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.includes('/.novelist/ai/sessions/agent-'))
      .map(([, body]) => body)
      .join('\n');
    expect(persisted).not.toMatch(/CODEX_(?:COMMAND|ENV|TOKEN|URL|QUERY)_SECRET/u);
    expect(persisted).toContain('普通 Codex 用户提示');
    expect(persisted).toContain('普通 Codex 助手正文。');

    await app.getByTestId('ai-agent-session-menu-trigger').click();
    await app.getByTestId('ai-agent-session-menu-save').click();
    await expect(app.getByTestId('ai-agent-save-status')).toContainText('Saved');
    const transcript = Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.includes('/.novelist/chats/'))
      .map(([, body]) => body)
      .join('\n');
    expect(transcript).not.toMatch(/CODEX_(?:COMMAND|ENV|TOKEN|URL|QUERY)_SECRET/u);
    expect(transcript).toContain('普通 Codex 用户提示');
    expect(transcript).toContain('普通 Codex 助手正文。');
  });

  test('project switch blocks sends while Agent teardown is pending @task23 @task23-negative', async ({ app, mockState }) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();

    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('项目 A 请求');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(1);
    const uuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${uuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: '项目 A 回复' }),
    });

    await mockState.setClaudeCliKillBlocked(true);
    await app.getByTestId('sidebar-switch-btn').click();
    await app.getByText('Another Story', { exact: true }).click();
    await expect(app.getByTestId('sidebar-switch-btn')).toContainText('another-project');

    await panel.locator('textarea').fill('不得发送到项目 B');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(panel).not.toContainText('不得发送到项目 B');
    await expect(panel).toContainText('AI Agent is still loading this project.');
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(1);
    await expect(app.getByTestId('ai-agent-session-menu-trigger')).toBeDisabled();
    await expect(app.getByTestId('ai-agent-session-new')).toBeDisabled();

    await mockState.setClaudeCliKillBlocked(false);
    await expect.poll(async () => {
      const written = await mockState.getWrittenFiles();
      return Object.keys(written).some((path) =>
        path.startsWith('/tmp/another-project/.novelist/ai/sessions/agent-'),
      );
    }).toBe(true);
    const destinationSessions = Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.startsWith('/tmp/another-project/.novelist/ai/sessions/agent-'))
      .map(([, body]) => body);
    expect(destinationSessions).not.toHaveLength(0);
    expect(destinationSessions.every((body) => !body.includes('项目 A 请求'))).toBe(true);
  });

  test('late source-project runtime events and state cannot surface in the destination project @task23 @task23-negative', async ({ app, mockState }, testInfo) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const panel = app.getByTestId('ai-agent-panel');

    await panel.locator('textarea').fill('PROJECT_A_ONLY_PROMPT');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sourceUuid = await activeAgentSessionUuid(app);
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(1);
    await mockState.emitEvent(`claude-stream://${sourceUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'PROJECT_A_PARTIAL' } },
      }),
    });
    await expect(panel).toContainText('PROJECT_A_PARTIAL');

    await mockState.setClaudeCliKillBlocked(true);
    await app.getByTestId('sidebar-switch-btn').click();
    await app.getByText('Another Story', { exact: true }).click();
    await expect(app.getByTestId('sidebar-switch-btn')).toContainText('another-project');
    await expect(app.getByTestId('ai-agent-session-new')).toBeDisabled();

    await mockState.emitEvent(`claude-stream://${sourceUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: 'LATE_PROJECT_A_OUTPUT' }),
    });
    await mockState.emitEvent(`claude-stream://${sourceUuid}`, {
      kind: 'error',
      message: 'LATE_PROJECT_A_ERROR',
    });
    await expect(panel).not.toContainText('LATE_PROJECT_A_OUTPUT');
    await expect(panel).not.toContainText('LATE_PROJECT_A_ERROR');

    await mockState.setClaudeCliKillBlocked(false);
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    await expect(panel).not.toContainText('PROJECT_A_ONLY_PROMPT');
    await expect(panel).not.toContainText('LATE_PROJECT_A_OUTPUT');
    await expect(panel).not.toContainText('LATE_PROJECT_A_ERROR');

    await panel.locator('textarea').fill('PROJECT_B_FRESH_PROMPT');
    await panel.getByRole('button', { name: 'Send' }).click();
    const destinationUuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${destinationUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: 'PROJECT_B_FRESH_OUTPUT' }),
    });
    await expect(panel).toContainText('PROJECT_B_FRESH_OUTPUT');
    await expect(panel).not.toContainText('PROJECT_A_PARTIAL');

    const written = Object.entries(await mockState.getWrittenFiles());
    const sourceBodies = written
      .filter(([path]) => path.startsWith('/tmp/novelist-test-project/.novelist/ai/sessions/agent-'))
      .map(([, body]) => body);
    expect(sourceBodies.some(body => body.includes('PROJECT_A_PARTIAL'))).toBe(true);
    expect(sourceBodies.some(body => body.includes('"status":"stopped"'))).toBe(true);
    const destinationBodies = written
      .filter(([path]) => path.startsWith('/tmp/another-project/.novelist/ai/sessions/agent-'))
      .map(([, body]) => body);
    expect(destinationBodies).not.toHaveLength(0);
    expect(destinationBodies.every(body => !body.includes('PROJECT_A_ONLY_PROMPT'))).toBe(true);
    expect(destinationBodies.every(body => !body.includes('PROJECT_A_PARTIAL'))).toBe(true);
    expect(destinationBodies.every(body => !body.includes('LATE_PROJECT_A'))).toBe(true);
    await app.screenshot({ path: '.sisyphus/evidence/task-12-project-switch.png' });
    await panel.screenshot({
      path: `.sisyphus/evidence/task-23-ai-isolation-${testInfo.project.name}.png`,
    });
  });

  test('destination session-load failure is B-scoped and one panel retry loads once', async ({ app, mockState }) => {
    await clearAiTalkStorage(app);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const panel = app.getByTestId('ai-agent-panel');
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();

    await panel.locator('textarea').fill('PROJECT_A_CONTEXT');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sourceUuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${sourceUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: 'PROJECT_A_COMPLETE' }),
    });
    await expect(panel).toContainText('PROJECT_A_COMPLETE');

    await mockState.setAiSessionListError('/tmp/another-project', 'B sessions unavailable');
    await app.getByTestId('sidebar-switch-btn').click();
    await app.getByText('Another Story', { exact: true }).click();
    await expect(app.getByTestId('sidebar-switch-btn')).toContainText('another-project');
    await expect(panel).toContainText('Failed to load AI Agent sessions for /tmp/another-project: B sessions unavailable');
    await expect(panel).not.toContainText('PROJECT_A_CONTEXT');
    await expect(panel).not.toContainText('PROJECT_A_COMPLETE');
    await expect(app.getByTestId('ai-agent-session-new')).toBeDisabled();

    await mockState.setAiSessionListError('/tmp/another-project', null);
    await app.getByTestId('panel-toggle-ai-agent').click();
    await expect(panel).toHaveCount(0);
    await app.getByTestId('panel-toggle-ai-agent').click();
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    const destinationLoads = (await mockState.getInvokeCalls()).filter(call => (
      call.command === 'list_ai_sessions' && call.args.projectDir === '/tmp/another-project'
    ));
    expect(destinationLoads).toHaveLength(2);
    await expect(app.getByTestId('ai-agent-panel')).not.toContainText('PROJECT_A_CONTEXT');

    await mockState.setAiSessionListError('/tmp/another-project', 'B sessions unavailable after retry check');
    await app.getByTestId('panel-toggle-ai-agent').click();
    await expect(app.getByTestId('ai-agent-panel')).toHaveCount(0);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const failedPanel = app.getByTestId('ai-agent-panel');
    await expect(failedPanel).toContainText(
      'Failed to load AI Agent sessions for /tmp/another-project: B sessions unavailable after retry check',
    );
    await expect(failedPanel).not.toContainText('PROJECT_A_CONTEXT');
    expect((await mockState.getInvokeCalls()).filter(call => (
      call.command === 'list_ai_sessions' && call.args.projectDir === '/tmp/another-project'
    ))).toHaveLength(3);
    await app.screenshot({ path: '.sisyphus/evidence/task-12-load-failure.png' });
  });

  test('CJK project commands switch ownership and invoke after retry and same-project reopen', async ({ app, mockState }) => {
    const projectA = '/tmp/novelist-test-project';
    const projectB = '/tmp/another-project';
    const commandA = `${projectA}/.novelist/ai/commands/甲项目命令.md`;
    const commandB = `${projectB}/.novelist/ai/commands/乙项目命令.md`;
    await mockState.setFileContent(commandA, 'PROJECT_A_COMMAND_INSTRUCTION');
    await mockState.setFileContent(commandB, 'PROJECT_B_COMMAND_INSTRUCTION');
    await mockState.setFileContent(`${projectA}/.novelist/ai/commands/Plan.md`, 'BUILTIN_COLLISION');
    await mockState.setFileContent(`${projectA}/.novelist/ai/commands/plan\u200d.md`, 'INVISIBLE_COMMAND');
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const panel = app.getByTestId('ai-agent-panel');
    const composer = panel.locator('textarea');

    await composer.fill('/甲');
    await expect(app.getByTestId('ai-command-menu')).toContainText('/甲项目命令');
    await expect(app.getByTestId('ai-command-menu')).not.toContainText('/乙项目命令');
    await composer.fill('@command');
    await expect(app.getByTestId('ai-mention-menu')).not.toContainText('Command: Plan');
    await expect(app.getByTestId('ai-mention-menu')).not.toContainText('Command: plan\u200d');
    await composer.fill('/甲项目命令 收紧项目甲节奏');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.startsWith(`${projectA}/.novelist/ai/sessions/agent-`))
      .some(([, body]) => body.includes('PROJECT_A_COMMAND_INSTRUCTION') && body.includes('收紧项目甲节奏'))).toBe(true);
    const sourceUuid = await activeAgentSessionUuid(app);
    await mockState.emitEvent(`claude-stream://${sourceUuid}`, {
      kind: 'stdout-line',
      data: JSON.stringify({ type: 'result', subtype: 'success', result: '项目甲完成' }),
    });

    await mockState.setAiPromptAssetError(projectB, 'B assets unavailable token=ASSET_SECRET');
    await app.getByTestId('sidebar-switch-btn').click();
    await app.getByText('Another Story', { exact: true }).click();
    await expect(panel).toContainText('Failed to load AI Agent sessions for /tmp/another-project');
    await expect(panel).not.toContainText('ASSET_SECRET');
    await composer.fill('/');
    await expect(app.getByTestId('ai-command-menu')).not.toContainText('/甲项目命令');

    await mockState.setAiPromptAssetError(projectB, null);
    await app.getByTestId('panel-toggle-ai-agent').click();
    await expect(panel).toHaveCount(0);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const reopenedPanel = app.getByTestId('ai-agent-panel');
    const reopenedComposer = reopenedPanel.locator('textarea');
    await reopenedComposer.fill('/乙');
    await expect(app.getByTestId('ai-command-menu')).toContainText('/乙项目命令');
    await expect(app.getByTestId('ai-command-menu')).not.toContainText('/甲项目命令');
    await reopenedComposer.fill('/乙项目命令 收紧项目乙节奏');
    await reopenedPanel.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.startsWith(`${projectB}/.novelist/ai/sessions/agent-`))
      .some(([, body]) => body.includes('PROJECT_B_COMMAND_INSTRUCTION') && body.includes('收紧项目乙节奏'))).toBe(true);

    await app.getByTestId('panel-toggle-ai-agent').click();
    await app.getByTestId('panel-toggle-ai-agent').click();
    const sameProjectComposer = app.getByTestId('ai-agent-panel').locator('textarea');
    await sameProjectComposer.fill('/乙');
    await expect(app.getByTestId('ai-command-menu')).toContainText('/乙项目命令');
  });

  test('late command assets from rapid A to B to A never replace current project commands', async ({ app, mockState }) => {
    const projectA = '/tmp/novelist-test-project';
    const projectB = '/tmp/another-project';
    await mockState.setFileContent(`${projectA}/.novelist/ai/commands/甲项目命令.md`, 'PROJECT_A_ONLY');
    await mockState.setFileContent(`${projectB}/.novelist/ai/commands/乙项目命令.md`, 'PROJECT_B_ONLY');
    await mockState.setAiPromptAssetsBlocked(projectB, true);
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const panel = app.getByTestId('ai-agent-panel');
    await panel.locator('textarea').fill('/甲');
    await expect(app.getByTestId('ai-command-menu')).toContainText('/甲项目命令');

    await app.getByTestId('sidebar-switch-btn').click();
    await app.getByText('Another Story', { exact: true }).click();
    await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => (
      call.command === 'list_ai_prompt_assets' && call.args.projectDir === projectB
    )).length).toBe(1);

    await panel.locator('textarea').fill('/');
    await app.evaluate(() => {
      const probe = { sawStaleB: false, observer: null as MutationObserver | null };
      const scan = () => {
        const menu = document.querySelector('[data-testid="ai-command-menu"]');
        if (menu?.textContent?.includes('/乙项目命令')) probe.sawStaleB = true;
      };
      probe.observer = new MutationObserver(scan);
      probe.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      Reflect.set(window, '__task12PromptAssetProbe__', probe);
      scan();
    });
    await app.getByTestId('sidebar-switch-btn').click();
    await app.getByTestId('project-switcher').getByText('Test Novel', { exact: true }).click();
    await expect(app.getByTestId('sidebar-switch-btn')).toContainText('novelist-test-project');
    await mockState.setAiPromptAssetsBlocked(projectB, false);

    await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => (
      call.command === 'list_ai_prompt_assets' && call.args.projectDir === projectA
    )).length).toBe(2);
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    await panel.locator('textarea').fill('/');
    await expect(app.getByTestId('ai-command-menu')).toContainText('/甲项目命令');
    await expect(app.getByTestId('ai-command-menu')).not.toContainText('/乙项目命令');
    const sawStaleB = await app.evaluate(() => {
      const probe = Reflect.get(window, '__task12PromptAssetProbe__') as {
        sawStaleB: boolean;
        observer: MutationObserver | null;
      };
      probe.observer?.disconnect();
      Reflect.deleteProperty(window, '__task12PromptAssetProbe__');
      return probe.sawStaleB;
    });
    expect(sawStaleB).toBe(false);

    await panel.locator('textarea').fill('/甲项目命令 快速回切后调用甲命令');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => {
      const bodies = Object.entries(await mockState.getWrittenFiles())
        .filter(([path]) => path.startsWith(`${projectA}/.novelist/ai/sessions/agent-`))
        .map(([, body]) => body);
      return bodies.some((body) => body.includes('PROJECT_A_ONLY'))
        && bodies.every((body) => !body.includes('PROJECT_B_ONLY'));
    }).toBe(true);
  });

  test('same-path A intent supersedes B before destination project commit', async ({ app, mockState }) => {
    const projectA = '/tmp/novelist-test-project';
    const projectB = '/tmp/another-project';
    await mockState.setFileContent(`${projectA}/.novelist/ai/commands/甲项目命令.md`, 'PROJECT_A_ONLY');
    await mockState.setFileContent(`${projectB}/.novelist/ai/commands/乙项目命令.md`, 'PROJECT_B_ONLY');
    await mockState.setProjectDetectBlocked(projectB, true);

    try {
      await setClaudeCliDetected(app);
      await enterProject(app);
      await app.getByTestId('panel-toggle-ai-agent').click();
      const panel = app.getByTestId('ai-agent-panel');
      await panel.locator('textarea').fill('/甲');
      await expect(app.getByTestId('ai-command-menu')).toContainText('/甲项目命令');

      await app.getByTestId('sidebar-switch-btn').click();
      await app.getByText('Another Story', { exact: true }).click();
      await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => (
        call.command === 'detect_project' && (call.args.path === projectB || call.args.dirPath === projectB)
      )).length).toBe(1);

      await app.getByTestId('sidebar-switch-btn').click();
      await app.getByTestId('project-switcher').getByText('Test Novel', { exact: true }).click();
      await mockState.setProjectDetectBlocked(projectB, false);
      await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => (
        call.command === 'list_ai_prompt_assets' && call.args.projectDir === projectA
      )).length).toBe(2);

      await expect(app.getByTestId('sidebar-switch-btn')).toContainText('novelist-test-project');
      await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => (
        call.command === 'list_ai_prompt_assets' && call.args.projectDir === projectB
      )).length).toBe(0);
      await panel.locator('textarea').fill('/');
      await expect(app.getByTestId('ai-command-menu')).toContainText('/甲项目命令');
      await expect(app.getByTestId('ai-command-menu')).not.toContainText('/乙项目命令');
    } finally {
      await mockState.setProjectDetectBlocked(projectB, false);
    }
  });

  test('successful project switch stops and starts the watcher exactly once', async ({ app, mockState }) => {
    await enterProject(app);
    await mockState.reset();

    await app.getByTestId('sidebar-switch-btn').click();
    await app.getByText('Another Story', { exact: true }).click();
    await expect(app.getByTestId('sidebar-switch-btn')).toContainText('another-project');

    const calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'stop_file_watcher')).toHaveLength(1);
    expect(calls.filter((call) => call.command === 'start_file_watcher')).toHaveLength(1);
    expect(calls.filter((call) => call.command === 'detect_project')).toHaveLength(1);
  });

  test('rejected source-project context read cannot surface in the destination project @task23 @task23-negative', async ({ app, mockState }) => {
    await setClaudeCliDetected(app);
    await enterProject(app);
    await app.getByTestId('panel-toggle-ai-agent').click();
    const panel = app.getByTestId('ai-agent-panel');
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();

    const filePath = '/tmp/novelist-test-project/Chapter 1.md';
    await mockState.setReadFileBlocked(filePath, true);
    await panel.locator('textarea').fill('@file:Chapter 不得泄漏错误');
    await panel.getByRole('button', { name: 'Send' }).click();
    const sourceSessionId = await app.evaluate(() => localStorage.getItem('novelist:ai-agent:active-session:v1'));
    expect(sourceSessionId).toBeTruthy();
    await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => (
      call.command === 'read_file' && call.args.path === filePath
    )).length).toBe(1);
    expect(await mockState.getClaudeCliSendCount()).toBe(0);

    await app.getByTestId('sidebar-switch-btn').click();
    await app.getByText('Another Story', { exact: true }).click();
    await expect(app.getByTestId('sidebar-switch-btn')).toContainText('another-project');
    await expect(app.getByTestId('ai-agent-session-new')).toBeEnabled();
    await mockState.failNextBlockedRead('PROJECT_A_READ_FAILED');

    await expect(panel).not.toContainText('PROJECT_A_READ_FAILED');
    await expect(panel).not.toContainText('Failed to resolve prompt context');
    await expect.poll(() => mockState.getClaudeCliSendCount()).toBe(0);
    const destinationBodies = Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.startsWith('/tmp/another-project/.novelist/ai/sessions/agent-'))
      .map(([, body]) => body);
    expect(destinationBodies.every((body) => !body.includes('不得泄漏错误'))).toBe(true);
    expect(destinationBodies.every((body) => !body.includes('PROJECT_A_READ_FAILED'))).toBe(true);
    const sourceBodies = Object.entries(await mockState.getWrittenFiles())
      .filter(([path]) => path.startsWith('/tmp/novelist-test-project/.novelist/ai/sessions/agent-'))
      .map(([, body]) => body);
    expect(sourceBodies.some((body) => (
      body.includes('@file:Chapter 不得泄漏错误')
      && body.includes('"contextState":"pending"')
      && body.includes('"status":"stopped"')
    ))).toBe(true);
    expect(sourceBodies.every((body) => !body.includes('PROJECT_A_READ_FAILED'))).toBe(true);
    expect(await mockState.getClaudeCliSendCount()).toBe(0);
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

  test('selecting an AI Talk provider updates baseUrl + model', async ({ app }) => {
    await app.keyboard.press('Meta+,');
    await app.getByTestId('settings-section-plugin:ai-talk').click();
    await app.getByTestId('ai-talk-profile-anthropic').click();

    const baseUrlInput = app.locator('input[type="text"]').first();
    await expect(baseUrlInput).toHaveValue('https://api.anthropic.com/v1');
  });
});
