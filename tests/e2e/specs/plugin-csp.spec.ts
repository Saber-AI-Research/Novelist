import { test, expect } from '@playwright/test';
import { withPluginContentSecurityPolicy } from '../../../plugins/vite-single-file';

/**
 * [regression] Bundled plugin entries ship a hash-based CSP (injected by
 * `singleFilePlugin()`). The build's own inline module must still run, while
 * HTML derived from a manuscript — such as a mindmap node rendered with
 * `innerHTML` — can neither execute handlers nor reach the network.
 */

// CRLF line endings exercise the parser's newline normalization before hashing.
const ENTRY_SCRIPT = [
  'document.body.dataset.ran = "1";',
  'const node = document.createElement("div");',
  'node.innerHTML = \'# 第一章 <img src="data:," onerror="document.body.dataset.injected = 1">\';',
  'document.body.append(node);',
  'node.querySelector("img").addEventListener("error", () => { document.body.dataset.imageFailed = "1"; });',
  'fetch("/plugin-csp/exfiltrate").then(',
  '  () => { document.body.dataset.network = "reached"; },',
  '  () => { document.body.dataset.network = "blocked"; },',
  ');',
].join('\r\n');

const ENTRY = withPluginContentSecurityPolicy(
  '<!doctype html><html><head><meta charset="UTF-8"><title>CSP</title></head>'
  + `<body><script type="module" crossorigin>${ENTRY_SCRIPT}</script></body></html>`,
);

test('[regression] plugin CSP runs the bundled script but blocks injected handlers and the network', async ({ page }) => {
  let exfiltrated = false;
  await page.route('**/plugin-csp/entry.html', (route) => route.fulfill({ contentType: 'text/html', body: ENTRY }));
  await page.route('**/plugin-csp/exfiltrate', (route) => {
    exfiltrated = true;
    return route.fulfill({ body: 'ok' });
  });

  await page.goto('/plugin-csp/entry.html');

  const body = page.locator('body');
  await expect(body).toHaveAttribute('data-ran', '1');
  await expect(body).toHaveAttribute('data-network', 'blocked');
  await expect(page.locator('img')).toHaveCount(1);
  // The injected handler would have run during this same error dispatch.
  await expect(body).toHaveAttribute('data-image-failed', '1');
  expect(await body.getAttribute('data-injected')).toBeNull();
  expect(exfiltrated).toBe(false);
});
