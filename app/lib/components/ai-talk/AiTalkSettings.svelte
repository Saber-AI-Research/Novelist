<script lang="ts">
  import { aiTalkSettings, PROVIDER_TEMPLATES } from './settings.svelte';
  import PromptPresetManager from './PromptPresetManager.svelte';
  import { t } from '$lib/i18n';
  import SettingsSwitch from '$lib/components/SettingsSwitch.svelte';

  let { compact = false }: { compact?: boolean } = $props();

  let showAdd = $state(false);
  let pendingDelete = $state<string | null>(null);
  let showKey = $state(false);

  function addProfile(templateId?: string) {
    aiTalkSettings.addProfile(templateId);
    showAdd = false;
    pendingDelete = null;
    showKey = false;
  }

  function selectProfile(id: string) {
    aiTalkSettings.update({ activeProfileId: id });
    pendingDelete = null;
    showKey = false;
    showAdd = false;
  }

  function duplicateProfile() {
    aiTalkSettings.saveAsNewProfile();
    pendingDelete = null;
    showKey = false;
    showAdd = false;
  }

  let activeProfile = $derived(
    aiTalkSettings.value.profiles.find((p) => p.id === aiTalkSettings.value.activeProfileId),
  );
</script>

<div class="ai-talk-settings" class:compact data-testid="ai-talk-settings">
  <div class="profiles full">
    <h4 class="section-label">{t('settings.aiTalk.providerProfile')}</h4>
    {#each aiTalkSettings.value.profiles as p (p.id)}
      <button
        type="button"
        class="provider-chip"
        class:active={p.id === aiTalkSettings.value.activeProfileId}
        aria-pressed={p.id === aiTalkSettings.value.activeProfileId}
        data-testid="ai-talk-profile-{p.id}"
        onclick={() => selectProfile(p.id)}
        title="{p.baseUrl} · {p.model}"
      >{p.label}</button>
    {/each}
    <button type="button" class="provider-chip add" data-testid="ai-talk-profile-add"
      aria-expanded={showAdd} onclick={() => showAdd = !showAdd}
    >{t('settings.aiTalk.profileAdd')}</button>
  </div>
  {#if showAdd}
    <div class="add-options full" data-testid="ai-talk-profile-templates">
      {#each PROVIDER_TEMPLATES as template}
        <button type="button" class="novelist-btn novelist-btn-ghost"
          data-testid="ai-talk-template-{template.id}" onclick={() => addProfile(template.id)}
        >{template.label}</button>
      {/each}
      <button type="button" class="novelist-btn novelist-btn-ghost"
        data-testid="ai-talk-template-custom" onclick={() => addProfile()}
      >{t('settings.aiTalk.profileCustom')}</button>
    </div>
  {/if}
  {#if activeProfile}
    <div class="profile-actions full">
      <input type="text" class="profile-name" data-testid="ai-talk-profile-name"
        aria-label={t('settings.aiTalk.profileName')} placeholder={t('settings.aiTalk.profileName')}
        value={activeProfile.label}
        onchange={(e) => aiTalkSettings.renameProfile(activeProfile.id, e.currentTarget.value)}
      />
      <button type="button" class="novelist-btn novelist-btn-ghost"
        data-testid="ai-talk-profile-duplicate" onclick={duplicateProfile}
      >{t('settings.aiTalk.profileDuplicate')}</button>
      <button type="button" class="novelist-btn novelist-btn-ghost danger"
        data-testid="ai-talk-profile-delete" onclick={() => pendingDelete = activeProfile.id}
      >{t('settings.aiTalk.profileDelete')}</button>
    </div>
    {#if pendingDelete === activeProfile.id}
      <div class="delete-confirm full" role="group" aria-label={t('settings.aiTalk.profileDelete')}>
        <p>{t('settings.aiTalk.profileDeleteConfirm', { name: activeProfile.label })}</p>
        <button type="button" class="novelist-btn danger" data-testid="ai-talk-profile-delete-confirm"
          onclick={() => { aiTalkSettings.deleteProfile(activeProfile.id); pendingDelete = null; showKey = false; }}
        >{t('settings.aiTalk.profileDelete')}</button>
        <button type="button" class="novelist-btn novelist-btn-ghost" onclick={() => pendingDelete = null}
        >{t('aiTalk.cancel')}</button>
      </div>
    {/if}
  <label>
    <span>{t('settings.aiTalk.baseUrl')}</span>
    <input
      type="url"
      data-testid="ai-talk-base-url"
      spellcheck="false"
      value={aiTalkSettings.value.baseUrl}
      oninput={(e) => aiTalkSettings.update({ baseUrl: e.currentTarget.value })}
    />
  </label>
  <label>
    <span>{t('settings.aiTalk.apiKey')}</span>
    <div class="key-field">
    <input
      type={showKey ? 'text' : 'password'}
      data-testid="ai-talk-api-key"
      value={aiTalkSettings.value.apiKey}
      oninput={(e) => aiTalkSettings.update({ apiKey: e.currentTarget.value })}
      placeholder="sk-…"
      autocomplete="off"
      spellcheck="false"
    />
    <button type="button" class="novelist-btn novelist-btn-ghost" aria-pressed={showKey}
      data-testid="ai-talk-key-visibility"
      onclick={() => showKey = !showKey}
    >{t(showKey ? 'settings.aiTalk.keyHide' : 'settings.aiTalk.keyShow')}</button>
    </div>
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
  {:else}
    <p class="hint" data-testid="ai-talk-no-profiles">{t('settings.aiTalk.noProfiles')}</p>
  {/if}
  <h4 class="section-label conversation-heading full">{t('settings.aiTalk.conversationSettings')}</h4>
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
    grid-template-columns: repeat(2, minmax(0, 1fr));
    min-width: 0;
    container-type: inline-size;
    gap: 12px;
  }
  .ai-talk-settings.compact {
    gap: 6px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: var(--novelist-text-secondary);
  }
  .full {
    grid-column: 1 / -1;
  }
  .switch-row {
    grid-column: 1 / -1;
  }
  .add-options, .delete-confirm {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--novelist-border);
    border-radius: 6px;
  }
  .delete-confirm p { flex: 1 0 100%; margin: 0; font-size: 12px; overflow-wrap: anywhere; }
  .danger { color: var(--novelist-error, #c43c3c); }
  button:focus-visible, input:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--novelist-accent);
    outline-offset: 2px;
  }
  .key-field { display: flex; gap: 4px; min-width: 0; }
  .key-field input { flex: 1; width: 0; }
  .profile-actions {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .profile-actions .profile-name {
    flex: 1 1 160px;
    min-width: 0;
  }
  input,
  textarea {
    min-width: 0;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    color: var(--novelist-text);
    padding: 8px 10px;
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
  }
  textarea {
    resize: vertical;
  }
  /* iOS zooms the page when focusing a field under 16px. */
  :global(html[data-mobile='true']) input,
  :global(html[data-mobile='true']) textarea {
    font-size: 16px;
  }
  .hint {
    grid-column: 1 / -1;
    margin: 0;
    font-size: 11px;
    color: var(--novelist-text-secondary);
    line-height: 1.6;
  }
  .profiles {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .section-label {
    flex: 1 0 100%;
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--novelist-text-secondary);
  }
  .conversation-heading {
    border-top: 1px solid var(--novelist-border);
    padding-top: 14px;
    margin-top: 4px;
  }
  .provider-chip {
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    color: var(--novelist-text-secondary);
    min-height: 32px;
    max-width: 100%;
    overflow-wrap: anywhere;
    padding: 4px 10px;
    border-radius: 10px;
    cursor: pointer;
    font-size: 12px;
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
  @container (max-width: 420px) {
    label { grid-column: 1 / -1; }
  }
  :global(html[data-mobile='true']) button { min-height: 44px; }
  :global(html[data-mobile='true']) input { min-height: 44px; }

</style>
