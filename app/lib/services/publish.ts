/**
 * Publish orchestrator. The frontend's only module that knows about
 * platform IDs — settings UI, share menu, and palette commands all
 * route through here.
 *
 * Public API:
 * - listChannels() — read configured publish channels
 * - dispatchPublish(channel, payload, doc) — run pre-publish image
 *   upload, body conversion (Pandoc for Ghost/WP, native MD for
 *   Medium), then submit to the platform
 * - extractLocalImageRefs / rewriteBodyWithUrlMap / stripFrontMatter
 *   are exposed for testing and reuse
 */

import {
  commands,
  type ChannelConfig,
  type PlatformConfig,
  type PostImageUploadResult,
  type PublishInput,
  type PublishResult,
  type RemoteIdentity,
  type VerifiedBinding,
} from '$lib/ipc/commands';
import {
  classifyPublishError,
  planPublishAttempt,
  type PublishFailure,
  type PublishIntent,
} from '$lib/services/publish-lifecycle';

export type DialogPayload = {
  title: string;
  tags: string[];
  slug?: string;
  excerpt?: string;
  status: string;
  /** Cover-image bytes if user picked one in the dialog. */
  coverImage?: { bytes: Uint8Array; filename: string; mime: string };
  /** Medium-only: target a publication (omit for user's own profile). */
  publicationId?: string;
};

export type DispatchPublishOptions = {
  remote: RemoteIdentity | null;
  intent: PublishIntent;
};

export type DispatchPublishResult = PublishResult & {
  remoteIdentity?: RemoteIdentity;
};

export class PublishCommandError extends Error {
  constructor(readonly failure: PublishFailure) {
    super(failure.state === 'error' ? failure.message : `Publish ${failure.state}`);
    this.name = 'PublishCommandError';
  }
}

export class PublishIdentityPersistenceError extends PublishCommandError {
  constructor(
    readonly result: PublishResult,
    failure: PublishFailure,
  ) {
    super(failure);
    this.name = 'PublishIdentityPersistenceError';
  }
}

export async function persistPublishResult(args: {
  projectDir: string;
  filePath: string;
  channelId: string;
  result: PublishResult;
}): Promise<RemoteIdentity> {
  const persisted = await commands.persistPublishResult(
    args.projectDir,
    args.filePath,
    args.channelId,
    args.result,
  );
  if (persisted.status !== 'ok') {
    throw new PublishCommandError(classifyPublishError(persisted.error));
  }
  return persisted.data;
}

/** Read every configured publish channel. */
export async function listChannels(): Promise<ChannelConfig[]> {
  const r = await commands.getPublishSettings();
  if (r.status !== 'ok') throw new Error(`Failed to read publish settings: ${r.error}`);
  return r.data.channels ?? [];
}

/** Strip a `---\n...\n---\n` YAML front-matter prefix if present. */
export function stripFrontMatter(body: string): string {
  if (!body.startsWith('---')) return body;
  // Look for the closing `---` on its own line.
  const re = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
  return body.replace(re, '');
}

/** Find every `![alt](path)` reference in `body`, return the path strings (in order). */
export function extractLocalImageRefs(body: string): string[] {
  const re = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (!isRemoteUrl(m[1])) out.push(m[1]);
  }
  return out;
}

/** Replace each `![alt](orig)` whose orig is in the map with the mapped URL. */
export function rewriteBodyWithUrlMap(body: string, map: Map<string, string>): string {
  return body.replace(
    /!(\[[^\]]*\])\(([^)\s]+)(\s+"[^"]*")?\)/g,
    (_full, alt: string, orig: string, title?: string) => {
      const replacement = map.get(orig);
      if (!replacement) return `!${alt}(${orig}${title ?? ''})`;
      return `!${alt}(${replacement}${title ?? ''})`;
    },
  );
}

export function isRemoteUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref) || ref.startsWith('data:');
}

/** Strip id/name from a ChannelConfig, leaving the platform discriminant + fields. */
export function toPlatformConfig(channel: ChannelConfig): PlatformConfig {
  const { id: _id, name: _name, ...rest } = channel;
  return rest as PlatformConfig;
}

/** Resolve a relative Markdown image path against the document's directory. */
export function resolveImagePath(docDir: string, ref: string): string {
  if (isRemoteUrl(ref) || ref.startsWith('/')) return ref;
  const cleaned = ref.replace(/^\.\//, '');
  return `${docDir.replace(/\/$/, '')}/${cleaned}`;
}

function imageFilename(ref: string): string {
  return ref.split(/[\\/]/).pop() || 'image.png';
}

function safeImageErrorLabel(ref: string): string {
  const clean = imageFilename(ref).replace(/[\u0000-\u001f\u007f]/g, '');
  return clean.slice(0, 80) || 'image';
}

function inferMimeFromExt(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg':  return 'image/svg+xml';
    default:     return 'application/octet-stream';
  }
}

/** Dispatch image upload to the right Tauri command for the platform. */
async function uploadImageForPlatform(
  config: PlatformConfig,
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<PostImageUploadResult> {
  const arr = Array.from(bytes);
  const args = { bytes: arr, filename, mime, config };
  let r;
  switch (config.platform) {
    case 'ghost':
      r = await commands.uploadPostImageGhost(args.bytes, args.filename, args.mime, args.config);
      break;
    case 'wordpress_self_hosted':
      r = await commands.uploadPostImageWordpressSelfHosted(args.bytes, args.filename, args.mime, args.config);
      break;
    case 'wordpress_com':
      r = await commands.uploadPostImageWordpressCom(args.bytes, args.filename, args.mime, args.config);
      break;
    case 'medium':
      r = await commands.uploadPostImageMedium(args.bytes, args.filename, args.mime, args.config);
      break;
    default: {
      const _exhaustive: never = config;
      throw new Error(`unknown platform: ${(_exhaustive as { platform: string }).platform}`);
    }
  }
  if (r.status !== 'ok') throw new Error(r.error);
  return r.data;
}

/** Dispatch publish to the right Tauri command for the platform. */
async function publishForPlatform(
  config: PlatformConfig,
  input: PublishInput,
): Promise<PublishResult> {
  let r;
  switch (config.platform) {
    case 'ghost':                  r = await commands.publishToGhost(input, config); break;
    case 'wordpress_self_hosted':  r = await commands.publishToWordpressSelfHosted(input, config); break;
    case 'wordpress_com':          r = await commands.publishToWordpressCom(input, config); break;
    case 'medium':                 r = await commands.publishToMedium(input, config); break;
    default: {
      const _exhaustive: never = config;
      throw new Error(`unknown platform: ${(_exhaustive as { platform: string }).platform}`);
    }
  }
  if (r.status !== 'ok') throw new PublishCommandError(classifyPublishError(r.error));
  return r.data;
}

async function verifyTrackedWordPressUpdate(
  config: PlatformConfig,
  updateTarget: NonNullable<PublishInput['update_target']>,
): Promise<void> {
  let result;
  switch (config.platform) {
    case 'wordpress_self_hosted':
      result = await commands.verifyWordpressSelfHostedUpdate(updateTarget, config);
      break;
    case 'wordpress_com':
      result = await commands.verifyWordpressComUpdate(updateTarget, config);
      break;
    case 'ghost':
    case 'medium':
      return;
  }
  if (result.status !== 'ok') {
    throw new PublishCommandError(classifyPublishError(result.error));
  }
}

/**
 * Run the complete publish pipeline for one channel:
 *
 *   1. Plan create/update behavior and verify tracked WordPress revisions.
 *   2. Strip YAML front-matter from the body (if any).
 *   3. Find every local image reference, read bytes, upload to the
 *      platform's media endpoint, build the orig → hosted URL map.
 *   4. If this attempt requires a cover upload, upload it too —
 *      record its hosted URL (Ghost: `feature_image`) and attachment
 *      id (WordPress: `featured_media`).
 *   5. Rewrite the body with the image URL map.
 *   6. For Ghost / WordPress / WP.com: convert Markdown → HTML via
 *      Pandoc. For Medium: pass body through unchanged.
 *   7. Submit the platform create or update call and persist its identity.
 *
 * Throws on any failure — caller (PublishDialog) catches and shows
 * the error inline without closing.
 */
export async function dispatchPublish(
  channel: ChannelConfig,
  payload: DialogPayload,
  doc: {
    dir: string;
    text: string;
    projectDir?: string;
    filePath?: string;
  },
  options: DispatchPublishOptions = { remote: null, intent: { kind: 'default' } },
): Promise<DispatchPublishResult> {
  const plan = planPublishAttempt(channel.platform, options.remote, options.intent);
  if (plan.request === 'blocked') {
    const failure: PublishFailure = plan.state === 'conflict'
      ? { state: 'conflict', remoteId: options.remote?.post_id ?? '' }
      : plan.state === 'unsupported'
        ? { state: 'unsupported' }
        : { state: 'corrupt' };
    throw new PublishCommandError(failure);
  }
  const platformConfig = toPlatformConfig(channel);
  if (plan.request === 'update') {
    await verifyTrackedWordPressUpdate(platformConfig, plan.updateTarget);
  }
  const stripped = stripFrontMatter(doc.text);
  const refs = extractLocalImageRefs(stripped);

  const urlMap = new Map<string, string>();
  let featuredMediaId: number | undefined;

  for (const ref of refs) {
    const filename = imageFilename(ref);
    const mime = inferMimeFromExt(filename);
    const readResult = await commands.readImageBytes(doc.dir, ref);
    if (readResult.status !== 'ok') {
      throw new Error(`Read failed for ${safeImageErrorLabel(ref)}: ${readResult.error}`);
    }
    const bytes = new Uint8Array(readResult.data);
    let uploaded: PostImageUploadResult;
    try {
      uploaded = await uploadImageForPlatform(platformConfig, bytes, filename, mime);
    } catch (e) {
      throw new Error(`Image upload failed for ${safeImageErrorLabel(ref)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    urlMap.set(ref, uploaded.url);
  }

  let featureImageUrl: string | undefined;
  if (payload.coverImage) {
    const cover = await uploadImageForPlatform(
      platformConfig,
      payload.coverImage.bytes,
      payload.coverImage.filename,
      payload.coverImage.mime,
    );
    featureImageUrl = cover.url;
    if (cover.attachment_id > 0) featuredMediaId = cover.attachment_id;
  }

  const rewritten = rewriteBodyWithUrlMap(stripped, urlMap);

  let body: string;
  let bodyFormat: 'html' | 'markdown';
  if (channel.platform === 'medium') {
    body = rewritten;
    bodyFormat = 'markdown';
  } else {
    const htmlResult = await commands.convertMarkdownToHtml(rewritten);
    if (htmlResult.status !== 'ok') {
      throw new Error(`Pandoc conversion failed: ${htmlResult.error}`);
    }
    body = htmlResult.data;
    bodyFormat = 'html';
  }

  const input: PublishInput = {
    title: payload.title,
    body,
    body_format: bodyFormat,
    tags: payload.tags,
    slug: payload.slug,
    excerpt: payload.excerpt,
    status: payload.status,
    feature_image_url: featureImageUrl,
    featured_media_id: featuredMediaId,
    publication_id: payload.publicationId,
    update_target: plan.request === 'update' ? plan.updateTarget : undefined,
  };

  const result = await publishForPlatform(platformConfig, input);
  if (doc.projectDir && doc.filePath) {
    try {
      const remoteIdentity = await persistPublishResult({
        projectDir: doc.projectDir,
        filePath: doc.filePath,
        channelId: channel.id,
        result,
      });
      return { ...result, remoteIdentity };
    } catch (error) {
      const failure = error instanceof PublishCommandError
        ? error.failure
        : { state: 'error' as const, message: 'Publish identity persistence failed' };
      throw new PublishIdentityPersistenceError(result, failure);
    }
  }
  return result;
}

export async function readPublishRemoteState(args: {
  projectDir: string;
  filePath: string;
  channelId: string;
}): Promise<RemoteIdentity | null> {
  const result = await commands.readPublishRemoteState(
    args.projectDir,
    args.filePath,
    args.channelId,
  );
  if (result.status !== 'ok') throw new PublishCommandError(classifyPublishError(result.error));
  return result.data;
}

/**
 * Task 20: bind an existing remote post to `(projectDir, filePath, channelId)`
 * after Rust-side authenticated verification. Task 21 UI wraps this to offer
 * "Attach existing post" flows in the Publish dialog.
 *
 * Contract:
 * - Credentials are never sent from the frontend; the Rust command resolves
 *   the channel by ID from persisted global settings.
 * - Provider verification (Ghost / WordPress / WordPress.com) GETs the
 *   referenced post and returns an `Updatable` binding. Medium fails closed
 *   with an unsupported/insufficient-scope backend error because `/v1/me`
 *   only proves token liveness, not post existence, canonical URL, or
 *   ownership; no Medium sidecar identity is written.
 * - Sidecar mutation is atomic and touches only the target channel's
 *   `remote` field; sibling channels, `form`, and `cover` are preserved.
 */
export async function bindLegacyPublication(args: {
  projectDir: string;
  filePath: string;
  channelId: string;
  urlOrId: string;
}): Promise<VerifiedBinding> {
  const r = await commands.bindLegacyPublication(
    args.projectDir,
    args.filePath,
    args.channelId,
    args.urlOrId,
  );
  if (r.status !== 'ok') {
    let structured = false;
    try {
      const parsed = JSON.parse(r.error) as { kind?: unknown };
      structured = Boolean(parsed && typeof parsed === 'object' && typeof parsed.kind === 'string');
    } catch {
      structured = false;
    }
    if (structured) throw new PublishCommandError(classifyPublishError(r.error));
    throw new Error(r.error);
  }
  return r.data;
}
