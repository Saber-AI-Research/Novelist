import { describe, expect, it } from 'vitest';
import type { ViteOutputBundle } from '../../../plugins/vite-single-file';
import { inlineViteAssets, withPluginContentSecurityPolicy } from '../../../plugins/vite-single-file';

describe('literary plugin single-file build', () => {
  it('inlines relative JavaScript and CSS assets into the entry document', () => {
    const bundle = {
      'assets/index-test.js': {
        type: 'chunk',
        code: 'const $ = true; $&&document.body.focus(); window.__pluginMounted = true;',
      },
      'assets/index-test.css': {
        type: 'asset',
        source: 'body { color: black; }',
      },
    } satisfies ViteOutputBundle;
    const source = '<script type="module" crossorigin src="./assets/index-test.js"></script>'
      + '<link rel="stylesheet" crossorigin href="./assets/index-test.css">';

    const result = inlineViteAssets(source, bundle);

    expect(result.html).toContain(
      '<script type="module" crossorigin>const $ = true; $&&document.body.focus(); window.__pluginMounted = true;</script>',
    );
    expect(result.html).toContain('<style>body { color: black; }</style>');
    expect(result.html).not.toMatch(/(?:src|href)=["']\.\/assets\//);
    expect(result.inlinedFiles).toEqual(new Set([
      'assets/index-test.js',
      'assets/index-test.css',
    ]));
  });
});

function policyOf(html: string): Map<string, string[]> {
  const content = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
  if (!content) throw new Error('no CSP meta');
  return new Map(content.split('; ').map((directive) => {
    const [name, ...sources] = directive.split(' ');
    return [name, sources];
  }));
}

// Enforcement in a real browser (hash match, blocked handlers and network)
// is covered by tests/e2e/specs/plugin-csp.spec.ts.
describe('single-file plugin Content-Security-Policy', () => {
  const html = '<!doctype html><html><head><meta charset="UTF-8"><title>x</title></head>'
    + '<body><script type="module" crossorigin>document.title = "雪夜";</script>'
    + '<script>window.second = true;</script>'
    + '<style>body{color:red}</style></body></html>';

  it('hashes every inline script and allows nothing else to run', () => {
    const scripts = policyOf(withPluginContentSecurityPolicy(html)).get('script-src')!;
    expect(scripts).toHaveLength(2);
    expect(scripts.every((source) => /^'sha256-[A-Za-z0-9+/]+=*'$/.test(source))).toBe(true);
  });

  it('is the first element of <head>, so it governs every later script', () => {
    const result = withPluginContentSecurityPolicy(html);
    expect(result.indexOf('<head><meta http-equiv="Content-Security-Policy"')).toBeGreaterThan(-1);
  });

  it('denies the network, frames, forms and every unlisted source', () => {
    const policy = policyOf(withPluginContentSecurityPolicy(html));
    expect(policy.get('default-src')).toEqual(["'none'"]);
    expect(policy.get('connect-src')).toEqual(["'none'"]);
    expect(policy.get('frame-src')).toEqual(["'none'"]);
    expect(policy.get('form-action')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'none'"]);
    expect(policy.get('img-src')).toEqual(['data:', 'blob:']);
    expect(policy.get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('refuses an entry that still loads an external script', () => {
    expect(() => withPluginContentSecurityPolicy(
      '<html><head></head><body><script type="module" src="./assets/index.js"></script></body></html>',
    )).toThrow(/inline every script/);
  });
});
