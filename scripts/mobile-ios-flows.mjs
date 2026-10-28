// Real user flows for the iOS simulator smoke (scripts/mobile-ios-smoke.mjs),
// driven through tauri-plugin-playwright: every action is JavaScript the
// plugin evaluates in the app's WKWebView, every native call is the app's own
// Tauri IPC (`window.__TAURI_INTERNALS__.invoke`), and every result is checked
// against the host file system of the simulator's app container, the app
// bundle, the repository or the loopback WebDAV server's files. Nothing is
// mocked, routed or stubbed.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import zlib from 'node:zlib';
import { listFiles } from './mobile-webdav.mjs';

const q = JSON.stringify;
const POLL_MS = 250;
const LITERARY_PLUGIN = 'literary-commentary';
const LITERARY_FRAME = 'iframe[title="文学评注"]';
const LOAD_STATE = '[data-testid="plugin-file-load-state"]';
const DIRTY = '.mobile-toolbar-dirty';
const FILES_BUTTON = '[data-testid="mobile-files-button"]';
// Extensions project sync uploads (core/src/services/project_files.rs).
const SYNCED_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'json', 'jsonl', 'csv', 'litstudy', 'novtrans', 'canvas', 'kanban']);

function fail(message, hints = []) {
  throw Object.assign(new Error(message), { hints: hints.filter(Boolean) });
}

function check(condition, message, hints) {
  if (!condition) fail(message, hints);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readBytes(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function realpath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/** `child` is `parent` or below it (both resolved). */
function within(child, parent) {
  const relative = path.relative(realpath(parent) ?? parent, realpath(child) ?? child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Body of a template file: everything after the closing `---` front-matter fence. */
function templateBody(raw) {
  const text = raw.replace(/^\uFEFF/, '');
  const lines = text.split(/(?<=\n)/);
  if (lines[0]?.replace(/\r?\n$/, '') !== '---') fail('repository template does not start with a --- fence');
  let consumed = lines[0].length;
  for (const line of lines.slice(1)) {
    consumed += line.length;
    if (line.replace(/\r?\n$/, '') === '---') return text.slice(consumed);
  }
  fail('repository template has no closing --- fence');
}

/** First `[outline] order` entry of a project.toml. */
function firstOutlineEntry(toml) {
  const order = /^\[outline\][^[]*?^order\s*=\s*\[\s*"((?:[^"\\]|\\.)*)"/ms.exec(toml)?.[1];
  return order === undefined ? undefined : JSON.parse(`"${order}"`);
}

function findFile(dir, suffix, depth = 8) {
  let found = null;
  const walk = (current, level) => {
    if (found || level > depth) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isFile() && full.endsWith(suffix)) {
        found = full;
        return;
      }
      if (entry.isDirectory()) walk(full, level + 1);
    }
  };
  walk(dir, 0);
  return found;
}

/** Files below `dir` (at most `limitBytes` each) whose bytes contain any of `needles`. */
function filesContaining(dir, needles, limitBytes = 16 * 1024 * 1024) {
  const hits = [];
  const buffers = needles.map((needle) => Buffer.from(needle));
  for (const rel of listFiles(dir)) {
    const full = path.join(dir, rel);
    let size;
    try {
      size = fs.statSync(full).size;
    } catch {
      continue;
    }
    if (size > limitBytes) continue;
    const bytes = readBytes(full);
    if (bytes && buffers.some((needle) => bytes.includes(needle))) hits.push(rel);
  }
  return hits;
}

// ── PNG pixels (simctl screenshots: 8-bit RGB/RGBA, not interlaced) ────────

function decodePng(file) {
  const data = fs.readFileSync(file);
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] };
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!header) fail(`${path.basename(file)} has no PNG header`);
  const channels = { 2: 3, 6: 4 }[header.colorType];
  if (header.depth !== 8 || !channels || header.interlace !== 0) {
    fail(`${path.basename(file)} is a PNG this check does not read (bit depth ${header.depth}, color type ${header.colorType}, interlace ${header.interlace})`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) fail(`${path.basename(file)} uses unknown PNG filter ${filter}`);
      out[x] = value & 0xff;
    }
  }
  return { width: header.width, height: header.height, channels, pixels };
}

/**
 * Colour statistics of a screenshot region (device pixels): how many pixels
 * differ from the region's most common colour, and how many distinct
 * colours (5 bits per channel) it has. A blank or uniformly filled frame has
 * almost no pixels off its background.
 */
function regionInk(png, region) {
  const counts = new Map();
  let total = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) {
      const i = (y * png.width + x) * png.channels;
      const key = ((png.pixels[i] >> 3) << 10) | ((png.pixels[i + 1] >> 3) << 5) | (png.pixels[i + 2] >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total += 1;
    }
  }
  const dominant = Math.max(0, ...counts.values());
  return { pixels: total, offBackground: total - dominant, distinctColours: counts.size };
}

// ── Page helpers ──────────────────────────────────────────────────────────

class Flow {
  constructor(session) {
    this.session = session;
  }

  get page() {
    return this.session.page;
  }

  /** The app's own command over Tauri IPC (rejects with the command's error text). */
  async invoke(command, args = {}) {
    try {
      return await this.page.evaluate(`window.__TAURI_INTERNALS__.invoke(${q(command)}, ${q(args)})`);
    } catch (error) {
      fail(`invoke ${command} failed: ${error.message.replace(/^TauriPage command 'eval' failed: /, '')}`);
    }
  }

  evaluate(expression) {
    return this.page.evaluate(expression);
  }

  /** Poll `expression` in the page until it is truthy; returns its value. */
  async waitFor(expression, label, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      await this.session.assertHealthy();
      try {
        last = await this.page.evaluate(`(() => { try { return (${expression}); } catch (error) { return { __error: String(error && error.message || error) }; } })()`);
      } catch (error) {
        // Only a failed evaluation is retried; a dead bridge is not.
        if (!error.message.startsWith('TauriPage command')) throw error;
        last = { __error: error.message };
      }
      if (last && !last.__error) return last;
      if (Date.now() >= deadline) fail(`timed out after ${timeoutMs / 1000} s waiting for ${label}`, [last?.__error ? `last error: ${last.__error}` : `last value: ${q(last)}`]);
      await delay(POLL_MS);
    }
  }

  async waitForHost(read, label, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = read();
      if (value) return value;
      if (Date.now() >= deadline) fail(`timed out after ${timeoutMs / 1000} s waiting for ${label}`);
      await this.session.assertHealthy();
      await delay(POLL_MS);
    }
  }

  visible(selector) {
    return `(() => { const el = document.querySelector(${q(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[inert]'); })()`;
  }

  /** Real DOM click (the plugin's `click`: waits until visible, scrolls into view, el.click()). */
  async click(selector, label = selector) {
    await this.waitFor(this.visible(selector), `${label} to be visible and interactive`);
    await this.page.click(selector, { timeout: 10_000 });
  }

  /** Open the project file drawer (phone and iPad portrait) unless it is open. */
  async openFiles() {
    const expanded = await this.page.getAttribute(FILES_BUTTON, 'aria-expanded', { timeout: 10_000 });
    if (expanded !== 'true') await this.click(FILES_BUTTON, 'the Files toolbar button');
    await this.waitFor(`document.querySelector(${q(FILES_BUTTON)})?.getAttribute('aria-expanded') === 'true' && !!document.querySelector('[data-testid="sidebar-region"]') && !document.querySelector('[data-testid="sidebar-region"]').closest('[inert]')`, 'the file drawer to open');
  }

  /** Open a project file from the drawer and leave the editor area uncovered. */
  async openTreeFile(name) {
    await this.openFiles();
    const selector = `[data-testid="sidebar-file-${name}"]`;
    await this.click(selector, `sidebar row ${name}`);
    await this.waitFor(`document.querySelector(${q(selector)})?.classList.contains('tree-file-active')`, `${name} to become the active tab`);
    // Switching tabs closes the drawer; re-selecting the active file does not.
    const open = () => `document.querySelector(${q(FILES_BUTTON)})?.getAttribute('aria-expanded') === 'true'`;
    await delay(500);
    if (await this.evaluate(open())) await this.click('[data-testid="sidebar-drawer-scrim"]', 'the drawer scrim');
    await this.waitFor(`!(${open()})`, 'the file drawer to close');
    return this.evaluate(`document.querySelector(${q(selector)}).getAttribute('data-tree-path')`);
  }

  /** From the Welcome library list, open the project called `name`. */
  async openLibraryProject(name, projectDir) {
    await this.waitFor(this.visible('[data-testid="welcome-library-list"]'), 'the Welcome library list');
    const index = await this.waitFor(
      `(() => { const rows = Array.from(document.querySelectorAll('[data-testid^="library-project-"]')); const i = rows.findIndex((row) => row.querySelector('.recent-name')?.textContent?.trim() === ${q(name)}); return i >= 0 ? { i: rows[i].getAttribute('data-testid') } : null; })()`,
      `library row ${name}`,
    );
    await this.click(`[data-testid="${index.i}"]`, `library row ${name}`);
    await this.waitFor(`Array.from(document.querySelectorAll('[data-tree-path]')).some((el) => el.getAttribute('data-tree-path').startsWith(${q(`${projectDir}/`)}))`, `project ${name} to open`);
  }

  /** Drop focus (and the software keyboard) so a screenshot shows the page as laid out. */
  async screenshot(name) {
    await this.evaluate('(document.activeElement && document.activeElement !== document.body && document.activeElement.blur(), true)');
    await delay(800);
    return this.session.screenshot(name);
  }
}

// ── Steps ─────────────────────────────────────────────────────────────────

/** Bundled resources through native commands, compared with the repository and the app bundle. */
async function bundledResources(flow, ctx) {
  const { session, root } = ctx;
  const libraryPath = await flow.invoke('get_library_path');
  check(
    realpath(libraryPath) !== null && realpath(libraryPath) === realpath(path.join(session.dataContainer, 'Documents', 'Projects')),
    `get_library_path returned ${libraryPath}, not the existing Documents/Projects of the app data container ${session.dataContainer}`,
  );
  const libraryEntries = fs.readdirSync(libraryPath).filter((name) => !name.startsWith('.'));
  check(libraryEntries.length === 0, `the fresh app library is not empty: ${libraryEntries.join(', ')}`);

  const templates = await flow.invoke('list_templates');
  check(templates.some((template) => template.id === 'novel' && template.builtin === true), 'list_templates has no built-in "novel" template', [q(templates.map((t) => t.id))]);

  const repoTemplates = path.join(root, 'core', 'bundled-templates');
  const expectedIds = fs.readdirSync(repoTemplates).filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)).sort();
  const listed = await flow.invoke('list_template_files', { projectDir: null });
  const bundledIds = listed.filter((entry) => entry.source === 'bundled').map((entry) => entry.id).sort();
  check(q(bundledIds) === q(expectedIds), `list_template_files lists bundled ${q(bundledIds)}, the repository has ${q(expectedIds)}`);
  const snippets = [];
  for (const id of expectedIds) {
    const file = await flow.invoke('read_template_file', { source: 'bundled', id, projectDir: null });
    const expected = templateBody(fs.readFileSync(path.join(repoTemplates, `${id}.md`), 'utf8'));
    check(file.body === expected, `read_template_file bundled ${id} differs from core/bundled-templates/${id}.md`, [`app: ${q(file.body.slice(0, 120))}`, `repo: ${q(expected.slice(0, 120))}`]);
    snippets.push({ id, name: file.summary?.name ?? null, bodyBytes: Buffer.byteLength(file.body), sha256: sha256(file.body) });
  }

  const repoPlugins = path.join(root, 'core', 'bundled-plugins');
  check(fs.existsSync(repoPlugins), 'core/bundled-plugins is missing; it is written by the Rust build (core/build.rs)');
  const expectedPlugins = fs.readdirSync(repoPlugins).filter((id) => fs.existsSync(path.join(repoPlugins, id, 'manifest.toml'))).sort();
  const plugins = await flow.invoke('list_plugins');
  const pluginIds = plugins.map((plugin) => plugin.id).sort();
  check(q(pluginIds) === q(expectedPlugins), `list_plugins returned ${q(pluginIds)}, the bundle has ${q(expectedPlugins)}`);
  check(plugins.every((plugin) => plugin.builtin === true), 'list_plugins returned a plugin that is not built in');
  const literary = plugins.find((plugin) => plugin.id === LITERARY_PLUGIN);
  check(literary?.enabled === false, `${LITERARY_PLUGIN} should start disabled, list_plugins says enabled=${literary?.enabled}`);
  check(literary?.ui?.entry === 'index.html' && literary.ui.file_extensions?.includes('.litstudy'), `${LITERARY_PLUGIN} has no .litstudy index.html UI entry`, [q(literary?.ui)]);

  // The installed plugin page is the bundle resource, byte for byte.
  const pluginsDir = await flow.invoke('get_plugins_dir');
  check(within(pluginsDir, session.dataContainer), `get_plugins_dir ${pluginsDir} is outside the app data container`);
  const installed = readBytes(path.join(pluginsDir, LITERARY_PLUGIN, 'index.html'));
  const repoPage = readBytes(path.join(repoPlugins, LITERARY_PLUGIN, 'index.html'));
  const bundlePagePath = findFile(session.appPath, path.join('bundled-plugins', LITERARY_PLUGIN, 'index.html'));
  const bundlePage = bundlePagePath && readBytes(bundlePagePath);
  check(installed && repoPage && bundlePage, `${LITERARY_PLUGIN}/index.html is missing (installed ${!!installed}, app bundle ${!!bundlePage}, core/bundled-plugins ${!!repoPage})`);
  check(installed.equals(bundlePage) && bundlePage.equals(repoPage), `${LITERARY_PLUGIN}/index.html installed in app data differs from the bundled resource`);

  return {
    libraryPath,
    templates: templates.map((template) => template.id),
    bundledSnippets: snippets,
    plugins: plugins.map(({ id, version, enabled, builtin }) => ({ id, version, enabled, builtin })),
    pluginPage: { bytes: installed.length, sha256: sha256(installed), bundleResource: path.relative(session.appPath, bundlePagePath) },
  };
}

/** Welcome → New Project → Novel template → name → Create; checked on the host file system. */
async function createProject(flow, ctx) {
  await flow.waitFor(flow.visible('[data-testid="welcome-library-empty"]'), 'the empty Welcome library');
  await flow.click('[data-testid="welcome-new-project"]', 'Welcome "New Project"');
  // The dialog opens on the Literary Commentary template, whose footer has no
  // name field; pick Novel first, then the name field appears.
  await flow.waitFor(flow.visible('[data-testid="new-project-template-novel"]'), 'the New Project dialog');
  await flow.click('[data-testid="new-project-template-novel"]', 'the Novel template');
  await flow.waitFor(flow.visible('#np-name'), 'the project name field');
  await flow.page.fill('#np-name', ctx.projectName, { timeout: 10_000 });
  await flow.click('.btn-create:not(:disabled)', 'the enabled Create button');

  const libraryPath = ctx.results.resources.libraryPath;
  const projectDirs = await flow.waitForHost(() => {
    const dirs = fs.readdirSync(libraryPath, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    return dirs.length > 0 && dirs;
  }, 'the project folder in Documents/Projects');
  check(projectDirs.length === 1, `expected one project folder in the library, found ${projectDirs.map((d) => d.name).join(', ')}`);
  const projectDir = path.join(libraryPath, projectDirs[0].name);
  const toml = await flow.waitForHost(() => readBytes(path.join(projectDir, '.novelist', 'project.toml'))?.toString('utf8'), '.novelist/project.toml');
  const tomlName = /^\[project\][^[]*?^name\s*=\s*"((?:[^"\\]|\\.)*)"/ms.exec(toml)?.[1];
  check(tomlName !== undefined && JSON.parse(`"${tomlName}"`) === ctx.projectName, `project.toml names the project ${tomlName}, expected ${ctx.projectName}`);
  const chapter = firstOutlineEntry(toml);
  check(chapter && !chapter.includes('/'), `project.toml has no top-level first outline entry (${chapter})`);
  const hostChapter = path.join(projectDir, chapter);
  check(fs.existsSync(hostChapter), `the first outline chapter ${chapter} does not exist on disk`);

  // The app opened the new project: its tree rows are paths in this folder.
  await flow.waitFor(`document.querySelector(${q(`[data-testid="sidebar-file-${chapter}"]`)})`, `sidebar row ${chapter}`);
  const appChapter = await flow.evaluate(`document.querySelector(${q(`[data-testid="sidebar-file-${chapter}"]`)}).getAttribute('data-tree-path')`);
  check(realpath(appChapter) === realpath(hostChapter), `the sidebar row ${chapter} points at ${appChapter}, not ${hostChapter}`);
  return { name: ctx.projectName, hostDir: projectDir, appDir: path.dirname(appChapter), chapter, appChapter, hostChapter, projectToml: { bytes: Buffer.byteLength(toml) } };
}

/** Open the chapter, type CJK through WebKit editing into CodeMirror, Save, compare disk bytes. */
async function typeAndSave(flow, ctx) {
  const { project } = ctx;
  const before = readBytes(project.hostChapter).toString('utf8');
  await flow.openTreeFile(project.chapter);
  await flow.waitFor(`window.__novelist_view && window.__novelist_view.state.doc.toString() === ${q(before)}`, `CodeMirror to show ${project.chapter} as stored on disk`);
  await flow.waitFor(`!document.querySelector(${q(DIRTY)})`, 'a clean tab before typing');

  const text = ctx.cjkText;
  // Focus the editor and put the caret at the end of the document with the
  // DOM selection (what a tap does), let CodeMirror read it, then insert
  // through WebKit's editing command; CodeMirror sees it as DOM input.
  const typed = await flow.evaluate(`(async () => {
    const view = window.__novelist_view;
    const end = view.state.doc.length;
    view.contentDOM.focus();
    const at = view.domAtPos(end);
    const range = document.createRange();
    range.setStart(at.node, at.offset);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !(view.hasFocus && view.state.selection.main.head === end)) await new Promise((r) => setTimeout(r, 50));
    const caret = { end, head: view.state.selection.main.head, hasFocus: view.hasFocus, activeIsEditor: document.activeElement === view.contentDOM };
    if (!(caret.hasFocus && caret.head === end)) return { caret, inserted: null };
    return { caret, inserted: document.execCommand('insertText', false, ${q(text)}) };
  })()`);
  check(typed.inserted !== null, 'CodeMirror did not take focus and the caret at the end of the document', [q(typed.caret)]);
  check(typed.inserted === true, 'WebKit refused execCommand("insertText") in the focused editor', [q(typed.caret)]);
  const expected = before + text;
  await flow.waitFor(`window.__novelist_view.state.doc.toString() === ${q(expected)}`, 'CodeMirror to contain the typed CJK text', 5_000);
  await flow.waitFor(`document.querySelector('.cm-content')?.textContent.includes(${q(text)})`, 'the typed CJK text in the rendered editor', 5_000);
  await flow.waitFor(`document.querySelector(${q(DIRTY)})`, 'the unsaved-changes marker');
  check(readBytes(project.hostChapter).toString('utf8') === before, 'the chapter changed on disk before Save');

  await flow.click('[data-testid="mobile-save"]', 'the toolbar Save button');
  await flow.waitFor(`!document.querySelector(${q(DIRTY)})`, 'the unsaved-changes marker to clear after Save');
  const expectedBytes = Buffer.from(expected, 'utf8');
  await flow.waitForHost(() => readBytes(project.hostChapter)?.equals(expectedBytes), `${project.chapter} on disk to hold exactly the edited text`, 10_000);
  await flow.waitFor(`window.__novelist_view.state.doc.toString() === ${q(expected)}`, 'CodeMirror to keep the saved text');
  const shot = await flow.screenshot('editor-cjk.png');
  return { file: project.chapter, typed: text, caret: typed.caret, bytesBefore: Buffer.byteLength(before), bytesAfter: expectedBytes.length, sha256: sha256(expectedBytes), screenshot: shot };
}

/** Enable the UI-only bundled literary plugin, reload, open a .litstudy file in its asset iframe. */
async function literaryPlugin(flow, ctx) {
  const { project, session } = ctx;
  await flow.invoke('set_plugin_enabled', { pluginId: LITERARY_PLUGIN, enabled: true });
  const plugins = await flow.invoke('list_plugins');
  check(plugins.find((plugin) => plugin.id === LITERARY_PLUGIN)?.enabled === true, `${LITERARY_PLUGIN} is not enabled after set_plugin_enabled`);

  const body = `${JSON.stringify(ctx.literaryFixture, null, 2)}\n`;
  const created = await flow.invoke('create_file_with_body', { dir: project.appDir, filename: ctx.literaryFile, body });
  check(path.basename(created) === ctx.literaryFile, `create_file_with_body wrote ${created}, expected ${ctx.literaryFile}`);
  const hostFixture = path.join(project.hostDir, ctx.literaryFile);
  check(readBytes(hostFixture)?.equals(Buffer.from(body, 'utf8')), `${ctx.literaryFile} on disk differs from the body sent to create_file_with_body`);

  // The plugin list is read once at startup: reload the frontend.
  await session.reloadFrontend();
  await flow.openLibraryProject(project.name, project.appDir);
  await flow.openFiles();
  // The row is clickable only once the .litstudy handler is registered.
  const selector = `[data-testid="sidebar-file-${ctx.literaryFile}"]`;
  await flow.waitFor(flow.visible(selector), `the ${ctx.literaryFile} row with the literary handler registered`, 20_000);
  await flow.openTreeFile(ctx.literaryFile);
  await flow.waitFor(`document.querySelector(${q(LITERARY_FRAME)})`, 'the literary plugin iframe');
  const state = await flow.waitFor(
    `(() => { const s = document.querySelector(${q(LOAD_STATE)}); if (!s) return { loaded: true }; if (s.getAttribute('role') === 'alert') return { failed: s.textContent.trim() }; return null; })()`,
    'the literary plugin handshake (plugin-ready)',
    20_000,
  );
  check(!state.failed, `the literary plugin frame failed to load: ${state.failed}`);
  // Native pixels: the frame region of a simctl screenshot must show content.
  // Measured with focus dropped (no software keyboard) right before and after the capture.
  await flow.evaluate('(document.activeElement && document.activeElement !== document.body && document.activeElement.blur(), true)');
  await delay(1_500);
  const measure = () => flow.evaluate(`(() => {
    const el = document.querySelector(${q(LITERARY_FRAME)});
    const r = el.getBoundingClientRect();
    return { src: el.getAttribute('src'), sandbox: el.getAttribute('sandbox'), rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      title: document.querySelector('[data-testid="mobile-toolbar-title"]')?.textContent.trim() ?? null };
  })()`);
  const frame = await measure();
  const src = decodeURIComponent(frame.src ?? '');
  check(src.includes(`/plugins/${LITERARY_PLUGIN}/index.html`), `the plugin iframe loads ${frame.src}, not the installed ${LITERARY_PLUGIN}/index.html`);
  check(frame.rect.width > 100 && frame.rect.height > 100, `the plugin iframe is ${frame.rect.width}x${frame.rect.height}`);
  const shot = await session.screenshot('plugin-litstudy.png');
  const after = await measure();
  check(q(after.rect) === q(frame.rect) && q(after.viewport) === q(frame.viewport), 'the plugin iframe moved while the screenshot was taken', [q(frame), q(after)]);
  const png = decodePng(path.join(session.dir, 'plugin-litstudy.png'));
  const scale = png.width / frame.viewport.width;
  check(Math.abs(png.height - frame.viewport.height * scale) <= 2 * scale, `screenshot ${png.width}x${png.height} does not map onto the ${frame.viewport.width}x${frame.viewport.height} web view`);
  const inset = 4 * scale;
  const region = {
    x: Math.max(0, Math.round(frame.rect.left * scale + inset)),
    y: Math.max(0, Math.round(frame.rect.top * scale + inset)),
  };
  region.width = Math.min(png.width - region.x, Math.round(frame.rect.width * scale - 2 * inset));
  region.height = Math.min(png.height - region.y, Math.round(frame.rect.height * scale - 2 * inset));
  const ink = regionInk(png, region);
  check(ink.offBackground >= 2_000 && ink.distinctColours >= 8, `the plugin frame region of plugin-litstudy.png looks blank (${ink.offBackground} of ${ink.pixels} pixels off the background, ${ink.distinctColours} colours)`);
  return { fixture: ctx.literaryFile, fixtureBytes: Buffer.byteLength(body), frame, pixels: { scale, region, ...ink }, screenshot: shot };
}

/** Project sync files under `dir`, as core/src/services/project_files.rs selects them. */
function syncedFiles(dir) {
  return listFiles(dir).filter((rel) => {
    if (rel === '.novelist/project.toml') return true;
    if (rel.split('/').some((part) => part.startsWith('.'))) return false;
    return SYNCED_EXTENSIONS.has(path.extname(rel).slice(1).toLowerCase());
  });
}

/**
 * Cloud account in the Keychain and project sync against the loopback Apache
 * WebDAV server: connect, check, relaunch, check again, bind, sync, compare
 * server bytes, disconnect, prove the Keychain entry is gone.
 */
async function cloudSync(flow, ctx) {
  const { project, session, webdav } = ctx;
  const account = webdav.account(session.role);
  const result = { endpoint: account.endpoint, username: account.username };

  const initial = await flow.invoke('check_cloud_account');
  check(initial.state === 'not_connected', `a fresh app reports cloud state ${initial.state}`);

  const connected = await flow.invoke('connect_cloud_account', { endpoint: account.endpoint, username: account.username, password: account.password });
  check(connected.connected === true && connected.username === account.username && connected.endpoint === account.endpoint, 'connect_cloud_account did not return the connected account', [q({ ...connected })]);
  check(connected.credential_storage === 'system_keychain', `the password went to ${connected.credential_storage}, not the system keychain`);
  const online = await flow.invoke('check_cloud_account');
  check(online.state === 'online', `check_cloud_account after connect: ${online.state} ${online.message ?? ''}`);

  // Only the Keychain may hold the password: nothing in the app container.
  const accountFile = findFile(session.dataContainer, path.join('cloud', 'account.json'));
  check(accountFile, 'connect_cloud_account wrote no cloud/account.json in the app container');
  const accountRecord = JSON.parse(readBytes(accountFile).toString('utf8'));
  check(q(Object.keys(accountRecord).sort()) === q(['connected_at', 'endpoint', 'username']), `cloud/account.json has fields ${q(Object.keys(accountRecord))}`);
  const leaks = filesContaining(session.dataContainer, [account.password]);
  check(leaks.length === 0, `the cloud password is stored in app container files: ${leaks.join(', ')}`);
  result.accountRecord = path.relative(session.dataContainer, accountFile);

  // A new process can only answer `online` by reading the Keychain.
  await session.relaunch();
  const relaunched = await flow.invoke('check_cloud_account');
  check(relaunched.state === 'online', `check_cloud_account after relaunch: ${relaunched.state} ${relaunched.message ?? ''}`);
  result.keychainAfterRelaunch = relaunched.state;

  const binding = await flow.invoke('bind_cloud_project', { projectDir: project.appDir, intervalMinutes: 5 });
  check(binding.linked === true && binding.enabled === true, 'bind_cloud_project did not link the project', [q(binding)]);
  const synced = await flow.invoke('sync_now', { projectDir: project.appDir });
  check(Array.isArray(synced.errors) && synced.errors.length === 0 && synced.last_sync, 'sync_now reported errors', [q(synced)]);
  result.sync = { filesUploaded: synced.files_uploaded, filesDownloaded: synced.files_downloaded, conflicts: synced.conflicts?.length ?? 0 };

  const identity = JSON.parse(readBytes(path.join(project.hostDir, '.novelist', 'sync-identity.json'))?.toString('utf8') ?? 'null');
  check(/^[0-9a-f]{64}$/.test(identity?.project_id ?? ''), 'the project has no sync identity after sync_now');
  const remoteDir = path.join(account.root, 'novelist-sync', identity.project_id);
  const remoteIdentity = JSON.parse(readBytes(path.join(remoteDir, '.novelist', 'sync-identity.json'))?.toString('utf8') ?? 'null');
  check(remoteIdentity?.project_id === identity.project_id, 'the server has no matching .novelist/sync-identity.json');
  const local = syncedFiles(project.hostDir);
  check(local.includes(project.chapter) && local.includes(ctx.literaryFile), `the local sync set misses the edited files: ${local.join(', ')}`);
  const compared = [];
  for (const rel of local) {
    const mine = readBytes(path.join(project.hostDir, rel));
    const theirs = readBytes(path.join(remoteDir, rel));
    check(theirs && theirs.equals(mine), `server copy of ${rel} ${theirs ? 'differs from' : 'is missing for'} the local file`);
    compared.push({ file: rel, bytes: mine.length, sha256: sha256(mine) });
  }
  result.serverFiles = { compared, remote: listFiles(remoteDir) };

  const keptLocal = Object.fromEntries(local.map((rel) => [rel, readBytes(path.join(project.hostDir, rel))]));
  const accountBytes = readBytes(accountFile);
  const disconnected = await flow.invoke('disconnect_cloud_account');
  check(disconnected.unlinked_projects >= 1, `disconnect_cloud_account unlinked ${disconnected.unlinked_projects} projects`);
  check(!fs.existsSync(accountFile), 'cloud/account.json survived disconnect_cloud_account');
  const after = await flow.invoke('check_cloud_account');
  check(after.state === 'not_connected', `check_cloud_account after disconnect: ${after.state}`);
  const unbound = await flow.invoke('get_cloud_project_binding', { projectDir: project.appDir });
  check(unbound.linked === false && unbound.enabled === false, 'the project is still linked after disconnect', [q(unbound)]);
  for (const [rel, bytes] of Object.entries(keptLocal)) {
    check(readBytes(path.join(project.hostDir, rel))?.equals(bytes), `disconnect changed or removed local ${rel}`);
    check(readBytes(path.join(remoteDir, rel))?.equals(bytes), `disconnect changed or removed server ${rel}`);
  }

  // The Keychain entry is gone: with the account record put back exactly as
  // the app wrote it, the app finds no stored password.
  fs.mkdirSync(path.dirname(accountFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(accountFile, accountBytes, { mode: 0o600 });
  const orphan = await flow.invoke('check_cloud_account');
  fs.rmSync(accountFile, { force: true });
  check(orphan.state === 'credential_missing' && /no stored cloud password/.test(orphan.message ?? ''), `with the account record restored, check_cloud_account says ${orphan.state} (${orphan.message}); the Keychain entry was not deleted`);
  result.keychainAfterDisconnect = { state: orphan.state, message: orphan.message };
  const final = await flow.invoke('check_cloud_account');
  check(final.state === 'not_connected', `check_cloud_account at the end: ${final.state}`);
  result.disconnect = { unlinkedProjects: disconnected.unlinked_projects, localKept: Object.keys(keptLocal).length };
  return result;
}

/** Reopen the project after the relaunch and leave the edited chapter on screen. */
async function finalEditor(flow, ctx) {
  const { project } = ctx;
  const saved = readBytes(project.hostChapter).toString('utf8');
  check(saved.endsWith(ctx.cjkText), `${project.chapter} on disk lost the typed text`);
  await flow.openLibraryProject(project.name, project.appDir);
  await flow.openTreeFile(project.chapter);
  await flow.waitFor(`window.__novelist_view && window.__novelist_view.state.doc.toString() === ${q(saved)}`, `CodeMirror to show the saved ${project.chapter} after the relaunch`);
  await flow.waitFor(`!document.querySelector(${q(DIRTY)})`, 'a clean tab');
  await flow.waitFor(`document.querySelector('.cm-content')?.textContent.includes(${q(ctx.cjkText)})`, 'the CJK text in the rendered editor');
  const shot = await flow.screenshot('screenshot.png');
  return { file: project.chapter, sha256: sha256(Buffer.from(saved, 'utf8')), screenshot: shot };
}

/**
 * Run every flow on one device. `session` is the smoke's DeviceSession
 * (page, screenshot, relaunch, reloadFrontend, assertHealthy, paths);
 * `record.flows` receives one entry per step.
 */
export async function runDeviceFlows(session, { root, webdav, record }) {
  const flow = new Flow(session);
  const ctx = {
    session,
    root,
    webdav,
    results: {},
    projectName: `Novelist Smoke ${session.family}`,
    cjkText: `雪夜灯下，林舟写下第一行。（${session.family} 中文测试）`,
    literaryFile: '雪夜试读.litstudy',
    literaryFixture: {
      schemaVersion: 1,
      book: { title: '试读本', author: '作者', language: 'zh-CN' },
      chapter: { id: 'chapter-1', title: '第一章 雪夜', volume: null, index: 1, total: 1, previousPath: null, nextPath: null },
      source: '庭前有一株梅树。\n夜雪初停，檐下灯火未熄。',
      sourceCursor: 0,
      insertions: [],
      stats: { correct: 0, mistakes: 0, pasted: 0, startedAt: null, completedAt: null },
    },
  };
  const steps = [
    ['bundled-resources', () => bundledResources(flow, ctx), (value) => (ctx.results.resources = value)],
    ['create-project', () => createProject(flow, ctx), (value) => (ctx.project = value)],
    ['type-cjk-and-save', () => typeAndSave(flow, ctx)],
    ['literary-plugin-frame', () => literaryPlugin(flow, ctx)],
    ['cloud-keychain-sync', () => cloudSync(flow, ctx)],
    ['final-editor', () => finalEditor(flow, ctx)],
  ];
  for (const [name, run, keep] of steps) {
    const entry = { name, status: 'running', seconds: null, result: null };
    record.flows.push(entry);
    record.stage = `flow:${name}`;
    session.log(`flow ${name}`);
    const startedAt = Date.now();
    try {
      const value = await run();
      await session.assertHealthy();
      keep?.(value);
      entry.result = name === 'create-project' ? { name: value.name, folder: path.basename(value.hostDir), chapter: value.chapter } : value;
      entry.status = 'passed';
    } catch (error) {
      entry.status = 'failed';
      entry.error = error.message;
      throw error;
    } finally {
      entry.seconds = Math.round((Date.now() - startedAt) / 100) / 10;
    }
  }
}
