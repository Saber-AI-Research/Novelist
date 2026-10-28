#!/usr/bin/env node
// Native iOS simulator smoke test for the unsigned simulator app that
// `node scripts/mobile.mjs ios build` produces (CI: .github/workflows/mobile-ci.yml).
//
// The bundle is found by its Info.plist, never by file name. A fresh iPhone
// and a fresh iPad simulator are created on the newest installed iOS runtime
// and run one after the other: boot, install, launch, wait for the frontend
// startup phases app/main.ts and App.svelte report through the
// `log_startup_phase` command (Rust tracing on the app's stdout), watch for a
// crash, take a screenshot. Only devices this run created are terminated,
// shut down and deleted; files are written only to the evidence directory.
// Needs no signing material.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AppVersionError, readAppVersion } from './app-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = path.join(ROOT, 'core', 'gen', 'apple', 'build', 'arm64-sim');
const APP_ID = 'com.novelist.app';
const MIN_OS = '16.0';
const DEVICE_FAMILY = [1, 2]; // iPhone, iPad
const TARGETS = [
  { role: 'iphone', family: 'iPhone' },
  { role: 'ipad', family: 'iPad' },
];
// log_startup_phase names: the root component is mounted and the first frame
// after boot ran (app/main.ts), App.svelte painted (its startup report
// mirrors every mark into the log).
const READY_PHASES = ['frontend.main.mounted', 'frontend.main.window-shown', 'frontend.app.first-paint'];
const ERROR_PHASE = /^frontend\.(?:main\.boot-failed|error:|reject:)/;
const LIMIT = {
  commandMs: 120_000,
  cleanupMs: 30_000,
  bootMs: 300_000,
  startupMs: 180_000,
  // Crash watch after the ready phases, before the screenshot.
  watchMs: 5_000,
  pollMs: 500,
  launchctlEveryMs: 2_000,
  stopMs: 10_000,
  captureBytes: 32 * 1024 * 1024,
  logBytes: 4 * 1024 * 1024,
  phases: 200,
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
               ios build\`) whose Info.plist says ${APP_ID} for
               iPhoneSimulator; other bundles there are rejected.
  --out DIR    Evidence directory; must be new or empty. Default: a new
               novelist-ios-smoke-* directory in $RUNNER_TEMP or the system
               temp directory.
  -h, --help   Show this help.

Needs macOS with full Xcode and an installed iOS ${MIN_OS}+ simulator runtime.
The app must be ${APP_ID}, iPhone + iPad, MinimumOSVersion ${MIN_OS}, with
CFBundleShortVersionString equal to the X.Y.Z of core/Cargo.toml.

For one fresh iPhone and then one fresh iPad simulator (newest device type
of the newest available iOS runtime): simctl create; bootstatus -b
(${LIMIT.bootMs / 1000} s); install; launch with stdout/stderr to files; wait
up to ${LIMIT.startupMs / 1000} s for the log_startup_phase phases
  ${READY_PHASES.join(', ')}
failing at once on frontend.main.boot-failed, frontend.error or
frontend.reject, or when the app exits; watch ${LIMIT.watchMs / 1000} s more for a crash;
screenshot; terminate the app, shut down and delete the device. Simulators
that existed before the run are never touched.

Evidence in DIR: evidence.json, and per device (iphone/, ipad/):
screenshot.png, app-stdout.log, app-stderr.log, unified.log, bootstatus.log;
on failure also failure.png and crash-reports/ when available. Logs are
capped at ${LIMIT.logBytes / 1024 / 1024} MiB each. Exit status 0 only when both devices passed.
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

function report(error) {
  if (!(error instanceof Failure)) {
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

// ── Evidence and cleanup state ────────────────────────────────────────────

const evidence = {
  schema: 1,
  status: 'running',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  failures: [],
  host: null,
  app: null,
  runtime: null,
  devices: [],
};
let outDir = null;
let stage = 'arguments';
// Live child processes (simctl commands, log streams) and the simulators this
// run created and has not deleted yet. Cleanup only ever acts on these.
const children = new Set();
const ownedDevices = new Set();

const outRel = (file) => path.relative(outDir, file);

function writeEvidence() {
  if (!outDir) return;
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
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
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    warn(`received ${signal}; removing the simulators this run created`);
    evidence.status = 'interrupted';
    evidence.failures.push({ stage, message: `received ${signal}` });
    cleanupSync();
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

/** Cap a log file the app wrote directly (simctl launch --stdout/--stderr). */
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
      [...rejected, ...accepted.map((app) => `candidate ${rel(app)}`), 'build it with: node scripts/mobile.mjs ios build'],
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

/**
 * The running app on one device: startup phases parsed from the tracing
 * lines `log_startup_phase` writes to stdout
 * (`… novelist::startup: frontend phase phase=<name> since_start_ms=<ms>`),
 * and whether the process is still alive.
 */
class AppRun {
  constructor(record, udid, pid, files) {
    this.record = record;
    this.udid = udid;
    this.pid = pid;
    this.files = files;
    this.tails = [new LogTail(files.stdout), new LogTail(files.stderr)];
    this.launchedAt = Date.now();
    this.seen = new Map();
    this.error = null;
    this.launchctlAt = 0;
    this.launchctl = { running: undefined };
  }

  readPhases() {
    for (const tailer of this.tails) {
      for (const raw of tailer.lines()) {
        const match = /novelist::startup:.*?\bphase=(.*?)(?: since_start_ms=(\S+))?\s*$/.exec(raw.replace(ANSI, ''));
        if (!match) continue;
        const entry = { phase: match[1], sinceStartMs: match[2] === undefined ? null : Number(match[2]), atSeconds: seconds(Date.now() - this.launchedAt) };
        if (this.record.phases.length < LIMIT.phases) {
          this.record.phases.push(entry);
          console.log(`  ${this.record.role} +${entry.atSeconds}s ${entry.phase}`);
        }
        if (!this.seen.has(entry.phase)) this.seen.set(entry.phase, entry);
        if (!this.error && ERROR_PHASE.test(entry.phase)) this.error = entry;
      }
    }
  }

  ready() {
    return READY_PHASES.every((phase) => this.seen.has(phase));
  }

  /** running: true/false when known, undefined when it cannot be determined. */
  async liveness() {
    if (this.pid !== undefined) {
      try {
        process.kill(this.pid, 0);
        return { running: true, via: `pid ${this.pid}` };
      } catch (error) {
        return { running: error.code === 'EPERM', via: `pid ${this.pid}` };
      }
    }
    if (Date.now() - this.launchctlAt >= LIMIT.launchctlEveryMs) {
      this.launchctlAt = Date.now();
      const listed = await simctl(['spawn', this.udid, 'launchctl', 'list'], { allowFailure: true, timeoutMs: LIMIT.cleanupMs });
      const job = listed.code === 0 ? listed.stdout.split('\n').map((line) => line.split('\t')).find((fields) => fields[2]?.startsWith(`UIKitApplication:${APP_ID}[`)) : undefined;
      this.launchctl = { running: job ? /^\d+$/.test(job[0]) : undefined, via: 'launchctl list' };
    }
    return this.launchctl;
  }

  logTails() {
    const show = (label, file) => {
      const text = isFile(file) ? tail(fs.readFileSync(file, 'utf8'), 20) : '';
      return text ? `${label} (last lines):\n${text}` : `${label}: empty`;
    };
    return [show('app stdout', this.files.stdout), show('app stderr', this.files.stderr)];
  }

  /** Poll until `until()` holds (true) or the deadline passes (false); fail on an error phase or exit. */
  async watch(until, deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      this.readPhases();
      if (this.error) fail(`the app reported startup phase ${this.error.phase}`, this.logTails());
      if (until()) return true;
      const live = await this.liveness();
      if (live.running === false) fail(`the app is no longer running (${live.via})`, this.logTails());
      if (Date.now() >= deadline) return false;
      await delay(LIMIT.pollMs);
    }
  }
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
function launchEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SIMCTL_CHILD_')));
  env.SIMCTL_CHILD_NO_COLOR = '1';
  return env;
}

// ── One device ────────────────────────────────────────────────────────────

async function smokeDevice(target, app, runTag) {
  const { role, family, runtime, deviceType } = target;
  const dir = path.join(outDir, role);
  fs.mkdirSync(dir);
  const files = { stdout: path.join(dir, 'app-stdout.log'), stderr: path.join(dir, 'app-stderr.log') };
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
    launch: null,
    ready: null,
    phases: [],
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
    const launched = await simctl(['launch', `--stdout=${files.stdout}`, `--stderr=${files.stderr}`, udid, APP_ID], { env: launchEnv() });
    const pidText = new RegExp(`^${APP_ID.replaceAll('.', '\\.')}: (\\d+)\\s*$`, 'm').exec(launched.stdout)?.[1];
    const pid = pidText === undefined ? undefined : Number(pidText);
    record.launch = { output: launched.stdout.trim(), pid: pid ?? null };
    const running = new AppRun(record, udid, pid, files);

    record.stage = 'startup';
    if (!(await running.watch(() => running.ready(), LIMIT.startupMs))) {
      const missing = READY_PHASES.filter((phase) => !running.seen.has(phase));
      const last = record.phases.at(-1)?.phase;
      fail(`no ${missing.join(', ')} within ${LIMIT.startupMs / 1000} s of launch (last phase: ${last ?? 'none'})`, running.logTails());
    }
    record.seconds.startup = seconds(Date.now() - running.launchedAt);
    record.ready = Object.fromEntries(READY_PHASES.map((phase) => [phase, running.seen.get(phase)]));
    console.log(`frontend ready ${record.seconds.startup} s after launch`);

    record.stage = 'watch';
    await running.watch(() => false, LIMIT.watchMs);

    record.stage = 'screenshot';
    record.screenshot = await screenshot(udid, path.join(dir, 'screenshot.png'));
    running.readPhases();
    if (running.error) fail(`the app reported startup phase ${running.error.phase}`, running.logTails());
    const live = await running.liveness();
    if (live.running !== true) fail(`could not confirm the app is still running after the screenshot (${live.via})`, running.logTails());
    record.liveness = live.via;
    record.status = 'passed';
    console.log(`${role}: passed; screenshot ${record.screenshot.file} (${record.screenshot.width}x${record.screenshot.height})`);
  } catch (error) {
    record.status = 'failed';
    record.failure = { stage: record.stage, message: error.message, hints: error.hints ?? [] };
    report(error);
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
    await teardown(record, logStream, files, booted);
    if (record.status === 'failed') record.files.crashReports = copyCrashReports(app.executable, startedAt, dir);
    record.seconds.total = seconds(Date.now() - startedAt);
  }
}

/** Terminate the app, stop the log stream, shut down and delete this run's device. */
async function teardown(record, logStream, files, booted) {
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
  if (udid && booted) await attempt('terminate', ['terminate', udid, APP_ID]);
  if (logStream) record.files.unifiedLog = await logStream.stop();
  if (udid) await attempt('shutdown', ['shutdown', udid]);
  for (const [key, file] of Object.entries(files)) record.files[key] = capLog(file);
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

  stage = 'runtime';
  step('Simulator runtime and device types');
  const targets = await selectTargets();

  stage = 'devices';
  const runTag = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
  for (const target of targets) await smokeDevice(target, app, runTag);

  const failed = evidence.devices.filter((device) => device.status !== 'passed');
  if (failed.length > 0) fail(`simulator smoke failed: ${failed.map((device) => `${device.role} (${device.failure?.stage}: ${device.failure?.message})`).join('; ')}`);
  evidence.status = 'passed';
  step('Passed');
  for (const device of evidence.devices) {
    console.log(`${device.role}: ${device.deviceType.name}, ${evidence.runtime.name}, ready ${device.seconds.startup} s after launch, ${path.join(outDir, device.screenshot.file)}`);
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
  cleanupSync();
  writeEvidence();
  if (outDir) console.log(`evidence ${path.join(outDir, 'evidence.json')}`);
}
