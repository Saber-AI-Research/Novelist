<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { aiTalkSettings } from './settings.svelte';
  import {
    getEditorSnapshot,
    replaceEditorRange,
    startAiStream,
    cancelAiStream,
    aiStream,
    type EditorSnapshot,
  } from './host';
  import { buildChatRequest, parseChatChunk, type ChatMessage } from './openai';
  import { cancelPendingStreams } from './cleanup';
  import AiTalkSettings from './AiTalkSettings.svelte';
  import SessionTabs from '$lib/components/ai-shared/SessionTabs.svelte';
  import AiComposer from '$lib/components/ai-shared/AiComposer.svelte';
  import AiEditSuggestionCard from '$lib/components/ai-shared/AiEditSuggestionCard.svelte';
  import {
    EDIT_SUGGESTION_PROTOCOL,
    locateSuggestion,
    splitEditSuggestions,
    type EditSuggestion,
    type SuggestionStatus,
  } from '$lib/components/ai-shared/edit-suggestions';
  import {
    attachmentToContextItem,
    createAttachmentFromContext,
    type AiContextAttachment,
  } from '$lib/components/ai-shared/attachments';
  import {
    reduceSelectionSuggestion,
    type SelectionSuggestionState,
  } from '$lib/components/ai-shared/selection-state';
  import {
    BUILTIN_SKILLS,
    buildContextPack,
    commandInstruction,
    contextPackToPrompt,
    parseSkillTokens,
    parseSlashCommand,
    resolveMentionContexts,
    skillAssetsForTokens,
    stripMentionTokens,
    stripSkillTokens,
  } from '$lib/components/ai-shared/context';
  import {
    listAiPromptAssets,
    listAiSessions,
    readAiSession,
    writeAiMemory,
    writeAiSession,
    type AiPromptAsset,
  } from '$lib/components/ai-shared/persistence';
  import { aiChatBasename, saveAiChat } from '$lib/services/ai-chat';
  import { aiTalkSessions, type DisplayMessage } from './sessions.svelte';
  import { promptPresets } from './presets.svelte';
  import { commands } from '$lib/ipc/commands';
  import { projectStore, type FileNode } from '$lib/stores/project.svelte';
  import { renderChatMarkdown } from '$lib/components/ai-shared/chat-markdown';
  import { t } from '$lib/i18n';
  import Brain from '@lucide/svelte/icons/brain';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Copy from '@lucide/svelte/icons/copy';
  import Check from '@lucide/svelte/icons/check';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Pencil from '@lucide/svelte/icons/pencil';
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import Save from '@lucide/svelte/icons/save';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Bookmark from '@lucide/svelte/icons/bookmark';
  import ListChevronsDownUp from '@lucide/svelte/icons/list-chevrons-down-up';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import Feather from '@lucide/svelte/icons/feather';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import History from '@lucide/svelte/icons/history';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';

  let settingsOpen = $state(false);
  let saveStatus = $state<string | null>(null); // brief toast after saving
  let attachments = $state<AiContextAttachment[]>([]);
  let promptAssets = $state<AiPromptAsset[]>([...BUILTIN_SKILLS]);
  let projectSessionsLoaded = $state(false);
  const SUPPORTED_CONTEXT_EXTENSIONS = new Set(['.md', '.txt', '.canvas', '.kanban']);

  // -------- Live editor selection (poll 300ms) --------
  // Shows a selection chip above the composer so the user knows their
  // current selection will be passed as context on the next send.
  // Dismissing the chip disables injection for the *next* turn only.

  let liveSnapshot = $state<EditorSnapshot | null>(null);
  let selectionState = $state<SelectionSuggestionState>({ snapshotKey: null, status: 'none' });
  let selectionTimer: ReturnType<typeof setInterval> | null = null;

  function refreshLiveSnapshot() {
    const s = getEditorSnapshot();
    // Only track non-empty selections.
    liveSnapshot = s && s.text.length > 0 ? s : null;
    selectionState = reduceSelectionSuggestion(selectionState, {
      type: 'selection-changed',
      key: liveSnapshot ? selectionKey(liveSnapshot) : null,
    });
  }

  // ------------------------------- Chat -------------------------------

  // Messages / history / cost all live in the session store now. These
  // derived values re-track whenever the active session id changes (tab
  // switch) or when the active session's content changes (message append).
  let messages = $derived<DisplayMessage[]>(aiTalkSessions.active?.messages ?? []);
  let activeSessionId = $derived(aiTalkSessions.activeId);

  let chatInput = $state('');
  let chatStreaming = $state(false);
  let chatStreamId: string | null = null;
  let chatScroller = $state<HTMLDivElement | undefined>(undefined);
  // Follow the stream only while the reader is already at the bottom; once
  // they scroll up to reread, stop yanking the view and offer a jump button.
  let stickToBottom = $state(true);
  // Live clock for the "Reasoning 3.2s" / "Thinking 1.4s" counters.
  let now = $state(Date.now());
  let turnStartedAt = $state<number | null>(null);
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  let copiedIndex = $state<number | null>(null);
  /** User overrides of the reasoning disclosure, keyed by message index. */
  let reasoningOpen = $state<Record<number, boolean>>({});
  // No trailing trim: a trailing space (inserted after picking a command)
  // must close the menu so Enter/Tab go back to normal typing.
  let commandMenuVisible = $derived(/^\s*\/[a-z-]*$/.test(chatInput));
  let commandQuery = $derived(chatInput.trim().startsWith('/') ? chatInput.trim().slice(1) : '');
  let mentionMenuVisible = $derived(/(^|\s)@[^\s]*$/.test(chatInput));
  let mentionQuery = $derived((/(?:^|\s)@([^\s]*)$/.exec(chatInput)?.[1] ?? '').toLowerCase());
  let mentionCandidates = $derived(buildMentionCandidates());
  let suggestedSelection = $derived(
    liveSnapshot && aiTalkSettings.value.includeSelection && selectionState.status !== 'none'
      ? { attachment: selectionAttachment(liveSnapshot), status: selectionState.status }
      : null,
  );

  /**
   * Resolves the effective system prompt / model / temperature for the
   * active session, preferring the session's assigned preset over the
   * global AI Talk settings.
   */
  function activeConfig(): {
    systemPrompt: string;
    model: string;
    temperature: number;
  } {
    const s = aiTalkSettings.value;
    const presetId = aiTalkSessions.active?.presetId;
    const preset = presetId ? promptPresets.get(presetId) : null;
    return {
      systemPrompt: preset?.systemPrompt ?? s.systemPrompt,
      model: preset?.model ?? s.model,
      temperature: preset?.temperature ?? s.temperature,
    };
  }

  /**
   * Build the OpenAI message list for a turn. `history` is the exact
   * conversation to send (ending with the user message for this turn) —
   * passed explicitly so retry/edit can replay a truncated transcript.
   * The edit-suggestion protocol is always appended to the system prompt
   * so structured ```novelist-edit blocks come back regardless of preset.
   */
  function buildChatContextFrom(history: DisplayMessage[], extraContext: AiContextAttachment[] = []): ChatMessage[] {
    const ctx: ChatMessage[] = [];
    const s = aiTalkSettings.value;
    const cfg = activeConfig();
    const systemPrompt = [cfg.systemPrompt.trim(), EDIT_SUGGESTION_PROTOCOL].filter(Boolean).join('\n\n');
    ctx.push({ role: 'system', content: systemPrompt });

    const snap = getEditorSnapshot();
    if (snap) {
      if (s.includeCurrentFile && snap.fullDoc.trim()) {
        ctx.push({
          role: 'user',
          content: `The user is currently editing "${snap.filePath ?? 'untitled'}". Document contents:\n\n${snap.fullDoc}`,
        });
      }
    }

    if (extraContext.length > 0) {
      const pack = buildContextPack('Use the attached context for this turn.', extraContext.map(attachmentToContextItem));
      ctx.push({
        role: 'user',
        content: contextPackToPrompt(pack),
      });
    }

    for (const m of history) {
      ctx.push({ role: m.role, content: m.content });
    }
    return ctx;
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
    chatInput = `/${id} `;
  }

  async function pickMention(token: string, attachment?: AiContextAttachment) {
    if (attachment) {
      addAttachments([await hydrateAttachment(attachment)]);
      chatInput = chatInput.replace(/(^|\s)@[^\s]*$/, '$1').trimStart();
      return;
    }
    // Prefix tokens (`@file:`, `@folder:`) need a path typed contiguously after
    // the colon, so no trailing space — a space would break `file:[^\s]+`
    // matching and the mention would be dropped from the turn. Complete tokens
    // (`@selection`, …) get a trailing space to close the menu.
    const trailing = token.endsWith(':') ? '' : ' ';
    chatInput = chatInput.replace(/(^|\s)@[^\s]*$/, `$1${token}${trailing}`);
  }

  function selectionKey(snapshot: EditorSnapshot): string {
    return `${snapshot.filePath ?? 'untitled'}:${snapshot.from}:${snapshot.to}:${snapshot.text.length}`;
  }

  function selectionAttachment(snapshot: EditorSnapshot): AiContextAttachment {
    return createAttachmentFromContext({
      id: `selection:${selectionKey(snapshot)}`,
      kind: 'selection',
      label: `Selection (${snapshot.text.length} chars)`,
      path: snapshot.filePath ?? undefined,
      content: snapshot.text,
    });
  }

  function attachSelectionSuggestion() {
    if (!liveSnapshot) return;
    addAttachments([selectionAttachment(liveSnapshot)]);
    selectionState = reduceSelectionSuggestion(selectionState, { type: 'attach' });
  }

  function dismissSelectionSuggestion() {
    selectionState = reduceSelectionSuggestion(selectionState, { type: 'dismiss' });
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
    const sessionCandidates: AiContextAttachment[] = aiTalkSessions.sessions
      .filter((session) => session.messages.length > 0)
      .map((session) => ({
        id: `session:${session.id}`,
        kind: 'session',
        label: `Session: ${session.title}`,
        source: 'session',
        mode: 'summary',
        content: session.messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join('\n\n'),
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

  async function handleSpecialTalkCommand(commandId: string): Promise<boolean> {
    if (commandId === 'clear') {
      clearChat();
      return true;
    }
    if (commandId === 'save') {
      await saveChatToProject();
      return true;
    }
    if (commandId === 'compact') {
      await compactConversation();
      return true;
    }
    return false;
  }

  async function compactConversation() {
    const sessionId = aiTalkSessions.ensureOne();
    if (messages.length < 2) {
      saveStatus = 'Need a longer conversation to compact.';
      setTimeout(() => (saveStatus = null), 2500);
      return;
    }
    if (!aiTalkSettings.value.apiKey) {
      saveStatus = 'Set an API key before compacting.';
      setTimeout(() => (saveStatus = null), 2500);
      return;
    }
    chatStreaming = true;
    let summary = '';
    try {
      const cfg = activeConfig();
      const req = buildChatRequest({
        baseUrl: aiTalkSettings.value.baseUrl,
        apiKey: aiTalkSettings.value.apiKey,
        model: cfg.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'Compact this conversation into a concise memory summary for future writing context. Preserve names, decisions, unresolved questions, and user preferences.',
          },
          { role: 'user', content: messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n') },
        ],
      });
      chatStreamId = await startAiStream(req);
      for await (const ev of aiStream(chatStreamId)) {
        if (ev.kind === 'chunk') {
          const delta = parseChatChunk(ev.data);
          if (delta?.content) summary += delta.content;
        }
      }
      aiTalkSessions.compactActive(summary || 'Conversation compacted.');
      await persistProjectSessions();
    } catch (e) {
      aiTalkSessions.updateMessages(sessionId, [
        ...messages,
        { role: 'assistant', content: `Compact failed: ${e instanceof Error ? e.message : String(e)}` },
      ]);
    } finally {
      chatStreaming = false;
      chatStreamId = null;
    }
  }

  async function sendChat() {
    const text = chatInput.trim();
    if (!text || chatStreaming) return;
    // Make sure we have a session to write into.
    const sessionId = aiTalkSessions.ensureOne();
    const slash = parseSlashCommand(text);
    if (slash && await handleSpecialTalkCommand(slash.id)) {
      chatInput = '';
      return;
    }

    if (!aiTalkSettings.value.apiKey) {
      aiTalkSessions.updateMessages(sessionId, [
        ...messages,
        { role: 'assistant', content: '⚠️ Set an API key in Settings first.' },
      ]);
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
    const turnContext = [...attachments, ...mentionAttachments, ...skillAttachments];
    if (mentionAttachments.length > 0 || skillAttachments.length > 0) {
      addAttachments([...mentionAttachments, ...skillAttachments]);
    }
    const cleaned = stripSkillTokens(stripMentionTokens(slash ? slash.rest || text : text));
    const instruction = commandInstruction(slash);
    const effectiveText = instruction
      ? `${instruction}\n\nUser request: ${cleaned || slash?.rest || text}`
      : cleaned || text;

    const history: DisplayMessage[] = [...messages, { role: 'user', content: effectiveText }];
    chatInput = '';
    await runAssistantTurn(sessionId, history, turnContext);
  }

  /**
   * Stream one assistant completion for the given conversation history
   * (which must end with a user message). Shared by send, retry, and edit.
   */
  async function runAssistantTurn(
    sessionId: string,
    history: DisplayMessage[],
    turnContext: AiContextAttachment[] = [],
  ) {
    // Snapshot messages through this turn locally so we can index into
    // the assistant slot as deltas arrive; we push the full array back
    // into the store after each update.
    const assistantIdx = history.length;
    const working: DisplayMessage[] = [...history, { role: 'assistant', content: '' }];
    aiTalkSessions.updateMessages(sessionId, working);
    chatStreaming = true;
    turnStartedAt = Date.now();
    now = turnStartedAt;
    clockTimer ??= setInterval(() => (now = Date.now()), 100);
    delete reasoningOpen[assistantIdx];
    scrollChat(true);
    let reasoningStartedAt: number | null = null;
    let reasoningMs: number | undefined;

    let buffered = '';
    let bufferedReasoning = '';
    try {
      const cfg = activeConfig();
      const req = buildChatRequest({
        baseUrl: aiTalkSettings.value.baseUrl,
        apiKey: aiTalkSettings.value.apiKey,
        model: cfg.model,
        temperature: cfg.temperature,
        messages: buildChatContextFrom(history, turnContext),
      });
      chatStreamId = await startAiStream(req);
      for await (const ev of aiStream(chatStreamId)) {
        if (ev.kind === 'chunk') {
          const delta = parseChatChunk(ev.data);
          if (delta?.reasoning) {
            reasoningStartedAt ??= Date.now();
            bufferedReasoning += delta.reasoning;
          }
          if (delta?.content) {
            if (reasoningStartedAt !== null && reasoningMs === undefined) reasoningMs = Date.now() - reasoningStartedAt;
            buffered += delta.content;
          }
          if (delta?.reasoning || delta?.content) {
            working[assistantIdx] = {
              role: 'assistant',
              content: buffered,
              reasoning: bufferedReasoning || undefined,
              reasoningMs,
            };
            aiTalkSessions.updateMessages(sessionId, [...working]);
            scrollChat();
          }
        } else if (ev.kind === 'error') {
          working[assistantIdx] = {
            role: 'assistant',
            content: `${buffered}\n\n⚠️ ${ev.message}${ev.status ? ` (HTTP ${ev.status})` : ''}`,
            reasoning: bufferedReasoning || undefined,
          };
          aiTalkSessions.updateMessages(sessionId, [...working]);
        }
      }
    } catch (e) {
      working[assistantIdx] = {
        role: 'assistant',
        content: `${buffered}\n\n⚠️ ${e instanceof Error ? e.message : String(e)}`,
        reasoning: bufferedReasoning || undefined,
      };
      aiTalkSessions.updateMessages(sessionId, [...working]);
    } finally {
      if (reasoningStartedAt !== null && reasoningMs === undefined) {
        working[assistantIdx] = { ...working[assistantIdx], reasoningMs: Date.now() - reasoningStartedAt };
        aiTalkSessions.updateMessages(sessionId, [...working]);
      }
      stopClock();
      chatStreaming = false;
      chatStreamId = null;
      await persistProjectSessions();
    }
  }

  function stopClock() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
    turnStartedAt = null;
  }

  // -------- Per-message actions: copy / edit / retry / suggestions --------

  let editingIndex = $state<number | null>(null);
  let editingText = $state('');

  function copyMessage(content: string, index?: number) {
    void navigator.clipboard?.writeText(content).then(
      () => {
        if (index === undefined) return;
        copiedIndex = index;
        setTimeout(() => {
          if (copiedIndex === index) copiedIndex = null;
        }, 1400);
      },
      () => {},
    );
  }

  /** Regenerate the assistant message at index `i` from the turns before it. */
  function retryMessage(i: number) {
    if (chatStreaming || !activeSessionId) return;
    const history = messages.slice(0, i);
    if (history.length === 0 || history[history.length - 1].role !== 'user') return;
    void runAssistantTurn(activeSessionId, history, [...attachments]);
  }

  function startEditMessage(i: number) {
    if (chatStreaming) return;
    editingIndex = i;
    editingText = messages[i].content;
  }

  function cancelEditMessage() {
    editingIndex = null;
    editingText = '';
  }

  /** Replace the edited user message, drop everything after it, and re-send. */
  function submitEditMessage() {
    if (editingIndex == null || chatStreaming || !activeSessionId) return;
    const text = editingText.trim();
    if (!text) return;
    const history: DisplayMessage[] = [
      ...messages.slice(0, editingIndex),
      { role: 'user', content: text },
    ];
    cancelEditMessage();
    void runAssistantTurn(activeSessionId, history, [...attachments]);
  }

  function setSuggestionStatus(messageIndex: number, suggestionId: string, status: SuggestionStatus) {
    if (!activeSessionId) return;
    const next = messages.map((m, idx) =>
      idx === messageIndex
        ? { ...m, suggestionStatus: { ...(m.suggestionStatus ?? {}), [suggestionId]: status } }
        : m,
    );
    aiTalkSessions.updateMessages(activeSessionId, next);
    void persistProjectSessions();
  }

  /** Apply a suggestion to the active editor document by exact match. */
  function acceptSuggestion(messageIndex: number, suggestion: EditSuggestion) {
    const snap = getEditorSnapshot();
    const range = snap ? locateSuggestion(snap.fullDoc, suggestion) : null;
    if (!range) {
      setSuggestionStatus(messageIndex, suggestion.id, 'conflict');
      return;
    }
    replaceEditorRange(range.from, range.to, suggestion.replace);
    setSuggestionStatus(messageIndex, suggestion.id, 'accepted');
  }

  function rejectSuggestion(messageIndex: number, suggestion: EditSuggestion) {
    setSuggestionStatus(messageIndex, suggestion.id, 'rejected');
  }

  function acceptAllSuggestions(messageIndex: number, list: EditSuggestion[]) {
    for (const suggestion of list) {
      const status = messages[messageIndex]?.suggestionStatus?.[suggestion.id];
      if (!status) acceptSuggestion(messageIndex, suggestion);
    }
  }

  async function cancelChat() {
    if (chatStreamId) {
      const id = chatStreamId;
      chatStreamId = null;
      await cancelAiStream(id).catch(() => {});
    }
    chatStreaming = false;
    stopClock();
  }

  function clearChat() {
    if (activeSessionId) aiTalkSessions.clearMessages(activeSessionId);
    void persistProjectSessions();
  }

  // -------- Save current session to project as markdown --------

  function messagesToMarkdown(title: string, msgs: DisplayMessage[]): string {
    const iso = new Date().toISOString();
    const lines: string[] = [];
    lines.push(`# ${title}`);
    lines.push('');
    lines.push(`_Exported from AI Talk · ${iso}_`);
    lines.push('');
    for (const m of msgs) {
      lines.push(m.role === 'user' ? '## You' : m.role === 'system' ? '## Memory' : '## Assistant');
      lines.push('');
      lines.push(m.content);
      lines.push('');
    }
    return lines.join('\n');
  }

  function safeFilename(raw: string): string {
    return raw.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'chat';
  }

  async function saveChatToProject() {
    const session = aiTalkSessions.active;
    if (!session) {
      saveStatus = 'No active chat to save.';
      setTimeout(() => (saveStatus = null), 2500);
      return;
    }
    if (messages.length === 0) {
      saveStatus = 'This chat is empty.';
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
    const filename = `${safeFilename(session.title)}-${stamp}.md`;
    const body = messagesToMarkdown(session.title, messages);
    try {
      const resolvedPath = await saveAiChat(projectDir, filename, body);
      saveStatus = `Saved · .novelist/chats/${aiChatBasename(resolvedPath)}`;
    } catch (e) {
      saveStatus = `Save failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    setTimeout(() => (saveStatus = null), 4000);
  }

  async function saveMemory() {
    const projectDir = projectStore.dirPath;
    if (!projectDir || messages.length === 0) return;
    const memory = messages.map((m) => `## ${m.role}\n\n${m.content}`).join('\n\n');
    try {
      await writeAiMemory(projectDir, memory);
      saveStatus = 'Saved · .novelist/ai/memory.md';
    } catch (e) {
      saveStatus = `Memory failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    setTimeout(() => (saveStatus = null), 3000);
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
      const files = await listAiSessions(projectDir, 'talk');
      if (files.length > 0) {
        const sessions = [];
        for (const file of files) {
          const raw = await readAiSession(projectDir, 'talk', file.id);
          if (raw) sessions.push(JSON.parse(raw));
        }
        if (sessions.length > 0) aiTalkSessions.replaceAll(sessions, aiTalkSessions.activeId);
      } else if (aiTalkSessions.sessions.length > 0) {
        await persistProjectSessions();
      }
    } catch (e) {
      console.warn('[ai-talk] failed to load project AI assets', e);
    }
  }

  async function persistProjectSessions() {
    const projectDir = projectStore.dirPath;
    if (!projectDir) return;
    await Promise.all(
      aiTalkSessions.sessions.map((session) =>
        writeAiSession(projectDir, 'talk', session.id, session).catch(() => {}),
      ),
    );
  }

  function scrollChat(force = false) {
    if (force) stickToBottom = true;
    if (!stickToBottom) return;
    queueMicrotask(() => {
      if (chatScroller) chatScroller.scrollTop = chatScroller.scrollHeight;
    });
  }

  function onChatScroll() {
    if (!chatScroller) return;
    const gap = chatScroller.scrollHeight - chatScroller.scrollTop - chatScroller.clientHeight;
    stickToBottom = gap < 48;
  }

  function jumpToBottom() {
    stickToBottom = true;
    chatScroller?.scrollTo({ top: chatScroller.scrollHeight, behavior: 'smooth' });
  }

  function formatSeconds(ms: number): string {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  }

  /** Rough token estimate: CJK ≈ 1 token/char, other scripts ≈ 4 chars/token. */
  function estimateTokens(text: string): number {
    let cjk = 0;
    for (const ch of text) if (/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)) cjk++;
    return Math.round(cjk + (text.length - cjk) / 4);
  }

  function formatCount(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  }

  let contextTokens = $derived(
    estimateTokens(messages.map((m) => m.content).join('\n') + attachments.map((a) => a.content).join('\n')),
  );

  function isReasoningOpen(i: number, m: DisplayMessage): boolean {
    if (i in reasoningOpen) return reasoningOpen[i];
    // Auto-expand while the model is still thinking, collapse once it answers.
    return chatStreaming && i === messages.length - 1 && !m.content;
  }

  function toggleReasoning(i: number, m: DisplayMessage) {
    reasoningOpen = { ...reasoningOpen, [i]: !isReasoningOpen(i, m) };
  }

  const STARTERS = ['continue', 'polish', 'consistency', 'brainstorm'] as const;

  function useStarter(key: (typeof STARTERS)[number]) {
    chatInput = t(`aiTalk.starter.${key}`);
    queueMicrotask(() => document.querySelector<HTMLTextAreaElement>('[data-testid="ai-talk-input"]')?.focus());
  }

  // Open settings on mount if a request flag is set (used by "Configure" entry)
  onMount(() => {
    if (sessionStorage.getItem('novelist:ai-talk:open-settings') === '1') {
      sessionStorage.removeItem('novelist:ai-talk:open-settings');
      settingsOpen = true;
    }
    aiTalkSessions.ensureOne();
    void loadProjectSessions();
    refreshLiveSnapshot();
    selectionTimer = setInterval(refreshLiveSnapshot, 300);
    window.addEventListener('novelist:ai-talk:save-chat', saveChatToProject);
  });

  // ---- Session + preset helpers wired to SessionTabs / preset picker ----

  function handleSessionSelect(id: string) {
    // Cancel any in-flight stream on the previous session before switching.
    if (chatStreaming) void cancelChat();
    cancelEditMessage();
    aiTalkSessions.setActive(id);
    reasoningOpen = {};
    scrollChat(true);
  }

  function handleSessionDelete(id: string) {
    if (aiTalkSessions.activeId === id && chatStreaming) void cancelChat();
    aiTalkSessions.delete(id);
    // Always keep at least one session so the UI doesn't collapse to empty.
    if (aiTalkSessions.sessions.length === 0) aiTalkSessions.create();
    void persistProjectSessions();
  }

  function handleSessionNew() {
    if (chatStreaming) void cancelChat();
    aiTalkSessions.create();
    void persistProjectSessions();
  }

  function handleSessionRename(id: string, title: string) {
    aiTalkSessions.rename(id, title);
    void persistProjectSessions();
  }

  function handlePresetChange(presetId: string) {
    if (!activeSessionId) return;
    aiTalkSessions.setPreset(activeSessionId, presetId === 'none' ? undefined : presetId);
    void persistProjectSessions();
  }

  let activePresetId = $derived(aiTalkSessions.active?.presetId ?? 'none');
  let activePresetLabel = $derived.by(() => {
    const preset = activePresetId === 'none' ? null : promptPresets.get(activePresetId);
    if (!preset) return t('aiTalk.noPreset');
    return `${typeof preset.icon === 'string' && preset.icon ? `${preset.icon} ` : ''}${preset.name}`;
  });
  let activeModelLabel = $derived.by(() => {
    const s = aiTalkSettings.value;
    const profile = s.profiles.find((p) => p.id === s.activeProfileId);
    return profile?.model || profile?.label || s.model;
  });

  // Cancel any in-flight streams when the panel unmounts so the Rust task
  // exits and the Tauri listener gets cleaned up via the iterator's finally.
  onDestroy(() => {
    cancelPendingStreams([chatStreamId], cancelAiStream);
    if (selectionTimer) clearInterval(selectionTimer);
    stopClock();
    window.removeEventListener('novelist:ai-talk:save-chat', saveChatToProject);
  });
</script>


<main>
  <SessionTabs
    items={aiTalkSessions.sessions}
    activeId={aiTalkSessions.activeId}
    onSelect={handleSessionSelect}
    onNew={handleSessionNew}
    onDelete={handleSessionDelete}
    onRename={handleSessionRename}
    testidPrefix="ai-talk-session"
    newLabel="New chat"
  />

  <header class="toolbar">
    <div class="usage" title="{t('aiTalk.context')} ≈ {contextTokens} tokens">
      <span class="usage-metric num" title={t('aiTalk.messageCount', { count: messages.length })}><History size={12} />{messages.length}</span>
      <span class="usage-metric num">≈{formatCount(contextTokens)} tokens</span>
    </div>
    <div class="tools">
      <button
        class="tool"
        onclick={compactConversation}
        disabled={chatStreaming || messages.length < 2}
        title={t('aiTalk.compact')}
        aria-label={t('aiTalk.compact')}
      ><ListChevronsDownUp size={15} /></button>
      <button
        class="tool"
        onclick={saveMemory}
        disabled={chatStreaming || messages.length === 0 || !projectStore.dirPath}
        title={t('aiTalk.memory')}
        aria-label={t('aiTalk.memory')}
      ><Bookmark size={15} /></button>
      <button
        class="tool"
        data-testid="ai-talk-save"
        onclick={saveChatToProject}
        disabled={chatStreaming || messages.length === 0}
        title={t('aiTalk.save')}
        aria-label={t('aiTalk.save')}
      ><Save size={15} /></button>
      <button
        class="tool"
        data-testid="ai-talk-clear"
        onclick={clearChat}
        disabled={chatStreaming}
        title={t('aiTalk.clear')}
        aria-label={t('aiTalk.clear')}
      ><Trash2 size={15} /></button>
      <button
        class="tool"
        class:active={settingsOpen}
        title={t('aiTalk.settings')}
        aria-label={t('aiTalk.settings')}
        aria-pressed={settingsOpen}
        onclick={() => (settingsOpen = !settingsOpen)}
      ><Settings2 size={15} /></button>
    </div>
  </header>

  {#if settingsOpen}
    <section class="settings-drawer">
      <AiTalkSettings compact />
    </section>
  {/if}

  <div class="chat-wrap">
    <div class="chat" data-testid="ai-talk-chat" bind:this={chatScroller} onscroll={onChatScroll}>
      {#each messages as m, i (i)}
        <div class="msg {m.role}" data-testid="ai-talk-msg-{m.role}">
          {#if editingIndex === i}
            <div class="edit-box" data-testid="ai-talk-edit-box">
              <!-- svelte-ignore a11y_autofocus -->
              <textarea rows="3" bind:value={editingText} data-testid="ai-talk-edit-input" autofocus></textarea>
              <div class="edit-actions">
                <button class="novelist-btn novelist-btn-quiet" onclick={cancelEditMessage}>{t('aiTalk.cancel')}</button>
                <button
                  class="novelist-btn novelist-btn-primary"
                  data-testid="ai-talk-edit-send"
                  disabled={!editingText.trim() || chatStreaming}
                  onclick={submitEditMessage}
                >{t('aiTalk.send')}</button>
              </div>
            </div>
          {:else if m.role === 'assistant'}
            {@const split = splitEditSuggestions(m.content)}
            {@const live = chatStreaming && i === messages.length - 1}
            {#if m.reasoning}
              {@const open = isReasoningOpen(i, m)}
              {@const thinking = live && !m.content}
              <div class="step" data-testid="ai-talk-reasoning" class:open>
                <button class="step-head" onclick={() => toggleReasoning(i, m)} aria-expanded={open}>
                  <Brain size={14} class="step-icon" />
                  <span class="step-title" class:shimmer={thinking} data-text={t('aiTalk.reasoning')}>{t('aiTalk.reasoning')}</span>
                  <span class="step-meta num">
                    {#if thinking && turnStartedAt}
                      {formatSeconds(now - turnStartedAt)}
                    {:else if m.reasoningMs !== undefined}
                      {formatSeconds(m.reasoningMs)}
                    {/if}
                  </span>
                  <ChevronRight size={13} class="step-chevron" />
                </button>
                {#if open}
                  <div class="step-body"><pre>{m.reasoning}</pre></div>
                {/if}
              </div>
            {:else if live && !m.content}
              <div class="step">
                <div class="step-head static">
                  <Sparkles size={14} class="step-icon" />
                  <span class="step-title shimmer" data-text={t('aiTalk.thinking')}>{t('aiTalk.thinking')}</span>
                  {#if turnStartedAt}<span class="step-meta num">{formatSeconds(now - turnStartedAt)}</span>{/if}
                </div>
              </div>
            {/if}
            {@const body = split.suggestions.length > 0 ? split.body : m.content}
            {#if body.trim()}
              <div class="content md" class:streaming={live}>{@html renderChatMarkdown(body)}</div>
            {/if}
            {#if split.suggestions.length > 0}
              <div class="suggestions">
                {#each split.suggestions as s (s.id)}
                  <AiEditSuggestionCard
                    suggestion={s}
                    status={m.suggestionStatus?.[s.id]}
                    disabled={chatStreaming}
                    onAccept={() => acceptSuggestion(i, s)}
                    onReject={() => rejectSuggestion(i, s)}
                  />
                {/each}
                {#if split.suggestions.length > 1 && split.suggestions.some((s) => !m.suggestionStatus?.[s.id])}
                  <div class="suggestions-bulk">
                    <button
                      class="novelist-btn novelist-btn-ghost novelist-btn-sm"
                      data-testid="ai-talk-accept-all-suggestions"
                      disabled={chatStreaming}
                      onclick={() => acceptAllSuggestions(i, split.suggestions)}
                    ><Check size={12} />{t('aiTalk.acceptAll')}</button>
                  </div>
                {/if}
              </div>
            {/if}
            {#if !live}
              <div class="msg-actions">
                <button
                  onclick={() => copyMessage(m.content, i)}
                  title={t('aiTalk.copy')}
                  aria-label={t('aiTalk.copy')}
                  class:copied={copiedIndex === i}
                >{#if copiedIndex === i}<Check size={13} />{:else}<Copy size={13} />{/if}</button>
                {#if i > 0 && messages[i - 1].role === 'user'}
                  <button
                    data-testid="ai-talk-retry"
                    disabled={chatStreaming}
                    onclick={() => retryMessage(i)}
                    title={t('aiTalk.retry')}
                    aria-label={t('aiTalk.retry')}
                  ><RotateCcw size={13} /></button>
                {/if}
              </div>
            {/if}
          {:else if m.role === 'system'}
            <details class="memory-card">
              <summary><Bookmark size={13} />{t('aiTalk.memorySummary')}</summary>
              <div class="content md">{@html renderChatMarkdown(m.content)}</div>
            </details>
          {:else}
            <div class="content user-card">{m.content}</div>
            <div class="msg-actions user-actions">
              <button
                onclick={() => copyMessage(m.content, i)}
                title={t('aiTalk.copy')}
                aria-label={t('aiTalk.copy')}
                class:copied={copiedIndex === i}
              >{#if copiedIndex === i}<Check size={13} />{:else}<Copy size={13} />{/if}</button>
              <button
                data-testid="ai-talk-edit"
                disabled={chatStreaming}
                onclick={() => startEditMessage(i)}
                title={t('aiTalk.edit')}
                aria-label={t('aiTalk.edit')}
              ><Pencil size={13} /></button>
            </div>
          {/if}
        </div>
      {/each}
      {#if messages.length === 0}
        <div class="empty">
          <div class="empty-mark"><Feather size={20} /></div>
          <p class="empty-title">{t('aiTalk.emptyTitle')}</p>
          <p class="empty-body">{t('aiTalk.emptyBody')}</p>
          <div class="starters">
            {#each STARTERS as key}
              <button class="starter" onclick={() => useStarter(key)}>{t(`aiTalk.starter.${key}`)}</button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
    <button
      class="scroll-bottom"
      data-visible={!stickToBottom && messages.length > 0}
      onclick={jumpToBottom}
      title={t('aiTalk.scrollToBottom')}
      aria-label={t('aiTalk.scrollToBottom')}
      tabindex={stickToBottom ? -1 : 0}
    ><ArrowDown size={15} /></button>
  </div>

  {#if saveStatus}
    <div class="save-status" data-testid="ai-talk-save-status">{saveStatus}</div>
  {/if}

  <div data-testid="ai-talk-composer">
    <AiComposer
      value={chatInput}
      placeholder={t('aiTalk.placeholder')}
      hint={t('aiTalk.hint')}
      inputTestId="ai-talk-input"
      attachments={attachments}
      mentionVisible={mentionMenuVisible}
      mentionQuery={mentionQuery}
      mentionCandidates={mentionCandidates}
      commandVisible={commandMenuVisible}
      commandQuery={commandQuery}
      suggestedSelection={suggestedSelection}
      busy={chatStreaming}
      canSend={Boolean(chatInput.trim())}
      sendLabel={t('aiTalk.send')}
      sendTestId="ai-talk-send"
      stopTestId="ai-talk-stop"
      onInput={(value) => (chatInput = value)}
      onSend={sendChat}
      onStop={cancelChat}
      onPickMention={pickMention}
      onPickCommand={pickCommand}
      onRemoveAttachment={removeAttachment}
      onClearAttachments={clearAttachments}
      onAttachSelection={attachSelectionSuggestion}
      onDismissSelection={dismissSelectionSuggestion}
    >
      {#snippet footer()}
        <label class="chip chip-strong" title={t('aiTalk.preset')}>
          <span class="chip-label">{activePresetLabel}</span>
          <select
            data-testid="ai-talk-preset-picker"
            value={activePresetId}
            onchange={(e) => handlePresetChange(e.currentTarget.value)}
            aria-label={t('aiTalk.preset')}
          >
            <option value="none">{t('aiTalk.noPreset')}</option>
            {#each promptPresets.all as p (p.id)}
              <option value={p.id}>{typeof p.icon === 'string' && p.icon ? `${p.icon} ` : ''}{p.name}</option>
            {/each}
          </select>
          <ChevronDown size={11} class="chip-caret" />
        </label>
        <label class="chip" title={t('aiTalk.modelProfile')}>
          <Sparkles size={12} class="chip-icon" />
          <span class="chip-label">{activeModelLabel}</span>
          <select
            data-testid="ai-talk-model-picker"
            value={aiTalkSettings.value.activeProfileId}
            onchange={(e) => aiTalkSettings.update({ activeProfileId: e.currentTarget.value })}
            aria-label={t('aiTalk.modelProfile')}
          >
            {#each aiTalkSettings.value.profiles as p (p.id)}
              <option value={p.id}>{p.model || p.label}</option>
            {/each}
          </select>
          <ChevronDown size={11} class="chip-caret" />
        </label>
      {/snippet}
    </AiComposer>
  </div>
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

  /* ---- Toolbar: context usage + icon actions (OpenFic-style) ---- */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 30px;
    padding: 2px 6px 2px 12px;
    border-bottom: 1px solid var(--novelist-border-subtle, var(--novelist-border));
  }
  .usage {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    font-size: 11px;
    color: var(--novelist-text-secondary);
  }
  .usage-metric {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--novelist-text-tertiary);
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 1px;
    flex: 0 0 auto;
  }
  .tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer;
    transition: background 80ms, color 80ms;
  }
  .tool:not(:disabled):hover,
  .tool.active {
    color: var(--novelist-text);
    background: var(--novelist-bg-secondary);
  }
  .tool:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .settings-drawer {
    padding: 10px 12px;
    background: var(--novelist-bg-secondary);
    border-bottom: 1px solid var(--novelist-border);
    max-height: 50%;
    overflow-y: auto;
  }

  /* ---- Transcript ---- */
  .chat-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .chat {
    flex: 1;
    overflow-y: auto;
    padding: 14px clamp(10px, 4%, 22px) 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .msg {
    display: flex;
    flex-direction: column;
    gap: 6px;
    animation: msg-in 0.28s ease-out;
  }
  @keyframes msg-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: none; }
  }
  .msg.user {
    align-items: flex-end;
  }
  .content {
    word-wrap: break-word;
    overflow-wrap: anywhere;
  }
  .user-card {
    max-width: 88%;
    padding: 8px 11px;
    border: 1px solid var(--novelist-border);
    border-radius: 10px;
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text);
    white-space: pre-wrap;
    line-height: 1.5;
  }

  /* Assistant replies render as flowing prose — no bubble. */
  .md {
    font-family: var(--novelist-editor-font);
    font-size: 14px;
    line-height: 1.75;
    color: var(--novelist-text);
  }
  .md :global(p) { margin: 0 0 0.6em; }
  .md :global(p:last-child) { margin-bottom: 0; }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    margin: 0.9em 0 0.4em;
    font-size: 1.02em;
    font-weight: 600;
    color: var(--novelist-heading-color, var(--novelist-text));
  }
  .md :global(h1) { font-size: 1.15em; }
  .md :global(:first-child) { margin-top: 0; }
  .md :global(ul),
  .md :global(ol) { margin: 0.2em 0 0.6em; padding-left: 1.4em; }
  .md :global(ul) { list-style: disc; }
  .md :global(ol) { list-style: decimal; }
  .md :global(li::marker) { color: var(--novelist-text-tertiary); }
  .md :global(li) { margin: 0.15em 0; }
  .md :global(blockquote) {
    margin: 0.4em 0 0.7em;
    padding: 2px 0 2px 12px;
    border-left: 2px solid var(--novelist-blockquote-border, var(--novelist-border));
    color: var(--novelist-text-secondary);
  }
  .md :global(code) {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 0.86em;
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--novelist-code-bg, var(--novelist-bg-secondary));
  }
  .md :global(pre) {
    margin: 0.4em 0 0.8em;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--novelist-code-bg, var(--novelist-bg-secondary));
    overflow-x: auto;
    line-height: 1.5;
  }
  .md :global(pre code) { padding: 0; background: none; font-size: 12px; }
  .md :global(hr) { border: 0; border-top: 1px solid var(--novelist-border); margin: 0.8em 0; }
  .md :global(.md-link) { color: var(--novelist-link-color, var(--novelist-accent)); text-decoration: underline; text-underline-offset: 2px; }
  .md.streaming > :global(:last-child)::after {
    content: '';
    display: inline-block;
    width: 6px;
    height: 1em;
    margin-left: 2px;
    vertical-align: -0.12em;
    border-radius: 1px;
    background: var(--novelist-accent);
    animation: caret-blink 1s steps(2, start) infinite;
  }
  @keyframes caret-blink { to { visibility: hidden; } }

  /* ---- Step rows (reasoning / thinking) ---- */
  .step {
    display: flex;
    flex-direction: column;
  }
  .step-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    padding: 0;
    border: 0;
    background: transparent;
    font: inherit;
    font-size: 12px;
    color: var(--novelist-text-secondary);
    cursor: pointer;
    text-align: left;
    align-self: flex-start;
  }
  .step-head.static { cursor: default; }
  .step-head :global(.step-icon) { color: var(--novelist-text-tertiary); flex: 0 0 auto; }
  .step-head :global(.step-chevron) {
    color: var(--novelist-text-tertiary);
    transition: transform 120ms ease;
  }
  .step.open .step-head :global(.step-chevron) { transform: rotate(90deg); }
  .step-head:not(.static):hover,
  .step-head:not(.static):hover :global(.step-icon),
  .step-head:not(.static):hover :global(.step-chevron) {
    color: var(--novelist-text);
  }
  .step-title { font-weight: 500; }
  .step-meta {
    color: var(--novelist-text-tertiary);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
  }
  .step-body {
    position: relative;
    margin: 6px 0 2px 6px;
    padding-left: 14px;
  }
  .step-body::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 1px;
    background: color-mix(in srgb, var(--novelist-text) 18%, transparent);
  }
  .step-body pre {
    margin: 0;
    font-family: inherit;
    font-size: 12px;
    line-height: 1.7;
    color: var(--novelist-text-secondary);
    white-space: pre-wrap;
    word-wrap: break-word;
    max-height: 320px;
    overflow: auto;
  }
  /* Shimmering label while the model is working. */
  .shimmer {
    position: relative;
    color: var(--novelist-text-tertiary);
  }
  .shimmer::after {
    content: attr(data-text);
    position: absolute;
    inset: 0;
    color: transparent;
    background-image: linear-gradient(
      90deg,
      transparent 35%,
      var(--novelist-text) 50%,
      transparent 65%
    );
    background-size: 250% 100%;
    background-clip: text;
    -webkit-background-clip: text;
    animation: shimmer 2.4s ease-in-out infinite;
  }
  @keyframes shimmer {
    from { background-position: 100% 0; }
    to { background-position: -150% 0; }
  }

  .memory-card {
    border: 1px dashed var(--novelist-border);
    border-radius: 10px;
    padding: 6px 10px;
    background: var(--novelist-bg-secondary);
  }
  .memory-card summary {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    font-size: 12px;
    color: var(--novelist-text-secondary);
    user-select: none;
  }
  .memory-card[open] summary { margin-bottom: 6px; }

  /* ---- Hover toolbar under each message ---- */
  .msg-actions {
    display: flex;
    gap: 2px;
    min-height: 24px;
    opacity: 0;
    transition: opacity 120ms;
  }
  .msg:hover .msg-actions,
  .msg:focus-within .msg-actions {
    opacity: 1;
  }
  .msg-actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--novelist-text-tertiary);
    cursor: pointer;
  }
  .msg-actions button:hover:not(:disabled) {
    color: var(--novelist-text);
    background: var(--novelist-bg-secondary);
  }
  .msg-actions button.copied { color: #2da44e; }
  .msg-actions button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .edit-box {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
  }
  .edit-box textarea {
    width: 100%;
    box-sizing: border-box;
    background: var(--novelist-bg);
    border: 1px solid color-mix(in srgb, var(--novelist-text) 40%, var(--novelist-border));
    color: var(--novelist-text);
    border-radius: 10px;
    padding: 8px 10px;
    font: inherit;
    line-height: 1.5;
    resize: vertical;
    outline: none;
  }
  .edit-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  .suggestions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .suggestions-bulk {
    display: flex;
    justify-content: flex-end;
  }

  /* ---- Empty state ---- */
  .empty {
    margin: auto;
    width: 90%;
    max-width: 300px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 24px 0;
  }
  .empty-mark {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    margin-bottom: 12px;
    border-radius: 12px;
    color: var(--novelist-accent);
    background: var(--novelist-accent-soft, var(--novelist-bg-secondary));
  }
  .empty-title {
    margin: 0 0 4px;
    font-family: var(--novelist-editor-font);
    font-size: 15px;
    font-weight: 600;
    color: var(--novelist-text);
  }
  .empty-body {
    margin: 0 0 16px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--novelist-text-secondary);
  }
  .starters {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
  }
  .starter {
    padding: 8px 12px;
    border: 1px solid var(--novelist-border);
    border-radius: 8px;
    background: var(--novelist-bg);
    color: var(--novelist-text);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition: border-color 120ms, background 120ms, box-shadow 120ms;
  }
  .starter:hover {
    border-color: color-mix(in srgb, var(--novelist-text) 22%, var(--novelist-border));
    background: var(--novelist-bg-secondary);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  }

  /* ---- Floating scroll-to-bottom ---- */
  .scroll-bottom {
    position: absolute;
    right: 14px;
    bottom: 12px;
    z-index: 5;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid var(--novelist-border);
    border-radius: 999px;
    background: var(--novelist-bg);
    color: var(--novelist-text);
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
    cursor: pointer;
    opacity: 0;
    visibility: hidden;
    transform: translateY(6px);
    transition: opacity 0.16s ease-out, transform 0.16s ease-out, visibility 0s linear 0.16s;
  }
  .scroll-bottom[data-visible='true'] {
    opacity: 1;
    visibility: visible;
    transform: none;
    transition: opacity 0.16s ease-out, transform 0.16s ease-out;
  }

  .save-status {
    margin: 0 12px;
    padding: 5px 10px;
    border-radius: 8px;
    background: var(--novelist-bg-secondary);
    font-size: 11px;
    color: var(--novelist-text-secondary);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- Composer footer chips (preset / model) ---- */
  .chip {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 26px;
    min-width: 0;
    padding: 0 6px;
    border-radius: 999px;
    color: var(--novelist-text-secondary);
    cursor: pointer;
    transition: background 80ms, color 80ms;
  }
  .chip:hover {
    color: var(--novelist-text);
    background: var(--novelist-bg-secondary);
  }
  .chip-strong {
    color: var(--novelist-text);
    font-weight: 600;
  }
  .chip :global(.chip-icon) { flex: 0 0 auto; }
  .chip :global(.chip-caret) { flex: 0 0 auto; opacity: 0.55; }
  .chip-label {
    min-width: 0;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }
  /* The native select stays for keyboard + a11y but is invisible and
     stretched over the chip, so the chip width hugs the visible label. */
  .chip select {
    position: absolute;
    inset: 0;
    width: 100%;
    opacity: 0;
    appearance: none;
    -webkit-appearance: none;
    border: 0;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .chip:focus-within {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--novelist-accent) 60%, transparent);
  }
</style>
