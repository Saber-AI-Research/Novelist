<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { accountSync, type AccountView, type Category, type Device, type Preview } from '$lib/services/account-sync';

  type Choice = 'local' | 'cloud';

  const categories: Category[] = ['preferences', 'shortcuts', 'ai', 'webdav'];
  const errorCodes = new Set(['revision_conflict', 'session_expired', 'account_credentials_invalid', 'decryption_failed', 'invalid_recovery_key', 'invalid_envelope', 'unsupported_schema', 'configuration_too_large', 'configuration_changed', 'conflicts_unresolved', 'preview_required', 'scope_required', 'unlock_required', 'sync_not_configured', 'already_signed_in', 'signed_out', 'account_operation_busy']);
  let view = $state.raw<AccountView>({ ...accountSync.view });
  let endpoint = $state('');
  let username = $state('');
  let password = $state('');
  let deviceName = $state('');
  let registering = $state(false);
  let selected = $state<Category[]>([]);
  let includeSecrets = $state(false);
  let existingKey = $state('');
  let generatedKey = $state('');
  let keySaved = $state(false);
  let actionBusy = $state(false);
  let localError = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let scopeDirty = $state(false);
  let committed = $state(false);
  let choices = $state<Record<string, Choice>>({});
  let devices = $state<Device[]>([]);
  let devicesLoaded = $state(false);
  let revokeTarget = $state<Device | null>(null);
  let confirmingLogout = $state(false);
  let keepConnections = $state(true);
  let confirmingDelete = $state(false);
  let deletePassword = $state('');
  let deleteAcknowledged = $state(false);
  let confirmingRestore = $state(false);
  let lastPreview = accountSync.view.preview;
  let lastAccountId = accountSync.view.account?.device_id;
  let destroyed = false;

  const busy = $derived(actionBusy || view.busy);
  const freshPreview = $derived(view.preview !== null && !scopeDirty);
  const conflictsResolved = $derived(view.preview?.conflicts.every((key) => choices[key] === 'local' || choices[key] === 'cloud') ?? false);
  const error = $derived(localError || view.error ? t(`account.error.${errorCodes.has(localError ?? view.error ?? '') ? localError ?? view.error : 'account_operation_failed'}`) : null);

  function clearSecrets() {
    password = '';
    existingKey = '';
    generatedKey = '';
    keySaved = false;
    deletePassword = '';
  }

  onMount(() => accountSync.subscribe(() => {
    if (destroyed) return;
    const next = accountSync.view;
    if (next.preview !== lastPreview) {
      lastPreview = next.preview;
      choices = {};
      scopeDirty = false;
    }
    if (next.account?.device_id !== lastAccountId) {
      lastAccountId = next.account?.device_id;
      selected = [];
      includeSecrets = false;
      committed = false;
      devices = [];
      devicesLoaded = false;
      revokeTarget = null;
      confirmingLogout = false;
      confirmingDelete = false;
      deleteAcknowledged = false;
      keepConnections = true;
      if (!next.account) clearSecrets();
    }
    view = { ...next };
  }));

  onDestroy(() => {
    destroyed = true;
    clearSecrets();
  });

  async function perform(action: () => Promise<void>, success?: () => void) {
    if (busy) return;
    actionBusy = true;
    localError = null;
    notice = null;
    try {
      await action();
      if (!destroyed) success?.();
    } catch {
      if (!destroyed) localError = accountSync.view.error ?? 'account_operation_failed';
    } finally {
      password = '';
      existingKey = '';
      deletePassword = '';
      actionBusy = false;
    }
  }

  function authenticate(event: SubmitEvent) {
    event.preventDefault();
    void perform(() => accountSync.login(endpoint.trim(), username.trim(), password, deviceName.trim(), registering));
  }

  function generateKey() {
    if (busy) return;
    localError = null;
    notice = null;
    keySaved = false;
    try {
      generatedKey = accountSync.generateRecoveryKey();
    } catch {
      localError = 'account_operation_failed';
    }
  }

  function unlockExisting(event: SubmitEvent) {
    event.preventDefault();
    if (generatedKey && existingKey.trim() === generatedKey && !keySaved) return;
    void perform(() => accountSync.unlock(existingKey.trim()), () => {
      generatedKey = '';
      keySaved = false;
      notice = t('account.recovery.unlocked');
    });
  }

  function unlockGenerated() {
    if (!keySaved || !generatedKey) return;
    void perform(() => accountSync.unlock(generatedKey), () => {
      generatedKey = '';
      keySaved = false;
      notice = t('account.recovery.unlocked');
    });
  }

  function changeCategory(category: Category, checked: boolean) {
    selected = checked ? [...selected, category] : selected.filter((item) => item !== category);
    scopeDirty = true;
    committed = false;
  }

  function preview() {
    if (!selected.length) return;
    void perform(() => accountSync.preview([...selected], includeSecrets), () => {
      scopeDirty = false;
      committed = false;
      choices = {};
    });
  }

  function commit(mode: 'merge' | 'local' | 'cloud') {
    if (!freshPreview || (mode === 'merge' && !conflictsResolved)) return;
    void perform(() => accountSync.commit(mode, { ...choices }), () => {
      committed = true;
      scopeDirty = false;
      notice = t('account.preview.committed');
    });
  }

  function loadDevices() {
    void perform(async () => {
      const result = await accountSync.devices();
      if (!destroyed) {
        devices = result;
        devicesLoaded = true;
      }
    });
  }

  function revokeDevice() {
    const target = revokeTarget;
    if (!target) return;
    void perform(async () => {
      await accountSync.revokeDevice(target.id);
      if (!target.current) {
        const result = await accountSync.devices();
        if (!destroyed) devices = result;
      }
    }, () => {
      revokeTarget = null;
      notice = t('account.devices.revoked');
    });
  }

  function logout() {
    void perform(() => accountSync.logout(keepConnections), () => {
      clearSecrets();
      notice = t('account.logout.done');
    });
  }

  function deleteAccount(event: SubmitEvent) {
    event.preventDefault();
    if (!deleteAcknowledged) return;
    void perform(() => accountSync.deleteAccount(deletePassword, keepConnections), () => {
      clearSecrets();
      notice = t('account.delete.done');
    });
  }

  function previewValue(row: Preview['rows'][number], side: Choice): string {
    if (!(side === 'local' ? row.localPresent : row.cloudPresent)) return t('account.preview.missing');
    if (row.sensitive) return t('account.preview.hidden');
    return (side === 'local' ? row.localValue : row.cloudValue) ?? t('account.preview.present');
  }

  function formatTime(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }
</script>

<section class="account-panel" data-testid="account-panel" aria-labelledby="novelist-account-title" aria-busy={busy}>
  <h3 id="novelist-account-title" class="text-xs font-semibold uppercase tracking-wide mb-2 hint">{t('account.title')}</h3>
  <p class="text-xs mb-3 hint">{t('account.intro')}</p>

  <div class="status-row">
    <span class="badge" data-testid="account-state">{t(`account.state.${view.state}`)}</span>
    <span class="text-xs hint" data-testid="account-enabled">{view.enabled ? t('account.sync.enabled') : t('account.sync.disabled')}</span>
    {#if busy}<span class="text-xs hint" role="status">{t('account.working')}</span>{/if}
  </div>
  {#if view.state === 'pending'}<p class="text-xs hint mt-2">{t('account.sync.pendingHint')}</p>{/if}
  {#if view.state === 'locked'}<p class="text-xs hint mt-2">{t('account.recovery.lockedHint')}</p>{/if}
  {#if error}<p class="text-xs error mt-2" role="alert" data-testid="account-error">{error}</p>{/if}
  {#if notice}<p class="text-xs mt-2" role="status" data-testid="account-notice">{notice}</p>{/if}

  {#if !view.account}
    <form class="form block" onsubmit={authenticate} data-testid="account-login-form">
      <label class="field">
        <span class="text-sm">{t('account.endpoint')}</span>
        <input type="url" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" required bind:value={endpoint} disabled={busy} data-testid="account-endpoint" />
        <span class="text-xs hint">{t('account.endpointHint')}</span>
      </label>
      <label class="field">
        <span class="text-sm">{t('account.username')}</span>
        <input type="text" autocomplete="username" autocapitalize="off" spellcheck="false" required bind:value={username} disabled={busy} data-testid="account-username" />
      </label>
      <label class="field">
        <span class="text-sm">{t('account.password')}</span>
        <input type="password" autocomplete={registering ? 'new-password' : 'current-password'} required bind:value={password} disabled={busy} data-testid="account-password" />
      </label>
      <label class="field">
        <span class="text-sm">{t('account.deviceName')}</span>
        <input type="text" autocomplete="off" required maxlength="120" bind:value={deviceName} disabled={busy} data-testid="account-device-name" />
      </label>
      <label class="check text-sm">
        <input type="checkbox" bind:checked={registering} disabled={busy} data-testid="account-register-mode" />
        <span>{t('account.registerMode')}</span>
      </label>
      <button type="submit" class="primary" disabled={busy} data-testid="account-login">{registering ? t('account.register') : t('account.login')}</button>
      <p class="text-xs hint">{t('account.loginHint')}</p>
    </form>
  {:else}
    <div class="block" data-testid="account-identity">
      <p class="text-sm font-medium break">{view.account.username}</p>
      <p class="text-xs hint break">{view.account.endpoint}</p>
      <p class="text-xs hint mt-2">{t('account.revision', { revision: view.revision })}</p>
    </div>
  {/if}

  <div class="block" data-testid="account-recovery">
    <h4 class="text-sm font-medium">{t('account.recovery.title')}</h4>
    <p class="text-xs hint mt-2">{t('account.recovery.hint')}</p>
    <form class="form mt-3" onsubmit={unlockExisting}>
      <label class="field">
        <span class="text-sm">{t('account.recovery.existing')}</span>
        <input type="password" autocomplete="off" autocapitalize="off" spellcheck="false" bind:value={existingKey} required disabled={busy || !view.account} data-testid="account-recovery-key" />
      </label>
      <button type="submit" disabled={busy || !view.account || !existingKey.trim() || (existingKey.trim() === generatedKey && !keySaved)} data-testid="account-unlock">{t('account.recovery.unlock')}</button>
    </form>
    <p class="text-xs hint mt-3">{t('account.recovery.generateHint')}</p>
    {#if generatedKey}
      <label class="field mt-2">
        <span class="text-sm">{t('account.recovery.newKey')}</span>
        <input class="key" type="text" readonly value={generatedKey} autocomplete="off" spellcheck="false" data-testid="account-generated-key" />
      </label>
      <label class="check text-xs mt-2">
        <input type="checkbox" bind:checked={keySaved} disabled={busy} data-testid="account-key-saved" />
        <span>{t('account.recovery.saved')}</span>
      </label>
      <div class="actions mt-2">
        <button type="button" disabled={busy || !view.account || !keySaved} onclick={unlockGenerated} data-testid="account-use-generated-key">{t('account.recovery.useGenerated')}</button>
        <button type="button" disabled={busy} onclick={() => { generatedKey = ''; keySaved = false; }}>{t('account.recovery.discard')}</button>
      </div>
    {:else}
      <button type="button" class="mt-2" disabled={busy} onclick={generateKey} data-testid="account-generate-key">{t('account.recovery.generate')}</button>
    {/if}
  </div>

  {#if view.account}
    <div class="block" data-testid="account-sync-scope">
      <h4 class="text-sm font-medium">{t('account.scope.title')}</h4>
      <p class="text-xs hint mt-2">{t('account.scope.hint')}</p>
      {#if view.categories.length}
        <p class="text-xs hint mt-2" data-testid="account-active-scope">{t('account.scope.active', { categories: view.categories.map((category) => t(`account.category.${category}`)).join(', '), secrets: view.includeSecrets ? t('account.scope.secretsIncluded') : t('account.scope.secretsExcluded') })}</p>
      {/if}
      {#if view.enabled}<p class="text-xs hint mt-2">{t('account.scope.disableFirst')}</p>{/if}
      <fieldset disabled={busy || view.enabled} class="scope-options">
        <legend class="text-xs hint">{t('account.scope.choose')}</legend>
        {#each categories as category}
          <label class="check text-sm">
            <input type="checkbox" checked={selected.includes(category)} onchange={(event) => changeCategory(category, event.currentTarget.checked)} data-testid={`account-category-${category}`} />
            <span>{t(`account.category.${category}`)}</span>
          </label>
        {/each}
        <label class="check text-sm">
          <input type="checkbox" bind:checked={includeSecrets} onchange={() => { scopeDirty = true; committed = false; }} data-testid="account-include-secrets" />
          <span>{t('account.scope.includeSecrets')}</span>
        </label>
      </fieldset>
      <p class="text-xs hint">{t('account.scope.secretsHint')}</p>
      <div class="actions mt-3">
        <button type="button" onclick={preview} disabled={busy || view.enabled || !selected.length} data-testid="account-preview">{t('account.preview.create')}</button>
        {#if view.enabled}
          <button type="button" onclick={() => { void perform(() => accountSync.sync()); }} disabled={busy || view.state === 'locked'} data-testid="account-sync-now">{t('account.sync.now')}</button>
          <button type="button" onclick={() => { void perform(() => accountSync.disable(), () => { committed = false; }); }} disabled={busy} data-testid="account-sync-disable">{t('account.sync.disable')}</button>
        {:else}
          <button type="button" class="primary" onclick={() => { void perform(() => accountSync.enable()); }} disabled={busy || !committed || scopeDirty || view.state === 'locked'} data-testid="account-sync-enable">{t('account.sync.enable')}</button>
        {/if}
      </div>
      <p class="text-xs hint mt-2">{t('account.sync.disableHint')}</p>
    </div>

    {#if view.preview}
      <div class="block" data-testid="account-diff-preview">
        <h4 class="text-sm font-medium">{t('account.preview.title')}</h4>
        <p class="text-xs hint mt-2">{t('account.preview.hint')}</p>
        {#if scopeDirty}<p class="text-xs error mt-2">{t('account.preview.stale')}</p>{/if}
        {#if view.preview.rows.length === 0}
          <p class="text-xs hint mt-2">{t('account.preview.empty')}</p>
        {:else}
          <ul class="list mt-2">
            {#each view.preview.rows as row (row.key)}
              <li class="difference" data-testid="account-diff-row">
                <div class="break">
                  <span class="text-sm">{row.label}</span>
                  <span class="badge">{t(`account.preview.kind.${row.kind}`)}</span>
                  <p class="text-xs hint">{t('account.preview.presence', { local: row.localPresent ? t('account.preview.present') : t('account.preview.absent'), cloud: row.cloudPresent ? t('account.preview.present') : t('account.preview.absent') })}</p>
                  <dl class="value-comparison text-xs mt-2">
                    <div><dt class="hint">{t('account.preview.localLabel')}</dt><dd>{previewValue(row, 'local')}</dd></div>
                    <div><dt class="hint">{t('account.preview.cloudLabel')}</dt><dd>{previewValue(row, 'cloud')}</dd></div>
                  </dl>
                </div>
                {#if view.preview.conflicts.includes(row.key)}
                  <label class="field choice text-xs">
                    <span>{t('account.preview.resolve')}</span>
                    <select value={choices[row.key] ?? ''} disabled={busy || !freshPreview} onchange={(event) => { const value = event.currentTarget.value; if (value === 'local' || value === 'cloud') choices = { ...choices, [row.key]: value }; }} data-testid="account-conflict-choice">
                      <option value="" disabled>{t('account.preview.choose')}</option>
                      <option value="local">{t('account.preview.localChoice')}</option>
                      <option value="cloud">{t('account.preview.cloudChoice')}</option>
                    </select>
                  </label>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        <div class="actions mt-3">
          <button type="button" class="primary" disabled={busy || !freshPreview || !conflictsResolved} onclick={() => commit('merge')} data-testid="account-commit-merge">{t('account.preview.merge')}</button>
          <button type="button" disabled={busy || !freshPreview} onclick={() => commit('local')} data-testid="account-commit-local">{t('account.preview.useLocal')}</button>
          <button type="button" disabled={busy || !freshPreview} onclick={() => commit('cloud')} data-testid="account-commit-cloud">{t('account.preview.useCloud')}</button>
        </div>
        <p class="text-xs hint mt-2">{t('account.preview.replaceHint')}</p>
      </div>
    {/if}

    {#if view.hasBackup}
      <div class="block" data-testid="account-backup">
        <h4 class="text-sm font-medium">{t('account.backup.title')}</h4>
        <p class="text-xs hint mt-2">{t('account.backup.hint')}</p>
        {#if confirmingRestore}
          <p class="text-xs mt-2">{t('account.backup.confirm')}</p>
          <div class="actions mt-2">
            <button type="button" disabled={busy} onclick={() => { void perform(() => accountSync.restoreBackup(), () => { confirmingRestore = false; committed = false; notice = t('account.backup.done'); }); }} data-testid="account-backup-confirm">{t('account.backup.restore')}</button>
            <button type="button" disabled={busy} onclick={() => { confirmingRestore = false; }}>{t('account.cancel')}</button>
          </div>
        {:else}
          <button type="button" class="mt-2" disabled={busy} onclick={() => { confirmingRestore = true; }} data-testid="account-backup-restore">{t('account.backup.restore')}</button>
        {/if}
      </div>
    {/if}

    <div class="block" data-testid="account-devices">
      <div class="card-row">
        <h4 class="text-sm font-medium">{t('account.devices.title')}</h4>
        <button type="button" disabled={busy} onclick={loadDevices} data-testid="account-devices-refresh">{t('account.devices.refresh')}</button>
      </div>
      <p class="text-xs hint mt-2">{t('account.devices.hint')}</p>
      {#if devicesLoaded && !devices.length}<p class="text-xs hint mt-2">{t('account.devices.empty')}</p>{/if}
      <ul class="list mt-2">
        {#each devices as device (device.id)}
          <li class="difference">
            <div class="break">
              <span class="text-sm">{device.name}</span>
              {#if device.current}<span class="badge">{t('account.devices.current')}</span>{/if}
              <p class="text-xs hint">{t('account.devices.lastSeen', { time: formatTime(device.last_seen_at) })}</p>
              <p class="text-xs hint">{t('account.devices.expires', { time: formatTime(device.expires_at) })}</p>
            </div>
            <button type="button" class="danger" disabled={busy} onclick={() => { revokeTarget = device; }} data-testid="account-device-revoke">{t('account.devices.revoke')}</button>
          </li>
        {/each}
      </ul>
      {#if revokeTarget}
        <div class="confirm mt-2" role="group" aria-labelledby="account-revoke-question">
          <p id="account-revoke-question" class="text-xs">{t(revokeTarget.current ? 'account.devices.revokeCurrent' : 'account.devices.revokeOther', { name: revokeTarget.name })}</p>
          <div class="actions">
            <button type="button" class="danger" disabled={busy} onclick={revokeDevice} data-testid="account-device-revoke-confirm">{t('account.devices.revoke')}</button>
            <button type="button" disabled={busy} onclick={() => { revokeTarget = null; }}>{t('account.cancel')}</button>
          </div>
        </div>
      {/if}
    </div>

    <div class="block" data-testid="account-session-actions">
      <label class="check text-sm">
        <input type="checkbox" bind:checked={keepConnections} disabled={busy} data-testid="account-keep-connections" />
        <span>{t('account.logout.keepConnections')}</span>
      </label>
      <p class="text-xs hint mt-2">{t('account.logout.scope')}</p>
      {#if confirmingLogout}
        <div class="confirm mt-3" role="group" aria-labelledby="account-logout-question">
          <p id="account-logout-question" class="text-xs">{t('account.logout.confirm')}</p>
          <div class="actions">
            <button type="button" disabled={busy} onclick={logout} data-testid="account-logout-confirm">{t('account.logout.button')}</button>
            <button type="button" disabled={busy} onclick={() => { confirmingLogout = false; }}>{t('account.cancel')}</button>
          </div>
        </div>
      {:else}
        <button type="button" class="mt-3" disabled={busy} onclick={() => { confirmingLogout = true; }} data-testid="account-logout">{t('account.logout.button')}</button>
      {/if}
      <div class="mt-3">
        {#if confirmingDelete}
          <form class="form confirm" onsubmit={deleteAccount} data-testid="account-delete-form">
            <p class="text-xs">{t('account.delete.scope')}</p>
            <label class="field">
              <span class="text-sm">{t('account.delete.password')}</span>
              <input type="password" autocomplete="current-password" required bind:value={deletePassword} disabled={busy} data-testid="account-delete-password" />
            </label>
            <label class="check text-xs">
              <input type="checkbox" bind:checked={deleteAcknowledged} disabled={busy} data-testid="account-delete-acknowledged" />
              <span>{t('account.delete.acknowledge')}</span>
            </label>
            <div class="actions">
              <button type="submit" class="danger" disabled={busy || !deleteAcknowledged || !deletePassword} data-testid="account-delete-confirm">{t('account.delete.confirm')}</button>
              <button type="button" disabled={busy} onclick={() => { confirmingDelete = false; deletePassword = ''; deleteAcknowledged = false; }}>{t('account.cancel')}</button>
            </div>
          </form>
        {:else}
          <button type="button" class="danger" disabled={busy} onclick={() => { confirmingDelete = true; }} data-testid="account-delete">{t('account.delete.button')}</button>
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .account-panel { color: var(--novelist-text); }
  .hint { color: var(--novelist-text-secondary); }
  .error { color: #ef4444; }
  .block { border: 1px solid var(--novelist-border); border-radius: 0.375rem; padding: 0.75rem; margin-top: 0.75rem; }
  .form, .field, .confirm { display: flex; flex-direction: column; gap: 0.25rem; }
  .form { gap: 0.75rem; }
  .check { display: flex; align-items: flex-start; gap: 0.5rem; }
  .check input { flex: 0 0 auto; margin-top: 0.2rem; }
  input:not([type='checkbox']), select { font-size: 0.875rem; padding: 0.375rem 0.5rem; border-radius: 0.25rem; background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border); width: 100%; min-height: 2.25rem; }
  button { font-size: 0.8125rem; padding: 0.375rem 0.75rem; border-radius: 0.25rem; border: 1px solid var(--novelist-border); background: var(--novelist-bg-secondary); color: var(--novelist-text); cursor: pointer; min-height: 2.25rem; }
  button.primary { background: var(--novelist-accent); border-color: var(--novelist-accent); color: #fff; }
  button.danger { border-color: #ef4444; color: #ef4444; }
  button:disabled, input:disabled, select:disabled, fieldset:disabled { opacity: 0.6; }
  button:disabled { cursor: default; }
  .actions, .status-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
  .card-row, .difference { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
  .difference { padding: 0.625rem 0; border-top: 1px solid var(--novelist-border); flex-wrap: wrap; }
  .difference:first-child { border-top: none; }
  .choice { min-width: 10rem; }
  .value-comparison { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; }
  .value-comparison dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .badge { display: inline-block; font-size: 0.75rem; padding: 0.125rem 0.5rem; border-radius: 999px; border: 1px solid var(--novelist-border); color: var(--novelist-text-secondary); }
  .scope-options { display: flex; flex-direction: column; gap: 0.5rem; border: 0; padding: 0.75rem 0; margin: 0.5rem 0 0; min-width: 0; }
  .list { list-style: none; margin-bottom: 0; padding: 0; }
  .break { min-width: 0; overflow-wrap: anywhere; }
  .key { font-family: monospace; }
  @media (pointer: coarse) { button, input:not([type='checkbox']), select { min-height: 2.75rem; } }
</style>
