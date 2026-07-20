export type PandocFailure = {
  stage: string;
  message: string;
  resolved_binary?: string | null;
  format?: string | null;
  argv_summary?: string[] | null;
  exit_code?: number | null;
  stderr_excerpt?: string | null;
  stderr_truncated?: boolean | null;
  source_path?: string | null;
  probed_paths?: string[] | null;
};

const PANDOC_FAILURE_PREFIX = 'NOVELIST_PANDOC_FAILURE_JSON:';
const MAX_ENVELOPE_LENGTH = 64 * 1024;
const MAX_DETAIL_LENGTH = 1024;
const MAX_PATH_LENGTH = 512;
const MAX_PROBED_PATHS = 8;
const FALLBACK_ERROR = 'Export failed. See application logs for details.';

const SECRET_KEYS = [
  'access_token',
  'api_key',
  'apikey',
  'app_password',
  'client_secret',
  'password',
  'secret',
  'secret_key',
  'token',
].join('|');

export function formatExportError(raw: string): string {
  const diagnostic = parsePandocFailure(raw);
  return diagnostic ? formatPandocFailure(diagnostic) : FALLBACK_ERROR;
}

export function formatCleanupWarning(successMessage: string, warning: PandocFailure): string {
  return `${sanitizeAndBound(successMessage, MAX_DETAIL_LENGTH)}\n\n${formatPandocFailure(warning)}`;
}

function parsePandocFailure(raw: string): PandocFailure | null {
  if (!raw.startsWith(PANDOC_FAILURE_PREFIX) || raw.length > MAX_ENVELOPE_LENGTH) return null;
  try {
    const parsed = JSON.parse(raw.slice(PANDOC_FAILURE_PREFIX.length)) as Partial<PandocFailure>;
    if (!isRecord(parsed) || typeof parsed.stage !== 'string' || typeof parsed.message !== 'string') {
      return null;
    }
    return parsed as PandocFailure;
  } catch {
    return null;
  }
}

function formatPandocFailure(diagnostic: PandocFailure): string {
  const message = sanitizeAndBound(
    typeof diagnostic.message === 'string' ? diagnostic.message : '',
    MAX_DETAIL_LENGTH,
  );
  const stage = typeof diagnostic.stage === 'string' ? diagnostic.stage : '';
  const lines = [stageSummary(stage, message)];
  if (message) lines.push(`Details: ${message}`);
  if (typeof diagnostic.format === 'string' && diagnostic.format) {
    lines.push(`Format: ${sanitizeAndBound(diagnostic.format, 32).toUpperCase()}`);
  }
  if (typeof diagnostic.source_path === 'string' && diagnostic.source_path) {
    lines.push(`Source: ${sanitizeAndBound(diagnostic.source_path, MAX_PATH_LENGTH)}`);
  }
  if (typeof diagnostic.resolved_binary === 'string' && diagnostic.resolved_binary) {
    lines.push(`Binary: ${sanitizeAndBound(diagnostic.resolved_binary, MAX_PATH_LENGTH)}`);
  }
  if (typeof diagnostic.exit_code === 'number' && Number.isFinite(diagnostic.exit_code)) {
    lines.push(`Exit code: ${diagnostic.exit_code}`);
  }
  if (typeof diagnostic.stderr_excerpt === 'string' && diagnostic.stderr_excerpt) {
    const suffix = diagnostic.stderr_truncated === true ? ' (truncated)' : '';
    lines.push(`Pandoc output: ${sanitizeAndBound(diagnostic.stderr_excerpt, MAX_DETAIL_LENGTH)}${suffix}`);
  }
  const checked = (Array.isArray(diagnostic.probed_paths) ? diagnostic.probed_paths : [])
    .filter((path): path is string => typeof path === 'string')
    .slice(0, MAX_PROBED_PATHS)
    .map(path => sanitizeAndBound(path, MAX_PATH_LENGTH));
  if (checked?.length) lines.push(`Checked: ${checked.join(', ')}`);
  return lines.join('\n');
}

function stageSummary(stage: string, message: string): string {
  switch (stage) {
    case 'discovery':
      return 'Pandoc was not found. Install Pandoc or set its path in Settings.';
    case 'input_read':
      return 'Novelist could not read or decode the export source.';
    case 'spawn':
      return 'Pandoc could not be started.';
    case 'timeout_or_cancel':
      return message.toLowerCase().includes('cancel')
        ? 'Pandoc export was cancelled.'
        : 'Pandoc export timed out.';
    case 'exit_non_zero':
      return 'Pandoc could not complete the export.';
    case 'output_decode':
      return 'Pandoc returned output that Novelist could not decode.';
    case 'output_commit':
      return 'Pandoc finished, but Novelist could not save the completed export.';
    case 'cleanup':
      return 'Export completed, but temporary files could not be removed.';
    default:
      return 'Pandoc export failed.';
  }
}

function sanitizeAndBound(value: string, maxLength: number): string {
  let safe = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  safe = safe.replace(
    /\b(authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:\s*[^\r\n]*/gi,
    '$1: <redacted>',
  );
  safe = safe.replace(
    /\b(Bearer|Basic|Ghost|Token)\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;)]+)/gi,
    '$1 <redacted>',
  );
  safe = safe.replace(
    new RegExp(
      `\\b(${SECRET_KEYS})\\s*=\\s*(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s&;,}"']+)`,
      'gi',
    ),
    '$1=<redacted>',
  );
  safe = safe.replace(
    new RegExp(`"(${SECRET_KEYS})"\\s*:\\s*"(?:\\\\.|[^"\\\\])*"`, 'gi'),
    '"$1":"<redacted>"',
  );
  const codePoints = Array.from(safe);
  if (codePoints.length <= maxLength) return safe;
  return `${codePoints.slice(0, maxLength).join('')}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
