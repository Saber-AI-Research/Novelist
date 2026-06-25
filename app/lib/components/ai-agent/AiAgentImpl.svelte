<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { aiAgentSettings } from './settings.svelte';
  import {
    detectClaudeCli,
    detectCodexCli,
    killClaudeSession,
    killCodexSession,
    type DetectedCli,
  } from './host';
  import { ClaudeRuntime, runtimeFor } from './runtime';
  import { projectStore, type FileNode } from '$lib/stores/project.svelte';
  import AiAgentSettings from './AiAgentSettings.svelte';
  import SessionTabs from '$lib/components/ai-shared/SessionTabs.svelte';
  import AiComposer from '$lib/components/ai-shared/AiComposer.svelte';
  import ApplyChangesCard from '$lib/components/ai-shared/ApplyChangesCard.svelte';
  import {
    buildPromptFromAttachments,
    createAttachmentFromContext,
    displayTextFromInput,
    type AiContextAttachment,
  } from '$lib/components/ai-shared/attachments';
  import {
    BUILTIN_SKILLS,
    commandInstruction,
    parseSkillTokens,
    parseSlashCommand,
    resolveMentionContexts,
    skillAssetsForTokens,
    type SlashCommandId,
  } from '$lib/components/ai-shared/context';
  import {
    parseChangeSetsFromText,
    validateFileChange,
    type AiFileChange,
  } from '$lib/components/ai-shared/apply-change-set';
  import {
    deleteAiSession,
    listAiPromptAssets,
    listAiSessions,
    readAiSession,
    writeAiSession,
    type AiPromptAsset,
  } from '$lib/components/ai-shared/persistence';
  import { aiAgentSessions, type ApplyChangesCard as ApplyChangesCardState, type Turn } from './sessions.svelte';
  import { assistantParts } from './render-parts';
  import { commands } from '$lib/ipc/commands';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import type { ClaudeStreamEvent } from './host';
  import { IconGear, IconTool, IconArrowInsert } from '../icons';

  let claudeDetected = $state<DetectedCli | null>(null);
  let codexDetected = $state<DetectedCli | null>(null);
  let detecting = $state(true);

  // A session is "live" (CLI spawned + listener attached) iff its
  // sessionUuid has an entry here. This is purely component-local —
  // sessions persist across reloads, the live subprocess state does not.
  const liveSessions = new Map<string, UnlistenFn>();
  // Codex (one-shot) listeners, keyed by sessionUuid. The channel is keyed by
  // the stable sessionUuid so a single subscription survives many one-shot
  // children; we attach lazily on the first turn and tear down on teardown.
  const codexListeners = new Map<string, UnlistenFn>();
  // Codex sessions with a turn currently streaming, keyed by session.id.
  // Reactive so the composer busy state + live badge update.
  let turnInFlight = $state(new Set<string>());
  // Sessions currently mid-spawn, keyed by session.id. Prevents racing
  // spawns when send() is called twice in rapid succession.
  const spawning = new Set<string>();

  function setTurnInFlight(sessionId: string, on: boolean) {
    const next = new Set(turnInFlight);
    if (on) next.add(sessionId); else next.delete(sessionId);
    turnInFlight = next;
  }
  const SUPPORTED_CONTEXT_EXTENSIONS = new Set(['.md', '.txt', '.canvas', '.kanban']);

  let input = $state('');
  let error = $state<string | null>(null);
  let scroller = $state<HTMLDivElement | undefined>(undefined);
  let settingsOpen = $state(false);
  let saveStatus = $state<string | null>(null);
  let attachments = $state<AiContextAttachment[]>([]);
  let promptAssets = $state<AiPromptAsset[]>([...BUILTIN_SKILLS]);
  let projectSessionsLoaded = $state(false);

  // Active session turns — re-derived on session switch.
  let activeSession = $derived(aiAgentSessions.active);
  let activeId = $derived(aiAgentSessions.activeId);
  let turns = $derived<Turn[]>(activeSession?.turns ?? []);
  let activeProvider = $derived(activeSession?.providerId ?? aiAgentSettings.value.providerId);
  // `isLive` = the session's CLI process is alive/persisted (drives the header
  // "● live" badge). For persistent providers (Claude) the process is spawned
  // once and kept alive across many turns, so this stays true between turns.
  let isLive = $derived(
    activeSession
      ? (runtimeFor(activeSession.providerId).capabilities.persistent
          ? liveSessions.has(activeSession.sessionUuid)
          : turnInFlight.has(activeSession.id))
      : false,
  );
  // `busy` = a turn is currently streaming (drives the composer Send/Stop
  // toggle). Distinct from `isLive`: a persistent CLI stays live *between*
  // turns, but the composer must return to "Send" once a turn's `result`
  // arrives so the user can send the next message. Keyed on `turnInFlight`,
  // which is now set for both one-shot (Codex) and persistent (Claude) turns.
  let busy = $derived(activeSession ? turnInFlight.has(activeSession.id) : false);
  // Provider-aware CLI detection + configured-path fallback for the warning row.
  let detected = $derived(activeProvider === 'codex' ? codexDetected : claudeDetected);
  let effectiveCliPath = $derived(
    activeProvider === 'codex' ? aiAgentSettings.value.codexCliPath : aiAgentSettings.value.cliPath,
  );
  let agentMode = $derived(activeSession?.mode ?? 'act');
  // No trailing trim: a trailing space (inserted after picking a command)
  // must close the menu so Enter/Tab go back to normal typing.
  let commandMenuVisible = $derived(/^\s*\/[a-z-]*$/.test(input));
  let commandQuery = $derived(input.trim().startsWith('/') ? input.trim().slice(1) : '');
  let mentionMenuVisible = $derived(/(^|\s)@[^\s]*$/.test(input));
  let mentionQuery = $derived((/(?:^|\s)@([^\s]*)$/.exec(input)?.[1] ?? '').toLowerCase());
  let mentionCandidates = $derived(buildMentionCandidates());

  onMount(async () => {
    aiAgentSessions.ensureOne();
    [claudeDetected, codexDetected] = await Promise.all([
      detectClaudeCli().catch(() => null),
      detectCodexCli().catch(() => null),
    ]);
    detecting = false;
    void loadProjectSessions();
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
    for (const [uuid, unlisten] of codexListeners.entries()) {
      try { unlisten(); } catch { /* ignore */ }
      await killCodexSession(uuid).catch(() => {});
    }
    codexListeners.clear();
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
        // Stamp the current text length so the renderer can place this card
        // right after the text that preceded it (and before any text streamed
        // afterward).
        cards.push({ kind: 'tool', name: b.name, input: b.input, textOffset: text.length });
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
    base[idx] = { ...cur, cards: [...cur.cards, { kind: 'tool-result', content, textOffset: cur.text.length }] };
    aiAgentSessions.updateTurns(sessionId, base);
    scrollDown();
  }

  function applyResult(
    sessionId: string,
    text: string,
    cost?: number,
    usage?: { input: number; output: number },
  ) {
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const { idx, turns: base } = ensureAssistantTurn(s.turns);
    const cur = base[idx] as Extract<Turn, { role: 'assistant' }>;
    const finalText = text && text.length > cur.text.length ? text : cur.text;
    const changeSets = parseChangeSetsFromText(finalText, { sourceSessionId: sessionId });
    const cards = changeSets.length > 0
      ? [...cur.cards, ...changeSets.map((changeSet) => ({ kind: 'apply-changes' as const, changeSet, textOffset: finalText.length }))]
      : cur.cards;
    base[idx] = { ...cur, text: finalText, cards, cost, usage: usage ?? cur.usage };
    aiAgentSessions.updateTurns(sessionId, base, cost);
    void persistProjectSessions();
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
      await ClaudeRuntime.spawn({
        sessionUuid: s.sessionUuid,
        cwd,
        cliPath: settings.cliPath || undefined,
        systemPrompt: settings.systemPrompt || undefined,
        model: settings.model || undefined,
        permissionMode: s.mode === 'plan' ? 'plan' : settings.permissionMode,
        addDirs: settings.attachProjectRoot && cwd ? [cwd] : [],
        // The CLI refuses to re-create a --session-id it already knows, so
        // once this uuid has produced output we must resume, not re-create.
        resume: s.providerState?.claudeStarted === true,
      });
      const unlisten = await ClaudeRuntime.listen(s.sessionUuid, (ev) =>
        handleStreamEvent(sessionId, ev),
      );
      liveSessions.set(s.sessionUuid, unlisten);
      return s.sessionUuid;
    } finally {
      spawning.delete(sessionId);
    }
  }

  /**
   * Ensure a Codex (one-shot) session has its stream listener attached. The
   * channel is keyed by the stable sessionUuid, so one subscription covers
   * every per-turn child process the Rust bridge spawns.
   */
  async function ensureListening(sessionId: string): Promise<void> {
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    if (!s || codexListeners.has(s.sessionUuid)) return;
    const runtime = runtimeFor(s.providerId);
    const unlisten = await runtime.listen(s.sessionUuid, (ev) =>
      handleStreamEvent(sessionId, ev),
    );
    codexListeners.set(s.sessionUuid, unlisten);
  }

  function addAttachments(items: AiContextAttachment[]) {
    const seen = new Set(attachments.map((item) => item.id));
    attachments = [...attachments, ...items.filter((item) => !seen.has(item.id))];
  }

  function removeAttachment(id: string) {
    attachments = attachments.filter((item) => item.id !== id);
  }

  function clearAttachments() {
    attachments = [];
  }

  function pickCommand(id: SlashCommandId) {
    input = `/${id} `;
  }

  async function pickMention(token: string, attachment?: AiContextAttachment) {
    if (attachment) {
      addAttachments([await hydrateAttachment(attachment)]);
      input = input.replace(/(^|\s)@[^\s]*$/, '$1').trimStart();
      return;
    }
    // Trailing space closes the mention menu after the pick.
    input = input.replace(/(^|\s)@[^\s]*$/, `$1${token} `);
  }

  function extension(path: string): string {
    const idx = path.lastIndexOf('.');
    return idx >= 0 ? path.slice(idx).toLowerCase() : '';
  }

  function flattenNodes(nodes: FileNode[]): FileNode[] {
    return nodes.flatMap((node) => [node, ...flattenNodes(node.children ?? [])]);
  }

  function buildMentionCandidates(): AiContextAttachment[] {
    const fileCandidates: AiContextAttachment[] = flattenNodes(projectStore.files)
      .filter((node) => !node.is_dir && SUPPORTED_CONTEXT_EXTENSIONS.has(extension(node.path)))
      .map((node) => ({
        id: `file:${node.path}`,
        kind: 'project-file',
        label: node.name,
        path: node.path,
        source: 'project',
        mode: 'full',
        content: '',
        estimatedChars: node.size ?? 0,
        truncated: false,
      }));
    const assetCandidates = promptAssets.map((asset) =>
      createAttachmentFromContext({
        id: `${asset.kind}:${asset.id}`,
        kind: 'manual-note',
        label: `${asset.kind === 'skill' ? 'Skill' : 'Command'}: ${asset.name}`,
        path: asset.path,
        content: asset.content,
      }),
    );
    const sessionCandidates: AiContextAttachment[] = aiAgentSessions.sessions
      .filter((session) => session.turns.length > 0)
      .map((session) => ({
        id: `session:${session.id}`,
        kind: 'session',
        label: `Session: ${session.title}`,
        source: 'session',
        mode: 'summary',
        content: session.turns.map((turn) =>
          turn.role === 'user'
            ? `USER: ${turn.displayText ?? turn.text}`
            : `ASSISTANT: ${turn.text}`,
        ).join('\n\n'),
        estimatedChars: session.title.length,
        truncated: false,
      }));
    return [...fileCandidates, ...assetCandidates, ...sessionCandidates];
  }

  async function hydrateAttachment(attachment: AiContextAttachment): Promise<AiContextAttachment> {
    if (attachment.kind !== 'project-file' || attachment.content || !attachment.path) return attachment;
    const result = await commands.readFile(attachment.path);
    if (result.status === 'error') return attachment;
    return {
      ...attachment,
      content: result.data,
      estimatedChars: result.data.length,
    };
  }

  async function setActiveMode(mode: 'act' | 'plan') {
    const s = activeSession;
    if (!s) return;
    const runtime = runtimeFor(s.providerId);
    if (runtime.capabilities.persistent) {
      // Claude bakes the mode into spawn flags, so drop the live process; the
      // next send re-spawns with the new permission-mode.
      const wasLive = liveSessions.get(s.sessionUuid);
      wasLive?.();
      liveSessions.delete(s.sessionUuid);
    } else {
      setTurnInFlight(s.id, false);
    }
    await runtime.kill(s.sessionUuid).catch(() => {});
    aiAgentSessions.setMode(s.id, mode);
    await persistProjectSessions();
  }

  async function stopActiveSession() {
    const s = activeSession;
    if (!s) return;
    const runtime = runtimeFor(s.providerId);
    if (runtime.capabilities.persistent) {
      const fn = liveSessions.get(s.sessionUuid);
      fn?.();
      liveSessions.delete(s.sessionUuid);
    }
    // Clear in-flight for both providers so the composer flips back to Send.
    setTurnInFlight(s.id, false);
    await runtime.cancel(s.sessionUuid).catch(() => {});
    aiAgentSessions.markInterrupted(s.id);
    await persistProjectSessions();
  }

  async function compactAgentSession() {
    const s = activeSession;
    if (!s || s.turns.length < 2) {
      saveStatus = 'Need a longer session to compact.';
      setTimeout(() => (saveStatus = null), 2500);
      return;
    }
    const summary = [
      'Session compacted. Preserve these working notes for future turns:',
      '',
      ...s.turns.slice(-12).map((turn) =>
        turn.role === 'user'
          ? `USER: ${turn.displayText ?? turn.text}`
          : `CLAUDE: ${turn.text || turn.cards.map((c) => c.kind).join(', ')}`,
      ),
    ].join('\n');
    aiAgentSessions.compactActive(summary);
    await persistProjectSessions();
  }

  async function handleSpecialAgentCommand(commandId: string): Promise<boolean> {
    if (commandId === 'clear') {
      if (activeId) aiAgentSessions.clearTurns(activeId);
      await persistProjectSessions();
      return true;
    }
    if (commandId === 'save') {
      await saveAgentToProject();
      return true;
    }
    if (commandId === 'compact') {
      await compactAgentSession();
      return true;
    }
    if (commandId === 'plan') {
      await setActiveMode('plan');
      return true;
    }
    if (commandId === 'act') {
      await setActiveMode('act');
      return true;
    }
    return false;
  }

  /** Drop the live listener + map entry for a CLI process that's gone. */
  function dropLive(uuid: string) {
    const fn = liveSessions.get(uuid);
    fn?.();
    liveSessions.delete(uuid);
  }

  /** Remember that the CLI created this conversation → future spawns resume. */
  function markClaudeStarted(sessionId: string) {
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    if (s && s.providerState?.claudeStarted !== true) {
      aiAgentSessions.patchProviderState(sessionId, { claudeStarted: true });
    }
  }

  /** Persist Codex's thread id so the NEXT turn resumes the same conversation. */
  function markCodexThread(sessionId: string, threadId: string) {
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    if (s && s.providerState?.codexThreadId !== threadId) {
      aiAgentSessions.patchProviderState(sessionId, { codexThreadId: threadId });
    }
  }

  /** Finalize a one-shot Codex turn (idempotent). */
  function finishCodexTurn(sessionId: string, opts?: { interrupted?: boolean }) {
    if (!turnInFlight.has(sessionId)) return; // already finalized
    setTurnInFlight(sessionId, false);
    if (opts?.interrupted) aiAgentSessions.markInterrupted(sessionId);
  }

  function handleStreamEvent(
    sessionId: string,
    ev: ClaudeStreamEvent,
  ) {
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    const runtime = runtimeFor(s?.providerId ?? 'claude');
    const persistent = runtime.capabilities.persistent;

    if (ev.kind === 'stderr-line') {
      const line = ev.data.trim();
      if (!line) return;
      // Codex prints benign operational chatter (e.g. "Reading additional
      // input from stdin…") to stderr — only surface genuine failures.
      if (persistent || /\b(error|panic|fatal|failed|denied|refused)\b/i.test(line)) {
        error = line;
      }
      return;
    }
    if (ev.kind === 'exit') {
      if (persistent) {
        // The CLI for this session exited. Drop the listener; the next
        // send() will re-spawn (resuming) with the same sessionUuid. Clear any
        // in-flight turn so the composer doesn't stay stuck on Stop.
        if (s) dropLive(s.sessionUuid);
        if (turnInFlight.has(sessionId)) setTurnInFlight(sessionId, false);
      } else {
        // One-shot turn ended. If it never reported turn.completed, the turn
        // was interrupted (crash / kill); otherwise this is a no-op.
        finishCodexTurn(sessionId, { interrupted: true });
      }
      return;
    }
    if (ev.kind === 'error') {
      error = ev.message;
      if (persistent) setTurnInFlight(sessionId, false);
      else finishCodexTurn(sessionId, { interrupted: true });
      return;
    }
    if (ev.kind === 'stdout-line') {
      const parsed = runtime.parseEvent(ev.data);
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
          if (persistent) markClaudeStarted(sessionId);
          applyResult(sessionId, parsed.text, parsed.cost, parsed.usage);
          // The turn finished streaming — clear in-flight so the composer
          // returns to Send. Codex routes through finishCodexTurn (which also
          // handles its interrupted/exit bookkeeping); Claude clears directly.
          if (persistent) setTurnInFlight(sessionId, false);
          else finishCodexTurn(sessionId);
          break;
        case 'system':
          // The init frame means the CLI persisted this session id.
          markClaudeStarted(sessionId);
          break;
        case 'session':
          // Codex thread id — capture immediately so the next turn resumes.
          markCodexThread(sessionId, parsed.threadId);
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

    const slash = parseSlashCommand(text);
    if (slash && await handleSpecialAgentCommand(slash.id)) {
      return;
    }

    const mentionContexts = await resolveMentionContexts(text);
    const skillTokens = parseSkillTokens(text);
    const skillAttachments = skillAssetsForTokens(skillTokens, promptAssets).map((skill) =>
      createAttachmentFromContext({
        id: `skill:${skill.id}`,
        kind: 'manual-note',
        label: `Skill: ${skill.name}`,
        path: skill.path,
        content: skill.content,
      }),
    );
    const mentionAttachments = mentionContexts.map(createAttachmentFromContext);
    const turnAttachments = [...attachments, ...mentionAttachments, ...skillAttachments];
    if (mentionAttachments.length > 0 || skillAttachments.length > 0) {
      addAttachments([...mentionAttachments, ...skillAttachments]);
    }
    const displayText = displayTextFromInput(slash ? slash.rest || text : text);
    const instruction = commandInstruction(slash);
    const userText = instruction
      ? `${instruction}\n\nUser request: ${displayText || slash?.rest || text}`
      : displayText || text;
    const packed = buildPromptFromAttachments(userText, turnAttachments);
    const outbound = packed.outboundText;

    // Append user turn immediately (snappy UX).
    aiAgentSessions.updateTurns(sessionId, [
      ...s.turns,
      {
        role: 'user',
        text: outbound,
        displayText: displayText || text,
        attachments: packed.attachments.map((item) => ({
          id: item.id,
          label: item.label,
          kind: item.kind,
          path: item.path,
        })),
      },
    ]);
    await persistProjectSessions();
    scrollDown();

    const runtime = runtimeFor(s.providerId);
    const settings = aiAgentSettings.value;
    const cwd = projectStore.dirPath ?? null;

    if (!runtime.capabilities.persistent) {
      // ── One-shot provider (Codex): each turn is a fresh `codex exec`. ──
      if (turnInFlight.has(sessionId)) {
        error = 'A Codex turn is already running for this session.';
        return;
      }
      try {
        await ensureListening(sessionId);
        setTurnInFlight(sessionId, true);
        await runtime.runTurn!({
          sessionUuid: s.sessionUuid,
          prompt: outbound,
          cwd,
          cliPath: settings.codexCliPath || undefined,
          model: settings.codexModel || undefined,
          // Plan mode is read-only; Act lets Codex modify the workspace.
          sandbox: s.mode === 'plan' ? 'read-only' : 'workspace-write',
          addDirs: settings.attachProjectRoot && cwd ? [cwd] : [],
          // Read the latest persisted thread id at call time (not a stale closure).
          resumeThreadId:
            (aiAgentSessions.sessions.find((x) => x.id === sessionId)?.providerState
              ?.codexThreadId as string | undefined) ?? null,
        });
      } catch (e) {
        setTurnInFlight(sessionId, false);
        error = e instanceof Error ? e.message : String(e);
      }
      return;
    }

    // ── Persistent provider (Claude): spawn-once, send-many over stdin. ──
    // Mark the turn in-flight so the composer shows Stop and blocks re-sends
    // until the streamed `result` (or an exit/error) finalizes it. The CLI
    // process itself stays alive between turns — that's `isLive`, not `busy`.
    if (turnInFlight.has(sessionId)) {
      error = 'A turn is already running for this session.';
      return;
    }
    setTurnInFlight(sessionId, true);
    try {
      const uuid = await ensureLive(sessionId);
      if (!uuid) throw new Error('Failed to spawn Claude CLI');
      try {
        await runtime.send(uuid, outbound);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!message.includes('Unknown claude session')) throw e;
        // The CLI exited between turns and its backend entry is gone while
        // our live map still points at it. Re-spawn (resume) and retry once.
        dropLive(uuid);
        const fresh = await ensureLive(sessionId);
        if (!fresh) throw e;
        await runtime.send(fresh, outbound);
      }
    } catch (e) {
      // The send never got off the ground — clear the in-flight flag so the
      // composer isn't stuck on Stop. A successful send leaves it set until
      // the `result` event clears it.
      setTurnInFlight(sessionId, false);
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function newSessionClicked() {
    aiAgentSessions.create();
    error = null;
    await persistProjectSessions();
  }

  function handleSessionSelect(id: string) {
    aiAgentSessions.setActive(id);
    error = null;
  }

  async function handleSessionDelete(id: string) {
    const s = aiAgentSessions.sessions.find((x) => x.id === id);
    if (s) {
      liveSessions.get(s.sessionUuid)?.();
      liveSessions.delete(s.sessionUuid);
      codexListeners.get(s.sessionUuid)?.();
      codexListeners.delete(s.sessionUuid);
      setTurnInFlight(id, false);
    }
    await aiAgentSessions.delete(id);
    if (aiAgentSessions.sessions.length === 0) aiAgentSessions.create();
    if (projectStore.dirPath) {
      await deleteAiSession(projectStore.dirPath, 'agent', id).catch(() => {});
    }
    await persistProjectSessions();
  }

  async function handleSessionRename(id: string, title: string) {
    aiAgentSessions.rename(id, title);
    await persistProjectSessions();
  }

  async function forkActiveSession() {
    const s = activeSession;
    if (!s) return;
    const nextId = aiAgentSessions.fork(s.id);
    if (nextId) {
      error = null;
      await persistProjectSessions();
    }
  }

  async function loadProjectSessions() {
    const projectDir = projectStore.dirPath;
    if (!projectDir || projectSessionsLoaded) return;
    projectSessionsLoaded = true;
    try {
      const assets = await listAiPromptAssets(projectDir);
      promptAssets = [...BUILTIN_SKILLS, ...assets.skills];
      if (assets.memory?.content) {
        addAttachments([
          createAttachmentFromContext({
            id: 'memory',
            kind: 'manual-note',
            label: 'Project memory',
            path: assets.memory.path,
            content: assets.memory.content,
          }),
        ]);
      }
      const files = await listAiSessions(projectDir, 'agent');
      if (files.length > 0) {
        const sessions = [];
        for (const file of files) {
          const raw = await readAiSession(projectDir, 'agent', file.id);
          if (raw) sessions.push(JSON.parse(raw));
        }
        if (sessions.length > 0) aiAgentSessions.replaceAll(sessions, aiAgentSessions.activeId);
      } else if (aiAgentSessions.sessions.length > 0) {
        await persistProjectSessions();
      }
    } catch (e) {
      console.warn('[ai-agent] failed to load project AI assets', e);
    }
  }

  async function persistProjectSessions() {
    const projectDir = projectStore.dirPath;
    if (!projectDir) return;
    await Promise.all(
      aiAgentSessions.sessions.map((session) =>
        writeAiSession(projectDir, 'agent', session.id, session).catch(() => {}),
      ),
    );
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
        lines.push('## You', '', t.displayText ?? t.text, '');
      } else {
        lines.push('## Claude', '');
        if (t.text) lines.push(t.text, '');
        for (const c of t.cards) {
          if (c.kind === 'tool') {
            const inputStr = typeof c.input === 'string' ? c.input : JSON.stringify(c.input, null, 2);
            lines.push(`> 🔧 **${c.name}**`, '', '```', inputStr, '```', '');
          } else if (c.kind === 'tool-result') {
            const body = c.content.length > 4000 ? c.content.slice(0, 4000) + '\n…' : c.content;
            lines.push('> ↳ tool result', '', '```', body, '```', '');
          } else if (c.kind === 'apply-changes') {
            lines.push('> Apply Changes', '', c.changeSet.summary, '');
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

  async function latestFileText(path: string): Promise<string | null> {
    const result = await commands.readFile(path);
    return result.status === 'ok' ? result.data : null;
  }

  async function writeFileText(path: string, text: string): Promise<void> {
    const result = await commands.writeFile(path, text);
    if (result.status === 'error') throw new Error(result.error);
  }

  function updateApplyCard(
    changeSetId: string,
    update: (card: ApplyChangesCardState) => ApplyChangesCardState,
  ) {
    const s = activeSession;
    if (!s) return;
    const turns = s.turns.map((turn) => {
      if (turn.role !== 'assistant') return turn;
      return {
        ...turn,
        cards: turn.cards.map((card) =>
          card.kind === 'apply-changes' && card.changeSet.id === changeSetId ? update(card) : card,
        ),
      };
    });
    aiAgentSessions.updateTurns(s.id, turns);
  }

  async function acceptApplyFile(changeSetId: string, file: AiFileChange) {
    const latest = await latestFileText(file.path);
    const valid = validateFileChange(file, latest);
    if (!valid.ok) {
      updateApplyCard(changeSetId, (card) => ({
        ...card,
        status: 'conflict',
        changeSet: {
          ...card.changeSet,
          files: card.changeSet.files.map((candidate) =>
            candidate.path === file.path ? { ...candidate, conflict: valid.reason } : candidate,
          ),
        },
      }));
      return;
    }
    await writeFileText(file.path, file.proposedText);
    updateApplyCard(changeSetId, (card) => ({ ...card, status: 'accepted' }));
  }

  function rejectApplyFile(changeSetId: string, file: AiFileChange) {
    updateApplyCard(changeSetId, (card) => ({
      ...card,
      status: 'rejected',
      changeSet: {
        ...card.changeSet,
        files: card.changeSet.files.filter((candidate) => candidate.path !== file.path),
      },
    }));
  }

  async function acceptApplyAll(changeSetId: string) {
    const s = activeSession;
    if (!s) return;
    const applyCards = s.turns.flatMap((turn) => turn.role === 'assistant' ? turn.cards : [])
      .filter((card): card is ApplyChangesCardState =>
        card.kind === 'apply-changes' && card.changeSet.id === changeSetId,
      );
    for (const card of applyCards) {
      for (const file of card.changeSet.files) await acceptApplyFile(changeSetId, file);
    }
  }

  function rejectApplyAll(changeSetId: string) {
    updateApplyCard(changeSetId, (card) => ({ ...card, status: 'rejected' }));
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

  function proposedPlan(text: string): string | null {
    const match = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/i.exec(text);
    return match?.[1]?.trim() || null;
  }

  function assistantBody(text: string): string {
    return text.replace(/<proposed_plan>[\s\S]*?<\/proposed_plan>/gi, '').trim();
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
      <span class:plan={agentMode === 'plan'} class="badge mode" data-testid="ai-agent-mode-badge">
        {agentMode}
      </span>
      {#if isLive}
        <span class="badge live" title={activeSession?.sessionUuid.slice(0, 8)}>● live</span>
      {:else if detecting}
        <span class="badge pending">detecting</span>
      {:else if !detected && !effectiveCliPath}
        <span class="badge bad">no CLI</span>
      {:else}
        <span class="badge idle">idle</span>
      {/if}
      {#if activeSession?.interrupted}
        <span class="badge interrupted">interrupted</span>
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

  {#if !detecting && !detected && !effectiveCliPath}
    <div class="empty">
      {#if activeProvider === 'codex'}
        <p class="empty-title">Codex CLI not found</p>
        <p>
          This session uses a locally installed <code>codex</code> binary. Install Codex and run
          <code>codex login</code>, then reload — or open Settings and set an absolute path.
        </p>
        <p>
          <a href="https://github.com/openai/codex" target="_blank" rel="noreferrer">
            Install instructions →
          </a>
        </p>
      {:else}
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
      {/if}
    </div>
  {:else}
    <div class="conv" bind:this={scroller}>
      {#each turns as turn, i (i)}
        {#if turn.role === 'user'}
          <div class="turn user">
            <div class="role">You</div>
            <div class="text">{turn.displayText ?? turn.text}</div>
            {#if turn.attachments?.length}
              <div class="turn-attachments">
                {#each turn.attachments as item (item.id)}
                  <span title={item.path ?? item.label}>{item.label}</span>
                {/each}
              </div>
            {/if}
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
              {@const plan = proposedPlan(turn.text)}
              {#if plan}
                <div class="plan-card" data-testid="ai-agent-plan-card">
                  <div class="plan-title">Proposed plan</div>
                  <div>{plan}</div>
                </div>
              {/if}
            {/if}
            {#each assistantParts(turn) as part, pi (pi)}
              {#if part.kind === 'text'}
                {#if assistantBody(part.text)}
                  <div class="text">{assistantBody(part.text)}</div>
                {/if}
              {:else if part.card.kind === 'tool'}
                <details class="card tool">
                  <summary><span class="summary-icon"><IconTool size={12} /></span> {part.card.name}</summary>
                  <pre>{summarizeInput(part.card.input)}</pre>
                </details>
              {:else if part.card.kind === 'tool-result'}
                <details class="card tool-result">
                  <summary><span class="summary-icon"><IconArrowInsert size={12} /></span> result</summary>
                  <pre>{part.card.content.length > 4000 ? part.card.content.slice(0, 4000) + '\n…' : part.card.content}</pre>
                </details>
              {:else if part.card.kind === 'apply-changes'}
                {@const changeSet = part.card.changeSet}
                <ApplyChangesCard
                  {changeSet}
                  status={part.card.status}
                  onAcceptFile={(file) => acceptApplyFile(changeSet.id, file)}
                  onRejectFile={(file) => rejectApplyFile(changeSet.id, file)}
                  onAcceptAll={() => acceptApplyAll(changeSet.id)}
                  onRejectAll={() => rejectApplyAll(changeSet.id)}
                />
              {/if}
            {/each}
            {#if turn.usage}
              <div class="usage" title="Codex token usage">
                ↑{turn.usage.input.toLocaleString()} ↓{turn.usage.output.toLocaleString()} tokens
              </div>
            {/if}
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

    <AiComposer
      value={input}
      placeholder="Ask the agent... @current /plan $plot-doctor"
      attachments={attachments}
      mentionVisible={mentionMenuVisible}
      mentionQuery={mentionQuery}
      mentionCandidates={mentionCandidates}
      commandVisible={commandMenuVisible}
      commandQuery={commandQuery}
      busy={busy}
      canSend={Boolean(input.trim())}
      onInput={(value) => (input = value)}
      onSend={send}
      onStop={stopActiveSession}
      onPickMention={pickMention}
      onPickCommand={pickCommand}
      onRemoveAttachment={removeAttachment}
      onClearAttachments={clearAttachments}
    >
      {#snippet actions()}
        {#if saveStatus}
          <span class="save-status" data-testid="ai-agent-save-status">{saveStatus}</span>
        {/if}
        <button
          class="novelist-btn novelist-btn-ghost"
          data-testid="ai-agent-mode-toggle"
          onclick={() => setActiveMode(agentMode === 'plan' ? 'act' : 'plan')}
          title="Shift+Tab also toggles Plan/Act"
        >{agentMode === 'plan' ? 'Act' : 'Plan'}</button>
        <button
          class="novelist-btn novelist-btn-ghost"
          data-testid="ai-agent-fork"
          onclick={forkActiveSession}
          disabled={turns.length === 0}
          title="Fork this transcript into a new session"
        >Fork</button>
        <button
          class="novelist-btn novelist-btn-ghost"
          data-testid="ai-agent-save"
          onclick={saveAgentToProject}
          disabled={turns.length === 0}
          title="Save chat as markdown into &lt;project&gt;/.novelist/chats/"
        >Save</button>
      {/snippet}
    </AiComposer>
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
    font-size: 14px;
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
  .badge.mode {
    background: var(--novelist-bg);
    color: var(--novelist-text-secondary);
    border: 1px solid var(--novelist-border);
  }
  .badge.mode.plan {
    background: color-mix(in srgb, var(--novelist-accent) 16%, var(--novelist-bg));
    color: var(--novelist-accent);
    border-color: color-mix(in srgb, var(--novelist-accent) 45%, var(--novelist-border));
  }
  .badge.interrupted { background: #f59e0b; color: #111827; }
  .usage {
    margin-top: 4px;
    font-size: 10px;
    color: var(--novelist-text-secondary);
    opacity: 0.75;
    font-variant-numeric: tabular-nums;
  }
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
  .turn-attachments {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 4px;
    max-width: 85%;
    align-self: flex-end;
  }
  .turn-attachments span {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    padding: 2px 6px;
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text-secondary);
    font-size: 10px;
  }
  .plan-card {
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--novelist-accent) 45%, var(--novelist-border));
    border-radius: 4px;
    background: color-mix(in srgb, var(--novelist-accent) 10%, var(--novelist-bg));
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  .plan-title {
    margin-bottom: 4px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--novelist-accent);
    font-weight: 600;
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
  .save-status {
    font-size: 11px;
    color: var(--novelist-text-secondary);
    margin-right: auto;
    align-self: center;
    font-variant-numeric: tabular-nums;
  }
  /* Button styles live in app.css — .novelist-btn / -primary / -ghost. */
</style>
