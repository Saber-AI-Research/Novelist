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
  import { IconGear } from '../icons';

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
    scrollChat();

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
          if (delta?.reasoning) bufferedReasoning += delta.reasoning;
          if (delta?.content) buffered += delta.content;
          if (delta?.reasoning || delta?.content) {
            working[assistantIdx] = {
              role: 'assistant',
              content: buffered,
              reasoning: bufferedReasoning || undefined,
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
      chatStreaming = false;
      chatStreamId = null;
      await persistProjectSessions();
    }
  }

  // -------- Per-message actions: copy / edit / retry / suggestions --------

  let editingIndex = $state<number | null>(null);
  let editingText = $state('');

  function copyMessage(content: string) {
    void navigator.clipboard?.writeText(content).catch(() => {});
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

  function scrollChat() {
    queueMicrotask(() => {
      if (chatScroller) chatScroller.scrollTop = chatScroller.scrollHeight;
    });
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

  // Cancel any in-flight streams when the panel unmounts so the Rust task
  // exits and the Tauri listener gets cleaned up via the iterator's finally.
  onDestroy(() => {
    cancelPendingStreams([chatStreamId], cancelAiStream);
    if (selectionTimer) clearInterval(selectionTimer);
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

  <header>
    <div class="header-right">
      <select
        class="preset-picker"
        data-testid="ai-talk-model-picker"
        value={aiTalkSettings.value.activeProfileId}
        onchange={(e) => aiTalkSettings.update({ activeProfileId: e.currentTarget.value })}
        aria-label="Model profile"
        title="Model profile"
      >
        {#each aiTalkSettings.value.profiles as p (p.id)}
          <option value={p.id}>{p.label} · {p.model}</option>
        {/each}
      </select>
      <select
        class="preset-picker"
        data-testid="ai-talk-preset-picker"
        value={activePresetId}
        onchange={(e) => handlePresetChange(e.currentTarget.value)}
        aria-label="Apply prompt preset"
        title="Prompt preset"
      >
        <option value="none">No preset</option>
        {#each promptPresets.all as p (p.id)}
          <option value={p.id}>{typeof p.icon === 'string' && p.icon ? `${p.icon} ` : ''}{p.name}</option>
        {/each}
      </select>
      <button class="novelist-btn novelist-btn-quiet icon-btn" title="Settings" aria-label="Settings" onclick={() => (settingsOpen = !settingsOpen)}><IconGear size={14} /></button>
    </div>
  </header>

  {#if settingsOpen}
    <section class="settings-drawer">
      <AiTalkSettings compact />
    </section>
  {/if}

  <div class="chat" data-testid="ai-talk-chat" bind:this={chatScroller}>
      {#each messages as m, i (i)}
        <div class="msg {m.role}" data-testid="ai-talk-msg-{m.role}">
          <div class="role">{m.role === 'user' ? 'You' : m.role === 'system' ? 'Memory' : 'Assistant'}</div>
          {#if editingIndex === i}
            <div class="edit-box" data-testid="ai-talk-edit-box">
              <textarea rows="3" bind:value={editingText} data-testid="ai-talk-edit-input"></textarea>
              <div class="edit-actions">
                <button
                  class="novelist-btn novelist-btn-primary"
                  data-testid="ai-talk-edit-send"
                  disabled={!editingText.trim() || chatStreaming}
                  onclick={submitEditMessage}
                >Send</button>
                <button class="novelist-btn novelist-btn-ghost" onclick={cancelEditMessage}>Cancel</button>
              </div>
            </div>
          {:else if m.role === 'assistant'}
            {@const split = splitEditSuggestions(m.content)}
            {#if m.reasoning}
              <details
                class="card reasoning"
                data-testid="ai-talk-reasoning"
                open={chatStreaming && i === messages.length - 1}
              >
                <summary>Thinking</summary>
                <pre>{m.reasoning}</pre>
              </details>
            {/if}
            <div class="content">{split.suggestions.length > 0 ? split.body : m.content}</div>
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
                      class="novelist-btn novelist-btn-ghost"
                      data-testid="ai-talk-accept-all-suggestions"
                      disabled={chatStreaming}
                      onclick={() => acceptAllSuggestions(i, split.suggestions)}
                    >Accept all</button>
                  </div>
                {/if}
              </div>
            {/if}
            <div class="msg-actions">
              <button onclick={() => copyMessage(m.content)} title="Copy message">Copy</button>
              {#if i > 0 && messages[i - 1].role === 'user'}
                <button
                  data-testid="ai-talk-retry"
                  disabled={chatStreaming}
                  onclick={() => retryMessage(i)}
                  title="Regenerate this reply"
                >Retry</button>
              {/if}
            </div>
          {:else}
            <div class="content">{m.content}</div>
            {#if m.role === 'user'}
              <div class="msg-actions user-actions">
                <button onclick={() => copyMessage(m.content)} title="Copy message">Copy</button>
                <button
                  data-testid="ai-talk-edit"
                  disabled={chatStreaming}
                  onclick={() => startEditMessage(i)}
                  title="Edit and re-send (discards later messages)"
                >Edit</button>
              </div>
            {/if}
          {/if}
        </div>
      {/each}
      {#if messages.length === 0}
        <div class="empty">
          <p>Start a conversation. <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>Enter</kbd> to send.</p>
        </div>
      {/if}
    </div>
    <div data-testid="ai-talk-composer">
      <AiComposer
        value={chatInput}
        placeholder="Ask anything..."
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
        {#snippet actions()}
        {#if saveStatus}
          <span class="save-status" data-testid="ai-talk-save-status">{saveStatus}</span>
        {/if}
        <button
          class="novelist-btn novelist-btn-ghost"
          data-testid="ai-talk-clear"
          onclick={clearChat}
          disabled={chatStreaming}
          title="Clear current chat"
        >Clear</button>
        <button
          class="novelist-btn novelist-btn-ghost"
          data-testid="ai-talk-save"
          onclick={saveChatToProject}
          disabled={chatStreaming || messages.length === 0}
          title="Save chat as markdown into &lt;project&gt;/.novelist/chats/"
        >Save</button>
        <button
          class="novelist-btn novelist-btn-ghost"
          onclick={saveMemory}
          disabled={chatStreaming || messages.length === 0 || !projectStore.dirPath}
          title="Save current chat as .novelist/ai/memory.md"
        >Memory</button>
        <button
          class="novelist-btn novelist-btn-ghost"
          onclick={compactConversation}
          disabled={chatStreaming || messages.length < 2}
          title="Compact current conversation"
        >Compact</button>
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
  .header-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .preset-picker {
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    color: var(--novelist-text);
    padding: 2px 4px;
    border-radius: 3px;
    font: inherit;
    font-size: 11px;
    max-width: 160px;
  }
  .save-status {
    font-size: 11px;
    color: var(--novelist-text-secondary);
    margin-right: auto;
    align-self: center;
    font-variant-numeric: tabular-nums;
  }
  .settings-drawer {
    padding: 10px;
    background: var(--novelist-bg-secondary);
    border-bottom: 1px solid var(--novelist-border);
  }
  /* Collapsible "Thinking" block for reasoning models — mirrors the
     ai-agent panel's tool-card style. */
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
    font-family: inherit;
    font-size: 11px;
    white-space: pre-wrap;
    word-wrap: break-word;
    max-height: 280px;
    overflow: auto;
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
  .msg-actions {
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 100ms;
  }
  .msg:hover .msg-actions,
  .msg:focus-within .msg-actions {
    opacity: 1;
  }
  .msg-actions.user-actions {
    align-self: flex-end;
  }
  .msg-actions button {
    border: 1px solid var(--novelist-border);
    background: var(--novelist-bg);
    color: var(--novelist-text-secondary);
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 10px;
    cursor: pointer;
  }
  .msg-actions button:hover:not(:disabled) {
    color: var(--novelist-text);
    background: var(--novelist-bg-secondary);
  }
  .msg-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .edit-box {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .edit-box textarea {
    width: 100%;
    box-sizing: border-box;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-accent);
    color: var(--novelist-text);
    border-radius: 4px;
    padding: 6px 8px;
    font: inherit;
    resize: vertical;
  }
  .edit-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }
  .suggestions {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 4px;
  }
  .suggestions-bulk {
    display: flex;
    justify-content: flex-end;
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
  /* Button styles live in app.css — .novelist-btn / -primary / -ghost. */
</style>
