export type DesktopPlatform = 'macos' | 'windows' | 'linux';

function defaultUserAgent(): string {
  return typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
}

export function detectDesktopPlatform(userAgent = defaultUserAgent()): DesktopPlatform {
  if (/mac|iphone|ipad|ipod/i.test(userAgent)) return 'macos';
  if (/windows/i.test(userAgent)) return 'windows';
  return 'linux';
}

export function fileManagerLabel(platform = detectDesktopPlatform()): string {
  if (platform === 'macos') return 'Reveal in Finder';
  if (platform === 'windows') return 'Show in Explorer';
  return 'Show in File Manager';
}

export function fileManagerLabelKey(platform = detectDesktopPlatform()): string {
  if (platform === 'macos') return 'sidebar.revealInFinder';
  if (platform === 'windows') return 'sidebar.revealInExplorer';
  return 'sidebar.revealInFileManager';
}
