<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import X from '@lucide/svelte/icons/x';
  import FilePen from '@lucide/svelte/icons/file-pen-line';
  import { buildWordDiff } from './diff';
  import type { EditSuggestion, SuggestionStatus } from './edit-suggestions';

  type Props = {
    suggestion: EditSuggestion;
    status?: SuggestionStatus;
    disabled?: boolean;
    onAccept: () => void;
    onReject: () => void;
  };

  let { suggestion, status, disabled = false, onAccept, onReject }: Props = $props();
  let parts = $derived(buildWordDiff(suggestion.search, suggestion.replace));
  // Character counts (not UTF-16 units) so CJK edits read naturally: +12 −8.
  let addedCount = $derived(parts.filter((p) => p.kind === 'added').reduce((n, p) => n + [...p.text.trim()].length, 0));
  let removedCount = $derived(parts.filter((p) => p.kind === 'removed').reduce((n, p) => n + [...p.text.trim()].length, 0));
</script>

<section class="suggestion" class:resolved={Boolean(status)} data-status={status ?? 'pending'} data-testid="ai-edit-suggestion">
  <header>
    <FilePen size={13} class="file-icon" />
    {#if suggestion.file}<span class="title">{suggestion.file}</span>{/if}
    <span class="stat added-stat">+{addedCount}</span>
    <span class="stat removed-stat">−{removedCount}</span>
    <span class="spacer"></span>
    {#if status === 'accepted'}
      <span class="status ok" data-testid="ai-edit-suggestion-status">✓ Applied</span>
    {:else if status === 'rejected'}
      <span class="status" data-testid="ai-edit-suggestion-status">Rejected</span>
    {:else if status === 'conflict'}
      <span class="status bad" data-testid="ai-edit-suggestion-status" title="Original text not found — document changed?">Original text not found — document changed?</span>
    {:else}
      <button
        class="act reject"
        type="button"
        data-testid="ai-edit-suggestion-reject"
        aria-label="Reject"
        title="Reject"
        {disabled}
        onclick={onReject}
      ><X size={13} /><span>Reject</span></button>
      <button
        class="act accept"
        type="button"
        data-testid="ai-edit-suggestion-accept"
        aria-label="Accept"
        title="Accept"
        {disabled}
        onclick={onAccept}
      ><Check size={13} /><span>Accept</span></button>
    {/if}
  </header>
  {#if suggestion.note}
    <div class="note">{suggestion.note}</div>
  {/if}
  <div class="diff">
    {#each parts as part}
      <span class={part.kind}>{part.text}</span>
    {/each}
  </div>
</section>

<style>
  .suggestion {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--novelist-border);
    border-radius: 12px;
    background: var(--novelist-bg);
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  }
  .suggestion.resolved {
    opacity: 0.72;
  }
  header {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 6px 0 10px;
    background: var(--novelist-bg-secondary);
    border-bottom: 1px solid var(--novelist-border-subtle, var(--novelist-border));
    font-size: 11.5px;
  }
  header :global(.file-icon) {
    flex: 0 0 auto;
    color: var(--novelist-text-secondary);
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--novelist-text);
  }
  .stat {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
  }
  .added-stat { color: #2da44e; }
  .removed-stat { color: #e5534b; }
  .spacer { flex: 1; }
  .note {
    padding: 6px 10px 0;
    font-size: 11.5px;
    color: var(--novelist-text-secondary);
  }
  .diff {
    padding: 8px 10px 10px;
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.75;
    font-family: var(--novelist-editor-font);
    font-size: 13px;
    max-height: 220px;
    overflow: auto;
  }
  .diff .same { color: var(--novelist-text); }
  .diff .added {
    color: color-mix(in srgb, #2da44e 55%, var(--novelist-text));
    background: rgba(46, 160, 67, 0.16);
    border-radius: 2px;
  }
  .diff .removed {
    color: color-mix(in srgb, #cf222e 60%, var(--novelist-text));
    background: rgba(248, 81, 73, 0.14);
    text-decoration: line-through;
    text-decoration-color: rgba(164, 14, 38, 0.45);
    border-radius: 2px;
  }
  .act {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 22px;
    padding: 0 7px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--novelist-text-secondary);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    transition: background 80ms, color 80ms, border-color 80ms;
  }
  .act:disabled { opacity: 0.5; cursor: not-allowed; }
  /* Narrow side panels: icon-only actions so the header never truncates. */
  @container (max-width: 300px) {
    .act span { display: none; }
    .act { padding: 0 5px; }
  }
  .act.reject:not(:disabled):hover {
    color: #cf222e;
    background: rgba(248, 81, 73, 0.1);
  }
  .act.accept {
    color: #fff;
    background: var(--novelist-accent);
  }
  .act.accept:not(:disabled):hover {
    background: color-mix(in srgb, var(--novelist-accent) 85%, black);
  }
  .status {
    font-size: 11px;
    color: var(--novelist-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .status.ok { color: #1a7f37; }
  .status.bad { color: #cf222e; }
</style>
