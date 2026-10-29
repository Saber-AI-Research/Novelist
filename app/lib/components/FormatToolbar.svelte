<script lang="ts">
  import type { Component } from 'svelte';
  import type { EditorView } from '@codemirror/view';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import Redo2 from '@lucide/svelte/icons/redo-2';
  import Bold from '@lucide/svelte/icons/bold';
  import Italic from '@lucide/svelte/icons/italic';
  import Heading from '@lucide/svelte/icons/heading';
  import Quote from '@lucide/svelte/icons/quote';
  import List from '@lucide/svelte/icons/list';
  import ListOrdered from '@lucide/svelte/icons/list-ordered';
  import ListTodo from '@lucide/svelte/icons/list-todo';
  import Strikethrough from '@lucide/svelte/icons/strikethrough';
  import Code from '@lucide/svelte/icons/code';
  import Link from '@lucide/svelte/icons/link';
  import KeyboardOff from '@lucide/svelte/icons/keyboard-off';
  import { commandRegistry } from '$lib/stores/commands.svelte';
  import { platform } from '$lib/stores/platform.svelte';
  import { t } from '$lib/i18n';

  /**
   * Touch format bar. Every action is a registered command id, so the bar,
   * the command palette and external-keyboard shortcuts run one handler.
   *
   * Buttons cancel `pointerdown`/`mousedown` so the editor keeps focus and
   * its caret/selection (and the on-screen keyboard stays up). Touch
   * scrolling of the bar is unaffected because scrolling is governed by
   * `touch-action`, not by the pointerdown default.
   */
  interface Props {
    getView: () => EditorView | null;
    /** Editor currently focused (keyboard likely visible on phones). */
    editorFocused: boolean;
  }
  let { getView, editorFocused }: Props = $props();

  type Item = { id: string; labelKey: string; icon?: Component<{ size?: number }>; text?: string };
  const ITEMS: Item[] = [
    { id: 'editor-undo', labelKey: 'command.undo', icon: Undo2 },
    { id: 'editor-redo', labelKey: 'command.redo', icon: Redo2 },
    { id: 'editor-heading', labelKey: 'command.toggleHeading', icon: Heading },
    { id: 'editor-bold', labelKey: 'command.bold', icon: Bold },
    { id: 'editor-italic', labelKey: 'command.italic', icon: Italic },
    { id: 'editor-block-quote', labelKey: 'command.blockQuote', icon: Quote },
    { id: 'editor-block-unordered-list', labelKey: 'command.blockUnorderedList', icon: List },
    { id: 'editor-block-ordered-list', labelKey: 'command.blockOrderedList', icon: ListOrdered },
    { id: 'editor-block-task-list', labelKey: 'command.blockTaskList', icon: ListTodo },
    { id: 'editor-cjk-quotes', labelKey: 'command.cjkQuotes', text: '「」' },
    { id: 'editor-strikethrough', labelKey: 'command.strikethrough', icon: Strikethrough },
    { id: 'editor-code-inline', labelKey: 'command.inlineCode', icon: Code },
    { id: 'editor-link', labelKey: 'command.insertLink', icon: Link },
  ];

  function keepEditorFocus(event: Event) {
    event.preventDefault();
  }

  function run(id: string) {
    const view = getView();
    const hadFocus = !!view?.hasFocus;
    commandRegistry.execute(id);
    // Some WebViews still move focus on tap; give it back so typing (and
    // dictation) continues at the same caret.
    if (view && hadFocus && !view.hasFocus) view.focus();
  }

  /** ARIA toolbar keyboard model: arrows/Home/End move between buttons. */
  function moveToolbarFocus(event: KeyboardEvent) {
    const toolbar = event.currentTarget as HTMLElement;
    const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>('button')];
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === 'ArrowRight') next = current < 0 ? 0 : (current + 1) % buttons.length;
    else if (event.key === 'ArrowLeft') next = current <= 0 ? buttons.length - 1 : current - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next].focus();
  }
</script>

<div
  class="format-toolbar"
  role="toolbar"
  tabindex="-1"
  aria-label={t('mobile.formatToolbar')}
  aria-orientation="horizontal"
  data-testid="format-toolbar"
  onpointerdown={keepEditorFocus}
  onmousedown={keepEditorFocus}
  onkeydown={moveToolbarFocus}
>
  <div class="format-toolbar-scroll">
    {#each ITEMS as item (item.id)}
      <button
        type="button"
        class="format-btn"
        data-testid="format-{item.id}"
        aria-label={t(item.labelKey)}
        title={t(item.labelKey)}
        onclick={() => run(item.id)}
      >
        {#if item.icon}
          <item.icon size={18} />
        {:else}
          <span class="format-btn-text" aria-hidden="true">{item.text}</span>
        {/if}
      </button>
    {/each}
  </div>
  {#if platform.isMobile && editorFocused}
    <button
      type="button"
      class="format-btn format-btn-dismiss"
      data-testid="format-hide-keyboard"
      aria-label={t('mobile.hideKeyboard')}
      title={t('mobile.hideKeyboard')}
      onclick={() => getView()?.contentDOM.blur()}
    >
      <KeyboardOff size={18} />
    </button>
  {/if}
</div>

<style>
  .format-toolbar {
    flex-shrink: 0;
    display: flex;
    align-items: stretch;
    min-height: 44px;
    padding: 0 env(safe-area-inset-right, 0px) 0 env(safe-area-inset-left, 0px);
    background: var(--novelist-bg-secondary);
    border-top: 1px solid var(--novelist-border-subtle, var(--novelist-border));
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .format-toolbar-scroll {
    flex: 1;
    min-width: 0;
    display: flex;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
    touch-action: pan-x;
  }
  .format-toolbar-scroll::-webkit-scrollbar {
    display: none;
  }
  .format-btn {
    flex: 0 0 44px;
    width: 44px;
    height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .format-btn:active {
    background: var(--novelist-sidebar-hover);
    color: var(--novelist-accent);
  }
  .format-btn:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--novelist-accent) 45%, transparent);
    outline-offset: -2px;
  }
  .format-btn-text {
    font-size: 15px;
    letter-spacing: -0.05em;
  }
  .format-btn-dismiss {
    border-left: 1px solid var(--novelist-border-subtle, var(--novelist-border));
  }
</style>
