import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MermaidConfig } from 'mermaid';
import type {
  LogicalImageAsset,
  LogicalMermaidAsset,
} from '$lib/utils/styled-copy/types';

const { ipc } = vi.hoisted(() => ({
  ipc: {
    reads: [] as Array<{ path: string; allowedRoots: string[] }>,
    uploads: [] as Array<{
      provider: string;
      bytes: number[];
      filename: string;
      mime: string;
    }>,
    settingsCalls: 0,
    activeUploads: 0,
    maximumActiveUploads: 0,
    readResults: new Map<string,
      | { status: 'ok'; data: { bytes: number[]; mime: string } }
      | { status: 'error'; error: string }
    >(),
    settings: {
      hosts: [] as Array<{ id: string; name: string; provider: string; [key: string]: unknown }>,
      active_host_id: undefined as string | undefined,
      auto_on_paste: false,
    },
    uploadHandler: null as null | ((call: {
      provider: string;
      bytes: number[];
      filename: string;
      mime: string;
    }) => Promise<
      | { status: 'ok'; data: { url: string; remote_key: string | null } }
      | { status: 'error'; error: string }
    >),
  },
}));

vi.mock('$lib/ipc/commands', () => {
  const upload = async (
    provider: string,
    bytes: number[],
    filename: string,
    mime: string,
  ) => {
    const call = { provider, bytes, filename, mime };
    ipc.uploads.push(call);
    ipc.activeUploads += 1;
    ipc.maximumActiveUploads = Math.max(ipc.maximumActiveUploads, ipc.activeUploads);
    try {
      if (ipc.uploadHandler) return await ipc.uploadHandler(call);
      return {
        status: 'ok' as const,
        data: {
          url: `https://${provider}.example/${encodeURIComponent(filename)}`,
          remote_key: null,
        },
      };
    } finally {
      ipc.activeUploads -= 1;
    }
  };

  return {
    commands: {
      readStyledCopyImage: (path: string, allowedRoots: string[]) => {
        ipc.reads.push({ path, allowedRoots });
        return Promise.resolve(ipc.readResults.get(path) ?? {
          status: 'error' as const,
          error: `missing fixture: ${path}`,
        });
      },
      getImageHostSettings: () => {
        ipc.settingsCalls += 1;
        return Promise.resolve({ status: 'ok' as const, data: ipc.settings });
      },
      uploadImageQiniu: (bytes: number[], filename: string, mime: string) =>
        upload('qiniu', bytes, filename, mime),
      uploadImageAliyunOss: (bytes: number[], filename: string, mime: string) =>
        upload('aliyun_oss', bytes, filename, mime),
      uploadImageS3: (bytes: number[], filename: string, mime: string) =>
        upload('s3', bytes, filename, mime),
      uploadImageImgur: (bytes: number[], filename: string, mime: string) =>
        upload('imgur', bytes, filename, mime),
      uploadImageSmms: (bytes: number[], filename: string, mime: string) =>
        upload('smms', bytes, filename, mime),
      uploadImageCustom: (bytes: number[], filename: string, mime: string) =>
        upload('custom', bytes, filename, mime),
    },
  };
});

function image(id: string, source: string): LogicalImageAsset {
  return { kind: 'image', id, source, alt: id, title: null };
}

function mermaid(id: string, source: string): LogicalMermaidAsset {
  return { kind: 'mermaid', id, source };
}

function validSvg(width = 640, height = 320): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`,
    ` viewBox="0 0 ${width} ${height}">`,
    '<style>#node{fill:#ffffff;stroke:#222222}</style>',
    '<rect id="node" width="100" height="50"/><text>章节</text></svg>',
  ].join('');
}

beforeEach(() => {
  ipc.reads.length = 0;
  ipc.uploads.length = 0;
  ipc.settingsCalls = 0;
  ipc.activeUploads = 0;
  ipc.maximumActiveUploads = 0;
  ipc.readResults.clear();
  ipc.settings.hosts = [];
  ipc.settings.active_host_id = undefined;
  ipc.uploadHandler = null;
});

describe('[contract] styled-copy asset session', () => {
  it('returns separate empty preview and final resolver maps without a host', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    const session = createStyledCopyAssetSession({
      assets: [],
      documentDir: '/documents',
      projectDir: null,
      target: 'wechat',
      wechatTheme: 'minimal',
    });

    await expect(session.resolvePreview()).resolves.toEqual({
      kind: 'ok',
      value: {},
      warnings: [],
    });
    await expect(session.resolveFinal(null)).resolves.toEqual({
      kind: 'ok',
      value: {},
      warnings: [],
    });
  });

  it('reads decoded CJK local paths only through the styled-copy safe reader', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    const encodedSource = './%E5%9B%BE%E7%89%87/%E5%B0%81%E9%9D%A2%201.png';
    const resolvedPath = '/文档/章节/图片/封面 1.png';
    const assets = [image('image-1', encodedSource)];
    const frozenAssets = JSON.stringify(assets);
    ipc.readResults.set(resolvedPath, {
      status: 'ok',
      data: { bytes: [137, 80, 78, 71], mime: 'image/png' },
    });

    const session = createStyledCopyAssetSession({
      assets,
      documentDir: '/文档/章节',
      projectDir: '/文档',
      target: 'wechat',
      wechatTheme: 'minimal',
    });
    const result = await session.resolvePreview();

    expect(result).toEqual({
      kind: 'ok',
      value: {
        'image-1': { kind: 'preview', url: 'data:image/png;base64,iVBORw==' },
      },
      warnings: [],
    });
    expect(ipc.reads).toEqual([{
      path: resolvedPath,
      allowedRoots: ['/文档/章节', '/文档'],
    }]);
    expect(ipc.settingsCalls).toBe(0);
    expect(ipc.uploads).toEqual([]);
    expect(JSON.stringify(assets)).toBe(frozenAssets);
  });

  it('preserves input HTTPS images in preview without reads, fetches, or uploads', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const source = 'https://cdn.example/%E5%B0%81%E9%9D%A2.webp?size=large#asset';
    const session = createStyledCopyAssetSession({
      assets: [image('image-1', source)],
      documentDir: '/documents',
      projectDir: null,
      target: 'zhihu',
      wechatTheme: 'technical',
    });

    await expect(session.resolvePreview()).resolves.toEqual({
      kind: 'ok',
      value: { 'image-1': { kind: 'preview', url: source } },
      warnings: [],
    });
    expect(ipc.reads).toEqual([]);
    expect(ipc.settingsCalls).toBe(0);
    expect(ipc.uploads).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('finalizes a remote-HTTPS-only document without resolving an image host', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    const source = 'https://cdn.example/image.png';
    const session = createStyledCopyAssetSession({
      assets: [image('image-1', source)],
      documentDir: '/documents',
      projectDir: null,
      target: 'wechat',
      wechatTheme: 'minimal',
    });

    await expect(session.resolveFinal('stale-host')).resolves.toEqual({
      kind: 'ok',
      value: { 'image-1': { kind: 'final', url: source } },
      warnings: [],
    });
    expect(ipc.settingsCalls).toBe(0);
    expect(ipc.uploads).toEqual([]);
  });

  it.each([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ])('brands validated %s bytes as a preview data URL', async (mime) => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    ipc.readResults.set('/documents/image.bin', {
      status: 'ok',
      data: { bytes: [0, 1, 2], mime },
    });
    const session = createStyledCopyAssetSession({
      assets: [image('image-1', 'image.bin')],
      documentDir: '/documents',
      projectDir: null,
      target: 'wechat',
      wechatTheme: 'minimal',
    });

    const result = await session.resolvePreview();
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value['image-1']).toEqual({
      kind: 'preview',
      url: `data:${mime};base64,AAEC`,
    });
  });

  it('encodes a large bounded preview without argument spreading', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    const bytes = Array.from({ length: 128_000 }, (_, index) => index % 251);
    ipc.readResults.set('/documents/large.png', {
      status: 'ok',
      data: { bytes, mime: 'image/png' },
    });
    const session = createStyledCopyAssetSession({
      assets: [image('image-1', 'large.png')],
      documentDir: '/documents',
      projectDir: null,
      target: 'zhihu',
      wechatTheme: 'minimal',
    });

    const result = await session.resolvePreview();
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const url = result.value['image-1']?.url ?? '';
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    expect(atob(url.slice('data:image/png;base64,'.length))).toHaveLength(bytes.length);
  });

  it('aggregates unsafe, malformed, and unresolved image sources without fetching', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const session = createStyledCopyAssetSession({
      assets: [
        image('http', 'http://cdn.example/image.png'),
        image('file', 'file:///private/image.png'),
        image('data', 'data:image/png;base64,AA=='),
        image('blob', 'blob:https://example/id'),
        image('scheme', 'ftp://example/image.png'),
        image('protocol-relative', '//cdn.example/image.png'),
        image('malformed-url', 'https://[invalid'),
        image('malformed-remote-encoding', 'https://cdn.example/broken%ZZ.png'),
        image('malformed-encoding', './broken%E0%A4%A.png'),
        image('missing', './missing.png'),
      ],
      documentDir: '/documents',
      projectDir: '/project',
      target: 'wechat',
      wechatTheme: 'magazine',
    });

    await expect(session.resolvePreview()).resolves.toEqual({
      kind: 'error',
      error: {
        code: 'asset_resolution_failed',
        failures: [
          { assetId: 'http', assetKind: 'image', reason: 'unsafe_source' },
          { assetId: 'file', assetKind: 'image', reason: 'unsafe_source' },
          { assetId: 'data', assetKind: 'image', reason: 'unsafe_source' },
          { assetId: 'blob', assetKind: 'image', reason: 'unsafe_source' },
          { assetId: 'scheme', assetKind: 'image', reason: 'unsafe_source' },
          { assetId: 'protocol-relative', assetKind: 'image', reason: 'unsafe_source' },
          { assetId: 'malformed-url', assetKind: 'image', reason: 'malformed_source' },
          {
            assetId: 'malformed-remote-encoding',
            assetKind: 'image',
            reason: 'malformed_source',
          },
          {
            assetId: 'malformed-encoding',
            assetKind: 'image',
            reason: 'malformed_source_encoding',
          },
          { assetId: 'missing', assetKind: 'image', reason: 'unresolved_source' },
        ],
      },
    });
    expect(ipc.reads).toEqual([{
      path: '/documents/missing.png',
      allowedRoots: ['/documents', '/project'],
    }]);
    expect(ipc.settingsCalls).toBe(0);
    expect(ipc.uploads).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects an SVG MIME returned by the native boundary', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    ipc.readResults.set('/documents/vector.svg', {
      status: 'ok',
      data: { bytes: [60, 115, 118, 103, 62], mime: 'image/svg+xml' },
    });
    const session = createStyledCopyAssetSession({
      assets: [image('image-1', './vector.svg')],
      documentDir: '/documents',
      projectDir: null,
      target: 'wechat',
      wechatTheme: 'minimal',
    });

    await expect(session.resolvePreview()).resolves.toEqual({
      kind: 'error',
      error: {
        code: 'asset_resolution_failed',
        failures: [{
          assetId: 'image-1',
          assetKind: 'image',
          reason: 'unsupported_image_type',
        }],
      },
    });
    expect(ipc.uploads).toEqual([]);
  });
});

describe('[contract] styled-copy final asset transaction', () => {
  it('deduplicates exact local and Mermaid bytes and forwards the native MIME', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    ipc.settings.hosts = [
      { id: 'global', name: 'Global', provider: 'imgur', client_id: 'global' },
      {
        id: 'project',
        name: 'Project',
        provider: 's3',
        access_key_id: 'key',
        secret_access_key: 'secret',
        bucket: 'bucket',
        region: 'region',
      },
    ];
    ipc.settings.active_host_id = 'global';
    ipc.readResults.set('/documents/图片/封面 1.jpg', {
      status: 'ok',
      data: { bytes: [255, 216, 255, 1], mime: 'image/jpeg' },
    });
    ipc.readResults.set('/documents/duplicate.jpg', {
      status: 'ok',
      data: { bytes: [255, 216, 255, 1], mime: 'image/jpeg' },
    });
    const rasterizeMermaid = vi.fn(async () => ({
      bytes: Uint8Array.from([137, 80, 78, 71]),
      mime: 'image/png' as const,
    }));
    const remote = 'https://cdn.example/existing.webp';
    const session = createStyledCopyAssetSession({
      assets: [
        image('image-1', './图片/封面 1.jpg'),
        image('image-2', './duplicate.jpg'),
        image('remote', remote),
        mermaid('mermaid-1', 'graph TD;章节-->完成'),
        mermaid('mermaid-2', 'graph TD;章节-->完成'),
      ],
      documentDir: '/documents',
      projectDir: '/project',
      target: 'wechat',
      wechatTheme: 'minimal',
    }, { rasterizeMermaid });

    const preview = await session.resolvePreview();
    expect(preview.kind).toBe('ok');
    expect(ipc.settingsCalls).toBe(0);
    expect(ipc.uploads).toEqual([]);

    await expect(session.resolveFinal('project')).resolves.toEqual({
      kind: 'ok',
      value: {
        'image-1': {
          kind: 'final',
          url: 'https://s3.example/%E5%B0%81%E9%9D%A2%201.jpg',
        },
        'image-2': {
          kind: 'final',
          url: 'https://s3.example/%E5%B0%81%E9%9D%A2%201.jpg',
        },
        remote: { kind: 'final', url: remote },
        'mermaid-1': {
          kind: 'final',
          url: 'https://s3.example/mermaid-1.png',
        },
        'mermaid-2': {
          kind: 'final',
          url: 'https://s3.example/mermaid-1.png',
        },
      },
      warnings: [],
    });
    expect(ipc.settingsCalls).toBe(1);
    expect(ipc.uploads).toEqual([
      {
        provider: 's3',
        bytes: [255, 216, 255, 1],
        filename: '封面 1.jpg',
        mime: 'image/jpeg',
      },
      {
        provider: 's3',
        bytes: [137, 80, 78, 71],
        filename: 'mermaid-1.png',
        mime: 'image/png',
      },
    ]);
    expect(rasterizeMermaid).toHaveBeenCalledTimes(2);
  });

  it('requires an effective host only when prepared bytes need upload', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    ipc.readResults.set('/documents/local.png', {
      status: 'ok',
      data: { bytes: [1, 2, 3], mime: 'image/png' },
    });
    const session = createStyledCopyAssetSession({
      assets: [image('image-1', 'local.png')],
      documentDir: '/documents',
      projectDir: null,
      target: 'zhihu',
      wechatTheme: 'minimal',
    });

    await expect(session.resolveFinal(null)).resolves.toEqual({
      kind: 'error',
      error: { code: 'image_host_unavailable' },
    });
    expect(ipc.settingsCalls).toBe(1);
    expect(ipc.uploads).toEqual([]);
  });

  it('runs at most three unique uploads concurrently', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    ipc.settings.hosts = [
      { id: 'host', name: 'Host', provider: 'imgur', client_id: 'client' },
    ];
    ipc.settings.active_host_id = 'host';
    const assets = Array.from({ length: 7 }, (_, index) => {
      const number = index + 1;
      ipc.readResults.set(`/documents/${number}.png`, {
        status: 'ok',
        data: { bytes: [number], mime: 'image/png' },
      });
      return image(`image-${number}`, `${number}.png`);
    });
    ipc.uploadHandler = async (call) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        status: 'ok',
        data: {
          url: `https://uploads.example/${call.bytes[0]}.png`,
          remote_key: null,
        },
      };
    };
    const session = createStyledCopyAssetSession({
      assets,
      documentDir: '/documents',
      projectDir: null,
      target: 'wechat',
      wechatTheme: 'technical',
    });

    const result = await session.resolveFinal(null);
    expect(result.kind).toBe('ok');
    expect(ipc.uploads).toHaveLength(7);
    expect(ipc.maximumActiveUploads).toBe(3);
  });

  it('aggregates failures and retries only hashes that did not succeed', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    ipc.settings.hosts = [
      { id: 'host', name: 'Host', provider: 'imgur', client_id: 'client' },
    ];
    ipc.settings.active_host_id = 'host';
    for (let number = 1; number <= 3; number += 1) {
      ipc.readResults.set(`/documents/${number}.png`, {
        status: 'ok',
        data: { bytes: [number], mime: 'image/png' },
      });
    }
    const session = createStyledCopyAssetSession({
      assets: [
        image('image-1', '1.png'),
        image('image-2', '2.png'),
        image('image-3', '3.png'),
      ],
      documentDir: '/documents',
      projectDir: null,
      target: 'wechat',
      wechatTheme: 'minimal',
    });
    ipc.uploadHandler = async (call) => {
      if (call.bytes[0] === 2) return { status: 'error', error: 'provider secret' };
      if (call.bytes[0] === 3) {
        return {
          status: 'ok',
          data: { url: 'http://insecure.example/3.png', remote_key: null },
        };
      }
      return {
        status: 'ok',
        data: { url: 'https://uploads.example/1.png', remote_key: null },
      };
    };

    await expect(session.resolveFinal(null)).resolves.toEqual({
      kind: 'error',
      error: {
        code: 'asset_upload_failed',
        failures: [
          { assetId: 'image-2', assetKind: 'image', reason: 'upload_failed' },
          { assetId: 'image-3', assetKind: 'image', reason: 'invalid_hosted_url' },
        ],
      },
    });
    expect(ipc.uploads.map((call) => call.bytes[0])).toEqual([1, 2, 3]);

    ipc.uploadHandler = async (call) => ({
      status: 'ok',
      data: {
        url: `https://uploads.example/${call.bytes[0]}.png`,
        remote_key: null,
      },
    });
    await expect(session.resolveFinal(null)).resolves.toEqual({
      kind: 'ok',
      value: {
        'image-1': { kind: 'final', url: 'https://uploads.example/1.png' },
        'image-2': { kind: 'final', url: 'https://uploads.example/2.png' },
        'image-3': { kind: 'final', url: 'https://uploads.example/3.png' },
      },
      warnings: [],
    });
    expect(ipc.uploads.map((call) => call.bytes[0])).toEqual([1, 2, 3, 2, 3]);
    expect(ipc.reads).toHaveLength(3);
  });

  it('does not reuse a successful hash after the effective host changes', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    ipc.settings.hosts = [
      { id: 'first', name: 'First', provider: 'imgur', client_id: 'client' },
      {
        id: 'second',
        name: 'Second',
        provider: 's3',
        access_key_id: 'key',
        secret_access_key: 'secret',
        bucket: 'bucket',
        region: 'region',
      },
    ];
    ipc.settings.active_host_id = 'first';
    ipc.readResults.set('/documents/local.png', {
      status: 'ok',
      data: { bytes: [9, 8, 7], mime: 'image/png' },
    });
    const session = createStyledCopyAssetSession({
      assets: [image('image-1', 'local.png')],
      documentDir: '/documents',
      projectDir: null,
      target: 'zhihu',
      wechatTheme: 'minimal',
    });

    const first = await session.resolveFinal('first');
    const second = await session.resolveFinal('second');

    expect(first.kind === 'ok' && first.value['image-1']).toEqual({
      kind: 'final',
      url: 'https://imgur.example/local.png',
    });
    expect(second.kind === 'ok' && second.value['image-1']).toEqual({
      kind: 'final',
      url: 'https://s3.example/local.png',
    });
    expect(ipc.uploads.map((call) => call.provider)).toEqual(['imgur', 's3']);
    expect(ipc.reads).toHaveLength(1);
  });

  it('rejects every non-absolute-HTTPS hosted response without caching it', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    ipc.settings.hosts = [
      { id: 'host', name: 'Host', provider: 'imgur', client_id: 'client' },
    ];
    ipc.settings.active_host_id = 'host';
    const invalidUrls = [
      'http://uploads.example/1.png',
      '/relative/2.png',
      'data:image/png;base64,AA==',
      'https://[invalid',
    ];
    for (let number = 1; number <= invalidUrls.length; number += 1) {
      ipc.readResults.set(`/documents/${number}.png`, {
        status: 'ok',
        data: { bytes: [number], mime: 'image/png' },
      });
    }
    ipc.uploadHandler = async (call) => ({
      status: 'ok',
      data: { url: invalidUrls[call.bytes[0] - 1], remote_key: null },
    });
    const session = createStyledCopyAssetSession({
      assets: invalidUrls.map((_, index) => image(`image-${index + 1}`, `${index + 1}.png`)),
      documentDir: '/documents',
      projectDir: null,
      target: 'wechat',
      wechatTheme: 'minimal',
    });

    const result = await session.resolveFinal(null);
    expect(result).toEqual({
      kind: 'error',
      error: {
        code: 'asset_upload_failed',
        failures: invalidUrls.map((_, index) => ({
          assetId: `image-${index + 1}`,
          assetKind: 'image',
          reason: 'invalid_hosted_url',
        })),
      },
    });
    expect(ipc.uploads).toHaveLength(4);
  });

  it('contains SHA-256 failures as an aggregate without starting uploads', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    ipc.settings.hosts = [
      { id: 'host', name: 'Host', provider: 'imgur', client_id: 'client' },
    ];
    ipc.settings.active_host_id = 'host';
    ipc.readResults.set('/documents/local.png', {
      status: 'ok',
      data: { bytes: [1, 2, 3], mime: 'image/png' },
    });
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(
      new Error('raw digest failure'),
    );
    const session = createStyledCopyAssetSession({
      assets: [image('image-1', 'local.png')],
      documentDir: '/documents',
      projectDir: null,
      target: 'wechat',
      wechatTheme: 'minimal',
    });

    await expect(session.resolveFinal(null)).resolves.toEqual({
      kind: 'error',
      error: {
        code: 'asset_upload_failed',
        failures: [{ assetId: 'image-1', assetKind: 'image', reason: 'upload_failed' }],
      },
    });
    expect(ipc.uploads).toEqual([]);
    digest.mockRestore();

    await expect(session.resolveFinal(null)).resolves.toEqual({
      kind: 'ok',
      value: {
        'image-1': { kind: 'final', url: 'https://imgur.example/local.png' },
      },
      warnings: [],
    });
    expect(ipc.uploads).toHaveLength(1);
  });
});

describe('[contract] styled-copy Mermaid raster boundary', () => {
  it('invokes installed Mermaid for a CJK-labelled diagram before the canvas seam', async () => {
    const { createMermaidRasterizer } = await import(
      '$lib/utils/styled-copy/mermaid-raster'
    );
    const rasterInputs: Array<{
      svg: string;
      widthCss: number;
      heightCss: number;
      scale: number;
      background: string;
    }> = [];
    const rasterize = createMermaidRasterizer({
      rasterizeSvg: async (input) => {
        rasterInputs.push(input);
        return Uint8Array.from([137, 80, 78, 71]);
      },
    });

    await expect(rasterize({
      source: 'graph TD;\nA[开始]-->B[完成]',
      background: '#ffffff',
      theme: 'neutral',
      scale: 1,
    })).resolves.toEqual({
      bytes: Uint8Array.from([137, 80, 78, 71]),
      mime: 'image/png',
    });
    expect(rasterInputs).toHaveLength(1);
    expect(rasterInputs[0].svg).toMatch(/^<svg\b/);
    expect(rasterInputs[0].widthCss).toBeGreaterThan(0);
    expect(rasterInputs[0].heightCss).toBeGreaterThan(0);
  });

  it('uses strict protected Mermaid 11 configuration without an application container', async () => {
    const { createMermaidRasterizer } = await import(
      '$lib/utils/styled-copy/mermaid-raster'
    );
    const configs: MermaidConfig[] = [];
    const renderCalls: Array<{ id: string; source: string; container: Element | undefined }> = [];
    const rasterInputs: Array<{
      svg: string;
      widthCss: number;
      heightCss: number;
      scale: number;
      background: string;
    }> = [];
    const rasterize = createMermaidRasterizer({
      loadMermaid: async () => ({
        initialize: (config: MermaidConfig) => configs.push(config),
        render: async (id: string, source: string, container?: Element) => {
          renderCalls.push({ id, source, container });
          return { svg: validSvg() };
        },
      }),
      rasterizeSvg: async (input) => {
        rasterInputs.push(input);
        return Uint8Array.from([137, 80, 78, 71]);
      },
    });

    await expect(rasterize({
      source: 'graph TD;\n章节-->完成',
      background: '#ffffff',
      theme: 'neutral',
      scale: 3,
    })).resolves.toEqual({
      bytes: Uint8Array.from([137, 80, 78, 71]),
      mime: 'image/png',
    });

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      maxTextSize: 50_000,
      deterministicIds: true,
    });
    expect(configs[0].secure).toEqual(expect.arrayContaining([
      'secure',
      'securityLevel',
      'startOnLoad',
      'maxTextSize',
      'suppressErrorRendering',
      'htmlLabels',
      'flowchart',
    ]));
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0].id).toMatch(/^novelist-styled-copy-mermaid-\d+$/);
    expect(renderCalls[0].source).toBe('graph TD;\n章节-->完成');
    expect(renderCalls[0].container).toBeUndefined();
    expect(rasterInputs).toEqual([{
      svg: expect.stringContaining('<svg'),
      widthCss: 640,
      heightCss: 320,
      scale: 2,
      background: '#ffffff',
    }]);
  });

  it('serializes initialize, render, and sanitize across concurrent calls', async () => {
    const { createMermaidRasterizer } = await import(
      '$lib/utils/styled-copy/mermaid-raster'
    );
    const events: string[] = [];
    let activeRenders = 0;
    let maximumActiveRenders = 0;
    const rasterize = createMermaidRasterizer({
      loadMermaid: async () => ({
        initialize: (config: MermaidConfig) => events.push(`init:${config.theme}`),
        render: async (id: string, source: string) => {
          events.push(`start:${source}:${id}`);
          activeRenders += 1;
          maximumActiveRenders = Math.max(maximumActiveRenders, activeRenders);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeRenders -= 1;
          events.push(`end:${source}:${id}`);
          return { svg: validSvg(100, 50) };
        },
      }),
      rasterizeSvg: async () => Uint8Array.from([1]),
    });

    await Promise.all([
      rasterize({ source: 'graph TD;A-->B', background: '#ffffff', theme: 'neutral' }),
      rasterize({ source: 'graph TD;C-->D', background: '#ffffff', theme: 'default' }),
    ]);

    expect(maximumActiveRenders).toBe(1);
    expect(events.map((event) => event.split(':')[0])).toEqual([
      'init', 'start', 'end', 'init', 'start', 'end',
    ]);
    const ids = events
      .filter((event) => event.startsWith('start:'))
      .map((event) => event.split(':').at(-1));
    expect(new Set(ids).size).toBe(2);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><foreignObject/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect onload="alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><use href="https://evil.example/x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>.x{fill:url(https://evil.example/x)}</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><g>',
  ])('rejects unsafe or malformed SVG before rasterization', async (svg) => {
    const { createMermaidRasterizer } = await import(
      '$lib/utils/styled-copy/mermaid-raster'
    );
    const rasterizeSvg = vi.fn(async () => Uint8Array.from([1]));
    const rasterize = createMermaidRasterizer({
      loadMermaid: async () => ({
        initialize: () => undefined,
        render: async () => ({ svg }),
      }),
      rasterizeSvg,
    });

    await expect(rasterize({
      source: 'graph TD;A-->B',
      background: '#ffffff',
      theme: 'neutral',
    })).rejects.toMatchObject({ name: 'MermaidRasterError', reason: 'unsafe_svg' });
    expect(rasterizeSvg).not.toHaveBeenCalled();
  });

  it('rejects excessive Mermaid source before render', async () => {
    const { createMermaidRasterizer, MAX_MERMAID_SOURCE_CHARS } = await import(
      '$lib/utils/styled-copy/mermaid-raster'
    );
    const render = vi.fn(async () => ({ svg: validSvg() }));
    const rasterize = createMermaidRasterizer({
      loadMermaid: async () => ({ initialize: () => undefined, render }),
      rasterizeSvg: async () => Uint8Array.from([1]),
    });

    await expect(rasterize({
      source: 'x'.repeat(MAX_MERMAID_SOURCE_CHARS + 1),
      background: '#ffffff',
      theme: 'neutral',
    })).rejects.toMatchObject({ name: 'MermaidRasterError', reason: 'source_too_large' });
    expect(render).not.toHaveBeenCalled();
  });

  it.each([
    { width: 0, height: 100, scale: 1 },
    { width: 4_097, height: 100, scale: 1 },
    { width: 3_000, height: 3_000, scale: 2 },
  ])('rejects invalid or oversized dimensions before canvas work', async ({ width, height, scale }) => {
    const { createMermaidRasterizer } = await import(
      '$lib/utils/styled-copy/mermaid-raster'
    );
    const rasterizeSvg = vi.fn(async () => Uint8Array.from([1]));
    const rasterize = createMermaidRasterizer({
      loadMermaid: async () => ({
        initialize: () => undefined,
        render: async () => ({ svg: validSvg(width, height) }),
      }),
      rasterizeSvg,
    });

    await expect(rasterize({
      source: 'graph TD;A-->B',
      background: '#ffffff',
      theme: 'neutral',
      scale,
    })).rejects.toMatchObject({ name: 'MermaidRasterError', reason: 'invalid_dimensions' });
    expect(rasterizeSvg).not.toHaveBeenCalled();
  });

  it('creates an opaque canvas, paints background first, and encodes PNG bytes', async () => {
    const { rasterizeSvgToOpaquePng } = await import(
      '$lib/utils/styled-copy/mermaid-raster'
    );
    const events: string[] = [];
    const canvas = document.createElement('canvas');
    const context = {
      fillStyle: '',
      fillRect: vi.fn(() => events.push('fill')),
      drawImage: vi.fn(() => events.push('draw')),
    } as unknown as CanvasRenderingContext2D;
    const getContext = vi.spyOn(canvas, 'getContext').mockReturnValue(context);
    const imageElement = document.createElement('img');

    await expect(rasterizeSvgToOpaquePng({
      svg: validSvg(100, 50),
      widthCss: 100,
      heightCss: 50,
      scale: 2,
      background: '#ffffff',
    }, {
      createCanvas: () => canvas,
      loadSvgImage: async () => imageElement,
      encodePng: async () => Uint8Array.from([137, 80, 78, 71]),
    })).resolves.toEqual(Uint8Array.from([137, 80, 78, 71]));

    expect(getContext).toHaveBeenCalledWith('2d', { alpha: false });
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(100);
    expect(context.fillStyle).toBe('#ffffff');
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 200, 100);
    expect(context.drawImage).toHaveBeenCalledWith(imageElement, 0, 0, 200, 100);
    expect(events).toEqual(['fill', 'draw']);
  });

  it('prepares Mermaid as an opaque PNG preview without uploads', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    const rasterizeMermaid = vi.fn(async () => ({
      bytes: Uint8Array.from([137, 80, 78, 71]),
      mime: 'image/png' as const,
    }));
    const session = createStyledCopyAssetSession({
      assets: [mermaid('mermaid-1', 'graph TD;章节-->完成')],
      documentDir: '/documents',
      projectDir: null,
      target: 'wechat',
      wechatTheme: 'magazine',
      mermaidScale: 2,
    }, { rasterizeMermaid });

    await expect(session.resolvePreview()).resolves.toEqual({
      kind: 'ok',
      value: {
        'mermaid-1': { kind: 'preview', url: 'data:image/png;base64,iVBORw==' },
      },
      warnings: [],
    });
    expect(rasterizeMermaid).toHaveBeenCalledWith({
      source: 'graph TD;章节-->完成',
      background: '#ffffff',
      theme: 'neutral',
      scale: 2,
    });
    expect(ipc.settingsCalls).toBe(0);
    expect(ipc.uploads).toEqual([]);
  });

  it('maps raw Mermaid failures to a path-free blocking asset error', async () => {
    const { createStyledCopyAssetSession } = await import('$lib/services/styled-copy-assets');
    const session = createStyledCopyAssetSession({
      assets: [mermaid('mermaid-1', 'graph TD;A-->B')],
      documentDir: '/secret/document/path',
      projectDir: null,
      target: 'zhihu',
      wechatTheme: 'minimal',
    }, {
      rasterizeMermaid: async () => {
        throw new Error('raw Mermaid parser output with /secret/document/path');
      },
    });

    await expect(session.resolvePreview()).resolves.toEqual({
      kind: 'error',
      error: {
        code: 'asset_resolution_failed',
        failures: [{
          assetId: 'mermaid-1',
          assetKind: 'mermaid',
          reason: 'mermaid_render_failed',
        }],
      },
    });
  });
});
