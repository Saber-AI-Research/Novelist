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

/**
 * Tauri's macOS asset URL encodes an absolute file path as one URL segment.
 * Relative subresources therefore resolve at the protocol root in WKWebView.
 * Keep iframe plugins self-contained so their entry document has no relative
 * JS or CSS request to resolve.
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
      htmlEntry.source = result.html;
      for (const fileName of result.inlinedFiles) delete bundle[fileName];
    },
  };
}
