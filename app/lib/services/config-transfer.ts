import type { AiTalkSettings } from '$lib/components/ai-talk/settings.svelte';
import { normalizeWebdavDirectory } from './webdav-directory';

export const CONFIG_TRANSFER_PREFIX = 'NOVELIST-CONFIG-V2:GZIP:';
const LEGACY_TRANSFER_PREFIX = 'NOVELIST-CONFIG-V1:GZIP:';
const MAX_TRANSFER_LENGTH = 512_000;
const MAX_DECODED_BYTES = 384_000;

export type TransferSyncConfig = {
  enabled: boolean;
  webdav_url: string;
  remote_directory: string;
  username: string;
  password: string;
  interval_minutes: number;
  legacy_remote_acknowledged: boolean;
  cloud_account: boolean;
};

export type ConfigTransferPayload = {
  version: 2;
  exportedAt: string;
  aiTalk: AiTalkSettings;
  sync: TransferSyncConfig;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (!value || value.length > MAX_TRANSFER_LENGTH || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error('配置字符串无效或过大');
  }
  const binary = atob(value);
  if (binary.length > MAX_DECODED_BYTES) throw new Error('配置字符串过大');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') throw new Error('当前环境不支持压缩配置');
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前环境不支持解压配置');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  // Count while inflating: a small gzip bomb must not be buffered in full first.
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_DECODED_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('解压后的配置过大');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export async function encodeConfigTransfer(payload: ConfigTransferPayload): Promise<string> {
  if (!isConfigTransferPayload(payload)) throw new Error('配置内容无效');
  const compressed = await gzip(new TextEncoder().encode(JSON.stringify(payload)));
  const encoded = `${CONFIG_TRANSFER_PREFIX}${bytesToBase64(compressed)}`;
  if (encoded.length > MAX_TRANSFER_LENGTH) throw new Error('配置内容过大');
  return encoded;
}

export async function decodeConfigTransfer(raw: string): Promise<ConfigTransferPayload> {
  const value = raw.trim();
  const legacy = value.startsWith(LEGACY_TRANSFER_PREFIX);
  const prefix = legacy ? LEGACY_TRANSFER_PREFIX : CONFIG_TRANSFER_PREFIX;
  if (!value.startsWith(prefix)) throw new Error('这不是 Novelist 配置字符串');
  try {
    const compressed = base64ToBytes(value.slice(prefix.length));
    let parsed: unknown = JSON.parse(new TextDecoder().decode(await gunzip(compressed)));
    if (legacy) {
      if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1
        || !('exportedAt' in parsed) || typeof parsed.exportedAt !== 'string'
        || !('aiTalk' in parsed) || !isAiTalkSettings(parsed.aiTalk)
        || !('sync' in parsed) || !parsed.sync || typeof parsed.sync !== 'object'
        || ('remote_directory' in parsed.sync && parsed.sync.remote_directory !== '')) throw new Error('配置内容无效或版本不受支持');
      parsed = { version: 2, exportedAt: parsed.exportedAt, aiTalk: parsed.aiTalk, sync: { ...parsed.sync, remote_directory: '' } };
    }
    if (!isConfigTransferPayload(parsed)) throw new Error('配置内容无效或版本不受支持');
    return parsed;
  } catch (error) {
    if (error instanceof Error && (error.message.includes('配置') || error.message.includes('支持'))) throw error;
    throw new Error('配置字符串损坏或无法解压');
  }
}

function isConfigTransferPayload(value: unknown): value is ConfigTransferPayload {
  if (!value || typeof value !== 'object' || !('version' in value) || !('exportedAt' in value)) return false;
  return value.version === 2 && typeof value.exportedAt === 'string'
    && 'aiTalk' in value && isAiTalkSettings(value.aiTalk)
    && 'sync' in value && isTransferSyncConfig(value.sync);
}

export function isAiTalkSettings(value: unknown): value is AiTalkSettings {
  if (!value || typeof value !== 'object' || !('activeProfileId' in value) || !('profiles' in value)) return false;
  if (typeof value.activeProfileId !== 'string' || !Array.isArray(value.profiles)) return false;
  const profilesValid = value.profiles.every((profile) => {
    if (!profile || typeof profile !== 'object') return false;
    return 'id' in profile && typeof profile.id === 'string'
      && 'label' in profile && typeof profile.label === 'string'
      && 'baseUrl' in profile && typeof profile.baseUrl === 'string'
      && 'apiKey' in profile && typeof profile.apiKey === 'string'
      && 'model' in profile && typeof profile.model === 'string'
      && 'temperature' in profile && typeof profile.temperature === 'number'
      && Number.isFinite(profile.temperature) && profile.temperature >= 0 && profile.temperature <= 2;
  });
  return profilesValid && 'baseUrl' in value && typeof value.baseUrl === 'string'
    && 'apiKey' in value && typeof value.apiKey === 'string'
    && 'model' in value && typeof value.model === 'string'
    && 'temperature' in value && typeof value.temperature === 'number'
    && Number.isFinite(value.temperature) && value.temperature >= 0 && value.temperature <= 2
    && 'systemPrompt' in value && typeof value.systemPrompt === 'string'
    && 'includeCurrentFile' in value && typeof value.includeCurrentFile === 'boolean'
    && 'includeSelection' in value && typeof value.includeSelection === 'boolean';
}

export function isTransferSyncConfig(value: unknown): value is TransferSyncConfig {
  if (!value || typeof value !== 'object' || !('remote_directory' in value) || typeof value.remote_directory !== 'string') return false;
  try { if (normalizeWebdavDirectory(value.remote_directory) !== value.remote_directory) return false; } catch { return false; }
  return 'enabled' in value && typeof value.enabled === 'boolean'
    && 'webdav_url' in value && typeof value.webdav_url === 'string'
    && 'username' in value && typeof value.username === 'string'
    && 'password' in value && typeof value.password === 'string'
    && 'interval_minutes' in value && typeof value.interval_minutes === 'number'
    && Number.isInteger(value.interval_minutes) && value.interval_minutes >= 0 && value.interval_minutes <= 10080
    && 'legacy_remote_acknowledged' in value && typeof value.legacy_remote_acknowledged === 'boolean'
    && 'cloud_account' in value && typeof value.cloud_account === 'boolean';
}
