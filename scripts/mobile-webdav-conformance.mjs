#!/usr/bin/env node
// WebDAV conformance smoke test for Novelist cloud sync.
//
// Exercises exactly the protocol features services/webdav.rs and
// services/sync.rs depend on (PROPFIND listings with strong ETags, MKCOL,
// conditional PUT/DELETE with If-None-Match / If-Match, percent-encoded CJK
// paths, no redirects) inside a throwaway collection that is removed again.
//
// Credentials come from NOVELIST_WEBDAV_USER / NOVELIST_WEBDAV_PASSWORD or an
// interactive hidden prompt; they are never accepted as arguments, never
// printed and only sent in the Authorization header.

import { randomBytes } from 'node:crypto';
import readline from 'node:readline';

const USAGE = `Novelist WebDAV conformance smoke test

Usage:
  node scripts/mobile-webdav-conformance.mjs --url <collection URL> [--keep]

  --url    The WebDAV folder URL a user enters in Novelist, for Nextcloud
           https://<host>/remote.php/dav/files/<login>/ (or a subfolder).
           http:// is only accepted for loopback hosts, like the app.
  --keep   Leave the test collection on the server for inspection.

Credentials (never on the command line):
  NOVELIST_WEBDAV_USER       login name (prompted when unset)
  NOVELIST_WEBDAV_PASSWORD   app password (prompted, hidden, when unset)

The test creates novelist-conformance-<time>-<random>/ below the URL and
deletes it afterwards. Exit status 0 means every required check passed.
`;

class Failure extends Error {}

function parseArgs(argv) {
  const options = { keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--') continue; // `pnpm <script> -- …` may forward the separator
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--url') options.url = argv[++i];
    else if (arg.startsWith('--url=')) options.url = arg.slice('--url='.length);
    else throw new Failure(`unknown argument ${JSON.stringify(arg)} (credentials are read from the environment or a prompt)`);
  }
  return options;
}

function validateBaseUrl(raw) {
  if (!raw) throw new Failure('--url is required');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Failure('--url is not a valid URL');
  }
  if (url.username || url.password) throw new Failure('--url must not contain credentials');
  if (url.search || url.hash || raw.includes('#') || raw.includes('?')) throw new Failure('--url must not contain a query or fragment');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback) throw new Failure('http:// is only allowed for loopback hosts; Novelist refuses cleartext WebDAV elsewhere');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Failure('--url must be http(s)');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function ask(question, { hidden }) {
  if (!process.stdin.isTTY) throw new Failure('credentials are not set in the environment and stdin is not a terminal');
  if (!hidden) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    rl.close();
    return answer;
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          done();
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          done();
          reject(new Failure('aborted'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

// ── HTTP ──────────────────────────────────────────────────────────────────

function collectionUrl(base, segments, { collection = false } = {}) {
  const url = new URL(base);
  url.pathname += segments.map(encodeURIComponent).join('/') + (collection && segments.length > 0 ? '/' : '');
  return url;
}

function makeClient(base, user, password) {
  const authorization = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
  return async function request(method, segments, { headers = {}, body, collection = false } = {}) {
    const url = collectionUrl(base, segments, { collection });
    let response;
    try {
      response = await fetch(url, {
        method,
        redirect: 'manual',
        headers: { Authorization: authorization, 'User-Agent': 'Novelist-WebDAV-conformance/1', ...headers },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new Failure(`${method} ${url.pathname} failed: ${error.cause?.code ?? error.message}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.status >= 300 && response.status < 400) {
      throw new Failure(`${method} ${url.pathname} was redirected (${response.status} to ${response.headers.get('location') ?? '?'}); Novelist never follows WebDAV redirects, enter the final URL`);
    }
    if (response.status === 401) throw new Failure(`${method} ${url.pathname} returned 401: login rejected (with 2FA enabled, use an app password)`);
    return { status: response.status, headers: response.headers, bytes, text: bytes.toString('utf8'), path: url.pathname };
  };
}

const isStrong = (etag) => typeof etag === 'string' && etag.trim() !== '' && !etag.trim().startsWith('W/');

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** Minimal multistatus reader: prefix-agnostic, enough for a smoke test. */
function parseMultistatus(xml) {
  const entries = [];
  for (const block of xml.match(/<(?:[\w.-]+:)?response[\s>][\s\S]*?<\/(?:[\w.-]+:)?response>/g) ?? []) {
    const field = (name) => {
      const match = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`).exec(block);
      return match ? decodeXml(match[1].trim()) : undefined;
    };
    const href = field('href') ?? '';
    const path = href.includes('://') ? new URL(href).pathname : href;
    entries.push({
      segments: path.split('/').filter(Boolean).map((part) => decodeURIComponent(part)),
      etag: field('getetag'),
      collection: /<(?:[\w.-]+:)?collection\s*\/>/.test(block),
    });
  }
  return entries;
}

// ── Checks ────────────────────────────────────────────────────────────────

const results = [];

function record(level, name, detail = '') {
  results.push({ level, name });
  const label = { pass: 'PASS', fail: 'FAIL', warn: 'WARN' }[level];
  console.log(`${label}  ${name}${detail ? ` (${detail})` : ''}`);
}

function expect(condition, name, detail) {
  record(condition ? 'pass' : 'fail', name, detail);
  return condition;
}

const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/><d:getetag/><d:resourcetype/></d:prop></d:propfind>';

async function listEtag(request, dir, fileName) {
  const listing = await request('PROPFIND', dir, { headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: PROPFIND_BODY, collection: true });
  if (listing.status !== 207) return { status: listing.status };
  const entry = parseMultistatus(listing.text).find((candidate) => !candidate.collection && candidate.segments.at(-1) === fileName);
  return { status: listing.status, entry };
}

/**
 * Some servers (Apache mod_dav) report a weak ETag for about a second after a
 * write. List again after a pause so a transient weak validator is reported
 * as a warning and only a permanently weak or missing one fails.
 */
async function settledListing(request, dir, fileName) {
  const first = await listEtag(request, dir, fileName);
  if (first.status !== 207 || first.entry === undefined || isStrong(first.entry.etag)) return { ...first, transient: undefined };
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const second = await listEtag(request, dir, fileName);
  return { ...second, transient: first.entry.etag ?? 'none' };
}

function reportSettling(listing) {
  if (listing.transient !== undefined && isStrong(listing.entry?.etag)) {
    record('warn', 'getetag is strong only after a pause', `right after the write it was ${listing.transient}; a sync directly after an upload cannot replace or delete that file until the next sync`);
  }
}

async function conformance(request, keep) {
  const root = `novelist-conformance-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(4).toString('hex')}`;
  const dir = [root, '卷一', '章节 #%'];
  const fileName = '第一章「草稿」.md';
  const file = [...dir, fileName];
  const first = Buffer.from('# 第一章\n\n她说：「你好。」\n', 'utf8');
  const second = Buffer.from('# 第一章\n\n她说：「再见。」\n', 'utf8');
  let created = false;
  try {
    const probe = await request('PROPFIND', [], { headers: { Depth: '0', 'Content-Type': 'application/xml' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', collection: true });
    if (!expect(probe.status === 207, 'PROPFIND Depth 0 on the base URL answers 207 Multi-Status', `got ${probe.status}`)) return;

    const mkcol = await request('MKCOL', [root], { collection: true });
    created = mkcol.status >= 200 && mkcol.status < 300;
    if (!expect(mkcol.status === 201, 'MKCOL creates a collection', `got ${mkcol.status}`)) return;
    const again = await request('MKCOL', [root], { collection: true });
    expect(again.status === 405 || (again.status >= 200 && again.status < 300), 'MKCOL on an existing collection answers 405 (or success)', `got ${again.status}`);
    for (let depth = 2; depth <= dir.length; depth += 1) {
      const nested = await request('MKCOL', dir.slice(0, depth), { collection: true });
      if (!expect(nested.status === 201, `MKCOL with percent-encoded CJK/space/#/% name "${dir[depth - 1]}"`, `got ${nested.status}`)) return;
    }

    const put = await request('PUT', file, { headers: { 'If-None-Match': '*', 'Content-Type': 'text/markdown; charset=utf-8' }, body: first });
    if (!expect(put.status === 201 || put.status === 204, 'PUT with If-None-Match: * creates a new file', `got ${put.status}`)) return;
    const putEtag = put.headers.get('etag');
    record(isStrong(putEtag) ? 'pass' : 'warn', 'PUT response carries a strong ETag', isStrong(putEtag) ? '' : `got ${putEtag ?? 'none'}; Novelist then reads it from the next listing`);

    const clash = await request('PUT', file, { headers: { 'If-None-Match': '*' }, body: second });
    expect(clash.status === 412, 'PUT with If-None-Match: * on an existing file answers 412', `got ${clash.status}`);

    const get = await request('GET', file);
    expect(get.status === 200 && get.bytes.equals(first), 'GET returns the exact UTF-8 bytes', `got ${get.status}`);
    const getEtag = get.headers.get('etag');
    record(isStrong(getEtag) ? 'pass' : 'warn', 'GET response carries a strong ETag', isStrong(getEtag) ? '' : `got ${getEtag ?? 'none'}`);

    const listed = await settledListing(request, dir, fileName);
    if (!expect(listed.status === 207 && listed.entry !== undefined, 'PROPFIND Depth 1 lists the file under its decoded CJK name', `status ${listed.status}`)) return;
    const etag = listed.entry.etag;
    if (!expect(isStrong(etag), 'PROPFIND reports a strong getetag (required for safe replace/delete)', `got ${etag ?? 'none'}`)) return;
    reportSettling(listed);
    if (isStrong(getEtag)) record(getEtag === etag ? 'pass' : 'warn', 'GET ETag equals the listing getetag', getEtag === etag ? '' : 'mismatch costs extra downloads, not correctness');

    const stalePut = await request('PUT', file, { headers: { 'If-Match': '"novelist-conformance-stale"' }, body: second });
    expect(stalePut.status === 412, 'PUT with a stale If-Match answers 412 and keeps the file', `got ${stalePut.status}`);

    const replace = await request('PUT', file, { headers: { 'If-Match': etag, 'Content-Type': 'text/markdown; charset=utf-8' }, body: second });
    if (!expect(replace.status === 200 || replace.status === 201 || replace.status === 204, 'PUT with the current If-Match replaces the file', `got ${replace.status}`)) return;
    const relisted = await settledListing(request, dir, fileName);
    const newEtag = relisted.entry?.etag;
    expect(isStrong(newEtag) && newEtag !== etag, 'the getetag changes when the content changes', `before ${etag}, after ${newEtag ?? 'none'}`);
    reportSettling(relisted);
    const reread = await request('GET', file);
    expect(reread.status === 200 && reread.bytes.equals(second), 'GET returns the replaced bytes', `got ${reread.status}`);

    const staleDelete = await request('DELETE', file, { headers: { 'If-Match': etag } });
    expect(staleDelete.status === 412, 'DELETE with a stale If-Match answers 412 and keeps the file', `got ${staleDelete.status}`);
    if (isStrong(newEtag)) {
      const remove = await request('DELETE', file, { headers: { 'If-Match': newEtag } });
      expect(remove.status === 204 || remove.status === 200, 'DELETE with the current If-Match removes the file', `got ${remove.status}`);
      const gone = await request('GET', file);
      expect(gone.status === 404, 'GET after DELETE answers 404', `got ${gone.status}`);
    }
  } finally {
    if (created && !keep) {
      const cleanup = await request('DELETE', [root], { collection: true }).catch((error) => ({ status: error.message }));
      if (cleanup.status !== 204 && cleanup.status !== 200 && cleanup.status !== 404) console.warn(`WARN  could not delete the test collection ${root}/ (${cleanup.status}); remove it manually`);
    } else if (created) {
      console.log(`kept test collection ${root}/`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const base = validateBaseUrl(options.url);
  const user = process.env.NOVELIST_WEBDAV_USER?.trim() || (await ask('WebDAV login: ', { hidden: false })).trim();
  const password = process.env.NOVELIST_WEBDAV_PASSWORD || (await ask('App password (hidden): ', { hidden: true }));
  if (!user || !password) throw new Failure('login and password are required');
  console.log(`Testing ${base.origin}${base.pathname} as the configured login\n`);
  await conformance(makeClient(base, user, password), options.keep);
  const failed = results.filter((result) => result.level === 'fail').length;
  const warned = results.filter((result) => result.level === 'warn').length;
  console.log(`\n${results.length - failed - warned} passed, ${warned} warnings, ${failed} failed`);
  return failed === 0 && results.length > 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`error: ${error instanceof Failure ? error.message : error.stack ?? error}`);
  process.exitCode = 1;
}
