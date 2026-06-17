<script lang="ts">
  import type { Snippet } from 'svelte';
  import AiContextBar from './AiContextBar.svelte';
  import AiMentionMenu from './AiMentionMenu.svelte';
  import AiCommandMenu from './AiCommandMenu.svelte';
  import type { SlashCommandId } from './context';
  import type { AiContextAttachment } from './attachments';
  import { attachmentToContextItem } from './attachments';
  import { filterMentionItems, filterSlashCommands } from './menu-items';
  import { getCaretCoordinates } from './caret-coordinates';
  import { IconClose, IconDocument } from '../icons';

  type SuggestedSelection = {
    attachment: AiContextAttachment;
    status: 'suggested' | 'attached' | 'dismissed';
  } | null;

  type Props = {
    value: string;
    placeholder: string;
    inputTestId?: string;
    attachments: readonly AiContextAttachment[];
    mentionVisible: boolean;
    mentionQuery: string;
    commandVisible: boolean;
    commandQuery: string;
    suggestedSelection?: SuggestedSelection;
    busy?: boolean;
    canSend: boolean;
    sendLabel?: string;
    sendTestId?: string;
    stopTestId?: string;
    onInput: (value: string) => void;
    onSend: () => void;
    onStop?: () => void;
    mentionCandidates?: readonly AiContextAttachment[];
    onPickMention: (token: string, attachment?: AiContextAttachment) => void | Promise<void>;
    onPickCommand: (id: SlashCommandId) => void;
    onRemoveAttachment: (id: string) => void;
    onClearAttachments: () => void;
    onAttachSelection?: () => void;
    onDismissSelection?: () => void;
    onDropPaths?: (paths: string[]) => void;
    actions?: Snippet;
  };

  let {
    value,
    placeholder,
    inputTestId,
    attachments,
    mentionVisible,
    mentionQuery,
    commandVisible,
    commandQuery,
    suggestedSelection = null,
    busy = false,
    canSend,
    sendLabel = 'Send',
    sendTestId,
    stopTestId,
    onInput,
    onSend,
    onStop,
    mentionCandidates = [],
    onPickMention,
    onPickCommand,
    onRemoveAttachment,
    onClearAttachments,
    onAttachSelection,
    onDismissSelection,
    onDropPaths,
    actions,
  }: Props = $props();

  let contextItems = $derived(attachments.map(attachmentToContextItem));

  // ---- Menu keyboard selection (ArrowUp/Down to move, Tab/Enter to pick) ----
  // The composer owns the filtered lists and the active index; the menu
  // components are pure renderers, so mouse and keyboard stay in sync.
  let commandItems = $derived(commandVisible ? filterSlashCommands(commandQuery) : []);
  let mentionItems = $derived(mentionVisible ? filterMentionItems(mentionQuery, mentionCandidates) : []);
  let menuLength = $derived(commandItems.length || mentionItems.length);
  let menuIndex = $state(0);
  // Reset the selection whenever the query (and thus the list) changes.
  $effect(() => {
    void commandQuery;
    void mentionQuery;
    void commandVisible;
    void mentionVisible;
    menuIndex = 0;
  });
  let activeMenuIndex = $derived(menuLength > 0 ? Math.min(menuIndex, menuLength - 1) : 0);

  // ---- Anchor the popup to the caret pixel position inside the textarea ----
  // <textarea> has no caret-rect API, so we measure via a mirror div whenever
  // a menu is open and the text changes. The menu floats upward from the caret
  // (the composer sits at the panel bottom, so there is always room above).
  const MENU_MIN_WIDTH = 220;
  let textareaEl = $state<HTMLTextAreaElement | undefined>(undefined);
  let caretLeft = $state(0);
  let caretTop = $state(0);
  $effect(() => {
    // Re-measure on input or when a menu opens/closes.
    void value;
    if (menuLength === 0 || !textareaEl) return;
    const coords = getCaretCoordinates(textareaEl, textareaEl.selectionStart);
    // Clamp horizontally so a long token near the right edge stays in view.
    const maxLeft = Math.max(0, textareaEl.clientWidth - MENU_MIN_WIDTH);
    caretLeft = Math.min(coords.left, maxLeft);
    caretTop = coords.top;
  });

  function pickActiveMenuItem(): boolean {
    if (commandItems.length > 0) {
      onPickCommand(commandItems[activeMenuIndex].id);
      return true;
    }
    if (mentionItems.length > 0) {
      const m = mentionItems[activeMenuIndex];
      void onPickMention(m.token, m.attachment);
      return true;
    }
    return false;
  }

  function keydown(e: KeyboardEvent) {
    // Never steal keys from an active IME composition (CJK input).
    if (e.isComposing) return;
    if (menuLength > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        menuIndex = (activeMenuIndex + 1) % menuLength;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        menuIndex = (activeMenuIndex - 1 + menuLength) % menuLength;
        return;
      }
      if ((e.key === 'Tab' && !e.shiftKey) || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey)) {
        if (pickActiveMenuItem()) {
          e.preventDefault();
          return;
        }
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (busy) onStop?.();
      else if (canSend) onSend();
    }
  }

  function drop(e: DragEvent) {
    const raw = e.dataTransfer?.getData('text/plain') || '';
    const paths = raw.split('\n').map((p) => p.trim()).filter(Boolean);
    if (paths.length > 0) {
      e.preventDefault();
      onDropPaths?.(paths);
    }
  }
</script>

<div
  class="ai-composer"
  data-testid="ai-composer"
  role="group"
  aria-label="AI composer"
  ondrop={drop}
  ondragover={(e) => e.preventDefault()}
>
  {#if suggestedSelection && suggestedSelection.status === 'suggested'}
    <div class="selection-suggestion" data-testid="ai-selection-suggestion">
      <button type="button" class="suggestion-main" onclick={onAttachSelection}>
        <IconDocument size={12} />
        <span>{suggestedSelection.attachment.label}</span>
      </button>
      <button type="button" class="suggestion-close" aria-label="Dismiss selection" onclick={onDismissSelection}>
        <IconClose size={12} />
      </button>
    </div>
  {/if}
  <AiContextBar
    items={contextItems}
    onRemove={onRemoveAttachment}
    onClear={onClearAttachments}
  />
  <div class="input-wrap">
    {#if menuLength > 0}
      <div class="menu-anchor" style="left: {caretLeft}px; top: {caretTop}px;">
        <AiCommandMenu items={commandItems} activeIndex={activeMenuIndex} onPick={onPickCommand} />
        <AiMentionMenu items={mentionItems} activeIndex={activeMenuIndex} onPick={onPickMention} />
      </div>
    {/if}
    <textarea
      bind:this={textareaEl}
      data-testid={inputTestId}
      rows="3"
      {placeholder}
      value={value}
      oninput={(e) => onInput(e.currentTarget.value)}
      onkeydown={keydown}
    ></textarea>
  </div>
  <div class="composer-actions">
    {#if actions}
      {@render actions()}
    {/if}
    {#if busy}
      <button class="novelist-btn novelist-btn-primary" data-testid={stopTestId} type="button" onclick={() => onStop?.()}>Stop</button>
    {:else}
      <button class="novelist-btn novelist-btn-primary" data-testid={sendTestId} type="button" onclick={onSend} disabled={!canSend}>{sendLabel}</button>
    {/if}
  </div>
</div>

<style>
  .ai-composer {
    border-top: 1px solid var(--novelist-border);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--novelist-bg-secondary);
  }
  .input-wrap {
    position: relative;
  }
  /* Floats above the caret line; the composer sits at the panel bottom so
     there is always room above. translateY lifts the menu by its own height. */
  .menu-anchor {
    position: absolute;
    z-index: 30;
    min-width: 220px;
    max-width: min(360px, 100%);
    max-height: 240px;
    overflow-y: auto;
    transform: translateY(calc(-100% - 6px));
  }
  textarea {
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
  .selection-suggestion {
    display: flex;
    align-items: center;
    border: 1px dashed color-mix(in srgb, var(--novelist-accent) 45%, var(--novelist-border));
    border-radius: 4px;
    background: color-mix(in srgb, var(--novelist-accent) 8%, var(--novelist-bg));
    overflow: hidden;
  }
  .suggestion-main {
    flex: 1;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 0;
    background: transparent;
    color: var(--novelist-text);
    padding: 4px 6px;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .suggestion-main span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .suggestion-close {
    display: inline-flex;
    align-items: center;
    border: 0;
    background: transparent;
    color: var(--novelist-text-secondary);
    padding: 4px 6px;
    cursor: pointer;
  }
  .composer-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
</style>
