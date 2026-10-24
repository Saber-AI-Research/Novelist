// @ts-expect-error Vite runs this build plugin in Node; the app tsconfig intentionally omits Node types.
import { createHash } from 'node:crypto';

type BundleItem =
  | { type: 'chunk'; code: string }
  | { type: 'asset'; source: string | Uint8Array };

export type ViteOutputBundle = Record<string, BundleItem>;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeClosingTag(value: string, tag: 'script' | 'style') {
  return value.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`);
}

export function inlineViteAssets(html: string, bundle: ViteOutputBundle) {
  let output = html;
  const inlinedFiles = new Set<string>();

  for (const [fileName, item] of Object.entries(bundle)) {
    const escapedName = escapeRegExp(fileName);
    if (item.type === 'chunk') {
      const scriptPattern = new RegExp(
        `<script([^>]*?)\\s+src=(["'])(?:\\./)?${escapedName}\\2([^>]*)><\\/script>`,
        'g',
      );
      const code = escapeClosingTag(item.code, 'script');
      const next = output.replace(
        scriptPattern,
        (_match, before: string, _quote: string, after: string) => (
          `<script${before}${after}>${code}</script>`
        ),
      );
      if (next !== output) {
        output = next;
        inlinedFiles.add(fileName);
      }
      continue;
    }

    if (!fileName.endsWith('.css')) continue;
    const stylesheetPattern = new RegExp(
      `<link([^>]*?)\\s+href=(["'])(?:\\./)?${escapedName}\\2([^>]*)>`,
      'g',
    );
    const source = typeof item.source === 'string'
      ? item.source
      : new TextDecoder().decode(item.source);
    const css = escapeClosingTag(source, 'style');
    const next = output.replace(stylesheetPattern, () => `<style>${css}</style>`);
    if (next !== output) {
      output = next;
      inlinedFiles.add(fileName);
    }
  }

  return { html: output, inlinedFiles };
}

const SCRIPT_ELEMENT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/**
 * Policy for a single-file plugin document. Only the build's own inline
 * scripts (by SHA-256) may run, so HTML derived from a manuscript cannot
 * execute event handlers or injected scripts, and nothing may reach the
 * network. Plugin iframes are additionally sandboxed into opaque origins.
 */
export function pluginContentSecurityPolicy(scriptHashes: readonly string[]) {
  const scripts = scriptHashes.length > 0
    ? scriptHashes.map((hash) => `'sha256-${hash}'`).join(' ')
    : "'none'";
  return [
    "default-src 'none'",
    `script-src ${scripts}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * Insert the plugin CSP as the first element of `<head>`, hashing every
 * inline script. External scripts are rejected: the policy would block them,
 * and the opaque plugin origin cannot load cross-origin asset modules anyway.
 */
export function withPluginContentSecurityPolicy(html: string) {
  // The HTML parser normalizes newlines before script text reaches the hash.
  const normalized = html.replace(/\r\n?/g, '\n');
  const hashes: string[] = [];
  for (const [, attributes, body] of normalized.matchAll(SCRIPT_ELEMENT)) {
    if (/\ssrc\s*=/i.test(attributes)) {
      throw new Error('Plugin entry must inline every script; found an external <script src>');
    }
    hashes.push(createHash('sha256').update(body, 'utf8').digest('base64'));
  }
  const head = /<head\b[^>]*>/i.exec(normalized);
  if (!head) throw new Error('Plugin entry has no <head> for its Content-Security-Policy');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${pluginContentSecurityPolicy(hashes)}">`;
  const insertAt = head.index + head[0].length;
  return normalized.slice(0, insertAt) + meta + normalized.slice(insertAt);
}

/**
 * Tauri's macOS asset URL encodes an absolute file path as one URL segment.
 * Relative subresources therefore resolve at the protocol root in WKWebView,
 * and the sandboxed (opaque-origin) plugin frame cannot load cross-origin
 * module scripts at all. Keep iframe plugins self-contained so their entry
 * document has no JS or CSS request to resolve, and ship it with a strict CSP.
 */
export function singleFilePlugin() {
  return {
    name: 'novelist-single-file-plugin',
    enforce: 'post' as const,
    generateBundle(_options: unknown, bundle: ViteOutputBundle) {
      const htmlEntry = bundle['index.html'];
      if (!htmlEntry || htmlEntry.type !== 'asset') return;
      const source = typeof htmlEntry.source === 'string'
        ? htmlEntry.source
        : new TextDecoder().decode(htmlEntry.source);
      const result = inlineViteAssets(source, bundle);
      htmlEntry.source = withPluginContentSecurityPolicy(result.html);
      for (const fileName of result.inlinedFiles) delete bundle[fileName];
    },
  };
}
