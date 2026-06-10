<script lang="ts">
  import { onMount } from 'svelte';
  import { commands, type HostConfig, type ImageHostSettings_Serialize, type ProviderConfig } from '$lib/ipc/commands';
  import { dispatchUpload, toProviderConfig } from '$lib/services/image-host';
  import { t } from '$lib/i18n';
  import SettingsSwitch from './SettingsSwitch.svelte';

  type ProviderId = ProviderConfig['provider'];

  // The Serialize phase shape — what reads return: `hosts`/`auto_on_paste`
  // always present. Structurally assignable to the Deserialize shape that
  // setImageHostSettings expects, so one local type serves both directions.
  let settings: ImageHostSettings_Serialize = $state({ hosts: [], active_host_id: undefined, auto_on_paste: false });
  let loading = $state(true);
  let saveError = $state<string | null>(null);
  let testStatus = $state<Record<string, { kind: 'idle' | 'pending' | 'ok' | 'err'; message?: string }>>({});

  // Form state for the "Add host" / edit dialog.
  let editing = $state<{ host: HostConfig; isNew: boolean } | null>(null);
  /** Set of secret-field keys whose value is currently revealed. */
  let revealedFields = $state<Set<string>>(new Set());
  function toggleReveal(key: string) {
    const next = new Set(revealedFields);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    revealedFields = next;
  }

  onMount(async () => {
    await reload();
    loading = false;
  });

  async function reload() {
    const r = await commands.getImageHostSettings();
    if (r.status === 'ok') settings = r.data;
  }

  async function persist() {
    saveError = null;
    const r = await commands.setImageHostSettings(settings);
    if (r.status !== 'ok') saveError = r.error;
  }

  function newHost(provider: ProviderId): HostConfig {
    const id = crypto.randomUUID();
    const name = providerLabel(provider);
    let body: ProviderConfig;
    switch (provider) {
      case 'qiniu':       body = { provider: 'qiniu', access_key: '', secret_key: '', bucket: '', domain: '' }; break;
      case 'aliyun_oss':  body = { provider: 'aliyun_oss', access_key_id: '', access_key_secret: '', bucket: '', endpoint: '' }; break;
      case 's3':          body = { provider: 's3', access_key_id: '', secret_access_key: '', bucket: '', region: 'us-east-1' }; break;
      case 'imgur':       body = { provider: 'imgur', client_id: '' }; break;
      case 'smms':        body = { provider: 'smms' }; break;
      case 'custom':      body = { provider: 'custom', post_url: '' }; break;
    }
    return { id, name, ...body } as HostConfig;
  }

  function providerLabel(p: ProviderId): string {
    switch (p) {
      case 'qiniu':      return 'Qiniu';
      case 'aliyun_oss': return 'Aliyun OSS';
      case 's3':         return 'Amazon S3';
      case 'imgur':      return 'imgur';
      case 'smms':       return 'sm.ms';
      case 'custom':     return 'Custom';
    }
  }

  function startAdd(provider: ProviderId) {
    editing = { host: newHost(provider), isNew: true };
  }
  function startEdit(host: HostConfig) {
    // $state.snapshot — structuredClone throws on Svelte 5 $state proxies.
    editing = { host: $state.snapshot(host) as HostConfig, isNew: false };
  }
  function cancelEdit() { editing = null; }
  async function saveEdit() {
    if (!editing) return;
    const idx = settings.hosts.findIndex(h => h.id === editing!.host.id);
    if (idx >= 0) settings.hosts[idx] = editing.host;
    else settings.hosts.push(editing.host);
    if (editing.isNew && !settings.active_host_id) settings.active_host_id = editing.host.id;
    editing = null;
    await persist();
  }
  async function removeHost(id: string) {
    settings.hosts = settings.hosts.filter(h => h.id !== id);
    if (settings.active_host_id === id) settings.active_host_id = settings.hosts[0]?.id;
    await persist();
  }
  async function setActive(id: string) {
    settings.active_host_id = id;
    await persist();
  }
  async function toggleAutoOnPaste(checked: boolean) {
    settings.auto_on_paste = checked;
    await persist();
  }

  /** A 1×1 transparent PNG used to test-upload without sending real content. */
  const ONE_PX_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAusB9Zy5HJ4AAAAASUVORK5CYII=';
  function decodeBase64(b64: string): number[] {
    const bin = atob(b64);
    const bytes = new Array<number>(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function testHost(host: HostConfig) {
    testStatus[host.id] = { kind: 'pending' };
    try {
      const cfg = toProviderConfig(host);
      const bytes = decodeBase64(ONE_PX_PNG_B64);
      const result = await dispatchUpload(cfg, bytes, 'novelist-test.png', 'image/png');
      testStatus[host.id] = { kind: 'ok', message: result.url };
    } catch (e) {
      testStatus[host.id] = { kind: 'err', message: e instanceof Error ? e.message : String(e) };
    }
  }

  // Form-field helper: given a ProviderConfig, list its editable fields.
  function fieldsFor(p: ProviderConfig): Array<{ key: string; label: string; placeholder?: string; secret?: boolean; optional?: boolean }> {
    switch (p.provider) {
      case 'qiniu': return [
        { key: 'access_key',  label: 'AccessKey',  placeholder: 'AK...' },
        { key: 'secret_key',  label: 'SecretKey',  secret: true },
        { key: 'bucket',      label: 'Bucket' },
        { key: 'domain',      label: 'Public domain', placeholder: 'https://cdn.example.com' },
      ];
      case 'aliyun_oss': return [
        { key: 'access_key_id',     label: 'AccessKeyId' },
        { key: 'access_key_secret', label: 'AccessKeySecret', secret: true },
        { key: 'bucket',            label: 'Bucket' },
        { key: 'endpoint',          label: 'Endpoint', placeholder: 'oss-cn-hangzhou.aliyuncs.com' },
        { key: 'custom_domain',     label: 'Custom domain', optional: true, placeholder: 'https://images.example.com' },
      ];
      case 's3': return [
        { key: 'access_key_id',     label: 'AccessKeyId' },
        { key: 'secret_access_key', label: 'SecretAccessKey', secret: true },
        { key: 'bucket',            label: 'Bucket' },
        { key: 'region',            label: 'Region', placeholder: 'us-east-1 / auto for R2' },
        { key: 'endpoint',          label: 'Endpoint (R2 / MinIO)', optional: true },
        { key: 'path_prefix',       label: 'Path prefix', optional: true },
        { key: 'custom_domain',     label: 'Custom domain', optional: true },
      ];
      case 'imgur':  return [{ key: 'client_id', label: 'Client ID' }];
      case 'smms':   return [{ key: 'api_token', label: 'API token', secret: true, optional: true }];
      case 'custom': return [
        { key: 'post_url', label: 'POST URL' },
        { key: 'bearer',   label: 'Bearer token', secret: true, optional: true },
      ];
    }
  }
</script>

<div class="image-hosts-panel">
  <h3 class="text-xs font-semibold uppercase tracking-wide mb-4" style="color: var(--novelist-text-secondary);">{t('settings.imageHosts.title')}</h3>

  {#if loading}
    <div class="text-sm" style="color: var(--novelist-text-secondary);">…</div>
  {:else}
    <div class="flex items-center justify-between mb-4">
      <label class="text-sm" for="auto-on-paste">{t('settings.imageHosts.autoOnPaste')}</label>
      <SettingsSwitch
        id="auto-on-paste"
        checked={settings.auto_on_paste}
        ariaLabel={t('settings.imageHosts.autoOnPaste')}
        onCheckedChange={toggleAutoOnPaste}
      />
    </div>

    <div class="text-xs uppercase tracking-wide mb-2" style="color: var(--novelist-text-secondary);">{t('settings.imageHosts.configured')}</div>
    {#if settings.hosts.length === 0}
      <div class="text-sm mb-3" style="color: var(--novelist-text-secondary);">{t('settings.imageHosts.empty')}</div>
    {:else}
      <ul class="space-y-2 mb-4">
        {#each settings.hosts as host (host.id)}
          <li class="flex items-center justify-between gap-3 p-2 rounded" style="border: 1px solid var(--novelist-border);">
            <div class="flex items-center gap-2 flex-1">
              <input
                type="radio"
                name="active-host"
                checked={settings.active_host_id === host.id}
                onchange={() => setActive(host.id)}
                aria-label="Set {host.name} as active host"
              />
              <div class="flex flex-col">
                <span class="text-sm font-medium">{host.name}</span>
                <span class="text-xs" style="color: var(--novelist-text-secondary);">{providerLabel(host.provider)}</span>
              </div>
              {#if testStatus[host.id]?.kind === 'pending'}
                <span class="text-xs ml-2" style="color: var(--novelist-text-secondary);">{t('settings.imageHosts.testing')}</span>
              {:else if testStatus[host.id]?.kind === 'ok'}
                <span class="text-xs ml-2" style="color: #2da84a;" title={testStatus[host.id].message}>{t('settings.imageHosts.testOk')}</span>
              {:else if testStatus[host.id]?.kind === 'err'}
                <span class="text-xs ml-2" style="color: #d24a4a;" title={testStatus[host.id].message}>{t('settings.imageHosts.testFailed')}</span>
              {/if}
            </div>
            <button class="text-xs px-2 py-1 cursor-pointer" onclick={() => testHost(host)} style="border: 1px solid var(--novelist-border); background: transparent;">{t('settings.imageHosts.test')}</button>
            <button class="text-xs px-2 py-1 cursor-pointer" onclick={() => startEdit(host)} style="border: 1px solid var(--novelist-border); background: transparent;">{t('settings.imageHosts.edit')}</button>
            <button class="text-xs px-2 py-1 cursor-pointer" onclick={() => removeHost(host.id)} style="border: 1px solid var(--novelist-border); background: transparent; color: #d24a4a;">{t('settings.imageHosts.delete')}</button>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="text-xs uppercase tracking-wide mb-2" style="color: var(--novelist-text-secondary);">{t('settings.imageHosts.addHost')}</div>
    <div class="flex flex-wrap gap-2 mb-4">
      {#each ['qiniu','aliyun_oss','s3','imgur','smms','custom'] as ProviderId[] as p}
        <button
          class="text-xs px-3 py-1.5 cursor-pointer rounded"
          style="border: 1px solid var(--novelist-border); background: transparent;"
          onclick={() => startAdd(p)}
        >{providerLabel(p)}</button>
      {/each}
    </div>

    {#if saveError}
      <div class="text-xs mb-3" style="color: #d24a4a;">{t('settings.imageHosts.failedToSave')}: {saveError}</div>
    {/if}
  {/if}

  {#if editing}
    <div class="modal-backdrop"
         onclick={(e) => { if (e.target === e.currentTarget) cancelEdit(); }}
         onkeydown={(e) => e.key === 'Escape' && cancelEdit()}
         role="button" tabindex="0">
      <div class="modal" role="dialog" tabindex="-1">
        <h4 class="text-sm font-semibold mb-3">{editing.isNew ? 'Add' : 'Edit'} {providerLabel(editing.host.provider)} host</h4>

        <div class="flex items-center justify-between mb-3 gap-2">
          <label class="text-xs w-32" for="host-name">Name</label>
          <input
            id="host-name"
            type="text"
            class="text-sm flex-1 px-2 py-1 rounded"
            style="border: 1px solid var(--novelist-border); background: var(--novelist-bg);"
            bind:value={editing.host.name}
          />
        </div>

        {#each fieldsFor(editing.host) as f}
          {@const shown = f.secret && revealedFields.has(f.key)}
          <div class="flex items-center justify-between mb-3 gap-2">
            <label class="text-xs w-32 shrink-0" for="host-{f.key}">
              {f.label}{#if f.optional} <span style="color: var(--novelist-text-secondary);">(opt)</span>{/if}
            </label>
            <div class="flex flex-1 gap-1">
              <input
                id="host-{f.key}"
                type={f.secret && !shown ? 'password' : 'text'}
                placeholder={f.placeholder ?? ''}
                class="text-sm flex-1 px-2 py-1 rounded"
                style="border: 1px solid var(--novelist-border); background: var(--novelist-bg);"
                value={(editing.host as unknown as Record<string, string>)[f.key] ?? ''}
                oninput={(e) => {
                  const val = (e.currentTarget as HTMLInputElement).value;
                  (editing!.host as unknown as Record<string, string>)[f.key] = val;
                }}
              />
              {#if f.secret}
                <button type="button" class="reveal-btn" onclick={() => toggleReveal(f.key)}
                        title={shown ? '隐藏' : '显示'}
                        aria-label={shown ? '隐藏' : '显示'}>
                  {#if shown}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
                  {:else}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
                  {/if}
                </button>
              {/if}
            </div>
          </div>
        {/each}

        <div class="flex justify-end gap-2 mt-4">
          <button class="text-xs px-3 py-1.5 cursor-pointer rounded" onclick={cancelEdit}
                  style="border: 1px solid var(--novelist-border); background: transparent;">{t('settings.imageHosts.cancel')}</button>
          <button class="text-xs px-3 py-1.5 cursor-pointer rounded" onclick={saveEdit}
                  style="border: none; background: var(--novelist-accent); color: white;">{editing.isNew ? t('settings.imageHosts.add') : t('settings.imageHosts.save')}</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .reveal-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 8px;
    background: transparent;
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    color: var(--novelist-text-secondary);
    cursor: pointer;
    flex-shrink: 0;
  }
  .reveal-btn:hover {
    color: var(--novelist-text);
    background: var(--novelist-sidebar-hover);
  }
  .modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center;
    z-index: 1000;
  }
  .modal {
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 8px;
    padding: 16px;
    width: 480px;
    max-width: 90vw;
    max-height: 80vh;
    overflow-y: auto;
  }
</style>
