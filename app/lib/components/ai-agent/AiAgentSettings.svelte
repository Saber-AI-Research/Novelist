<script lang="ts">
  import { onMount } from 'svelte';
  import { aiAgentSettings } from './settings.svelte';
  import { detectClaudeCli, type DetectedCli } from './host';

  let { compact = false }: { compact?: boolean } = $props();

  let detected = $state<DetectedCli | null>(null);
  let detecting = $state(true);

  onMount(async () => {
    try {
      detected = await detectClaudeCli();
    } finally {
      detecting = false;
    }
  });
</script>

<div class="ai-agent-settings" class:compact>
  <div class="status">
    {#if detecting}
      <span class="dot pending"></span>
      <span>Detecting <code>claude</code> CLI…</span>
    {:else if detected}
      <span class="dot ok"></span>
      <span>Found <code>{detected.path}</code>{detected.version ? ` (${detected.version})` : ''}</span>
    {:else}
      <span class="dot bad"></span>
      <span>
        Claude Code CLI not found on <code>$PATH</code>. Install it from
        <a href="https://docs.claude.com/en/docs/claude-code/overview" target="_blank" rel="noreferrer">
          docs.claude.com
        </a>
        and reload, or set an absolute path below.
      </span>
    {/if}
  </div>

  <label>
    <span>CLI path override (optional)</span>
    <input
      type="text"
      placeholder="/usr/local/bin/claude"
      value={aiAgentSettings.value.cliPath}
      oninput={(e) => aiAgentSettings.update({ cliPath: e.currentTarget.value })}
    />
  </label>
  <label>
    <span>Model (optional)</span>
    <input
      type="text"
      placeholder="sonnet / opus / haiku / model id"
      value={aiAgentSettings.value.model}
      oninput={(e) => aiAgentSettings.update({ model: e.currentTarget.value })}
    />
  </label>
  <label>
    <span>Permission mode</span>
    <select
      value={aiAgentSettings.value.permissionMode}
      onchange={(e) =>
        aiAgentSettings.update({
          permissionMode: e.currentTarget.value as
            | 'default'
            | 'acceptEdits'
            | 'bypassPermissions'
            | 'plan',
        })}
    >
      <option value="default">default — confirm each tool</option>
      <option value="acceptEdits">acceptEdits (recommended)</option>
      <option value="bypassPermissions">bypassPermissions ⚠</option>
      <option value="plan">plan — read-only</option>
    </select>
  </label>
  <label class="full">
    <span>System prompt addition (optional)</span>
    <textarea
      rows={compact ? 2 : 4}
      placeholder="Extra system prompt appended to Claude's default."
      value={aiAgentSettings.value.systemPrompt}
      oninput={(e) => aiAgentSettings.update({ systemPrompt: e.currentTarget.value })}
    ></textarea>
  </label>
  <label class="check">
    <input
      type="checkbox"
      checked={aiAgentSettings.value.attachProjectRoot}
      onchange={(e) => aiAgentSettings.update({ attachProjectRoot: e.currentTarget.checked })}
    />
    <span>Attach current project root via <code>--add-dir</code></span>
  </label>
  <p class="hint">
    The agent runs the local <code>claude</code> binary as a subprocess and
    inherits its tool-use capabilities (file edits, bash, etc.). Treat
    <strong>bypassPermissions</strong> with care.
  </p>
</div>

<style>
  .ai-agent-settings {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .status {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--novelist-text);
  }
  .status code {
    background: var(--novelist-bg);
    padding: 1px 4px;
    border-radius: 2px;
    font-size: 11px;
  }
  .status a {
    color: var(--novelist-accent);
    text-decoration: underline;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.pending { background: #d4d4d4; animation: pulse 1.2s infinite; }
  .dot.ok { background: #16a34a; }
  .dot.bad { background: #dc2626; }
  @keyframes pulse { 50% { opacity: 0.3; } }
  label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    color: var(--novelist-text-secondary);
  }
  label.full { grid-column: 1 / -1; }
  label.check {
    grid-column: 1 / -1;
    flex-direction: row;
    align-items: center;
    gap: 6px;
    color: var(--novelist-text);
    font-size: 12px;
  }
  input,
  textarea,
  select {
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    color: var(--novelist-text);
    padding: 4px 6px;
    border-radius: 3px;
    font: inherit;
    font-size: 12px;
  }
  textarea { resize: vertical; }
  .hint {
    grid-column: 1 / -1;
    margin: 0;
    font-size: 11px;
    color: var(--novelist-text-secondary);
  }
  .hint code {
    background: var(--novelist-bg);
    padding: 1px 4px;
    border-radius: 2px;
  }
</style>
