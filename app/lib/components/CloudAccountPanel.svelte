<script lang="ts">
  import { onMount } from 'svelte';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import {
    commands,
    type CloudAccountStatus,
    type CloudAccountSummary,
    type CloudProject,
    type CloudProjectBinding,
    type ConflictResolution,
    type SyncStatus,
  } from '$lib/ipc/commands';
  import { platform } from '$lib/stores/platform.svelte';
  import { nonConflictErrors, syncedCleanly } from '$lib/services/cloud-sync-status';
  import { t } from '$lib/i18n';

  interface Props {
    /** Open project to link and sync; `null` when none is open. */
    projectDir?: string | null;
    /** Absolute project folder to open after a download (or for an existing copy). */
    onOpenProject?: (path: string) => void;
  }

  let { projectDir = null, onOpenProject }: Props = $props();

  const INTERVALS = [15, 30, 60, 120] as const;

  // ── account ──
  let account = $state<CloudAccountSummary | null>(null);
  let connection = $state<CloudAccountStatus | null>(null);
  let checking = $state(false);
  let endpoint = $state('');
  let username = $state('');
  let password = $state('');
  let connecting = $state(false);
  let accountError = $state<string | null>(null);
  let confirmingDisconnect = $state(false);
  let disconnecting = $state(false);
  let notice = $state<string | null>(null);

  // ── this project ──
  let binding = $state<CloudProjectBinding | null>(null);
  let bindingFor: string | null = null;
  let interval = $state(30);
  let linking = $state(false);
  let syncing = $state(false);
  let syncStatus = $state<SyncStatus | null>(null);
  let projectError = $state<string | null>(null);
  let resolving = $state<string | null>(null);

  // ── cloud projects ──
  let projects = $state<CloudProject[]>([]);
  let listed = $state(false);
  let listing = $state(false);
  let listError = $state<string | null>(null);
  let truncated = $state(false);
  let skipped = $state(0);
  let downloading = $state<string | null>(null);

  const connected = $derived(account?.connected === true);

  /** Problems other than the per-file conflicts listed separately. */
  const otherErrors = $derived(nonConflictErrors(syncStatus));
  const synced = $derived(syncedCleanly(syncStatus));

  function announceSyncConfig(dir: string) {
    window.dispatchEvent(new CustomEvent('novelist-sync-config-changed', { detail: { projectDir: dir } }));
  }

  function formatTime(iso: string | null): string {
    if (!iso) return '';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  }

  function projectLabel(project: CloudProject): string {
    return project.name ?? t('cloud.projects.untitled', { id: project.project_id.slice(0, 8) });
  }

  onMount(() => {
    void loadAccount();
  });

  async function loadAccount() {
    const result = await commands.getCloudAccount();
    if (result.status === 'error') {
      accountError = result.error;
      return;
    }
    account = result.data;
    if (result.data.connected) {
      void checkConnection();
      void loadProjects();
    }
  }

  async function checkConnection() {
    checking = true;
    const result = await commands.checkCloudAccount();
    checking = false;
    if (result.status === 'ok') {
      connection = result.data;
      account = result.data.account;
    } else {
      connection = null;
      accountError = result.error;
    }
  }

  async function connect(event: SubmitEvent) {
    event.preventDefault();
    if (connecting) return;
    connecting = true;
    accountError = null;
    notice = null;
    const result = await commands.connectCloudAccount(endpoint, username, password);
    connecting = false;
    if (result.status === 'error') {
      accountError = result.error;
      return;
    }
    // The password now lives only in the device vault.
    password = '';
    account = result.data;
    connection = { account: result.data, state: 'online', message: null };
    if (projectDir) await loadBinding(projectDir);
    await loadProjects();
  }

  async function disconnect() {
    if (disconnecting) return;
    disconnecting = true;
    accountError = null;
    const result = await commands.disconnectCloudAccount();
    disconnecting = false;
    confirmingDisconnect = false;
    if (result.status === 'error') {
      accountError = result.error;
      return;
    }
    notice = t('cloud.account.disconnected', { count: result.data.unlinked_projects });
    account = { ...(account as CloudAccountSummary), connected: false, endpoint: null, host: null, username: null, connected_at: null };
    connection = null;
    projects = [];
    listed = false;
    syncStatus = null;
    if (projectDir) {
      announceSyncConfig(projectDir);
      await loadBinding(projectDir);
    }
  }

  // ── this project ──

  $effect(() => {
    const dir = projectDir;
    binding = null;
    syncStatus = null;
    projectError = null;
    if (dir) void loadBinding(dir);
  });

  async function loadBinding(dir: string) {
    bindingFor = dir;
    const result = await commands.getCloudProjectBinding(dir);
    if (bindingFor !== dir) return;
    if (result.status === 'error') {
      projectError = result.error;
      return;
    }
    binding = result.data;
    if (INTERVALS.includes(result.data.interval_minutes as (typeof INTERVALS)[number])) {
      interval = result.data.interval_minutes;
    }
  }

  async function link() {
    const dir = projectDir;
    if (!dir || linking) return;
    linking = true;
    projectError = null;
    const result = await commands.bindCloudProject(dir, interval);
    linking = false;
    if (projectDir !== dir) return;
    if (result.status === 'error') {
      projectError = result.error;
      return;
    }
    binding = result.data;
    announceSyncConfig(dir);
    await runSync();
  }

  async function unlink() {
    const dir = projectDir;
    if (!dir || linking) return;
    linking = true;
    projectError = null;
    const result = await commands.unbindCloudProject(dir);
    linking = false;
    if (projectDir !== dir) return;
    if (result.status === 'error') {
      projectError = result.error;
      return;
    }
    binding = result.data;
    syncStatus = null;
    announceSyncConfig(dir);
  }

  async function changeInterval(minutes: number) {
    interval = minutes;
    if (binding?.linked) await link();
  }

  async function runSync() {
    const dir = projectDir;
    if (!dir || syncing) return;
    syncing = true;
    projectError = null;
    const result = await commands.syncNow(dir);
    syncing = false;
    if (projectDir !== dir) return;
    if (result.status === 'error') {
      syncStatus = null;
      projectError = result.error;
      return;
    }
    syncStatus = result.data;
    if (binding && result.data.last_sync) binding = { ...binding, last_sync: result.data.last_sync };
  }

  async function resolve(path: string, resolution: ConflictResolution) {
    const dir = projectDir;
    if (!dir || resolving) return;
    resolving = path;
    projectError = null;
    notice = null;
    const result = await commands.resolveSyncConflict(dir, path, resolution);
    resolving = null;
    if (projectDir !== dir) return;
    if (result.status === 'error') {
      projectError = result.error;
      return;
    }
    if (result.data) notice = t('cloud.conflict.copySaved', { path: result.data });
    // Re-sync so the list reflects what is still unresolved.
    await runSync();
  }

  // ── cloud projects ──

  async function loadProjects() {
    if (listing) return;
    listing = true;
    listError = null;
    const result = await commands.listCloudProjects();
    listing = false;
    listed = true;
    if (result.status === 'error') {
      listError = result.error;
      return;
    }
    projects = result.data.projects;
    truncated = result.data.truncated;
    skipped = result.data.skipped;
  }

  async function download(project: CloudProject) {
    if (downloading) return;
    let parentDir: string | null = null;
    if (!platform.isMobile) {
      // Desktop has no project library: the user picks where the folder goes.
      const picked = await openDialog({ directory: true, title: t('cloud.projects.chooseFolder') });
      if (typeof picked !== 'string') return;
      parentDir = picked;
    }
    downloading = project.project_id;
    listError = null;
    const result = await commands.downloadCloudProject(project.project_id, parentDir);
    downloading = null;
    if (result.status === 'error') {
      listError = result.error;
      return;
    }
    announceSyncConfig(result.data.project_dir);
    if (platform.isMobile) {
      projects = projects.map((candidate) => candidate.project_id === project.project_id
        ? { ...candidate, local_project_dir: result.data.project_dir }
        : candidate);
    }
    onOpenProject?.(result.data.project_dir);
  }
</script>

<section class="cloud-panel" data-testid="cloud-account-panel" aria-labelledby="cloud-account-title">
  <h3 id="cloud-account-title" class="text-xs font-semibold uppercase tracking-wide mb-2" style="color: var(--novelist-text-secondary);">
    {t('cloud.title')}
  </h3>
  <p class="text-xs mb-3 hint">{t('cloud.intro')}</p>

  {#if notice}
    <p class="text-xs mb-3 notice" role="status" data-testid="cloud-notice">{notice}</p>
  {/if}

  {#if account === null && !accountError}
    <p class="text-sm hint">{t('cloud.loading')}</p>
  {:else if !connected}
    <form class="cloud-form" onsubmit={connect} data-testid="cloud-connect-form">
      <label class="field">
        <span class="text-sm">{t('cloud.account.endpoint')}</span>
        <input
          type="url"
          inputmode="url"
          autocapitalize="off"
          autocomplete="url"
          spellcheck="false"
          required
          placeholder="https://cloud.example.com/remote.php/dav/files/me/"
          bind:value={endpoint}
          data-testid="cloud-endpoint"
        />
        <span class="text-xs hint">{t('cloud.account.endpointHint')}</span>
      </label>
      <label class="field">
        <span class="text-sm">{t('cloud.account.username')}</span>
        <input
          type="text"
          autocapitalize="off"
          autocomplete="username"
          spellcheck="false"
          required
          bind:value={username}
          data-testid="cloud-username"
        />
      </label>
      <label class="field">
        <span class="text-sm">{t('cloud.account.appPassword')}</span>
        <input
          type="password"
          autocomplete="off"
          required
          bind:value={password}
          data-testid="cloud-password"
        />
        <span class="text-xs hint">{t('cloud.account.appPasswordHint')}</span>
      </label>
      <button type="submit" class="primary" disabled={connecting} data-testid="cloud-connect">
        {connecting ? t('cloud.account.connecting') : t('cloud.account.connect')}
      </button>
    </form>
  {:else if account}
    <div class="card" data-testid="cloud-account-card">
      <div class="card-row">
        <div class="min-w-0">
          <div class="text-sm font-medium truncate" data-testid="cloud-account-identity">
            {t('cloud.account.identity', { user: account.username ?? '', host: account.host ?? '' })}
          </div>
          <div class="text-xs hint truncate" title={account.endpoint ?? ''}>{account.endpoint}</div>
        </div>
        <span
          class="badge"
          class:ok={connection?.state === 'online'}
          class:bad={connection !== null && connection.state !== 'online'}
          data-testid="cloud-connection-state"
        >
          {checking ? t('cloud.state.checking') : t(`cloud.state.${connection?.state ?? 'unknown'}`)}
        </span>
      </div>
      {#if connection?.message}
        <p class="text-xs mt-2 error" role="alert">{connection.message}</p>
      {/if}
      <p class="text-xs mt-2 hint">
        {account.credential_storage === 'system_keychain' ? t('cloud.account.storedKeychain') : t('cloud.account.storedFile')}
      </p>
      <div class="actions mt-2">
        <button type="button" onclick={checkConnection} disabled={checking} data-testid="cloud-check">
          {t('cloud.account.check')}
        </button>
        {#if confirmingDisconnect}
          <div class="confirm" role="alertdialog" aria-labelledby="cloud-disconnect-question">
            <p id="cloud-disconnect-question" class="text-xs">{t('cloud.account.disconnectConfirm')}</p>
            <div class="actions">
              <button type="button" class="danger" onclick={disconnect} disabled={disconnecting} data-testid="cloud-disconnect-confirm">
                {t('cloud.account.disconnect')}
              </button>
              <button type="button" onclick={() => { confirmingDisconnect = false; }} disabled={disconnecting}>
                {t('cloud.cancel')}
              </button>
            </div>
          </div>
        {:else}
          <button type="button" onclick={() => { confirmingDisconnect = true; }} data-testid="cloud-disconnect">
            {t('cloud.account.disconnect')}
          </button>
        {/if}
      </div>
    </div>
  {/if}

  {#if accountError}
    <p class="text-xs mt-2 error" role="alert" data-testid="cloud-account-error">{accountError}</p>
  {/if}

  {#if connected}
    <div class="block" data-testid="cloud-this-project">
      <h4 class="text-sm font-medium mb-2">{t('cloud.project.title')}</h4>
      {#if !projectDir}
        <p class="text-xs hint">{t('cloud.project.none')}</p>
      {:else if binding}
        {#if binding.other_account}
          <p class="text-xs mb-2 error">{t('cloud.project.otherAccount')}</p>
        {:else if binding.custom_webdav && !binding.linked}
          <p class="text-xs mb-2 hint">{t('cloud.project.customWebdav')}</p>
        {/if}
        <div class="actions">
          {#if binding.linked && binding.enabled}
            <button type="button" class="primary" onclick={runSync} disabled={syncing} data-testid="cloud-sync-now">
              {syncing ? t('cloud.project.syncing') : t('cloud.project.syncNow')}
            </button>
            <button type="button" onclick={unlink} disabled={linking || syncing} data-testid="cloud-unlink">
              {t('cloud.project.unlink')}
            </button>
          {:else}
            <button type="button" class="primary" onclick={link} disabled={linking} data-testid="cloud-link">
              {t('cloud.project.link')}
            </button>
          {/if}
          <label class="interval">
            <span class="text-xs">{t('cloud.project.interval')}</span>
            <select
              value={interval}
              onchange={(event) => changeInterval(Number(event.currentTarget.value))}
              disabled={linking}
            >
              {#each INTERVALS as minutes (minutes)}
                <option value={minutes}>{t('cloud.project.minutes', { count: minutes })}</option>
              {/each}
            </select>
          </label>
        </div>

        {#if syncing}
          <p class="text-xs mt-2 hint" role="status">{t('cloud.project.syncing')}</p>
        {:else if synced && syncStatus}
          <p class="text-xs mt-2 ok-text" role="status" data-testid="cloud-sync-ok">
            {t('cloud.project.synced', { time: formatTime(syncStatus.last_sync), up: syncStatus.files_uploaded, down: syncStatus.files_downloaded })}
          </p>
        {:else if syncStatus}
          <p class="text-xs mt-2 error" role="alert" data-testid="cloud-sync-problems">
            {t('cloud.project.problems', { count: syncStatus.errors.length })}
          </p>
        {:else if binding.linked && binding.last_sync}
          <p class="text-xs mt-2 hint">{t('cloud.project.lastSync', { time: formatTime(binding.last_sync) })}</p>
        {/if}

        {#if otherErrors.length > 0}
          <ul class="text-xs mt-1 error list" data-testid="cloud-sync-errors">
            {#each otherErrors as error, index (index)}
              <li>{error}</li>
            {/each}
          </ul>
        {/if}

        {#if syncStatus && syncStatus.conflicts.length > 0}
          <div class="conflicts mt-2" data-testid="cloud-conflicts">
            <p class="text-xs mb-1">{t('cloud.conflict.explain')}</p>
            {#each syncStatus.conflicts as path (path)}
              <div class="conflict" data-testid="cloud-conflict">
                <code class="text-xs path">{path}</code>
                <div class="actions">
                  <button type="button" disabled={resolving !== null} onclick={() => resolve(path, 'keep_local')}>
                    {t('cloud.conflict.keepLocal')}
                  </button>
                  <button type="button" disabled={resolving !== null} onclick={() => resolve(path, 'keep_remote')}>
                    {t('cloud.conflict.keepRemote')}
                  </button>
                  {#if !path.startsWith('.novelist/')}
                    <button type="button" disabled={resolving !== null} onclick={() => resolve(path, 'keep_both')}>
                      {t('cloud.conflict.keepBoth')}
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
            <p class="text-xs mt-1 hint">{t('cloud.conflict.backupNote')}</p>
          </div>
        {/if}
      {/if}
      {#if projectError}
        <p class="text-xs mt-2 error" role="alert" data-testid="cloud-project-error">{projectError}</p>
      {/if}
    </div>

    <div class="block" data-testid="cloud-projects">
      <div class="card-row mb-2">
        <h4 class="text-sm font-medium">{t('cloud.projects.title')}</h4>
        <button type="button" onclick={loadProjects} disabled={listing} data-testid="cloud-projects-refresh">
          {listing ? t('cloud.projects.loading') : t('cloud.projects.refresh')}
        </button>
      </div>
      {#if listed && projects.length === 0 && !listError}
        <p class="text-xs hint">{t('cloud.projects.empty')}</p>
      {/if}
      <ul class="list projects">
        {#each projects as project (project.project_id)}
          <li class="project" data-testid="cloud-project">
            <div class="min-w-0">
              <div class="text-sm truncate">{projectLabel(project)}</div>
              <div class="text-xs hint">{project.project_id.slice(0, 12)}</div>
            </div>
            {#if project.local_project_dir}
              <button type="button" onclick={() => onOpenProject?.(project.local_project_dir!)} data-testid="cloud-project-open">
                {t('cloud.projects.open')}
              </button>
            {:else}
              <button
                type="button"
                class="primary"
                disabled={downloading !== null}
                onclick={() => download(project)}
                data-testid="cloud-project-download"
              >
                {downloading === project.project_id ? t('cloud.projects.downloading') : t('cloud.projects.download')}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
      {#if truncated}
        <p class="text-xs mt-1 hint">{t('cloud.projects.truncated')}</p>
      {/if}
      {#if skipped > 0}
        <p class="text-xs mt-1 hint">{t('cloud.projects.skipped', { count: skipped })}</p>
      {/if}
      {#if listError}
        <p class="text-xs mt-2 error" role="alert" data-testid="cloud-projects-error">{listError}</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .cloud-panel {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .hint {
    color: var(--novelist-text-secondary);
  }
  .error {
    color: #ef4444;
  }
  .ok-text {
    color: #22c55e;
  }
  .notice {
    color: var(--novelist-text);
  }
  .cloud-form,
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .cloud-form {
    gap: 0.75rem;
  }
  input,
  select {
    font-size: 0.875rem;
    padding: 0.375rem 0.5rem;
    border-radius: 0.25rem;
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text);
    border: 1px solid var(--novelist-border);
    width: 100%;
    min-height: 2.25rem;
  }
  button {
    font-size: 0.8125rem;
    padding: 0.375rem 0.75rem;
    border-radius: 0.25rem;
    border: 1px solid var(--novelist-border);
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text);
    cursor: pointer;
    min-height: 2.25rem;
    white-space: nowrap;
  }
  button.primary {
    background: var(--novelist-accent);
    border-color: var(--novelist-accent);
    color: #fff;
  }
  button.danger {
    border-color: #ef4444;
    color: #ef4444;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .card,
  .block {
    border: 1px solid var(--novelist-border);
    border-radius: 0.375rem;
    padding: 0.75rem;
  }
  .block {
    margin-top: 0.75rem;
  }
  .card-row,
  .project,
  .conflict {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .confirm {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
  }
  .interval {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .interval select {
    width: auto;
  }
  .badge {
    font-size: 0.75rem;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--novelist-border);
    color: var(--novelist-text-secondary);
    white-space: nowrap;
  }
  .badge.ok {
    color: #22c55e;
    border-color: #22c55e;
  }
  .badge.bad {
    color: #ef4444;
    border-color: #ef4444;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .projects .project {
    padding: 0.5rem 0;
    border-top: 1px solid var(--novelist-border);
  }
  .projects .project:first-child {
    border-top: none;
  }
  .conflict {
    padding: 0.375rem 0;
    flex-wrap: wrap;
  }
  .path {
    overflow-wrap: anywhere;
    background: var(--novelist-code-bg);
    padding: 1px 4px;
    border-radius: 3px;
  }
  .min-w-0 {
    min-width: 0;
  }
  /* Comfortable touch targets on phones and tablets. */
  @media (pointer: coarse) {
    button,
    input,
    select {
      min-height: 2.75rem;
    }
  }
</style>
