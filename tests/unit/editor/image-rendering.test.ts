import { describe, it, expect } from 'vitest';

/**
 * Image rendering feature tests.
 *
 * Tests the pure logic for image handling:
 * - Markdown image syntax parsing
 * - Image path resolution (relative vs absolute vs URL)
 * - LRU cache behavior
 * - Paste/drop filename generation
 *
 * The actual ImageWidget rendering (DOM, Tauri IPC) is browser-only
 * and covered by E2E tests.
 */

// ── Image syntax parsing ──

/** Extract image info from markdown image syntax: ![alt](src) */
function parseImageSyntax(text: string): { alt: string; src: string } | null {
  const match = text.match(/^!\[([^\]]*)\]\(([^)]*)\)$/);
  if (!match) return null;
  return { alt: match[1], src: match[2] };
}

describe('image syntax parsing', () => {
  it('parses basic image', () => {
    const result = parseImageSyntax('![photo](image.png)');
    expect(result).toEqual({ alt: 'photo', src: 'image.png' });
  });

  it('parses image with empty alt', () => {
    const result = parseImageSyntax('![](image.png)');
    expect(result).toEqual({ alt: '', src: 'image.png' });
  });

  it('parses image with URL source', () => {
    const result = parseImageSyntax('![logo](https://example.com/logo.png)');
    expect(result).toEqual({ alt: 'logo', src: 'https://example.com/logo.png' });
  });

  it('parses image with relative path', () => {
    const result = parseImageSyntax('![](./assets/img.jpg)');
    expect(result).toEqual({ alt: '', src: './assets/img.jpg' });
  });

  it('parses image with data URI', () => {
    const result = parseImageSyntax('![](data:image/png;base64,abc123)');
    expect(result).toEqual({ alt: '', src: 'data:image/png;base64,abc123' });
  });

  it('parses image with CJK alt text', () => {
    const result = parseImageSyntax('![第一章插图](ch1.png)');
    expect(result).toEqual({ alt: '第一章插图', src: 'ch1.png' });
  });

  it('parses image with spaces in alt', () => {
    const result = parseImageSyntax('![a nice photo](img.png)');
    expect(result).toEqual({ alt: 'a nice photo', src: 'img.png' });
  });

  it('returns null for non-image syntax', () => {
    expect(parseImageSyntax('not an image')).toBeNull();
    expect(parseImageSyntax('[link](url)')).toBeNull();  // no !
    expect(parseImageSyntax('![alt only]')).toBeNull();
  });

  it('parses image with empty source', () => {
    const result = parseImageSyntax('![alt]()');
    expect(result).toEqual({ alt: 'alt', src: '' });
  });
});

// ── Image source classification ──

type ImageSourceType = 'http' | 'data' | 'local';

function classifyImageSource(src: string): ImageSourceType {
  if (src.startsWith('http://') || src.startsWith('https://')) return 'http';
  if (src.startsWith('data:')) return 'data';
  return 'local';
}

describe('image source classification', () => {
  it('classifies HTTP URLs', () => {
    expect(classifyImageSource('http://example.com/img.png')).toBe('http');
    expect(classifyImageSource('https://example.com/img.png')).toBe('http');
  });

  it('classifies data URIs', () => {
    expect(classifyImageSource('data:image/png;base64,abc')).toBe('data');
  });

  it('classifies local paths', () => {
    expect(classifyImageSource('./img.png')).toBe('local');
    expect(classifyImageSource('assets/photo.jpg')).toBe('local');
    expect(classifyImageSource('/absolute/path.png')).toBe('local');
    expect(classifyImageSource('.novelist/images/paste.png')).toBe('local');
  });
});

// ── Image path resolution ──

function resolveImagePath(src: string, projectDir: string): string {
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
    return src;
  }
  // Resolve relative path against project directory
  if (src.startsWith('/')) return src;  // absolute path
  return `${projectDir}/${src}`;
}

describe('image path resolution', () => {
  const projectDir = '/Users/test/my-novel';

  it('passes HTTP URLs through unchanged', () => {
    expect(resolveImagePath('https://example.com/img.png', projectDir))
      .toBe('https://example.com/img.png');
  });

  it('passes data URIs through unchanged', () => {
    expect(resolveImagePath('data:image/png;base64,abc', projectDir))
      .toBe('data:image/png;base64,abc');
  });

  it('resolves relative path against project dir', () => {
    expect(resolveImagePath('assets/img.png', projectDir))
      .toBe('/Users/test/my-novel/assets/img.png');
  });

  it('resolves ./ relative path', () => {
    expect(resolveImagePath('./img.png', projectDir))
      .toBe('/Users/test/my-novel/./img.png');
  });

  it('passes absolute paths through', () => {
    expect(resolveImagePath('/absolute/path.png', projectDir))
      .toBe('/absolute/path.png');
  });

  it('resolves .novelist/ path for pasted images', () => {
    expect(resolveImagePath('.novelist/images/paste_123.png', projectDir))
      .toBe('/Users/test/my-novel/.novelist/images/paste_123.png');
  });
});

// ── LRU cache model ──

class LRUCache<K, V> {
  private map = new Map<K, V>();
  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    if (this.map.size >= this.maxSize) {
      const first = this.map.keys().next().value!;
      this.map.delete(first);
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }
}

describe('image LRU cache', () => {
  it('stores and retrieves values', () => {
    const cache = new LRUCache<string, string>(64);
    cache.set('img1.png', 'data:image/png;base64,abc');
    expect(cache.get('img1.png')).toBe('data:image/png;base64,abc');
  });

  it('evicts oldest entry when full', () => {
    const cache = new LRUCache<string, string>(3);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    // Cache is full (3/3), adding one more should evict 'a'
    cache.set('d', '4');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
    expect(cache.get('d')).toBe('4');
    expect(cache.size).toBe(3);
  });

  it('handles max size of 1', () => {
    const cache = new LRUCache<string, string>(1);
    cache.set('a', '1');
    cache.set('b', '2');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('2');
  });

  it('does not exceed max size under repeated sets', () => {
    const cache = new LRUCache<string, string>(64);
    for (let i = 0; i < 100; i++) {
      cache.set(`img_${i}.png`, `data_${i}`);
    }
    expect(cache.size).toBe(64);
  });
});

// ── Paste/drop filename generation ──

function generatePasteFilename(timestamp: number, index: number): string {
  const ts = timestamp;
  return index === 0
    ? `paste_${ts}.png`
    : `paste_${ts}_${index}.png`;
}

function generateDropFilename(originalName: string, timestamp: number): string {
  return `${timestamp}_${originalName}`;
}

describe('image paste filename generation', () => {
  it('generates filename with timestamp', () => {
    const name = generatePasteFilename(1700000000000, 0);
    expect(name).toBe('paste_1700000000000.png');
  });

  it('appends index for multiple pastes', () => {
    const name = generatePasteFilename(1700000000000, 2);
    expect(name).toBe('paste_1700000000000_2.png');
  });
});

describe('image drop filename generation', () => {
  it('prepends timestamp to original filename', () => {
    const name = generateDropFilename('photo.jpg', 1700000000000);
    expect(name).toBe('1700000000000_photo.jpg');
  });

  it('handles filenames with spaces', () => {
    const name = generateDropFilename('my photo.png', 1700000000000);
    expect(name).toBe('1700000000000_my photo.png');
  });
});

// ── Image context menu logic ──

describe('image context menu: source classification for menu items', () => {
  function getContextMenuItems(src: string, projectDir: string): string[] {
    const isLocal = !src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:');
    const items: string[] = ['Copy Image Path'];
    if (isLocal && projectDir) items.push('Reveal in Finder');
    if (src.startsWith('http://') || src.startsWith('https://')) items.push('Open in Browser');
    items.push('Edit Caption', 'Delete Image');
    return items;
  }

  it('local image shows Reveal in Finder', () => {
    const items = getContextMenuItems('./assets/photo.png', '/project');
    expect(items).toContain('Reveal in Finder');
    expect(items).not.toContain('Open in Browser');
  });

  it('HTTP image shows Open in Browser', () => {
    const items = getContextMenuItems('https://example.com/img.png', '/project');
    expect(items).toContain('Open in Browser');
    expect(items).not.toContain('Reveal in Finder');
  });

  it('data URI image shows neither Reveal nor Open in Browser', () => {
    const items = getContextMenuItems('data:image/png;base64,abc', '/project');
    expect(items).not.toContain('Reveal in Finder');
    expect(items).not.toContain('Open in Browser');
  });

  it('local image without project dir omits Reveal in Finder', () => {
    const items = getContextMenuItems('./img.png', '');
    expect(items).not.toContain('Reveal in Finder');
  });

  it('always includes Copy Image Path, Edit Caption, Delete Image', () => {
    for (const src of ['./local.png', 'https://remote.com/img.png', 'data:image/png;base64,abc']) {
      const items = getContextMenuItems(src, '/project');
      expect(items).toContain('Copy Image Path');
      expect(items).toContain('Edit Caption');
      expect(items).toContain('Delete Image');
    }
  });
});

describe('image context menu: edit caption position', () => {
  function findAltTextRange(lineText: string, lineFrom: number): { from: number; to: number } | null {
    const altStart = lineText.indexOf('![');
    if (altStart < 0) return null;
    const from = lineFrom + altStart + 2;
    const closeBracket = lineText.indexOf(']', altStart);
    const to = closeBracket >= 0 ? lineFrom + closeBracket : from;
    return { from, to };
  }

  it('finds alt text range in standard image', () => {
    const result = findAltTextRange('![my photo](image.png)', 0);
    expect(result).toEqual({ from: 2, to: 10 });
  });

  it('finds alt text range with empty alt', () => {
    const result = findAltTextRange('![](image.png)', 0);
    expect(result).toEqual({ from: 2, to: 2 });
  });

  it('respects line offset', () => {
    const result = findAltTextRange('![alt](url)', 100);
    expect(result).toEqual({ from: 102, to: 105 });
  });

  it('handles CJK alt text', () => {
    const text = '![第一章插图](ch1.png)';
    const result = findAltTextRange(text, 0);
    expect(result).not.toBeNull();
    expect(text.slice(result!.from, result!.to)).toBe('第一章插图');
  });

  it('returns null for non-image line', () => {
    expect(findAltTextRange('just text', 0)).toBeNull();
  });
});

describe('image context menu: delete image line', () => {
  function computeDeleteRange(lineFrom: number, lineTo: number, docLength: number): { from: number; to: number } {
    const deleteTo = Math.min(lineTo + 1, docLength);
    return { from: lineFrom, to: deleteTo };
  }

  it('deletes line including trailing newline', () => {
    const doc = '![img](a.png)\nnext line';
    const result = computeDeleteRange(0, 13, doc.length);
    expect(result).toEqual({ from: 0, to: 14 });
    expect(doc.slice(result.to)).toBe('next line');
  });

  it('deletes last line without exceeding doc length', () => {
    const doc = 'first\n![img](a.png)';
    const lineFrom = 6;
    const lineTo = doc.length;
    const result = computeDeleteRange(lineFrom, lineTo, doc.length);
    expect(result.to).toBe(doc.length);
  });

  it('handles single-line document', () => {
    const doc = '![img](a.png)';
    const result = computeDeleteRange(0, doc.length, doc.length);
    expect(result).toEqual({ from: 0, to: doc.length });
  });
});

describe('image context menu: reveal path resolution', () => {
  it('constructs full path for local images', () => {
    const projectDir = '/Users/test/novel';
    const imgSrc = '.novelist/images/paste.png';
    const fullPath = `${projectDir}/${imgSrc}`;
    expect(fullPath).toBe('/Users/test/novel/.novelist/images/paste.png');
  });

  it('handles relative path with subdirectory', () => {
    const projectDir = '/Users/test/novel';
    const imgSrc = 'assets/chapter1/hero.jpg';
    const fullPath = `${projectDir}/${imgSrc}`;
    expect(fullPath).toBe('/Users/test/novel/assets/chapter1/hero.jpg');
  });
});

// ── Markdown image insertion from paste ──

function generatePasteMarkdown(filename: string): string {
  return `![pasted image](.novelist/images/${filename})`;
}

describe('paste image markdown generation', () => {
  it('generates correct markdown with .novelist path', () => {
    const md = generatePasteMarkdown('paste_1700000000000.png');
    expect(md).toBe('![pasted image](.novelist/images/paste_1700000000000.png)');
  });

  it('generated markdown is parseable', () => {
    const md = generatePasteMarkdown('paste_123.png');
    const parsed = parseImageSyntax(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.alt).toBe('pasted image');
    expect(parsed!.src).toBe('.novelist/images/paste_123.png');
  });
});
