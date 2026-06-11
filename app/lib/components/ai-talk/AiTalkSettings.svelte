<script lang="ts">
  import { aiTalkSettings } from './settings.svelte';
  import { AI_TALK_PRESETS, applyAiTalkPreset } from './presets';
  import PromptPresetManager from './PromptPresetManager.svelte';
  import { t } from '$lib/i18n';
  import SettingsSwitch from '$lib/components/SettingsSwitch.svelte';

  let { compact = false }: { compact?: boolean } = $props();

  let activeProfile = $derived(
    aiTalkSettings.value.profiles.find((p) => p.id === aiTalkSettings.value.activeProfileId),
  );
</script>

<div class="ai-talk-settings" class:compact>
  <div class="presets full">
    <span class="preset-label">{t('settings.aiTalk.providerPreset')}</span>
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
    <span>{t('settings.aiTalk.providerProfile')}</span>
    <select
      data-testid="ai-talk-profile-select"
      value={aiTalkSettings.value.activeProfileId}
      onchange={(e) => aiTalkSettings.update({ activeProfileId: e.currentTarget.value })}
    >
      {#each aiTalkSettings.value.profiles as p (p.id)}
        <option value={p.id}>{p.label}</option>
      {/each}
    </select>
  </label>
  <div class="profile-actions full">
    <button
      type="button"
      class="novelist-btn novelist-btn-ghost"
      data-testid="ai-talk-profile-save-as"
      onclick={() => aiTalkSettings.saveAsNewProfile()}
    >{t('settings.aiTalk.profileSaveAs')}</button>
    {#if activeProfile?.custom}
      <input
        type="text"
        class="profile-name"
        aria-label={t('settings.aiTalk.profileName')}
        placeholder={t('settings.aiTalk.profileName')}
        value={activeProfile.label}
        oninput={(e) => aiTalkSettings.renameProfile(activeProfile.id, e.currentTarget.value)}
      />
      <button
        type="button"
        class="novelist-btn novelist-btn-ghost"
        data-testid="ai-talk-profile-delete"
        onclick={() => aiTalkSettings.deleteProfile(activeProfile.id)}
      >{t('settings.aiTalk.profileDelete')}</button>
    {/if}
  </div>
  <label>
    <span>{t('settings.aiTalk.baseUrl')}</span>
    <input
      type="text"
      value={aiTalkSettings.value.baseUrl}
      oninput={(e) => aiTalkSettings.update({ baseUrl: e.currentTarget.value })}
    />
  </label>
  <label>
    <span>{t('settings.aiTalk.apiKey')}</span>
    <input
      type="password"
      value={aiTalkSettings.value.apiKey}
      oninput={(e) => aiTalkSettings.update({ apiKey: e.currentTarget.value })}
      placeholder="sk-…"
      autocomplete="off"
    />
  </label>
  <label>
    <span>{t('settings.aiTalk.model')}</span>
    <input
      type="text"
      value={aiTalkSettings.value.model}
      oninput={(e) => aiTalkSettings.update({ model: e.currentTarget.value })}
    />
  </label>
  <label>
    <span>{t('settings.aiTalk.temperature')}</span>
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
    <span>{t('settings.aiTalk.systemPrompt')}</span>
    <textarea
      rows={compact ? 2 : 4}
      value={aiTalkSettings.value.systemPrompt}
      oninput={(e) => aiTalkSettings.update({ systemPrompt: e.currentTarget.value })}
    ></textarea>
  </label>
  <div class="switch-row">
    <SettingsSwitch
      checked={aiTalkSettings.value.includeCurrentFile}
      label={t('settings.aiTalk.includeCurrentFile')}
      onCheckedChange={(checked) => aiTalkSettings.update({ includeCurrentFile: checked })}
    />
  </div>
  <div class="switch-row">
    <SettingsSwitch
      checked={aiTalkSettings.value.includeSelection}
      label={t('settings.aiTalk.includeSelection')}
      onCheckedChange={(checked) => aiTalkSettings.update({ includeSelection: checked })}
    />
  </div>
  <p class="hint">{t('settings.aiTalk.hint')}</p>
</div>

<div class="prompt-presets-wrap">
  <PromptPresetManager />
</div>

<style>
  .prompt-presets-wrap {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--novelist-border);
  }
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
  .switch-row {
    grid-column: 1 / -1;
  }
  .profile-actions {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .profile-actions .profile-name {
    flex: 1;
    min-width: 0;
  }
  input,
  select,
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
