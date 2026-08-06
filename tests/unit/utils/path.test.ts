import { describe, expect, it } from 'vitest';
import { pathBasename, pathDirname, pathJoin, pathStartsWithChild, pathsEqual } from '$lib/utils/path';

describe('path utils', () => {
  it('handles POSIX paths', () => {
    expect(pathBasename('/work/novel/chapter.md')).toBe('chapter.md');
    expect(pathDirname('/work/novel/chapter.md')).toBe('/work/novel');
    expect(pathJoin('/work/novel', 'chapter.md')).toBe('/work/novel/chapter.md');
    expect(pathStartsWithChild('/work/novel/sub/chapter.md', '/work/novel')).toBe(true);
    expect(pathStartsWithChild('/work/Novel/sub/chapter.md', '/work/novel')).toBe(false);
    expect(pathsEqual('/work/novel/', '/work/novel')).toBe(true);
    expect(pathsEqual('/work/Novel', '/work/novel')).toBe(false);
  });

  it('handles Windows paths', () => {
    expect(pathBasename('C:\\Users\\me\\novel\\chapter.md')).toBe('chapter.md');
    expect(pathDirname('C:\\Users\\me\\novel\\chapter.md')).toBe('C:\\Users\\me\\novel');
    expect(pathJoin('C:\\Users\\me\\novel', 'chapter.md')).toBe('C:\\Users\\me\\novel\\chapter.md');
    expect(pathStartsWithChild('C:\\Users\\me\\novel\\sub\\chapter.md', 'C:\\Users\\me\\novel')).toBe(true);
    expect(pathStartsWithChild('C:\\Users\\me\\novel\\sub\\chapter.md', 'c:\\users\\me\\novel')).toBe(true);
    expect(pathsEqual('C:\\Users\\me\\novel\\', 'c:\\users\\me\\novel')).toBe(true);
  });
});
