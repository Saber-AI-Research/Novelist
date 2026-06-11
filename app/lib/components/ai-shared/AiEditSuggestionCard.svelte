<script lang="ts">
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
</script>

<section class="suggestion" class:resolved={Boolean(status)} data-testid="ai-edit-suggestion">
  {#if suggestion.note || suggestion.file}
    <div class="meta">
      {#if suggestion.file}<span class="file">{suggestion.file}</span>{/if}
      {#if suggestion.note}<span class="note">{suggestion.note}</span>{/if}
    </div>
  {/if}
  <div class="diff">
    {#each parts as part}
      <span class={part.kind}>{part.text}</span>
    {/each}
  </div>
  <div class="actions">
    {#if status === 'accepted'}
      <span class="status ok" data-testid="ai-edit-suggestion-status">✓ Applied</span>
    {:else if status === 'rejected'}
      <span class="status" data-testid="ai-edit-suggestion-status">Rejected</span>
    {:else if status === 'conflict'}
      <span class="status bad" data-testid="ai-edit-suggestion-status">Original text not found — document changed?</span>
    {:else}
      <button
        class="novelist-btn novelist-btn-primary"
        type="button"
        data-testid="ai-edit-suggestion-accept"
        {disabled}
        onclick={onAccept}
      >Accept</button>
      <button
        class="novelist-btn novelist-btn-ghost"
        type="button"
        data-testid="ai-edit-suggestion-reject"
        {disabled}
        onclick={onReject}
      >Reject</button>
    {/if}
  </div>
</section>

<style>
  .suggestion {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border: 1px solid color-mix(in srgb, var(--novelist-accent) 40%, var(--novelist-border));
    border-radius: 6px;
    background: color-mix(in srgb, var(--novelist-accent) 6%, var(--novelist-bg));
  }
  .suggestion.resolved {
    border-color: var(--novelist-border);
    background: var(--novelist-bg-secondary);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 11px;
    color: var(--novelist-text-secondary);
  }
  .file {
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    padding: 0 4px;
    background: var(--novelist-bg);
  }
  .diff {
    padding: 6px 8px;
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    background: var(--novelist-bg);
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: 1.6;
    font-size: 13px;
    max-height: 160px;
    overflow: auto;
  }
  .diff .same { color: var(--novelist-text); }
  .diff .added {
    color: #166534;
    background: rgba(34, 197, 94, 0.18);
  }
  .diff .removed {
    color: #991b1b;
    background: rgba(239, 68, 68, 0.16);
    text-decoration: line-through;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .status {
    font-size: 11px;
    color: var(--novelist-text-secondary);
  }
  .status.ok { color: #16a34a; }
  .status.bad { color: #dc2626; }
</style>
