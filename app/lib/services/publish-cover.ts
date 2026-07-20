export const MAX_PUBLISH_COVER_BYTES = 25 * 1024 * 1024;

export interface CoverBytesInput {
  bytes: Uint8Array;
  declaredMime: string;
}

export interface CoverObjectUrlApi {
  createObjectURL(object: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface CoverObjectUrlOwner {
  readonly current: string | null;
  replace(blob: Blob): string;
  clear(): void;
}

export function shouldUploadPublishCover(
  request: 'create' | 'update',
  changedForAttempt: boolean,
): boolean {
  return request === 'create' || changedForAttempt;
}

export async function readCoverFile(file: File): Promise<CoverBytesInput> {
  if (file.size > MAX_PUBLISH_COVER_BYTES) {
    throw new Error(`Cover image exceeds the 25 MiB (${MAX_PUBLISH_COVER_BYTES} byte) limit.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_PUBLISH_COVER_BYTES) {
    throw new Error(`Cover image exceeds the 25 MiB (${MAX_PUBLISH_COVER_BYTES} byte) limit.`);
  }
  return {
    bytes,
    declaredMime: file.type,
  };
}

export function findClipboardImage(clipboardData: DataTransfer | null): File | null {
  if (!clipboardData) return null;
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== 'file' || !item.type.toLowerCase().startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return Array.from(clipboardData.files ?? []).find((file) =>
    file.type.toLowerCase().startsWith('image/')) ?? null;
}

export function createCoverObjectUrlOwner(
  api: CoverObjectUrlApi = URL,
): CoverObjectUrlOwner {
  let current: string | null = null;
  return {
    get current() {
      return current;
    },
    replace(blob) {
      const next = api.createObjectURL(blob);
      const previous = current;
      current = next;
      if (previous) api.revokeObjectURL(previous);
      return next;
    },
    clear() {
      const previous = current;
      current = null;
      if (previous) api.revokeObjectURL(previous);
    },
  };
}
