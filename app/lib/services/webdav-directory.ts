export const DEFAULT_WEBDAV_DIRECTORY = 'Novelist';

/** A logical relative collection path; URL encoding belongs to the native transport. */
export function normalizeWebdavDirectory(value: string): string {
  const directory = value.trim();
  if (new TextEncoder().encode(directory).length > 512
    || /[\\%?#\p{Cc}]/u.test(directory)
    || /^[a-z][a-z0-9+.-]*:/iu.test(directory)
    || (directory !== '' && directory.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))) {
    throw new Error('invalid_webdav_directory');
  }
  return directory;
}

/** Preview only valid server origins/paths; never display embedded credentials. */
export function webdavDirectoryUrl(endpoint: string, remoteDirectory: string): string | null {
  try {
    const url = new URL(endpoint.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    const directory = normalizeWebdavDirectory(remoteDirectory);
    const segments = directory === '' ? [] : directory.split('/').map(encodeURIComponent);
    url.pathname = [url.pathname.replace(/\/+$/u, ''), ...segments].join('/') + '/';
    return url.toString();
  } catch {
    return null;
  }
}
