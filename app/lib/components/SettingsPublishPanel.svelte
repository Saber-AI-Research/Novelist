<script lang="ts">
  import { onMount } from 'svelte';
  import { open as shellOpen } from '@tauri-apps/plugin-shell';
  import { commands, type ChannelConfig, type PandocStatus, type PlatformConfig, type PublishSettings } from '$lib/ipc/commands';
  import { t } from '$lib/i18n';

  type PlatformId = PlatformConfig['platform'];

  // `channels` is optional on the wire (serde default) — keep it required
  // locally so the template can index it without guards.
  let settings: Required<PublishSettings> = $state({ channels: [] });
  let loading = $state(true);
  let saveError = $state<string | null>(null);
  let testStatus = $state<Record<string, { kind: 'idle' | 'pending' | 'ok' | 'err'; message?: string }>>({});

  let editing = $state<{ channel: ChannelConfig; isNew: boolean } | null>(null);
  /** Set of field keys whose secret value is currently revealed (eye icon toggled). */
  let revealedFields = $state<Set<string>>(new Set());
  function toggleReveal(key: string) {
    const next = new Set(revealedFields);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    revealedFields = next;
  }

  // --- Pandoc status / override ---
  // Ghost and WordPress publish flows convert MD→HTML via Pandoc;
  // we surface its status here so the user can fix a broken install
  // without leaving the Publish settings page.
  let pandocStatus = $state<PandocStatus | null>(null);
  let pandocOverrideInput = $state('');
  let pandocSavingOverride = $state(false);

  async function refreshPandocStatus() {
    const r = await commands.checkPandoc();
    if (r.status === 'ok') {
      pandocStatus = r.data;
      pandocOverrideInput = r.data.override_path ?? '';
    }
  }

  async function savePandocOverride() {
    pandocSavingOverride = true;
    const value = pandocOverrideInput.trim();
    await commands.setPandocPath(value === '' ? null : value);
    await refreshPandocStatus();
    pandocSavingOverride = false;
  }

  async function openPandocInstallPage() {
    // Tauri WKWebView blocks `window.open`; route through the shell plugin.
    try {
      await shellOpen('https://pandoc.org/installing.html');
    } catch (e) {
      console.error('[settings] shell.open failed:', e);
    }
  }

  onMount(async () => {
    await reload();
    await refreshPandocStatus();
    loading = false;
  });

  async function reload() {
    const r = await commands.getPublishSettings();
    if (r.status === 'ok') settings = { channels: r.data.channels ?? [] };
  }

  async function persist() {
    saveError = null;
    const r = await commands.setPublishSettings(settings);
    if (r.status !== 'ok') saveError = r.error;
  }

  function platformLabel(p: PlatformId): string {
    return t(`settings.publish.platform.${p}`);
  }

  function newChannel(platform: PlatformId): ChannelConfig {
    const id = crypto.randomUUID();
    const name = platformLabel(platform);
    let body: PlatformConfig;
    switch (platform) {
      case 'ghost':                 body = { platform: 'ghost', admin_url: '', api_key: '' }; break;
      case 'wordpress_self_hosted': body = { platform: 'wordpress_self_hosted', site_url: '', username: '', app_password: '' }; break;
      case 'wordpress_com':         body = { platform: 'wordpress_com', site_id_or_domain: '', access_token: '' }; break;
      case 'medium':                body = { platform: 'medium', token: '' }; break;
    }
    return { id, name, ...body } as ChannelConfig;
  }

  function startAdd(platform: PlatformId) {
    editing = { channel: newChannel(platform), isNew: true };
    revealedFields = new Set();
  }
  function startEdit(c: ChannelConfig)   {
    // Use $state.snapshot — structuredClone() throws DataCloneError on
    // Svelte 5 $state proxies, which silently kills the Edit button.
    editing = { channel: $state.snapshot(c) as ChannelConfig, isNew: false };
    revealedFields = new Set();
  }
  function cancelEdit()                  { editing = null; revealedFields = new Set(); }
  async function saveEdit() {
    if (!editing) return;
    const idx = settings.channels.findIndex(c => c.id === editing!.channel.id);
    if (idx >= 0) settings.channels[idx] = editing.channel;
    else settings.channels.push(editing.channel);
    editing = null;
    revealedFields = new Set();
    await persist();
  }
  async function removeChannel(id: string) {
    settings.channels = settings.channels.filter(c => c.id !== id);
    await persist();
  }

  /** Read-only verify call per platform — `GET /site/` for Ghost,
   *  `GET /users/me` for WordPress, `GET /v1/me` for Medium. None
   *  create or modify anything on the platform side, so this is a
   *  pure auth check. Returns a short status line on success; failure
   *  surfaces the platform's full response body so the user can see
   *  what's actually wrong. */
  async function testChannel(c: ChannelConfig) {
    testStatus[c.id] = { kind: 'pending' };
    try {
      const r = await commands.verifyPublishChannel(toPlatformConfig(c));
      if (r.status !== 'ok') {
        testStatus[c.id] = { kind: 'err', message: r.error };
      } else {
        testStatus[c.id] = { kind: 'ok', message: r.data };
      }
    } catch (e) {
      testStatus[c.id] = { kind: 'err', message: e instanceof Error ? e.message : String(e) };
    }
  }

  function toPlatformConfig(c: ChannelConfig): PlatformConfig {
    const { id: _id, name: _name, ...rest } = c;
    return rest as PlatformConfig;
  }

  function fieldsFor(c: ChannelConfig): Array<{ key: string; label: string; placeholder?: string; secret?: boolean; hint?: string }> {
    switch (c.platform) {
      case 'ghost': return [
        { key: 'admin_url', label: t('settings.publish.label.ghost.adminUrl'),
          placeholder: 'https://blog.example.com',
          hint: t('settings.publish.hint.ghost.adminUrl') },
        { key: 'api_key',   label: t('settings.publish.label.ghost.apiKey'), secret: true,
          placeholder: '64a1b2c3d4e5f6:abcdef0123…',
          hint: t('settings.publish.hint.ghost.apiKey') },
      ];
      case 'wordpress_self_hosted': return [
        { key: 'site_url',     label: t('settings.publish.label.wp.siteUrl'),
          placeholder: 'https://blog.example.com',
          hint: t('settings.publish.hint.wp.siteUrl') },
        { key: 'username',     label: t('settings.publish.label.wp.username'),
          hint: t('settings.publish.hint.wp.username') },
        { key: 'app_password', label: t('settings.publish.label.wp.appPassword'), secret: true,
          placeholder: 'abcd EFGH 1234 ijkl MNOP 6789',
          hint: t('settings.publish.hint.wp.appPassword') },
      ];
      case 'wordpress_com': return [
        { key: 'site_id_or_domain', label: t('settings.publish.label.wpcom.site'),
          placeholder: 'myblog.wordpress.com',
          hint: t('settings.publish.hint.wpcom.site') },
        { key: 'access_token',      label: t('settings.publish.label.wpcom.token'), secret: true,
          hint: t('settings.publish.hint.wpcom.token') },
      ];
      case 'medium': return [
        { key: 'token', label: t('settings.publish.label.medium.token'), secret: true,
          hint: t('settings.publish.hint.medium.token') },
      ];
    }
  }
</script>

<div class="publish-panel">
  <h3 class="text-xs font-semibold uppercase tracking-wide mb-4" style="color: var(--novelist-text-secondary);">{t('settings.publish.title')}</h3>

  {#if loading}
    <div class="text-sm" style="color: var(--novelist-text-secondary);">…</div>
  {:else}
    <!-- Pandoc status card — Ghost / WordPress publish flows need
         pandoc on the system. We never bundle it (binary-size cost),
         so users without it are pointed at the install page or can
         set a custom path. -->
    {#if pandocStatus}
      <div class="pandoc-card" class:pandoc-ok={pandocStatus.available} class:pandoc-err={!pandocStatus.available}>
        <div class="pandoc-row">
          <div class="pandoc-icon">
            {#if pandocStatus.available}✓{:else}!{/if}
          </div>
          <div class="pandoc-text">
            {#if pandocStatus.available}
              <div class="pandoc-headline">{t('settings.pandoc.foundHeadline')}</div>
              <div class="pandoc-detail">
                {pandocStatus.version ?? ''}
                {#if pandocStatus.resolved_path}
                  <span class="pandoc-path-mono">— {pandocStatus.resolved_path}</span>
                {/if}
              </div>
            {:else}
              <div class="pandoc-headline">{t('settings.pandoc.notFoundHeadline')}</div>
              <div class="pandoc-detail">{t('settings.pandoc.notFoundHint')}</div>
            {/if}
          </div>
          <button class="pandoc-btn" onclick={refreshPandocStatus} title={t('settings.pandoc.recheck')}>
            {t('settings.pandoc.recheck')}
          </button>
        </div>

        <div class="pandoc-override-row">
          <label class="text-xs shrink-0" for="pandoc-override-input" style="color: var(--novelist-text-secondary);">
            {t('settings.pandoc.overrideLabel')}
          </label>
          <input
            id="pandoc-override-input"
            type="text"
            class="pandoc-input"
            placeholder={t('settings.pandoc.overridePlaceholder')}
            bind:value={pandocOverrideInput}
          />
          <button class="pandoc-btn" onclick={savePandocOverride} disabled={pandocSavingOverride}>
            {pandocSavingOverride ? t('settings.pandoc.saving') : t('settings.pandoc.save')}
          </button>
          <button class="pandoc-btn pandoc-btn-link" onclick={openPandocInstallPage}>
            {t('settings.pandoc.installLink')}
          </button>
        </div>
      </div>
    {/if}

    <div class="text-xs uppercase tracking-wide mb-2" style="color: var(--novelist-text-secondary);">{t('settings.publish.configured')}</div>

    {#if settings.channels.length === 0}
      <div class="text-sm mb-3" style="color: var(--novelist-text-secondary);">{t('settings.publish.empty')}</div>
    {:else}
      <ul class="space-y-2 mb-4">
        {#each settings.channels as ch (ch.id)}
          <li class="rounded" style="border: 1px solid var(--novelist-border);">
            <div class="flex items-center justify-between gap-3 p-2">
              <div class="flex flex-col flex-1">
                <span class="text-sm font-medium">{ch.name}</span>
                <span class="text-xs" style="color: var(--novelist-text-secondary);">{platformLabel(ch.platform)}</span>
              </div>
              {#if testStatus[ch.id]?.kind === 'pending'}
                <span class="text-xs" style="color: var(--novelist-text-secondary);">{t('settings.publish.testing')}</span>
              {:else if testStatus[ch.id]?.kind === 'ok'}
                <span class="text-xs" style="color: #2da84a;">{t('settings.publish.testOk')}</span>
              {:else if testStatus[ch.id]?.kind === 'err'}
                <span class="text-xs" style="color: #d24a4a;">{t('settings.publish.testFailed')}</span>
              {/if}
              <button class="text-xs px-2 py-1 cursor-pointer" onclick={() => testChannel(ch)} style="border: 1px solid var(--novelist-border); background: transparent;">{t('settings.publish.test')}</button>
              <button class="text-xs px-2 py-1 cursor-pointer" onclick={() => startEdit(ch)} style="border: 1px solid var(--novelist-border); background: transparent;">{t('settings.publish.edit')}</button>
              <button class="text-xs px-2 py-1 cursor-pointer" onclick={() => removeChannel(ch.id)} style="border: 1px solid var(--novelist-border); background: transparent; color: #d24a4a;">{t('settings.publish.delete')}</button>
            </div>
            {#if testStatus[ch.id]?.message && (testStatus[ch.id]?.kind === 'err' || testStatus[ch.id]?.kind === 'ok')}
              <pre class="test-detail" class:err={testStatus[ch.id]?.kind === 'err'}>{testStatus[ch.id]!.message}</pre>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="text-xs uppercase tracking-wide mb-2" style="color: var(--novelist-text-secondary);">{t('settings.publish.addChannel')}</div>
    <div class="flex flex-wrap gap-2 mb-4">
      {#each ['ghost','wordpress_self_hosted','wordpress_com','medium'] as PlatformId[] as p}
        <button class="text-xs px-3 py-1.5 cursor-pointer rounded"
                style="border: 1px solid var(--novelist-border); background: transparent;"
                onclick={() => startAdd(p)}>{platformLabel(p)}</button>
      {/each}
    </div>

    {#if saveError}
      <div class="text-xs mb-3" style="color: #d24a4a;">{t('settings.publish.failedToSave')}: {saveError}</div>
    {/if}
  {/if}

  {#if editing}
    <div class="modal-backdrop"
         onclick={(e) => { if (e.target === e.currentTarget) cancelEdit(); }}
         onkeydown={(e) => e.key === 'Escape' && cancelEdit()}
         role="button" tabindex="0">
      <div class="modal" role="dialog" tabindex="-1">
        <h4 class="text-sm font-semibold mb-3">{editing.isNew ? 'Add' : 'Edit'} {platformLabel(editing.channel.platform)} channel</h4>

        <div class="flex items-center justify-between mb-3 gap-2">
          <label class="text-xs w-32" for="ch-name">Name</label>
          <input id="ch-name" type="text" class="text-sm flex-1 px-2 py-1 rounded"
                 style="border: 1px solid var(--novelist-border); background: var(--novelist-bg);"
                 bind:value={editing.channel.name} />
        </div>

        {#each fieldsFor(editing.channel) as f}
          {@const shown = f.secret && revealedFields.has(f.key)}
          <div class="mb-3">
            <div class="flex items-center justify-between gap-2">
              <label class="text-xs w-32 shrink-0" for={`ch-${f.key}`}>{f.label}</label>
              <div class="flex flex-1 gap-1">
                <input id={`ch-${f.key}`}
                       type={f.secret && !shown ? 'password' : 'text'}
                       placeholder={f.placeholder ?? ''}
                       class="text-sm flex-1 px-2 py-1 rounded"
                       style="border: 1px solid var(--novelist-border); background: var(--novelist-bg);"
                       value={(editing.channel as unknown as Record<string, string>)[f.key] ?? ''}
                       oninput={(e) => {
                         const v = (e.currentTarget as HTMLInputElement).value;
                         (editing!.channel as unknown as Record<string, string>)[f.key] = v;
                       }} />
                {#if f.secret}
                  <button type="button"
                          class="reveal-btn"
                          onclick={() => toggleReveal(f.key)}
                          title={shown ? t('settings.publish.hideSecret') : t('settings.publish.showSecret')}
                          aria-label={shown ? t('settings.publish.hideSecret') : t('settings.publish.showSecret')}>
                    {#if shown}
                      <!-- eye-off -->
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>
                        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>
                        <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>
                        <line x1="2" y1="2" x2="22" y2="22"/>
                      </svg>
                    {:else}
                      <!-- eye -->
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                    {/if}
                  </button>
                {/if}
              </div>
            </div>
            {#if f.hint}
              <div class="text-[11px] mt-1" style="color: var(--novelist-text-secondary); padding-left: 8.5rem;">{f.hint}</div>
            {/if}
          </div>
        {/each}

        <div class="flex justify-end gap-2 mt-4">
          <button class="text-xs px-3 py-1.5 cursor-pointer rounded" onclick={cancelEdit}
                  style="border: 1px solid var(--novelist-border); background: transparent;">{t('settings.publish.cancel')}</button>
          <button class="text-xs px-3 py-1.5 cursor-pointer rounded" onclick={saveEdit}
                  style="border: none; background: var(--novelist-accent); color: white;">{editing.isNew ? t('settings.publish.add') : t('settings.publish.save')}</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  /* Pandoc status / override card — sits at the top of the publish
     panel so users hitting "spawn pandoc: No such file" land here. */
  .pandoc-card {
    border: 1px solid var(--novelist-border);
    border-radius: 6px;
    padding: 10px 12px;
    margin-bottom: 16px;
    background: var(--novelist-bg);
  }
  .pandoc-ok { border-left: 3px solid #2da84a; }
  .pandoc-err { border-left: 3px solid #d24a4a; background: rgba(210, 74, 74, 0.04); }
  .pandoc-row {
    display: flex; align-items: center; gap: 10px;
  }
  .pandoc-icon {
    flex-shrink: 0;
    width: 22px; height: 22px;
    border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 13px;
  }
  .pandoc-ok .pandoc-icon { color: #2da84a; background: rgba(45,168,74,0.14); }
  .pandoc-err .pandoc-icon { color: #d24a4a; background: rgba(210,74,74,0.14); }
  .pandoc-text { flex: 1; min-width: 0; }
  .pandoc-headline { font-size: 13px; font-weight: 500; }
  .pandoc-detail {
    font-size: 11px; color: var(--novelist-text-secondary);
    margin-top: 2px; word-break: break-word;
  }
  .pandoc-path-mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    margin-left: 4px;
  }
  .pandoc-override-row {
    display: flex; align-items: center; gap: 8px;
    margin-top: 10px;
  }
  .pandoc-input {
    flex: 1;
    font-size: 12px; padding: 4px 8px; border-radius: 4px;
    border: 1px solid var(--novelist-border);
    background: var(--novelist-bg); color: var(--novelist-text);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .pandoc-btn {
    flex-shrink: 0;
    font-size: 12px; padding: 4px 10px;
    border: 1px solid var(--novelist-border); background: transparent;
    color: var(--novelist-text); border-radius: 4px; cursor: pointer;
  }
  .pandoc-btn:hover { background: var(--novelist-sidebar-hover); }
  .pandoc-btn:disabled { opacity: 0.5; cursor: default; }
  .pandoc-btn-link {
    border: none; color: var(--novelist-accent); text-decoration: underline;
    background: transparent;
  }
  .pandoc-btn-link:hover { background: transparent; }

  .test-detail {
    margin: 0;
    padding: 6px 10px;
    border-top: 1px solid var(--novelist-border);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--novelist-text-secondary);
    background: color-mix(in srgb, var(--novelist-bg-secondary) 50%, transparent);
  }
  .test-detail.err {
    color: #d24a4a;
    background: rgba(210, 74, 74, 0.06);
  }

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
