import { commands, type HostConfig } from '$lib/ipc/commands';
import {
  dispatchUpload,
  resolveActiveHost,
  toProviderConfig,
} from '$lib/services/image-host';
import {
  MermaidRasterError,
  rasterizeMermaid as defaultRasterizeMermaid,
  type MermaidRasterizer,
} from '$lib/utils/styled-copy/mermaid-raster';
import { WECHAT_STYLE_MAPS, ZHIHU_STYLE_MAP } from '$lib/utils/styled-copy/themes';
import type {
  LogicalAsset,
  LogicalImageAsset,
  LogicalMermaidAsset,
  ResolvedStyledCopyAssetUrls,
  StyledCopyAssetFailure,
  StyledCopyResult,
  StyledCopyTarget,
  WechatTheme,
} from '$lib/utils/styled-copy/types';

export interface StyledCopyAssetSessionInput {
  readonly assets: readonly LogicalAsset[];
  readonly documentDir: string;
  readonly projectDir: string | null;
  readonly target: StyledCopyTarget;
  readonly wechatTheme: WechatTheme;
  readonly mermaidScale?: number;
}

export interface StyledCopyAssetSession {
  resolvePreview(): Promise<StyledCopyResult<ResolvedStyledCopyAssetUrls>>;
  resolveFinal(
    projectActiveHostId?: string | null,
  ): Promise<StyledCopyResult<ResolvedStyledCopyAssetUrls>>;
}

export interface StyledCopyAssetSessionDependencies {
  rasterizeMermaid?: MermaidRasterizer;
}

const EMPTY_RESOLVERS: ResolvedStyledCopyAssetUrls = Object.freeze({});
const PREVIEW_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const BASE64_CHUNK_BYTES = 12_288;
const MAX_ACTIVE_UPLOADS = 3;

interface PreparedRemoteAsset {
  kind: 'remote';
  assetId: string;
  assetKind: LogicalAsset['kind'];
  url: string;
}

interface PreparedByteAsset {
  kind: 'bytes';
  assetId: string;
  assetKind: LogicalAsset['kind'];
  bytes: Uint8Array;
  mime: string;
  filename: string;
}

type PreparedAsset = PreparedRemoteAsset | PreparedByteAsset;

interface UploadGroup {
  sha256: string;
  assets: PreparedByteAsset[];
}

export function createStyledCopyAssetSession(
  input: StyledCopyAssetSessionInput,
  dependencies: StyledCopyAssetSessionDependencies = {},
): StyledCopyAssetSession {
  const assets = input.assets.map(copyLogicalAsset);
  const allowedRoots = Object.freeze([
    input.documentDir,
    ...(input.projectDir && input.projectDir !== input.documentDir ? [input.projectDir] : []),
  ]);
  const rasterizeMermaid = dependencies.rasterizeMermaid ?? defaultRasterizeMermaid;
  const mermaidBackground = publicationBackground(input.target, input.wechatTheme);
  const successfulUploads = new Map<string, string>();
  let preparation: Promise<StyledCopyResult<PreparedAsset[]>> | null = null;
  let uploadGroups: Promise<UploadGroup[]> | null = null;

  const prepare = () => {
    preparation ??= prepareAssets(
      assets,
      input.documentDir,
      allowedRoots,
      rasterizeMermaid,
      mermaidBackground,
      input.mermaidScale,
    );
    return preparation;
  };

  return {
    async resolvePreview() {
      const prepared = await prepare();
      if (prepared.kind === 'error') return prepared;
      if (prepared.value.length === 0) return emptyResult();

      const value: Record<string, { kind: 'preview'; url: string }> = {};
      for (const asset of prepared.value) {
        value[asset.assetId] = {
          kind: 'preview',
          url: asset.kind === 'remote'
            ? asset.url
            : toPreviewDataUrl(asset.bytes, asset.mime),
        };
      }
      return { kind: 'ok', value, warnings: [] };
    },
    async resolveFinal(projectActiveHostId?: string | null) {
      const prepared = await prepare();
      if (prepared.kind === 'error') return prepared;
      if (prepared.value.length === 0) return emptyResult();
      const byteAssets = prepared.value.filter(isPreparedByteAsset);
      if (byteAssets.length === 0) return finalRemoteResolvers(prepared.value);

      let settingsResult: Awaited<ReturnType<typeof commands.getImageHostSettings>>;
      try {
        settingsResult = await commands.getImageHostSettings();
      } catch {
        return { kind: 'error', error: { code: 'image_host_unavailable' } };
      }
      if (settingsResult.status !== 'ok') {
        return { kind: 'error', error: { code: 'image_host_unavailable' } };
      }
      const host = resolveActiveHost(settingsResult.data, projectActiveHostId);
      if (!host) return { kind: 'error', error: { code: 'image_host_unavailable' } };

      uploadGroups ??= groupUploadsBySha256(byteAssets);
      let groups: UploadGroup[];
      try {
        groups = await uploadGroups;
      } catch {
        uploadGroups = null;
        return {
          kind: 'error',
          error: {
            code: 'asset_upload_failed',
            failures: byteAssets.map((asset) => assetFailureFromPrepared(asset, 'upload_failed')),
          },
        };
      }
      return finalizePreparedAssets(
        prepared.value,
        groups,
        host,
        successfulUploads,
      );
    },
  };
}

function emptyResult(): StyledCopyResult<ResolvedStyledCopyAssetUrls> {
  return { kind: 'ok', value: EMPTY_RESOLVERS, warnings: [] };
}

function copyLogicalAsset(asset: LogicalAsset): LogicalAsset {
  return { ...asset };
}

async function prepareAssets(
  assets: readonly LogicalAsset[],
  documentDir: string,
  allowedRoots: readonly string[],
  rasterizeMermaid: MermaidRasterizer,
  mermaidBackground: string,
  mermaidScale: number | undefined,
): Promise<StyledCopyResult<PreparedAsset[]>> {
  const results = await Promise.all(assets.map((asset) => (
    asset.kind === 'image'
      ? prepareImage(asset, documentDir, allowedRoots)
      : prepareMermaid(asset, rasterizeMermaid, mermaidBackground, mermaidScale)
  )));
  const failures: StyledCopyAssetFailure[] = [];
  const prepared: PreparedAsset[] = [];
  for (const result of results) {
    if (isAssetFailure(result)) failures.push(result);
    else prepared.push(result);
  }
  if (failures.length > 0) {
    return { kind: 'error', error: { code: 'asset_resolution_failed', failures } };
  }
  return { kind: 'ok', value: prepared, warnings: [] };
}

async function prepareMermaid(
  asset: LogicalMermaidAsset,
  rasterizeMermaid: MermaidRasterizer,
  background: string,
  scale: number | undefined,
): Promise<PreparedAsset | StyledCopyAssetFailure> {
  try {
    const result = await rasterizeMermaid({
      source: asset.source,
      background,
      theme: 'neutral',
      ...(scale === undefined ? {} : { scale }),
    });
    if (!validBytes(result.bytes)) return assetFailure(asset, 'mermaid_render_failed');
    return {
      kind: 'bytes',
      assetId: asset.id,
      assetKind: asset.kind,
      bytes: new Uint8Array(result.bytes),
      mime: 'image/png',
      filename: `${asset.id}.png`,
    };
  } catch (error) {
    return assetFailure(asset, mermaidFailureReason(error));
  }
}

async function prepareImage(
  asset: LogicalImageAsset,
  documentDir: string,
  allowedRoots: readonly string[],
): Promise<PreparedAsset | StyledCopyAssetFailure> {
  const classified = classifyImageSource(asset);
  if ('reason' in classified) return classified;
  if (classified.kind === 'remote') {
    return {
      kind: 'remote',
      assetId: asset.id,
      assetKind: asset.kind,
      url: classified.url,
    };
  }

  const path = absoluteLocalPath(documentDir, classified.path);
  try {
    const result = await commands.readStyledCopyImage(path, [...allowedRoots]);
    if (result.status !== 'ok') return assetFailure(asset, 'unresolved_source');
    if (!PREVIEW_IMAGE_MIMES.has(result.data.mime)) {
      return assetFailure(asset, 'unsupported_image_type');
    }
    if (!validBytes(result.data.bytes)) return assetFailure(asset, 'invalid_image_bytes');
    return {
      kind: 'bytes',
      assetId: asset.id,
      assetKind: asset.kind,
      bytes: Uint8Array.from(result.data.bytes),
      mime: result.data.mime,
      filename: localFilename(classified.path, asset.id, result.data.mime),
    };
  } catch {
    return assetFailure(asset, 'unresolved_source');
  }
}

function classifyImageSource(
  asset: LogicalImageAsset,
):
  | { kind: 'remote'; url: string }
  | { kind: 'local'; path: string }
  | StyledCopyAssetFailure {
  const source = asset.source;
  if (!source || /[\u0000-\u001f\u007f]/.test(source)) {
    return assetFailure(asset, 'malformed_source');
  }
  if (/^https:/i.test(source)) {
    if (!/^https:\/\//i.test(source)) return assetFailure(asset, 'malformed_source');
    if (!validPercentEscapes(source)) return assetFailure(asset, 'malformed_source');
    try {
      const parsed = new URL(source);
      if (parsed.protocol !== 'https:' || !parsed.hostname) {
        return assetFailure(asset, 'malformed_source');
      }
      return { kind: 'remote', url: source };
    } catch {
      return assetFailure(asset, 'malformed_source');
    }
  }
  if (source.startsWith('//')) return assetFailure(asset, 'unsafe_source');
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(source);
  if (!isWindowsPath && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)) {
    return assetFailure(asset, 'unsafe_source');
  }

  try {
    const path = source
      .split(/([\\/])/)
      .map((part) => part === '/' || part === '\\' ? part : decodeURIComponent(part))
      .join('');
    return { kind: 'local', path };
  } catch {
    return assetFailure(asset, 'malformed_source_encoding');
  }
}

function validPercentEscapes(value: string): boolean {
  for (let index = value.indexOf('%'); index >= 0; index = value.indexOf('%', index + 1)) {
    if (!/^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) return false;
  }
  return true;
}

function absoluteLocalPath(documentDir: string, source: string): string {
  if (source.startsWith('/') || source.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(source)) {
    return source;
  }
  const separator = documentDir.includes('\\') && !documentDir.includes('/') ? '\\' : '/';
  const base = documentDir.replace(/[\\/]+$/, '');
  const relative = source.replace(/^(?:\.[\\/])+/, '');
  return `${base}${separator}${relative}`;
}

function localFilename(path: string, assetId: string, mime: string): string {
  const filename = path.split(/[\\/]/).at(-1);
  if (filename) return filename;
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length);
  return `${assetId}.${extension}`;
}

function validBytes(bytes: ArrayLike<number>): boolean {
  if (bytes.length === 0) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return false;
  }
  return true;
}

function assetFailure(
  asset: LogicalAsset,
  reason: StyledCopyAssetFailure['reason'],
): StyledCopyAssetFailure {
  return { assetId: asset.id, assetKind: asset.kind, reason };
}

function mermaidFailureReason(error: unknown): StyledCopyAssetFailure['reason'] {
  if (!(error instanceof MermaidRasterError)) return 'mermaid_render_failed';
  switch (error.reason) {
    case 'source_too_large': return 'mermaid_source_too_large';
    case 'unsafe_svg': return 'mermaid_unsafe_svg';
    case 'invalid_dimensions': return 'mermaid_invalid_dimensions';
    case 'render_failed': return 'mermaid_render_failed';
  }
}

function publicationBackground(target: StyledCopyTarget, wechatTheme: WechatTheme): string {
  const styleMap = target === 'wechat' ? WECHAT_STYLE_MAPS[wechatTheme] : ZHIHU_STYLE_MAP;
  return styleMap.article['background-color'] ?? '#ffffff';
}

function isAssetFailure(
  value: PreparedAsset | StyledCopyAssetFailure,
): value is StyledCopyAssetFailure {
  return 'reason' in value;
}

function isPreparedByteAsset(asset: PreparedAsset): asset is PreparedByteAsset {
  return asset.kind === 'bytes';
}

function finalRemoteResolvers(
  assets: readonly PreparedAsset[],
): StyledCopyResult<ResolvedStyledCopyAssetUrls> {
  const value: Record<string, { kind: 'final'; url: string }> = {};
  for (const asset of assets) {
    if (asset.kind === 'remote') value[asset.assetId] = { kind: 'final', url: asset.url };
  }
  return { kind: 'ok', value, warnings: [] };
}

async function groupUploadsBySha256(
  assets: readonly PreparedByteAsset[],
): Promise<UploadGroup[]> {
  const hashes = await Promise.all(assets.map((asset) => sha256(asset.bytes)));
  const groupsByHash = new Map<string, UploadGroup>();
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index];
    const hash = hashes[index];
    const existing = groupsByHash.get(hash);
    if (existing) existing.assets.push(asset);
    else groupsByHash.set(hash, { sha256: hash, assets: [asset] });
  }
  return [...groupsByHash.values()];
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function finalizePreparedAssets(
  assets: readonly PreparedAsset[],
  groups: readonly UploadGroup[],
  host: HostConfig,
  successfulUploads: Map<string, string>,
): Promise<StyledCopyResult<ResolvedStyledCopyAssetUrls>> {
  const urlByHash = new Map<string, string>();
  const pending: UploadGroup[] = [];
  for (const group of groups) {
    const cached = successfulUploads.get(uploadCacheKey(host.id, group.sha256));
    if (cached) urlByHash.set(group.sha256, cached);
    else pending.push(group);
  }

  const providerConfig = toProviderConfig(host);
  const outcomes = await mapWithConcurrency(pending, MAX_ACTIVE_UPLOADS, async (group) => {
    const representative = group.assets[0];
    try {
      const result = await dispatchUpload(
        providerConfig,
        Array.from(representative.bytes),
        representative.filename,
        representative.mime,
      );
      const url = absoluteHttpsUrl(result.url);
      if (!url) return { kind: 'error', group, reason: 'invalid_hosted_url' } as const;
      successfulUploads.set(uploadCacheKey(host.id, group.sha256), url);
      return { kind: 'ok', group, url } as const;
    } catch {
      return { kind: 'error', group, reason: 'upload_failed' } as const;
    }
  });

  const failures: StyledCopyAssetFailure[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'ok') {
      urlByHash.set(outcome.group.sha256, outcome.url);
      continue;
    }
    for (const asset of outcome.group.assets) {
      failures.push(assetFailureFromPrepared(asset, outcome.reason));
    }
  }
  if (failures.length > 0) {
    return { kind: 'error', error: { code: 'asset_upload_failed', failures } };
  }

  const hashByAssetId = new Map<string, string>();
  for (const group of groups) {
    for (const asset of group.assets) hashByAssetId.set(asset.assetId, group.sha256);
  }
  const value: Record<string, { kind: 'final'; url: string }> = {};
  for (const asset of assets) {
    if (asset.kind === 'remote') {
      value[asset.assetId] = { kind: 'final', url: asset.url };
      continue;
    }
    const hash = hashByAssetId.get(asset.assetId);
    const url = hash ? urlByHash.get(hash) : undefined;
    if (!url) {
      return {
        kind: 'error',
        error: {
          code: 'asset_upload_failed',
          failures: [assetFailureFromPrepared(asset, 'upload_failed')],
        },
      };
    }
    value[asset.assetId] = { kind: 'final', url };
  }
  return { kind: 'ok', value, warnings: [] };
}

function uploadCacheKey(hostId: string, sha: string): string {
  return `${hostId}:${sha}`;
}

function absoluteHttpsUrl(value: string): string | null {
  if (!value || value !== value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:'
      || !parsed.hostname
      || parsed.username
      || parsed.password
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function assetFailureFromPrepared(
  asset: PreparedByteAsset,
  reason: StyledCopyAssetFailure['reason'],
): StyledCopyAssetFailure {
  return { assetId: asset.assetId, assetKind: asset.assetKind, reason };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]);
    }
  };
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function toPreviewDataUrl(bytes: Uint8Array, mime: string): string {
  const encoded: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const end = Math.min(offset + BASE64_CHUNK_BYTES, bytes.length);
    let binary = '';
    for (let index = offset; index < end; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    encoded.push(btoa(binary));
  }
  return `data:${mime};base64,${encoded.join('')}`;
}
