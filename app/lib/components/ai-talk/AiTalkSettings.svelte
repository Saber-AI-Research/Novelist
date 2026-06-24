<script lang="ts">
  import { aiTalkSettings } from './settings.svelte';
  import PromptPresetManager from './PromptPresetManager.svelte';
  import { t } from '$lib/i18n';
  import SettingsSwitch from '$lib/components/SettingsSwitch.svelte';

  let { compact = false }: { compact?: boolean } = $props();

  let activeProfile = $derived(
    aiTalkSettings.value.profiles.find((p) => p.id === aiTalkSettings.value.activeProfileId),
  );
</script>

<div class="ai-talk-settings" class:compact>
  <!-- One unified list: built-in providers and user-added custom configs sit
       side by side; the active one is highlighted, and "+ Add" snapshots the
       current connection fields into a new custom profile. -->
  <div class="profiles full">
    <span class="preset-label">{t('settings.aiTalk.providerProfile')}</span>
    {#each aiTalkSettings.value.profiles as p (p.id)}
      <button
        type="button"
        class="provider-chip"
        class:active={p.id === aiTalkSettings.value.activeProfileId}
        data-testid="ai-talk-profile-{p.id}"
        onclick={() => aiTalkSettings.update({ activeProfileId: p.id })}
        title="{p.baseUrl} · {p.model}"
      >{p.label}{#if p.custom}<span class="chip-tag">★</span>{/if}</button>
    {/each}
    <button
      type="button"
      class="provider-chip add"
      data-testid="ai-talk-profile-add"
      onclick={() => aiTalkSettings.saveAsNewProfile()}
    >{t('settings.aiTalk.profileAdd')}</button>
  </div>
  {#if activeProfile?.custom}
    <div class="profile-actions full">
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
    </div>
  {/if}
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
  .profiles {
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
  .provider-chip {
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    color: var(--novelist-text-secondary);
    padding: 2px 8px;
    border-radius: 10px;
    cursor: pointer;
    font-size: 11px;
    transition: background 80ms, color 80ms, border-color 80ms;
  }
  .provider-chip:hover {
    background: color-mix(in srgb, var(--novelist-accent) 15%, var(--novelist-bg));
    color: var(--novelist-accent);
    border-color: color-mix(in srgb, var(--novelist-accent) 50%, transparent);
  }
  .provider-chip.active {
    background: var(--novelist-accent);
    color: var(--novelist-accent-contrast, #fff);
    border-color: var(--novelist-accent);
  }
  .provider-chip.add {
    border-style: dashed;
  }
  .chip-tag {
    margin-left: 4px;
    opacity: 0.7;
    font-size: 9px;
  }
</style>
