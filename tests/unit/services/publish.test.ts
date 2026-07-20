import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * [contract] services/publish — orchestrator for publishing.
 *
 * Rules under test:
 *   1. stripFrontMatter removes leading `---\n...\n---\n`.
 *   2. extractLocalImageRefs returns local image paths only (skips http/data).
 *   3. rewriteBodyWithUrlMap replaces only the URL portion of `![](...)`
 *      keeping alt text and optional title intact.
 *   4. dispatchPublish routes platform-specific calls correctly:
 *      Medium → no Pandoc conversion; others → Pandoc-converted HTML.
 *   5. Pre-publish image upload uploads each local ref via the
 *      platform's media endpoint and rewrites the body URLs.
 *   6. Cover image upload sets feature_image_url; WP also sets
 *      featured_media_id when attachment_id > 0.
 */

const { calls, mockSettings, mockBytes, persistState, verifyState, uploadState } = vi.hoisted(() => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const mockSettings = {
    channels: [] as Array<{ id: string; name: string; platform: string; [k: string]: unknown }>,
  };
  const mockBytes = new Map<string, number[]>();
  const persistState = {
    error: null as string | null,
    rejection: null as Error | null,
  };
  const verifyState = {
    selfHostedError: null as string | null,
    wordpressComError: null as string | null,
  };
  const uploadState = {
    failingPlatform: null as string | null,
  };
  return { calls, mockSettings, mockBytes, persistState, verifyState, uploadState };
});

vi.mock('$lib/ipc/commands', () => {
  const ok = <T>(data: T) => Promise.resolve({ status: 'ok', data });
  const err = (e: string) => Promise.resolve({ status: 'error', error: e });

  function makeUpload(platform: string) {
    return (bytes: number[], filename: string, _mime: string, _config: { platform: string }) => {
      calls.push({ name: `uploadPostImage_${platform}`, args: [bytes.length, filename] });
      if (uploadState.failingPlatform === platform) return err('media upload rejected');
      return ok({
        url: `https://${platform}.example.com/${filename}`,
        attachment_id: platform.startsWith('wordpress') ? 99 : 0,
      });
    };
  }
  function makePublish(platform: string) {
    return (input: unknown, _config: { platform: string }) => {
      calls.push({ name: `publish_${platform}`, args: [input] });
      const provider_revision = platform === 'ghost'
        ? { provider: 'ghost', updated_at: 'revision-1' }
        : platform === 'medium'
          ? null
          : { provider: 'wordpress', modified: 'revision-1', modified_gmt: null };
      return ok({
        url: `https://${platform}.example.com/post`,
        remote_id: '1',
        operation: 'created',
        provider_revision,
      });
    };
  }

  return {
    commands: {
      getPublishSettings: () => {
        calls.push({ name: 'getPublishSettings', args: [] });
        return ok(mockSettings);
      },
      readImageBytes: (...args: string[]) => {
        calls.push({ name: 'readImageBytes', args });
        const [baseDir, reference] = args;
        const path = `${baseDir.replace(/\/$/, '')}/${reference.replace(/^\.\//, '')}`;
        const bytes = mockBytes.get(path);
        if (!bytes) return err('unsafe_image: unreadable');
        return ok(bytes);
      },
      uploadPostImageGhost: makeUpload('ghost'),
      uploadPostImageWordpressSelfHosted: makeUpload('wordpress_self_hosted'),
      uploadPostImageWordpressCom: makeUpload('wordpress_com'),
      uploadPostImageMedium: makeUpload('medium'),
      verifyWordpressSelfHostedUpdate: (updateTarget: unknown, _config: unknown) => {
        calls.push({ name: 'verifyUpdate_wordpress_self_hosted', args: [updateTarget] });
        if (verifyState.selfHostedError) return err(verifyState.selfHostedError);
        return ok(null);
      },
      verifyWordpressComUpdate: (updateTarget: unknown, _config: unknown) => {
        calls.push({ name: 'verifyUpdate_wordpress_com', args: [updateTarget] });
        if (verifyState.wordpressComError) return err(verifyState.wordpressComError);
        return ok(null);
      },
      publishToGhost: makePublish('ghost'),
      publishToWordpressSelfHosted: makePublish('wordpress_self_hosted'),
      publishToWordpressCom: makePublish('wordpress_com'),
      publishToMedium: makePublish('medium'),
      convertMarkdownToHtml: (markdown: string) => {
        calls.push({ name: 'convertMarkdownToHtml', args: [markdown] });
        return ok(`<html>${markdown}</html>`);
      },
      persistPublishResult: (
        projectDir: string,
        filePath: string,
        channelId: string,
        result: { remote_id: string; url: string; provider_revision?: unknown },
      ) => {
        calls.push({
          name: 'persistPublishResult',
          args: [projectDir, filePath, channelId, result],
        });
        if (persistState.rejection) return Promise.reject(persistState.rejection);
        if (persistState.error) return err(persistState.error);
        return ok({
          post_id: result.remote_id,
          url: result.url,
          provider_revision: result.provider_revision,
          capability: channelId.startsWith('m')
            ? { kind: 'unsupported_update', data: { reason: 'create_only_api' } }
            : { kind: 'updatable' },
        });
      },
    },
  };
});

beforeEach(() => {
  calls.length = 0;
  mockSettings.channels = [];
  mockBytes.clear();
  persistState.error = null;
  persistState.rejection = null;
  verifyState.selfHostedError = null;
  verifyState.wordpressComError = null;
  uploadState.failingPlatform = null;
});

describe('stripFrontMatter', () => {
  it('removes leading YAML front-matter block', async () => {
    const { stripFrontMatter } = await import('$lib/services/publish');
    const out = stripFrontMatter('---\ntitle: x\ntags: [a, b]\n---\n# Heading\n\nBody.');
    expect(out).toBe('# Heading\n\nBody.');
  });
  it('passes through unchanged when no front-matter', async () => {
    const { stripFrontMatter } = await import('$lib/services/publish');
    expect(stripFrontMatter('# Heading\n')).toBe('# Heading\n');
  });
  it('handles CRLF line endings', async () => {
    const { stripFrontMatter } = await import('$lib/services/publish');
    expect(stripFrontMatter('---\r\ntitle: x\r\n---\r\nbody')).toBe('body');
  });
});

describe('extractLocalImageRefs', () => {
  it('returns only local references', async () => {
    const { extractLocalImageRefs } = await import('$lib/services/publish');
    const refs = extractLocalImageRefs(
      '![local](./a.png) ![remote](https://x/b.png) ![root](/c.png) ![alt with space](d.gif "title")',
    );
    expect(refs).toEqual(['./a.png', '/c.png', 'd.gif']);
  });
});

describe('rewriteBodyWithUrlMap', () => {
  it('replaces matching URLs and leaves alt+title intact', async () => {
    const { rewriteBodyWithUrlMap } = await import('$lib/services/publish');
    const map = new Map([['./a.png', 'https://cdn.example.com/x.png']]);
    expect(
      rewriteBodyWithUrlMap('![alt text](./a.png "t") prose ![other](b.png)', map),
    ).toBe('![alt text](https://cdn.example.com/x.png "t") prose ![other](b.png)');
  });
});

describe('dispatchPublish', () => {
  it('routes Medium without Pandoc conversion', async () => {
    mockSettings.channels = [
      { id: 'm', name: 'Medium', platform: 'medium', token: 't' },
    ];
    const { dispatchPublish } = await import('$lib/services/publish');
    await dispatchPublish(
      mockSettings.channels[0] as never,
      {
        title: 'Hi',
        tags: [],
        status: 'public',
      },
      { dir: '/p', text: 'plain' },
    );
    expect(calls.find(c => c.name === 'convertMarkdownToHtml')).toBeUndefined();
    const pub = calls.find(c => c.name === 'publish_medium');
    expect(pub).toBeDefined();
    expect((pub!.args[0] as { body_format: string }).body_format).toBe('markdown');
  });

  it('routes Ghost via Pandoc → HTML', async () => {
    mockSettings.channels = [
      { id: 'g', name: 'Ghost', platform: 'ghost', admin_url: 'x', api_key: 'a:b' },
    ];
    const { dispatchPublish } = await import('$lib/services/publish');
    await dispatchPublish(
      mockSettings.channels[0] as never,
      { title: 'Hi', tags: ['rust'], status: 'draft' },
      { dir: '/p', text: 'hello' },
    );
    expect(calls.find(c => c.name === 'convertMarkdownToHtml')).toBeDefined();
    const pub = calls.find(c => c.name === 'publish_ghost');
    expect(pub).toBeDefined();
    expect((pub!.args[0] as { body_format: string }).body_format).toBe('html');
    expect((pub!.args[0] as { body: string }).body).toBe('<html>hello</html>');
  });

  it('uploads local images and rewrites the body before submission', async () => {
    mockSettings.channels = [
      { id: 'g', name: 'Ghost', platform: 'ghost', admin_url: 'x', api_key: 'a:b' },
    ];
    mockBytes.set('/p/a.png', [1, 2, 3]);
    const { dispatchPublish } = await import('$lib/services/publish');
    await dispatchPublish(
      mockSettings.channels[0] as never,
      { title: 'Hi', tags: [], status: 'draft' },
      { dir: '/p', text: '![](./a.png)' },
    );
    expect(calls.find(c => c.name === 'uploadPostImage_ghost')).toBeDefined();
    const conv = calls.find(c => c.name === 'convertMarkdownToHtml');
    expect((conv!.args[0] as string)).toContain('https://ghost.example.com/a.png');
  });

  it('passes the document directory and raw CJK reference to the Rust-owned capability', async () => {
    mockSettings.channels = [
      { id: 'g', name: 'Ghost', platform: 'ghost', admin_url: 'x', api_key: 'a:b' },
    ];
    mockBytes.set('/project/章节/插图/人物甲.png', [1, 2, 3]);
    const { dispatchPublish } = await import('$lib/services/publish');
    await dispatchPublish(
      mockSettings.channels[0] as never,
      { title: '第一章', tags: [], status: 'draft' },
      {
        dir: '/project/章节',
        projectDir: '/project',
        filePath: '/project/章节/第一章.md',
        text: '![](./插图/人物甲.png)',
      },
    );

    expect(calls.find(call => call.name === 'readImageBytes')?.args).toEqual([
      '/project/章节',
      './插图/人物甲.png',
    ]);
  });

  it.each(['../outside-sentinel.png', '/private/outside-sentinel.png'])(
    'does not upload when Rust rejects unsafe reference %s',
    async (reference) => {
      mockSettings.channels = [
        { id: 'g', name: 'Ghost', platform: 'ghost', admin_url: 'x', api_key: 'a:b' },
      ];
      const { dispatchPublish } = await import('$lib/services/publish');
      await expect(
        dispatchPublish(
          mockSettings.channels[0] as never,
          { title: 'Unsafe', tags: [], status: 'draft' },
          {
            dir: '/project/chapters',
            projectDir: '/project',
            filePath: '/project/chapters/chapter.md',
            text: `![](${reference})`,
          },
        ),
      ).rejects.toThrow(/unsafe_image/);
      expect(calls.find(call => call.name === 'readImageBytes')?.args).toEqual([
        '/project/chapters',
        reference,
      ]);
      expect(calls.filter(call => call.name.startsWith('uploadPostImage_'))).toHaveLength(0);
    },
  );

  it('cover image upload sets feature_image_url and (WP) featured_media_id', async () => {
    mockSettings.channels = [
      {
        id: 'wp',
        name: 'WP',
        platform: 'wordpress_self_hosted',
        site_url: 'x',
        username: 'u',
        app_password: 'p',
      },
    ];
    const { dispatchPublish } = await import('$lib/services/publish');
    await dispatchPublish(
      mockSettings.channels[0] as never,
      {
        title: 'Hi',
        tags: [],
        status: 'draft',
        coverImage: {
          bytes: new Uint8Array([1]),
          filename: 'cover.png',
          mime: 'image/png',
        },
      },
      { dir: '/p', text: 'body' },
    );
    const pub = calls.find(c => c.name === 'publish_wordpress_self_hosted');
    expect(pub).toBeDefined();
    const inp = pub!.args[0] as { feature_image_url?: string; featured_media_id?: number };
    expect(inp.feature_image_url).toBeTruthy();
    expect(inp.featured_media_id).toBe(99);
  });

  it('verifies a tracked self-hosted WordPress revision before body or cover uploads', async () => {
    mockSettings.channels = [
      {
        id: 'wp',
        name: 'WP',
        platform: 'wordpress_self_hosted',
        site_url: 'https://wordpress.example.com',
        username: 'u',
        app_password: 'p',
      },
    ];
    mockBytes.set('/project/章节/插图.png', [1, 2, 3]);
    const { dispatchPublish } = await import('$lib/services/publish');

    await dispatchPublish(
      mockSettings.channels[0] as never,
      {
        title: '第一章',
        tags: [],
        status: 'draft',
        coverImage: {
          bytes: new Uint8Array([4, 5, 6]),
          filename: '封面.png',
          mime: 'image/png',
        },
      },
      {
        dir: '/project/章节',
        projectDir: '/project',
        filePath: '/project/章节/第一章.md',
        text: '![](./插图.png)',
      },
      {
        remote: {
          post_id: '42',
          provider_revision: {
            provider: 'wordpress',
            modified: '2026-07-18T09:00:00',
            modified_gmt: '2026-07-18T01:00:00',
          },
          capability: { kind: 'updatable' },
        },
        intent: { kind: 'default' },
      },
    );

    expect(calls.map(call => call.name)).toEqual([
      'verifyUpdate_wordpress_self_hosted',
      'readImageBytes',
      'uploadPostImage_wordpress_self_hosted',
      'uploadPostImage_wordpress_self_hosted',
      'convertMarkdownToHtml',
      'publish_wordpress_self_hosted',
      'persistPublishResult',
    ]);
    expect(calls[0].args[0]).toEqual({
      remote_id: '42',
      expected_revision: {
        provider: 'wordpress',
        modified: '2026-07-18T09:00:00',
        modified_gmt: '2026-07-18T01:00:00',
      },
    });
  });

  it('verifies a tracked WordPress.com revision before its site-scoped uploads', async () => {
    const channel = {
      id: 'wp-com',
      name: 'WP.com',
      platform: 'wordpress_com',
      site_id_or_domain: 'novel.wordpress.com',
      access_token: 'token',
    };
    mockSettings.channels = [channel];
    mockBytes.set('/project/章节/场景.png', [1, 2, 3]);
    const { dispatchPublish } = await import('$lib/services/publish');

    await dispatchPublish(
      channel as never,
      {
        title: '第二章',
        tags: [],
        status: 'draft',
        coverImage: {
          bytes: new Uint8Array([4, 5, 6]),
          filename: '新封面.png',
          mime: 'image/png',
        },
      },
      {
        dir: '/project/章节',
        projectDir: '/project',
        filePath: '/project/章节/第二章.md',
        text: '![](./场景.png)',
      },
      {
        remote: {
          post_id: '7',
          provider_revision: {
            provider: 'wordpress',
            modified: '2026-07-18T09:00:00',
            modified_gmt: null,
          },
          capability: { kind: 'updatable' },
        },
        intent: { kind: 'default' },
      },
    );

    expect(calls.map(call => call.name)).toEqual([
      'verifyUpdate_wordpress_com',
      'readImageBytes',
      'uploadPostImage_wordpress_com',
      'uploadPostImage_wordpress_com',
      'convertMarkdownToHtml',
      'publish_wordpress_com',
      'persistPublishResult',
    ]);
  });

  it.each([
    ['conflict', JSON.stringify({
      kind: 'update_conflict',
      data: {
        provider: 'wordpress',
        remote_id: '42',
        actual: {
          provider: 'wordpress',
          modified: 'newer',
          modified_gmt: null,
        },
      },
    })],
    ['not found', JSON.stringify({
      kind: 'remote_not_found',
      data: { provider: 'wordpress', remote_id: '42' },
    })],
    ['auth failure', JSON.stringify({
      kind: 'auth',
      data: 'authentication rejected',
    })],
  ])('stops a tracked WordPress %s before all upload and publish side effects', async (_case, error) => {
    const channel = {
      id: 'wp',
      name: 'WP',
      platform: 'wordpress_self_hosted',
      site_url: 'https://wordpress.example.com',
      username: 'u',
      app_password: 'p',
    };
    mockBytes.set('/project/inside.png', [1, 2, 3]);
    verifyState.selfHostedError = error;
    const { dispatchPublish, PublishCommandError } = await import('$lib/services/publish');

    await expect(dispatchPublish(
      channel as never,
      {
        title: 'Guarded',
        tags: [],
        status: 'draft',
        coverImage: {
          bytes: new Uint8Array([4, 5, 6]),
          filename: 'cover.png',
          mime: 'image/png',
        },
      },
      {
        dir: '/project',
        projectDir: '/project',
        filePath: '/project/chapter.md',
        text: '![](./inside.png)',
      },
      {
        remote: {
          post_id: '42',
          provider_revision: {
            provider: 'wordpress',
            modified: 'old',
            modified_gmt: null,
          },
          capability: { kind: 'updatable' },
        },
        intent: { kind: 'default' },
      },
    )).rejects.toBeInstanceOf(PublishCommandError);

    expect(calls.map(call => call.name)).toEqual(['verifyUpdate_wordpress_self_hosted']);
    expect(calls.filter(call => call.name === 'readImageBytes')).toHaveLength(0);
    expect(calls.filter(call => call.name.startsWith('uploadPostImage_'))).toHaveLength(0);
    expect(calls.filter(call => call.name.startsWith('publish_'))).toHaveLength(0);
    expect(calls.filter(call => call.name === 'persistPublishResult')).toHaveLength(0);
  });

  it.each([
    ['conflict', JSON.stringify({
      kind: 'update_conflict',
      data: {
        provider: 'wordpress_com',
        remote_id: '7',
        actual: {
          provider: 'wordpress',
          modified: 'newer',
          modified_gmt: null,
        },
      },
    })],
    ['not found', JSON.stringify({
      kind: 'remote_not_found',
      data: { provider: 'wordpress_com', remote_id: '7' },
    })],
    ['auth failure', JSON.stringify({
      kind: 'auth',
      data: 'authentication rejected',
    })],
  ])('stops a tracked WordPress.com %s before all upload and publish side effects', async (_case, error) => {
    const channel = {
      id: 'wp-com',
      name: 'WP.com',
      platform: 'wordpress_com',
      site_id_or_domain: 'novel.wordpress.com',
      access_token: 'token',
    };
    verifyState.wordpressComError = error;
    const { dispatchPublish, PublishCommandError } = await import('$lib/services/publish');

    await expect(dispatchPublish(
      channel as never,
      {
        title: 'Guarded',
        tags: [],
        status: 'draft',
        coverImage: {
          bytes: new Uint8Array([4, 5, 6]),
          filename: 'cover.png',
          mime: 'image/png',
        },
      },
      {
        dir: '/project',
        projectDir: '/project',
        filePath: '/project/chapter.md',
        text: 'body',
      },
      {
        remote: {
          post_id: '7',
          provider_revision: {
            provider: 'wordpress',
            modified: 'old',
            modified_gmt: null,
          },
          capability: { kind: 'updatable' },
        },
        intent: { kind: 'default' },
      },
    )).rejects.toBeInstanceOf(PublishCommandError);

    expect(calls.map(call => call.name)).toEqual(['verifyUpdate_wordpress_com']);
    expect(calls.filter(call => call.name.startsWith('uploadPostImage_'))).toHaveLength(0);
    expect(calls.filter(call => call.name.startsWith('publish_'))).toHaveLength(0);
    expect(calls.filter(call => call.name === 'persistPublishResult')).toHaveLength(0);
  });

  it.each([
    ['wordpress_self_hosted', 'wp', 'uploadPostImage_wordpress_self_hosted'],
    ['wordpress_com', 'wp-com', 'uploadPostImage_wordpress_com'],
  ] as const)('stops tracked %s after a body-image upload failure without publish or persistence', async (
    platform,
    channelId,
    uploadCall,
  ) => {
    const channel = platform === 'wordpress_self_hosted'
      ? {
          id: channelId,
          name: 'WP',
          platform,
          site_url: 'https://wordpress.example.com',
          username: 'u',
          app_password: 'p',
        }
      : {
          id: channelId,
          name: 'WP.com',
          platform,
          site_id_or_domain: 'novel.wordpress.com',
          access_token: 'token',
        };
    mockBytes.set('/project/inside.png', [1, 2, 3]);
    uploadState.failingPlatform = platform;
    const { dispatchPublish } = await import('$lib/services/publish');

    await expect(dispatchPublish(
      channel as never,
      { title: 'Guarded', tags: [], status: 'draft' },
      {
        dir: '/project',
        projectDir: '/project',
        filePath: '/project/chapter.md',
        text: '![](./inside.png)',
      },
      {
        remote: {
          post_id: platform === 'wordpress_self_hosted' ? '42' : '7',
          provider_revision: {
            provider: 'wordpress',
            modified: 'old',
            modified_gmt: null,
          },
          capability: { kind: 'updatable' },
        },
        intent: { kind: 'default' },
      },
    )).rejects.toThrow(/Image upload failed.*inside\.png.*media upload rejected/);

    expect(calls.map(call => call.name)).toEqual([
      `verifyUpdate_${platform}`,
      'readImageBytes',
      uploadCall,
    ]);
    expect(calls.filter(call => call.name.startsWith('publish_'))).toHaveLength(0);
    expect(calls.filter(call => call.name === 'persistPublishResult')).toHaveLength(0);
  });

  it.each([
    ['wordpress_self_hosted', 'wp', 'uploadPostImage_wordpress_self_hosted'],
    ['wordpress_com', 'wp-com', 'uploadPostImage_wordpress_com'],
  ] as const)('stops tracked %s after a cover upload failure without publish or persistence', async (
    platform,
    channelId,
    uploadCall,
  ) => {
    const channel = platform === 'wordpress_self_hosted'
      ? {
          id: channelId,
          name: 'WP',
          platform,
          site_url: 'https://wordpress.example.com',
          username: 'u',
          app_password: 'p',
        }
      : {
          id: channelId,
          name: 'WP.com',
          platform,
          site_id_or_domain: 'novel.wordpress.com',
          access_token: 'token',
        };
    uploadState.failingPlatform = platform;
    const { dispatchPublish } = await import('$lib/services/publish');

    await expect(dispatchPublish(
      channel as never,
      {
        title: 'Guarded',
        tags: [],
        status: 'draft',
        coverImage: {
          bytes: new Uint8Array([4, 5, 6]),
          filename: '封面.png',
          mime: 'image/png',
        },
      },
      {
        dir: '/project',
        projectDir: '/project',
        filePath: '/project/chapter.md',
        text: 'body',
      },
      {
        remote: {
          post_id: platform === 'wordpress_self_hosted' ? '42' : '7',
          provider_revision: {
            provider: 'wordpress',
            modified: 'old',
            modified_gmt: null,
          },
          capability: { kind: 'updatable' },
        },
        intent: { kind: 'default' },
      },
    )).rejects.toBeInstanceOf(Error);

    expect(calls.map(call => call.name)).toEqual([
      `verifyUpdate_${platform}`,
      uploadCall,
    ]);
    expect(calls.filter(call => call.name.startsWith('publish_'))).toHaveLength(0);
    expect(calls.filter(call => call.name === 'persistPublishResult')).toHaveLength(0);
  });

  it('retries verification after conflict and uploads a changed cover exactly once', async () => {
    const channel = {
      id: 'wp',
      name: 'WP',
      platform: 'wordpress_self_hosted',
      site_url: 'https://wordpress.example.com',
      username: 'u',
      app_password: 'p',
    };
    const remote = {
      post_id: '42',
      provider_revision: {
        provider: 'wordpress' as const,
        modified: 'old',
        modified_gmt: null,
      },
      capability: { kind: 'updatable' as const },
    };
    const payload = {
      title: 'Retry',
      tags: [],
      status: 'draft',
      coverImage: {
        bytes: new Uint8Array([4, 5, 6]),
        filename: 'cover.png',
        mime: 'image/png',
      },
    };
    const doc = {
      dir: '/project',
      projectDir: '/project',
      filePath: '/project/chapter.md',
      text: 'body',
    };
    verifyState.selfHostedError = JSON.stringify({
      kind: 'update_conflict',
      data: {
        provider: 'wordpress',
        remote_id: '42',
        actual: { provider: 'wordpress', modified: 'current', modified_gmt: null },
      },
    });
    const { dispatchPublish } = await import('$lib/services/publish');

    await expect(dispatchPublish(
      channel as never,
      payload,
      doc,
      { remote, intent: { kind: 'default' } },
    )).rejects.toBeDefined();
    verifyState.selfHostedError = null;
    await dispatchPublish(
      channel as never,
      payload,
      doc,
      {
        remote,
        intent: {
          kind: 'overwrite',
          confirmed: true,
          revision: { provider: 'wordpress', modified: 'current', modified_gmt: null },
        },
      },
    );

    expect(calls.filter(call => call.name === 'verifyUpdate_wordpress_self_hosted')).toHaveLength(2);
    expect(calls.filter(call => call.name === 'uploadPostImage_wordpress_self_hosted')).toHaveLength(1);
    expect(calls.filter(call => call.name === 'publish_wordpress_self_hosted')).toHaveLength(1);
    expect(calls.filter(call => call.name === 'persistPublishResult')).toHaveLength(1);
  });

  it('keeps create and confirmed New Copy uploads free of update preflight', async () => {
    const channel = {
      id: 'wp',
      name: 'WP',
      platform: 'wordpress_self_hosted',
      site_url: 'https://wordpress.example.com',
      username: 'u',
      app_password: 'p',
    };
    const payload = {
      title: 'Copy',
      tags: [],
      status: 'draft',
      coverImage: {
        bytes: new Uint8Array([1]),
        filename: 'cover.png',
        mime: 'image/png',
      },
    };
    const doc = { dir: '/project', text: 'body' };
    const { dispatchPublish } = await import('$lib/services/publish');

    await dispatchPublish(channel as never, payload, doc, {
      remote: null,
      intent: { kind: 'default' },
    });
    await dispatchPublish(channel as never, payload, doc, {
      remote: {
        post_id: '42',
        provider_revision: {
          provider: 'wordpress',
          modified: 'old',
          modified_gmt: null,
        },
        capability: { kind: 'updatable' },
      },
      intent: { kind: 'new_copy', confirmed: true },
    });

    expect(calls.filter(call => call.name.startsWith('verifyUpdate_'))).toHaveLength(0);
    expect(calls.filter(call => call.name === 'uploadPostImage_wordpress_self_hosted')).toHaveLength(2);
    expect(calls.filter(call => call.name === 'publish_wordpress_self_hosted')).toHaveLength(2);
  });

  it('leaves tracked Ghost update ordering and cover semantics unchanged', async () => {
    const channel = {
      id: 'g',
      name: 'Ghost',
      platform: 'ghost',
      admin_url: 'https://ghost.example.com',
      api_key: 'id:secret',
    };
    const { dispatchPublish } = await import('$lib/services/publish');

    await dispatchPublish(
      channel as never,
      {
        title: 'Ghost update',
        tags: [],
        status: 'draft',
        coverImage: {
          bytes: new Uint8Array([1]),
          filename: 'cover.png',
          mime: 'image/png',
        },
      },
      { dir: '/project', text: 'body' },
      {
        remote: {
          post_id: 'g1',
          provider_revision: { provider: 'ghost', updated_at: 'old' },
          capability: { kind: 'updatable' },
        },
        intent: { kind: 'default' },
      },
    );

    expect(calls.filter(call => call.name.startsWith('verifyUpdate_'))).toHaveLength(0);
    expect(calls.filter(call => call.name === 'uploadPostImage_ghost')).toHaveLength(1);
    expect(calls.filter(call => call.name === 'publish_ghost')).toHaveLength(1);
  });

  it('skips remote URLs in the body when uploading images', async () => {
    mockSettings.channels = [
      { id: 'g', name: 'Ghost', platform: 'ghost', admin_url: 'x', api_key: 'a:b' },
    ];
    const { dispatchPublish } = await import('$lib/services/publish');
    await dispatchPublish(
      mockSettings.channels[0] as never,
      { title: 'Hi', tags: [], status: 'draft' },
      { dir: '/p', text: '![remote](https://cdn.example.com/x.png)' },
    );
    expect(calls.filter(c => c.name === 'uploadPostImage_ghost')).toHaveLength(0);
  });

  it('strips front-matter before submitting', async () => {
    mockSettings.channels = [
      { id: 'm', name: 'Medium', platform: 'medium', token: 't' },
    ];
    const { dispatchPublish } = await import('$lib/services/publish');
    await dispatchPublish(
      mockSettings.channels[0] as never,
      { title: 'Hi', tags: [], status: 'public' },
      { dir: '/p', text: '---\nx: y\n---\nhello body' },
    );
    const pub = calls.find(c => c.name === 'publish_medium');
    expect((pub!.args[0] as { body: string }).body).toBe('hello body');
  });

  it('image read failure aborts publish with descriptive error', async () => {
    mockSettings.channels = [
      { id: 'g', name: 'Ghost', platform: 'ghost', admin_url: 'x', api_key: 'a:b' },
    ];
    // mockBytes.get('/p/missing.png') will return undefined → err
    const { dispatchPublish } = await import('$lib/services/publish');
    await expect(
      dispatchPublish(
        mockSettings.channels[0] as never,
        { title: 'Hi', tags: [], status: 'draft' },
        { dir: '/p', text: '![](./missing.png)' },
      ),
    ).rejects.toThrow(/missing\.png/);
  });
});

describe('[contract] bindLegacyPublication wrapper', () => {
  const bindCalls: Array<{
    projectDir: string;
    filePath: string;
    channelId: string;
    urlOrId: string;
  }> = [];
  let bindNext: { status: 'ok'; data: unknown } | { status: 'error'; error: string } = {
    status: 'ok',
    data: {},
  };

  beforeEach(async () => {
    bindCalls.length = 0;
    const module = await import('$lib/ipc/commands');
    (module.commands as unknown as {
      bindLegacyPublication: (
        projectDir: string,
        filePath: string,
        channelId: string,
        urlOrId: string,
      ) => Promise<unknown>;
    }).bindLegacyPublication = async (projectDir, filePath, channelId, urlOrId) => {
      bindCalls.push({ projectDir, filePath, channelId, urlOrId });
      return bindNext;
    };
  });

  it('forwards args verbatim and returns the verified binding on ok', async () => {
    const verified = {
      channel_id: 'ghost-personal_1',
      provider: 'ghost',
      remote_id: '0123456789abcdef01234567',
      url: 'https://blog.example.com/hello/',
      revision: { provider: 'ghost', updated_at: '2026-07-16T00:00:00.000Z' },
      capability: { kind: 'updatable' },
    };
    bindNext = { status: 'ok', data: verified };
    const { bindLegacyPublication } = await import('$lib/services/publish');
    const out = await bindLegacyPublication({
      projectDir: '/p',
      filePath: '/p/ch1.md',
      channelId: 'ghost-personal_1',
      urlOrId: '0123456789abcdef01234567',
    });
    expect(bindCalls).toEqual([
      {
        projectDir: '/p',
        filePath: '/p/ch1.md',
        channelId: 'ghost-personal_1',
        urlOrId: '0123456789abcdef01234567',
      },
    ]);
    expect(out).toEqual(verified);
  });

  it('converts typed not-found errors into safe recovery state', async () => {
    bindNext = {
      status: 'error',
      error: JSON.stringify({
        kind: 'remote_not_found',
        data: { provider: 'ghost', remote_id: '0123' },
      }),
    };
    const { bindLegacyPublication, PublishCommandError } = await import('$lib/services/publish');
    await expect(
      bindLegacyPublication({
        projectDir: '/p',
        filePath: '/p/ch1.md',
        channelId: 'ghost-personal_1',
        urlOrId: '0123',
      }),
    ).rejects.toMatchObject({
      constructor: PublishCommandError,
      failure: { state: 'not_found', remoteId: '0123' },
    });
  });

  it('keeps Rust-owned input validation failures visible', async () => {
    bindNext = { status: 'error', error: 'Remote URL or ID is invalid' };
    const { bindLegacyPublication } = await import('$lib/services/publish');
    await expect(
      bindLegacyPublication({
        projectDir: '/p',
        filePath: '/p/ch1.md',
        channelId: 'ghost-personal_1',
        urlOrId: 'bad input',
      }),
    ).rejects.toThrow('Remote URL or ID is invalid');
  });

  it('does not pass credentials — only channelId reaches the IPC boundary', async () => {
    bindNext = {
      status: 'ok',
      data: {
        channel_id: 'ghost-personal_1',
        provider: 'ghost',
        remote_id: '0123456789abcdef01234567',
        url: 'https://blog.example.com/hello/',
        capability: { kind: 'updatable' },
      },
    };
    const { bindLegacyPublication } = await import('$lib/services/publish');
    await bindLegacyPublication({
      projectDir: '/p',
      filePath: '/p/ch1.md',
      channelId: 'ghost-personal_1',
      urlOrId: '0123456789abcdef01234567',
    });
    const [call] = bindCalls;
    expect(call).toBeDefined();
    expect(JSON.stringify(call)).not.toMatch(/api_key|token|password|admin_url/i);
  });

  it('propagates Medium insufficient-scope bind failure without fabricating a binding', async () => {
    bindNext = {
      status: 'error',
      error: JSON.stringify({
        kind: 'unsupported_update',
        data: { provider: 'medium', reason: 'insufficient_scope' },
      }),
    };
    const { bindLegacyPublication, PublishCommandError } = await import('$lib/services/publish');
    await expect(
      bindLegacyPublication({
        projectDir: '/p',
        filePath: '/p/ch1.md',
        channelId: 'medium-personal_1',
        urlOrId: 'https://medium.com/@x/story-abcDEF123',
      }),
    ).rejects.toMatchObject({
      constructor: PublishCommandError,
      failure: { state: 'unsupported' },
    });
    expect(bindCalls).toHaveLength(1);
  });
});

describe('[contract] tracked publish orchestration', () => {
  const channel = {
    id: 'g',
    name: 'Ghost',
    platform: 'ghost',
    admin_url: 'https://ghost.example.com',
    api_key: 'id:secret',
  } as const;
  const doc = {
    dir: '/project',
    text: 'body',
    projectDir: '/project',
    filePath: '/project/chapter.md',
  };

  it('persists a successful create before returning', async () => {
    const { dispatchPublish } = await import('$lib/services/publish');
    const result = await dispatchPublish(
      channel as never,
      { title: 'First', tags: [], status: 'draft' },
      doc,
      { remote: null, intent: { kind: 'default' } },
    );
    expect(result.operation).toBe('created');
    expect(result.remoteIdentity).toMatchObject({
      post_id: '1',
      provider_revision: { provider: 'ghost', updated_at: 'revision-1' },
      capability: { kind: 'updatable' },
    });
    const publish = calls.find(call => call.name === 'publish_ghost');
    expect((publish?.args[0] as { update_target?: unknown }).update_target).toBeUndefined();
    const persist = calls.find(call => call.name === 'persistPublishResult');
    expect(persist?.args.slice(0, 3)).toEqual([
      '/project',
      '/project/chapter.md',
      'g',
    ]);
  });

  it('retains the provider result when identity persistence fails for retry without republish', async () => {
    persistState.error = 'Bearer secret-persistence-token';
    const {
      dispatchPublish,
      persistPublishResult,
      PublishIdentityPersistenceError,
    } = await import('$lib/services/publish');

    let rejected: unknown;
    try {
      await dispatchPublish(
        channel as never,
        { title: 'First', tags: [], status: 'draft' },
        doc,
        { remote: null, intent: { kind: 'default' } },
      );
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(PublishIdentityPersistenceError);
    const pending = (rejected as InstanceType<typeof PublishIdentityPersistenceError>).result;
    expect(pending).toMatchObject({ remote_id: '1', operation: 'created' });
    expect(calls.filter(call => call.name === 'publish_ghost')).toHaveLength(1);
    expect(calls.filter(call => call.name === 'persistPublishResult')).toHaveLength(1);

    persistState.error = null;
    const remote = await persistPublishResult({
      projectDir: doc.projectDir,
      filePath: doc.filePath,
      channelId: channel.id,
      result: pending,
    });
    expect(remote.post_id).toBe('1');
    expect(calls.filter(call => call.name === 'publish_ghost')).toHaveLength(1);
    expect(calls.filter(call => call.name === 'persistPublishResult')).toHaveLength(2);
  });

  it('retains the provider result when identity persistence rejects with an Error', async () => {
    persistState.rejection = new Error('Bearer secret-transport-token');
    const {
      dispatchPublish,
      PublishIdentityPersistenceError,
    } = await import('$lib/services/publish');

    let rejected: unknown;
    try {
      await dispatchPublish(
        channel as never,
        { title: 'First', tags: [], status: 'draft' },
        doc,
        { remote: null, intent: { kind: 'default' } },
      );
    } catch (error) {
      rejected = error;
    }

    expect(rejected).toBeInstanceOf(PublishIdentityPersistenceError);
    expect((rejected as Error).message).not.toContain('secret-transport-token');
    expect((rejected as InstanceType<typeof PublishIdentityPersistenceError>).result)
      .toMatchObject({ remote_id: '1', operation: 'created' });
    expect(calls.filter(call => call.name === 'publish_ghost')).toHaveLength(1);
    expect(calls.filter(call => call.name === 'persistPublishResult')).toHaveLength(1);
  });

  it('updates the same durable ID with its typed expected revision', async () => {
    const commandModule = await import('$lib/ipc/commands');
    (commandModule.commands as unknown as {
      publishToGhost: (input: unknown, config: unknown) => Promise<unknown>;
    }).publishToGhost = async (input) => {
      calls.push({ name: 'publish_ghost', args: [input] });
      return {
        status: 'ok',
        data: {
          url: 'https://ghost.example.com/g1/',
          remote_id: 'g1',
          operation: 'updated',
          provider_revision: { provider: 'ghost', updated_at: 'revision-2' },
        },
      };
    };
    const { dispatchPublish } = await import('$lib/services/publish');
    await dispatchPublish(
      channel as never,
      { title: 'Update', tags: [], status: 'draft' },
      doc,
      {
        remote: {
          post_id: 'g1',
          url: 'https://ghost.example.com/g1/',
          provider_revision: { provider: 'ghost', updated_at: 'revision-1' },
          capability: { kind: 'updatable' },
        },
        intent: { kind: 'default' },
      },
    );
    const publish = calls.find(call => call.name === 'publish_ghost');
    expect((publish?.args[0] as { update_target?: unknown }).update_target).toEqual({
      remote_id: 'g1',
      expected_revision: { provider: 'ghost', updated_at: 'revision-1' },
    });
    expect(calls.filter(call => call.name === 'publish_ghost')).toHaveLength(1);
    expect(calls.filter(call => call.name === 'persistPublishResult')).toHaveLength(1);
  });

  it('surfaces a typed conflict without persisting or sending a create fallback', async () => {
    const commandModule = await import('$lib/ipc/commands');
    (commandModule.commands as unknown as {
      publishToGhost: (input: unknown, config: unknown) => Promise<unknown>;
    }).publishToGhost = async (input) => {
      calls.push({ name: 'publish_ghost', args: [input] });
      return {
        status: 'error',
        error: JSON.stringify({
          kind: 'update_conflict',
          data: {
            provider: 'ghost',
            remote_id: 'g1',
            actual: { provider: 'ghost', updated_at: 'server-revision' },
          },
        }),
      };
    };
    const { dispatchPublish, PublishCommandError } = await import('$lib/services/publish');
    await expect(
      dispatchPublish(
        channel as never,
        { title: 'Conflict', tags: [], status: 'draft' },
        doc,
        {
          remote: {
            post_id: 'g1',
            provider_revision: { provider: 'ghost', updated_at: 'revision-1' },
            capability: { kind: 'updatable' },
          },
          intent: { kind: 'default' },
        },
      ),
    ).rejects.toMatchObject({
      constructor: PublishCommandError,
      failure: {
        state: 'conflict',
        remoteId: 'g1',
        actualRevision: { provider: 'ghost', updated_at: 'server-revision' },
      },
    });
    expect(calls.filter(call => call.name === 'publish_ghost')).toHaveLength(1);
    expect(calls.filter(call => call.name === 'persistPublishResult')).toHaveLength(0);
  });

  it('blocks tracked Medium before cover upload or post request', async () => {
    const { dispatchPublish, PublishCommandError } = await import('$lib/services/publish');
    await expect(
      dispatchPublish(
        {
          id: 'm',
          name: 'Medium',
          platform: 'medium',
          token: 'token',
        } as never,
        {
          title: 'Guarded',
          tags: [],
          status: 'public',
          coverImage: {
            bytes: new Uint8Array([1, 2, 3]),
            filename: 'cover.png',
            mime: 'image/png',
          },
        },
        doc,
        {
          remote: {
            post_id: 'm1',
            url: 'https://medium.com/@author/m1',
            capability: {
              kind: 'unsupported_update',
              data: { reason: 'create_only_api' },
            },
          },
          intent: { kind: 'default' },
        },
      ),
    ).rejects.toMatchObject({
      constructor: PublishCommandError,
      failure: { state: 'unsupported' },
    });
    expect(calls.filter(call => call.name.startsWith('uploadPostImage_'))).toHaveLength(0);
    expect(calls.filter(call => call.name === 'publish_medium')).toHaveLength(0);
    expect(calls.filter(call => call.name === 'persistPublishResult')).toHaveLength(0);
  });
});
