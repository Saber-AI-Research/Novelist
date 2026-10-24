import { describe, expect, it } from 'vitest';
import {
  normalizeSafeProjectRelativePath,
  parsePluginFileRevision,
} from '../../../app/lib/services/plugin-file-protocol';

describe('plugin file protocol', () => {
  it('accepts only non-negative integer revisions', () => {
    expect(parsePluginFileRevision(0)).toBe(0);
    expect(parsePluginFileRevision(4)).toBe(4);
    expect(parsePluginFileRevision(-1)).toBeNull();
    expect(parsePluginFileRevision(1.5)).toBeNull();
    expect(parsePluginFileRevision('4')).toBeNull();
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
