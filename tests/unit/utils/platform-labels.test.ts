import { describe, expect, it } from 'vitest';
import { detectDesktopPlatform, fileManagerLabel, fileManagerLabelKey } from '$lib/utils/platform-labels';

describe('platform labels', () => {
  it('detects macOS from the browser user agent', () => {
    expect(detectDesktopPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos');
  });

  it('detects Windows from the browser user agent', () => {
    expect(detectDesktopPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
  });

  it('falls back to linux-style labels for other desktop user agents', () => {
    expect(detectDesktopPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  it('uses platform-native file manager names', () => {
    expect(fileManagerLabel('macos')).toBe('Reveal in Finder');
    expect(fileManagerLabel('windows')).toBe('Show in Explorer');
    expect(fileManagerLabel('linux')).toBe('Show in File Manager');
  });

  it('maps platforms to sidebar i18n keys', () => {
    expect(fileManagerLabelKey('macos')).toBe('sidebar.revealInFinder');
    expect(fileManagerLabelKey('windows')).toBe('sidebar.revealInExplorer');
    expect(fileManagerLabelKey('linux')).toBe('sidebar.revealInFileManager');
  });
});
