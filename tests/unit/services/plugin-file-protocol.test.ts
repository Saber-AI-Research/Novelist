import { describe, expect, it } from 'vitest';
import {
  normalizeSafeProjectRelativePath,
  parsePluginFileRevision,
  shouldMarkPluginFileSaved,
} from '../../../app/lib/services/plugin-file-protocol';

describe('plugin file protocol', () => {
  it('accepts only non-negative integer revisions', () => {
    expect(parsePluginFileRevision(0)).toBe(0);
    expect(parsePluginFileRevision(4)).toBe(4);
    expect(parsePluginFileRevision(-1)).toBeNull();
    expect(parsePluginFileRevision(1.5)).toBeNull();
    expect(parsePluginFileRevision('4')).toBeNull();
  });

  it('marks a save clean only for the latest token, revision, and content', () => {
    expect(shouldMarkPluginFileSaved('token-2', 'token-2', 3, 3, 'new', 'new')).toBe(true);
    expect(shouldMarkPluginFileSaved('token-2', 'token-1', 3, 3, 'new', 'new')).toBe(false);
    expect(shouldMarkPluginFileSaved('token-2', 'token-2', 4, 3, 'new', 'new')).toBe(false);
    expect(shouldMarkPluginFileSaved('token-2', 'token-2', 3, 3, 'newer', 'new')).toBe(false);
  });

  it('confines project-relative navigation', () => {
    expect(normalizeSafeProjectRelativePath('01 卷/0002 第二章.litstudy'))
      .toBe('01 卷/0002 第二章.litstudy');
    expect(normalizeSafeProjectRelativePath('01 卷\\0002 第二章.litstudy'))
      .toBe('01 卷/0002 第二章.litstudy');
    expect(normalizeSafeProjectRelativePath('../outside')).toBeNull();
    expect(normalizeSafeProjectRelativePath('/absolute')).toBeNull();
    expect(normalizeSafeProjectRelativePath('C:\\outside')).toBeNull();
  });
});
