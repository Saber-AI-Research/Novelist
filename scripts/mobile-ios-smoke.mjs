#!/usr/bin/env node
// Native iOS simulator smoke test for the unsigned simulator app that
// `node scripts/mobile.mjs ios build --e2e` produces (CI: .github/workflows/mobile-ci.yml).
//
// The bundle is found by its Info.plist, never by file name. A fresh iPhone
// and a fresh iPad simulator are created on the newest installed iOS runtime
// and run one after the other: boot, install, launch with a unique Unix
// socket for tauri-plugin-playwright (compiled in by the debug-only
// `e2e-testing` feature), connect @srsholmes/tauri-playwright's PluginClient
// to it, and prove readiness in the real WKWebView: bridge ping, mounted app
// DOM and the startup performance marks. scripts/mobile-ios-flows.mjs then
// drives the real UI and native commands (project creation, CJK typing and
// Save checked on the container's file system, bundled templates and
// plugins, the literary plugin's asset iframe, Keychain-backed cloud
// account and project sync against a loopback Apache WebDAV server from
// scripts/mobile-webdav.mjs). Screenshots come from `simctl io`. Startup
// phases are read from the app's stdout/stderr and the unified log for
// diagnostics, and an error phase fails the run. Only devices, sockets and
// servers this run created are stopped and removed; files are written only
// to the evidence directory. Needs no signing material.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AppVersionError, readAppVersion } from './app-version.mjs';
import { runDeviceFlows } from './mobile-ios-flows.mjs';
import { listFiles, startLoopbackWebDav } from './mobile-webdav.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = path.join(ROOT, 'core', 'gen', 'apple', 'build', 'arm64-sim');
const APP_ID = 'com.novelist.app';
const MIN_OS = '16.0';
const DEVICE_FAMILY = [1, 2]; // iPhone, iPad
const TARGETS = [
  { role: 'iphone', family: 'iPhone' },
  { role: 'ipad', family: 'iPad' },
];
// Startup marks app/main.ts and App.svelte set with startupMark(), which
// also calls performance.mark(`novelist.<name>`); the same names reach the
// log through `log_startup_phase`.
const STARTUP_MARKS = ['frontend.main.mounted', 'frontend.main.window-shown', 'frontend.app.first-paint'];
const ERROR_PHASE = /^frontend\.(?:main\.boot-failed|error:|reject:)/;
// `… novelist::startup: frontend phase phase=<name> since_start_ms=<ms>`;
// backend phases quote the name. The unified log prefixes the first line
// of each stdout chunk and may cut a chunk short with `<…>`.
const PHASE_LINE = /novelist::startup: (?:frontend|backend) phase phase=("(?:[^"\\]|\\.)*"|.*?)(?: since_start_ms=(\S+))?\s*$/;
const BRIDGE_LINE = /tauri-plugin-playwright: (?:(listening on) (\S+)|(?:unix|tcp) server error: (.*))$/;
const LIMIT = {
  commandMs: 120_000,
  cleanupMs: 30_000,
  bootMs: 300_000,
  // Launch to bridge socket, ping and ready DOM.
  startupMs: 180_000,
  connectMs: 15_000,
  // Above the plugin's own 30 s eval timeout: a missing answer means a dead bridge.
  bridgeMs: 45_000,
  terminateMs: 15_000,
  pollMs: 500,
  launchctlEveryMs: 2_000,
  stopMs: 10_000,
  captureBytes: 32 * 1024 * 1024,
  logBytes: 4 * 1024 * 1024,
  domBytes: 256 * 1024,
  phases: 400,
  crashReports: 5,
};
const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const inActions = process.env.GITHUB_ACTIONS === 'true';

const USAGE = `Novelist iOS simulator smoke test

Usage:
  node scripts/mobile-ios-smoke.mjs [--app PATH] [--out DIR]

  --app PATH   Simulator .app to test. Default: the single bundle under
               core/gen/apple/build/arm64-sim (from \`node scripts/mobile.mjs
               ios build --e2e\`) whose Info.plist says ${APP_ID} for
               iPhoneSimulator; other bundles there are rejected.
  --out DIR    Evidence directory; must be new or empty. Default: a new
               novelist-ios-smoke-* directory in $RUNNER_TEMP or the system
               temp directory.
  -h, --help   Show this help.

Needs macOS with full Xcode, an installed iOS ${MIN_OS}+ simulator runtime,
macOS /usr/sbin/httpd (Apache 2.4 with mod_dav_fs) and \`pnpm install\`
(@srsholmes/tauri-playwright). The app must be ${APP_ID}, iPhone + iPad,
MinimumOSVersion ${MIN_OS}, CFBundleShortVersionString equal to the X.Y.Z of
core/Cargo.toml, built with --e2e (tauri-plugin-playwright; never in a
release or published build).

A loopback WebDAV server with one random account per device starts first.
Then for one fresh iPhone and one fresh iPad simulator (newest device type of
the newest available iOS runtime): simctl create; bootstatus -b
(${LIMIT.bootMs / 1000} s); install; launch with a new /tmp Unix socket for the
bridge; within ${LIMIT.startupMs / 1000} s the socket, a bridge ping and the
ready app DOM (marks ${STARTUP_MARKS.join(', ')}); then the
flows of scripts/mobile-ios-flows.mjs, with a relaunch for the Keychain
check. The run fails on frontend.main.boot-failed, frontend.error or
frontend.reject in the app log, on a native init error in the DOM, or when
the app exits. The app is terminated, the device shut down and deleted,
the socket removed. Simulators that existed before the run are never touched.

Evidence in DIR: evidence.json (per device: launches, readiness, startup
phases, flow results), webdav/ (server access and error logs), and per device
(iphone/, ipad/): welcome.png, editor-cjk.png, plugin-litstudy.png,
screenshot.png (the edited chapter at the end), app-stdout*.log,
app-stderr*.log, unified.log, native-startup.log, bootstatus.log; on failure
also failure.png, failure-dom.json and crash-reports/ when available. Logs are
capped at ${LIMIT.logBytes / 1024 / 1024} MiB each; no password is ever written. Exit status 0
only when both devices passed.
`;

// ── Output and failure ────────────────────────────────────────────────────

class Failure extends Error {
  constructor(message, hints = []) {
    super(message);
    this.hints = hints.filter(Boolean);
  }
}

function fail(message, hints = []) {
  throw new Failure(message, hints);
}

function step(message) {
  console.log(`\n==> ${message}`);
}

function warn(message) {
  console.warn(inActions ? `::warning::${message}` : `warning: ${message}`);
}

/** Failures of this script and its helper modules carry `hints`; anything else is a bug. */
const expected = (error) => error instanceof Failure || Array.isArray(error?.hints);

function report(error) {
  if (!expected(error)) {
    console.error(error);
    return;
  }
  console.error(inActions ? `::error::${error.message}` : `error: ${error.message}`);
  for (const hint of error.hints) console.error(`  ${hint.replaceAll('\n', '\n  ')}`);
}

function rel(file) {
  const relative = path.relative(ROOT, file);
  return relative.startsWith('..') || path.isAbsolute(relative) ? file : relative || '.';
}

function tail(text, lines = 15) {
  return text.replace(ANSI, '').trim().split('\n').slice(-lines).join('\n');
}

function seconds(ms) {
  return Math.round(ms / 100) / 10;
}

function stat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function lstat(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

const isDir = (file) => stat(file)?.isDirectory() === true;
const isFile = (file) => stat(file)?.isFile() === true;

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Reject with `message` unless `promise` settles within `ms`. */
async function within(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Failure(message)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Evidence and cleanup state ────────────────────────────────────────────

const evidence = {
  schema: 2,
  status: 'running',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  failures: [],
  host: null,
  app: null,
  runtime: null,
  webdav: null,
  devices: [],
  secretScan: null,
};
let outDir = null;
let stage = 'arguments';
// Live child processes (simctl commands, log streams), the simulators and
// bridge sockets this run created and has not removed yet, and the WebDAV
// server. Cleanup only ever acts on these.
const children = new Set();
const ownedDevices = new Set();
const ownedSockets = new Set();
let webdav = null;

const outRel = (file) => path.relative(outDir, file);

function writeEvidence() {
  if (!outDir) return;
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

/** Remove a bridge socket this run asked the app to create; never anything else. */
function removeSocket(file) {
  const entry = lstat(file);
  ownedSockets.delete(file);
  if (!entry) return 'absent';
  if (!entry.isSocket()) return `left in place: not a socket`;
  fs.unlinkSync(file);
  return 'removed';
}

/** Synchronous last-resort cleanup (normal exit, failure or signal). */
function cleanupSync() {
  for (const child of children) child.kill('SIGTERM');
  for (const udid of ownedDevices) {
    for (const args of [['terminate', udid, APP_ID], ['shutdown', udid]]) {
      spawnSync('xcrun', ['simctl', ...args], { stdio: 'ignore', timeout: LIMIT.cleanupMs });
    }
    const deleted = spawnSync('xcrun', ['simctl', 'delete', udid], { stdio: 'ignore', timeout: LIMIT.cleanupMs });
    if (deleted.status === 0) console.error(`deleted simulator ${udid} (created by this run)`);
    else warn(`could not delete simulator ${udid} created by this run; remove it with: xcrun simctl delete ${udid}`);
  }
  ownedDevices.clear();
  for (const socket of [...ownedSockets]) {
    try {
      removeSocket(socket);
    } catch (error) {
      warn(`could not remove bridge socket ${socket}: ${error.message}`);
    }
  }
  webdav?.stopSync();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    warn(`received ${signal}; removing the simulators, sockets and server this run created`);
    evidence.status = 'interrupted';
    evidence.failures.push({ stage, message: `received ${signal}` });
    cleanupSync();
    if (webdav && outDir) evidence.secretScan = { scanned: true, hits: scrubEvidence(webdav.secrets()) };
    writeEvidence();
    process.exit(128 + (os.constants.signals[signal] ?? 1));
  });
}

// ── Child processes ───────────────────────────────────────────────────────

function collector(limit) {
  const chunks = [];
  let kept = 0;
  let dropped = 0;
  return {
    add(chunk) {
      const room = Math.max(0, limit - kept);
      if (room > 0) {
        const part = chunk.subarray(0, room);
        chunks.push(part);
        kept += part.length;
      }
      dropped += Math.max(0, chunk.length - room);
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    dropped: () => dropped,
  };
}

/**
 * Run a command with captured, size-capped output and a deadline (SIGTERM,
 * then SIGKILL). `logFile` receives the command line and its output.
 */
function run(command, args, { timeoutMs = LIMIT.commandMs, env = process.env, allowFailure = false, logFile } = {}) {
  const shown = [command, ...args].join(' ');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const stdout = collector(LIMIT.captureBytes);
    const stderr = collector(LIMIT.captureBytes);
    child.stdout.on('data', (chunk) => stdout.add(chunk));
    child.stderr.on('data', (chunk) => stderr.add(chunk));
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), LIMIT.stopMs);
    }, timeoutMs);
    let settled = false;
    const settle = (finish) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      children.delete(child);
      finish();
    };
    child.on('error', (error) =>
      settle(() => reject(new Failure(error.code === 'ENOENT' ? `${command} was not found on PATH` : `could not start ${shown}: ${error.message}`))),
    );
    child.on('close', (code, signal) =>
      settle(() => {
        const result = { code: code ?? 1, signal, stdout: stdout.text(), stderr: stderr.text(), dropped: stdout.dropped() + stderr.dropped() };
        if (logFile) fs.writeFileSync(logFile, `$ ${shown}\n${result.stdout}${result.stderr}${result.dropped > 0 ? `\n[smoke: ${result.dropped} further bytes not kept]\n` : ''}`);
        if (timedOut) reject(new Failure(`${shown} did not finish within ${timeoutMs / 1000} s`, [tail(result.stderr || result.stdout)]));
        else if (result.code !== 0 && !allowFailure) {
          reject(new Failure(`${shown} ${signal ? `was killed by ${signal}` : `exited with status ${result.code}`}`, [tail(result.stderr || result.stdout)]));
        } else resolve(result);
      }),
    );
  });
}

const simctl = (args, options) => run('xcrun', ['simctl', ...args], options);

/**
 * `xcrun simctl spawn <udid> log stream` for the app process, written to a
 * capped file until stop() (SIGINT, then SIGKILL after LIMIT.stopMs).
 */
function startLogStream(udid, executable, file) {
  const fd = fs.openSync(file, 'w');
  const child = spawn('xcrun', ['simctl', 'spawn', udid, 'log', 'stream', '--style', 'compact', '--level', 'info', '--predicate', `process == "${executable}"`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let written = 0;
  let dropped = 0;
  const write = (chunk) => {
    const room = Math.max(0, LIMIT.logBytes - written);
    if (room > 0) written += fs.writeSync(fd, chunk.subarray(0, room));
    dropped += Math.max(0, chunk.length - room);
  };
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  const closed = new Promise((resolve) => {
    child.on('error', (error) => resolve({ error: error.message }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), LIMIT.stopMs);
      const exit = await closed;
      clearTimeout(killTimer);
      children.delete(child);
      if (dropped > 0) fs.writeSync(fd, `\n[smoke: ${dropped} further bytes not kept]\n`);
      fs.closeSync(fd);
      return { file: outRel(file), bytes: written, droppedBytes: dropped, exit };
    },
  };
}

/** Cap a log file the app wrote directly (simctl launch --stdout/--stderr, NOVELIST_NATIVE_TAURI_LOG). */
function capLog(file) {
  const size = stat(file)?.size;
  if (size === undefined) return { file: outRel(file), missing: true };
  if (size > LIMIT.logBytes) {
    fs.truncateSync(file, LIMIT.logBytes);
    fs.appendFileSync(file, `\n[smoke: truncated; the app wrote ${size} bytes]\n`);
  }
  return { file: outRel(file), bytes: size, truncated: size > LIMIT.logBytes };
}

// ── Arguments and setup ───────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--') continue; // `pnpm <script> -- …` may forward the separator
    const match = /^--(app|out)(?:=(.*))?$/s.exec(arg);
    if (!match) fail(`unknown argument ${JSON.stringify(arg)}`, ['run with --help for usage']);
    const [, name, inline] = match;
    const value = inline ?? argv[++i];
    if (!value || value.startsWith('--')) fail(`--${name} needs a value`);
    if (options[name] !== undefined) fail(`--${name} was given twice`);
    options[name] = value;
  }
  return options;
}

function prepareOutDir(requested) {
  if (requested === undefined) return fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'novelist-ios-smoke-'));
  const dir = path.resolve(requested);
  const existing = stat(dir);
  if (existing && (!existing.isDirectory() || fs.readdirSync(dir).length > 0)) {
    fail(`--out ${dir} exists and is not an empty directory`, ['pick a new directory; the smoke test never overwrites files']);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function checkToolchain() {
  if (process.platform !== 'darwin') fail('the iOS simulator needs macOS with full Xcode');
  const developer = await run('xcode-select', ['-p'], { allowFailure: true });
  const xcode = await run('xcodebuild', ['-version'], { allowFailure: true });
  const version = /^Xcode (\d+(?:\.\d+)*)$/m.exec(xcode.stdout)?.[1];
  if (xcode.code !== 0 || !version) {
    fail('full Xcode is not installed or not selected; Command Line Tools have no iOS simulator', [
      `active developer directory: ${developer.stdout.trim() || 'none'}`,
      tail(xcode.stderr || xcode.stdout, 3),
      'install Xcode, then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
      'xcodebuild -downloadPlatform iOS',
    ]);
  }
  const located = await run('xcrun', ['--find', 'simctl'], { allowFailure: true });
  if (located.code !== 0) fail(`xcrun cannot find simctl in Xcode ${version}`, [tail(located.stderr || located.stdout, 3)]);
  const macos = await run('sw_vers', ['-productVersion'], { allowFailure: true });
  evidence.host = {
    macOS: macos.stdout.trim() || null,
    xcode: version,
    xcodeBuild: /^Build version (\S+)$/m.exec(xcode.stdout)?.[1] ?? null,
    developerDir: developer.stdout.trim(),
  };
  console.log(`Xcode ${version} (${evidence.host.xcodeBuild}) at ${evidence.host.developerDir}, macOS ${evidence.host.macOS}`);
}

/** The Node side of the bridge, from the repository's dev dependencies. */
async function loadBridge() {
  let module;
  try {
    module = await import('@srsholmes/tauri-playwright');
  } catch (error) {
    fail(`@srsholmes/tauri-playwright cannot be loaded (${error.message})`, ['run pnpm install in the repository']);
  }
  const { PluginClient, TauriPage } = module;
  /**
   * PluginClient with a deadline per command and a hard stop when the app's
   * socket closes; the stock client would wait forever for a dead app.
   */
  class BridgeClient extends PluginClient {
    async connect() {
      await super.connect();
      this.closed = new Promise((_, reject) => {
        this.socket.once('close', () => reject(new Failure('the bridge socket closed (did the app exit?)')));
      });
      this.closed.catch(() => {});
    }

    async send(command) {
      if (this.broken) throw new Failure(`the bridge is unusable after: ${this.broken}`);
      let timer;
      try {
        return await Promise.race([
          super.send(command),
          this.closed,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Failure(`bridge command ${command.type} got no answer within ${LIMIT.bridgeMs / 1000} s`)), LIMIT.bridgeMs);
          }),
        ]);
      } catch (error) {
        this.broken = error.message;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return { BridgeClient, TauriPage };
}

// ── App bundle ────────────────────────────────────────────────────────────

/** core/Cargo.toml [package].version, the only app version (scripts/app-version.mjs). */
function appVersion() {
  try {
    return readAppVersion(ROOT);
  } catch (error) {
    if (error instanceof AppVersionError) fail(error.message, error.hints);
    throw error;
  }
}

async function plistValue(file, key, format = 'raw') {
  const result = await run('plutil', ['-extract', key, format, '-o', '-', file], { allowFailure: true });
  if (result.code !== 0) return undefined;
  if (format !== 'json') return result.stdout.trim();
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

/** `.app` directories up to three levels below `dir` (not inside bundles). */
function findAppBundles(dir) {
  const found = [];
  const walk = (current, level) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(current, entry.name);
      if (entry.name.endsWith('.app')) found.push(full);
      else if (level < 3) walk(full, level + 1);
    }
  };
  walk(dir, 1);
  return found.sort();
}

/** What a build left behind, for the evidence when no valid bundle exists. */
function listTree(dir, depth = 3, limit = 200) {
  const entries = [];
  const walk = (current, level) => {
    let items;
    try {
      items = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= limit) return;
      const full = path.join(current, item.name);
      entries.push(`${rel(full)}${item.isDirectory() ? '/' : ''}`);
      if (item.isDirectory() && !item.name.endsWith('.app') && level < depth) walk(full, level + 1);
    }
  };
  walk(dir, 1);
  return entries;
}

async function locateApp(explicit, version) {
  const expectedVersion = /^\d+\.\d+\.\d+/.exec(version)?.[0];
  if (!expectedVersion) fail(`core/Cargo.toml version ${version} has no numeric X.Y.Z core`);
  let candidates;
  if (explicit !== undefined) {
    const app = path.resolve(explicit);
    if (!isDir(app)) fail(`--app ${app} is not a directory`);
    candidates = [app];
  } else {
    candidates = findAppBundles(BUILD_DIR);
  }
  evidence.app = { searched: explicit !== undefined ? rel(path.resolve(explicit)) : rel(BUILD_DIR), cargoVersion: version, expectedVersion, candidates: [] };

  const accepted = [];
  for (const candidate of candidates) {
    const info = path.join(candidate, 'Info.plist');
    const reasons = [];
    if (!isFile(info)) {
      reasons.push('no Info.plist');
    } else {
      const bundleId = await plistValue(info, 'CFBundleIdentifier');
      const platforms = await plistValue(info, 'CFBundleSupportedPlatforms', 'json');
      if (bundleId !== APP_ID) reasons.push(`CFBundleIdentifier is ${bundleId ?? 'missing'}, expected ${APP_ID}`);
      if (JSON.stringify(platforms) !== JSON.stringify(['iPhoneSimulator'])) {
        reasons.push(`CFBundleSupportedPlatforms is ${JSON.stringify(platforms ?? null)}, expected ["iPhoneSimulator"]`);
      }
    }
    evidence.app.candidates.push({ path: rel(candidate), accepted: reasons.length === 0, reasons });
    if (reasons.length === 0) accepted.push(candidate);
  }
  const rejected = evidence.app.candidates.filter((candidate) => !candidate.accepted).map((candidate) => `rejected ${candidate.path}: ${candidate.reasons.join('; ')}`);
  if (accepted.length !== 1) {
    if (explicit === undefined) evidence.app.buildOutput = listTree(path.dirname(BUILD_DIR));
    fail(
      accepted.length === 0
        ? `no ${APP_ID} iPhoneSimulator .app in ${evidence.app.searched}`
        : `${accepted.length} ${APP_ID} iPhoneSimulator bundles in ${evidence.app.searched}; pass --app`,
      [...rejected, ...accepted.map((app) => `candidate ${rel(app)}`), 'build it with: node scripts/mobile.mjs ios build --e2e'],
    );
  }

  const app = accepted[0];
  const info = path.join(app, 'Info.plist');
  const details = {
    path: rel(app),
    bundleId: APP_ID,
    platforms: ['iPhoneSimulator'],
    platformName: await plistValue(info, 'DTPlatformName'),
    sdk: await plistValue(info, 'DTSDKName'),
    executable: await plistValue(info, 'CFBundleExecutable'),
    shortVersion: await plistValue(info, 'CFBundleShortVersionString'),
    bundleVersion: await plistValue(info, 'CFBundleVersion'),
    minimumOS: await plistValue(info, 'MinimumOSVersion'),
    deviceFamily: await plistValue(info, 'UIDeviceFamily', 'json'),
  };
  Object.assign(evidence.app, details);
  // Keychain access in the simulator depends on how Xcode signed the bundle;
  // recorded for the cloud flow's diagnostics.
  const signed = await run('codesign', ['-dvv', app], { allowFailure: true });
  const signature = `${signed.stdout}${signed.stderr}`;
  evidence.app.signature = signed.code === 0 ? (/^Signature=(.*)$/m.exec(signature)?.[1] ?? /^Authority=(.*)$/m.exec(signature)?.[1] ?? 'signed') : tail(signature, 1) || `codesign status ${signed.code}`;
  const problems = [];
  if (details.platformName !== 'iphonesimulator') problems.push(`DTPlatformName is ${details.platformName ?? 'missing'}, expected iphonesimulator`);
  if (details.minimumOS !== MIN_OS) problems.push(`MinimumOSVersion is ${details.minimumOS ?? 'missing'}, expected ${MIN_OS}`);
  if (JSON.stringify(details.deviceFamily) !== JSON.stringify(DEVICE_FAMILY)) {
    problems.push(`UIDeviceFamily is ${JSON.stringify(details.deviceFamily ?? null)}, expected ${JSON.stringify(DEVICE_FAMILY)} (iPhone + iPad)`);
  }
  if (details.shortVersion !== expectedVersion) {
    problems.push(`CFBundleShortVersionString is ${details.shortVersion ?? 'missing'}, expected ${expectedVersion} (core/Cargo.toml ${version})`);
  }
  // The executable name goes into a log predicate: keep it a plain file name.
  if (!details.executable || !/^[\w.-]+$/.test(details.executable) || !isFile(path.join(app, details.executable))) {
    problems.push(`CFBundleExecutable ${details.executable ?? 'missing'} is not a plain file name present in the bundle`);
  }
  if (problems.length > 0) fail(`${rel(app)} is not the expected Novelist simulator app`, problems);
  console.log(`app ${details.path}: ${APP_ID} ${details.shortVersion} (${details.bundleVersion}), ${details.sdk}, iOS ${details.minimumOS}+, iPhone + iPad`);
  return { path: app, executable: details.executable };
}

// ── Runtime and device types ──────────────────────────────────────────────

function isIosRuntime(runtime) {
  return runtime.platform === 'iOS' || /\.SimRuntime\.iOS-/.test(runtime.identifier ?? '');
}

/** Newest available iOS runtime; per family its newest supported device type. */
async function selectTargets() {
  const listed = await simctl(['list', '--json']);
  const saveList = () => fs.writeFileSync(path.join(outDir, 'simctl-list.json'), listed.stdout);
  let data;
  try {
    data = JSON.parse(listed.stdout);
  } catch (error) {
    saveList();
    fail(`xcrun simctl list --json did not return JSON (${error.message})`);
  }
  const ios = (data.runtimes ?? []).filter(isIosRuntime);
  const usable = ios.filter((runtime) => runtime.isAvailable === true && compareVersions(runtime.version ?? '0', MIN_OS) >= 0);
  if (usable.length === 0) {
    saveList();
    fail(`no available iOS ${MIN_OS}+ simulator runtime`, [
      ...ios.map((runtime) => `${runtime.name ?? runtime.identifier}: ${runtime.isAvailable ? 'available' : `unavailable (${runtime.availabilityError ?? 'no reason given'})`}`),
      'xcodebuild -downloadPlatform iOS',
    ]);
  }
  const runtime = usable.sort((a, b) => compareVersions(b.version, a.version))[0];
  evidence.runtime = { name: runtime.name, identifier: runtime.identifier, version: runtime.version, build: runtime.buildversion ?? null };

  // devicetypes order and minRuntimeVersion rank models; newest wins.
  const known = new Map((data.devicetypes ?? []).map((type, index) => [type.identifier, { index, minRuntime: Number(type.minRuntimeVersion) || 0 }]));
  const rank = (type) => known.get(type.identifier) ?? { index: -1, minRuntime: 0 };
  const newer = (a, b) => rank(a).minRuntime - rank(b).minRuntime || rank(a).index - rank(b).index;
  const targets = TARGETS.map(({ role, family }) => {
    const types = (runtime.supportedDeviceTypes ?? []).filter((type) => type.productFamily === family);
    if (types.length === 0) {
      saveList();
      fail(`${runtime.name} reports no supported ${family} simulator device type`);
    }
    const type = types.reduce((best, candidate) => (newer(candidate, best) > 0 ? candidate : best));
    return { role, family, runtime, deviceType: { name: type.name, identifier: type.identifier } };
  });
  console.log(`runtime ${runtime.name} (${runtime.buildversion ?? runtime.identifier}); devices: ${targets.map((target) => target.deviceType.name).join(', ')}`);
  return targets;
}

// ── App observation ───────────────────────────────────────────────────────

/** Incremental reader of complete lines from a file another process appends to. */
class LogTail {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.rest = '';
  }

  lines() {
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= this.offset) return [];
      const buffer = Buffer.alloc(Math.min(size - this.offset, LIMIT.logBytes));
      const read = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += read;
      const lines = (this.rest + buffer.subarray(0, read).toString('utf8')).split('\n');
      this.rest = lines.pop();
      return lines;
    } finally {
      fs.closeSync(fd);
    }
  }
}

function parsePhase(raw) {
  const match = PHASE_LINE.exec(raw.replace(ANSI, ''));
  if (!match) return null;
  let phase = match[1];
  if (phase.startsWith('"')) {
    try {
      phase = JSON.parse(phase);
    } catch {
      phase = phase.slice(1, -1);
    }
  }
  return { phase, sinceStartMs: match[2] === undefined ? null : Number(match[2]) };
}

function pngInfo(file) {
  const bytes = stat(file)?.size ?? 0;
  const header = Buffer.alloc(24);
  if (bytes >= 24) {
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, header, 0, 24, 0);
    fs.closeSync(fd);
  }
  if (bytes < 24 || !header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || header.toString('latin1', 12, 16) !== 'IHDR') {
    fail(`${outRel(file)} is not a PNG (${bytes} bytes)`);
  }
  return { file: outRel(file), width: header.readUInt32BE(16), height: header.readUInt32BE(20), bytes };
}

async function screenshot(udid, file, timeoutMs = LIMIT.commandMs) {
  await simctl(['io', udid, 'screenshot', file], { timeoutMs });
  return pngInfo(file);
}

function copyCrashReports(executable, sinceMs, dir) {
  const source = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
  let names;
  try {
    names = fs.readdirSync(source);
  } catch {
    return [];
  }
  const reports = names
    .filter((name) => name.startsWith(`${executable}-`) && /\.(?:ips|crash)$/.test(name))
    .map((name) => ({ name, mtime: stat(path.join(source, name))?.mtimeMs ?? 0 }))
    .filter((report) => report.mtime >= sinceMs)
    .sort((a, b) => a.mtime - b.mtime)
    .slice(0, LIMIT.crashReports);
  if (reports.length === 0) return [];
  const target = path.join(dir, 'crash-reports');
  fs.mkdirSync(target);
  return reports.map(({ name }) => {
    fs.copyFileSync(path.join(source, name), path.join(target, name));
    return capLog(path.join(target, name));
  });
}

/** simctl launch environment: only the variables this run chooses reach the app. */
function launchEnv(socket, nativeLog) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SIMCTL_CHILD_')));
  env.SIMCTL_CHILD_NO_COLOR = '1';
  env.SIMCTL_CHILD_TAURI_PLAYWRIGHT_SOCKET = socket;
  env.SIMCTL_CHILD_NOVELIST_NATIVE_TAURI_LOG = nativeLog;
  return env;
}

// Readiness of the real WebView, read through the bridge.
const READY_STATE = `(() => {
  const marks = ${JSON.stringify(STARTUP_MARKS)};
  const shell = document.querySelector('[data-testid="welcome-screen"], [data-testid="app-layout"]');
  const rect = shell ? shell.getBoundingClientRect() : null;
  return {
    readyState: document.readyState,
    visibility: document.visibilityState,
    bridge: window.__PW_ACTIVE__ === true,
    ipc: typeof window.__TAURI_INTERNALS__?.invoke === 'function',
    mounted: !!document.querySelector('#app > *'),
    initError: document.querySelector('[data-testid="platform-init-error"]')?.textContent?.trim() ?? null,
    marks: Object.fromEntries(marks.map((name) => [name, performance.getEntriesByName('novelist.' + name)[0]?.startTime ?? null])),
    shell: shell ? shell.getAttribute('data-testid') : null,
    shellVisible: !!rect && rect.width > 0 && rect.height > 0,
    timeOrigin: performance.timeOrigin,
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
  };
})()`;

const DOM_SNAPSHOT = `(() => ({
  url: location.href,
  readyState: document.readyState,
  activeElement: document.activeElement ? document.activeElement.outerHTML.slice(0, 400) : null,
  testIds: Array.from(document.querySelectorAll('[data-testid]')).slice(0, 400).map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.getAttribute('data-testid'), visible: r.width > 0 && r.height > 0 && !el.closest('[inert]'), text: (el.textContent || '').trim().slice(0, 80) };
  }),
  text: (document.body ? document.body.innerText : '').slice(0, 20000),
}))()`;

// ── One device ────────────────────────────────────────────────────────────

/**
 * The app on one simulator across launches: the bridge (client + page), log
 * observation, liveness, screenshots. scripts/mobile-ios-flows.mjs uses
 * page, role, family, dir, appPath, dataContainer, log(), assertHealthy(),
 * screenshot(), reloadFrontend() and relaunch().
 */
class DeviceSession {
  constructor({ record, udid, app, dir, socketTag, bridge }) {
    this.record = record;
    this.role = record.role;
    this.family = record.family;
    this.udid = udid;
    this.appPath = app.path;
    this.dir = dir;
    this.socketTag = socketTag;
    this.bridge = bridge;
    this.unified = new LogTail(path.join(dir, 'unified.log'));
    this.nativeLog = path.join(dir, 'native-startup.log');
    this.launches = [];
    this.current = null;
    this.client = null;
    this.page = null;
    this.dataContainer = null;
    this.seen = new Map();
    this.error = null;
    this.bridgeError = null;
  }

  log(message) {
    console.log(`  ${this.role} ${message}`);
  }

  readLogs() {
    const sources = [this.unified, ...(this.current?.tails ?? [])];
    for (const source of sources) {
      for (const raw of source.lines()) {
        const bridgeLine = BRIDGE_LINE.exec(raw.replace(ANSI, '').trimEnd());
        if (bridgeLine?.[1] && this.current) this.current.entry.bridgeListening = bridgeLine[2];
        else if (bridgeLine?.[3]) this.bridgeError ??= bridgeLine[3];
        const parsed = parsePhase(raw);
        if (!parsed) continue;
        const entry = { ...parsed, launch: this.launches.length, atSeconds: this.current ? seconds(Date.now() - this.current.launchedAt) : null };
        if (this.record.phases.length < LIMIT.phases) this.record.phases.push(entry);
        if (!this.seen.has(entry.phase)) this.seen.set(entry.phase, entry);
        if (!this.error && ERROR_PHASE.test(entry.phase)) this.error = entry;
      }
    }
  }

  /** running: true/false when known, undefined when it cannot be determined. */
  async liveness() {
    const current = this.current;
    if (!current) return { running: undefined, via: 'not launched' };
    if (current.pid !== undefined) {
      try {
        process.kill(current.pid, 0);
        return { running: true, via: `pid ${current.pid}` };
      } catch (error) {
        return { running: error.code === 'EPERM', via: `pid ${current.pid}` };
      }
    }
    if (Date.now() - current.launchctlAt >= LIMIT.launchctlEveryMs) {
      current.launchctlAt = Date.now();
      const listed = await simctl(['spawn', this.udid, 'launchctl', 'list'], { allowFailure: true, timeoutMs: LIMIT.cleanupMs });
      const job = listed.code === 0 ? listed.stdout.split('\n').map((line) => line.split('\t')).find((fields) => fields[2]?.startsWith(`UIKitApplication:${APP_ID}[`)) : undefined;
      current.launchctl = { running: job ? /^\d+$/.test(job[0]) : undefined, via: 'launchctl list' };
    }
    return current.launchctl;
  }

  logTails() {
    const show = (label, file) => {
      const text = isFile(file) ? tail(fs.readFileSync(file, 'utf8'), 20) : '';
      return text ? `${label} (last lines):\n${text}` : `${label}: empty`;
    };
    return [
      ...(this.current ? [show('app stdout', this.current.files.stdout), show('app stderr', this.current.files.stderr)] : []),
      show('native-startup.log', this.nativeLog),
      show('unified log', path.join(this.dir, 'unified.log')),
    ];
  }

  /** Fail on an app error phase, a bridge server error, or an app that exited. */
  async assertHealthy() {
    this.readLogs();
    if (this.error) fail(`the app reported phase ${this.error.phase}`, this.logTails());
    if (this.bridgeError) fail(`tauri-plugin-playwright could not serve its socket: ${this.bridgeError}`, this.logTails());
    if (!this.current) return;
    const live = await this.liveness();
    if (live.running === false) fail(`the app is no longer running (${live.via})`, this.logTails());
  }

  async launch(label) {
    const index = this.launches.length + 1;
    const socket = `/tmp/novelist-ios-${this.socketTag}-${this.role}-${index}.sock`;
    if (lstat(socket)) fail(`bridge socket path ${socket} already exists; refusing to reuse it`);
    ownedSockets.add(socket);
    const suffix = index === 1 ? '' : `-${index}`;
    const files = { stdout: path.join(this.dir, `app-stdout${suffix}.log`), stderr: path.join(this.dir, `app-stderr${suffix}.log`) };
    const entry = { label, socket, pid: null, launchOutput: null, bridgeListening: null, seconds: {}, ready: null, files: {} };
    this.launches.push({ entry, files, socket });
    this.record.launches.push(entry);

    const launchedAt = Date.now();
    const launched = await simctl(['launch', `--stdout=${files.stdout}`, `--stderr=${files.stderr}`, this.udid, APP_ID], { env: launchEnv(socket, this.nativeLog) });
    const pidText = new RegExp(`^${APP_ID.replaceAll('.', '\\.')}: (\\d+)\\s*$`, 'm').exec(launched.stdout)?.[1];
    entry.pid = pidText === undefined ? null : Number(pidText);
    entry.launchOutput = launched.stdout.trim();
    this.current = {
      entry,
      files,
      pid: entry.pid ?? undefined,
      launchedAt,
      tails: [new LogTail(files.stdout), new LogTail(files.stderr)],
      launchctlAt: 0,
      launchctl: { running: undefined },
    };
    const deadline = launchedAt + LIMIT.startupMs;

    // 1. The plugin binds the socket the app was told about.
    for (;;) {
      await this.assertHealthy();
      const found = lstat(socket);
      if (found?.isSocket()) break;
      if (found) fail(`${socket} exists but is not a socket`);
      if (Date.now() >= deadline) {
        fail(`the app did not create the bridge socket ${socket} within ${LIMIT.startupMs / 1000} s`, [
          'the app must be built with: node scripts/mobile.mjs ios build --e2e (tauri-plugin-playwright)',
          isFile(this.nativeLog) ? null : 'native-startup.log is missing: the app did not run the e2e-testing startup logger with this environment',
          ...this.logTails(),
        ]);
      }
      await delay(LIMIT.pollMs);
    }
    entry.seconds.socket = seconds(Date.now() - launchedAt);

    // 2. PluginClient connects and the plugin answers.
    this.client?.disconnect();
    this.client = new this.bridge.BridgeClient(socket);
    await within(this.client.connect(), LIMIT.connectMs, `could not connect to the bridge socket ${socket} within ${LIMIT.connectMs / 1000} s`);
    const pong = await this.client.send({ type: 'ping' });
    if (pong?.ok !== true || pong.data !== 'pong') fail(`the bridge answered ping with ${JSON.stringify(pong)}`);
    entry.seconds.ping = seconds(Date.now() - launchedAt);
    this.page = new this.bridge.TauriPage(this.client);
    this.page.setDefaultTimeout(10_000);

    // 3. The real WebView: Tauri IPC, mounted app, startup marks, visible shell.
    entry.ready = await this.waitReady(deadline, null);
    entry.seconds.ready = seconds(Date.now() - launchedAt);
    if (!this.dataContainer) {
      const container = await simctl(['get_app_container', this.udid, APP_ID, 'data']);
      this.dataContainer = fs.realpathSync(container.stdout.trim());
    }
    this.log(`${label}: socket ${entry.seconds.socket} s, ping ${entry.seconds.ping} s, ready ${entry.seconds.ready} s after launch (pid ${entry.pid ?? 'unknown'})`);
    return entry;
  }

  async waitReady(deadline, previousOrigin) {
    let last = null;
    for (;;) {
      await this.assertHealthy();
      try {
        last = await this.page.evaluate(READY_STATE);
      } catch (error) {
        // A failed evaluation (page still loading) is retried; a dead bridge is not.
        if (!String(error?.message).startsWith('TauriPage command')) throw error;
        last = { evalError: error.message };
      }
      if (last?.initError) fail(`the app shows its platform init error: ${last.initError}`, this.logTails());
      const fresh = previousOrigin === null || (last?.timeOrigin && last.timeOrigin !== previousOrigin);
      if (
        fresh &&
        last?.readyState === 'complete' &&
        last.visibility === 'visible' &&
        last.bridge &&
        last.ipc &&
        last.mounted &&
        last.shellVisible &&
        STARTUP_MARKS.every((mark) => last.marks?.[mark] !== null && last.marks?.[mark] !== undefined)
      ) {
        return last;
      }
      if (Date.now() >= deadline) fail('the app WebView did not become ready', [`last state: ${JSON.stringify(last)}`, ...this.logTails()]);
      await delay(LIMIT.pollMs);
    }
  }

  /** location.reload() in the app WebView, then the same readiness as a launch. */
  async reloadFrontend() {
    const before = await this.page.evaluate('performance.timeOrigin');
    await this.page.evaluate('(setTimeout(() => location.reload(), 100), true)');
    const ready = await this.waitReady(Date.now() + LIMIT.startupMs, before);
    this.record.reloads.push({ at: new Date().toISOString(), ready });
    return ready;
  }

  async terminate() {
    if (!this.current) return;
    await simctl(['terminate', this.udid, APP_ID], { timeoutMs: LIMIT.cleanupMs });
    const deadline = Date.now() + LIMIT.terminateMs;
    while ((await this.liveness()).running === true) {
      if (Date.now() >= deadline) fail(`the app did not exit within ${LIMIT.terminateMs / 1000} s of simctl terminate`);
      await delay(LIMIT.pollMs);
    }
    this.readLogs();
    this.client?.disconnect();
    this.client = null;
    this.page = null;
    this.current = null;
  }

  /** Terminate the app process and launch it again (new socket, fresh WebView). */
  async relaunch() {
    await this.terminate();
    await this.launch('relaunch');
  }

  async screenshot(name) {
    const shot = await screenshot(this.udid, path.join(this.dir, name));
    this.log(`screenshot ${shot.file} (${shot.width}x${shot.height})`);
    return shot;
  }

  /** DOM state for the evidence when a step failed, if the bridge still answers. */
  async captureDom() {
    if (!this.page || this.client?.broken) return null;
    try {
      const dom = await within(this.page.evaluate(DOM_SNAPSHOT), 20_000, 'DOM snapshot timed out');
      const file = path.join(this.dir, 'failure-dom.json');
      fs.writeFileSync(file, JSON.stringify(dom, null, 2).slice(0, LIMIT.domBytes));
      return outRel(file);
    } catch (error) {
      return { error: error.message };
    }
  }
}

async function smokeDevice(target, app, runTag, socketTag, bridge) {
  const { role, family, runtime, deviceType } = target;
  const dir = path.join(outDir, role);
  fs.mkdirSync(dir);
  const record = {
    role,
    family,
    name: `Novelist Smoke ${family} ${runTag}`,
    deviceType,
    runtime: runtime.identifier,
    udid: null,
    status: 'running',
    stage: 'create',
    failure: null,
    seconds: {},
    launches: [],
    reloads: [],
    ready: null,
    logPhases: null,
    phases: [],
    flows: [],
    welcomeScreenshot: null,
    screenshot: null,
    files: {},
    cleanup: {},
  };
  evidence.devices.push(record);
  step(`${role}: ${deviceType.name} on ${runtime.name}`);
  const startedAt = Date.now();
  const timed = async (key, task) => {
    const t0 = Date.now();
    const result = await task();
    record.seconds[key] = seconds(Date.now() - t0);
    return result;
  };
  let booted = false;
  let logStream = null;
  let session = null;
  try {
    const created = await timed('create', () => simctl(['create', record.name, deviceType.identifier, runtime.identifier]));
    const udid = created.stdout.trim();
    if (!UDID.test(udid)) fail(`simctl create printed ${JSON.stringify(udid)} instead of a device UDID`);
    ownedDevices.add(udid);
    record.udid = udid;
    console.log(`created ${record.name} (${udid})`);

    record.stage = 'boot';
    record.files.bootstatus = outRel(path.join(dir, 'bootstatus.log'));
    await timed('boot', () => simctl(['bootstatus', udid, '-b'], { timeoutMs: LIMIT.bootMs, logFile: path.join(dir, 'bootstatus.log') }));
    booted = true;
    console.log(`booted in ${record.seconds.boot} s`);

    record.stage = 'install';
    await timed('install', () => simctl(['install', udid, app.path]));

    record.stage = 'launch';
    logStream = startLogStream(udid, app.executable, path.join(dir, 'unified.log'));
    session = new DeviceSession({ record, udid, app, dir, socketTag, bridge });
    const first = await session.launch('launch');
    record.ready = first.ready;
    record.seconds.startup = first.seconds.ready;
    // Diagnostics only: the unified log may cut a coalesced stdout chunk
    // short (`<…>`), so a phase missing here is not a failure when the DOM
    // marks above prove it.
    session.readLogs();
    record.logPhases = Object.fromEntries(STARTUP_MARKS.map((mark) => [mark, session.seen.get(mark) ?? null]));

    record.stage = 'welcome';
    record.welcomeScreenshot = await session.screenshot('welcome.png');

    await runDeviceFlows(session, { root: ROOT, webdav, record });

    record.stage = 'final';
    record.screenshot = record.flows.at(-1)?.result?.screenshot ?? null;
    if (!record.screenshot) fail('the flows finished without the final editor screenshot');
    await session.assertHealthy();
    const live = await session.liveness();
    if (live.running !== true) fail(`could not confirm the app is still running at the end (${live.via})`, session.logTails());
    record.liveness = live.via;
    record.status = 'passed';
    console.log(`${role}: passed; final screenshot ${record.screenshot.file} (${record.screenshot.width}x${record.screenshot.height})`);
  } catch (error) {
    record.status = 'failed';
    record.failure = { stage: record.stage, message: error.message, hints: error.hints ?? [] };
    report(error);
    if (session) record.failureDom = await session.captureDom();
    if (booted) {
      try {
        record.failureScreenshot = await screenshot(record.udid, path.join(dir, 'failure.png'), LIMIT.cleanupMs);
      } catch (screenshotError) {
        record.failureScreenshot = { error: screenshotError.message };
      }
    }
    // Device state for the evidence. A `create` that failed or timed out may
    // still have made the device: the run-unique name identifies it.
    const listed = await simctl(['list', '--json', 'devices'], { allowFailure: true, timeoutMs: LIMIT.cleanupMs }).catch(() => null);
    let devices = [];
    try {
      devices = Object.values(JSON.parse(listed?.stdout ?? '{}').devices ?? {}).flat();
    } catch {
      // Leave deviceState unknown.
    }
    if (!record.udid) {
      const orphan = devices.find((entry) => entry.name === record.name && UDID.test(entry.udid ?? ''));
      if (orphan) {
        ownedDevices.add(orphan.udid);
        record.udid = orphan.udid;
      }
    }
    const device = record.udid ? devices.find((entry) => entry.udid === record.udid) : undefined;
    record.deviceState = device ? { state: device.state, isAvailable: device.isAvailable, availabilityError: device.availabilityError ?? null } : null;
  } finally {
    await teardown(record, session, logStream, booted);
    if (record.status === 'failed') record.files.crashReports = copyCrashReports(app.executable, startedAt, dir);
    record.seconds.total = seconds(Date.now() - startedAt);
  }
}

/** Terminate the app, stop the log stream, shut down and delete this run's device, remove its sockets. */
async function teardown(record, session, logStream, booted) {
  const attempt = async (key, args) => {
    try {
      const result = await simctl(args, { allowFailure: true, timeoutMs: LIMIT.cleanupMs });
      record.cleanup[key] = result.code === 0 ? 'ok' : tail(result.stderr || result.stdout, 2) || `status ${result.code}`;
      return result.code === 0;
    } catch (error) {
      record.cleanup[key] = error.message;
      return false;
    }
  };
  const { udid } = record;
  session?.client?.disconnect();
  if (udid && booted) await attempt('terminate', ['terminate', udid, APP_ID]);
  if (logStream) record.files.unifiedLog = await logStream.stop();
  if (udid) await attempt('shutdown', ['shutdown', udid]);
  for (const [index, launch] of (session?.launches ?? []).entries()) {
    launch.entry.files = { stdout: capLog(launch.files.stdout), stderr: capLog(launch.files.stderr) };
    try {
      record.cleanup[`socket${index + 1}`] = removeSocket(launch.socket);
    } catch (error) {
      record.cleanup[`socket${index + 1}`] = error.message;
    }
  }
  if (session) record.files.nativeStartupLog = capLog(session.nativeLog);
  if (!udid) return;
  if (await attempt('delete', ['delete', udid])) {
    ownedDevices.delete(udid);
    return;
  }
  const message = `could not delete simulator ${udid} created by this run (${record.cleanup.delete})`;
  warn(message);
  record.status = 'failed';
  record.failure ??= { stage: 'cleanup', message, hints: [] };
}

/**
 * Replace every WebDAV password (and Basic credential) found in the evidence
 * with `[redacted]`; returns where they were found.
 */
function scrubEvidence(secrets) {
  const needles = secrets.map((secret) => Buffer.from(secret));
  const redacted = Buffer.from('[redacted]');
  const hits = [];
  for (const relFile of listFiles(outDir)) {
    const file = path.join(outDir, relFile);
    if ((stat(file)?.size ?? 0) > LIMIT.captureBytes) continue;
    let bytes = fs.readFileSync(file);
    let count = 0;
    for (const needle of needles) {
      for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle)) {
        bytes = Buffer.concat([bytes.subarray(0, at), redacted, bytes.subarray(at + needle.length)]);
        count += 1;
      }
    }
    if (count > 0) {
      fs.writeFileSync(file, bytes);
      hits.push({ file: relFile, count });
    }
  }
  let json = JSON.stringify(evidence);
  if (secrets.some((secret) => json.includes(secret))) {
    for (const secret of secrets) json = json.replaceAll(secret, '[redacted]');
    Object.assign(evidence, JSON.parse(json));
    hits.push({ file: 'evidence.json' });
  }
  return hits;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  stage = 'evidence';
  outDir = prepareOutDir(options.out);
  console.log(`evidence directory ${outDir}`);

  // The bundle first: it needs only plutil and cargo, and after a failed
  // build its diagnostics matter more than the simulator toolchain.
  stage = 'app';
  step('Simulator app');
  const app = await locateApp(options.app, appVersion());

  stage = 'toolchain';
  step('Toolchain');
  await checkToolchain();
  const bridge = await loadBridge();

  stage = 'runtime';
  step('Simulator runtime and device types');
  const targets = await selectTargets();

  stage = 'webdav';
  step('Loopback WebDAV server (macOS Apache, mod_dav_fs)');
  webdav = await startLoopbackWebDav({ users: targets.map((target) => target.role) });
  evidence.webdav = { server: `Apache ${webdav.version ?? 'unknown'}`, port: webdav.port, probes: webdav.probes, stop: null };
  console.log(`WebDAV on 127.0.0.1:${webdav.port} (${evidence.webdav.server}), one account per device`);

  stage = 'devices';
  const socketTag = randomBytes(3).toString('hex');
  const runTag = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${socketTag}`;
  for (const target of targets) await smokeDevice(target, app, runTag, socketTag, bridge);

  const failed = evidence.devices.filter((device) => device.status !== 'passed');
  if (failed.length > 0) fail(`simulator smoke failed: ${failed.map((device) => `${device.role} (${device.failure?.stage}: ${device.failure?.message})`).join('; ')}`);
  evidence.status = 'passed';
  step('Passed');
  for (const device of evidence.devices) {
    console.log(`${device.role}: ${device.deviceType.name}, ${evidence.runtime.name}, ready ${device.seconds.startup} s after launch, flows ${device.flows.map((flow) => flow.name).join(', ')}, ${path.join(outDir, device.screenshot.file)}`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  evidence.status = 'failed';
  evidence.failures.push({ stage, message: error.message, hints: error.hints ?? [] });
  if (stage !== 'devices') report(error);
  else console.error(inActions ? `::error::${error.message}` : `error: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (webdav) {
    try {
      evidence.webdav.stop = await webdav.stop({ logDir: path.join(outDir, 'webdav'), logBytes: LIMIT.logBytes });
    } catch (error) {
      evidence.webdav.stop = { error: error.message };
    }
    const hits = scrubEvidence(webdav.secrets());
    evidence.secretScan = { scanned: true, hits };
    if (hits.length > 0) {
      const message = `a WebDAV password reached the evidence (now redacted): ${hits.map((hit) => hit.file).join(', ')}`;
      console.error(inActions ? `::error::${message}` : `error: ${message}`);
      evidence.status = 'failed';
      evidence.failures.push({ stage: 'secret-scan', message });
      process.exitCode = 1;
    }
  }
  cleanupSync();
  writeEvidence();
  if (outDir) console.log(`evidence ${path.join(outDir, 'evidence.json')}`);
}
