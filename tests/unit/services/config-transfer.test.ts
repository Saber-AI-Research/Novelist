import { describe, expect, it } from 'vitest';
import {
  decodeConfigTransfer,
  encodeConfigTransfer,
  isAiTalkSettings,
  isTransferSyncConfig,
} from '$lib/services/config-transfer';

const aiTalk = {
  activeProfileId: 'custom',
  profiles: [{ id: 'custom', label: '本地模型', baseUrl: 'http://localhost:11434/v1', apiKey: 'secret', model: 'qwen', temperature: 0.4 }],
  baseUrl: 'http://localhost:11434/v1',
  apiKey: 'secret',
  model: 'qwen',
  temperature: 0.4,
  systemPrompt: '帮助我写作。',
  includeCurrentFile: true,
  includeSelection: false,
};

const sync = {
  enabled: true,
  webdav_url: 'https://dav.example.test/小说/',
  remote_directory: '我的写作/小说',
  username: '作者',
  password: 'app-password',
  interval_minutes: 15,
  legacy_remote_acknowledged: false,
  cloud_account: false,
};

describe('config transfer', () => {
  it('round-trips compressed CJK AI and WebDAV settings', async () => {
    expect(isAiTalkSettings(aiTalk)).toBe(true);
    expect(isTransferSyncConfig(sync)).toBe(true);
    const encoded = await encodeConfigTransfer({ version: 2, exportedAt: '2026-10-29T00:00:00.000Z', aiTalk, sync });
    const decoded = await decodeConfigTransfer(encoded);
    expect(decoded.aiTalk).toEqual(aiTalk);
    expect(decoded.sync).toEqual(sync);
  });

  it('rejects pasted text that is not a Novelist payload', async () => {
    await expect(decodeConfigTransfer('ordinary clipboard text')).rejects.toThrow('Novelist');
  });

  it('rejects invalid numeric settings before encoding', async () => {
    expect(isAiTalkSettings({ ...aiTalk, temperature: Number.NaN })).toBe(false);
    expect(isTransferSyncConfig({ ...sync, interval_minutes: Number.POSITIVE_INFINITY })).toBe(false);
    await expect(encodeConfigTransfer({
      version: 2,
      exportedAt: '2026-10-29T00:00:00.000Z',
      aiTalk: { ...aiTalk, temperature: 3 },
      sync,
    })).rejects.toThrow('配置');
  });

  it('restores old V1 settings into their original endpoint folder without adding Novelist', async () => {
    const { remote_directory: _directory, ...legacySync } = sync;
    const legacy = { version: 1, exportedAt: '2026-10-29T00:00:00.000Z', aiTalk, sync: legacySync };
    const compressed = new Blob([JSON.stringify(legacy)]).stream().pipeThrough(new CompressionStream('gzip'));
    const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
    const decoded = await decodeConfigTransfer(`NOVELIST-CONFIG-V1:GZIP:${btoa(String.fromCharCode(...bytes))}`);
    expect(decoded.sync.remote_directory).toBe('');
    expect(decoded.sync.webdav_url).toBe(legacySync.webdav_url);
  });

  it('rejects a directory downgrade disguised as the legacy transfer format', async () => {
    const encoded = await encodeConfigTransfer({ version: 2, exportedAt: '2026-11-03T00:00:00.000Z', aiTalk, sync });
    const legacyTagged = encoded.replace('NOVELIST-CONFIG-V2:', 'NOVELIST-CONFIG-V1:');
    await expect(decodeConfigTransfer(legacyTagged)).rejects.toThrow('版本');
    expect(isTransferSyncConfig({ ...sync, remote_directory: '../other' })).toBe(false);
  });

  it('rejects malformed encoded payloads with a stable error', async () => {
    await expect(decodeConfigTransfer('NOVELIST-CONFIG-V1:GZIP:%%%')).rejects.toThrow('配置');
  });
});
