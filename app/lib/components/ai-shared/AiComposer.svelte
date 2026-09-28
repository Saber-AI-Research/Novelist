<script lang="ts">
  import type { Snippet } from 'svelte';
  import AiContextBar from './AiContextBar.svelte';
  import AiMentionMenu from './AiMentionMenu.svelte';
  import AiCommandMenu from './AiCommandMenu.svelte';
  import type { AiContextAttachment } from './attachments';
  import type { AiPromptAsset } from './persistence';
  import { attachmentToContextItem } from './attachments';
  import { filterMentionItems, filterSlashCommands } from './menu-items';
  import { getCaretCoordinates } from './caret-coordinates';
  import { IconClose, IconDocument } from '../icons';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Square from '@lucide/svelte/icons/square';

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
    commandAssets?: readonly AiPromptAsset[];
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
    onPickCommand: (id: string) => void;
    onRemoveAttachment: (id: string) => void;
    onClearAttachments: () => void;
    onAttachSelection?: () => void;
    onDismissSelection?: () => void;
    onDropPaths?: (paths: string[]) => void;
    /** Right side of the footer, before the send button. */
    actions?: Snippet;
    /** Left side of the footer (mode / model chips). */
    footer?: Snippet;
    /** Hint shown under the box (e.g. keyboard shortcuts). */
    hint?: string;
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
    commandAssets = [],
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
    footer,
    hint,
  }: Props = $props();

  let focused = $state(false);

  // Grow the textarea with its content (2–10 lines) instead of a fixed
  // 3-row box with a manual resize handle.
  $effect(() => {
    void value;
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, 240)}px`;
  });

  let contextItems = $derived(attachments.map(attachmentToContextItem));

  // ---- Menu keyboard selection (ArrowUp/Down to move, Tab/Enter to pick) ----
  // The composer owns the filtered lists and the active index; the menu
  // components are pure renderers, so mouse and keyboard stay in sync.
  let commandItems = $derived(commandVisible ? filterSlashCommands(commandQuery, commandAssets) : []);
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
  <div class="composer-box" class:focused>
    {#if menuLength > 0}
      <div class="menu-anchor" style="left: {caretLeft}px; top: {caretTop}px;">
        <AiCommandMenu items={commandItems} activeIndex={activeMenuIndex} onPick={onPickCommand} />
        <AiMentionMenu items={mentionItems} activeIndex={activeMenuIndex} onPick={onPickMention} />
      </div>
    {/if}
    <textarea
      bind:this={textareaEl}
      data-testid={inputTestId}
      rows="2"
      {placeholder}
      value={value}
      oninput={(e) => onInput(e.currentTarget.value)}
      onkeydown={keydown}
      onfocus={() => (focused = true)}
      onblur={() => (focused = false)}
    ></textarea>
  </div>
  <div class="composer-footer">
    {#if footer}
      <div class="footer-start">{@render footer()}</div>
    {/if}
    <div class="footer-end">
      {#if actions}
        {@render actions()}
      {/if}
      {#if busy}
        <button
          class="send-btn stop"
          data-testid={stopTestId}
          type="button"
          aria-label="Stop"
          title="Stop"
          onclick={() => onStop?.()}
        ><Square size={11} fill="currentColor" strokeWidth={0} /></button>
      {:else}
        <button
          class="send-btn"
          data-testid={sendTestId}
          type="button"
          aria-label={sendLabel}
          title="{sendLabel} (⌘/Ctrl+Enter)"
          onclick={onSend}
          disabled={!canSend}
        ><ArrowUp size={15} strokeWidth={2.25} /></button>
      {/if}
    </div>
  </div>
  {#if hint}
    <div class="composer-hint">{hint}</div>
  {/if}
</div>

<style>
  .ai-composer {
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--novelist-bg);
  }
  /* One rounded surface holding the textarea and its toolbar, the way
     chat-first writing tools (OpenFic, Cursor) frame the prompt box. */
  .composer-box {
    position: relative;
    display: flex;
    flex-direction: column;
    border: 1px solid color-mix(in srgb, var(--novelist-text) 16%, var(--novelist-border));
    border-radius: 10px;
    background: var(--novelist-bg);
    /* Soft upward fade so the box floats over the scrolling transcript. */
    box-shadow:
      0 -10px 18px color-mix(in srgb, var(--novelist-bg) 72%, transparent),
      0 -1px 0 color-mix(in srgb, var(--novelist-text) 4%, transparent);
    transition: border-color 200ms ease, box-shadow 200ms ease;
  }
  .composer-box.focused {
    border-color: color-mix(in srgb, var(--novelist-text) 42%, var(--novelist-border));
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
    min-height: 52px;
    max-height: 240px;
    background: transparent;
    border: 0;
    outline: none;
    color: var(--novelist-text);
    padding: 10px;
    font: inherit;
    font-size: 13.5px;
    line-height: 1.5;
    resize: none;
  }
  textarea::placeholder {
    color: var(--novelist-text-tertiary);
  }
  .composer-footer {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 2px;
    min-width: 0;
  }
  .footer-start {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
  }
  .footer-end {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    flex: 0 0 auto;
  }
  .send-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: var(--novelist-text);
    color: var(--novelist-bg);
    cursor: pointer;
    transition: background 100ms, opacity 150ms, transform 100ms;
  }
  .send-btn:not(:disabled):hover {
    background: color-mix(in srgb, var(--novelist-text) 82%, var(--novelist-bg));
  }
  .send-btn:not(:disabled):active {
    transform: scale(0.94);
  }
  .send-btn:disabled {
    opacity: 0.25;
    cursor: not-allowed;
  }
  .composer-hint {
    padding: 0 4px;
    font-size: 10.5px;
    color: var(--novelist-text-tertiary);
    text-align: center;
    user-select: none;
  }
  .selection-suggestion {
    display: flex;
    align-items: center;
    border: 1px dashed color-mix(in srgb, var(--novelist-accent) 45%, var(--novelist-border));
    border-radius: 8px;
    background: color-mix(in srgb, var(--novelist-accent) 6%, var(--novelist-bg));
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
    padding: 5px 8px;
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
    padding: 5px 8px;
    cursor: pointer;
  }
</style>
