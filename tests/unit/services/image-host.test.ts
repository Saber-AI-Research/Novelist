import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * [contract] services/image-host — orchestrator for image-host uploads.
 *
 * Rules under test:
 *   1. resolveActiveHost honors per-project override over global default.
 *   2. dispatchUpload routes to the matching uploadImage<Provider> command
 *      based on the discriminant.
 *   3. uploadAllInDocument skips already-remote URLs, continues past
 *      per-image failures, and returns a successes/failures report.
 *   4. extractImageRefs / resolveImagePath handle the common Markdown
 *      shapes correctly.
 */

const { calls, mockSettings } = vi.hoisted(() => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const mockSettings = {
    hosts: [] as Array<{ id: string; name: string; provider: string; [k: string]: unknown }>,
    active_host_id: undefined as string | undefined,
    auto_on_paste: false,
  };
  return { calls, mockSettings };
});

vi.mock('$lib/ipc/commands', () => {
  // tiny success-result wrapper matching the typedError shape
  const ok = <T>(data: T) => Promise.resolve({ status: 'ok', data });
  const err = (e: string) => Promise.resolve({ status: 'error', error: e });

  type DispatchOutput = { url: string; remote_key: string | null };
  function makeUpload(provider: string) {
    return (bytes: number[], filename: string, mime: string, config: { provider: string }) => {
      calls.push({ name: `upload_${provider}`, args: [bytes, filename, mime, config] });
      if ((mockSettings as { _force_failure?: string })._force_failure === provider) {
        return err('forced failure');
      }
      return ok<DispatchOutput>({ url: `https://${provider}.example.com/${filename}`, remote_key: null });
    };
  }

  return {
    commands: {
      getImageHostSettings: () => {
        calls.push({ name: 'getImageHostSettings', args: [] });
        return ok(mockSettings);
      },
      readImageBytes: (path: string) => {
        calls.push({ name: 'readImageBytes', args: [path] });
        return ok([1, 2, 3]);
      },
      uploadImageQiniu: makeUpload('qiniu'),
      uploadImageAliyunOss: makeUpload('aliyun_oss'),
      uploadImageS3: makeUpload('s3'),
      uploadImageImgur: makeUpload('imgur'),
      uploadImageSmms: makeUpload('smms'),
      uploadImageCustom: makeUpload('custom'),
    },
  };
});

beforeEach(() => {
  calls.length = 0;
  mockSettings.hosts = [];
  mockSettings.active_host_id = undefined;
  mockSettings.auto_on_paste = false;
  delete (mockSettings as { _force_failure?: string })._force_failure;
});

describe('resolveActiveHost', () => {
  it('uses project override when set and present in hosts', async () => {
    const { resolveActiveHost } = await import('$lib/services/image-host');
    const host = resolveActiveHost(
      {
        hosts: [
          { id: 'g', name: 'Global', provider: 'imgur', client_id: 'g' } as never,
          { id: 'p', name: 'Project', provider: 'imgur', client_id: 'p' } as never,
        ],
        active_host_id: 'g',
        auto_on_paste: false,
      },
      'p',
    );
    expect(host?.id).toBe('p');
  });

  it('falls through to global active when project override is unset', async () => {
    const { resolveActiveHost } = await import('$lib/services/image-host');
    const host = resolveActiveHost(
      {
        hosts: [{ id: 'g', name: 'Global', provider: 'imgur', client_id: 'g' } as never],
        active_host_id: 'g',
        auto_on_paste: false,
      },
      null,
    );
    expect(host?.id).toBe('g');
  });

  it('falls through to global active when project override is stale', async () => {
    const { resolveActiveHost } = await import('$lib/services/image-host');
    const host = resolveActiveHost(
      {
        hosts: [{ id: 'g', name: 'Global', provider: 'imgur', client_id: 'g' } as never],
        active_host_id: 'g',
        auto_on_paste: false,
      },
      'removed-project-host',
    );
    expect(host?.id).toBe('g');
  });

  it('returns null when no host is configured', async () => {
    const { resolveActiveHost } = await import('$lib/services/image-host');
    const host = resolveActiveHost(
      { hosts: [], active_host_id: undefined, auto_on_paste: false },
      null,
    );
    expect(host).toBeNull();
  });

  it('returns null when active_host_id points at a missing host', async () => {
    const { resolveActiveHost } = await import('$lib/services/image-host');
    const host = resolveActiveHost(
      { hosts: [], active_host_id: 'nope', auto_on_paste: false },
      null,
    );
    expect(host).toBeNull();
  });
});

describe('dispatchUpload', () => {
  it('routes qiniu config to upload_image_qiniu', async () => {
    const { dispatchUpload } = await import('$lib/services/image-host');
    const cfg = {
      provider: 'qiniu',
      access_key: 'ak',
      secret_key: 'sk',
      bucket: 'b',
      domain: 'd',
    } as const;
    await dispatchUpload(cfg, [1, 2], 'x.png', 'image/png');
    expect(calls.find(c => c.name === 'upload_qiniu')).toBeDefined();
    expect(calls.find(c => c.name === 'upload_imgur')).toBeUndefined();
  });

  it('routes s3 config to upload_image_s3', async () => {
    const { dispatchUpload } = await import('$lib/services/image-host');
    const cfg = {
      provider: 's3',
      access_key_id: 'AK',
      secret_access_key: 'SK',
      bucket: 'b',
      region: 'us-east-1',
    } as const;
    await dispatchUpload(cfg, [1], 'x.png', 'image/png');
    expect(calls.find(c => c.name === 'upload_s3')).toBeDefined();
  });

  it('throws when the upload command returns error status', async () => {
    const { dispatchUpload } = await import('$lib/services/image-host');
    (mockSettings as { _force_failure?: string })._force_failure = 'imgur';
    await expect(
      dispatchUpload({ provider: 'imgur', client_id: 'x' } as const, [1], 'x.png', 'image/png'),
    ).rejects.toThrow(/forced failure/);
  });
});

describe('uploadAllInDocument', () => {
  it('skips remote URLs and uploads locals', async () => {
    mockSettings.hosts = [{ id: 'h', name: 'h', provider: 'imgur', client_id: 'x' } as never];
    mockSettings.active_host_id = 'h';
    const { uploadAllInDocument } = await import('$lib/services/image-host');
    const doc = `
      Some text.
      ![local](./assets/foo.png)
      ![remote](https://cdn.example.com/already.png)
      ![root](/abs/path.png)
    `;
    const report = await uploadAllInDocument(doc, '/proj');
    expect(report.successes).toHaveLength(2); // local relative + root abs
    expect(report.failures).toHaveLength(0);
    expect(report.successes.map(s => s.original)).toEqual(['./assets/foo.png', '/abs/path.png']);
  });

  it('continues past failures and reports them', async () => {
    mockSettings.hosts = [{ id: 'h', name: 'h', provider: 'imgur', client_id: 'x' } as never];
    mockSettings.active_host_id = 'h';
    (mockSettings as { _force_failure?: string })._force_failure = 'imgur';
    const { uploadAllInDocument } = await import('$lib/services/image-host');
    const report = await uploadAllInDocument(
      '![a](./a.png) ![b](./b.png)',
      '/proj',
    );
    expect(report.successes).toHaveLength(0);
    expect(report.failures).toHaveLength(2);
    expect(report.failures[0].error).toMatch(/forced failure/);
  });

  it('throws NoActiveHostError when no host is configured', async () => {
    const { uploadAllInDocument, NoActiveHostError } = await import('$lib/services/image-host');
    await expect(uploadAllInDocument('![a](./a.png)', '/proj')).rejects.toBeInstanceOf(
      NoActiveHostError,
    );
  });
});

describe('extractImageRefs', () => {
  it('captures every ![](path) target', async () => {
    const { extractImageRefs } = await import('$lib/services/image-host');
    const refs = extractImageRefs(
      '![a](./a.png) intermediate ![](b.jpg) and ![alt with space](c.gif "title")',
    );
    expect(refs).toEqual(['./a.png', 'b.jpg', 'c.gif']);
  });

  it('returns empty array when document has no images', async () => {
    const { extractImageRefs } = await import('$lib/services/image-host');
    expect(extractImageRefs('plain text [link](http://x)')).toEqual([]);
  });
});

describe('resolveImagePath', () => {
  it('preserves absolute URLs and data URIs', async () => {
    const { resolveImagePath } = await import('$lib/services/image-host');
    expect(resolveImagePath('/proj', 'https://cdn.example.com/x')).toBe(
      'https://cdn.example.com/x',
    );
    expect(resolveImagePath('/proj', 'data:image/png;base64,iVBORw0KG=')).toBe(
      'data:image/png;base64,iVBORw0KG=',
    );
  });

  it('joins relative paths against docDir and strips ./', async () => {
    const { resolveImagePath } = await import('$lib/services/image-host');
    expect(resolveImagePath('/proj', './assets/x.png')).toBe('/proj/assets/x.png');
    expect(resolveImagePath('/proj/', 'b.png')).toBe('/proj/b.png');
  });

  it('preserves root-absolute paths', async () => {
    const { resolveImagePath } = await import('$lib/services/image-host');
    expect(resolveImagePath('/proj', '/abs/x.png')).toBe('/abs/x.png');
  });
});
