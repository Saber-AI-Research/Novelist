export interface PublishUrlPolicy {
  allowHttp: boolean;
}

const FORBIDDEN_RAW_CHARACTER = /[\p{Cc}\p{White_Space}"<>\\^`{|}]/u;
const INVALID_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/iu;
const ABSOLUTE_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;

export function isOpenablePublishUrl(value: string, policy: PublishUrlPolicy): boolean {
  if (FORBIDDEN_RAW_CHARACTER.test(value) || INVALID_PERCENT_ESCAPE.test(value)) return false;

  const authority = ABSOLUTE_AUTHORITY.exec(value)?.[1];
  if (!authority || authority.includes('@')) return false;

  try {
    encodeURI(value);
    const parsed = new URL(value);
    const schemeAllowed = parsed.protocol === 'https:'
      || (policy.allowHttp && parsed.protocol === 'http:');
    const hostname = parsed.hostname.endsWith('.')
      ? parsed.hostname.slice(0, -1)
      : parsed.hostname;
    return schemeAllowed
      && hostname !== ''
      && !hostname.split('.').some((label) => label === '')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}
