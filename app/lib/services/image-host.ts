/**
 * Image-host orchestrator. The frontend's only image-host module that
 * knows about provider IDs — editor and settings UI both call through here.
 *
 * Public API:
 * - uploadImage(reference, scope, projectHostId?) — upload one confined image.
 * - uploadAllInDocument(docText, scope, projectHostId?) — batch-upload local images
 *   referenced by the Markdown text; returns a per-image report.
 * - uploadInlineBytes(bytes, suggestedName, mime, projectDir?) — used by
 *   the paste/drop interceptor when bytes are already in memory.
 *
 * Active-host resolution: reads `image_hosts` settings; if a `projectDir`
 * is provided AND that project's `active_image_host_id` is set AND points
 * at a configured host, that wins; otherwise falls back to the global
 * `active_host_id`. Throws if no usable host is configured.
 */

import { commands, type HostConfig, type ImageHostSettings_Serialize, type ProviderConfig, type UploadResult } from '$lib/ipc/commands';

export type UploadReport = {
  successes: Array<{ original: string; url: string }>;
  failures: Array<{ original: string; error: string }>;
};

export type LocalImageReadScope = {
  baseDir: string;
};

export class NoActiveHostError extends Error {
  constructor() {
    super('No image host is configured. Add one in Settings → Image Hosts.');
    this.name = 'NoActiveHostError';
  }
}

/** Resolve the active host given current settings + an optional project override. */
export function resolveActiveHost(
  settings: ImageHostSettings_Serialize,
  projectActiveHostId: string | null | undefined,
): HostConfig | null {
  const projectHost = projectActiveHostId
    ? settings.hosts.find((host) => host.id === projectActiveHostId)
    : undefined;
  if (projectHost) return projectHost;
  return settings.hosts.find((host) => host.id === settings.active_host_id) ?? null;
}

async function loadActiveHost(projectActiveHostId?: string | null): Promise<HostConfig> {
  const result = await commands.getImageHostSettings();
  if (result.status !== 'ok') {
    throw new Error(`Failed to read image-host settings: ${result.error}`);
  }
  const host = resolveActiveHost(result.data, projectActiveHostId ?? null);
  if (!host) throw new NoActiveHostError();
  return host;
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
    case 'bmp':  return 'image/bmp';
    case 'ico':  return 'image/x-icon';
    default:     return 'application/octet-stream';
  }
}

/** Strip the host wrapper fields, leaving just the provider config. */
export function toProviderConfig(host: HostConfig): ProviderConfig {
  // HostConfig's wire shape is `{id, name} & ProviderConfig` (Rust uses
  // serde(flatten)). Drop id/name; the rest is a ProviderConfig.
  const { id: _id, name: _name, ...rest } = host;
  return rest as ProviderConfig;
}

/** Dispatch an upload to the right Tauri command for the host's provider. */
export async function dispatchUpload(
  config: ProviderConfig,
  bytes: number[],
  filename: string,
  mime: string,
): Promise<UploadResult> {
  const args = { bytes, filename, mime, config };
  let result;
  switch (config.provider) {
    case 'qiniu':       result = await commands.uploadImageQiniu(args.bytes, args.filename, args.mime, args.config); break;
    case 'aliyun_oss':  result = await commands.uploadImageAliyunOss(args.bytes, args.filename, args.mime, args.config); break;
    case 's3':          result = await commands.uploadImageS3(args.bytes, args.filename, args.mime, args.config); break;
    case 'imgur':       result = await commands.uploadImageImgur(args.bytes, args.filename, args.mime, args.config); break;
    case 'smms':        result = await commands.uploadImageSmms(args.bytes, args.filename, args.mime, args.config); break;
    case 'custom':      result = await commands.uploadImageCustom(args.bytes, args.filename, args.mime, args.config); break;
    default: {
      // Exhaustiveness check; TS will complain if a new variant is added.
      const _exhaustive: never = config;
      throw new Error(`Unknown image-host provider: ${(_exhaustive as { provider: string }).provider}`);
    }
  }
  if (result.status !== 'ok') {
    throw new Error(result.error);
  }
  return result.data;
}

/** Read a local file through a Rust-owned project/document capability. */
async function readLocalBytes(scope: LocalImageReadScope, reference: string): Promise<number[]> {
  const result = await commands.readImageBytes(scope.baseDir, reference);
  if (result.status !== 'ok') {
    throw new Error(`Failed to read local image: ${result.error}`);
  }
  return result.data;
}

function bytesToBase64(bytes: number[]): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/** Load a local image preview through the same confined read used by uploads. */
export async function readLocalImageDataUri(
  reference: string,
  scope: LocalImageReadScope,
): Promise<string> {
  const bytes = await readLocalBytes(scope, reference);
  return `data:${inferMimeFromExt(reference)};base64,${bytesToBase64(bytes)}`;
}

/** Resolve a relative Markdown image path against the document's directory. */
export function resolveImagePath(docDir: string, ref: string): string {
  if (/^([a-z]+:)?\/\//i.test(ref) || ref.startsWith('data:')) return ref;
  if (ref.startsWith('/')) return ref;
  // strip leading ./ for cleanliness
  const cleaned = ref.replace(/^\.\//, '');
  return `${docDir.replace(/\/$/, '')}/${cleaned}`;
}

/** True if the URL is already remote (or a data URI) — skip upload. */
export function isRemoteUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref) || ref.startsWith('data:');
}

/** Upload a single local image and return the remote URL. */
export async function uploadImage(
  reference: string,
  scope: LocalImageReadScope,
  projectActiveHostId?: string | null,
): Promise<{ url: string }> {
  const host = await loadActiveHost(projectActiveHostId);
  const filename = reference.split(/[\\/]/).pop() ?? 'image.png';
  const mime = inferMimeFromExt(filename);
  const bytes = await readLocalBytes(scope, reference);
  const { url } = await dispatchUpload(toProviderConfig(host), bytes, filename, mime);
  return { url };
}

/** Upload bytes already in memory (paste/drop intercept). */
export async function uploadInlineBytes(
  bytes: Uint8Array,
  suggestedName: string,
  mime: string,
  projectActiveHostId?: string | null,
): Promise<{ url: string }> {
  const host = await loadActiveHost(projectActiveHostId);
  const arr = Array.from(bytes);
  const { url } = await dispatchUpload(toProviderConfig(host), arr, suggestedName, mime);
  return { url };
}

/**
 * Find every `![](...)` reference in `docText` whose target is a local
 * file (not http/https/data URI), upload each sequentially, and return
 * a per-image report. Caller is responsible for applying the URL
 * replacements to the editor source.
 */
export async function uploadAllInDocument(
  docText: string,
  scope: LocalImageReadScope,
  projectActiveHostId?: string | null,
): Promise<UploadReport> {
  const host = await loadActiveHost(projectActiveHostId);
  const refs = extractImageRefs(docText);
  const report: UploadReport = { successes: [], failures: [] };
  for (const ref of refs) {
    if (isRemoteUrl(ref)) continue;
    const filename = ref.split(/[\\/]/).pop() ?? 'image.png';
    const mime = inferMimeFromExt(filename);
    try {
      const bytes = await readLocalBytes(scope, ref);
      const providerCfg = toProviderConfig(host);
      const { url } = await dispatchUpload(providerCfg, bytes, filename, mime);
      report.successes.push({ original: ref, url });
    } catch (e) {
      report.failures.push({ original: ref, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

/** Extract every `![alt](path)` target from Markdown source. */
export function extractImageRefs(docText: string): string[] {
  const re = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(docText)) !== null) {
    out.push(m[1]);
  }
  return out;
}
