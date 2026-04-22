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
  import SessionTabs from '$lib/components/ai-shared/SessionTabs.svelte';
  import { aiAgentSessions, type Turn } from './sessions.svelte';
  import { commands } from '$lib/ipc/commands';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import { IconGear, IconTool, IconArrowInsert } from '../icons';

  let detected = $state<DetectedCli | null>(null);
  let detecting = $state(true);

  // A session is "live" (CLI spawned + listener attached) iff its
  // sessionUuid has an entry here. This is purely component-local —
  // sessions persist across reloads, the live subprocess state does not.
  const liveSessions = new Map<string, UnlistenFn>();
  // Sessions currently mid-spawn, keyed by session.id. Prevents racing
  // spawns when send() is called twice in rapid succession.
  const spawning = new Set<string>();

  let input = $state('');
  let error = $state<string | null>(null);
  let scroller = $state<HTMLDivElement | undefined>(undefined);
  let settingsOpen = $state(false);
  let saveStatus = $state<string | null>(null);

  // Active session turns — re-derived on session switch.
  let activeSession = $derived(aiAgentSessions.active);
  let activeId = $derived(aiAgentSessions.activeId);
  let turns = $derived<Turn[]>(activeSession?.turns ?? []);
  let isLive = $derived(activeSession ? liveSessions.has(activeSession.sessionUuid) : false);

  onMount(async () => {
    aiAgentSessions.ensureOne();
    detected = await detectClaudeCli();
    detecting = false;
    if (sessionStorage.getItem('novelist:ai-agent:open-settings') === '1') {
      sessionStorage.removeItem('novelist:ai-agent:open-settings');
      settingsOpen = true;
    }
  });

  onDestroy(async () => {
    for (const [uuid, unlisten] of liveSessions.entries()) {
      try { unlisten(); } catch { /* ignore */ }
      await killClaudeSession(uuid).catch(() => {});
    }
    liveSessions.clear();
  });

  function ensureAssistantTurn(current: Turn[]): { idx: number; turns: Turn[] } {
    const last = current[current.length - 1];
    if (last && last.role === 'assistant') {
      return { idx: current.length - 1, turns: current };
    }
    const next = [...current, { role: 'assistant' as const, text: '', cards: [] }];
    return { idx: next.length - 1, turns: next };
  }

  function applyTextDelta(sessionId: string, text: string) {
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const { idx, turns: base } = ensureAssistantTurn(s.turns);
    const cur = base[idx] as Extract<Turn, { role: 'assistant' }>;
    base[idx] = { ...cur, text: cur.text + text };
    aiAgentSessions.updateTurns(sessionId, base);
    scrollDown();
  }

  function applyAssistantBlocks(
    sessionId: string,
    blocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; name: string; input: unknown }>,
  ) {
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const { idx, turns: base } = ensureAssistantTurn(s.turns);
    const cur = base[idx] as Extract<Turn, { role: 'assistant' }>;
    let text = cur.text;
    const cards = [...cur.cards];
    let textChanged = false;
    for (const b of blocks) {
      if (b.type === 'text') {
        if (b.text.length >= text.length) {
          text = b.text;
          textChanged = true;
        }
      } else if (b.type === 'tool_use') {
        cards.push({ kind: 'tool', name: b.name, input: b.input });
      }
    }
    base[idx] = { ...cur, text: textChanged ? text : cur.text, cards };
    aiAgentSessions.updateTurns(sessionId, base);
    scrollDown();
  }

  function applyToolResult(sessionId: string, content: string) {
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const { idx, turns: base } = ensureAssistantTurn(s.turns);
    const cur = base[idx] as Extract<Turn, { role: 'assistant' }>;
    base[idx] = { ...cur, cards: [...cur.cards, { kind: 'tool-result', content }] };
    aiAgentSessions.updateTurns(sessionId, base);
    scrollDown();
  }

  function applyResult(sessionId: string, text: string, cost?: number) {
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const { idx, turns: base } = ensureAssistantTurn(s.turns);
    const cur = base[idx] as Extract<Turn, { role: 'assistant' }>;
    const finalText = text && text.length > cur.text.length ? text : cur.text;
    base[idx] = { ...cur, text: finalText, cost };
    aiAgentSessions.updateTurns(sessionId, base, cost);
    scrollDown();
  }

  function scrollDown() {
    queueMicrotask(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  }

  /**
   * Ensure the given UI session has a live Claude CLI process + listener.
   * Re-spawns across panel reloads (the store keeps the sessionUuid stable
   * but the OS process dies with the host).
   */
  async function ensureLive(sessionId: string): Promise<string | null> {
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    if (!s) return null;
    if (liveSessions.has(s.sessionUuid)) return s.sessionUuid;
    if (spawning.has(sessionId)) {
      // Another caller is mid-spawn for this same session — poll briefly.
      while (spawning.has(sessionId) && !liveSessions.has(s.sessionUuid)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return liveSessions.has(s.sessionUuid) ? s.sessionUuid : null;
    }
    spawning.add(sessionId);
    try {
      const settings = aiAgentSettings.value;
      const cwd = projectStore.dirPath ?? null;
      await spawnClaudeSession({
        sessionUuid: s.sessionUuid,
        cwd,
        cliPath: settings.cliPath || undefined,
        systemPrompt: settings.systemPrompt || undefined,
        model: settings.model || undefined,
        permissionMode: settings.permissionMode,
        addDirs: settings.attachProjectRoot && cwd ? [cwd] : [],
      });
      const unlisten = await listenClaudeStream(s.sessionUuid, (ev) =>
        handleStreamEvent(sessionId, ev),
      );
      liveSessions.set(s.sessionUuid, unlisten);
      return s.sessionUuid;
    } finally {
      spawning.delete(sessionId);
    }
  }

  function handleStreamEvent(
    sessionId: string,
    ev: Parameters<Parameters<typeof listenClaudeStream>[1]>[0],
  ) {
    if (ev.kind === 'stderr-line') {
      if (ev.data.trim()) error = ev.data.trim();
      return;
    }
    if (ev.kind === 'exit') {
      // The CLI for this session exited. Drop the listener; the next
      // send() will re-spawn with the same sessionUuid.
      const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
      if (s) {
        const fn = liveSessions.get(s.sessionUuid);
        fn?.();
        liveSessions.delete(s.sessionUuid);
      }
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
          applyTextDelta(sessionId, parsed.text);
          break;
        case 'assistant-block':
          applyAssistantBlocks(sessionId, parsed.blocks);
          break;
        case 'tool-use':
          applyAssistantBlocks(sessionId, [{ type: 'tool_use', name: parsed.name, input: parsed.input }]);
          break;
        case 'tool-result':
          applyToolResult(sessionId, parsed.content);
          break;
        case 'result':
          applyResult(sessionId, parsed.text, parsed.cost);
          break;
        case 'system':
          break;
      }
    }
  }

  async function send() {
    const text = input.trim();
    if (!text) return;
    error = null;
    input = '';
    const sessionId = aiAgentSessions.ensureOne();
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    // Append user turn immediately (snappy UX).
    aiAgentSessions.updateTurns(sessionId, [...s.turns, { role: 'user', text }]);
    scrollDown();
    try {
      const uuid = await ensureLive(sessionId);
      if (!uuid) throw new Error('Failed to spawn Claude CLI');
      await sendToClaude(uuid, userInputLine(text));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function newSessionClicked() {
    aiAgentSessions.create();
    error = null;
  }

  function handleSessionSelect(id: string) {
    aiAgentSessions.setActive(id);
    error = null;
  }

  async function handleSessionDelete(id: string) {
    const s = aiAgentSessions.sessions.find((x) => x.id === id);
    if (s) {
      const fn = liveSessions.get(s.sessionUuid);
      fn?.();
      liveSessions.delete(s.sessionUuid);
    }
    await aiAgentSessions.delete(id);
    if (aiAgentSessions.sessions.length === 0) aiAgentSessions.create();
  }

  function handleSessionRename(id: string, title: string) {
    aiAgentSessions.rename(id, title);
  }

  // -------- Save current session to project as markdown --------

  function safeFilename(raw: string): string {
    return raw.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'agent';
  }

  function turnsToMarkdown(title: string, list: Turn[]): string {
    const iso = new Date().toISOString();
    const lines: string[] = [`# ${title}`, '', `_Exported from AI Agent · ${iso}_`, ''];
    for (const t of list) {
      if (t.role === 'user') {
        lines.push('## You', '', t.text, '');
      } else {
        lines.push('## Claude', '');
        if (t.text) lines.push(t.text, '');
        for (const c of t.cards) {
          if (c.kind === 'tool') {
            const inputStr = typeof c.input === 'string' ? c.input : JSON.stringify(c.input, null, 2);
            lines.push(`> 🔧 **${c.name}**`, '', '```', inputStr, '```', '');
          } else {
            const body = c.content.length > 4000 ? c.content.slice(0, 4000) + '\n…' : c.content;
            lines.push('> ↳ tool result', '', '```', body, '```', '');
          }
        }
        if (t.cost != null) lines.push(`_Cost: $${t.cost.toFixed(4)}_`, '');
      }
    }
    return lines.join('\n');
  }

  async function saveAgentToProject() {
    const s = activeSession;
    if (!s || s.turns.length === 0) {
      saveStatus = 'Nothing to save.';
      setTimeout(() => (saveStatus = null), 2500);
      return;
    }
    const projectDir = projectStore.dirPath;
    if (!projectDir) {
      saveStatus = 'Open a project first.';
      setTimeout(() => (saveStatus = null), 3000);
      return;
    }
    const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '');
    const filename = `${safeFilename(s.title)}-${stamp}.md`;
    const body = turnsToMarkdown(s.title, s.turns);
    try {
      const result = await commands.createFileWithBody(`${projectDir}/.novelist/chats`, filename, body);
      if (result.status === 'error') throw new Error(result.error);
      saveStatus = `Saved · .novelist/chats/${filename}`;
    } catch (e) {
      saveStatus = `Save failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    setTimeout(() => (saveStatus = null), 4000);
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
  <SessionTabs
    items={aiAgentSessions.sessions}
    activeId={activeId}
    onSelect={handleSessionSelect}
    onNew={newSessionClicked}
    onDelete={handleSessionDelete}
    onRename={handleSessionRename}
    testidPrefix="ai-agent-session"
    newLabel="New agent session"
  />
  <header>
    <div class="title">
      <span>AI Agent</span>
      {#if isLive}
        <span class="badge live" title={activeSession?.sessionUuid.slice(0, 8)}>● live</span>
      {:else if detecting}
        <span class="badge pending">detecting</span>
      {:else if !detected && !aiAgentSettings.value.cliPath}
        <span class="badge bad">no CLI</span>
      {:else}
        <span class="badge idle">idle</span>
      {/if}
    </div>
    <div class="actions">
      <button class="novelist-btn novelist-btn-quiet icon-btn" title="Settings" aria-label="Settings" onclick={() => (settingsOpen = !settingsOpen)}><IconGear size={14} /></button>
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
                  <summary><span class="summary-icon"><IconTool size={12} /></span> {c.name}</summary>
                  <pre>{summarizeInput(c.input)}</pre>
                </details>
              {:else}
                <details class="card tool-result">
                  <summary><span class="summary-icon"><IconArrowInsert size={12} /></span> result</summary>
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
        {#if saveStatus}
          <span class="save-status" data-testid="ai-agent-save-status">{saveStatus}</span>
        {/if}
        <button
          class="novelist-btn novelist-btn-ghost"
          data-testid="ai-agent-save"
          onclick={saveAgentToProject}
          disabled={turns.length === 0}
          title="Save chat as markdown into &lt;project&gt;/.novelist/chats/"
        >Save</button>
        <button class="novelist-btn novelist-btn-primary" onclick={send} disabled={!input.trim()}>Send</button>
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
  .card summary .summary-icon {
    display: inline-flex;
    vertical-align: -1px;
    margin-right: 2px;
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
  .save-status {
    font-size: 11px;
    color: var(--novelist-text-secondary);
    margin-right: auto;
    align-self: center;
    font-variant-numeric: tabular-nums;
  }
  /* Button styles live in app.css — .novelist-btn / -primary / -ghost. */
</style>
