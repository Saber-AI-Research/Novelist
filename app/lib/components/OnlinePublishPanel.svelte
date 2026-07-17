<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { open as shellOpen } from '@tauri-apps/plugin-shell';
  import { commands, type ChannelConfig, type PlatformConfig } from '$lib/ipc/commands';
  import { dispatchPublish, toPlatformConfig, type DialogPayload } from '$lib/services/publish';
  import { type PublishFormDraft } from '$lib/services/publish-form-persistence';
  import { createPublishDialogPersistenceController } from '$lib/services/publish-dialog-persistence-controller';
  import { registerRenameFlushProvider } from '$lib/services/rename-coordinator';
  import { registerProjectSwitchFlushProvider } from '$lib/services/project-switch-coordinator';
  import { t } from '$lib/i18n';

  interface Props {
    channel: ChannelConfig;
    doc: { dir: string; text: string; projectDir: string; filePath: string };
    onClose: () => void;
    onPublishingChange?: (publishing: boolean) => void;
  }
  let { channel, doc, onClose, onPublishingChange }: Props = $props();

  // Pre-fill title from H1 of the doc, or use empty.
  function extractH1(text: string): string {
    const m = text.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : '';
  }

  // ASCII-only kebab-case from a title; falls back to "post" for empty/CJK.
  function slugify(s: string): string {
    const cleaned = s
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
    return cleaned || 'post';
  }

  function statusOptionsFor(platform: PlatformConfig['platform']): { value: string; label: string }[] {
    switch (platform) {
      case 'ghost':
        return [
          { value: 'draft',     label: t('publish.statusOpt.draft') },
          { value: 'published', label: t('publish.statusOpt.published') },
        ];
      case 'wordpress_self_hosted':
      case 'wordpress_com':
        return [
          { value: 'draft',   label: t('publish.statusOpt.draft') },
          { value: 'pending', label: t('publish.statusOpt.pending') },
          { value: 'private', label: t('publish.statusOpt.private') },
          { value: 'publish', label: t('publish.statusOpt.publish') },
        ];
      case 'medium':
        return [
          { value: 'draft',    label: t('publish.statusOpt.draft') },
          { value: 'unlisted', label: t('publish.statusOpt.unlisted') },
          { value: 'public',   label: t('publish.statusOpt.public') },
        ];
    }
  }

  function defaultStatusFor(platform: PlatformConfig['platform']): string {
    return platform === 'medium' ? 'public' : 'draft';
  }

  function baseUrlForChannel(c: ChannelConfig): string {
    switch (c.platform) {
      case 'ghost':                 return c.admin_url;
      case 'wordpress_self_hosted': return c.site_url;
      case 'wordpress_com':         return `https://${c.site_id_or_domain}`;
      case 'medium':                return 'https://medium.com';
    }
  }

  // svelte-ignore state_referenced_locally
  let title = $state(extractH1(doc.text));
  let tagInput = $state('');
  let tags = $state<string[]>([]);
  let excerpt = $state('');
  // svelte-ignore state_referenced_locally
  let slug = $state(slugify(extractH1(doc.text)));
  // svelte-ignore state_referenced_locally
  let status = $state(defaultStatusFor(channel.platform));
  let destination = $state<string | undefined>(undefined);
  let coverFile = $state<File | null>(null);
  let coverPreviewUrl = $state<string | null>(null);

  let publishing = $state(false);
  let errorMessage = $state<string | null>(null);
  let successUrl = $state<string | null>(null);
  let corruptDraftNotice = $state(false);
  let exitPromise: Promise<boolean> | null = null;

  $effect(() => {
    onPublishingChange?.(publishing);
  });

  // Tag autocomplete: pre-fetch existing tags from the platform on mount.
  // Empty array for platforms that don't expose a tag-list API.
  let availableTags = $state<string[]>([]);
  let tagSuggestionsOpen = $state(false);
  let tagInputEl = $state<HTMLInputElement | null>(null);

  function currentFormSnapshot(): PublishFormDraft {
    return {
      title,
      tags: [...tags],
      excerpt: excerpt.trim() === '' ? undefined : excerpt,
      slug: slug.trim() === '' ? undefined : slug,
      status,
      destination,
    };
  }

  function applyPersistedForm(persisted: PublishFormDraft): void {
    title = persisted.title;
    tags = [...persisted.tags];
    excerpt = persisted.excerpt ?? '';
    slug = persisted.slug ?? slug;
    status = persisted.status ?? status;
    destination = persisted.destination ?? destination;
  }

  // svelte-ignore state_referenced_locally
  const persistenceController = createPublishDialogPersistenceController({
    identity: {
      projectDir: doc.projectDir,
      filePath: doc.filePath,
      channelId: channel.id,
    },
    readFields: currentFormSnapshot,
    applyFields: applyPersistedForm,
    onCorruptDraft: () => {
      corruptDraftNotice = true;
    },
  });

  function markUserInput(): void {
    persistenceController.handleUserInput();
  }

  $effect(() => {
    void title;
    void tags;
    void excerpt;
    void slug;
    void status;
    void destination;
    persistenceController.handleFieldChange();
  });

  /**
   * Tags shown in the dropdown. With no query, show every available
   * tag the user hasn't already added (so the dropdown serves as a
   * "browse" UI). When typing, filter case-insensitively. Cap at 60
   * to keep the dropdown bounded for users with long tag taxonomies.
   */
  // svelte-ignore state_referenced_locally
  let tagSuggestions = $derived.by(() => {
    const q = tagInput.trim().toLowerCase();
    const filtered = availableTags.filter(t => !tags.includes(t));
    const matched = q ? filtered.filter(t => t.toLowerCase().includes(q)) : filtered;
    return matched.slice(0, 60);
  });

  onMount(() => {
    const unregisterRenameFlush = registerRenameFlushProvider((oldPath) =>
      persistenceController.handleRenameFlush(oldPath),
    );
    const unregisterProjectSwitchFlush = registerProjectSwitchFlushProvider(async (_previous, next) => {
      await persistenceController.handleProjectSwitch(next);
      if (persistenceController.isRetired) onClose();
    });
    (async () => {
      const r = await commands.listPublishTags(toPlatformConfig(channel));
      if (r.status === 'ok') availableTags = r.data;
    })().catch((err) => {
      console.warn(
        '[publish] tag autocomplete fetch rejected:',
        err instanceof Error ? err.message : err,
      );
    });
    persistenceController.loadInitialDraft().catch((err) => {
      console.warn(
        '[publish] initial draft restore rejected:',
        err instanceof Error ? err.message : err,
      );
    });
    return () => {
      unregisterRenameFlush();
      unregisterProjectSwitchFlush();
    };
  });

  onDestroy(() => {
    if (coverPreviewUrl) {
      URL.revokeObjectURL(coverPreviewUrl);
      coverPreviewUrl = null;
    }
    persistenceController.handleDestroy().catch((err) => {
      console.warn('[publish] destroy flush rejected:', err instanceof Error ? err.message : err);
    });
  });

  function selectSuggestion(name: string) {
    if (!tags.includes(name)) {
      tags = [...tags, name];
      markUserInput();
    }
    tagInput = '';
    // Keep dropdown open after selection — user often wants to add several.
    // It will close when they click outside or press Escape.
    tagInputEl?.focus();
  }

  function toggleSuggestionsDropdown() {
    tagSuggestionsOpen = !tagSuggestionsOpen;
    if (tagSuggestionsOpen) tagInputEl?.focus();
  }

  /**
   * Stable hash of a tag string into one of N color slots — keeps a
   * given tag the same color across renders and matches mweb / Notion
   * style where each tag has its own consistent hue.
   */
  function hashColorIndex(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 6;
  }

  function addTagFromInput() {
    const v = tagInput.trim();
    if (v && !tags.includes(v)) {
      tags = [...tags, v];
      markUserInput();
    }
    tagInput = '';
  }
  function removeTag(t: string) {
    tags = tags.filter(x => x !== t);
    markUserInput();
  }

  function onTagKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTagFromInput();
    } else if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
      tags = tags.slice(0, -1);
      markUserInput();
    }
  }

  async function pickCover() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) setCover(f);
    });
    input.click();
  }

  function setCover(f: File) {
    coverFile = f;
    if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
    coverPreviewUrl = URL.createObjectURL(f);
  }

  function clearCover() {
    coverFile = null;
    if (coverPreviewUrl) URL.revokeObjectURL(coverPreviewUrl);
    coverPreviewUrl = null;
  }

  function onCoverDrop(e: DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f && f.type.startsWith('image/')) setCover(f);
  }

  /** Read an image from the system clipboard via the Rust-side
   *  `arboard` API exposed as a Tauri command. Going through Rust
   *  bypasses the WebKit/macOS "Paste" permission prompt that
   *  `navigator.clipboard.read()` triggers — one-click instead of two. */
  async function pasteCoverFromClipboard() {
    errorMessage = null;
    const r = await commands.readClipboardImage();
    if (r.status !== 'ok') {
      // Distinguish "no image on clipboard" from a hard failure.
      const msg = r.error.toLowerCase();
      if (msg.includes('no image')) {
        errorMessage = t('publish.pasteNoImage');
      } else {
        errorMessage = `${t('publish.pasteFailed')}: ${r.error}`;
      }
      return;
    }
    const blob = new Blob([new Uint8Array(r.data.bytes)], { type: r.data.mime });
    const ext = r.data.mime.split('/')[1] || 'png';
    const file = new File([blob], `clipboard.${ext}`, { type: r.data.mime });
    setCover(file);
  }

  async function doPublish() {
    if (!title.trim()) {
      errorMessage = t('publish.titleRequired');
      return;
    }
    publishing = true;
    errorMessage = null;
    successUrl = null;

    try {
      await persistenceController.handleBeforePublish();
      const payload: DialogPayload = {
        title: title.trim(),
        tags,
        slug: slug.trim() || undefined,
        excerpt: excerpt.trim() || undefined,
        status,
        publicationId: destination,
      };
      if (coverFile) {
        const buf = await coverFile.arrayBuffer();
        payload.coverImage = {
          bytes: new Uint8Array(buf),
          filename: coverFile.name,
          mime: coverFile.type || 'image/png',
        };
      }
      const result = await dispatchPublish(channel, payload, doc);
      successUrl = result.url;
      await persistenceController.handleAfterPublishSuccess();
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
    } finally {
      publishing = false;
    }
  }

  function persistBeforeExit(): Promise<boolean> {
    if (exitPromise) return exitPromise;
    exitPromise = (async () => {
      try {
        await persistenceController.handleClose();
        return true;
      } catch (err) {
        errorMessage = `${t('publish.draftPersistFailed')}: ${
          err instanceof Error ? err.message : String(err)
        }`;
        return false;
      } finally {
        exitPromise = null;
      }
    })();
    return exitPromise;
  }

  async function handleClose() {
    if (await persistBeforeExit()) onClose();
  }

  function safeHandleClose(): void {
    handleClose().catch((err) => {
      errorMessage = `${t('publish.draftPersistFailed')}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    });
  }

  export function requestClose(): void {
    if (!publishing) safeHandleClose();
  }

  export async function prepareForModeSwitch(): Promise<boolean> {
    if (publishing) return false;
    return persistBeforeExit();
  }

  async function openInBrowser() {
    // `window.open` no-ops inside the Tauri WKWebView. Route through the
    // shell plugin so the system browser handles the URL.
    if (!successUrl) return;
    try {
      await shellOpen(successUrl);
    } catch (e) {
      console.error('[publish] shell.open failed:', e);
      errorMessage = e instanceof Error ? e.message : String(e);
    }
  }
</script>

<div class="online-panel">
    <div class="header">
      <div class="header-name">{channel.name}</div>
      <div class="header-url">{baseUrlForChannel(channel)}</div>
    </div>

    {#if successUrl}
      <div class="success-banner">
        <span>{t('publish.success')}</span>
        <button class="link-btn" onclick={openInBrowser}>{t('publish.openInBrowser')}</button>
        <button class="close-btn" onclick={safeHandleClose}>{t('publish.close')}</button>
      </div>
    {:else}
      <div class="form">
        <label for="pub-title" class="lbl">{t('publish.title')} <span class="req">*</span></label>
        <input id="pub-title" type="text" class="inp" bind:value={title} oninput={markUserInput} />

        <div class="row">
          <div class="col">
            <span class="lbl">{t('publish.coverImage')}</span>
            <div
              class="cover-drop"
              role="button"
              tabindex="0"
              ondragover={(e) => e.preventDefault()}
              ondrop={onCoverDrop}
              onclick={pickCover}
              onkeydown={(e) => { if (e.key === 'Enter') pickCover(); }}
            >
              {#if coverPreviewUrl}
                <img src={coverPreviewUrl} alt="cover preview" />
              {:else}
                <div class="cover-placeholder">{t('publish.coverPlaceholder')}</div>
              {/if}
            </div>
            <div class="cover-actions">
              <button class="small-btn" onclick={pickCover}>{t('publish.choose')}</button>
              <button class="small-btn" onclick={pasteCoverFromClipboard}>{t('publish.pasteFromClipboard')}</button>
              {#if coverFile}<button class="small-btn" onclick={clearCover}>{t('publish.remove')}</button>{/if}
            </div>
          </div>

          <div class="col">
            <label for="pub-tags" class="lbl">{t('publish.tags')}</label>
            <div class="tag-input-wrap">
              <div class="tag-row">
                {#each tags as tag}
                  <span class="tag-pill tag-pill-selected">
                    {tag}
                    <button type="button" class="pill-x" onclick={() => removeTag(tag)} aria-label="remove tag">×</button>
                  </span>
                {/each}
                <input
                  id="pub-tags"
                  type="text"
                  class="tag-inp"
                  bind:this={tagInputEl}
                  bind:value={tagInput}
                  oninput={() => { tagSuggestionsOpen = true; }}
                  onfocus={() => { tagSuggestionsOpen = true; }}
                  onkeydown={onTagKeydown}
                  onblur={() => {
                    // Delay so a click on a suggestion fires before the dropdown closes.
                    setTimeout(() => { tagSuggestionsOpen = false; addTagFromInput(); }, 150);
                  }}
                  placeholder={tags.length === 0 ? t('publish.tagsPlaceholder') : ''}
                />
                {#if availableTags.length > 0}
                  <button
                    type="button"
                    class="tag-dropdown-toggle"
                    onmousedown={(e) => { e.preventDefault(); toggleSuggestionsDropdown(); }}
                    aria-label={t('publish.tagsDropdownToggle')}
                    title={t('publish.tagsDropdownToggle')}
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  </button>
                {/if}
              </div>
              {#if tagSuggestionsOpen && availableTags.length > 0}
                <div class="tag-suggestions">
                  {#if tagSuggestions.length > 0}
                    <div class="tag-suggestions-header">{t('publish.tagsAvailable')} ({tagSuggestions.length}{availableTags.length - tags.length > 60 ? `/${availableTags.length - tags.length}` : ''})</div>
                    <div class="tag-pill-grid">
                      {#each tagSuggestions as s, i}
                        {@const colorIdx = hashColorIndex(s)}
                        <button
                          type="button"
                          class={`tag-pill tag-pill-available pill-c${colorIdx}`}
                          onmousedown={(e) => { e.preventDefault(); selectSuggestion(s); }}
                        >
                          {s}
                        </button>
                      {/each}
                    </div>
                  {:else}
                    <div class="tag-suggestions-empty">{t('publish.tagsNoMatch')}</div>
                  {/if}
                </div>
              {/if}
            </div>

            <label for="pub-excerpt" class="lbl">{t('publish.excerpt')}</label>
            <textarea id="pub-excerpt" class="inp" rows="3" bind:value={excerpt} oninput={markUserInput}></textarea>

            <label for="pub-slug" class="lbl">{t('publish.slug')}</label>
            <input id="pub-slug" type="text" class="inp" bind:value={slug} oninput={markUserInput} />
          </div>
        </div>

        <div class="row">
          <label for="pub-status" class="lbl status-lbl">{t('publish.status')}</label>
          <select id="pub-status" class="inp inp-select" bind:value={status} onchange={markUserInput}>
            {#each statusOptionsFor(channel.platform) as opt}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </div>

        {#if corruptDraftNotice}
          <div class="draft-notice" data-testid="publish-draft-recovered">{t('publish.draftUnreadable')}</div>
        {/if}

        {#if errorMessage}
          <div class="error-banner">{errorMessage}</div>
        {/if}

        <div class="footer">
          <button class="ghost-btn" onclick={safeHandleClose} disabled={publishing}>{t('publish.cancel')}</button>
          <button class="primary-btn" onclick={doPublish} disabled={publishing}>
            {publishing ? t('publish.publishing') : t('publish.publish')}
          </button>
        </div>
      </div>
    {/if}
</div>

<style>
  .header {
    border-bottom: 1px solid var(--novelist-border);
    padding-bottom: 8px; margin-bottom: 12px;
  }
  .header-name { font-weight: 600; font-size: 14px; }
  .header-url { font-size: 12px; color: var(--novelist-text-secondary); }

  .form { display: flex; flex-direction: column; gap: 8px; }
  .lbl { font-size: 12px; color: var(--novelist-text-secondary); margin-top: 6px; display: block; }
  .req { color: #d24a4a; }
  .inp {
    width: 100%; padding: 6px 8px; border-radius: 4px;
    border: 1px solid var(--novelist-border); background: var(--novelist-bg);
    color: var(--novelist-text); font-size: 14px;
  }
  .inp-select { width: auto; padding-right: 24px; }
  /* Disable the resize handle on the excerpt textarea — keeping the
     dialog layout stable matters more than letting users resize. */
  textarea.inp { resize: none; }
  .row { display: flex; gap: 16px; align-items: flex-start; }
  .col { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .status-lbl { margin-top: 0; align-self: center; }

  .cover-drop {
    border: 1px dashed var(--novelist-border);
    border-radius: 4px;
    height: 140px;
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
    cursor: pointer;
  }
  .cover-drop img { max-width: 100%; max-height: 100%; }
  .cover-placeholder { font-size: 12px; color: var(--novelist-text-secondary); padding: 0 8px; text-align: center; }
  .cover-actions { display: flex; gap: 6px; margin-top: 6px; }
  .small-btn {
    font-size: 11px; padding: 3px 8px;
    border: 1px solid var(--novelist-border); background: transparent; border-radius: 3px;
    cursor: pointer;
  }

  /* Tag input + dropdown — pill-styled chips arranged in a wrapping
     grid. Inspired by mweb / Notion-style multi-select pickers. */
  .tag-input-wrap { position: relative; }
  .tag-row {
    display: flex; flex-wrap: wrap; gap: 6px;
    border: 1px solid var(--novelist-border); border-radius: 6px;
    padding: 6px 8px; min-height: 36px; align-items: center;
    background: var(--novelist-bg);
  }
  .tag-inp {
    flex: 1; min-width: 100px;
    border: none; outline: none; background: transparent;
    font-size: 13px; color: var(--novelist-text);
    padding: 2px 0;
  }
  .tag-dropdown-toggle {
    flex-shrink: 0;
    width: 22px; height: 22px;
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent; border: none; border-radius: 4px;
    color: var(--novelist-text-secondary); cursor: pointer;
  }
  .tag-dropdown-toggle:hover {
    background: var(--novelist-sidebar-hover);
    color: var(--novelist-text);
  }

  /* Pill — base style for both selected chips (in the input row) and
     available chips (in the dropdown). Use a light-tinted background
     with same-hue text, mweb / Notion-style. */
  .tag-pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 12px;
    line-height: 1.3;
    border: none;
    cursor: pointer;
    white-space: nowrap;
    transition: filter 100ms;
  }
  .tag-pill:hover { filter: brightness(0.95); }

  .pill-x {
    background: none; border: none; cursor: pointer;
    font-size: 13px; line-height: 1; padding: 0;
    margin-left: 2px; opacity: 0.55;
    color: inherit;
  }
  .pill-x:hover { opacity: 1; }

  /* Selected chips use the accent color so they read clearly against
     the input row. */
  .tag-pill-selected {
    background: color-mix(in srgb, var(--novelist-accent) 18%, transparent);
    color: var(--novelist-accent);
    font-weight: 500;
  }

  /* Available chips in the dropdown get one of six stable colors
     hashed from the tag name, so a given tag is always the same hue. */
  .tag-pill-available { font-weight: 500; }
  .pill-c0 { background: rgba(245, 158,  11, 0.18); color: #b45309; }
  .pill-c1 { background: rgba(124,  58, 237, 0.18); color: #6d28d9; }
  .pill-c2 { background: rgba( 14, 165, 233, 0.18); color: #0369a1; }
  .pill-c3 { background: rgba( 22, 163,  74, 0.18); color: #15803d; }
  .pill-c4 { background: rgba(225,  29,  72, 0.18); color: #be123c; }
  .pill-c5 { background: rgba(168,  85, 247, 0.18); color: #7e22ce; }
  /* Dark-mode adjustment: lift text brightness so colored pills don't
     muddy against a dark background. */
  @media (prefers-color-scheme: dark) {
    .pill-c0 { color: #fbbf24; }
    .pill-c1 { color: #a78bfa; }
    .pill-c2 { color: #38bdf8; }
    .pill-c3 { color: #4ade80; }
    .pill-c4 { color: #fb7185; }
    .pill-c5 { color: #c084fc; }
  }

  /* Dropdown panel — a card with a small header and a wrapping grid
     of pills. Multiple per row, scrolls vertically when long. */
  .tag-suggestions {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 6px;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.14);
    max-height: 240px;
    overflow-y: auto;
    z-index: 10;
    padding: 8px 10px;
  }
  .tag-suggestions-header {
    font-size: 10px;
    color: var(--novelist-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 6px;
  }
  .tag-suggestions-empty {
    font-size: 12px;
    color: var(--novelist-text-secondary);
    padding: 4px 0;
  }
  .tag-pill-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .error-banner {
    background: rgba(210, 74, 74, 0.12);
    border-left: 3px solid #d24a4a;
    padding: 6px 10px;
    font-size: 12px;
    color: #d24a4a;
    margin-top: 8px;
    border-radius: 0 3px 3px 0;
  }

  .draft-notice {
    background: rgba(217, 149, 26, 0.12);
    border-left: 3px solid #d9951a;
    padding: 6px 10px;
    font-size: 12px;
    color: var(--novelist-text-secondary);
    margin-top: 8px;
    border-radius: 0 3px 3px 0;
  }

  .success-banner {
    display: flex; gap: 12px; align-items: center;
    background: rgba(45, 168, 74, 0.12);
    border-left: 3px solid #2da84a;
    padding: 8px 12px;
    border-radius: 0 3px 3px 0;
    font-size: 14px;
  }

  .footer {
    display: flex; justify-content: flex-end; gap: 8px;
    margin-top: 12px; padding-top: 8px;
    border-top: 1px solid var(--novelist-border);
  }
  .ghost-btn {
    padding: 6px 14px; font-size: 14px;
    border: 1px solid var(--novelist-border); background: transparent;
    border-radius: 4px; cursor: pointer;
  }
  .primary-btn {
    padding: 6px 14px; font-size: 14px;
    border: none; background: var(--novelist-accent); color: white;
    border-radius: 4px; cursor: pointer;
  }
  .primary-btn:disabled, .ghost-btn:disabled { opacity: 0.5; cursor: default; }
  .link-btn { background: none; border: none; color: var(--novelist-accent); cursor: pointer; padding: 0; font-size: 14px; text-decoration: underline; }
  .close-btn { background: none; border: 1px solid var(--novelist-border); border-radius: 3px; padding: 2px 8px; font-size: 12px; cursor: pointer; margin-left: auto; }
</style>
