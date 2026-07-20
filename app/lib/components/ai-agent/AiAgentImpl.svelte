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
    isBuiltinSlashCommandName,
    isInvocableProjectCommandName,
    parseSkillTokens,
    parseSlashCommand,
    resolveMentionContexts,
    skillAssetsForTokens,
  } from '$lib/components/ai-shared/context';
  import {
    parseChangeSetsFromText,
    type AiFileChange,
  } from '$lib/components/ai-shared/apply-change-set';
  import {
    deleteAiSession,
    listAiPromptAssets,
    listAiSessions,
    readAiSession,
    writeAiSession,
    type AiPromptAssets,
  } from '$lib/components/ai-shared/persistence';
  import { aiChatBasename, saveAiChat } from '$lib/services/ai-chat';
  import { conditionalFileWrite } from '$lib/services/conditional-file-write';
  import {
    aiAgentSessions,
    sanitizeAgentProviderPayload,
    sanitizeAgentTurnFailureMessage,
    type AgentTurnFailureStage,
    type AgentSession,
    type AssistantTurn,
    type ApplyChangesCard as ApplyChangesCardState,
    type Turn,
    type UserTurn,
  } from './sessions.svelte';
  import {
    AiAgentProjectLifecycle,
    acquireAiAgentMountLease,
    applyFileIfCurrent,
    attachListenerIfCurrent,
    createAiAgentAttemptOwner,
    createAiSessionPersistenceQueue,
    isProjectScopedPath,
    mutateAndPersistForToken,
    startLiveSessionIfCurrent,
    type AiAgentAttempt,
    type AiAgentProjectToken,
  } from './lifecycle';
  import { assistantParts } from './render-parts';
  import {
    flushAiAgentNewSessionRequests,
    registerAiAgentNewSessionHandler,
    type AiAgentNewSessionRequest,
    type AiAgentNewSessionRequestResult,
  } from './new-session-requests';
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
  // One in-flight exchange per session. Mapping to a stable turn id keeps
  // retries and late stream events scoped to the assistant turn they own.
  let turnInFlight = $state(new Map<string, AiAgentAttempt>());
  // Sessions currently mid-spawn, keyed by session.id. Prevents racing
  // spawns when send() is called twice in rapid succession.
  const spawning = new Set<string>();
  const mountLease = acquireAiAgentMountLease();
  const persistenceQueue = createAiSessionPersistenceQueue();
  const attemptOwner = createAiAgentAttemptOwner();
  type CodexDrain = { attempt: AiAgentAttempt; promise: Promise<void>; resolve: () => void };
  const codexDrains = new Map<string, CodexDrain>();
  const retiringCodexDrains = new Map<string, Promise<void>>();

  function snapshotAgentSession(session: AgentSession): AgentSession {
    return JSON.parse(JSON.stringify(session)) as AgentSession;
  }

  async function mutateAndPersistAgentSession(
    token: AiAgentProjectToken,
    sessionId: string,
    mutate: () => void,
    rollback: (applied: AgentSession, previous: AgentSession) => void,
  ): Promise<boolean> {
    if (!isActiveToken(token)) return false;
    const current = aiAgentSessions.sessions.find((session) => session.id === sessionId);
    if (!current) return false;
    const previous = snapshotAgentSession(current);
    mutate();
    const applied = aiAgentSessions.sessions.find((session) => session.id === sessionId);
    if (!applied || !isActiveToken(token)) return false;
    try {
      await persistAgentSessionFor(token.projectDir, applied);
      return isActiveToken(token);
    } catch (cause) {
      if (isActiveToken(token)) rollback(applied, previous);
      throw cause;
    }
  }

  async function runRuntimeCleanup(label: string, operation: () => Promise<void>) {
    try {
      await operation();
    } catch (e) {
      console.warn(
        `[ai-agent] ${label} failed`,
        sanitizeAgentTurnFailureMessage(e instanceof Error ? e.message : String(e)),
      );
    }
  }

  async function detachListener(
    listeners: Map<string, UnlistenFn>,
    sessionUuid: string,
    label: string,
  ) {
    const unlisten = listeners.get(sessionUuid);
    listeners.delete(sessionUuid);
    if (unlisten) await runRuntimeCleanup(label, async () => { await unlisten(); });
  }

  function syncAttempt(sessionId: string, attempt: AiAgentAttempt | null) {
    const next = new Map(turnInFlight);
    if (attempt) next.set(sessionId, attempt); else next.delete(sessionId);
    turnInFlight = next;
  }

  function reserveAttempt(sessionId: string, turnId: string): AiAgentAttempt | null {
    const attempt = attemptOwner.claim(sessionId, turnId);
    if (attempt) syncAttempt(sessionId, attempt);
    return attempt;
  }

  function ownsAttempt(sessionId: string, attempt: AiAgentAttempt): boolean {
    return attemptOwner.owns(sessionId, attempt);
  }

  function ownsAttemptInPhase(
    sessionId: string,
    attempt: AiAgentAttempt,
    phase: AiAgentAttempt['phase'],
  ): boolean {
    const current = attemptOwner.current(sessionId);
    return current?.generation === attempt.generation && current.phase === phase;
  }

  function bindAttemptTurn(
    sessionId: string,
    attempt: AiAgentAttempt,
    turnId: string,
  ): AiAgentAttempt | null {
    const bound = attemptOwner.bindTurn(sessionId, attempt, turnId);
    if (bound) syncAttempt(sessionId, bound);
    return bound;
  }

  function markAttemptRunning(sessionId: string, attempt: AiAgentAttempt): AiAgentAttempt | null {
    const running = attemptOwner.markRunning(sessionId, attempt);
    if (running) syncAttempt(sessionId, running);
    return running;
  }

  function markAttemptCancelling(sessionId: string, attempt: AiAgentAttempt): AiAgentAttempt | null {
    const cancelling = attemptOwner.markCancelling(sessionId, attempt);
    if (cancelling) syncAttempt(sessionId, cancelling);
    return cancelling;
  }

  function releaseAttempt(sessionId: string, attempt: AiAgentAttempt): boolean {
    if (!attemptOwner.release(sessionId, attempt)) return false;
    syncAttempt(sessionId, null);
    return true;
  }

  function beginCodexDrain(sessionId: string, attempt: AiAgentAttempt) {
    if (codexDrains.has(sessionId)) return;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    codexDrains.set(sessionId, { attempt, promise, resolve });
  }

  function finishCodexDrain(sessionId: string, attempt?: AiAgentAttempt): boolean {
    const drain = codexDrains.get(sessionId);
    if (!drain || (attempt && drain.attempt.generation !== attempt.generation)) return false;
    codexDrains.delete(sessionId);
    drain.resolve();
    return true;
  }

  async function retireCodexDrain(
    sessionId: string,
    sessionUuid: string,
    attempt: AiAgentAttempt,
    cancelRuntime: boolean,
  ) {
    const retirementKey = `${sessionId}:${attempt.generation}`;
    const existing = retiringCodexDrains.get(retirementKey);
    if (existing) return existing;
    const retirement = (async () => {
      try {
        await detachListener(codexListeners, sessionUuid, 'Codex terminal listener cleanup');
        if (cancelRuntime) {
          await runRuntimeCleanup('Codex terminal runtime cleanup', () =>
            runtimeFor('codex').cancel(sessionUuid),
          );
        }
      } finally {
        finishCodexDrain(sessionId, attempt);
      }
    })();
    retiringCodexDrains.set(retirementKey, retirement);
    void retirement.then(() => {
      if (retiringCodexDrains.get(retirementKey) === retirement) {
        retiringCodexDrains.delete(retirementKey);
      }
    });
    return retirement;
  }

  async function waitForCodexDrain(sessionId: string, attempt: AiAgentAttempt): Promise<boolean> {
    const drain = codexDrains.get(sessionId);
    if (drain && drain.attempt.generation < attempt.generation) await drain.promise;
    return ownsAttempt(sessionId, attempt);
  }

  function clearCodexDrains() {
    for (const drain of codexDrains.values()) drain.resolve();
    codexDrains.clear();
    retiringCodexDrains.clear();
  }
  const SUPPORTED_CONTEXT_EXTENSIONS = new Set(['.md', '.txt', '.canvas', '.kanban']);

  let input = $state('');
  let error = $state<string | null>(null);
  let sessionActionError = $state<string | null>(null);
  let scroller = $state<HTMLDivElement | undefined>(undefined);
  let settingsOpen = $state(false);
  let saveStatus = $state<string | null>(null);
  let attachments = $state<AiContextAttachment[]>([]);
  type OwnedPromptAssets = { owner: AiAgentProjectToken; assets: AiPromptAssets };
  let ownedPromptAssets = $state<OwnedPromptAssets | null>(null);
  let lifecycleReady = $state(false);
  let predecessorReady = $state(false);
  let destroyed = false;
  let mountActivated = false;
  let unregisterNewSessionHandler: (() => void) | null = null;

  // Active session turns — re-derived on session switch.
  let activeSession = $derived(aiAgentSessions.active);
  let activeId = $derived(aiAgentSessions.activeId);
  let turns = $derived<Turn[]>(lifecycleReady ? (activeSession?.turns ?? []) : []);
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
  let commandMenuVisible = $derived(/^\s*\/[^\s/]*$/u.test(input));
  let commandQuery = $derived(input.trim().startsWith('/') ? input.trim().slice(1) : '');
  let mentionMenuVisible = $derived(/(^|\s)@[^\s]*$/.test(input));
  let mentionQuery = $derived((/(?:^|\s)@([^\s]*)$/.exec(input)?.[1] ?? '').toLowerCase());
  let mentionCandidates = $derived(buildMentionCandidates());

  onMount(async () => {
    unregisterNewSessionHandler = registerAiAgentNewSessionHandler(handleNewSessionRequest);
    void mountLease.predecessor.then(() => {
      if (destroyed || !mountLease.isCurrent()) return;
      mountActivated = true;
      predecessorReady = true;
    });
    [claudeDetected, codexDetected] = await Promise.all([
      detectClaudeCli().catch(() => null),
      detectCodexCli().catch(() => null),
    ]);
    detecting = false;
    if (sessionStorage.getItem('novelist:ai-agent:open-settings') === '1') {
      sessionStorage.removeItem('novelist:ai-agent:open-settings');
      settingsOpen = true;
    }
  });

  const projectLifecycle = new AiAgentProjectLifecycle({
    teardownProject,
    clearVolatileContext,
    loadProject: loadProjectSessionsFor,
    onLoadFailure(ctx, e) {
      if (destroyed || !isActiveToken(ctx)) return;
      const message = sanitizeAgentTurnFailureMessage(e instanceof Error ? e.message : String(e));
      error = `Failed to load AI Agent sessions for ${ctx.projectDir ?? 'this project'}: ${message}`;
    },
  });

  let renderablePromptAssets = $derived.by(() => {
    const owned = ownedPromptAssets;
    return owned
      && owned.owner.projectDir === projectStore.dirPath
      && projectLifecycle.isCurrent(owned.owner)
      ? owned.assets
      : null;
  });
  let skillPromptAssets = $derived([
    ...BUILTIN_SKILLS,
    ...(renderablePromptAssets?.skills ?? []),
  ]);
  let projectCommandAssets = $derived(
    (renderablePromptAssets?.commands ?? []).filter((asset) =>
      isInvocableProjectCommandName(asset.name) && !isBuiltinSlashCommandName(asset.name),
    ),
  );

  $effect(() => {
    const projectDir = projectStore.dirPath;
    projectStore.generation;
    lifecycleReady = false;
    if (!predecessorReady) return;
    const switching = projectLifecycle.switchTo(projectDir, true);
    input = '';
    attachments = [];
    ownedPromptAssets = emptyOwnedPromptAssets(projectLifecycle.capture());
    void switching
      .catch((e) => {
        if (!destroyed) {
          console.warn(
            '[ai-agent] project lifecycle switch failed',
            sanitizeAgentTurnFailureMessage(e instanceof Error ? e.message : String(e)),
          );
        }
      })
      .finally(() => {
        lifecycleReady = !destroyed && projectLifecycle.status.kind === 'ready';
        if (lifecycleReady) flushAiAgentNewSessionRequests();
      });
  });

  onDestroy(() => {
    unregisterNewSessionHandler?.();
    unregisterNewSessionHandler = null;
    destroyed = true;
    lifecycleReady = false;
    const token = projectLifecycle.invalidate();
    const loadedProjectDir = projectLifecycle.takeLoadedProjectForTeardown();
    const retirement = retireMount(
      { ...token, projectDir: loadedProjectDir },
      mountActivated,
    );
    void retirement.catch((error) => {
      console.warn(
        '[ai-agent] mount retirement failed',
        sanitizeAgentTurnFailureMessage(error instanceof Error ? error.message : String(error)),
      );
    });
    mountLease.retire(retirement);
  });

  function isActiveToken(token: AiAgentProjectToken): boolean {
    return !destroyed && projectLifecycle.isCurrent(token);
  }

  function applyTextDelta(sessionId: string, turnId: string, text: string) {
    aiAgentSessions.updateAssistantTurn(sessionId, turnId, (turn) => ({
      ...turn,
      text: turn.text + text,
    }));
    scrollDown();
  }

  function applyAssistantBlocks(
    sessionId: string,
    turnId: string,
    blocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; name: string; input: unknown }>,
  ) {
    aiAgentSessions.updateAssistantTurn(sessionId, turnId, (turn) => {
      let text = turn.text;
      const cards = [...turn.cards];
      let textChanged = false;
      for (const block of blocks) {
        if (block.type === 'text') {
          if (block.text.length >= text.length) {
            text = block.text;
            textChanged = true;
          }
        } else {
          cards.push({
            kind: 'tool',
            name: block.name,
            input: sanitizeAgentProviderPayload(block.input),
            textOffset: text.length,
          });
        }
      }
      return { ...turn, text: textChanged ? text : turn.text, cards };
    });
    scrollDown();
  }

  function applyToolResult(sessionId: string, turnId: string, content: string, isError: boolean) {
    const storedContent = sanitizeAgentTurnFailureMessage(content);
    aiAgentSessions.updateAssistantTurn(sessionId, turnId, (turn) => ({
      ...turn,
      cards: [
        ...turn.cards,
        {
          kind: 'tool-result',
          content: storedContent,
          status: isError ? 'error' : 'success',
          textOffset: turn.text.length,
        },
      ],
    }));
    if (isError) aiAgentSessions.failTurn(sessionId, turnId, 'tool', storedContent, false);
    scrollDown();
  }

  function applyResult(
    sessionId: string,
    turnId: string,
    text: string,
    cost?: number,
    usage?: { input: number; output: number },
  ) {
    aiAgentSessions.updateAssistantTurn(sessionId, turnId, (turn) => {
      const finalText = text && text.length > turn.text.length ? text : turn.text;
      const changeSets = parseChangeSetsFromText(finalText, {
        sourceSessionId: sessionId,
        sourceProjectDir: projectLifecycle.currentProjectDir,
      });
      const cards = changeSets.length > 0
        ? [...turn.cards, ...changeSets.map((changeSet) => ({ kind: 'apply-changes' as const, changeSet, textOffset: finalText.length }))]
        : turn.cards;
      return {
        ...turn,
        text: finalText,
        cards,
        cost,
        usage: usage ?? turn.usage,
        status: turn.failure ? 'failed' : 'complete',
      };
    }, cost);
    persistProjectSessionsInBackground();
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
  async function ensureLive(
    sessionId: string,
    token: AiAgentProjectToken,
    attempt: AiAgentAttempt,
  ): Promise<string | null> {
    if (!isActiveToken(token) || !ownsAttemptInPhase(sessionId, attempt, 'running')) return null;
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    if (!s) return null;
    if (liveSessions.has(s.sessionUuid)) return s.sessionUuid;
    if (spawning.has(sessionId)) {
      // Another caller is mid-spawn for this same session — poll briefly.
      while (isActiveToken(token) && ownsAttemptInPhase(sessionId, attempt, 'running') && spawning.has(sessionId) && !liveSessions.has(s.sessionUuid)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!isActiveToken(token) || !ownsAttemptInPhase(sessionId, attempt, 'running')) return null;
      if (liveSessions.has(s.sessionUuid)) return s.sessionUuid;
      return ensureLive(sessionId, token, attempt);
    }
    spawning.add(sessionId);
    try {
      const settings = aiAgentSettings.value;
      const cwd = projectStore.dirPath ?? null;
      return await startLiveSessionIfCurrent({
        token,
        sessionUuid: s.sessionUuid,
        isCurrent: (candidate) => isActiveToken(candidate) && ownsAttemptInPhase(sessionId, attempt, 'running'),
        spawn: () => ClaudeRuntime.spawn({
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
        }),
        listen: () => ClaudeRuntime.listen(s.sessionUuid, (ev) =>
          handleStreamEvent(sessionId, s.sessionUuid, ev, token),
        ),
        kill: (uuid) => ClaudeRuntime.kill(uuid),
        register: (unlisten) => liveSessions.set(s.sessionUuid, unlisten),
      });
    } finally {
      spawning.delete(sessionId);
    }
  }

  /**
   * Ensure a Codex (one-shot) session has its stream listener attached. The
   * channel is keyed by the stable sessionUuid, so one subscription covers
   * every per-turn child process the Rust bridge spawns.
   */
  async function ensureListening(
    sessionId: string,
    token: AiAgentProjectToken,
    attempt: AiAgentAttempt,
  ): Promise<void> {
    if (!isActiveToken(token) || !ownsAttemptInPhase(sessionId, attempt, 'running')) return;
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    if (!s || codexListeners.has(s.sessionUuid)) return;
    const runtime = runtimeFor(s.providerId);
    await attachListenerIfCurrent({
      token,
      sessionUuid: s.sessionUuid,
      isCurrent: (candidate) => isActiveToken(candidate) && ownsAttemptInPhase(sessionId, attempt, 'running'),
      listen: () => runtime.listen(s.sessionUuid, (ev) =>
        handleStreamEvent(sessionId, s.sessionUuid, ev, token, attempt),
      ),
      kill: (uuid) => runtime.kill(uuid),
      register: (unlisten) => codexListeners.set(s.sessionUuid, unlisten),
    });
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

  function pickCommand(id: string) {
    input = `/${id} `;
  }

  async function pickMention(tokenText: string, attachment?: AiContextAttachment) {
    const lifecycleToken = projectLifecycle.capture();
    if (attachment) {
      const hydrated = await hydrateAttachment(attachment);
      if (!isActiveToken(lifecycleToken)) return;
      addAttachments([hydrated]);
      input = input.replace(/(^|\s)@[^\s]*$/, '$1').trimStart();
      return;
    }
    // Trailing space closes the mention menu after the pick.
    if (!isActiveToken(lifecycleToken)) return;
    input = input.replace(/(^|\s)@[^\s]*$/, `$1${tokenText} `);
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
    const assetCandidates = [...skillPromptAssets, ...projectCommandAssets].map((asset) =>
      createAttachmentFromContext({
        id: `${asset.kind}:${asset.id}`,
        kind: 'manual-note',
        label: `${asset.kind === 'skill' ? 'Skill' : 'Command'}: ${asset.name}`,
        path: asset.path,
        content: asset.content,
      }),
    );
    const sessionCandidates: AiContextAttachment[] = aiAgentSessions.sessions
      .filter(() => lifecycleReady)
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

  async function setActiveMode(mode: 'act' | 'plan', token?: AiAgentProjectToken) {
    if (!token && !lifecycleReady) return;
    const lifecycleToken = token ?? projectLifecycle.capture();
    if (!isActiveToken(lifecycleToken)) return;
    const s = activeSession;
    if (!s) return;
    const runtime = runtimeFor(s.providerId);
    const priorCodexDrain = runtime.capabilities.persistent ? undefined : codexDrains.get(s.id);
    let attempt = turnInFlight.get(s.id) ?? reserveAttempt(s.id, '');
    if (!attempt) return;
    attempt = markAttemptCancelling(s.id, attempt);
    if (!attempt) return;
    if (runtime.capabilities.persistent) {
      // Claude bakes the mode into spawn flags, so drop the live process; the
      // next send re-spawns with the new permission-mode.
      await detachListener(liveSessions, s.sessionUuid, 'mode-switch listener cleanup');
    }
    if (!runtime.capabilities.persistent && (priorCodexDrain || attempt.turnId)) {
      const drainAttempt = priorCodexDrain?.attempt ?? attempt;
      if (!priorCodexDrain) beginCodexDrain(s.id, drainAttempt);
      await retireCodexDrain(s.id, s.sessionUuid, drainAttempt, true);
    } else {
      await runRuntimeCleanup('mode-switch cleanup', () => runtime.kill(s.sessionUuid));
    }
    if (!isActiveToken(lifecycleToken)) return;
    if (!releaseAttempt(s.id, attempt)) return;
    if (attempt.turnId) aiAgentSessions.stopTurn(s.id, attempt.turnId);
    aiAgentSessions.setMode(s.id, mode);
    await persistProjectSessionsFor(lifecycleToken.projectDir);
  }

  async function stopActiveSession() {
    const token = projectLifecycle.capture();
    if (!isActiveToken(token)) return;
    const s = activeSession;
    if (!s) return;
    let attempt = turnInFlight.get(s.id);
    const runtime = runtimeFor(s.providerId);
    if (attempt) {
      const cancelling = markAttemptCancelling(s.id, attempt);
      if (!cancelling) return;
      attempt = cancelling;
    }
    if (runtime.capabilities.persistent) {
      await detachListener(liveSessions, s.sessionUuid, 'turn listener cleanup');
    }
    if (attempt && !runtime.capabilities.persistent) {
      beginCodexDrain(s.id, attempt);
      await retireCodexDrain(s.id, s.sessionUuid, attempt, true);
    } else {
      await runRuntimeCleanup('turn cancellation', () => runtime.cancel(s.sessionUuid));
    }
    if (!isActiveToken(token)) return;
    if (attempt) {
      if (!releaseAttempt(s.id, attempt)) return;
      aiAgentSessions.stopTurn(s.id, attempt.turnId);
      aiAgentSessions.markInterrupted(s.id);
    }
    const sessions = aiAgentSessions.sessions.map(snapshotAgentSession);
    await persistProjectSessionsFor(token.projectDir, sessions);
  }

  async function compactAgentSession(sessionId: string, token?: AiAgentProjectToken) {
    if ((!token && !lifecycleReady) || busy) return;
    const lifecycleToken = token ?? projectLifecycle.capture();
    if (!isActiveToken(lifecycleToken)) return;
    const s = aiAgentSessions.sessions.find((session) => session.id === sessionId);
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
    await mutateAndPersistAgentSession(
      lifecycleToken,
      sessionId,
      () => aiAgentSessions.compact(sessionId, summary),
      (applied, previous) => {
        aiAgentSessions.restoreSessionIfOwned(sessionId, applied, previous);
      },
    );
  }

  async function handleSpecialAgentCommand(commandId: string, token: AiAgentProjectToken): Promise<boolean> {
    if (!isActiveToken(token)) return true;
    if (commandId === 'clear') {
      if (activeId && window.confirm('Clear transcript for this session? This cannot be undone.')) {
        await clearAgentSession(activeId, token);
      }
      return true;
    }
    if (commandId === 'save') {
      await saveAgentToProject(token);
      return true;
    }
    if (commandId === 'compact') {
      if (window.confirm('Compact session transcript? This replaces the current transcript with a summary.')) {
        if (activeId) await compactAgentSession(activeId, token);
      }
      return true;
    }
    if (commandId === 'plan') {
      await setActiveMode('plan', token);
      return true;
    }
    if (commandId === 'act') {
      await setActiveMode('act', token);
      return true;
    }
    return false;
  }

  /** Drop the live listener + map entry for a CLI process that's gone. */
  function dropLive(uuid: string) {
    void detachListener(liveSessions, uuid, 'closed runtime listener cleanup');
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

  function failAttempt(
    sessionId: string,
    attempt: AiAgentAttempt,
    stage: AgentTurnFailureStage,
    message: string,
    terminal = true,
  ): boolean {
    if (!ownsAttemptInPhase(sessionId, attempt, 'running')) return false;
    aiAgentSessions.failTurn(sessionId, attempt.turnId, stage, message, terminal);
    if (terminal) releaseAttempt(sessionId, attempt);
    persistProjectSessionsInBackground();
    return true;
  }

  function handleStreamEvent(
    sessionId: string,
    sessionUuid: string,
    ev: ClaudeStreamEvent,
    token: AiAgentProjectToken,
    listenerAttempt?: AiAgentAttempt,
  ) {
    if (!isActiveToken(token)) return;
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    if (!s || s.sessionUuid !== sessionUuid) return;
    const runtime = runtimeFor(s?.providerId ?? 'claude');
    const persistent = runtime.capabilities.persistent;
    if (!persistent && listenerAttempt) {
      const drain = codexDrains.get(sessionId);
      if (drain) {
        if (drain.attempt.generation !== listenerAttempt.generation) return;
        if (ev.kind === 'exit' || ev.kind === 'error') {
          void retireCodexDrain(sessionId, sessionUuid, listenerAttempt, ev.kind === 'error');
        }
        return;
      }
      if (!ownsAttemptInPhase(sessionId, listenerAttempt, 'running')) return;
    }
    const attempt = attemptOwner.current(sessionId);
    if (attempt?.phase === 'cancelling') return;

    if (ev.kind === 'stderr-line') {
      const line = ev.data.trim();
      if (!line) return;
      // Codex prints benign operational chatter (e.g. "Reading additional
      // input from stdin…") to stderr — only surface genuine failures.
      if (persistent || /\b(error|panic|fatal|failed|denied|refused)\b/i.test(line)) {
        if (!attempt || !failAttempt(sessionId, attempt, 'stream', line, false)) {
          error = sanitizeAgentTurnFailureMessage(line);
        }
      }
      return;
    }
    if (ev.kind === 'exit') {
      if (persistent && s) dropLive(s.sessionUuid);
      const message = ev.code == null
        ? 'Agent process exited before completing the turn.'
        : `Agent process exited with code ${ev.code} before completing the turn.`;
      if (persistent) {
        if (attempt && failAttempt(sessionId, attempt, 'stream', message)) aiAgentSessions.markInterrupted(sessionId);
      } else {
        if (attempt) {
          beginCodexDrain(sessionId, attempt);
          if (failAttempt(sessionId, attempt, 'stream', message)) aiAgentSessions.markInterrupted(sessionId);
          void retireCodexDrain(sessionId, sessionUuid, attempt, false);
        }
      }
      return;
    }
    if (ev.kind === 'error') {
      if (!persistent && attempt) beginCodexDrain(sessionId, attempt);
      if (!attempt || !failAttempt(sessionId, attempt, 'stream', ev.message)) {
        error = sanitizeAgentTurnFailureMessage(ev.message);
      }
      if (!persistent) {
        aiAgentSessions.markInterrupted(sessionId);
        if (attempt) void retireCodexDrain(sessionId, sessionUuid, attempt, true);
      }
      return;
    }
    if (ev.kind === 'stdout-line') {
      const parsed = runtime.parseEvent(ev.data);
      if (!parsed) return;
      switch (parsed.kind) {
        case 'text-delta': {
          if (attempt) applyTextDelta(sessionId, attempt.turnId, parsed.text);
          break;
        }
        case 'assistant-block': {
          if (attempt) applyAssistantBlocks(sessionId, attempt.turnId, parsed.blocks);
          break;
        }
        case 'tool-use': {
          if (attempt) applyAssistantBlocks(sessionId, attempt.turnId, [{ type: 'tool_use', name: parsed.name, input: parsed.input }]);
          break;
        }
        case 'tool-result': {
          if (attempt) applyToolResult(sessionId, attempt.turnId, parsed.content, parsed.isError);
          break;
        }
        case 'failure':
          if (attempt) {
            if (!persistent) beginCodexDrain(sessionId, attempt);
            failAttempt(sessionId, attempt, parsed.stage, parsed.message);
          }
          break;
        case 'result': {
          if (!attempt) break;
          if (persistent) markClaudeStarted(sessionId);
          applyResult(sessionId, attempt.turnId, parsed.text, parsed.cost, parsed.usage);
          // The turn finished streaming — clear in-flight so the composer
          // returns to Send. Codex routes through finishCodexTurn (which also
          // handles its interrupted/exit bookkeeping); Claude clears directly.
          if (!persistent) beginCodexDrain(sessionId, attempt);
          releaseAttempt(sessionId, attempt);
          break;
        }
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

  async function dispatchAgentTurn(
    sessionId: string,
    attempt: AiAgentAttempt,
    outbound: string,
    token: AiAgentProjectToken,
  ) {
    if (!isActiveToken(token) || !ownsAttemptInPhase(sessionId, attempt, 'reserved')) return;
    const session = aiAgentSessions.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    const runtime = runtimeFor(session.providerId);
    const settings = aiAgentSettings.value;
    const cwd = token.projectDir;

    try {
      if (!runtime.capabilities.persistent) {
        if (!await waitForCodexDrain(sessionId, attempt)) return;
        const running = markAttemptRunning(sessionId, attempt);
        if (!running) return;
        attempt = running;
        await ensureListening(sessionId, token, attempt);
        if (!isActiveToken(token) || !ownsAttemptInPhase(sessionId, attempt, 'running')) return;
        if (!runtime.runTurn) throw new Error('Provider cannot run this turn.');
        await runtime.runTurn({
          sessionUuid: session.sessionUuid,
          prompt: outbound,
          cwd,
          cliPath: settings.codexCliPath || undefined,
          model: settings.codexModel || undefined,
          sandbox: session.mode === 'plan' ? 'read-only' : 'workspace-write',
          addDirs: settings.attachProjectRoot && cwd ? [cwd] : [],
          resumeThreadId:
            (aiAgentSessions.sessions.find((candidate) => candidate.id === sessionId)?.providerState
              ?.codexThreadId as string | undefined) ?? null,
        });
        return;
      }

      const running = markAttemptRunning(sessionId, attempt);
      if (!running) return;
      attempt = running;
      const uuid = await ensureLive(sessionId, token, attempt);
      if (!isActiveToken(token) || !ownsAttemptInPhase(sessionId, attempt, 'running')) return;
      if (!uuid) throw new Error('Failed to spawn Claude CLI');
      try {
        await runtime.send(uuid, outbound);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!message.includes('Unknown claude session')) throw e;
        // The persistent process exited between turns. Resume it once while
        // retaining the same turn id so streamed output still lands correctly.
        if (!isActiveToken(token) || !ownsAttemptInPhase(sessionId, attempt, 'running')) return;
        dropLive(uuid);
        const fresh = await ensureLive(sessionId, token, attempt);
        if (!fresh) throw e;
        await runtime.send(fresh, outbound);
      }
    } catch (e) {
      if (!isActiveToken(token) || !ownsAttemptInPhase(sessionId, attempt, 'running')) return;
      if (!runtime.capabilities.persistent) beginCodexDrain(sessionId, attempt);
      const failed = failAttempt(sessionId, attempt, 'send', e instanceof Error ? e.message : String(e));
      if (!runtime.capabilities.persistent && failed) {
        aiAgentSessions.markInterrupted(sessionId);
        void retireCodexDrain(sessionId, session.sessionUuid, attempt, true);
      }
      await persistProjectSessionsFor(token.projectDir);
    }
  }

  type PreparedAgentPrompt = {
    request: Omit<UserTurn, 'role' | 'turnId'>;
    discoveredAttachments: AiContextAttachment[];
  };

  async function prepareAgentPrompt(
    sourceText: string,
    baseAttachments: readonly AiContextAttachment[],
  ): Promise<PreparedAgentPrompt> {
    const slash = parseSlashCommand(sourceText, [...projectCommandAssets]);
    const skillTokens = parseSkillTokens(sourceText);
    const skillAttachments = skillAssetsForTokens(skillTokens, [...skillPromptAssets]).map((skill) =>
      createAttachmentFromContext({
        id: `skill:${skill.id}`,
        kind: 'manual-note',
        label: `Skill: ${skill.name}`,
        path: skill.path,
        content: skill.content,
      }),
    );
      const mentionContexts = await resolveMentionContexts(sourceText, { rejectFileReadError: true });
    const mentionAttachments = mentionContexts.map(createAttachmentFromContext);
    const turnAttachments = [...baseAttachments, ...mentionAttachments, ...skillAttachments];
    const displayText = displayTextFromInput(slash ? slash.rest || sourceText : sourceText);
    const instruction = commandInstruction(slash);
    const userText = instruction
      ? `${instruction}\n\nUser request: ${displayText || slash?.rest || sourceText}`
      : displayText || sourceText;
    const packed = buildPromptFromAttachments(userText, turnAttachments);

    return {
      request: {
        text: packed.outboundText,
        displayText: displayText || sourceText,
        sourceText,
        contextState: 'resolved',
        attachments: packed.attachments.map((item) => ({
          id: item.id,
          label: item.label,
          kind: item.kind,
          path: item.path,
        })),
      },
      discoveredAttachments: [...mentionAttachments, ...skillAttachments],
    };
  }

  async function failContextResolution(
    sessionId: string,
    turnId: string,
    attempt: AiAgentAttempt,
    token: AiAgentProjectToken,
    cause: unknown,
  ) {
    if (!isActiveToken(token) || !ownsAttemptInPhase(sessionId, attempt, 'reserved')) return;
    if (!aiAgentSessions.sessions.some((session) => session.id === sessionId)) {
      releaseAttempt(sessionId, attempt);
      return;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    aiAgentSessions.failTurn(
      sessionId,
      turnId,
      'context',
      `Failed to resolve prompt context: ${message}`,
    );
    releaseAttempt(sessionId, attempt);
    const failedSession = aiAgentSessions.sessions.find((session) => session.id === sessionId);
    if (!failedSession || !isActiveToken(token)) return;
    try {
      await persistAgentSessionFor(token.projectDir, failedSession);
    } catch (persistError) {
      console.warn(
        '[ai-agent] failed to persist context-resolution failure',
        sanitizeAgentTurnFailureMessage(
          persistError instanceof Error ? persistError.message : String(persistError),
        ),
      );
    }
  }

  async function send() {
    const text = input.trim();
    if (!text) return;
    error = null;
    if (!lifecycleReady) {
      error = 'AI Agent is still loading this project.';
      return;
    }
    const sessionId = aiAgentSessions.ensureOne();
    const s = aiAgentSessions.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    if (turnInFlight.has(sessionId)) {
      error = 'A turn is already running for this session.';
      return;
    }
    const token = projectLifecycle.capture();

    const slash = parseSlashCommand(text, projectCommandAssets);
    if (slash && await handleSpecialAgentCommand(slash.id, token)) {
      if (!isActiveToken(token)) return;
      if (input.trim() === text) input = '';
      return;
    }

    const provisionalAttempt = reserveAttempt(sessionId, '');
    if (!provisionalAttempt) return;
    let attempt: AiAgentAttempt = provisionalAttempt;
    const baseAttachments = [...attachments];
    let turnId: string | null = null;
    let appended = false;
    try {
      appended = await mutateAndPersistForToken({
        token,
        isCurrent: (candidate) => isActiveToken(candidate) && ownsAttemptInPhase(sessionId, attempt, 'reserved'),
        mutate() {
          turnId = aiAgentSessions.startTurn(sessionId, {
            text,
            displayText: text,
            sourceText: text,
            contextState: 'pending',
            attachments: baseAttachments.map((item) => ({
              id: item.id,
              label: item.label,
              kind: item.kind,
              path: item.path,
            })),
          });
          attempt = bindAttemptTurn(sessionId, attempt, turnId) ?? attempt;
        },
        persist: async (projectDir) => {
          const target = aiAgentSessions.sessions.find((session) => session.id === sessionId);
          if (target) await persistAgentSessionFor(projectDir, target);
        },
      });
    } catch (e) {
      if (turnId && isActiveToken(token) && ownsAttemptInPhase(sessionId, attempt, 'reserved')) {
        aiAgentSessions.failTurn(
          sessionId,
          turnId,
          'send',
          `Could not persist turn: ${e instanceof Error ? e.message : String(e)}`,
        );
        releaseAttempt(sessionId, attempt);
        if (input.trim() === text) input = '';
      }
      return;
    }
    if (!appended || !turnId || !isActiveToken(token) || !ownsAttemptInPhase(sessionId, attempt, 'reserved')) {
      return;
    }
    if (input.trim() === text) input = '';
    scrollDown();

    let prepared: PreparedAgentPrompt;
    try {
      prepared = await prepareAgentPrompt(text, baseAttachments);
    } catch (e) {
      await failContextResolution(sessionId, turnId, attempt, token, e);
      return;
    }
    if (!isActiveToken(token) || !ownsAttemptInPhase(sessionId, attempt, 'reserved')) return;
    if (!aiAgentSessions.sessions.some((session) => session.id === sessionId)) {
      releaseAttempt(sessionId, attempt);
      return;
    }
    if (aiAgentSessions.activeId === sessionId && prepared.discoveredAttachments.length > 0) {
      addAttachments(prepared.discoveredAttachments);
    }

    let resolved = false;
    let outbound: string | null = null;
    try {
      resolved = await mutateAndPersistForToken({
        token,
        isCurrent: (candidate) => isActiveToken(candidate) && ownsAttemptInPhase(sessionId, attempt, 'reserved'),
        mutate() {
          outbound = aiAgentSessions.retryTurn(sessionId, turnId!, prepared.request)?.text ?? null;
        },
        persist: async (projectDir) => {
          const target = aiAgentSessions.sessions.find((session) => session.id === sessionId);
          if (target) await persistAgentSessionFor(projectDir, target);
        },
      });
    } catch (e) {
      if (isActiveToken(token) && ownsAttemptInPhase(sessionId, attempt, 'reserved')) {
        releaseAttempt(sessionId, attempt);
        aiAgentSessions.failTurn(sessionId, turnId, 'send', `Could not persist turn: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    if (!resolved || !outbound || !ownsAttemptInPhase(sessionId, attempt, 'reserved')) return;
    await dispatchAgentTurn(sessionId, attempt, outbound, token);
  }

  async function retryAgentTurn(turnId: string) {
    if (!lifecycleReady || busy) return;
    const session = activeSession;
    if (!session) return;
    const request = session.turns.find(
      (turn): turn is UserTurn => turn.role === 'user' && turn.turnId === turnId,
    );
    const response = session.turns.find(
      (turn): turn is AssistantTurn => turn.role === 'assistant' && turn.turnId === turnId,
    );
    if (!request) return;
    const token = projectLifecycle.capture();
    const attempt = reserveAttempt(session.id, turnId);
    if (!attempt) return;
    let replacement: Omit<UserTurn, 'role' | 'turnId'> | undefined;
    if (request.contextState === 'pending') {
      try {
        const prepared = await prepareAgentPrompt(
          request.sourceText ?? request.text,
          [...attachments],
        );
        replacement = prepared.request;
        if (
          isActiveToken(token)
          && ownsAttemptInPhase(session.id, attempt, 'reserved')
          && aiAgentSessions.activeId === session.id
          && prepared.discoveredAttachments.length > 0
        ) {
          addAttachments(prepared.discoveredAttachments);
        }
      } catch (e) {
        await failContextResolution(session.id, turnId, attempt, token, e);
        return;
      }
    }
    if (!isActiveToken(token) || !ownsAttemptInPhase(session.id, attempt, 'reserved')) return;
    if (!aiAgentSessions.sessions.some((candidate) => candidate.id === session.id)) {
      releaseAttempt(session.id, attempt);
      return;
    }
    let outbound: string | null = null;
    let reset = false;
    try {
      reset = await mutateAndPersistForToken({
        token,
        isCurrent: (candidate) => isActiveToken(candidate) && ownsAttemptInPhase(session.id, attempt, 'reserved'),
        mutate() {
          outbound = aiAgentSessions.retryTurn(session.id, turnId, replacement)?.text ?? null;
        },
        persist: async (projectDir) => {
          const target = aiAgentSessions.sessions.find((candidate) => candidate.id === session.id);
          if (target) await persistAgentSessionFor(projectDir, target);
        },
      });
    } catch (e) {
      if (isActiveToken(token) && ownsAttemptInPhase(session.id, attempt, 'reserved')) {
        releaseAttempt(session.id, attempt);
        aiAgentSessions.failTurn(session.id, turnId, 'send', `Could not persist retry: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    if (!reset || !outbound) {
      if (ownsAttemptInPhase(session.id, attempt, 'reserved')) releaseAttempt(session.id, attempt);
      return;
    }
    error = null;
    scrollDown();
    await dispatchAgentTurn(session.id, attempt, outbound, token);
  }

  function requestTurnRetry(turnId: string | undefined) {
    if (turnId) void retryAgentTurn(turnId);
  }

  async function createNewSession(token: AiAgentProjectToken): Promise<boolean> {
    if (!lifecycleReady || !isActiveToken(token)) return false;
    aiAgentSessions.create();
    error = null;
    await persistProjectSessionsFor(token.projectDir);
    return true;
  }

  async function handleNewSessionRequest(
    request: AiAgentNewSessionRequest,
  ): Promise<AiAgentNewSessionRequestResult> {
    if (request.projectDir !== projectStore.dirPath) return 'rejected';
    if (
      !lifecycleReady ||
      projectLifecycle.status.kind !== 'ready' ||
      projectLifecycle.currentProjectDir !== request.projectDir
    ) {
      return 'defer';
    }
    const token = projectLifecycle.capture();
    if (token.projectDir !== request.projectDir || !isActiveToken(token)) return 'defer';
    return await createNewSession(token) ? 'handled' : 'defer';
  }

  async function newSessionClicked() {
    if (!lifecycleReady) return;
    await createNewSession(projectLifecycle.capture());
  }

  function handleSessionSelect(id: string) {
    aiAgentSessions.setActive(id);
    error = null;
  }

  async function handleSessionDelete(id: string) {
    if (!lifecycleReady || turnInFlight.has(id)) return;
    const token = projectLifecycle.capture();
    const s = aiAgentSessions.sessions.find((x) => x.id === id);
    const reserved = reserveAttempt(id, '');
    if (!s || !reserved) return;
    const deletedSnapshot = snapshotAgentSession(s);
    const deletedIndex = aiAgentSessions.sessions.findIndex((session) => session.id === id);
    const activeBeforeDelete = aiAgentSessions.activeId;
    const action = markAttemptCancelling(id, reserved);
    if (!action) return;
    try {
      await detachListener(liveSessions, s.sessionUuid, 'deleted Claude listener cleanup');
      await detachListener(codexListeners, s.sessionUuid, 'deleted Codex listener cleanup');
      finishCodexDrain(id);
      await runRuntimeCleanup('session deletion cleanup', () =>
        runtimeFor(s.providerId).cancel(s.sessionUuid),
      );
      if (!isActiveToken(token) || !ownsAttemptInPhase(id, action, 'cancelling')) return;
      const current = aiAgentSessions.sessions.find((session) => session.id === id);
      if (!current || current.sessionUuid !== s.sessionUuid) return;
      await aiAgentSessions.delete(id);
      const activeAfterDelete = aiAgentSessions.activeId;
      let fallbackId: string | null = null;
      let fallback: AgentSession | null = null;
      let fallbackPersisted = false;
      try {
        if (aiAgentSessions.sessions.length === 0) {
          fallbackId = aiAgentSessions.create();
          const createdFallback = aiAgentSessions.sessions.find((session) => session.id === fallbackId);
          if (!createdFallback) throw new Error('Failed to create fallback Agent session');
          fallback = createdFallback;
          await persistAgentSessionFor(token.projectDir, createdFallback);
          fallbackPersisted = true;
        }
        if (token.projectDir) {
          const projectDir = token.projectDir;
          await persistenceQueue.enqueue(
            projectDir,
            id,
            () => deleteAiSession(projectDir, 'agent', id),
          );
        }
      } catch (cause) {
        if (isActiveToken(token)) {
          if (fallbackId) aiAgentSessions.removeCreatedSession(fallbackId, activeAfterDelete);
          aiAgentSessions.reinsertDeletedSession(
            deletedSnapshot,
            deletedIndex,
            activeBeforeDelete,
            activeAfterDelete,
          );
        }
        if (token.projectDir) {
          if (fallbackPersisted && fallbackId && fallback) {
            try {
              await deleteAiSession(token.projectDir, 'agent', fallbackId);
            } catch {
              // Keep the original failure visible when durable compensation also fails.
            }
          }
        }
        throw cause;
      }
    } finally {
      releaseAttempt(id, action);
    }
  }

  async function handleSessionRename(id: string, title: string) {
    if (!lifecycleReady) return;
    const token = projectLifecycle.capture();
    if (!isActiveToken(token)) return;
    await mutateAndPersistAgentSession(
      token,
      id,
      () => aiAgentSessions.rename(id, title),
      (applied, previous) => {
        aiAgentSessions.restoreRenameIfOwned(id, applied, previous);
      },
    );
  }

  async function forkSession(id: string) {
    if (!lifecycleReady || busy) return;
    const token = projectLifecycle.capture();
    if (!isActiveToken(token)) return;
    const s = aiAgentSessions.sessions.find((session) => session.id === id);
    if (!s) return;
    const previousActiveId = aiAgentSessions.activeId;
    const nextId = aiAgentSessions.fork(s.id);
    if (!nextId) return;
    const fork = aiAgentSessions.sessions.find((session) => session.id === nextId);
    if (!fork) return;
    try {
      await persistAgentSessionFor(token.projectDir, fork);
    } catch (cause) {
      if (isActiveToken(token)) aiAgentSessions.removeCreatedSession(nextId, previousActiveId);
      if (token.projectDir) {
        try {
          await deleteAiSession(token.projectDir, 'agent', nextId);
        } catch {
          // The original failure remains authoritative; a retry can clean up.
        }
      }
      throw cause;
    }
  }

  async function clearActiveSession() {
    if (!activeId || !lifecycleReady) return;
    await clearAgentSession(activeId, projectLifecycle.capture());
  }

  async function clearAgentSession(id: string, token: AiAgentProjectToken) {
    if (!isActiveToken(token) || turnInFlight.has(id)) return;
    const session = aiAgentSessions.sessions.find((candidate) => candidate.id === id);
    if (!session) return;
    const reserved = reserveAttempt(id, '');
    if (!reserved) return;
    const action = markAttemptCancelling(id, reserved);
    if (!action) return;
    try {
      await detachListener(liveSessions, session.sessionUuid, 'cleared Claude listener cleanup');
      await detachListener(codexListeners, session.sessionUuid, 'cleared Codex listener cleanup');
      finishCodexDrain(id);
      await runRuntimeCleanup('session clear cleanup', () =>
        runtimeFor(session.providerId).cancel(session.sessionUuid),
      );
      if (!isActiveToken(token) || !ownsAttemptInPhase(id, action, 'cancelling')) return;
      const current = aiAgentSessions.sessions.find((candidate) => candidate.id === id);
      if (!current || current.sessionUuid !== session.sessionUuid) return;
      await mutateAndPersistAgentSession(
        token,
        id,
        () => aiAgentSessions.clearTurns(id),
        (applied, previous) => {
          aiAgentSessions.restoreSessionIfOwned(id, applied, previous);
        },
      );
    } finally {
      releaseAttempt(id, action);
    }
  }

  let sessionMenuActions = $derived([
    {
      id: 'save',
      label: 'Save transcript',
      disabled: turns.length === 0 || !lifecycleReady,
      onSelect: (id: string) => saveAgentToProject(undefined, id),
    },
    {
      id: 'fork',
      label: 'Fork session',
      disabled: turns.length === 0 || busy || !lifecycleReady,
      onSelect: forkSession,
    },
    {
      id: 'compact',
      label: 'Compact session',
      disabled: turns.length < 2 || busy || !lifecycleReady,
      confirmation: 'Compact session transcript? This replaces the current transcript with a summary.',
      onSelect: (id: string) => compactAgentSession(id),
    },
    {
      id: 'clear',
      label: 'Clear transcript',
      disabled: turns.length === 0 || busy || !lifecycleReady,
      danger: true,
      confirmation: 'Clear transcript for this session? This cannot be undone.',
      onSelect: (id: string) => clearAgentSession(id, projectLifecycle.capture()),
    },
  ]);

  function handleSessionActionError(cause: unknown | null) {
    sessionActionError = cause == null
      ? null
      : `Session action failed: ${sanitizeAgentTurnFailureMessage(
          cause instanceof Error ? cause.message : String(cause),
        )}`;
  }

  async function persistRetiredSessions(
    projectDir: string | null,
    sessions: readonly AgentSession[],
  ): Promise<void> {
    if (!projectDir) return;
    await Promise.all(sessions.map((session) =>
      writeAiSession(projectDir, 'agent', session.id, session),
    ));
  }

  async function retireMount(
    ctx: AiAgentProjectToken,
    ownsSharedState: boolean,
  ): Promise<void> {
    await mountLease.predecessor;
    if (!ownsSharedState) {
      await persistenceQueue.closeAndDrain();
      return;
    }

    try {
      await projectLifecycle.drain();
    } catch (error) {
      console.warn(
        '[ai-agent] lifecycle drain failed during retirement',
        sanitizeAgentTurnFailureMessage(error instanceof Error ? error.message : String(error)),
      );
    }

    const queueDrain = persistenceQueue.closeAndDrain();
    const runtimeSessions = [...aiAgentSessions.sessions];
    for (const session of runtimeSessions) {
      await detachListener(liveSessions, session.sessionUuid, 'retired Claude listener cleanup');
      await detachListener(codexListeners, session.sessionUuid, 'retired Codex listener cleanup');
      const attempt = attemptOwner.current(session.id);
      if (attempt) {
        releaseAttempt(session.id, attempt);
        if (attempt.turnId) aiAgentSessions.stopTurn(session.id, attempt.turnId);
        aiAgentSessions.markInterrupted(session.id);
      }
    }
    clearCodexDrains();
    const sessions = aiAgentSessions.sessions.map(snapshotAgentSession);

    await Promise.all(runtimeSessions.map((session) =>
      runRuntimeCleanup('retired project runtime cleanup', () =>
        runtimeFor(session.providerId).cancel(session.sessionUuid),
      ),
    ));
    await queueDrain;
    await persistRetiredSessions(ctx.projectDir, sessions);
    spawning.clear();
  }

  async function teardownProject(ctx: AiAgentProjectToken) {
    const runtimeSessions = [...aiAgentSessions.sessions];

    for (const s of runtimeSessions) {
      await detachListener(liveSessions, s.sessionUuid, 'project Claude listener cleanup');
      await detachListener(codexListeners, s.sessionUuid, 'project Codex listener cleanup');
      const attempt = attemptOwner.current(s.id);
      if (attempt) {
        releaseAttempt(s.id, attempt);
        aiAgentSessions.stopTurn(s.id, attempt.turnId);
        aiAgentSessions.markInterrupted(s.id);
      }
    }
    clearCodexDrains();

    const sessions = aiAgentSessions.sessions.map(snapshotAgentSession);
    await Promise.all(runtimeSessions.map((s) =>
      runRuntimeCleanup('project teardown cleanup', () =>
        runtimeFor(s.providerId).cancel(s.sessionUuid),
      ),
    ));
    await persistProjectSessionsFor(ctx.projectDir, sessions);
    spawning.clear();
  }

  function emptyOwnedPromptAssets(owner: AiAgentProjectToken): OwnedPromptAssets {
    return { owner, assets: { commands: [], skills: [], memory: null } };
  }

  function clearVolatileContext(ctx: AiAgentProjectToken) {
    if (destroyed) return;
    input = '';
    error = null;
    saveStatus = null;
    attachments = [];
    ownedPromptAssets = emptyOwnedPromptAssets(ctx);
    turnInFlight = new Map();
    attemptOwner.clear();
    clearCodexDrains();
    liveSessions.clear();
    codexListeners.clear();
    spawning.clear();
    aiAgentSessions.replaceAll([], null);
    aiAgentSessions.ensureOne();
    lifecycleReady = false;
  }

  async function loadProjectSessionsFor(ctx: AiAgentProjectToken) {
    const projectDir = ctx.projectDir;
    if (!projectDir) return;
    try {
      const assets = await listAiPromptAssets(projectDir);
      if (!isActiveToken(ctx)) return;
      ownedPromptAssets = { owner: ctx, assets };
      if (assets.memory?.content) {
        if (!isActiveToken(ctx)) return;
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
      if (!isActiveToken(ctx)) return;
      if (files.length > 0) {
        const sessions = [];
        for (const file of files) {
          const raw = await readAiSession(projectDir, 'agent', file.id);
          if (!isActiveToken(ctx)) return;
          if (raw) {
            const parsed = JSON.parse(raw) as { id?: unknown };
            if (parsed.id === file.id) sessions.push(parsed);
          }
        }
        if (!isActiveToken(ctx)) return;
        if (sessions.length > 0) {
          aiAgentSessions.replaceAll(sessions, aiAgentSessions.activeId);
          await persistProjectSessionsFor(projectDir);
        }
      } else if (aiAgentSessions.sessions.length > 0) {
        if (!isActiveToken(ctx)) return;
        await persistProjectSessionsFor(projectDir);
      }
    } catch (e) {
      if (isActiveToken(ctx)) {
        ownedPromptAssets = emptyOwnedPromptAssets(ctx);
        attachments = [];
        aiAgentSessions.replaceAll([], null);
        aiAgentSessions.ensureOne();
      }
      const message = sanitizeAgentTurnFailureMessage(e instanceof Error ? e.message : String(e));
      console.warn('[ai-agent] failed to load project AI assets', message);
      throw new Error(message);
    }
  }

  async function persistProjectSessions() {
    await persistProjectSessionsFor(projectStore.dirPath);
  }

  function persistProjectSessionsInBackground() {
    void persistProjectSessions().catch((e) => {
      if (!destroyed) {
        error = `Failed to persist AI Agent sessions: ${sanitizeAgentTurnFailureMessage(
          e instanceof Error ? e.message : String(e),
        )}`;
      }
    });
  }

  async function persistProjectSessionsFor(
    projectDir: string | null,
    sessions: readonly AgentSession[] = aiAgentSessions.sessions,
  ) {
    if (!projectDir) return;
    const snapshots = sessions.map(snapshotAgentSession);
    await Promise.all(
      snapshots.map((session) =>
        persistenceQueue.enqueue(
          projectDir,
          session.id,
          () => writeAiSession(projectDir, 'agent', session.id, session),
        ),
      ),
    );
  }

  async function persistAgentSessionFor(projectDir: string | null, session: AgentSession) {
    if (!projectDir) return;
    const snapshot = snapshotAgentSession(session);
    await persistenceQueue.enqueue(
      projectDir,
      snapshot.id,
      () => writeAiSession(projectDir, 'agent', snapshot.id, snapshot),
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

  async function saveAgentToProject(token?: AiAgentProjectToken, sessionId = activeId) {
    if (!token && !lifecycleReady) return;
    const lifecycleToken = token ?? projectLifecycle.capture();
    if (!isActiveToken(lifecycleToken)) return;
    const s = aiAgentSessions.sessions.find((session) => session.id === sessionId);
    if (!s || s.turns.length === 0) {
      saveStatus = 'Nothing to save.';
      setTimeout(() => (saveStatus = null), 2500);
      return;
    }
    const projectDir = lifecycleToken.projectDir;
    if (!projectDir) {
      saveStatus = 'Open a project first.';
      setTimeout(() => (saveStatus = null), 3000);
      return;
    }
    const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '');
    const filename = `${safeFilename(s.title)}-${stamp}.md`;
    const body = turnsToMarkdown(s.title, s.turns);
    try {
      const resolvedPath = await saveAiChat(projectDir, filename, body);
      if (!isActiveToken(lifecycleToken)) return;
      saveStatus = `Saved · .novelist/chats/${aiChatBasename(resolvedPath)}`;
    } catch (e) {
      if (!isActiveToken(lifecycleToken)) return;
      saveStatus = `Save failed: ${sanitizeAgentTurnFailureMessage(e instanceof Error ? e.message : String(e))}`;
    }
    setTimeout(() => (saveStatus = null), 4000);
  }

  type ApplyOperationContext = {
    sessionId: string;
    turnId: string;
    changeSetId: string;
    projectToken: AiAgentProjectToken;
  };

  function resolveApplyTarget(context: ApplyOperationContext, file?: AiFileChange): {
    session: AgentSession;
    turn: AssistantTurn;
    card: ApplyChangesCardState;
  } | null {
    if (!isActiveToken(context.projectToken)) return null;
    const session = aiAgentSessions.sessions.find((candidate) => candidate.id === context.sessionId);
    const turn = session?.turns.find(
      (candidate): candidate is AssistantTurn =>
        candidate.role === 'assistant' && candidate.turnId === context.turnId,
    );
    const card = turn?.cards.find(
      (candidate): candidate is ApplyChangesCardState =>
        candidate.kind === 'apply-changes' && candidate.changeSet.id === context.changeSetId,
    );
    if (
      !session
      || !turn
      || !card
      || card.changeSet.sourceSessionId !== context.sessionId
      || card.changeSet.sourceProjectDir !== context.projectToken.projectDir
    ) return null;
    if (file && !card.changeSet.files.some((candidate) =>
      candidate.path === file.path
      && candidate.originalText === file.originalText
      && candidate.proposedText === file.proposedText
    )) return null;
    return { session, turn, card };
  }

  function captureApplyContext(
    sessionId: string,
    turnId: string | undefined,
    changeSetId: string,
  ): ApplyOperationContext | null {
    if (!turnId) return null;
    const context = {
      sessionId,
      turnId,
      changeSetId,
      projectToken: projectLifecycle.capture(),
    };
    return resolveApplyTarget(context) ? context : null;
  }

  function updateApplyCard(
    context: ApplyOperationContext,
    update: (card: ApplyChangesCardState) => ApplyChangesCardState,
  ): boolean {
    if (!resolveApplyTarget(context)) return false;
    aiAgentSessions.updateAssistantTurn(context.sessionId, context.turnId, (turn) => ({
      ...turn,
      cards: turn.cards.map((card) =>
        card.kind === 'apply-changes' && card.changeSet.id === context.changeSetId
          ? update(card)
          : card,
      ),
    }));
    return true;
  }

  function markApplyFailure(context: ApplyOperationContext, message: string): boolean {
    if (!resolveApplyTarget(context)) return false;
    aiAgentSessions.failTurn(context.sessionId, context.turnId, 'apply', message);
    persistProjectSessionsInBackground();
    return true;
  }

  async function acceptApplyFile(
    sessionId: string,
    turnId: string | undefined,
    changeSetId: string,
    file: AiFileChange,
  ) {
    const context = captureApplyContext(sessionId, turnId, changeSetId);
    if (!context) return;
    try {
      await acceptApplyFileWithContext(context, file);
    } catch (e) {
      if (!resolveApplyTarget(context, file)) return;
      markApplyFailure(context, e instanceof Error ? e.message : String(e));
    }
  }

  async function acceptApplyFileWithContext(
    context: ApplyOperationContext,
    file: AiFileChange,
  ): Promise<'accepted' | 'conflict' | 'stale'> {
    const target = resolveApplyTarget(context, file);
    if (!target) return 'stale';
    const projectDir = context.projectToken.projectDir;
    if (!projectDir) return 'stale';
    const markConflict = (reason?: string) => {
      updateApplyCard(context, (candidate) => ({
        ...candidate,
        status: 'conflict',
        changeSet: reason
          ? {
              ...candidate.changeSet,
              files: candidate.changeSet.files.map((candidateFile) =>
                candidateFile.path === file.path ? { ...candidateFile, conflict: reason } : candidateFile,
              ),
            }
          : candidate.changeSet,
      }));
      markApplyFailure(context, reason ?? `Could not apply changes to ${file.path}.`);
    };
    if (file.status === 'modify' && file.originalText === null) {
      markConflict('Change proposal is missing original file content.');
      return 'conflict';
    }
    const expectedText = file.status === 'create' ? null : file.originalText;
    return applyFileIfCurrent({
      token: context.projectToken,
      sourceProjectDir: target.card.changeSet.sourceProjectDir,
      filePath: file.path,
      expectedText,
      proposedText: file.proposedText,
      isCurrent: () => resolveApplyTarget(context, file) !== null,
      compareAndWrite: (expected, proposedText) =>
        conditionalFileWrite(projectDir, file.path, expected, proposedText),
      markConflict,
      markAccepted() {
        updateApplyCard(context, (candidate) => ({ ...candidate, status: 'accepted' }));
      },
    });
  }

  function rejectApplyFile(
    sessionId: string,
    turnId: string | undefined,
    changeSetId: string,
    file: AiFileChange,
  ) {
    const context = captureApplyContext(sessionId, turnId, changeSetId);
    if (!context || !resolveApplyTarget(context, file)) return;
    updateApplyCard(context, (card) => ({
      ...card,
      status: 'rejected',
      changeSet: {
        ...card.changeSet,
        files: card.changeSet.files.filter((candidate) => candidate.path !== file.path),
      },
    }));
  }

  async function acceptApplyAll(
    sessionId: string,
    turnId: string | undefined,
    changeSetId: string,
  ) {
    const context = captureApplyContext(sessionId, turnId, changeSetId);
    const target = context ? resolveApplyTarget(context) : null;
    if (!context || !target) return;
    const files = [...target.card.changeSet.files];
    for (const file of files) {
      if (!resolveApplyTarget(context, file)) return;
      try {
        const result = await acceptApplyFileWithContext(context, file);
        if (result === 'stale') return;
      } catch (e) {
        if (!resolveApplyTarget(context, file)) return;
        markApplyFailure(context, e instanceof Error ? e.message : String(e));
        return;
      }
    }
  }

  function rejectApplyAll(
    sessionId: string,
    turnId: string | undefined,
    changeSetId: string,
  ) {
    const context = captureApplyContext(sessionId, turnId, changeSetId);
    if (context) updateApplyCard(context, (card) => ({ ...card, status: 'rejected' }));
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

  function failureLabel(stage: AgentTurnFailureStage): string {
    if (stage === 'context') return 'Context failed';
    if (stage === 'send') return 'Send failed';
    if (stage === 'tool') return 'Tool failed';
    if (stage === 'apply') return 'Apply failed';
    return 'Stream failed';
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
    onActionError={handleSessionActionError}
    menuActions={sessionMenuActions}
    disableDelete={busy || !lifecycleReady}
    disableActions={!lifecycleReady}
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
                <details class="card tool-result" class:error={part.card.status === 'error'}>
                  <summary><span class="summary-icon"><IconArrowInsert size={12} /></span> {part.card.status === 'error' ? 'failed' : 'result'}</summary>
                  <pre>{part.card.content.length > 4000 ? part.card.content.slice(0, 4000) + '\n…' : part.card.content}</pre>
                </details>
              {:else if part.card.kind === 'apply-changes'}
                {@const changeSet = part.card.changeSet}
                <ApplyChangesCard
                  {changeSet}
                  status={part.card.status}
                  onAcceptFile={(file) => acceptApplyFile(changeSet.sourceSessionId, turn.turnId, changeSet.id, file)}
                  onRejectFile={(file) => rejectApplyFile(changeSet.sourceSessionId, turn.turnId, changeSet.id, file)}
                  onAcceptAll={() => acceptApplyAll(changeSet.sourceSessionId, turn.turnId, changeSet.id)}
                  onRejectAll={() => rejectApplyAll(changeSet.sourceSessionId, turn.turnId, changeSet.id)}
                />
              {/if}
            {/each}
            {#if turn.usage}
              <div class="usage" title="Codex token usage">
                ↑{turn.usage.input.toLocaleString()} ↓{turn.usage.output.toLocaleString()} tokens
              </div>
            {/if}
            {#if turn.turnId && turnInFlight.get(activeSession?.id ?? '')?.turnId === turn.turnId}
              <div class="turn-state running">
                <span>Running</span>
                <button
                  type="button"
                  class="novelist-btn novelist-btn-ghost novelist-btn-sm"
                  aria-label="Stop turn"
                  data-testid="ai-agent-turn-stop-{turn.turnId}"
                  onclick={stopActiveSession}
                >Stop</button>
              </div>
            {/if}
            {#if turn.turnId && turn.failure}
              <div
                class="turn-error"
                role="alert"
                data-testid="ai-agent-turn-error-{turn.turnId}"
              >
                <div>
                  <strong>{failureLabel(turn.failure.stage)}</strong>
                  <span>{turn.failure.message}</span>
                </div>
                <button
                  type="button"
                  class="novelist-btn novelist-btn-ghost novelist-btn-sm"
                  aria-label="Retry turn"
                  disabled={busy}
                  onclick={() => requestTurnRetry(turn.turnId)}
                >Retry</button>
              </div>
            {:else if turn.turnId && turn.status === 'stopped'}
              <div class="turn-state stopped" data-testid="ai-agent-turn-stopped-{turn.turnId}">
                <span>Stopped</span>
                <button
                  type="button"
                  class="novelist-btn novelist-btn-ghost novelist-btn-sm"
                  aria-label="Retry turn"
                  disabled={busy}
                  onclick={() => requestTurnRetry(turn.turnId)}
                >Retry</button>
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

    {#if sessionActionError}
      <div class="banner" data-testid="ai-agent-action-error">{sessionActionError}</div>
    {/if}

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
      commandAssets={projectCommandAssets}
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
  .card.tool-result.error {
    border-color: color-mix(in srgb, var(--novelist-accent) 60%, var(--novelist-border));
  }
  .turn-state,
  .turn-error {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 5px 8px;
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text-secondary);
    font-size: 11px;
  }
  .turn-error {
    border-left: 2px solid var(--novelist-accent);
  }
  .turn-error div {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .turn-error strong {
    color: var(--novelist-text);
    font-size: 11px;
  }
  .turn-error span {
    overflow-wrap: anywhere;
  }
  .turn-state button,
  .turn-error button {
    flex-shrink: 0;
    margin-left: auto;
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
