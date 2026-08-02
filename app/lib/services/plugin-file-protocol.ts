export function parsePluginFileRevision(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

export function shouldMarkPluginFileSaved(
  latestDocumentToken: string | undefined,
  requestDocumentToken: string,
  latestRevision: number | undefined,
  requestRevision: number | null,
  currentContent: string,
  savedContent: string,
): boolean {
  if (latestDocumentToken !== requestDocumentToken || currentContent !== savedContent) {
    return false;
  }
  return requestRevision === null || latestRevision === requestRevision;
}

export function normalizeSafeProjectRelativePath(value: string): string | null {
  const relativePath = value.replace(/\\/g, '/');
  if (
    !relativePath
    || relativePath.startsWith('/')
    || /^[A-Za-z]:/.test(relativePath)
    || relativePath.split('/').some((part) => part === '..')
  ) {
    return null;
  }
  return relativePath;
}
