<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { aiAgentSettings } from './settings.svelte';
  import {
    detectClaudeCli,
    spawnClaudeSession,
    sendToClaude,
    killClaudeSession,
    listenClaudeStream,
    parseClaudeLine,
    userInputLine,
    type DetectedCli,
  } from './host';
  import { projectStore } from '$lib/stores/project.svelte';
  import AiAgentSettings from './AiAgentSettings.svelte';
  import type { UnlistenFn } from '@tauri-apps/api/event';

  type ToolCard = { kind: 'tool'; name: string; input: unknown };
  type ToolResultCard = { kind: 'tool-result'; content: string };
  type Card = ToolCard | ToolResultCard;

  type Turn =
    | { role: 'user'; text: string }
    | { role: 'assistant'; text: string; cards: Card[]; cost?: number };

  let detected = $state<DetectedCli | null>(null);
  let detecting = $state(true);

  let sessionId: string | null = $state(null);
  let starting = $state(false);
  let unlisten: UnlistenFn | null = null;

  let turns = $state<Turn[]>([]);
  let input = $state('');
  let error = $state<string | null>(null);
  let scroller = $state<HTMLDivElement | undefined>(undefined);

  let settingsOpen = $state(false);

  // ----------- bring up the session lazily on first send ---------------

  onMount(async () => {
    detected = await detectClaudeCli();
    detecting = false;
    if (sessionStorage.getItem('novelist:ai-agent:open-settings') === '1') {
      sessionStorage.removeItem('novelist:ai-agent:open-settings');
      settingsOpen = true;
    }
  });

  onDestroy(async () => {
    unlisten?.();
    if (sessionId) {
      await killClaudeSession(sessionId).catch(() => {});
    }
  });

  function uuid(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return `ai-agent-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }

  function appendUserTurn(text: string) {
    turns = [...turns, { role: 'user', text }];
    scrollDown();
  }

  function ensureAssistantTurn(): number {
    const last = turns[turns.length - 1];
    if (last && last.role === 'assistant') {
      return turns.length - 1;
    }
    turns = [...turns, { role: 'assistant', text: '', cards: [] }];
    return turns.length - 1;
  }

  function applyTextDelta(text: string) {
    const idx = ensureAssistantTurn();
    const cur = turns[idx] as Extract<Turn, { role: 'assistant' }>;
    turns[idx] = { ...cur, text: cur.text + text };
    scrollDown();
  }

  function applyAssistantBlocks(blocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; name: string; input: unknown }>) {
    const idx = ensureAssistantTurn();
    const cur = turns[idx] as Extract<Turn, { role: 'assistant' }>;
    let text = cur.text;
    const cards = [...cur.cards];
    let textChanged = false;
    for (const b of blocks) {
      if (b.type === 'text') {
        // Replace if non-empty and different — full block usually arrives once
        // at end of streaming, may be redundant with deltas. Prefer the longer.
        if (b.text.length >= text.length) {
          text = b.text;
          textChanged = true;
        }
      } else if (b.type === 'tool_use') {
        cards.push({ kind: 'tool', name: b.name, input: b.input });
      }
    }
    turns[idx] = { ...cur, text: textChanged ? text : cur.text, cards };
    scrollDown();
  }

  function applyToolResult(content: string) {
    const idx = ensureAssistantTurn();
    const cur = turns[idx] as Extract<Turn, { role: 'assistant' }>;
    turns[idx] = { ...cur, cards: [...cur.cards, { kind: 'tool-result', content }] };
    scrollDown();
  }

  function applyResult(text: string, cost?: number) {
    const idx = ensureAssistantTurn();
    const cur = turns[idx] as Extract<Turn, { role: 'assistant' }>;
    const finalText = text && text.length > cur.text.length ? text : cur.text;
    turns[idx] = { ...cur, text: finalText, cost };
    scrollDown();
  }

  function scrollDown() {
    queueMicrotask(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  }

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;
    if (starting) {
      // Already starting — wait briefly
      while (starting && !sessionId) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (sessionId) return sessionId;
    }
    starting = true;
    try {
      const id = uuid();
      const settings = aiAgentSettings.value;
      const cwd = projectStore.dirPath ?? null;
      const newId = await spawnClaudeSession({
        sessionUuid: id,
        cwd,
        cliPath: settings.cliPath || undefined,
        systemPrompt: settings.systemPrompt || undefined,
        model: settings.model || undefined,
        permissionMode: settings.permissionMode,
        addDirs: settings.attachProjectRoot && cwd ? [cwd] : [],
      });
      sessionId = newId;
      unlisten = await listenClaudeStream(newId, handleStreamEvent);
      return newId;
    } finally {
      starting = false;
    }
  }

  function handleStreamEvent(ev: Parameters<Parameters<typeof listenClaudeStream>[1]>[0]) {
    if (ev.kind === 'stderr-line') {
      // Surface stderr in the error banner — but only for non-empty interesting lines.
      if (ev.data.trim()) error = ev.data.trim();
      return;
    }
    if (ev.kind === 'exit') {
      // Session ended; mark closed so next send starts a new one.
      sessionId = null;
      unlisten?.();
      unlisten = null;
      return;
    }
    if (ev.kind === 'error') {
      error = ev.message;
      return;
    }
    if (ev.kind === 'stdout-line') {
      const parsed = parseClaudeLine(ev.data);
      if (!parsed) return;
      switch (parsed.kind) {
        case 'text-delta':
          applyTextDelta(parsed.text);
          break;
        case 'assistant-block':
          applyAssistantBlocks(parsed.blocks);
          break;
        case 'tool-use':
          applyAssistantBlocks([{ type: 'tool_use', name: parsed.name, input: parsed.input }]);
          break;
        case 'tool-result':
          applyToolResult(parsed.content);
          break;
        case 'result':
          applyResult(parsed.text, parsed.cost);
          break;
        case 'system':
          // ignore boot-up info for now
          break;
      }
    }
  }

  async function send() {
    const text = input.trim();
    if (!text) return;
    error = null;
    input = '';
    appendUserTurn(text);
    try {
      const id = await ensureSession();
      await sendToClaude(id, userInputLine(text));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function newSession() {
    if (sessionId) {
      await killClaudeSession(sessionId).catch(() => {});
      sessionId = null;
      unlisten?.();
      unlisten = null;
    }
    turns = [];
    error = null;
  }

  function inputKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  }

  function summarizeInput(input: unknown): string {
    if (typeof input === 'string') return input;
    try {
      const s = JSON.stringify(input);
      return s.length > 240 ? s.slice(0, 240) + '…' : s;
    } catch {
      return String(input);
    }
  }
</script>

<main>
  <header>
    <div class="title">
      <span>AI Agent</span>
      {#if sessionId}
        <span class="badge live" title={`session ${sessionId.slice(0, 8)}`}>● live</span>
      {:else if detecting}
        <span class="badge pending">detecting</span>
      {:else if !detected}
        <span class="badge bad">no CLI</span>
      {:else}
        <span class="badge idle">idle</span>
      {/if}
    </div>
    <div class="actions">
      <button class="ghost" title="New session" onclick={newSession} disabled={!sessionId && turns.length === 0}>
        ↺
      </button>
      <button class="gear" title="Settings" onclick={() => (settingsOpen = !settingsOpen)}>⚙</button>
    </div>
  </header>

  {#if settingsOpen}
    <section class="settings-drawer">
      <AiAgentSettings compact />
    </section>
  {/if}

  {#if !detecting && !detected && !aiAgentSettings.value.cliPath}
    <div class="empty">
      <p class="empty-title">Claude Code CLI not found</p>
      <p>
        AI Agent uses a locally installed <code>claude</code> binary. Install Claude Code, then reload —
        or open Settings and set an absolute path.
      </p>
      <p>
        <a href="https://docs.claude.com/en/docs/claude-code/overview" target="_blank" rel="noreferrer">
          Install instructions →
        </a>
      </p>
    </div>
  {:else}
    <div class="conv" bind:this={scroller}>
      {#each turns as turn, i (i)}
        {#if turn.role === 'user'}
          <div class="turn user">
            <div class="role">You</div>
            <div class="text">{turn.text}</div>
          </div>
        {:else}
          <div class="turn assistant">
            <div class="role">
              Claude
              {#if turn.cost != null}
                <span class="cost">${turn.cost.toFixed(4)}</span>
              {/if}
            </div>
            {#if turn.text}
              <div class="text">{turn.text}</div>
            {/if}
            {#each turn.cards as c, ci (ci)}
              {#if c.kind === 'tool'}
                <details class="card tool">
                  <summary>🔧 {c.name}</summary>
                  <pre>{summarizeInput(c.input)}</pre>
                </details>
              {:else}
                <details class="card tool-result">
                  <summary>↳ result</summary>
                  <pre>{c.content.length > 4000 ? c.content.slice(0, 4000) + '\n…' : c.content}</pre>
                </details>
              {/if}
            {/each}
          </div>
        {/if}
      {/each}
      {#if turns.length === 0}
        <div class="hello">
          <p>
            {#if projectStore.dirPath}
              Session will spawn in <code>{projectStore.dirPath}</code> when you send.
            {:else}
              Open a project for full agent capabilities. Without a project, claude runs in its default cwd.
            {/if}
          </p>
        </div>
      {/if}
    </div>

    {#if error}
      <div class="banner">{error}</div>
    {/if}

    <div class="composer">
      <textarea
        rows="3"
        placeholder="Ask the agent…  (⌘/Ctrl+Enter to send)"
        value={input}
        oninput={(e) => (input = e.currentTarget.value)}
        onkeydown={inputKeydown}
      ></textarea>
      <div class="composer-actions">
        <button class="primary" onclick={send} disabled={!input.trim()}>Send</button>
      </div>
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
  .title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 500;
  }
  .badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .badge.live { background: #16a34a; color: #fff; }
  .badge.idle { background: var(--novelist-border); color: var(--novelist-text-secondary); }
  .badge.pending { background: var(--novelist-border); color: var(--novelist-text-secondary); }
  .badge.bad { background: #dc2626; color: #fff; }
  .actions {
    display: flex;
    gap: 4px;
  }
  .gear, .actions .ghost {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 14px;
    color: var(--novelist-text-secondary);
  }
  .actions .ghost:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .settings-drawer {
    padding: 10px;
    background: var(--novelist-bg-secondary);
    border-bottom: 1px solid var(--novelist-border);
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
    padding: 20px;
    gap: 8px;
    color: var(--novelist-text-secondary);
    font-size: 12px;
  }
  .empty-title {
    font-size: 14px;
    color: var(--novelist-text);
    margin: 0;
  }
  .empty a { color: var(--novelist-accent); text-decoration: underline; }
  .empty code {
    background: var(--novelist-bg-secondary);
    padding: 1px 4px;
    border-radius: 2px;
  }
  .conv {
    flex: 1;
    overflow-y: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .turn {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .role {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--novelist-text-secondary);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .role .cost {
    color: var(--novelist-text-secondary);
    font-weight: normal;
    font-size: 10px;
    text-transform: none;
    letter-spacing: 0;
  }
  .text {
    white-space: pre-wrap;
    word-wrap: break-word;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--novelist-bg-secondary);
  }
  .turn.user .text {
    background: var(--novelist-accent);
    color: #fff;
    align-self: flex-end;
    max-width: 85%;
  }
  .card {
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    background: var(--novelist-bg-secondary);
    overflow: hidden;
  }
  .card summary {
    cursor: pointer;
    padding: 4px 8px;
    font-size: 11px;
    color: var(--novelist-text-secondary);
    user-select: none;
  }
  .card pre {
    margin: 0;
    padding: 6px 10px;
    background: var(--novelist-bg);
    font-size: 11px;
    white-space: pre-wrap;
    word-wrap: break-word;
    max-height: 280px;
    overflow: auto;
  }
  .card.tool-result summary {
    color: color-mix(in srgb, var(--novelist-accent) 80%, var(--novelist-text-secondary));
  }
  .hello {
    color: var(--novelist-text-secondary);
    font-size: 12px;
    text-align: center;
    margin-top: 30%;
  }
  .hello code {
    background: var(--novelist-bg-secondary);
    padding: 1px 4px;
    border-radius: 2px;
  }
  .banner {
    margin: 0 8px 4px;
    padding: 6px 10px;
    background: color-mix(in srgb, #dc2626 20%, var(--novelist-bg));
    color: var(--novelist-text);
    font-size: 12px;
    border-radius: 4px;
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
</style>
