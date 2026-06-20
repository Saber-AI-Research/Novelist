<script lang="ts">
  import { onMount } from 'svelte';
  import { aiAgentSettings, type AgentProvider } from './settings.svelte';
  import { detectClaudeCli, detectCodexCli, type DetectedCli } from './host';
  import { t } from '$lib/i18n';
  import SettingsSwitch from '$lib/components/SettingsSwitch.svelte';

  let { compact = false }: { compact?: boolean } = $props();

  let claudeDetected = $state<DetectedCli | null>(null);
  let codexDetected = $state<DetectedCli | null>(null);
  let detecting = $state(true);

  let provider = $derived(aiAgentSettings.value.providerId);
  let detected = $derived(provider === 'codex' ? codexDetected : claudeDetected);

  onMount(async () => {
    try {
      [claudeDetected, codexDetected] = await Promise.all([
        detectClaudeCli().catch(() => null),
        detectCodexCli().catch(() => null),
      ]);
    } finally {
      detecting = false;
    }
  });
</script>

<div class="ai-agent-settings" class:compact>
  <label class="full">
    <span>{t('settings.aiAgent.provider')}</span>
    <select
      value={aiAgentSettings.value.providerId}
      onchange={(e) => aiAgentSettings.update({ providerId: e.currentTarget.value as AgentProvider })}
    >
      <option value="claude">{t('settings.aiAgent.providerClaude')}</option>
      <option value="codex">{t('settings.aiAgent.providerCodex')}</option>
    </select>
  </label>

  <div class="status">
    {#if detecting}
      <span class="dot pending"></span>
      <span>{t('settings.aiAgent.detecting')}
        <code>{provider === 'codex' ? t('settings.aiAgent.codexLabel') : t('settings.aiAgent.cliLabel')}</code> CLI…</span>
    {:else if detected}
      <span class="dot ok"></span>
      <span>{t('settings.aiAgent.cliFound')} <code>{detected.path}</code>{detected.version ? ` (${detected.version})` : ''}</span>
    {:else if provider === 'codex'}
      <span class="dot bad"></span>
      <span>
        {t('settings.aiAgent.codexNotFoundLead')} <code>$PATH</code>{t('settings.aiAgent.codexNotFoundTail')}
        <code>codex login</code>{t('settings.aiAgent.codexNotFoundEnd')}
      </span>
    {:else}
      <span class="dot bad"></span>
      <span>
        {t('settings.aiAgent.cliNotFoundLead')} <code>$PATH</code>{t('settings.aiAgent.cliNotFoundTail')}
        <a href="https://docs.claude.com/en/docs/claude-code/overview" target="_blank" rel="noreferrer">
          {t('settings.aiAgent.docsLink')}
        </a>
        {t('settings.aiAgent.cliNotFoundEnd')}
      </span>
    {/if}
  </div>

  {#if provider === 'codex'}
    <label>
      <span>{t('settings.aiAgent.codexCliPath')}</span>
      <input
        type="text"
        placeholder={t('settings.aiAgent.codexCliPathPlaceholder')}
        value={aiAgentSettings.value.codexCliPath}
        oninput={(e) => aiAgentSettings.update({ codexCliPath: e.currentTarget.value })}
      />
    </label>
    <label>
      <span>{t('settings.aiAgent.codexModel')}</span>
      <input
        type="text"
        placeholder={t('settings.aiAgent.codexModelPlaceholder')}
        value={aiAgentSettings.value.codexModel}
        oninput={(e) => aiAgentSettings.update({ codexModel: e.currentTarget.value })}
      />
    </label>
    <p class="hint">{t('settings.aiAgent.codexSandboxNote')}</p>
  {:else}
    <label>
      <span>{t('settings.aiAgent.cliPath')}</span>
      <input
        type="text"
        placeholder={t('settings.aiAgent.cliPathPlaceholder')}
        value={aiAgentSettings.value.cliPath}
        oninput={(e) => aiAgentSettings.update({ cliPath: e.currentTarget.value })}
      />
    </label>
    <label>
      <span>{t('settings.aiAgent.model')}</span>
      <input
        type="text"
        placeholder={t('settings.aiAgent.modelPlaceholder')}
        value={aiAgentSettings.value.model}
        oninput={(e) => aiAgentSettings.update({ model: e.currentTarget.value })}
      />
    </label>
    <label>
      <span>{t('settings.aiAgent.permissionMode')}</span>
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
        <option value="default">{t('settings.aiAgent.permission.default')}</option>
        <option value="acceptEdits">{t('settings.aiAgent.permission.acceptEdits')}</option>
        <option value="bypassPermissions">{t('settings.aiAgent.permission.bypass')}</option>
        <option value="plan">{t('settings.aiAgent.permission.plan')}</option>
      </select>
    </label>
    <label class="full">
      <span>{t('settings.aiAgent.systemPrompt')}</span>
      <textarea
        rows={compact ? 2 : 4}
        placeholder={t('settings.aiAgent.systemPromptPlaceholder')}
        value={aiAgentSettings.value.systemPrompt}
        oninput={(e) => aiAgentSettings.update({ systemPrompt: e.currentTarget.value })}
      ></textarea>
    </label>
  {/if}
  <div class="switch-row">
    <SettingsSwitch
      checked={aiAgentSettings.value.attachProjectRoot}
      onCheckedChange={(checked) => aiAgentSettings.update({ attachProjectRoot: checked })}
      ariaLabel={t('settings.aiAgent.attachProjectRootLead')}
    />
    <span class="switch-label">
      {t('settings.aiAgent.attachProjectRootLead')}
      <code>{t('settings.aiAgent.addDirFlag')}</code>
      {t('settings.aiAgent.attachProjectRootTail')}
    </span>
  </div>
  {#if provider !== 'codex'}
    <p class="hint">
      {t('settings.aiAgent.hintLead')} <code>{t('settings.aiAgent.cliLabel')}</code>
      {t('settings.aiAgent.hintMid')}
      <strong>{t('settings.aiAgent.hintBypass')}</strong>{t('settings.aiAgent.hintTail')}
    </p>
  {/if}
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
  .switch-row {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--novelist-text);
    font-size: 12px;
  }
  .switch-label {
    min-width: 0;
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
