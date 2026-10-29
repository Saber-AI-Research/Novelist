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
    const encoded = await encodeConfigTransfer({ version: 1, exportedAt: '2026-10-29T00:00:00.000Z', aiTalk, sync });
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
      version: 1,
      exportedAt: '2026-10-29T00:00:00.000Z',
      aiTalk: { ...aiTalk, temperature: 3 },
      sync,
    })).rejects.toThrow('配置');
  });

  it('rejects malformed encoded payloads with a stable error', async () => {
    await expect(decodeConfigTransfer('NOVELIST-CONFIG-V1:GZIP:%%%')).rejects.toThrow('配置');
  });
});
