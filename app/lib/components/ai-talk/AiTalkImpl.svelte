<script lang="ts">
  import { onMount } from 'svelte';
  import { aiTalkSettings } from './settings.svelte';
  import {
    getEditorSnapshot,
    replaceEditorRange,
    startAiStream,
    cancelAiStream,
    aiStream,
  } from './host';
  import { buildChatRequest, parseChatDelta, type ChatMessage } from './openai';
  import AiTalkSettings from './AiTalkSettings.svelte';

  type Tab = 'chat' | 'rewrite';
  let activeTab = $state<Tab>('chat');
  let settingsOpen = $state(false);

  // ------------------------------- Chat -------------------------------

  type DisplayMessage = { role: 'user' | 'assistant'; content: string };
  const HISTORY_KEY = 'novelist:ai-talk:history:v1';

  let messages = $state<DisplayMessage[]>(loadHistory());
  let chatInput = $state('');
  let chatStreaming = $state(false);
  let chatStreamId: string | null = null;
  let chatScroller = $state<HTMLDivElement | undefined>(undefined);

  function loadHistory(): DisplayMessage[] {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(messages));
    } catch {
      /* ignore */
    }
  }

  function buildChatContext(userText: string): ChatMessage[] {
    const ctx: ChatMessage[] = [];
    const s = aiTalkSettings.value;
    if (s.systemPrompt.trim()) {
      ctx.push({ role: 'system', content: s.systemPrompt });
    }

    const snap = getEditorSnapshot();
    if (snap) {
      if (s.includeCurrentFile && snap.fullDoc.trim()) {
        ctx.push({
          role: 'user',
          content: `The user is currently editing "${snap.filePath ?? 'untitled'}". Document contents:\n\n${snap.fullDoc}`,
        });
      } else if (s.includeSelection && snap.text.trim()) {
        ctx.push({
          role: 'user',
          content: `Selected text the user is asking about:\n\n${snap.text}`,
        });
      }
    }

    for (const m of messages) {
      ctx.push({ role: m.role, content: m.content });
    }
    ctx.push({ role: 'user', content: userText });
    return ctx;
  }

  async function sendChat() {
    const text = chatInput.trim();
    if (!text || chatStreaming) return;
    if (!aiTalkSettings.value.apiKey) {
      messages = [...messages, { role: 'assistant', content: '⚠️ Set an API key in Settings first.' }];
      saveHistory();
      return;
    }
    messages = [...messages, { role: 'user', content: text }];
    chatInput = '';
    saveHistory();
    scrollChat();

    const assistantIdx = messages.length;
    messages = [...messages, { role: 'assistant', content: '' }];
    chatStreaming = true;

    let buffered = '';
    try {
      const req = buildChatRequest({
        baseUrl: aiTalkSettings.value.baseUrl,
        apiKey: aiTalkSettings.value.apiKey,
        model: aiTalkSettings.value.model,
        temperature: aiTalkSettings.value.temperature,
        messages: buildChatContext(text),
      });
      chatStreamId = await startAiStream(req);
      for await (const ev of aiStream(chatStreamId)) {
        if (ev.kind === 'chunk') {
          const delta = parseChatDelta(ev.data);
          if (delta) {
            buffered += delta;
            messages[assistantIdx] = { role: 'assistant', content: buffered };
            scrollChat();
          }
        } else if (ev.kind === 'error') {
          messages[assistantIdx] = {
            role: 'assistant',
            content: `${buffered}\n\n⚠️ ${ev.message}${ev.status ? ` (HTTP ${ev.status})` : ''}`,
          };
        }
      }
    } catch (e) {
      messages[assistantIdx] = {
        role: 'assistant',
        content: `${buffered}\n\n⚠️ ${e instanceof Error ? e.message : String(e)}`,
      };
    } finally {
      chatStreaming = false;
      chatStreamId = null;
      saveHistory();
    }
  }

  async function cancelChat() {
    if (chatStreamId) {
      const id = chatStreamId;
      chatStreamId = null;
      await cancelAiStream(id).catch(() => {});
    }
    chatStreaming = false;
  }

  function clearChat() {
    messages = [];
    saveHistory();
  }

  function scrollChat() {
    queueMicrotask(() => {
      if (chatScroller) chatScroller.scrollTop = chatScroller.scrollHeight;
    });
  }

  function chatKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void sendChat();
    }
  }

  // ------------------------------ Rewrite ------------------------------

  type RewriteSnap = { from: number; to: number; original: string };

  let rewriteInstr = $state('');
  let rewriteSnap = $state<RewriteSnap | null>(null);
  let rewriteOutput = $state('');
  let rewriteStreaming = $state(false);
  let rewriteStreamId: string | null = null;
  let rewriteError = $state('');

  function captureSelection() {
    rewriteError = '';
    const snap = getEditorSnapshot();
    if (!snap || !snap.text.trim()) {
      rewriteError = 'No text selected in the editor.';
      rewriteSnap = null;
      return;
    }
    rewriteSnap = { from: snap.from, to: snap.to, original: snap.text };
    rewriteOutput = '';
  }

  async function runRewrite() {
    if (!rewriteSnap || !rewriteInstr.trim() || rewriteStreaming) return;
    if (!aiTalkSettings.value.apiKey) {
      rewriteError = 'Set an API key in Settings first.';
      return;
    }
    rewriteError = '';
    rewriteOutput = '';
    rewriteStreaming = true;

    try {
      const req = buildChatRequest({
        baseUrl: aiTalkSettings.value.baseUrl,
        apiKey: aiTalkSettings.value.apiKey,
        model: aiTalkSettings.value.model,
        temperature: aiTalkSettings.value.temperature,
        messages: [
          {
            role: 'system',
            content:
              'You rewrite text per the user instruction. Return ONLY the rewritten text — no preamble, no markdown fences, no commentary.',
          },
          {
            role: 'user',
            content: `Instruction: ${rewriteInstr}\n\nText to rewrite:\n${rewriteSnap.original}`,
          },
        ],
      });
      rewriteStreamId = await startAiStream(req);
      for await (const ev of aiStream(rewriteStreamId)) {
        if (ev.kind === 'chunk') {
          const delta = parseChatDelta(ev.data);
          if (delta) rewriteOutput += delta;
        } else if (ev.kind === 'error') {
          rewriteError = `${ev.message}${ev.status ? ` (HTTP ${ev.status})` : ''}`;
        }
      }
    } catch (e) {
      rewriteError = e instanceof Error ? e.message : String(e);
    } finally {
      rewriteStreaming = false;
      rewriteStreamId = null;
    }
  }

  async function cancelRewrite() {
    if (rewriteStreamId) {
      const id = rewriteStreamId;
      rewriteStreamId = null;
      await cancelAiStream(id).catch(() => {});
    }
    rewriteStreaming = false;
  }

  function acceptRewrite() {
    if (!rewriteSnap || !rewriteOutput) return;
    replaceEditorRange(rewriteSnap.from, rewriteSnap.to, rewriteOutput);
    rewriteSnap = null;
    rewriteOutput = '';
    rewriteInstr = '';
  }

  function rejectRewrite() {
    rewriteOutput = '';
  }

  // Open settings on mount if a request flag is set (used by "Configure" entry)
  onMount(() => {
    if (sessionStorage.getItem('novelist:ai-talk:open-settings') === '1') {
      sessionStorage.removeItem('novelist:ai-talk:open-settings');
      settingsOpen = true;
    }
  });
</script>

<main>
  <header>
    <div class="tabs">
      <button class:active={activeTab === 'chat'} onclick={() => (activeTab = 'chat')}>Chat</button>
      <button class:active={activeTab === 'rewrite'} onclick={() => (activeTab = 'rewrite')}>Rewrite</button>
    </div>
    <button class="gear" title="Settings" onclick={() => (settingsOpen = !settingsOpen)}>⚙</button>
  </header>

  {#if settingsOpen}
    <section class="settings-drawer">
      <AiTalkSettings compact />
    </section>
  {/if}

  {#if activeTab === 'chat'}
    <div class="chat" bind:this={chatScroller}>
      {#each messages as m, i (i)}
        <div class="msg {m.role}">
          <div class="role">{m.role === 'user' ? 'You' : 'Assistant'}</div>
          <div class="content">{m.content}</div>
        </div>
      {/each}
      {#if messages.length === 0}
        <div class="empty">
          <p>Start a conversation. <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd> to send.</p>
        </div>
      {/if}
    </div>
    <div class="composer">
      <textarea
        rows="3"
        placeholder="Ask anything…"
        value={chatInput}
        oninput={(e) => (chatInput = e.currentTarget.value)}
        onkeydown={chatKeydown}
      ></textarea>
      <div class="composer-actions">
        <button class="ghost" onclick={clearChat} disabled={chatStreaming}>Clear</button>
        {#if chatStreaming}
          <button class="primary" onclick={cancelChat}>Stop</button>
        {:else}
          <button class="primary" onclick={sendChat} disabled={!chatInput.trim()}>Send</button>
        {/if}
      </div>
    </div>
  {:else}
    <div class="rewrite">
      <div class="row">
        <button class="primary" onclick={captureSelection}>Use current selection</button>
        {#if rewriteSnap}
          <span class="meta">{rewriteSnap.original.length} chars</span>
        {/if}
      </div>
      {#if rewriteSnap}
        <details open>
          <summary>Original</summary>
          <pre>{rewriteSnap.original}</pre>
        </details>
        <textarea
          rows="2"
          placeholder="Instruction (e.g. 'tighten this paragraph', 'translate to Chinese')"
          value={rewriteInstr}
          oninput={(e) => (rewriteInstr = e.currentTarget.value)}
        ></textarea>
        <div class="row">
          {#if rewriteStreaming}
            <button class="primary" onclick={cancelRewrite}>Stop</button>
          {:else}
            <button class="primary" onclick={runRewrite} disabled={!rewriteInstr.trim()}>Rewrite</button>
          {/if}
        </div>
      {/if}
      {#if rewriteOutput}
        <details open>
          <summary>Rewritten</summary>
          <pre>{rewriteOutput}</pre>
        </details>
        <div class="row">
          <button class="primary" onclick={acceptRewrite} disabled={rewriteStreaming}>Accept &amp; replace</button>
          <button class="ghost" onclick={rejectRewrite} disabled={rewriteStreaming}>Discard</button>
        </div>
      {/if}
      {#if rewriteError}
        <div class="banner">{rewriteError}</div>
      {/if}
    </div>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    color: var(--novelist-text);
    background: var(--novelist-bg);
    font-size: 13px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    border-bottom: 1px solid var(--novelist-border);
    background: var(--novelist-bg-secondary);
  }
  .tabs {
    display: flex;
    gap: 4px;
  }
  .tabs button {
    background: none;
    border: 1px solid transparent;
    padding: 4px 10px;
    border-radius: 4px;
    color: var(--novelist-text-secondary);
    cursor: pointer;
    font-size: 12px;
  }
  .tabs button.active {
    color: var(--novelist-text);
    border-color: var(--novelist-border);
    background: var(--novelist-bg);
  }
  .gear {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 16px;
    color: var(--novelist-text-secondary);
  }
  .settings-drawer {
    padding: 10px;
    background: var(--novelist-bg-secondary);
    border-bottom: 1px solid var(--novelist-border);
  }
  .banner {
    background: color-mix(in srgb, orange 20%, var(--novelist-bg));
    color: var(--novelist-text);
    padding: 6px 10px;
    font-size: 12px;
    border-radius: 4px;
  }
  .chat {
    flex: 1;
    overflow-y: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .msg {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .msg .role {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--novelist-text-secondary);
  }
  .msg .content {
    white-space: pre-wrap;
    word-wrap: break-word;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--novelist-bg-secondary);
  }
  .msg.user .content {
    background: var(--novelist-accent);
    color: #fff;
    align-self: flex-end;
    max-width: 85%;
  }
  .empty {
    color: var(--novelist-text-secondary);
    text-align: center;
    margin-top: 30%;
    font-size: 12px;
  }
  kbd {
    background: var(--novelist-bg-secondary);
    border: 1px solid var(--novelist-border);
    border-radius: 3px;
    padding: 1px 4px;
    font-size: 11px;
  }
  .composer {
    border-top: 1px solid var(--novelist-border);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--novelist-bg-secondary);
  }
  .composer textarea {
    width: 100%;
    box-sizing: border-box;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    color: var(--novelist-text);
    border-radius: 4px;
    padding: 6px 8px;
    font: inherit;
    resize: vertical;
  }
  .composer-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  button.primary {
    background: var(--novelist-accent);
    color: #fff;
    border: none;
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }
  button.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.ghost {
    background: none;
    color: var(--novelist-text-secondary);
    border: 1px solid var(--novelist-border);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }
  .rewrite {
    flex: 1;
    overflow-y: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .rewrite .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .rewrite .meta {
    font-size: 11px;
    color: var(--novelist-text-secondary);
  }
  .rewrite textarea {
    width: 100%;
    box-sizing: border-box;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    color: var(--novelist-text);
    border-radius: 4px;
    padding: 6px 8px;
    font: inherit;
    resize: vertical;
  }
  .rewrite details {
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
  }
  .rewrite summary {
    cursor: pointer;
    padding: 4px 8px;
    font-size: 11px;
    color: var(--novelist-text-secondary);
    background: var(--novelist-bg-secondary);
    user-select: none;
  }
  .rewrite pre {
    margin: 0;
    padding: 8px;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-family: inherit;
    font-size: 12px;
  }
</style>
