export function parsePluginFileRevision(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
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
