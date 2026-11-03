import { describe, expect, it } from 'vitest';
import { normalizeWebdavDirectory, webdavDirectoryUrl } from '$lib/services/webdav-directory';

describe('WebDAV application directory boundaries', () => {
  it('keeps nested CJK and space-containing names inside the supplied endpoint', () => {
    const target = webdavDirectoryUrl('https://dav.example.test/users/writer/', '写作空间/长篇 小说');
    expect(target).not.toBeNull();
    const url = new URL(target!);
    expect(url.origin).toBe('https://dav.example.test');
    expect(decodeURIComponent(url.pathname)).toBe('/users/writer/写作空间/长篇 小说/');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
  });

  it('uses the exact supplied directory when the endpoint-folder option is selected', () => {
    expect(webdavDirectoryUrl('https://dav.example.test/already-dedicated', '')).toBe('https://dav.example.test/already-dedicated/');
    expect(normalizeWebdavDirectory('  写作/小说  ')).toBe('写作/小说');
  });

  it('rejects paths that could leave or reinterpret the selected collection', () => {
    for (const directory of ['../other', '/absolute', 'nested/../other', 'nested//child', 'nested/', '.', '%2e%2e', 'folder%2fother', 'https://another.test/folder', 'C:\\folder', 'folder?token=x', 'folder#fragment', 'folder\nchild']) {
      expect(() => normalizeWebdavDirectory(directory)).toThrow('invalid_webdav_directory');
      expect(webdavDirectoryUrl('https://dav.example.test/user/', directory)).toBeNull();
    }
  });

  it('never previews pasted credentials or query secrets as a destination', () => {
    for (const endpoint of ['https://writer:secret@dav.example.test/', 'https://dav.example.test/?token=secret', 'https://dav.example.test/#secret', 'file:///private/data']) {
      expect(webdavDirectoryUrl(endpoint, 'Novelist')).toBeNull();
    }
  });
});
