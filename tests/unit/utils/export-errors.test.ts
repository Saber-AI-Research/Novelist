import { describe, expect, it } from 'vitest';
import {
  formatCleanupWarning,
  formatExportError,
  type PandocFailure,
} from '$lib/utils/export-errors';

const PREFIX = 'NOVELIST_PANDOC_FAILURE_JSON:';

function encoded(failure: PandocFailure): string {
  return `${PREFIX}${JSON.stringify(failure)}`;
}

describe('[contract] Export Pandoc diagnostics', () => {
  it('maps discovery to actionable guidance and bounded attempted locations', () => {
    const message = formatExportError(encoded({
      stage: 'discovery',
      message: 'Pandoc not found.',
      format: 'html',
      probed_paths: ['/configured/pandoc', '/opt/homebrew/bin/pandoc'],
    }));

    expect(message).toContain('Pandoc was not found');
    expect(message).toContain('Settings');
    expect(message).toContain('Checked: /configured/pandoc, /opt/homebrew/bin/pandoc');
    expect(message).not.toContain('Pandoc discovery:');
  });

  it('maps timeout without exposing the internal stage tag', () => {
    const message = formatExportError(encoded({
      stage: 'timeout_or_cancel',
      message: 'Pandoc exceeded the 120 second timeout.',
      resolved_binary: '/opt/pandoc-3.10/bin/pandoc',
      format: 'docx',
    }));

    expect(message).toContain('Pandoc export timed out');
    expect(message).toContain('Format: DOCX');
    expect(message).not.toContain('timeout_or_cancel');
  });

  it('maps output commit failures without implying conversion failed', () => {
    const message = formatExportError(encoded({
      stage: 'output_commit',
      message: 'failed to commit completed export: permission denied',
      resolved_binary: '/opt/pandoc-3.10/bin/pandoc',
      format: 'epub',
    }));

    expect(message).toContain('Pandoc finished');
    expect(message).toContain('could not save the completed export');
    expect(message).toContain('Format: EPUB');
  });

  it('maps malformed encoding with CJK context and defense-in-depth redaction', () => {
    const secret = 'SUPER_SECRET_TOKEN_123';
    const message = formatExportError(encoded({
      stage: 'input_read',
      message: `failed to decode source text as GBK; token=${secret}`,
      format: 'epub',
      source_path: '/稿件/第一章-gbk.md',
    }));

    expect(message).toContain('could not read or decode the export source');
    expect(message).toContain('/稿件/第一章-gbk.md');
    expect(message).toContain('token=<redacted>');
    expect(message).not.toContain(secret);
  });

  it('redacts quoted and whitespace-separated credential forms', () => {
    const secrets = ['QUOTED_TOKEN_123', 'SPACED_KEY_456', 'QUOTED_BEARER_789'];
    const message = formatExportError(encoded({
      stage: 'exit_non_zero',
      message: `token="${secrets[0]}" api_key = ${secrets[1]} Bearer "${secrets[2]}"`,
      stderr_excerpt: `password='${secrets[0]}' Token '${secrets[1]}'`,
    }));

    for (const secret of secrets) expect(message).not.toContain(secret);
    expect(message).toContain('<redacted>');
  });

  it('preserves success while rendering a cleanup warning', () => {
    const message = formatCleanupWarning('Export complete: /mock/export.html', {
      stage: 'cleanup',
      message: 'failed to remove temporary export resources: permission denied',
      resolved_binary: '/opt/pandoc-3.10/bin/pandoc',
      format: 'html',
      source_path: '/稿件/第一章.md',
    });

    expect(message).toContain('Export complete: /mock/export.html');
    expect(message).toContain('temporary files could not be removed');
    expect(message).toContain('/稿件/第一章.md');
  });

  it('does not render malformed unstructured backend payloads verbatim', () => {
    const raw = `token=SUPER_SECRET ${'x'.repeat(10_000)}`;
    const message = formatExportError(raw);

    expect(message).toBe('Export failed. See application logs for details.');
    expect(message).not.toContain('SUPER_SECRET');
    expect(message.length).toBeLessThan(200);
  });

  it('ignores malformed optional diagnostic fields without throwing', () => {
    const message = formatExportError(`${PREFIX}${JSON.stringify({
      stage: 'exit_non_zero',
      message: 'Pandoc failed safely.',
      format: { unexpected: true },
      source_path: 42,
      resolved_binary: ['not', 'a', 'path'],
      exit_code: '47',
      stderr_excerpt: { secret: 'do not coerce this object' },
      stderr_truncated: 'yes',
      probed_paths: { path: '/not-an-array' },
    })}`);

    expect(message).toContain('Pandoc could not complete the export');
    expect(message).toContain('Details: Pandoc failed safely.');
    expect(message).not.toContain('[object Object]');
    expect(message).not.toContain('not-an-array');
  });
});
