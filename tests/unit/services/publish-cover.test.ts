import { describe, expect, it, vi } from 'vitest';
import {
  MAX_PUBLISH_COVER_BYTES,
  createCoverObjectUrlOwner,
  findClipboardImage,
  readCoverFile,
  shouldUploadPublishCover,
} from '$lib/services/publish-cover';

describe('[contract] durable publish cover helpers', () => {
  it('rejects an oversized browser file before allocating its bytes', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const file = {
      size: MAX_PUBLISH_COVER_BYTES + 1,
      type: 'image/png',
      name: 'too-large.png',
      arrayBuffer,
    } as unknown as File;

    await expect(readCoverFile(file)).rejects.toThrow(/25 MiB|26214400/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('reads a file at the limit and preserves only declared metadata for Rust validation', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const file = {
      size: MAX_PUBLISH_COVER_BYTES,
      type: 'image/png',
      name: '封面 image.png',
      arrayBuffer: vi.fn(async () => bytes.buffer),
    } as unknown as File;

    await expect(readCoverFile(file)).resolves.toEqual({
      bytes,
      declaredMime: 'image/png',
    });
  });

  it('creates the replacement URL before revoking the previous URL and clears idempotently', () => {
    const events: string[] = [];
    let next = 0;
    const owner = createCoverObjectUrlOwner({
      createObjectURL: () => {
        const url = `blob:cover-${++next}`;
        events.push(`create:${url}`);
        return url;
      },
      revokeObjectURL: (url) => events.push(`revoke:${url}`),
    });

    expect(owner.replace(new Blob(['first'], { type: 'image/png' }))).toBe('blob:cover-1');
    expect(owner.replace(new Blob(['second'], { type: 'image/png' }))).toBe('blob:cover-2');
    expect(events).toEqual([
      'create:blob:cover-1',
      'create:blob:cover-2',
      'revoke:blob:cover-1',
    ]);
    expect(owner.current).toBe('blob:cover-2');

    owner.clear();
    owner.clear();
    expect(events.at(-1)).toBe('revoke:blob:cover-2');
    expect(events.filter((event) => event === 'revoke:blob:cover-2')).toHaveLength(1);
    expect(owner.current).toBeNull();
  });

  it('keeps the active URL when replacement URL creation fails', () => {
    const revokeObjectURL = vi.fn();
    let shouldFail = false;
    const owner = createCoverObjectUrlOwner({
      createObjectURL: () => {
        if (shouldFail) throw new Error('blob allocation failed');
        return 'blob:active';
      },
      revokeObjectURL,
    });
    owner.replace(new Blob(['valid']));
    shouldFail = true;

    expect(() => owner.replace(new Blob(['replacement']))).toThrow('blob allocation failed');
    expect(owner.current).toBe('blob:active');
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('uses a ClipboardEvent image item before the files fallback and ignores text', () => {
    const direct = new File(['direct'], 'direct.png', { type: 'image/png' });
    const fallback = new File(['fallback'], 'fallback.png', { type: 'image/png' });
    const clipboard = {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => direct }],
      files: [fallback],
    } as unknown as DataTransfer;
    expect(findClipboardImage(clipboard)).toBe(direct);

    const filesOnly = { items: [], files: [fallback] } as unknown as DataTransfer;
    expect(findClipboardImage(filesOnly)).toBe(fallback);

    const textOnly = {
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      files: [],
    } as unknown as DataTransfer;
    expect(findClipboardImage(textOnly)).toBeNull();
  });

  it('uploads durable covers for creates or explicit changes, not unchanged restores', () => {
    expect(shouldUploadPublishCover('create', false)).toBe(true);
    expect(shouldUploadPublishCover('create', true)).toBe(true);
    expect(shouldUploadPublishCover('update', false)).toBe(false);
    expect(shouldUploadPublishCover('update', true)).toBe(true);
  });
});
