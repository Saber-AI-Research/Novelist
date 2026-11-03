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

const REMEMBERED_DIRECTORIES_KEY = 'novelist.cloud.remoteDirectories';

function rememberedKey(endpoint: string, username: string): string {
  return `${endpoint.trim().replace(/\/+$/u, '')}\n${username.trim()}`;
}

function readRemembered(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(REMEMBERED_DIRECTORIES_KEY) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * The folder last used for this endpoint and user, so reconnecting an account
 * (including one created before folders existed, which uses '') keeps the
 * same root instead of silently switching to the default.
 */
export function rememberedWebdavDirectory(endpoint: string, username: string): string | null {
  const value = readRemembered()[rememberedKey(endpoint, username)];
  return typeof value === 'string' ? value : null;
}

export function rememberWebdavDirectory(endpoint: string, username: string, directory: string): void {
  try {
    const all = readRemembered();
    all[rememberedKey(endpoint, username)] = directory;
    localStorage.setItem(REMEMBERED_DIRECTORIES_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: the form falls back to the default folder.
  }
}
