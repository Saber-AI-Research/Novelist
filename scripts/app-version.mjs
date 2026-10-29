#!/usr/bin/env node
// The app version has exactly one source: [package].version in core/Cargo.toml.
// core/Cargo.lock mirrors it (generated). Tauri's runtime and desktop bundler
// fall back to it because tauri.conf.json has no `version`; tauri-cli's mobile
// commands do not, so scripts/mobile.mjs passes it to them. package.json is
// private and carries no version. Reading fails when a second copy reappears.
//
//   node scripts/app-version.mjs                 print the app version
//   node scripts/app-version.mjs bump <version>  set a new release version

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SCRIPT), '..');
const NUMBER = '(0|[1-9][0-9]*)';
// The two forms release tags accept: vX.Y.Z (stable) and vX.Y.Z-beta.N.
const RELEASE_VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(-beta\\.[1-9][0-9]*)?$`);
const TAURI_CONFIG = /^tauri(\.[A-Za-z0-9_-]+)?\.conf\.json$/;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const USAGE = `Novelist app version (single source: core/Cargo.toml [package].version)

Usage:
  node scripts/app-version.mjs                 Print the app version.
  node scripts/app-version.mjs bump <version>  Set it to <version> (X.Y.Z or
                                               X.Y.Z-beta.N, newer than today's)
                                               and refresh core/Cargo.lock with
                                               \`cargo update --workspace --offline\`.

Both fail when package.json or a core/tauri*.conf.json declares "version".
`;

export class AppVersionError extends Error {
  constructor(message, hints = []) {
    super(message);
    this.name = 'AppVersionError';
    this.hints = hints;
  }
}

function fail(message, hints = []) {
  throw new AppVersionError(message, hints);
}

function locations(root) {
  const core = path.join(root, 'core');
  return { root, core, manifest: path.join(core, 'Cargo.toml'), lock: path.join(core, 'Cargo.lock') };
}

const relative = (root, file) => path.relative(root, file) || '.';
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readJson(root, file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return fail(`could not parse ${relative(root, file)}: ${error.message}`);
  }
}

/** A second, hand-maintained version would drift from Cargo.toml: refuse it. */
function rejectDuplicateVersions(root) {
  const { core } = locations(root);
  const sources = [path.join(root, 'package.json')];
  for (const name of fs.readdirSync(core).sort()) {
    if (TAURI_CONFIG.test(name)) sources.push(path.join(core, name));
  }
  for (const file of sources) {
    if (!fs.existsSync(file)) continue;
    const json = readJson(root, file);
    if (json !== null && typeof json === 'object' && Object.hasOwn(json, 'version')) {
      fail(`${relative(root, file)} declares "version"; the app version lives only in core/Cargo.toml [package].version`, [
        `remove "version" from ${relative(root, file)}`,
        'Tauri falls back to Cargo.toml; change the version with `node scripts/app-version.mjs bump <version>`',
      ]);
    }
  }
}

function cargo(root, args, { capture = true } = {}) {
  const { core } = locations(root);
  // cwd = core/ so a core/.cargo/config.toml applies as it does for builds.
  const result = spawnSync('cargo', args, {
    cwd: core,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
  });
  if (result.error) {
    fail(result.error.code === 'ENOENT' ? 'cargo was not found on PATH' : `could not run cargo ${args[0]}: ${result.error.message}`, [
      'install Rust with rustup: https://rustup.rs',
    ]);
  }
  return result;
}

function cargoVersion(root) {
  const { manifest } = locations(root);
  const result = cargo(root, ['metadata', '--no-deps', '--format-version', '1', '--offline', '--manifest-path', manifest]);
  if (result.status !== 0) {
    fail(`cargo metadata failed for ${relative(root, manifest)}`, [result.stderr.trim().split('\n').slice(-10).join('\n')]);
  }
  const target = fs.realpathSync(manifest);
  const metadata = JSON.parse(result.stdout);
  const pkg = metadata.packages.find((candidate) => fs.existsSync(candidate.manifest_path) && fs.realpathSync(candidate.manifest_path) === target);
  if (!pkg?.version) fail(`cargo metadata reported no package version for ${relative(root, manifest)}`);
  return { name: pkg.name, version: pkg.version };
}

/** The app version: core/Cargo.toml [package].version, via `cargo metadata`. */
export function readAppVersion(root = DEFAULT_ROOT) {
  rejectDuplicateVersions(root);
  return cargoVersion(root).version;
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) fail(`"${version}" is not a semantic version`);
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') ?? [] };
}

/** Semantic-version precedence (build metadata ignored): <0, 0 or >0. */
function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i += 1) {
    const [x, y] = [left.pre[i], right.pre[i]];
    if (x === y) continue;
    const [xNumeric, yNumeric] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return left.pre.length - right.pre.length;
}

/** Replace the one literal `version = "…"` line of the [package] table. */
function setManifestVersion(root, text, current, next) {
  const lines = text.split('\n');
  const hits = [];
  let inPackage = false;
  lines.forEach((line, index) => {
    const header = /^[ \t]*(\[\[?)[ \t]*([^\]#]*?)[ \t]*\]\]?[ \t]*(?:#.*)?\r?$/.exec(line);
    if (header) {
      inPackage = header[1] === '[' && header[2] === 'package';
      return;
    }
    if (!inPackage) return;
    const field = /^([ \t]*version[ \t]*=[ \t]*)(["'])([^"'\\\r\n]*)\2([ \t]*(?:#[^\r\n]*)?\r?)$/.exec(line);
    if (field) hits.push({ index, field });
    else if (/^[ \t]*version[ \t]*[.=]/.test(line)) hits.push({ index, field: null });
  });
  const manifest = relative(root, locations(root).manifest);
  if (hits.length !== 1 || !hits[0].field) {
    fail(`${manifest} needs exactly one literal \`version = "X.Y.Z"\` line in [package] (found ${hits.length})`, [
      'set it by hand if the manifest layout changed (for example to `version.workspace = true`)',
    ]);
  }
  const [{ index, field }] = hits;
  if (field[3] !== current) fail(`${manifest} [package] version line says ${field[3]}, but cargo metadata reports ${current}`);
  lines[index] = `${field[1]}${field[2]}${next}${field[2]}${field[4]}`;
  return lines.join('\n');
}

/** Cargo.lock with only the workspace root package's version changed. */
function expectedLock(root, text, name, current, next) {
  const entry = new RegExp(`^(\\[\\[package\\]\\]\\r?\\nname = "${escapeRegExp(name)}"\\r?\\nversion = ")${escapeRegExp(current)}("\\r?\\n)(?!source = )`, 'gm');
  const matches = text.match(entry) ?? [];
  if (matches.length !== 1) {
    fail(`${relative(root, locations(root).lock)} has ${matches.length} entries for the workspace package ${name} ${current} (expected 1)`, [
      'bring the lockfile up to date first (`cd core && cargo update --workspace --offline`) and review that change separately',
    ]);
  }
  return text.replace(entry, `$1${next}$2`);
}

function writeFileAtomic(root, file, content) {
  const mode = fs.statSync(file).mode & 0o7777;
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    fail(`could not write ${relative(root, file)}: ${error.message}`);
  }
}

/**
 * Set the app version in core/Cargo.toml and let Cargo rewrite only the
 * workspace entry of core/Cargo.lock (no dependency is upgraded). Any other
 * lockfile change, a cargo failure or an interrupt restores both files.
 */
export function bumpAppVersion(next, root = DEFAULT_ROOT) {
  const { manifest, lock } = locations(root);
  if (!RELEASE_VERSION.test(next ?? '')) {
    fail(`invalid version ${JSON.stringify(next ?? '')}`, ['use X.Y.Z (stable) or X.Y.Z-beta.N, without a leading v; numbers have no leading zeros']);
  }
  rejectDuplicateVersions(root);
  const { name, version: current } = cargoVersion(root);
  if (compareSemver(next, current) <= 0) {
    fail(`${next} is not newer than the current app version ${current}`, ['release versions only move forward; published tags are never reused']);
  }
  if (!fs.existsSync(lock)) fail(`${relative(root, lock)} is missing`, ['restore it from git; the bump must not resolve dependencies from scratch']);

  const manifestBefore = fs.readFileSync(manifest, 'utf8');
  const lockBefore = fs.readFileSync(lock, 'utf8');
  const manifestAfter = setManifestVersion(root, manifestBefore, current, next);
  const lockAfter = expectedLock(root, lockBefore, name, current, next);

  const restore = () => {
    if (fs.readFileSync(manifest, 'utf8') !== manifestBefore) writeFileAtomic(root, manifest, manifestBefore);
    if (fs.readFileSync(lock, 'utf8') !== lockBefore) writeFileAtomic(root, lock, lockBefore);
  };
  // An interrupt must not leave Cargo.toml and Cargo.lock disagreeing: keep
  // running until cargo returns, then restore.
  const ignore = () => {};
  for (const signal of SIGNALS) process.on(signal, ignore);
  try {
    writeFileAtomic(root, manifest, manifestAfter);
    const update = cargo(root, ['update', '--workspace', '--offline', '--manifest-path', manifest], { capture: false });
    if (update.status !== 0) {
      restore();
      fail(`cargo update --workspace --offline ${update.signal ? `was interrupted (${update.signal})` : `exited with status ${update.status}`}; restored core/Cargo.toml and core/Cargo.lock`, [
        update.signal ? '' : 'see cargo\'s error above; offline resolution needs the registry index cached: run `cd core && cargo fetch --locked` online first',
      ]);
    }
    if (fs.readFileSync(lock, 'utf8') !== lockAfter) {
      restore();
      fail(`cargo update changed ${relative(root, lock)} beyond the ${name} version; restored core/Cargo.toml and core/Cargo.lock`, [
        'the lockfile was out of date with the manifests: run `cd core && cargo update --workspace --offline`, review and commit that first',
      ]);
    }
    const reported = cargoVersion(root).version;
    if (reported !== next) {
      restore();
      fail(`cargo metadata reports ${reported} after the bump, expected ${next}; restored core/Cargo.toml and core/Cargo.lock`);
    }
  } finally {
    for (const signal of SIGNALS) process.off(signal, ignore);
  }
  console.log(`${relative(root, manifest)}: version ${current} -> ${next}`);
  console.log(`${relative(root, lock)}: ${name} ${current} -> ${next} (no other entry changed)`);
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === undefined) {
    console.log(readAppVersion());
  } else if (command === '-h' || command === '--help' || command === 'help') {
    console.log(USAGE);
  } else if (command === 'bump') {
    if (rest.length !== 1) fail('bump takes exactly one version', ['node scripts/app-version.mjs bump X.Y.Z (or X.Y.Z-beta.N)']);
    bumpAppVersion(rest[0]);
  } else {
    fail(`unknown command "${command}"`, ['run with --help for usage']);
  }
}

function invokedDirectly() {
  try {
    return process.argv[1] !== undefined && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(SCRIPT);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof AppVersionError)) throw error;
    console.error(process.env.GITHUB_ACTIONS === 'true' ? `::error::${error.message}` : `error: ${error.message}`);
    for (const hint of error.hints.filter(Boolean)) console.error(`  ${hint.replaceAll('\n', '\n  ')}`);
    process.exitCode = 1;
  }
}
