#!/usr/bin/env node
// Novelist mobile toolchain driver (iOS + Android).
//
// One entry point for local development and CI: explicit environment
// validation, Rust checks, unsigned/debug builds that need no production
// secrets, and signed release builds that fail closed. Secret values are only
// tested for presence and handed to child processes through the environment;
// they are never printed. See docs/design-docs/mobile-deployment.md.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppVersionError, readAppVersion } from './app-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'core');
const RELEASE_DIR = path.join(CORE, 'target', 'mobile-release');
const APP_ID = 'com.novelist.app';
const PRODUCT = 'Novelist';
// Android versionCode is a signed 32-bit int; the same number becomes the iOS
// CFBundleVersion so one counter orders every mobile build.
const MAX_BUILD_NUMBER = 2_147_483_647;

const ANDROID = {
  // tauri-cli 2.10.1 ignores NDK_HOME and builds with the lexicographically
  // newest directory under $ANDROID_HOME/ndk, so CI keeps only this one.
  ndk: '27.2.12479018',
  platform: 'android-36',
  // 35.0.0 is the Android Gradle Plugin 8.11 default; 36.0.0 matches compileSdk.
  buildTools: ['35.0.0', '36.0.0'],
  minSdk: 26,
  targets: {
    aarch64: { tauri: 'aarch64', triple: 'aarch64-linux-android', abi: 'arm64-v8a' },
    x86_64: { tauri: 'x86_64', triple: 'x86_64-linux-android', abi: 'x86_64' },
  },
  project: path.join(CORE, 'gen', 'android'),
};

const IOS_MIN_OS = '16.0';
const IOS = {
  minOs: IOS_MIN_OS,
  // `clang` is the clang spelling of the Rust triple: rquickjs hands the Rust
  // triple to bindgen, and clang 17+ rejects `aarch64-apple-ios-sim`.
  device: { tauri: 'aarch64', triple: 'aarch64-apple-ios', clang: `arm64-apple-ios${IOS_MIN_OS}`, sdk: 'iphoneos', out: 'arm64' },
  simulator: { tauri: 'aarch64-sim', triple: 'aarch64-apple-ios-sim', clang: `arm64-apple-ios${IOS_MIN_OS}-simulator`, sdk: 'iphonesimulator', out: 'arm64-sim' },
  // App Store Connect only accepts uploads built with Xcode 26+ since 2026-04-28.
  minUploadXcode: 26,
  project: path.join(CORE, 'gen', 'apple'),
};

const ENV = {
  androidSigning: ['ANDROID_KEYSTORE_PATH', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'],
  iosSigning: ['IOS_CERTIFICATE', 'IOS_CERTIFICATE_PASSWORD', 'IOS_MOBILE_PROVISION'],
  // Setting any of these switches tauri-cli to API-key automatic signing.
  tauriAppleApiKey: ['APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH'],
  asc: ['ASC_API_KEY_ID', 'ASC_API_ISSUER_ID', 'ASC_API_PRIVATE_KEY', 'ASC_API_PRIVATE_KEY_PATH', 'ASC_APP_APPLE_ID'],
};

const USAGE = `Novelist mobile toolchain

Usage:
  node scripts/mobile.mjs <android|ios> <command> [options] [-- <tauri args>]
  node scripts/mobile.mjs build-number [N]

Commands (both platforms):
  doctor    Validate SDKs, toolchains and Rust targets; report which release
            credentials are present (names only). Exit 1 if a build would fail.
  init      Install the Rust targets and verify the committed native project.
  dev       Run \`tauri <platform> dev\` with the validated environment.
            Device names and other tauri flags go after \`--\`.
  check     cargo clippy --locked --lib -D warnings for every mobile target
            (default features only; never --all-features).
  build     Build without any production secret (secrets are removed from
            the child environment):
              android: universal debug APK (aarch64 + x86_64), debug-signed
              ios:     simulator .app (aarch64-sim), not code signed
            --release builds an unsigned release APK / release simulator app.
  publish   Signed release build; fails closed when a credential is missing:
              android: universal APK signed with the release keystore,
                       verified with apksigner against ANDROID_SIGNING_CERT_SHA256
              ios:     App Store Connect export (TestFlight), manual signing
            Output: core/target/mobile-release/

Platform-specific commands:
  android verify   Check an existing APK (--apk PATH): package, minSdk, ABIs,
                   16 KiB page alignment, signer (must equal
                   ANDROID_SIGNING_CERT_SHA256 when that is set).
  android ci-sdk   CI only (GITHUB_ACTIONS=true): install the pinned SDK/NDK
                   packages and delete every other NDK from $ANDROID_HOME/ndk.
  ios upload       Upload the published IPA to App Store Connect (TestFlight)
                   with an App Store Connect API key.

Options:
  --build-number N   Mobile build number (also MOBILE_BUILD_NUMBER). Required
                     for publish/upload; optional for build. 1..${MAX_BUILD_NUMBER}.
  --target T         Restrict targets (android: aarch64, x86_64; ios check:
                     aarch64, aarch64-sim). Repeatable.
  --release          build: produce release-profile artifacts (still unsigned).
  --skip-frontend    build: reuse the existing dist/ instead of running the
                     beforeBuildCommand (\`pnpm build\`); dist/ must be current.
  --ipa PATH         ios upload: IPA to upload (default: the publish output
                     for the current version and build number).
  --apk PATH         android verify: APK to check.
  --regenerate-xcodeproj
                     ios init: run xcodegen on core/gen/apple/project.yml.
  -h, --help         Show this help.

Environment:
  Android: ANDROID_HOME (or ANDROID_SDK_ROOT), JAVA_HOME (JDK 17+), libclang
           (LIBCLANG_PATH or Xcode CLT / apt libclang-dev).
  Android publish: ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD,
           ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD, ANDROID_SIGNING_CERT_SHA256.
  iOS:     macOS with full Xcode (26+ for publish/upload).
  iOS publish: IOS_CERTIFICATE (base64 .p12), IOS_CERTIFICATE_PASSWORD,
           IOS_MOBILE_PROVISION (base64 App Store profile), APPLE_DEVELOPMENT_TEAM.
  iOS upload: ASC_API_KEY_ID, ASC_API_ISSUER_ID, ASC_APP_APPLE_ID and
           ASC_API_PRIVATE_KEY (.p8 contents) or ASC_API_PRIVATE_KEY_PATH.
`;

// ── Output and failure ────────────────────────────────────────────────────

class Failure extends Error {
  constructor(message, hints = []) {
    super(message);
    this.hints = hints;
  }
}

function fail(message, hints = []) {
  throw new Failure(message, hints);
}

const inActions = process.env.GITHUB_ACTIONS === 'true';

function step(message) {
  console.log(`\n==> ${message}`);
}

function warn(message) {
  console.warn(inActions ? `::warning::${message}` : `warning: ${message}`);
}

function rel(file) {
  return path.relative(ROOT, file) || '.';
}

// ── Filesystem helpers ────────────────────────────────────────────────────

function stat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

const isDir = (file) => Boolean(file) && stat(file)?.isDirectory() === true;
const isFile = (file) => Boolean(file) && stat(file)?.isFile() === true;

function isExecutable(file) {
  if (!isFile(file)) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function which(command) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function makePrivateTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── Cleanup and signals ───────────────────────────────────────────────────

const cleanups = [];
let activeChild = null;

function onCleanup(fn) {
  cleanups.push(fn);
}

function runCleanups() {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try {
      fn();
    } catch (error) {
      warn(`cleanup step failed: ${error.message}`);
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    warn(`received ${signal}; stopping and cleaning up`);
    if (activeChild) activeChild.kill(signal);
    runCleanups();
    process.exit(128 + (os.constants.signals[signal] ?? 1));
  });
}

// ── Child processes ───────────────────────────────────────────────────────

/**
 * Run a command. `display` replaces the echoed command line (use it whenever
 * an argument could identify credentials). Captured runs return stdout/stderr.
 */
function run(command, args, { cwd = ROOT, env = process.env, capture = false, input, allowFailure = false, display } = {}) {
  const shown = display ?? [command, ...args].join(' ');
  if (!capture) console.log(`$ ${shown}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [input !== undefined ? 'pipe' : capture ? 'ignore' : 'inherit', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    });
    activeChild = child;
    const stdout = [];
    const stderr = [];
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    if (input !== undefined) child.stdin.end(input);
    child.on('error', (error) => {
      activeChild = null;
      reject(
        error.code === 'ENOENT'
          ? new Failure(`${command} was not found on PATH`)
          : new Failure(`could not start ${shown}: ${error.message}`),
      );
    });
    child.on('close', (code, signal) => {
      activeChild = null;
      const out = Buffer.concat(stdout);
      const result = { code: code ?? 1, signal, stdoutBytes: out, stdout: out.toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (result.code !== 0 && !allowFailure) {
        reject(new Failure(`${shown} ${signal ? `was killed by ${signal}` : `exited with status ${result.code}`}`, capture ? [tail(result.stderr || result.stdout)] : []));
      } else {
        resolve(result);
      }
    });
  });
}

function tail(text, lines = 15) {
  return text.trim().split('\n').slice(-lines).join('\n');
}

/** Quote one argument for consumers that split with shell rules (bindgen uses shlex). */
function shellWord(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

// ── Arguments ─────────────────────────────────────────────────────────────

const VALUE_OPTIONS = new Set(['build-number', 'target', 'ipa', 'apk']);
const FLAG_OPTIONS = new Set(['help', 'release', 'regenerate-xcodeproj', 'skip-frontend']);

function parseArgs(argv) {
  const positional = [];
  const options = { target: [] };
  let passthrough = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      passthrough = argv.slice(i + 1);
      break;
    }
    if (arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (FLAG_OPTIONS.has(name)) {
      if (inline !== undefined) fail(`--${name} does not take a value`);
      options[name] = true;
    } else if (VALUE_OPTIONS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`);
      if (name === 'target') options.target.push(value);
      else options[name] = value;
    } else {
      fail(`unknown option --${name}`, ['run with --help for usage']);
    }
  }
  return { positional, options, passthrough };
}

function rejectOptions(ctx, allowed) {
  const used = Object.entries(ctx.options).filter(([name, value]) => (Array.isArray(value) ? value.length > 0 : value !== undefined));
  for (const [name] of used) {
    if (!allowed.includes(name)) fail(`--${name} is not valid for "${ctx.platform} ${ctx.command}"`);
  }
  if (ctx.passthrough.length > 0 && !allowed.includes('--')) fail(`"${ctx.platform} ${ctx.command}" does not accept arguments after --`);
}

// ── Build number and version ──────────────────────────────────────────────

function parseBuildNumber(raw, source) {
  const value = String(raw).trim();
  if (!/^[1-9][0-9]*$/.test(value)) {
    fail(`${source} must be a positive integer without sign, separators or leading zeros (got ${JSON.stringify(value)})`);
  }
  if (value.length > 10 || Number(value) > MAX_BUILD_NUMBER) {
    fail(`${source} must be at most ${MAX_BUILD_NUMBER} (Android versionCode is a signed 32-bit integer)`);
  }
  return Number(value);
}

function resolveBuildNumber(optionValue, { required }) {
  const envValue = process.env.MOBILE_BUILD_NUMBER?.trim() || undefined;
  if (optionValue !== undefined && envValue !== undefined && optionValue.trim() !== envValue) {
    fail('--build-number and MOBILE_BUILD_NUMBER disagree; set only one');
  }
  if (optionValue !== undefined) return parseBuildNumber(optionValue, '--build-number');
  if (envValue !== undefined) return parseBuildNumber(envValue, 'MOBILE_BUILD_NUMBER');
  if (required) {
    fail('a mobile build number is required', [
      'pass --build-number N or set MOBILE_BUILD_NUMBER',
      'it must be greater than every build already uploaded to TestFlight or installed from an APK',
    ]);
  }
  return undefined;
}

let cachedAppVersion;

/** core/Cargo.toml [package].version, the only app version (scripts/app-version.mjs). */
function appVersion() {
  if (cachedAppVersion === undefined) {
    try {
      cachedAppVersion = readAppVersion(ROOT);
    } catch (error) {
      if (error instanceof AppVersionError) fail(error.message, error.hints);
      throw error;
    }
  }
  return cachedAppVersion;
}

/**
 * `--config` for every `tauri android|ios` build and dev run. tauri.conf.json
 * has no `version`; the runtime and desktop bundler fall back to Cargo.toml,
 * but tauri-cli's mobile commands do not (Android would get versionName 1.0,
 * iOS the build number as CFBundleShortVersionString), so pass it here.
 * CFBundleVersion = the plain build number: `--build-number` would append it
 * to the app version (0.6.1.N), which App Store Connect rejects as a
 * four-component CFBundleVersion.
 */
function tauriVersionConfig(buildNumber) {
  const config = { version: appVersion() };
  if (buildNumber !== undefined) config.bundle = { iOS: { bundleVersion: String(buildNumber) } };
  return ['--config', JSON.stringify(config)];
}

function releaseBaseName(version, buildNumber) {
  return `${PRODUCT}_${version}_${buildNumber}`;
}

// ── Shared environment checks ─────────────────────────────────────────────

function present(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '';
}

function requireEnv(names, context, hints = []) {
  const missing = names.filter((name) => !present(name));
  if (missing.length > 0) {
    fail(`${context}: missing ${missing.join(', ')}`, [...hints, 'see docs/design-docs/mobile-deployment.md for how each value is created']);
  }
}

function childEnv(additions, { drop = [] } = {}) {
  const env = { ...process.env, ...additions };
  for (const name of drop) delete env[name];
  return env;
}

function requirePnpm() {
  if (!which('pnpm')) fail('pnpm was not found on PATH', ['install pnpm 9+ (corepack enable or npm i -g pnpm)']);
}

async function requireRustTargets(triples) {
  if (!which('rustup')) fail('rustup was not found on PATH', ['install Rust with rustup: https://rustup.rs']);
  const { stdout } = await run('rustup', ['target', 'list', '--installed'], { cwd: CORE, capture: true });
  const installed = new Set(stdout.split('\n').map((line) => line.trim()));
  const missing = triples.filter((triple) => !installed.has(triple));
  if (missing.length > 0) {
    fail(`Rust target(s) not installed for the active toolchain: ${missing.join(', ')}`, [`rustup target add ${missing.join(' ')}`, 'or run the matching `init` command']);
  }
}

async function ensureFrontendDist() {
  if (isFile(path.join(ROOT, 'dist', 'index.html'))) {
    console.log('using existing dist/ (tauri::generate_context! embeds it; run `pnpm build` to refresh)');
    return;
  }
  step('Building the frontend (dist/ is required by tauri::generate_context!)');
  await run('pnpm', ['build']);
}

/**
 * One cargo invocation per target. Tauri plugin build scripts copy their
 * native sources into one shared registry directory (`android/.tauri/…`), so
 * several targets building them concurrently collide (EEXIST).
 */
async function clippyEachTarget(targets, env) {
  for (const target of targets) {
    step(`cargo clippy --target ${target.triple}`);
    await run('cargo', ['clippy', '--locked', '--lib', '--target', target.triple, '--', '-D', 'warnings'], { cwd: CORE, env });
  }
}

/** `--skip-frontend`: drop tauri's beforeBuildCommand and embed the existing dist/. */
function frontendConfig(ctx) {
  if (ctx.options['skip-frontend'] !== true) return [];
  if (!isFile(path.join(ROOT, 'dist', 'index.html'))) fail('--skip-frontend needs an existing dist/ (run `pnpm build` first)');
  console.log('reusing dist/ without running `pnpm build` (--skip-frontend)');
  return ['--config', JSON.stringify({ build: { beforeBuildCommand: null } })];
}

function gitStatus(dir) {
  const result = spawnSync('git', ['status', '--porcelain', '--', dir], { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

function reportNativeProjectChanges(dir, before) {
  const after = gitStatus(dir);
  if (before === null || after === null || after === before) return;
  warn(`tauri rewrote tracked files under ${rel(dir)} (bundle id, team, signing or version settings). Review with \`git diff -- ${rel(dir)}\` and do not commit signing identities.`);
}

// ── Android environment ───────────────────────────────────────────────────

function androidSdkRoot() {
  const home = process.env.ANDROID_HOME?.trim();
  const sdkRoot = process.env.ANDROID_SDK_ROOT?.trim();
  if (home && sdkRoot && path.resolve(home) !== path.resolve(sdkRoot)) {
    fail(`ANDROID_HOME (${home}) and ANDROID_SDK_ROOT (${sdkRoot}) point to different SDKs`, ['unset one of them; tauri and Gradle prefer ANDROID_HOME']);
  }
  const chosen = home || sdkRoot;
  if (chosen) {
    if (!isDir(chosen)) fail(`ANDROID_HOME (${chosen}) is not a directory`);
    return path.resolve(chosen);
  }
  const candidates = [
    path.join(os.homedir(), 'Library', 'Android', 'sdk'),
    path.join(os.homedir(), 'Android', 'Sdk'),
    '/opt/homebrew/share/android-commandlinetools',
    '/usr/local/share/android-commandlinetools',
  ].filter(isDir);
  fail(
    'ANDROID_HOME is not set',
    candidates.length > 0
      ? candidates.map((candidate) => `an SDK exists at ${candidate}: export ANDROID_HOME="${candidate}"`)
      : ['install the Android SDK command-line tools, then export ANDROID_HOME=<sdk root>'],
  );
}

function sdkmanagerInstallHint(sdk) {
  return `sdkmanager --sdk_root="${sdk}" --install "ndk;${ANDROID.ndk}" "platforms;${ANDROID.platform}" ${ANDROID.buildTools.map((v) => `"build-tools;${v}"`).join(' ')} "platform-tools"`;
}

/** The NDK tauri-cli will actually use: the last entry of $ANDROID_HOME/ndk in path order. */
function tauriSelectedNdk(sdk) {
  const ndkRoot = path.join(sdk, 'ndk');
  const entries = isDir(ndkRoot) ? fs.readdirSync(ndkRoot).map((name) => path.join(ndkRoot, name)) : [];
  entries.sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
  const selected = entries.at(-1);
  if (!selected) fail(`no NDK installed under ${ndkRoot}`, [sdkmanagerInstallHint(sdk)]);
  if (!isDir(selected)) fail(`${selected} is not an NDK directory, but tauri-cli would select it (newest entry of ${ndkRoot})`, ['remove the stray file']);
  const configured = process.env.NDK_HOME?.trim();
  if (configured && (!isDir(configured) || fs.realpathSync(configured) !== fs.realpathSync(selected))) {
    fail(`NDK_HOME is ${configured}, but tauri-cli 2.10.1 ignores NDK_HOME and builds with ${selected}`, [
      `keep only the wanted NDK under ${ndkRoot} (CI: \`node scripts/mobile.mjs android ci-sdk\`)`,
      'or unset NDK_HOME to accept the selected NDK',
    ]);
  }
  if (path.basename(selected) !== ANDROID.ndk) warn(`using NDK ${path.basename(selected)}; CI is pinned to ${ANDROID.ndk}`);
  return selected;
}

function ndkHostTag() {
  if (process.platform === 'darwin') return 'darwin-x86_64';
  if (process.platform === 'linux') {
    if (process.arch !== 'x64') fail('the Android NDK only ships linux-x86_64 host toolchains');
    return 'linux-x86_64';
  }
  if (process.platform === 'win32') return 'windows-x86_64';
  return fail(`unsupported host platform ${process.platform} for Android builds`);
}

function javaHints() {
  const candidates = [
    '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    '/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    '/usr/lib/jvm/java-17-openjdk-amd64',
  ].filter(isDir);
  return candidates.length > 0 ? candidates.map((dir) => `export JAVA_HOME="${dir}"`) : ['install JDK 17 (Temurin, Homebrew openjdk@17 or Android Studio) and export JAVA_HOME'];
}

async function checkJava() {
  const javaHome = process.env.JAVA_HOME?.trim();
  const java = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : which('java');
  if (javaHome && !isFile(java)) fail(`JAVA_HOME (${javaHome}) does not contain bin/java`, javaHints());
  if (!java) fail('Java was not found (JAVA_HOME unset and no java on PATH)', javaHints());
  // java.home is the JDK root even when `java` is a PATH shim (macOS /usr/bin/java).
  const result = await run(java, ['-XshowSettings:properties', '-version'], { capture: true, allowFailure: true });
  const output = `${result.stderr}${result.stdout}`;
  const match = /version "(\d+)(?:\.(\d+))?/.exec(output);
  const home = /^\s*java\.home = (.+)$/m.exec(output)?.[1]?.trim();
  if (result.code !== 0 || !match || !home) fail(`${java} -version failed; no usable JDK`, javaHints());
  const major = Number(match[1]) === 1 ? Number(match[2]) : Number(match[1]);
  if (major < 17) fail(`${java} is Java ${major}; the Android Gradle Plugin needs JDK 17+`, javaHints());
  return { java, javaHome: javaHome || home, major };
}

function libclangCandidates() {
  if (process.platform === 'darwin') {
    const developer = spawnSync('xcode-select', ['-p'], { encoding: 'utf8' });
    const dirs = [];
    if (developer.status === 0) dirs.push(path.join(developer.stdout.trim(), 'Toolchains', 'XcodeDefault.xctoolchain', 'usr', 'lib'), path.join(developer.stdout.trim(), 'usr', 'lib'));
    dirs.push('/Library/Developer/CommandLineTools/usr/lib');
    return dirs;
  }
  if (process.platform === 'linux') {
    const llvm = isDir('/usr/lib')
      ? fs
          .readdirSync('/usr/lib')
          .map((name) => /^llvm-(\d+)$/.exec(name))
          .filter(Boolean)
          .sort((a, b) => Number(b[1]) - Number(a[1]))
          .map((match) => path.join('/usr/lib', match[0], 'lib'))
      : [];
    return [...llvm, '/usr/lib/x86_64-linux-gnu', '/usr/lib64', '/usr/lib'];
  }
  return [];
}

function hasLibclang(dir) {
  if (!isDir(dir)) return false;
  return fs.readdirSync(dir).some((name) => /^libclang(-\d+(\.\d+)*)?\.(dylib|dll|so(\.\d+)*)$/.test(name) || name === 'libclang.dll');
}

function resolveLibclang() {
  const configured = process.env.LIBCLANG_PATH?.trim();
  if (configured) {
    if (!hasLibclang(configured)) fail(`LIBCLANG_PATH (${configured}) does not contain libclang`);
    return configured;
  }
  const found = libclangCandidates().find(hasLibclang);
  if (!found) {
    fail('libclang was not found (rquickjs generates its bindings with bindgen)', [
      process.platform === 'darwin' ? 'xcode-select --install' : 'sudo apt-get install libclang-dev',
      'or export LIBCLANG_PATH=<directory containing libclang>',
    ]);
  }
  return found;
}

function androidBuildTools(sdk) {
  const root = path.join(sdk, 'build-tools');
  const installed = isDir(root) ? fs.readdirSync(root).filter((name) => /^\d+(\.\d+)*$/.test(name)).sort(compareVersions).reverse() : [];
  // Prefer the pinned versions CI installs, so tool output stays the same.
  const pinned = [...ANDROID.buildTools].sort(compareVersions).reverse();
  const versions = [...pinned.filter((version) => installed.includes(version)), ...installed.filter((version) => !pinned.includes(version))];
  for (const version of versions) {
    const dir = path.join(root, version);
    const apksigner = path.join(dir, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
    const aapt2 = path.join(dir, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
    const zipalign = path.join(dir, process.platform === 'win32' ? 'zipalign.exe' : 'zipalign');
    // `zipalign -P` (16 KiB page alignment check) needs build-tools 35+.
    if (compareVersions(version, '35') >= 0 && isFile(apksigner) && isFile(aapt2) && isFile(zipalign)) return { version, apksigner, aapt2, zipalign };
  }
  return fail(`no Android build-tools 35+ with apksigner, aapt2 and zipalign under ${root}`, [sdkmanagerInstallHint(sdk)]);
}

function selectAndroidTargets(requested) {
  const names = requested.length > 0 ? requested : Object.keys(ANDROID.targets);
  return names.map((name) => ANDROID.targets[name] ?? fail(`unknown Android target "${name}"`, [`expected one of: ${Object.keys(ANDROID.targets).join(', ')}`]));
}

/**
 * Validate the Android toolchain and return the environment for children.
 * `cargo` adds the per-target compiler/linker variables a bare `cargo clippy`
 * needs; tauri builds set those itself and only need the bindgen sysroot.
 */
async function androidEnvironment({ targets, cargo = false, drop = [] }) {
  requirePnpm();
  const sdk = androidSdkRoot();
  if (!isDir(path.join(sdk, 'platforms', ANDROID.platform))) fail(`Android platform ${ANDROID.platform} is not installed in ${sdk}`, [sdkmanagerInstallHint(sdk)]);
  const buildTools = androidBuildTools(sdk);
  const ndk = tauriSelectedNdk(sdk);
  const toolchain = path.join(ndk, 'toolchains', 'llvm', 'prebuilt', ndkHostTag());
  if (!isDir(toolchain)) fail(`NDK host toolchain missing: ${toolchain}`);
  const java = await checkJava();
  // Either variable replaces every `target.<triple>.rustflags`, including the
  // 16 KiB max-page-size link flag in .cargo/config.toml.
  const overriding = ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS'].filter(present);
  if (overriding.length > 0) {
    fail(`${overriding.join(' and ')} would replace the Android rustflags from .cargo/config.toml (16 KiB page alignment)`, ['unset them; add Android flags to .cargo/config.toml instead']);
  }
  const readelf = path.join(toolchain, 'bin', process.platform === 'win32' ? 'llvm-readelf.exe' : 'llvm-readelf');
  if (!isFile(readelf)) fail(`NDK llvm-readelf missing: ${readelf}`);
  const libclang = resolveLibclang();
  await requireRustTargets(targets.map((target) => target.triple));

  const exe = process.platform === 'win32' ? '.cmd' : '';
  const env = {
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    NDK_HOME: ndk,
    ANDROID_NDK_HOME: ndk,
    ANDROID_NDK_ROOT: ndk,
    JAVA_HOME: java.javaHome,
    LIBCLANG_PATH: libclang,
    PATH: [path.join(java.javaHome, 'bin'), process.env.PATH].join(path.delimiter),
  };
  for (const target of targets) {
    const key = target.triple.replaceAll('-', '_');
    env[`BINDGEN_EXTRA_CLANG_ARGS_${key}`] = shellWord(`--sysroot=${path.join(toolchain, 'sysroot')}`);
    if (cargo) {
      const clang = path.join(toolchain, 'bin', `${target.triple}${ANDROID.minSdk}-clang${exe}`);
      if (!isFile(clang)) fail(`NDK compiler missing: ${clang}`);
      env[`CC_${key}`] = clang;
      env[`CXX_${key}`] = path.join(toolchain, 'bin', `${target.triple}${ANDROID.minSdk}-clang++${exe}`);
      env[`AR_${key}`] = path.join(toolchain, 'bin', 'llvm-ar');
      env[`RANLIB_${key}`] = path.join(toolchain, 'bin', 'llvm-ranlib');
      env[`CARGO_TARGET_${key.toUpperCase()}_LINKER`] = clang;
    }
  }
  return { sdk, ndk, buildTools, java, libclang, readelf, env: childEnv(env, { drop }) };
}

// ── Android artifact verification ─────────────────────────────────────────

async function inspectApk(tools, apk, env, { versionCode, versionName, abis }) {
  const { stdout } = await run(tools.aapt2, ['dump', 'badging', apk], { capture: true, env });
  const pkg = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/m.exec(stdout);
  if (!pkg) fail(`aapt2 could not read the package line of ${rel(apk)}`);
  const [, name, code, nameVersion] = pkg;
  if (name !== APP_ID) fail(`${rel(apk)} has package ${name}, expected ${APP_ID}`);
  if (versionCode !== undefined && Number(code) !== versionCode) fail(`${rel(apk)} has versionCode ${code}, expected ${versionCode}`);
  if (versionName !== undefined && nameVersion !== versionName) fail(`${rel(apk)} has versionName ${nameVersion}, expected ${versionName}`);
  const minSdk = /^(?:minSdkVersion|sdkVersion):'(\d+)'/m.exec(stdout)?.[1];
  if (Number(minSdk) !== ANDROID.minSdk) fail(`${rel(apk)} has minSdkVersion ${minSdk}, expected ${ANDROID.minSdk}`);
  const nativeCode = [...(/^native-code: (.*)$/m.exec(stdout)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const missingAbis = abis.filter((abi) => !nativeCode.includes(abi));
  if (missingAbis.length > 0) fail(`${rel(apk)} lacks native code for ${missingAbis.join(', ')} (has: ${nativeCode.join(', ') || 'none'})`);
  return { versionCode: Number(code), versionName: nameVersion, nativeCode };
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(file) : [file];
  });
}

/**
 * Android 15+ devices may use 16 KiB memory pages: every PT_LOAD segment of
 * every bundled .so must be aligned to at least 16 KiB, and uncompressed
 * libraries must start on 16 KiB boundaries inside the APK.
 */
async function verifyPageAlignment(found, apk) {
  const zip = await run(found.buildTools.zipalign, ['-c', '-P', '16', '4', apk], { capture: true, allowFailure: true, env: found.env });
  if (zip.code !== 0) fail(`${rel(apk)} fails \`zipalign -c -P 16 4\` (native libraries not 16 KiB page-aligned in the archive)`, [tail(`${zip.stdout}\n${zip.stderr}`)]);
  const dir = makePrivateTempDir('novelist-apk-libs-');
  const unzip = await run('unzip', ['-q', '-o', apk, 'lib/*', '-d', dir], { capture: true, allowFailure: true });
  if (unzip.code !== 0 || !isDir(path.join(dir, 'lib'))) fail(`could not extract native libraries from ${rel(apk)}`, [tail(`${unzip.stdout}\n${unzip.stderr}`)]);
  const libraries = listFiles(path.join(dir, 'lib')).filter((file) => file.endsWith('.so'));
  if (libraries.length === 0) fail(`${rel(apk)} contains no native libraries`);
  const report = [];
  for (const library of libraries) {
    const { stdout } = await run(found.readelf, ['-lW', library], { capture: true, env: found.env });
    const aligns = stdout
      .split('\n')
      .filter((line) => /^\s*LOAD\s/.test(line))
      .map((line) => line.trim().split(/\s+/).at(-1));
    const name = path.relative(path.join(dir, 'lib'), library);
    if (aligns.length === 0) fail(`llvm-readelf found no PT_LOAD segments in ${name}`);
    const minimum = Math.min(...aligns.map((align) => Number.parseInt(align, 16)));
    if (!(minimum >= 16384)) {
      fail(`${name} has PT_LOAD alignment ${aligns.join(', ')}; Android 15+ devices with 16 KiB pages cannot load it`, [
        'link with -Wl,-z,max-page-size=16384 (target.<triple>.rustflags in .cargo/config.toml)',
        'RUSTFLAGS / CARGO_ENCODED_RUSTFLAGS would replace those flags',
      ]);
    }
    report.push(`${name} (PT_LOAD align 0x${minimum.toString(16)})`);
  }
  return report;
}

async function verifyApkSignature(tools, apk, env, expectedSha256) {
  const result = await run(tools.apksigner, ['verify', '--verbose', '--print-certs', apk], { capture: true, allowFailure: true, env });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 || !/^Verifies$/m.test(output)) fail(`apksigner rejected ${rel(apk)}`, [tail(output)]);
  if (!/Verified using v[23] scheme \(APK Signature Scheme v[23]\): true/.test(output)) fail(`${rel(apk)} is not signed with APK Signature Scheme v2 or v3`);
  // apksigner <= 36 prints "Signer #1 certificate SHA-256 digest: …"; 37+
  // prints one line per signature scheme ("V2 Signer: certificate SHA-256
  // digest: …"). Either way: exactly one signer and one distinct certificate.
  const count = Number(/^Number of signers: (\d+)$/m.exec(output)?.[1]);
  const digests = new Set([...output.matchAll(/^(?:Signer #\d+|V\d+(?:\.\d+)? Signer(?: #\d+)?:) certificate SHA-256 digest: ([0-9a-f]{64})$/gm)].map((match) => match[1]));
  if (count !== 1 || digests.size !== 1) {
    fail(`${rel(apk)}: apksigner reports ${Number.isNaN(count) ? 'an unknown number of' : count} signer(s) and ${digests.size} distinct certificate(s); expected exactly one of each`, [tail(output)]);
  }
  const [signer] = digests;
  if (expectedSha256 && signer !== expectedSha256) {
    fail(`${rel(apk)} is signed by certificate ${signer}, not the release certificate ${expectedSha256}`, ['an APK signed with another key cannot upgrade installed copies']);
  }
  return signer;
}

function normalizeSha256(value, source) {
  const hex = value.replace(/[\s:]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) fail(`${source} must be a SHA-256 fingerprint (64 hex digits, colons allowed)`);
  return hex;
}

function removeApks(dir) {
  if (!isDir(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.apk')) fs.rmSync(path.join(dir, name), { force: true });
  }
}

function stageRelease(source, fileName) {
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const target = path.join(RELEASE_DIR, fileName);
  fs.copyFileSync(source, target);
  const digest = sha256File(target);
  fs.writeFileSync(`${target}.sha256`, `${digest}  ${fileName}\n`);
  return { target, digest };
}

// ── Android commands ──────────────────────────────────────────────────────

async function androidDoctor(ctx) {
  rejectOptions(ctx, ['target']);
  const targets = selectAndroidTargets(ctx.options.target);
  const found = await androidEnvironment({ targets });
  step('Android toolchain');
  console.log(`SDK          ${found.sdk}`);
  console.log(`NDK          ${found.ndk} (tauri-cli selection)`);
  console.log(`build-tools  ${found.buildTools.version}`);
  console.log(`JDK          ${found.java.major} at ${found.java.javaHome}`);
  console.log(`libclang     ${found.libclang}`);
  console.log(`Rust targets ${targets.map((target) => target.triple).join(', ')}`);
  reportCredentials('Android publish', [...ENV.androidSigning, 'ANDROID_SIGNING_CERT_SHA256', 'MOBILE_BUILD_NUMBER']);
}

function reportCredentials(label, names) {
  step(`${label} inputs (presence only)`);
  for (const name of names) console.log(`${present(name) ? 'set    ' : 'missing'} ${name}`);
}

async function androidInit(ctx) {
  rejectOptions(ctx, ['target']);
  const targets = selectAndroidTargets(ctx.options.target);
  if (!isFile(path.join(ANDROID.project, 'app', 'build.gradle.kts'))) {
    fail(`the committed Android project is missing (${rel(ANDROID.project)})`, ['restore it from git; regenerating with `tauri android init` overwrites committed customizations']);
  }
  if (!which('rustup')) fail('rustup was not found on PATH', ['install Rust with rustup: https://rustup.rs']);
  await run('rustup', ['target', 'add', ...targets.map((target) => target.triple)], { cwd: CORE });
  await androidDoctor({ ...ctx, options: { target: ctx.options.target } });
}

async function androidDev(ctx) {
  rejectOptions(ctx, ['--']);
  const found = await androidEnvironment({ targets: selectAndroidTargets([]), drop: ENV.androidSigning });
  await run('pnpm', ['tauri', 'android', 'dev', ...tauriVersionConfig(), ...ctx.passthrough], { env: found.env });
}

async function androidCheck(ctx) {
  rejectOptions(ctx, ['target']);
  const targets = selectAndroidTargets(ctx.options.target);
  const found = await androidEnvironment({ targets, cargo: true });
  await ensureFrontendDist();
  await clippyEachTarget(targets, found.env);
}

async function androidBuild(ctx) {
  rejectOptions(ctx, ['target', 'release', 'build-number', 'skip-frontend']);
  const release = ctx.options.release === true;
  const targets = selectAndroidTargets(ctx.options.target);
  const buildNumber = resolveBuildNumber(ctx.options['build-number'], { required: false });
  const found = await androidEnvironment({ targets, drop: [...ENV.androidSigning, 'MOBILE_BUILD_NUMBER'] });
  if (buildNumber !== undefined) found.env.MOBILE_BUILD_NUMBER = String(buildNumber);
  const profile = release ? 'release' : 'debug';
  const outDir = path.join(ANDROID.project, 'app', 'build', 'outputs', 'apk', 'universal', profile);
  removeApks(outDir);
  step(`Building the universal ${profile} APK without release credentials`);
  await run('pnpm', ['tauri', 'android', 'build', '--apk', '--ci', ...(release ? [] : ['--debug']), '--target', ...targets.map((target) => target.tauri), ...tauriVersionConfig(), ...frontendConfig(ctx)], { env: found.env });
  const apk = path.join(outDir, release ? 'app-universal-release-unsigned.apk' : 'app-universal-debug.apk');
  if (!isFile(apk)) fail(`expected APK was not produced: ${rel(apk)}`);
  step('Verifying the APK');
  const info = await inspectApk(found.buildTools, apk, found.env, { versionCode: buildNumber, versionName: appVersion(), abis: targets.map((target) => target.abi) });
  const signer = release ? null : await verifyApkSignature(found.buildTools, apk, found.env, null);
  const pages = await verifyPageAlignment(found, apk);
  console.log(`APK          ${rel(apk)}`);
  console.log(`package      ${APP_ID} versionCode=${info.versionCode} versionName=${info.versionName}`);
  console.log(`native code  ${info.nativeCode.join(', ')}`);
  console.log(`16 KiB pages zipalign -P 16 ok; ${pages.join('; ')}`);
  console.log(release ? 'signature    none (unsigned release; install requires `publish`)' : `signature    debug certificate ${signer}`);
}

async function androidPublish(ctx) {
  rejectOptions(ctx, ['build-number']);
  const buildNumber = resolveBuildNumber(ctx.options['build-number'], { required: true });
  requireEnv([...ENV.androidSigning, 'ANDROID_SIGNING_CERT_SHA256'], 'Android release signing');
  const expectedSha256 = normalizeSha256(process.env.ANDROID_SIGNING_CERT_SHA256, 'ANDROID_SIGNING_CERT_SHA256');
  const keystore = path.resolve(process.env.ANDROID_KEYSTORE_PATH);
  if (!isFile(keystore)) fail('ANDROID_KEYSTORE_PATH does not point to a readable keystore file');
  const version = appVersion();
  const targets = selectAndroidTargets([]);
  const found = await androidEnvironment({ targets });
  found.env.ANDROID_KEYSTORE_PATH = keystore;
  found.env.MOBILE_BUILD_NUMBER = String(buildNumber);

  step('Checking the release keystore certificate');
  const keytool = path.join(found.java.javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
  const listing = await run(keytool, ['-list', '-v', '-keystore', keystore, '-alias', process.env.ANDROID_KEY_ALIAS, '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD'], {
    capture: true,
    allowFailure: true,
    env: found.env,
    display: 'keytool -list -v (release keystore)',
  });
  if (listing.code !== 0) fail('keytool could not open ANDROID_KEY_ALIAS in the keystore with ANDROID_KEYSTORE_PASSWORD (output suppressed)');
  const keystoreSha256 = /SHA256:\s*([0-9A-Fa-f:]{95})/.exec(listing.stdout)?.[1];
  if (!keystoreSha256) fail('keytool did not report a SHA-256 certificate fingerprint for ANDROID_KEY_ALIAS');
  if (normalizeSha256(keystoreSha256, 'keystore certificate') !== expectedSha256) {
    fail('the keystore certificate does not match ANDROID_SIGNING_CERT_SHA256', ['refusing to sign: a different key would break in-place upgrades of every installed copy']);
  }
  console.log(`release certificate SHA-256 ${expectedSha256}`);

  const outDir = path.join(ANDROID.project, 'app', 'build', 'outputs', 'apk', 'universal', 'release');
  removeApks(outDir);
  step(`Building the signed universal release APK (versionCode ${buildNumber})`);
  await run('pnpm', ['tauri', 'android', 'build', '--apk', '--ci', '--target', ...targets.map((target) => target.tauri), ...tauriVersionConfig()], { env: found.env });
  const apk = path.join(outDir, 'app-universal-release.apk');
  if (!isFile(apk)) {
    fail(
      isFile(path.join(outDir, 'app-universal-release-unsigned.apk'))
        ? 'Gradle produced an unsigned APK: the release signing config was not applied'
        : `expected APK was not produced: ${rel(apk)}`,
    );
  }

  step('Verifying signature and manifest');
  await verifyApkSignature(found.buildTools, apk, found.env, expectedSha256);
  const info = await inspectApk(found.buildTools, apk, found.env, { versionCode: buildNumber, versionName: version, abis: targets.map((target) => target.abi) });
  const pages = await verifyPageAlignment(found, apk);
  const staged = stageRelease(apk, `${releaseBaseName(version, buildNumber)}_android-universal.apk`);
  console.log(`APK     ${rel(staged.target)}`);
  console.log(`SHA-256 ${staged.digest}`);
  console.log(`package ${APP_ID} versionCode=${info.versionCode} versionName=${info.versionName} abis=${info.nativeCode.join(',')}`);
  console.log(`16 KiB  zipalign -P 16 ok; ${pages.join('; ')}`);
}

async function androidVerify(ctx) {
  rejectOptions(ctx, ['apk', 'target', 'build-number']);
  if (!ctx.options.apk) fail('--apk PATH is required');
  const apk = path.resolve(ctx.options.apk);
  if (!isFile(apk)) fail(`APK not found: ${ctx.options.apk}`);
  const targets = selectAndroidTargets(ctx.options.target);
  const buildNumber = resolveBuildNumber(ctx.options['build-number'], { required: false });
  const expectedSha256 = present('ANDROID_SIGNING_CERT_SHA256') ? normalizeSha256(process.env.ANDROID_SIGNING_CERT_SHA256, 'ANDROID_SIGNING_CERT_SHA256') : null;
  const found = await androidEnvironment({ targets });
  step(`Verifying ${rel(apk)}`);
  const info = await inspectApk(found.buildTools, apk, found.env, { versionCode: buildNumber, versionName: appVersion(), abis: targets.map((target) => target.abi) });
  const pages = await verifyPageAlignment(found, apk);
  let signer = 'none (unsigned or invalid signature)';
  if (expectedSha256) {
    signer = `release certificate ${await verifyApkSignature(found.buildTools, apk, found.env, expectedSha256)}`;
  } else {
    const probe = await run(found.buildTools.apksigner, ['verify', apk], { capture: true, allowFailure: true, env: found.env });
    if (probe.code === 0) signer = `certificate ${await verifyApkSignature(found.buildTools, apk, found.env, null)}`;
  }
  console.log(`package      ${APP_ID} versionCode=${info.versionCode} versionName=${info.versionName}`);
  console.log(`native code  ${info.nativeCode.join(', ')}`);
  console.log(`16 KiB pages zipalign -P 16 ok; ${pages.join('; ')}`);
  console.log(`signature    ${signer}`);
}

/** CI only: install the pinned packages and leave exactly one NDK for tauri-cli. */
async function androidCiSdk(ctx) {
  rejectOptions(ctx, []);
  if (process.env.GITHUB_ACTIONS !== 'true') {
    fail('`android ci-sdk` deletes NDKs from $ANDROID_HOME and only runs on GitHub Actions runners', ['locally, keep the wanted NDK under $ANDROID_HOME/ndk yourself']);
  }
  const sdk = androidSdkRoot();
  const cmdlineTools = path.join(sdk, 'cmdline-tools');
  const sdkmanager = [path.join(cmdlineTools, 'latest', 'bin', 'sdkmanager'), ...(isDir(cmdlineTools) ? fs.readdirSync(cmdlineTools).map((name) => path.join(cmdlineTools, name, 'bin', 'sdkmanager')) : [])].find(isFile);
  if (!sdkmanager) fail(`sdkmanager was not found under ${cmdlineTools}`);
  const packages = [`ndk;${ANDROID.ndk}`, `platforms;${ANDROID.platform}`, ...ANDROID.buildTools.map((version) => `build-tools;${version}`), 'platform-tools'];
  step('Installing pinned Android SDK packages');
  await run(sdkmanager, [`--sdk_root=${sdk}`, '--install', ...packages], { input: 'y\n'.repeat(20) });
  const ndkRoot = path.join(sdk, 'ndk');
  for (const name of fs.readdirSync(ndkRoot)) {
    if (name !== ANDROID.ndk) {
      console.log(`removing ${path.join(ndkRoot, name)} so tauri-cli selects ${ANDROID.ndk}`);
      fs.rmSync(path.join(ndkRoot, name), { recursive: true, force: true });
    }
  }
  const ndk = path.join(ndkRoot, ANDROID.ndk);
  if (!isDir(path.join(ndk, 'toolchains'))) fail(`pinned NDK ${ANDROID.ndk} is not installed at ${ndk}`);
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, ['ANDROID_HOME', 'ANDROID_SDK_ROOT'].map((name) => `${name}=${sdk}`).concat(['NDK_HOME', 'ANDROID_NDK_HOME', 'ANDROID_NDK_ROOT', 'ANDROID_NDK', 'ANDROID_NDK_LATEST_HOME'].map((name) => `${name}=${ndk}`), ['']).join('\n'));
  }
  console.log(`NDK_HOME=${ndk}`);
}

// ── iOS environment ───────────────────────────────────────────────────────

async function iosEnvironment({ minXcode, needSimulatorRuntime = false, drop = [] } = {}) {
  if (process.platform !== 'darwin') fail('iOS builds require macOS with Xcode');
  requirePnpm();
  const developer = await run('xcode-select', ['-p'], { capture: true, allowFailure: true });
  const xcode = await run('xcodebuild', ['-version'], { capture: true, allowFailure: true });
  const match = /^Xcode (\d+)(?:\.(\d+))?(?:\.(\d+))?/m.exec(xcode.stdout);
  if (xcode.code !== 0 || !match) {
    fail('full Xcode is not installed or not selected (Command Line Tools alone cannot build iOS apps)', [
      `active developer directory: ${developer.stdout.trim() || 'none'}`,
      'install Xcode 26 or newer, then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
      'sudo xcodebuild -runFirstLaunch && xcodebuild -downloadPlatform iOS',
    ]);
  }
  const xcodeVersion = match.slice(1).filter(Boolean).join('.');
  if (minXcode && Number(match[1]) < minXcode) {
    fail(`Xcode ${xcodeVersion} is selected; App Store Connect requires uploads built with Xcode ${minXcode}+`, ['select a newer Xcode with xcode-select -s']);
  }
  const sdks = {};
  for (const sdk of [IOS.device.sdk, IOS.simulator.sdk]) {
    const result = await run('xcrun', ['--sdk', sdk, '--show-sdk-path'], { capture: true, allowFailure: true });
    if (result.code !== 0 || !isDir(result.stdout.trim())) fail(`the ${sdk} SDK is not available in Xcode ${xcodeVersion}`, ['xcodebuild -downloadPlatform iOS']);
    sdks[sdk] = result.stdout.trim();
  }
  if (needSimulatorRuntime) {
    const runtimes = await run('xcrun', ['simctl', 'list', 'runtimes', '--json'], { capture: true });
    const available = (JSON.parse(runtimes.stdout).runtimes ?? []).filter((runtime) => runtime.isAvailable && /iOS/.test(runtime.platform ?? runtime.name ?? ''));
    if (available.length === 0) fail('no iOS simulator runtime is installed', ['xcodebuild -downloadPlatform iOS']);
  }
  await requireRustTargets([IOS.device.triple, IOS.simulator.triple]);
  const env = {
    IPHONEOS_DEPLOYMENT_TARGET: IOS.minOs,
    // bindgen appends these after rquickjs's own `--target=<rust triple>`;
    // clang uses the last --target, so the clang spelling wins.
    [`BINDGEN_EXTRA_CLANG_ARGS_${IOS.device.triple.replaceAll('-', '_')}`]: `${shellWord(`--sysroot=${sdks[IOS.device.sdk]}`)} --target=${IOS.device.clang}`,
    [`BINDGEN_EXTRA_CLANG_ARGS_${IOS.simulator.triple.replaceAll('-', '_')}`]: `${shellWord(`--sysroot=${sdks[IOS.simulator.sdk]}`)} --target=${IOS.simulator.clang}`,
  };
  return { developerDir: developer.stdout.trim(), xcodeVersion, xcodeMajor: Number(match[1]), sdks, env: childEnv(env, { drop }) };
}

async function plistValue(file, key, format = 'raw') {
  const result = await run('plutil', ['-extract', key, format, '-o', '-', file], { capture: true, allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

function findSingle(dir, predicate, description) {
  const matches = isDir(dir) ? fs.readdirSync(dir).filter(predicate) : [];
  if (matches.length !== 1) fail(`expected exactly one ${description} in ${rel(dir)}, found ${matches.length}`);
  return path.join(dir, matches[0]);
}

async function verifyIosInfoPlist(plist, { version, buildNumber, label }) {
  const expect = async (key, expected, format) => {
    const actual = await plistValue(plist, key, format);
    const normalized = format === 'json' ? JSON.stringify(JSON.parse(actual ?? 'null')) : actual;
    if (normalized !== expected) fail(`${label}: ${key} is ${normalized ?? 'missing'}, expected ${expected}`);
  };
  await expect('CFBundleIdentifier', APP_ID);
  await expect('CFBundleShortVersionString', version.split('-')[0]);
  await expect('MinimumOSVersion', IOS.minOs);
  await expect('UIDeviceFamily', JSON.stringify([1, 2]), 'json');
  if (buildNumber !== undefined) await expect('CFBundleVersion', String(buildNumber));
}

// ── iOS signing material ──────────────────────────────────────────────────

const HOME = os.homedir();
const KEYCHAINS_DIR = path.join(HOME, 'Library', 'Keychains');
const PROFILES_DIR = path.join(HOME, 'Library', 'MobileDevice', 'Provisioning Profiles');

function listDir(dir) {
  return new Set(isDir(dir) ? fs.readdirSync(dir) : []);
}

function keychainSearchList() {
  const result = spawnSync('security', ['list-keychains', '-d', 'user'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split('\n').map((line) => line.trim().replace(/^"|"$/g, '')).filter(Boolean) : null;
}

/**
 * tauri-cli imports IOS_CERTIFICATE into a temporary keychain (deleted on
 * normal exit) and writes IOS_MOBILE_PROVISION into the user's profile folder
 * (never deleted). Remove both, and restore the keychain search list, however
 * this process ends.
 */
function guardSigningState() {
  const keychainsBefore = listDir(KEYCHAINS_DIR);
  const profilesBefore = listDir(PROFILES_DIR);
  const searchList = keychainSearchList();
  onCleanup(() => {
    for (const name of listDir(KEYCHAINS_DIR)) {
      if (!keychainsBefore.has(name) && name.endsWith('.keychain-db')) {
        spawnSync('security', ['delete-keychain', path.join(KEYCHAINS_DIR, name)], { stdio: 'ignore' });
        fs.rmSync(path.join(KEYCHAINS_DIR, name), { force: true });
      }
    }
    for (const name of listDir(PROFILES_DIR)) {
      if (!profilesBefore.has(name)) fs.rmSync(path.join(PROFILES_DIR, name), { force: true });
    }
    if (searchList) spawnSync('security', ['list-keychains', '-d', 'user', '-s', ...searchList.filter((file) => fs.existsSync(file))], { stdio: 'ignore' });
  });
}

function decodeBase64Env(name, file) {
  const bytes = Buffer.from(process.env[name].replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) fail(`${name} is not valid base64`);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
}

/** Validate certificate and profile before spending a build on them. */
async function preflightIosSigning(team) {
  const dir = makePrivateTempDir('novelist-ios-signing-');
  const p12 = path.join(dir, 'distribution.p12');
  const profile = path.join(dir, 'profile.mobileprovision');
  const profilePlist = path.join(dir, 'profile.plist');
  decodeBase64Env('IOS_CERTIFICATE', p12);
  decodeBase64Env('IOS_MOBILE_PROVISION', profile);

  // /usr/bin/openssl is LibreSSL, which reads the legacy PKCS#12 encryption
  // Keychain Access still exports; -passin env: keeps the password off argv.
  const certificate = await run('/usr/bin/openssl', ['pkcs12', '-in', p12, '-clcerts', '-nokeys', '-passin', 'env:IOS_CERTIFICATE_PASSWORD'], {
    capture: true,
    allowFailure: true,
    display: 'openssl pkcs12 (distribution certificate)',
  });
  if (certificate.code !== 0 || !certificate.stdout.includes('BEGIN CERTIFICATE')) fail('IOS_CERTIFICATE could not be opened with IOS_CERTIFICATE_PASSWORD');
  const pem = certificate.stdout.slice(certificate.stdout.indexOf('-----BEGIN CERTIFICATE-----'));
  const details = await run('/usr/bin/openssl', ['x509', '-noout', '-subject', '-enddate', '-nameopt', 'RFC2253'], { capture: true, input: pem });
  const subject = /^subject=\s*(.*)$/m.exec(details.stdout)?.[1] ?? '';
  const commonName = /(?:^|,)CN=([^,]+)/.exec(subject)?.[1] ?? '';
  const unit = /(?:^|,)OU=([^,]+)/.exec(subject)?.[1];
  const notAfter = new Date(/^notAfter=(.*)$/m.exec(details.stdout)?.[1] ?? '');
  if (!/^(Apple|iPhone) Distribution:/.test(commonName)) fail(`IOS_CERTIFICATE is "${commonName}", not an Apple Distribution certificate`);
  if (unit !== team) fail(`IOS_CERTIFICATE belongs to team ${unit ?? 'unknown'}, not APPLE_DEVELOPMENT_TEAM ${team}`);
  if (Number.isNaN(notAfter.getTime())) fail('could not read the IOS_CERTIFICATE expiry date');
  if (notAfter <= new Date()) fail(`IOS_CERTIFICATE expired on ${notAfter.toISOString()}`, ['create a new Apple Distribution certificate and a new profile']);
  const der = await run('/usr/bin/openssl', ['x509', '-outform', 'DER'], { capture: true, input: pem });
  const certificateDigest = createHash('sha256').update(der.stdoutBytes).digest('hex');

  const decoded = await run('security', ['cms', '-D', '-i', profile, '-o', profilePlist], { capture: true, allowFailure: true });
  if (decoded.code !== 0) fail('IOS_MOBILE_PROVISION is not a signed provisioning profile');
  const profileName = await plistValue(profilePlist, 'Name');
  const profileTeam = await plistValue(profilePlist, 'TeamIdentifier.0');
  const applicationId = await plistValue(profilePlist, 'Entitlements.application-identifier');
  const expires = new Date((await plistValue(profilePlist, 'ExpirationDate')) ?? '');
  if (profileTeam !== team) fail(`provisioning profile "${profileName}" belongs to team ${profileTeam}, not ${team}`);
  if (applicationId !== `${team}.${APP_ID}`) fail(`provisioning profile "${profileName}" is for ${applicationId}, not ${team}.${APP_ID}`);
  if ((await plistValue(profilePlist, 'ProvisionedDevices', 'json')) !== undefined || (await plistValue(profilePlist, 'ProvisionsAllDevices')) !== undefined) {
    fail(`provisioning profile "${profileName}" is a development, ad hoc or enterprise profile; TestFlight needs an App Store Connect distribution profile`);
  }
  if ((await plistValue(profilePlist, 'Entitlements.get-task-allow')) === 'true') fail(`provisioning profile "${profileName}" allows debugging (development profile)`);
  if (Number.isNaN(expires.getTime())) fail(`could not read the expiry date of provisioning profile "${profileName}"`);
  if (expires <= new Date()) fail(`provisioning profile "${profileName}" expired on ${expires.toISOString()}`);
  if (expires - Date.now() < 30 * 24 * 3600 * 1000) warn(`provisioning profile "${profileName}" expires on ${expires.toISOString()}`);

  // The profile must list the very certificate we sign with.
  let listed = false;
  for (let index = 0; !listed; index += 1) {
    const encoded = await plistValue(profilePlist, `DeveloperCertificates.${index}`);
    if (encoded === undefined) break;
    listed = createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex') === certificateDigest;
  }
  if (!listed) fail(`provisioning profile "${profileName}" does not include the IOS_CERTIFICATE distribution certificate`, ['regenerate the profile after creating or renewing the certificate']);
  console.log(`certificate  ${commonName} (expires ${notAfter.toISOString().slice(0, 10)})`);
  console.log(`profile      ${profileName} (expires ${expires.toISOString().slice(0, 10)})`);
}

// ── iOS commands ──────────────────────────────────────────────────────────

async function iosDoctor(ctx) {
  rejectOptions(ctx, []);
  const found = await iosEnvironment({ needSimulatorRuntime: true });
  step('iOS toolchain');
  console.log(`Xcode        ${found.xcodeVersion} (${found.developerDir})`);
  console.log(`iphoneos     ${found.sdks[IOS.device.sdk]}`);
  console.log(`simulator    ${found.sdks[IOS.simulator.sdk]}`);
  console.log(`Rust targets ${IOS.device.triple}, ${IOS.simulator.triple}`);
  if (found.xcodeMajor < IOS.minUploadXcode) warn(`Xcode ${found.xcodeVersion} can build, but TestFlight uploads need Xcode ${IOS.minUploadXcode}+`);
  reportCredentials('iOS publish', [...ENV.iosSigning, 'APPLE_DEVELOPMENT_TEAM', 'MOBILE_BUILD_NUMBER']);
  reportCredentials('TestFlight upload', ENV.asc);
}

async function iosInit(ctx) {
  rejectOptions(ctx, ['regenerate-xcodeproj']);
  if (process.platform !== 'darwin') fail('iOS development requires macOS');
  if (!isFile(path.join(IOS.project, 'project.yml'))) fail(`the committed Xcode project spec is missing (${rel(IOS.project)}/project.yml)`, ['restore it from git']);
  if (!which('rustup')) fail('rustup was not found on PATH', ['install Rust with rustup: https://rustup.rs']);
  await run('rustup', ['target', 'add', IOS.device.triple, IOS.simulator.triple], { cwd: CORE });
  if (ctx.options['regenerate-xcodeproj']) {
    if (!which('xcodegen')) fail('xcodegen was not found on PATH', ['brew install xcodegen']);
    await run('xcodegen', ['generate', '--spec', 'project.yml'], { cwd: IOS.project });
  } else if (!isFile(path.join(IOS.project, 'novelist.xcodeproj', 'project.pbxproj'))) {
    fail('core/gen/apple/novelist.xcodeproj is missing', ['rerun with --regenerate-xcodeproj (needs xcodegen)']);
  }
  await iosDoctor({ ...ctx, options: { target: [] } });
}

async function iosDev(ctx) {
  rejectOptions(ctx, ['--']);
  const found = await iosEnvironment({ drop: [...ENV.iosSigning, ...ENV.tauriAppleApiKey] });
  await run('pnpm', ['tauri', 'ios', 'dev', ...tauriVersionConfig(), ...ctx.passthrough], { env: found.env });
}

async function iosCheck(ctx) {
  rejectOptions(ctx, ['target']);
  const all = { [IOS.device.tauri]: IOS.device, [IOS.simulator.tauri]: IOS.simulator };
  const targets = (ctx.options.target.length > 0 ? ctx.options.target : Object.keys(all)).map((name) => all[name] ?? fail(`unknown iOS target "${name}"`, [`expected one of: ${Object.keys(all).join(', ')}`]));
  const found = await iosEnvironment();
  await ensureFrontendDist();
  await clippyEachTarget(targets, found.env);
}

async function iosBuild(ctx) {
  rejectOptions(ctx, ['release', 'build-number', 'skip-frontend']);
  const release = ctx.options.release === true;
  const buildNumber = resolveBuildNumber(ctx.options['build-number'], { required: false });
  const found = await iosEnvironment({ needSimulatorRuntime: true, drop: [...ENV.iosSigning, ...ENV.tauriAppleApiKey] });
  const outDir = path.join(IOS.project, 'build', IOS.simulator.out);
  fs.rmSync(outDir, { recursive: true, force: true });
  const before = gitStatus(IOS.project);
  step(`Building the ${release ? 'release' : 'debug'} simulator app without signing credentials`);
  await run('pnpm', ['tauri', 'ios', 'build', '--ci', '--target', IOS.simulator.tauri, ...(release ? [] : ['--debug']), ...tauriVersionConfig(buildNumber), ...frontendConfig(ctx)], { env: found.env });
  reportNativeProjectChanges(IOS.project, before);
  const app = findSingle(outDir, (name) => name.endsWith('.app'), 'simulator .app');
  await verifyIosInfoPlist(path.join(app, 'Info.plist'), { version: appVersion(), buildNumber, label: rel(app) });
  console.log(`app          ${rel(app)} (iPhone + iPad, iOS ${IOS.minOs}+, unsigned simulator build)`);
}

async function iosPublish(ctx) {
  rejectOptions(ctx, ['build-number']);
  const buildNumber = resolveBuildNumber(ctx.options['build-number'], { required: true });
  requireEnv([...ENV.iosSigning, 'APPLE_DEVELOPMENT_TEAM'], 'iOS distribution signing');
  const configuredApiKey = ENV.tauriAppleApiKey.filter(present);
  if (configuredApiKey.length > 0) {
    fail(`unset ${configuredApiKey.join(', ')} for publish`, ['they switch tauri-cli to API-key automatic signing; publish signs manually with IOS_CERTIFICATE + IOS_MOBILE_PROVISION', 'TestFlight upload credentials use the ASC_* names']);
  }
  const team = process.env.APPLE_DEVELOPMENT_TEAM.trim();
  if (!/^[A-Z0-9]{10}$/.test(team)) fail('APPLE_DEVELOPMENT_TEAM must be the 10-character Apple team ID');
  const version = appVersion();
  const found = await iosEnvironment({ minXcode: IOS.minUploadXcode });
  guardSigningState();

  step('Checking the distribution certificate and provisioning profile');
  await preflightIosSigning(team);

  const outDir = path.join(IOS.project, 'build', IOS.device.out);
  fs.rmSync(outDir, { recursive: true, force: true });
  const before = gitStatus(IOS.project);
  step(`Building and exporting for App Store Connect (CFBundleVersion ${buildNumber})`);
  await run('pnpm', ['tauri', 'ios', 'build', '--ci', '--target', IOS.device.tauri, '--export-method', 'app-store-connect', ...tauriVersionConfig(buildNumber)], { env: found.env });
  reportNativeProjectChanges(IOS.project, before);
  const ipa = findSingle(outDir, (name) => name.endsWith('.ipa'), 'IPA');

  step('Verifying the IPA');
  const dir = makePrivateTempDir('novelist-ipa-');
  await run('ditto', ['-x', '-k', ipa, dir], { capture: true });
  const app = findSingle(path.join(dir, 'Payload'), (name) => name.endsWith('.app'), 'app bundle in Payload/');
  await verifyIosInfoPlist(path.join(app, 'Info.plist'), { version, buildNumber, label: rel(ipa) });
  if (!isFile(path.join(app, 'embedded.mobileprovision'))) fail(`${rel(ipa)} has no embedded provisioning profile`);
  if (!isFile(path.join(app, 'PrivacyInfo.xcprivacy'))) fail(`${rel(ipa)} does not contain PrivacyInfo.xcprivacy`);
  await run('codesign', ['--verify', '--deep', '--strict', app], { capture: true });
  const signature = await run('codesign', ['-dvv', app], { capture: true });
  const details = `${signature.stdout}\n${signature.stderr}`;
  if (!/^Authority=(Apple|iPhone) Distribution:/m.test(details)) fail(`${rel(ipa)} is not signed with an Apple Distribution certificate`);
  if (!new RegExp(`^TeamIdentifier=${team}$`, 'm').test(details)) fail(`${rel(ipa)} is not signed by team ${team}`);
  const staged = stageRelease(ipa, `${releaseBaseName(version, buildNumber)}_ios.ipa`);
  console.log(`IPA     ${rel(staged.target)}`);
  console.log(`SHA-256 ${staged.digest}`);
  console.log('Next: `node scripts/mobile.mjs ios upload` sends it to App Store Connect.');
}

async function iosUpload(ctx) {
  rejectOptions(ctx, ['build-number', 'ipa']);
  const version = appVersion();
  const buildNumber = resolveBuildNumber(ctx.options['build-number'], { required: true });
  const ipa = path.resolve(ctx.options.ipa ?? path.join(RELEASE_DIR, `${releaseBaseName(version, buildNumber)}_ios.ipa`));
  if (!isFile(ipa)) fail(`IPA not found: ${rel(ipa)}`, ['run `node scripts/mobile.mjs ios publish` first']);
  requireEnv(['ASC_API_KEY_ID', 'ASC_API_ISSUER_ID', 'ASC_APP_APPLE_ID'], 'App Store Connect upload');
  if (!present('ASC_API_PRIVATE_KEY') && !present('ASC_API_PRIVATE_KEY_PATH')) fail('App Store Connect upload: set ASC_API_PRIVATE_KEY (the .p8 contents) or ASC_API_PRIVATE_KEY_PATH');
  const keyId = process.env.ASC_API_KEY_ID.trim();
  const issuer = process.env.ASC_API_ISSUER_ID.trim();
  const appleId = process.env.ASC_APP_APPLE_ID.trim();
  if (!/^[A-Z0-9]{10}$/.test(keyId)) fail('ASC_API_KEY_ID must be the 10-character key ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issuer)) fail('ASC_API_ISSUER_ID must be the issuer UUID shown above the team keys table');
  if (!/^[0-9]+$/.test(appleId)) fail('ASC_APP_APPLE_ID must be the numeric Apple ID of the app record (App Information page)');
  const found = await iosEnvironment({ minXcode: IOS.minUploadXcode });

  const dir = makePrivateTempDir('novelist-ipa-');
  await run('ditto', ['-x', '-k', ipa, dir], { capture: true });
  const app = findSingle(path.join(dir, 'Payload'), (name) => name.endsWith('.app'), 'app bundle in Payload/');
  await verifyIosInfoPlist(path.join(app, 'Info.plist'), { version, buildNumber, label: rel(ipa) });

  // altool reads AuthKey_<id>.p8 from API_PRIVATE_KEYS_DIR; the directory is
  // private to this run and removed on every exit path.
  const keys = makePrivateTempDir('novelist-asc-key-');
  const keyFile = path.join(keys, `AuthKey_${keyId}.p8`);
  if (!present('ASC_API_PRIVATE_KEY') && !isFile(process.env.ASC_API_PRIVATE_KEY_PATH)) fail('ASC_API_PRIVATE_KEY_PATH does not point to a readable .p8 file');
  const key = present('ASC_API_PRIVATE_KEY') ? process.env.ASC_API_PRIVATE_KEY : fs.readFileSync(process.env.ASC_API_PRIVATE_KEY_PATH, 'utf8');
  if (!key.includes('-----BEGIN PRIVATE KEY-----')) fail('the App Store Connect API key is not a PEM .p8 private key');
  fs.writeFileSync(keyFile, key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600 });

  step(`Uploading ${path.basename(ipa)} to App Store Connect`);
  await run(
    'xcrun',
    ['altool', '--upload-package', ipa, '--platform', 'ios', '--apple-id', appleId, '--bundle-id', APP_ID, '--bundle-version', String(buildNumber), '--bundle-short-version-string', version.split('-')[0], '--api-key', keyId, '--api-issuer', issuer],
    { env: childEnv({ ...found.env, API_PRIVATE_KEYS_DIR: keys }, { drop: ENV.asc }), display: `xcrun altool --upload-package ${path.basename(ipa)} --platform ios (API key auth)` },
  );
  console.log('Upload accepted by altool. App Store Connect processing, TestFlight availability and Beta App Review happen afterwards and are not verified by this script.');
}

// ── Dispatch ──────────────────────────────────────────────────────────────

const COMMANDS = {
  android: { doctor: androidDoctor, init: androidInit, dev: androidDev, check: androidCheck, build: androidBuild, publish: androidPublish, verify: androidVerify, 'ci-sdk': androidCiSdk },
  ios: { doctor: iosDoctor, init: iosInit, dev: iosDev, check: iosCheck, build: iosBuild, publish: iosPublish, upload: iosUpload },
};

async function main(argv) {
  const { positional, options, passthrough } = parseArgs(argv);
  if (options.help || positional.length === 0) {
    console.log(USAGE);
    return;
  }
  const [platform, command, ...extra] = positional;
  if (platform === 'build-number') {
    if (extra.length > 0) fail('build-number takes at most one value');
    console.log(command !== undefined ? parseBuildNumber(command, 'build number') : resolveBuildNumber(undefined, { required: true }));
    return;
  }
  if (!COMMANDS[platform]) fail(`unknown platform "${platform}"`, ['expected "android" or "ios" (or "build-number"); see --help']);
  const handler = COMMANDS[platform][command];
  if (!handler) fail(`unknown ${platform} command "${command ?? ''}"`, [`expected one of: ${Object.keys(COMMANDS[platform]).join(', ')}`]);
  if (extra.length > 0) fail(`unexpected argument "${extra[0]}"`, ['pass tauri arguments after --']);
  if (command !== 'dev' && passthrough.length > 0) {
    // `pnpm mobile:<platform>:<command> -- --flag` forwards the separator;
    // only `dev` hands arguments to tauri, so read the rest as our options.
    const forwarded = parseArgs(passthrough);
    if (forwarded.positional.length > 0 || forwarded.passthrough.length > 0) fail(`"${platform} ${command}" takes no extra arguments`);
    if (forwarded.options.help) {
      console.log(USAGE);
      return;
    }
    const { target, ...rest } = forwarded.options;
    Object.assign(options, rest);
    options.target.push(...target);
    passthrough.length = 0;
  }
  await handler({ platform, command, options, passthrough });
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof Failure) {
    console.error(inActions ? `::error::${error.message}` : `error: ${error.message}`);
    for (const hint of error.hints.filter(Boolean)) console.error(`  ${hint.replaceAll('\n', '\n  ')}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
} finally {
  runCleanups();
}
