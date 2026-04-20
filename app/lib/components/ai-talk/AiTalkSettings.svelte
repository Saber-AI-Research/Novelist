<script lang="ts">
  import { aiTalkSettings } from './settings.svelte';
  import { AI_TALK_PRESETS, applyAiTalkPreset } from './presets';

  let { compact = false }: { compact?: boolean } = $props();
</script>

<div class="ai-talk-settings" class:compact>
  <div class="presets full">
    <span class="preset-label">Quick preset:</span>
    {#each AI_TALK_PRESETS as p}
      <button
        type="button"
        class="preset-chip"
        data-testid="ai-talk-preset-{p.id}"
        onclick={() => applyAiTalkPreset(p.id)}
        title="{p.baseUrl} · {p.model}"
      >{p.label}</button>
    {/each}
  </div>
  <label>
    <span>Base URL</span>
    <input
      type="text"
      value={aiTalkSettings.value.baseUrl}
      oninput={(e) => aiTalkSettings.update({ baseUrl: e.currentTarget.value })}
    />
  </label>
  <label>
    <span>API Key</span>
    <input
      type="password"
      value={aiTalkSettings.value.apiKey}
      oninput={(e) => aiTalkSettings.update({ apiKey: e.currentTarget.value })}
      placeholder="sk-…"
      autocomplete="off"
    />
  </label>
  <label>
    <span>Model</span>
    <input
      type="text"
      value={aiTalkSettings.value.model}
      oninput={(e) => aiTalkSettings.update({ model: e.currentTarget.value })}
    />
  </label>
  <label>
    <span>Temperature</span>
    <input
      type="number"
      step="0.1"
      min="0"
      max="2"
      value={aiTalkSettings.value.temperature}
      oninput={(e) => aiTalkSettings.update({ temperature: Number(e.currentTarget.value) })}
    />
  </label>
  <label class="full">
    <span>System prompt</span>
    <textarea
      rows={compact ? 2 : 4}
      value={aiTalkSettings.value.systemPrompt}
      oninput={(e) => aiTalkSettings.update({ systemPrompt: e.currentTarget.value })}
    ></textarea>
  </label>
  <label class="check">
    <input
      type="checkbox"
      checked={aiTalkSettings.value.includeCurrentFile}
      onchange={(e) => aiTalkSettings.update({ includeCurrentFile: e.currentTarget.checked })}
    />
    <span>Include current file in chat context</span>
  </label>
  <label class="check">
    <input
      type="checkbox"
      checked={aiTalkSettings.value.includeSelection}
      onchange={(e) => aiTalkSettings.update({ includeSelection: e.currentTarget.checked })}
    />
    <span>Include current selection in chat context</span>
  </label>
  <p class="hint">
    API key is stored locally on this device. Requests go through the Novelist
    Rust backend (URL allowlist enforced).
  </p>
</div>

<style>
  .ai-talk-settings {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .ai-talk-settings.compact {
    gap: 6px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    color: var(--novelist-text-secondary);
  }
  label.full {
    grid-column: 1 / -1;
  }
  label.check {
    grid-column: 1 / -1;
    flex-direction: row;
    align-items: center;
    gap: 6px;
    color: var(--novelist-text);
    font-size: 12px;
  }
  input,
  textarea {
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    color: var(--novelist-text);
    padding: 4px 6px;
    border-radius: 3px;
    font: inherit;
    font-size: 12px;
  }
  textarea {
    resize: vertical;
  }
  .hint {
    grid-column: 1 / -1;
    margin: 0;
    font-size: 11px;
    color: var(--novelist-text-secondary);
  }
  .presets {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px;
  }
  .preset-label {
    font-size: 11px;
    color: var(--novelist-text-secondary);
    margin-right: 4px;
  }
  .preset-chip {
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    color: var(--novelist-text-secondary);
    padding: 2px 8px;
    border-radius: 10px;
    cursor: pointer;
    font-size: 11px;
    transition: background 80ms, color 80ms;
  }
  .preset-chip:hover {
    background: color-mix(in srgb, var(--novelist-accent) 15%, var(--novelist-bg));
    color: var(--novelist-accent);
    border-color: color-mix(in srgb, var(--novelist-accent) 50%, transparent);
  }
</style>
