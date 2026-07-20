<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { open as shellOpen } from '@tauri-apps/plugin-shell';
  import {
    commands,
    type ChannelConfig,
    type PlatformConfig,
    type ProviderRevision,
    type PublishCoverAsset,
    type PublishResult,
    type RemoteIdentity,
  } from '$lib/ipc/commands';
  import {
    bindLegacyPublication,
    dispatchPublish,
    persistPublishResult,
    PublishCommandError,
    PublishIdentityPersistenceError,
    readPublishRemoteState,
    toPlatformConfig,
    type DialogPayload,
  } from '$lib/services/publish';
  import {
    beginPublishRemoteRead,
    failPublishRemoteRead,
    isPublishRemoteStateUnknown,
    planPublishAttempt,
    type PublishFailure,
    type PublishIntent,
    type PublishRemoteState,
  } from '$lib/services/publish-lifecycle';
  import {
    createCoverObjectUrlOwner,
    findClipboardImage,
    readCoverFile,
    shouldUploadPublishCover,
    type CoverBytesInput,
  } from '$lib/services/publish-cover';
  import { type PublishFormDraft } from '$lib/services/publish-form-persistence';
  import { createPublishDialogPersistenceController } from '$lib/services/publish-dialog-persistence-controller';
  import { registerRenameFlushProvider } from '$lib/services/rename-coordinator';
  import { registerProjectSwitchFlushProvider } from '$lib/services/project-switch-coordinator';
  import { pathStartsWithChild } from '$lib/utils/path';
  import { isOpenablePublishUrl } from '$lib/utils/publish-url';
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
  let coverAsset = $state<PublishCoverAsset | null>(null);
  let coverPreviewUrl = $state<string | null>(null);
  let coverChangedForAttempt = false;
  const coverUrlOwner = createCoverObjectUrlOwner();
  let coverMutationTail: Promise<void> = Promise.resolve();
  let coverMutationFailure: string | null = null;
  let coverGeneration = 0;
  let destroyed = false;
  let skipDestroyFlush = false;

  let publishing = $state(false);
  let binding = $state(false);
  let errorMessage = $state<string | null>(null);
  let openRemoteError = $state<string | null>(null);
  let successUrl = $state<string | null>(null);
  let remoteState = $state<PublishRemoteState>({ kind: 'unknown', phase: 'loading' });
  let lifecycleState = $state<'unknown' | 'new' | 'updating' | 'updated' | 'conflict' | 'not_found' | 'unsupported' | 'corrupt'>('unknown');
  let publishFailure = $state<PublishFailure | null>(null);
  let bindOpen = $state(false);
  let bindValue = $state('');
  let bindError = $state<string | null>(null);
  let confirmation = $state<{
    kind: 'overwrite' | 'new_copy';
    revision?: ProviderRevision;
  } | null>(null);
  let corruptDraftNotice = $state(false);
  let exitLocked = $state(false);
  let exitPromise: Promise<boolean> | null = null;
  let remoteReadOwner = '';
  let remoteReadGeneration = 0;
  let availableTagsRequest = '';
  let pendingPublishResult = $state<PublishResult | null>(null);

  let displayRemoteIdentity = $derived.by((): RemoteIdentity | null | undefined => {
    if (!isPublishRemoteStateUnknown(remoteState)) return remoteState;
    return remoteState.previous?.remote;
  });

  $effect(() => {
    onPublishingChange?.(publishing || binding);
  });

  function lifecycleLabel(): string {
    if (lifecycleState === 'unknown' && isPublishRemoteStateUnknown(remoteState)) {
      return t(remoteState.phase === 'loading' ? 'publish.state.checking' : 'publish.state.unknown');
    }
    return t(`publish.state.${lifecycleState}`);
  }

  function applyRemoteState(remote: RemoteIdentity | null): void {
    remoteState = remote;
    publishFailure = null;
    confirmation = null;
    if (!remote) {
      lifecycleState = 'new';
      return;
    }
    const plan = planPublishAttempt(channel.platform, remote, { kind: 'default' });
    lifecycleState = plan.state === 'updating' ? 'updating' : plan.state;
  }

  function currentRemoteOwner(): string {
    return JSON.stringify([doc.projectDir, doc.filePath, channel.id]);
  }

  function remoteReadIsCurrent(owner: string, generation: number): boolean {
    return !destroyed
      && owner === remoteReadOwner
      && owner === currentRemoteOwner()
      && generation === remoteReadGeneration;
  }

  async function loadAvailableTags(owner: string, generation: number): Promise<void> {
    const request = `${owner}:${generation}`;
    if (availableTagsRequest === request) return;
    availableTagsRequest = request;
    try {
      const result = await commands.listPublishTags(toPlatformConfig(channel));
      if (
        !remoteReadIsCurrent(owner, generation)
        || exitLocked
        || isPublishRemoteStateUnknown(remoteState)
      ) return;
      if (result.status === 'ok') availableTags = result.data;
    } catch {
      if (availableTagsRequest === request) availableTagsRequest = '';
    }
  }

  async function refreshRemoteState(owner = currentRemoteOwner()): Promise<void> {
    const sameOwner = owner === remoteReadOwner;
    const generation = ++remoteReadGeneration;
    remoteReadOwner = owner;
    if (!sameOwner) {
      availableTags = [];
      availableTagsRequest = '';
    }
    remoteState = beginPublishRemoteRead(remoteState, sameOwner);
    lifecycleState = 'unknown';
    publishFailure = null;
    confirmation = null;
    try {
      const remote = await readPublishRemoteState({
        projectDir: doc.projectDir,
        filePath: doc.filePath,
        channelId: channel.id,
      });
      if (!remoteReadIsCurrent(owner, generation) || exitLocked) return;
      applyRemoteState(remote);
      void loadAvailableTags(owner, generation);
    } catch {
      if (!remoteReadIsCurrent(owner, generation)) return;
      remoteState = failPublishRemoteRead(remoteState);
      lifecycleState = 'unknown';
    }
  }

  function operationLocked(): boolean {
    return publishing || binding || exitLocked || isPublishRemoteStateUnknown(remoteState);
  }

  function exitOperationLocked(): boolean {
    return publishing || binding || exitLocked || pendingPublishResult !== null;
  }

  function retryRemoteStateLocked(): boolean {
    return publishing
      || binding
      || exitLocked
      || !isPublishRemoteStateUnknown(remoteState)
      || remoteState.phase === 'loading';
  }

  async function retryRemoteState(): Promise<void> {
    const pending = pendingPublishResult;
    if (!pending) {
      await refreshRemoteState();
      return;
    }
    if (retryRemoteStateLocked()) return;

    const owner = currentRemoteOwner();
    const generation = ++remoteReadGeneration;
    const sameOwner = owner === remoteReadOwner;
    remoteReadOwner = owner;
    remoteState = beginPublishRemoteRead(remoteState, sameOwner);
    lifecycleState = 'unknown';
    try {
      const remote = await persistPublishResult({
        projectDir: doc.projectDir,
        filePath: doc.filePath,
        channelId: channel.id,
        result: pending,
      });
      if (!remoteReadIsCurrent(owner, generation)) return;
      pendingPublishResult = null;
      successUrl = pending.url;
      applyRemoteState(remote);
      lifecycleState = 'updated';
      publishFailure = null;
      try {
        await persistenceController.handleAfterPublishSuccess();
      } catch (error) {
        errorMessage = `${t('publish.draftPersistFailed')}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    } catch {
      if (!remoteReadIsCurrent(owner, generation)) return;
      remoteState = failPublishRemoteRead(remoteState);
      lifecycleState = 'unknown';
    }
  }

  // Tag autocomplete loads only after remote identity is confirmed.
  // Empty array for platforms that don't expose a tag-list API.
  let availableTags = $state<string[]>([]);
  let tagSuggestionsOpen = $state(false);
  let tagInputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    const owner = currentRemoteOwner();
    if (owner !== remoteReadOwner) void refreshRemoteState(owner);
  });

  function currentFormSnapshot(): PublishFormDraft {
    return {
      title,
      tags: [...tags],
      excerpt: excerpt.trim() === '' ? undefined : excerpt,
      slug,
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
    if (!isPublishRemoteStateUnknown(remoteState)) {
      persistenceController.handleFieldChange();
    }
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
    const unregisterRenameFlush = registerRenameFlushProvider(async (oldPath) => {
      if (doc.filePath !== oldPath && !pathStartsWithChild(doc.filePath, oldPath)) return;
      if (publishing || binding || pendingPublishResult) {
        throw new Error(t('publish.remoteStateUnavailable'));
      }
      exitLocked = true;
      try {
        await coverMutationTail;
        if (coverMutationFailure) throw new Error(coverMutationFailure);
        if (pendingPublishResult) throw new Error(t('publish.remoteStateUnavailable'));
        if (isPublishRemoteStateUnknown(remoteState)) {
          skipDestroyFlush = true;
          onClose();
          return;
        }
        await persistenceController.handleRenameFlush(oldPath);
        skipDestroyFlush = true;
        onClose();
      } catch (error) {
        exitLocked = false;
        throw error;
      }
    });
    const unregisterProjectSwitchFlush = registerProjectSwitchFlushProvider(async (previous, next) => {
      if (previous === next) return;
      if (publishing || binding || pendingPublishResult) {
        throw new Error(t('publish.remoteStateUnavailable'));
      }
      if (next === doc.projectDir) return;
      exitLocked = true;
      try {
        await coverMutationTail;
        if (coverMutationFailure) throw new Error(coverMutationFailure);
        if (pendingPublishResult) throw new Error(t('publish.remoteStateUnavailable'));
        if (isPublishRemoteStateUnknown(remoteState)) {
          skipDestroyFlush = true;
          onClose();
          return;
        }
        await persistenceController.handleProjectSwitch(next);
        if (persistenceController.isRetired) onClose();
      } catch (error) {
        exitLocked = false;
        throw error;
      }
    });
    persistenceController.loadInitialDraft().catch((err) => {
      console.warn(
        '[publish] initial draft restore rejected:',
        err instanceof Error ? err.message : err,
      );
    });
    enqueueCoverMutation(restoreCover, true).catch((err) => {
      console.warn(
        '[publish] cover restore rejected:',
        err instanceof Error ? err.message : err,
      );
    });
    return () => {
      unregisterRenameFlush();
      unregisterProjectSwitchFlush();
    };
  });

  onDestroy(() => {
    destroyed = true;
    coverGeneration += 1;
    coverUrlOwner.clear();
    coverPreviewUrl = null;
    if (!skipDestroyFlush && !isPublishRemoteStateUnknown(remoteState)) {
      persistenceController.handleDestroy().catch((err) => {
        console.warn('[publish] destroy flush rejected:', err instanceof Error ? err.message : err);
      });
    }
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

  function coverError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function coverActionsLocked(): boolean {
    return operationLocked() || destroyed;
  }

  function recordCoverMutationFailure(error: unknown): void {
    if (destroyed) return;
    const message = coverError(error);
    coverMutationFailure = message;
    errorMessage = message;
  }

  function applyCoverAsset(asset: PublishCoverAsset): void {
    const blob = new Blob([new Uint8Array(asset.bytes)], { type: asset.mime });
    const nextUrl = coverUrlOwner.replace(blob);
    coverAsset = asset;
    coverPreviewUrl = nextUrl;
  }

  function enqueueCoverMutation(
    operation: () => Promise<void>,
    allowBeforeRemoteReady = false,
  ): Promise<void> {
    if (
      destroyed
      || publishing
      || binding
      || exitLocked
      || (!allowBeforeRemoteReady && isPublishRemoteStateUnknown(remoteState))
    ) return Promise.resolve();
    coverGeneration += 1;
    const run = coverMutationTail.then(operation, operation);
    coverMutationTail = run.catch(() => {});
    return run;
  }

  async function restoreCover(): Promise<void> {
    try {
      const restoreGeneration = coverGeneration;
      const result = await commands.loadPublishCover(doc.projectDir, doc.filePath, channel.id);
      if (destroyed || restoreGeneration !== coverGeneration) return;
      if (result.status !== 'ok') throw new Error(result.error);
      if (result.data) {
        applyCoverAsset(result.data);
        coverChangedForAttempt = false;
      }
      coverMutationFailure = null;
    } catch (error) {
      recordCoverMutationFailure(error);
    }
  }

  async function persistCoverUnqueued(source: File | CoverBytesInput): Promise<void> {
    try {
      const input = source instanceof File ? await readCoverFile(source) : source;
      const result = await commands.storePublishCover(
        doc.projectDir,
        doc.filePath,
        channel.id,
        Array.from(input.bytes),
        input.declaredMime,
      );
      if (result.status !== 'ok') throw new Error(result.error);
      if (destroyed) return;
      applyCoverAsset(result.data);
      coverChangedForAttempt = true;
      coverMutationFailure = null;
      errorMessage = null;
    } catch (error) {
      recordCoverMutationFailure(error);
    }
  }

  async function ingestCover(source: File | CoverBytesInput): Promise<void> {
    await enqueueCoverMutation(() => persistCoverUnqueued(source));
  }

  async function pickCover() {
    if (coverActionsLocked()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) void ingestCover(f);
    });
    input.click();
  }

  async function clearCover() {
    await enqueueCoverMutation(async () => {
      const result = await commands.clearPublishCover(doc.projectDir, doc.filePath, channel.id);
      if (result.status !== 'ok') {
        recordCoverMutationFailure(result.error);
        return;
      }
      if (destroyed) return;
      coverAsset = null;
      coverChangedForAttempt = true;
      coverPreviewUrl = null;
      coverUrlOwner.clear();
      coverMutationFailure = null;
      errorMessage = null;
    });
  }

  function onCoverDrop(e: DragEvent) {
    e.preventDefault();
    if (coverActionsLocked()) return;
    const f = e.dataTransfer?.files?.[0];
    if (f) void ingestCover(f);
  }

  /** Read an image from the system clipboard via the Rust-side
   *  `arboard` API exposed as a Tauri command. Going through Rust
   *  bypasses the WebKit/macOS "Paste" permission prompt that
   *  `navigator.clipboard.read()` triggers — one-click instead of two. */
  async function pasteCoverFromClipboard() {
    if (coverActionsLocked()) return;
    errorMessage = null;
    await enqueueCoverMutation(async () => {
      const r = await commands.readClipboardImage();
      if (r.status !== 'ok') {
        // Distinguish "no image on clipboard" from a hard failure.
        const msg = r.error.toLowerCase();
        if (msg.includes('no image')) {
          recordCoverMutationFailure(t('publish.pasteNoImage'));
        } else {
          recordCoverMutationFailure(`${t('publish.pasteFailed')}: ${r.error}`);
        }
        return;
      }
      await persistCoverUnqueued({
        bytes: new Uint8Array(r.data.bytes),
        declaredMime: r.data.mime,
      });
    });
  }

  function onCoverPaste(event: ClipboardEvent): void {
    if (coverActionsLocked()) return;
    const directImage = findClipboardImage(event.clipboardData);
    event.preventDefault();
    if (directImage) {
      void ingestCover(directImage);
      return;
    }
    void pasteCoverFromClipboard();
  }

  function applyPublishFailure(failure: PublishFailure): void {
    publishFailure = failure;
    confirmation = null;
    if (failure.state === 'error') {
      errorMessage = failure.message;
      return;
    }
    lifecycleState = failure.state;
    errorMessage = null;
  }

  function requestNewCopy(): void {
    if (operationLocked()) return;
    confirmation = { kind: 'new_copy' };
  }

  function requestOverwrite(): void {
    if (operationLocked() || publishFailure?.state !== 'conflict') return;
    confirmation = {
      kind: 'overwrite',
      revision: publishFailure.actualRevision,
    };
  }

  async function confirmRecoveryAction(): Promise<void> {
    const pending = confirmation;
    if (!pending || operationLocked()) return;
    confirmation = null;
    if (pending.kind === 'new_copy') {
      await doPublish({ kind: 'new_copy', confirmed: true });
      return;
    }
    await doPublish({
      kind: 'overwrite',
      confirmed: true,
      revision: pending.revision,
    });
  }

  function showBind(): void {
    if (operationLocked() || channel.platform === 'medium') return;
    bindValue = displayRemoteIdentity?.post_id ?? '';
    bindOpen = true;
    bindError = null;
    confirmation = null;
    errorMessage = null;
  }

  async function confirmBind(): Promise<void> {
    const candidate = bindValue.trim();
    if (!candidate || operationLocked() || channel.platform === 'medium') return;
    binding = true;
    bindError = null;
    errorMessage = null;
    try {
      await coverMutationTail;
      if (coverMutationFailure) throw new Error(coverMutationFailure);
      await persistenceController.handleBeforePublish();
      await bindLegacyPublication({
        projectDir: doc.projectDir,
        filePath: doc.filePath,
        channelId: channel.id,
        urlOrId: candidate,
      });
      successUrl = null;
      openRemoteError = null;
      bindOpen = false;
      bindError = null;
      await refreshRemoteState();
    } catch {
      bindError = t('publish.bindFailed');
    } finally {
      binding = false;
    }
  }

  async function doPublish(intent: PublishIntent = { kind: 'default' }) {
    if (operationLocked()) return;
    if (isPublishRemoteStateUnknown(remoteState)) {
      lifecycleState = 'unknown';
      return;
    }
    const remoteForAttempt = remoteState;
    const plan = planPublishAttempt(channel.platform, remoteForAttempt, intent);
    if (plan.request === 'blocked') {
      if (plan.state === 'unsupported') applyPublishFailure({ state: 'unsupported' });
      else if (plan.state === 'conflict') {
        applyPublishFailure({ state: 'conflict', remoteId: displayRemoteIdentity?.post_id ?? '' });
      } else applyPublishFailure({ state: 'corrupt' });
      return;
    }
    if (!title.trim()) {
      errorMessage = t('publish.titleRequired');
      return;
    }
    publishing = true;
    errorMessage = null;
    successUrl = null;

    try {
      await coverMutationTail;
      if (coverMutationFailure) {
        throw new Error(coverMutationFailure);
      }
      await persistenceController.handleBeforePublish();
      const payload: DialogPayload = {
        title: title.trim(),
        tags,
        slug: slug.trim() || undefined,
        excerpt: excerpt.trim() || undefined,
        status,
        publicationId: destination,
      };
      if (
        coverAsset
        && channel.platform !== 'medium'
        && shouldUploadPublishCover(plan.request, coverChangedForAttempt)
      ) {
        payload.coverImage = {
          bytes: new Uint8Array(coverAsset.bytes),
          filename: coverAsset.filename,
          mime: coverAsset.mime,
        };
      }
      const result = await dispatchPublish(channel, payload, doc, {
        remote: remoteForAttempt,
        intent,
      });
      coverChangedForAttempt = false;
      if (!result.remoteIdentity) {
        pendingPublishResult = result;
        remoteState = failPublishRemoteRead(remoteState);
        lifecycleState = 'unknown';
        return;
      }
      successUrl = result.url;
      applyRemoteState(result.remoteIdentity);
      lifecycleState = 'updated';
      publishFailure = null;
      await persistenceController.handleAfterPublishSuccess();
    } catch (e) {
      if (e instanceof PublishIdentityPersistenceError) {
        pendingPublishResult = e.result;
        remoteState = failPublishRemoteRead(remoteState);
        lifecycleState = 'unknown';
        publishFailure = null;
        errorMessage = null;
      } else if (e instanceof PublishCommandError) applyPublishFailure(e.failure);
      else errorMessage = e instanceof Error ? e.message : t('publish.failed');
    } finally {
      publishing = false;
    }
  }

  function persistBeforeExit(): Promise<boolean> {
    if (exitPromise) return exitPromise;
    exitLocked = true;
    const operation = (async () => {
      try {
        await coverMutationTail;
        if (isPublishRemoteStateUnknown(remoteState)) {
          skipDestroyFlush = true;
          return true;
        }
        await persistenceController.handleClose();
        return true;
      } catch (err) {
        exitLocked = false;
        errorMessage = `${t('publish.draftPersistFailed')}: ${
          err instanceof Error ? err.message : String(err)
        }`;
        return false;
      }
    })();
    exitPromise = operation;
    void operation.finally(() => {
      if (exitPromise === operation) exitPromise = null;
    });
    return operation;
  }

  async function handleClose() {
    if (await persistBeforeExit()) onClose();
  }

  function safeHandleClose(): void {
    if (exitOperationLocked()) return;
    handleClose().catch((err) => {
      errorMessage = `${t('publish.draftPersistFailed')}: ${
        err instanceof Error ? err.message : String(err)
      }`;
    });
  }

  export function requestClose(): void {
    if (!exitOperationLocked()) safeHandleClose();
  }

  export async function prepareForModeSwitch(): Promise<boolean> {
    if (exitOperationLocked()) return false;
    return persistBeforeExit();
  }

  async function openInBrowser() {
    // `window.open` no-ops inside the Tauri WKWebView. Route through the
    // shell plugin so the system browser handles the URL.
    const target = successUrl ?? displayRemoteIdentity?.url;
    if (!target) return;
    const allowHttp = channel.platform === 'ghost'
      || channel.platform === 'wordpress_self_hosted';
    if (!isOpenablePublishUrl(target, { allowHttp })) {
      openRemoteError = t('publish.openRemoteInvalid');
      return;
    }
    openRemoteError = null;
    try {
      await shellOpen(target);
    } catch {
      console.error('[publish] shell.open failed');
      openRemoteError = t('publish.openRemoteFailed');
    }
  }
</script>

<div class="online-panel">
    <div class="header">
      <div class="header-name">{channel.name}</div>
      <div class="header-url">{baseUrlForChannel(channel)}</div>
    </div>

    <div class="lifecycle-row" aria-live="polite">
      <span class={`state-label state-${lifecycleState}`} data-testid="publish-state">
        {lifecycleLabel()}
      </span>
      <div class="remote-actions">
        {#if displayRemoteIdentity?.url}
          <button class="quiet-action" data-testid="publish-open-remote" onclick={openInBrowser} disabled={operationLocked()}>
            {t('publish.openRemote')}
          </button>
        {/if}
        {#if channel.platform !== 'medium'}
          <button
            class="quiet-action"
            data-testid={displayRemoteIdentity ? 'publish-rebind' : 'publish-attach-existing'}
            onclick={showBind}
            disabled={operationLocked()}
          >
            {displayRemoteIdentity ? t('publish.rebind') : t('publish.attachExisting')}
          </button>
        {/if}
      </div>
    </div>

    {#if openRemoteError}
      <div class="state-notice error-notice" data-testid="publish-open-remote-error" role="alert">
        <span>{openRemoteError}</span>
      </div>
    {/if}

    {#if lifecycleState === 'conflict'}
      <div class="state-notice warning-notice" data-testid="publish-conflict">
        <span>{t('publish.conflictMessage')}</span>
        <div class="notice-actions">
          <button class="quiet-action" data-testid="publish-overwrite" onclick={requestOverwrite} disabled={operationLocked()}>{t('publish.overwriteExisting')}</button>
          <button class="quiet-action" data-testid="publish-new-copy" onclick={requestNewCopy} disabled={operationLocked()}>{t('publish.newCopy')}</button>
        </div>
      </div>
    {:else if lifecycleState === 'not_found'}
      <div class="state-notice warning-notice" data-testid="publish-not-found">
        <span>{t('publish.notFoundMessage')}</span>
        <button class="quiet-action" data-testid="publish-new-copy" onclick={requestNewCopy} disabled={operationLocked()}>{t('publish.newCopy')}</button>
      </div>
    {:else if lifecycleState === 'unsupported'}
      <div class="state-notice warning-notice" data-testid="publish-unsupported">
        <span>{channel.platform === 'medium' ? t('publish.mediumUnsupported') : t('publish.unsupportedMessage')}</span>
        <button class="quiet-action" data-testid="publish-new-copy" onclick={requestNewCopy} disabled={operationLocked()}>{t('publish.newCopy')}</button>
      </div>
    {:else if lifecycleState === 'corrupt'}
      <div class="state-notice error-notice" data-testid="publish-corrupt">
        <span>{t('publish.corruptMessage')}</span>
        <button class="quiet-action" onclick={() => { void refreshRemoteState(); }} disabled={operationLocked()}>{t('publish.retry')}</button>
      </div>
    {:else if lifecycleState === 'unknown' && isPublishRemoteStateUnknown(remoteState) && remoteState.phase === 'failed'}
      <div class="state-notice error-notice" data-testid="publish-remote-uncertain">
        <span>{t('publish.remoteStateUnavailable')}</span>
        <button
          class="quiet-action"
          data-testid="publish-remote-retry"
          onclick={() => { void retryRemoteState(); }}
          disabled={retryRemoteStateLocked()}
        >{t('publish.retry')}</button>
      </div>
    {/if}

    {#if bindOpen}
      <div class="inline-operation" data-testid="publish-bind-form">
        <label for="publish-bind-input" class="lbl">{t('publish.remoteUrlOrId')}</label>
        <div class="inline-fields">
          <input id="publish-bind-input" data-testid="publish-bind-input" class="inp" bind:value={bindValue} disabled={binding} />
          <button class="ghost-btn" onclick={() => { bindOpen = false; bindError = null; }} disabled={binding}>{t('publish.cancel')}</button>
          <button class="primary-btn" data-testid="publish-bind-confirm" onclick={confirmBind} disabled={binding || !bindValue.trim()}>
            {binding ? t('publish.binding') : t('publish.bind')}
          </button>
        </div>
      </div>
      {#if bindError}
        <div class="state-notice error-notice" data-testid="publish-bind-error" role="alert">
          <span>{bindError}</span>
        </div>
      {/if}
    {/if}

    {#if confirmation}
      <div class="inline-operation confirmation" data-testid="publish-confirmation">
        <span>{confirmation.kind === 'overwrite' ? t('publish.confirmOverwrite') : t('publish.confirmNewCopy')}</span>
        <div class="notice-actions">
          <button class="ghost-btn" data-testid="publish-confirm-cancel" onclick={() => { confirmation = null; }}>{t('publish.cancel')}</button>
          <button class="primary-btn" data-testid="publish-confirm-action" onclick={confirmRecoveryAction}>{t('publish.confirm')}</button>
        </div>
      </div>
    {/if}

    {#if errorMessage}
      <div class="error-banner" data-testid="publish-cover-error">{errorMessage}</div>
    {/if}

    {#if successUrl}
      <div class="success-banner">
        <span>{t('publish.success')}</span>
        <button class="link-btn" onclick={openInBrowser}>{t('publish.openInBrowser')}</button>
        <button class="close-btn" onclick={safeHandleClose} disabled={publishing || exitLocked}>{t('publish.close')}</button>
      </div>
    {:else}
      <div class="form">
        <label for="pub-title" class="lbl">{t('publish.title')} <span class="req">*</span></label>
        <input id="pub-title" type="text" class="inp" bind:value={title} oninput={markUserInput} />

        <div class="row">
          <div class="col">
            <span class="lbl">{t('publish.coverImage')}</span>
            {#if channel.platform === 'medium'}
              <div class="medium-cover-note" data-testid="publish-medium-cover-note">{t('publish.mediumCoverUnsupported')}</div>
            {:else}
              <div
                class="cover-drop"
                role="button"
                tabindex={operationLocked() ? -1 : 0}
                aria-disabled={operationLocked()}
                aria-label={t('publish.coverImage')}
                data-testid="publish-cover-drop"
                ondragover={(e) => e.preventDefault()}
                ondrop={onCoverDrop}
                onpaste={onCoverPaste}
                onclick={pickCover}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void pickCover();
                  }
                }}
              >
                {#if coverPreviewUrl}
                  <img src={coverPreviewUrl} alt="cover preview" data-testid="publish-cover-preview" />
                {:else}
                  <div class="cover-placeholder">{t('publish.coverPlaceholder')}</div>
                {/if}
              </div>
              <div class="cover-actions">
                <button class="small-btn" data-testid="publish-cover-choose" onclick={pickCover} disabled={operationLocked()}>{t('publish.choose')}</button>
                <button class="small-btn" onclick={pasteCoverFromClipboard} disabled={operationLocked()}>{t('publish.pasteFromClipboard')}</button>
                {#if coverAsset}<button class="small-btn" data-testid="publish-cover-remove" onclick={clearCover} disabled={operationLocked()}>{t('publish.remove')}</button>{/if}
              </div>
            {/if}
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

        <div class="footer">
          <button class="ghost-btn" onclick={safeHandleClose} disabled={exitOperationLocked()}>{t('publish.cancel')}</button>
          <button class="primary-btn" data-testid="publish-submit" onclick={() => doPublish()} disabled={operationLocked()}>
            {publishing ? t('publish.publishing') : displayRemoteIdentity ? t('publish.update') : t('publish.publish')}
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

  .lifecycle-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    min-height: 26px; margin-bottom: 8px;
  }
  .state-label {
    display: inline-flex; align-items: center; min-height: 22px;
    padding: 2px 8px; border-radius: 4px;
    background: var(--novelist-sidebar-hover); color: var(--novelist-text-secondary);
    font-size: 11px; font-weight: 600;
  }
  .state-updating, .state-updated { color: var(--novelist-accent); background: color-mix(in srgb, var(--novelist-accent) 12%, transparent); }
  .state-conflict, .state-not_found, .state-unsupported { color: #b06f0e; background: rgba(217, 149, 26, 0.12); }
  .state-corrupt { color: #d24a4a; background: rgba(210, 74, 74, 0.12); }
  .remote-actions, .notice-actions, .inline-fields { display: flex; align-items: center; gap: 8px; }
  .quiet-action {
    border: none; background: transparent; color: var(--novelist-accent);
    padding: 3px 4px; border-radius: 3px; font-size: 12px; cursor: pointer;
  }
  .quiet-action:hover { background: var(--novelist-sidebar-hover); }
  .quiet-action:disabled { opacity: 0.5; cursor: default; }
  .state-notice, .inline-operation {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 7px 10px; margin-bottom: 8px; border-radius: 0 3px 3px 0;
    font-size: 12px;
  }
  .warning-notice { border-left: 3px solid #d9951a; background: rgba(217, 149, 26, 0.1); }
  .error-notice { border-left: 3px solid #d24a4a; background: rgba(210, 74, 74, 0.1); }
  .inline-operation { border-left: 3px solid var(--novelist-accent); background: color-mix(in srgb, var(--novelist-accent) 8%, transparent); }
  .inline-operation > .lbl { margin: 0; flex: 0 0 auto; }
  .inline-fields { flex: 1; min-width: 0; }
  .inline-fields .inp { flex: 1; min-width: 120px; }
  .confirmation > span { color: var(--novelist-text-secondary); }
  .medium-cover-note {
    min-height: 140px; display: flex; align-items: center; justify-content: center;
    padding: 16px; border: 1px dashed var(--novelist-border); border-radius: 4px;
    color: var(--novelist-text-secondary); font-size: 12px; text-align: center;
  }

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
  .cover-drop img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .cover-drop:focus-visible {
    outline: 2px solid var(--novelist-accent);
    outline-offset: 2px;
  }
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
  .primary-btn:disabled, .ghost-btn:disabled, .close-btn:disabled, .small-btn:disabled { opacity: 0.5; cursor: default; }
  .link-btn { background: none; border: none; color: var(--novelist-accent); cursor: pointer; padding: 0; font-size: 14px; text-decoration: underline; }
  .close-btn { background: none; border: 1px solid var(--novelist-border); border-radius: 3px; padding: 2px 8px; font-size: 12px; cursor: pointer; margin-left: auto; }
</style>
