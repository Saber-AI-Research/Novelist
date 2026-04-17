import { describe, it, expect } from 'vitest';
import { isScratchFile, nextScratchDisplayName } from '$lib/utils/scratch';

describe('isScratchFile', () => {
  it('returns true for valid scratch file paths', () => {
    expect(isScratchFile('/tmp/novelist_scratch_1234567890.md')).toBe(true);
    expect(isScratchFile('/Users/test/novelist_scratch_0.md')).toBe(true);
    expect(isScratchFile('novelist_scratch_999.md')).toBe(true);
  });

  it('returns false for regular markdown files', () => {
    expect(isScratchFile('/Users/test/chapter1.md')).toBe(false);
    expect(isScratchFile('/tmp/notes.md')).toBe(false);
  });

  it('returns false for files with similar but wrong names', () => {
    expect(isScratchFile('/tmp/novelist_scratch_.md')).toBe(false);
    expect(isScratchFile('/tmp/novelist_scratch_abc.md')).toBe(false);
    expect(isScratchFile('/tmp/novelist_scratch_123.txt')).toBe(false);
    expect(isScratchFile('/tmp/scratch_123.md')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isScratchFile('')).toBe(false);
  });

  it('only checks the filename, not parent directories', () => {
    expect(isScratchFile('/novelist_scratch_fake/chapter1.md')).toBe(false);
    expect(isScratchFile('/path/to/novelist_scratch_42.md')).toBe(true);
  });
});

describe('nextScratchDisplayName', () => {
  it('returns incrementing names', () => {
    // Note: This relies on module-level counter state.
    // The first call in this test module gets whatever the counter is at.
    const name1 = nextScratchDisplayName();
    const name2 = nextScratchDisplayName();
    const name3 = nextScratchDisplayName();

    // Each call should produce a unique name
    expect(name1).not.toBe(name2);
    expect(name2).not.toBe(name3);
  });

  it('names contain "Untitled"', () => {
    const name = nextScratchDisplayName();
    expect(name).toContain('Untitled');
  });
});
