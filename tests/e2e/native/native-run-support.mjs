// @ts-nocheck -- Executed directly by Node; behavior is covered by native-run-support.test.ts.
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

import {
  NATIVE_FIXTURE_TEARDOWN_TIMEOUT_MS,
  NATIVE_FIXTURE_TIMEOUT_MS,
  NATIVE_WORKFLOW_TIMEOUT_MS,
  PLAYWRIGHT_CHILD_KILL_GRACE_MS,
  PLAYWRIGHT_CHILD_REPORT_EXIT_BUFFER_MS,
  PLAYWRIGHT_CHILD_TERM_GRACE_MS,
  PLAYWRIGHT_CHILD_TIMEOUT_MS,
} from './native-timeout-policy.mjs';

export {
  NATIVE_FIXTURE_TEARDOWN_TIMEOUT_MS,
  NATIVE_FIXTURE_TIMEOUT_MS,
  NATIVE_WORKFLOW_TIMEOUT_MS,
  PLAYWRIGHT_CHILD_KILL_GRACE_MS,
  PLAYWRIGHT_CHILD_REPORT_EXIT_BUFFER_MS,
  PLAYWRIGHT_CHILD_TERM_GRACE_MS,
  PLAYWRIGHT_CHILD_TIMEOUT_MS,
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VISUAL_LIFECYCLE_GREP = 'real WKWebView native clipboard';
const RAPID_RELOAD_GREP = 'rapid external v1 v2 v3';
const DEFAULT_NATIVE_RUN_LOCK_PORT = 43_124;
export const RUN_OWNED_PATH_KEYS = Object.freeze([
  'socket',
  'runRoot',
  'project',
  'home',
  'temp',
  'config',
  'clipboardSnapshot',
  'pasteboardHelper',
  'supervisor',
  'bundle',
  'png',
  'screenshot',
  'tauriLog',
  'owner',
  'initialFile',
  'playwrightOutput',
]);

/**
 * @typedef {'visual' | 'nonvisual-behavior'} NativeMode
 * @typedef {'visual-lifecycle' | 'rapid-reload' | 'custom'} NativeScenario
 * @typedef {'required' | 'not_required'} NativeArtifactRequirement
 * @typedef {{
 *   scenario: NativeScenario,
 *   mode: NativeMode,
 *   artifact: NativeArtifactRequirement,
 *   acceptanceOwner: boolean,
 * }} NativeScenarioPolicy
 */

/**
 * @param {string} nativeMode
 * @param {string} testGrep
 * @returns {NativeScenarioPolicy}
 */
export function nativeScenarioPolicy(nativeMode, testGrep) {
  if (nativeMode === 'nonvisual-behavior') {
    const scenario =
      testGrep === VISUAL_LIFECYCLE_GREP
        ? 'visual-lifecycle'
        : testGrep === RAPID_RELOAD_GREP
          ? 'rapid-reload'
          : 'custom';
    return {
      scenario,
      mode: 'nonvisual-behavior',
      artifact: 'not_required',
      acceptanceOwner: false,
    };
  }
  if (nativeMode === 'visual' && testGrep === VISUAL_LIFECYCLE_GREP) {
    return {
      scenario: 'visual-lifecycle',
      mode: 'visual',
      artifact: 'required',
      acceptanceOwner: true,
    };
  }
  if (nativeMode === 'visual' && testGrep === RAPID_RELOAD_GREP) {
    return {
      scenario: 'rapid-reload',
      mode: 'visual',
      artifact: 'not_required',
      acceptanceOwner: false,
    };
  }
  throw new Error(`unsupported native scenario: mode=${nativeMode} grep=${testGrep}`);
}

export function resolveNativeRunLockPort(value) {
  if (value === undefined) return DEFAULT_NATIVE_RUN_LOCK_PORT;
  if (!/^\d+$/.test(value)) throw new Error(`invalid native run lock port: ${value}`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid native run lock port: ${value}`);
  }
  return port;
}

export async function acquireNativeRunLock(port, owner) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid native run lock port: ${port}`);
  }
  const host = '127.0.0.1';
  const listener = createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      listener.once('error', onError);
      listener.listen({ host, port, exclusive: true }, () => {
        listener.off('error', onError);
        resolve();
      });
    });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EADDRINUSE') {
      throw new Error(`native run already active: ${host}:${port}`);
    }
    throw error;
  }
  return { host, port, owner, listener };
}

export async function releaseNativeRunLock(lock) {
  if (!lock.listener.listening) return;
  await new Promise((resolve, reject) => {
    lock.listener.close((error) => (error ? reject(error) : resolve()));
  });
  if (lock.listener.listening) {
    throw new Error(`native run lock listener survived release: ${lock.host}:${lock.port}`);
  }
}

export function pickEnvironment(source, names) {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = source[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

export function strictInteractiveEnvironmentValue(value) {
  return value === '1' ? '1' : undefined;
}

export function computeContainedScreenshotCrop(image, viewport, crop) {
  const values = {
    'image width': image.width,
    'image height': image.height,
    'viewport width': viewport.innerWidth,
    'viewport height': viewport.innerHeight,
    'crop x': crop.x,
    'crop y': crop.y,
    'crop width': crop.width,
    'crop height': crop.height,
  };
  for (const [label, value] of Object.entries(values)) {
    if (!Number.isFinite(value)) throw new Error(`${label} must be finite: ${value}`);
  }
  for (const [label, value] of Object.entries({
    'image width': image.width,
    'image height': image.height,
    'viewport width': viewport.innerWidth,
    'viewport height': viewport.innerHeight,
    'crop width': crop.width,
    'crop height': crop.height,
  })) {
    if (value <= 0) throw new Error(`${label} must be greater than zero: ${value}`);
  }
  if (crop.x < 0 || crop.y < 0) {
    throw new Error(`crop origin must be nonnegative: x=${crop.x} y=${crop.y}`);
  }

  const scale = image.width / viewport.innerWidth;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`screenshot scale must be finite and greater than zero: ${scale}`);
  }
  const contentTop = image.height - viewport.innerHeight * scale;
  if (!Number.isFinite(contentTop) || contentTop < 0) {
    throw new Error(`screenshot content offset must be finite and nonnegative: ${contentTop}`);
  }

  const cssRight = crop.x + crop.width;
  const cssBottom = crop.y + crop.height;
  if (!Number.isFinite(cssRight) || cssRight > viewport.innerWidth) {
    throw new Error(`crop exceeds viewport right bound: ${cssRight} > ${viewport.innerWidth}`);
  }
  if (!Number.isFinite(cssBottom) || cssBottom > viewport.innerHeight) {
    throw new Error(`crop exceeds viewport bottom bound: ${cssBottom} > ${viewport.innerHeight}`);
  }

  const result = {
    x: crop.x * scale,
    y: contentTop + crop.y * scale,
    width: crop.width * scale,
    height: crop.height * scale,
  };
  if (!Object.values(result).every(Number.isFinite)) {
    throw new Error(`scaled crop geometry must be finite: ${JSON.stringify(result)}`);
  }
  if (result.width <= 0 || result.height <= 0) {
    throw new Error(`scaled crop dimensions must be greater than zero: width=${result.width} height=${result.height}`);
  }
  if (result.x < 0 || result.y < 0) {
    throw new Error(`scaled crop origin must be nonnegative: x=${result.x} y=${result.y}`);
  }
  if (Math.ceil(result.x + result.width) > image.width) {
    throw new Error(`crop exceeds screenshot right bound: ${result.x + result.width} > ${image.width}`);
  }
  if (Math.ceil(result.y + result.height) > image.height) {
    throw new Error(`crop exceeds screenshot bottom bound: ${result.y + result.height} > ${image.height}`);
  }

  return { scale, contentTop, crop: result };
}

export function runOwnedPathResidue(paths, pathExists) {
  return Object.fromEntries(Object.entries(paths).map(([name, ownedPath]) => [name, pathExists(ownedPath)]));
}

export function buildRunOwnedPathInventory(paths) {
  const actualKeys = Object.keys(paths);
  const missing = RUN_OWNED_PATH_KEYS.filter((key) => !Object.hasOwn(paths, key));
  const expected = new Set(RUN_OWNED_PATH_KEYS);
  const unexpected = actualKeys.filter((key) => !expected.has(key)).sort();
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `invalid run-owned path inventory: missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`,
    );
  }
  return Object.fromEntries(RUN_OWNED_PATH_KEYS.map((key) => [key, paths[key]]));
}

export function dirtyConflictStatePreserved(dirtySnapshot, unresolvedSnapshot, expected) {
  const matches = (snapshot) =>
    snapshot.content === expected.editorContent &&
    snapshot.storeContent === expected.storeContent &&
    snapshot.dirty === true &&
    snapshot.composing === false &&
    snapshot.filePath === expected.filePath;
  return matches(dirtySnapshot) && matches(unresolvedSnapshot);
}

export function waitForPlaywrightChild(child, options = {}) {
  const timeoutMs = options.timeoutMs ?? PLAYWRIGHT_CHILD_TIMEOUT_MS;
  const termGraceMs = options.termGraceMs ?? PLAYWRIGHT_CHILD_TERM_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? PLAYWRIGHT_CHILD_KILL_GRACE_MS;
  for (const [name, value] of Object.entries({
    timeoutMs,
    termGraceMs,
    killGraceMs,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`invalid Playwright child watchdog ${name}: ${value}`);
    }
  }
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new Error(`Playwright child process-group leader must have a positive PID: ${child.pid}`);
  }

  const signalProcessGroup = options.signalProcessGroup ?? process.kill;
  const processGroupPid = -child.pid;
  return new Promise((resolve) => {
    let timedOut = false;
    let directChildExit = null;
    let watchdogTimer;
    let graceTimer;
    let settled = false;
    const signalErrors = [];

    const cleanup = () => {
      clearTimeout(watchdogTimer);
      clearTimeout(graceTimer);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const errorIsMissingProcess = (error) => error && typeof error === 'object' && error.code === 'ESRCH';
    const signalGroup = (signal) => {
      try {
        signalProcessGroup(processGroupPid, signal);
        return true;
      } catch (error) {
        if (errorIsMissingProcess(error)) return false;
        signalErrors.push(`${signal}: ${error instanceof Error ? error.message : String(error)}`);
        return true;
      }
    };
    const timeoutReason = (outcome) => {
      const childStatus = directChildExit ? `; direct child ${directChildExit}` : '';
      const errors = signalErrors.length > 0 ? `; signal errors: ${signalErrors.join(', ')}` : '';
      return `Playwright child timed out after ${timeoutMs}ms; ${outcome}${childStatus}${errors}`;
    };
    const onError = (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (timedOut) {
        directChildExit = `error: ${message}`;
        return;
      }
      finish({
        exitCode: 1,
        reason: `Playwright child error: ${message}`,
        timedOut: false,
      });
    };
    const onExit = (code, signal) => {
      const exitStatus = signal ? `exited with signal ${signal}` : `exited with code ${code ?? 1}`;
      if (timedOut) {
        directChildExit = exitStatus;
        return;
      }

      clearTimeout(watchdogTimer);
      const naturalResult = {
        exitCode: code ?? (signal ? 1 : 0),
        reason: code === null ? `exit signal ${signal ?? 'unknown'}` : `exit code ${code}`,
        timedOut: false,
      };
      if (!signalGroup(0)) {
        finish(naturalResult);
        return;
      }

      const finishDescendantFailure = (outcome) =>
        finish({
          exitCode: 1,
          reason: `Playwright child ${naturalResult.reason}; detached descendants survived leader exit; ${outcome}`,
          timedOut: false,
        });
      if (!signalGroup('SIGTERM')) {
        finishDescendantFailure('process group disappeared before SIGTERM');
        return;
      }
      graceTimer = setTimeout(() => {
        if (!signalGroup('SIGKILL')) {
          finishDescendantFailure('process group exited during SIGTERM grace');
          return;
        }
        graceTimer = setTimeout(() => {
          const groupSurvived = signalGroup(0);
          finishDescendantFailure(
            groupSurvived
              ? `process group survived SIGKILL grace ${killGraceMs}ms`
              : 'process group absent after SIGKILL',
          );
        }, killGraceMs);
      }, termGraceMs);
    };

    child.once('error', onError);
    child.once('exit', onExit);
    watchdogTimer = setTimeout(() => {
      timedOut = true;
      if (!signalGroup('SIGTERM')) {
        finish({
          exitCode: 1,
          reason: timeoutReason('process group already absent at SIGTERM'),
          timedOut: true,
        });
        return;
      }
      graceTimer = setTimeout(() => {
        if (!signalGroup('SIGKILL')) {
          finish({
            exitCode: 1,
            reason: timeoutReason('process group exited during SIGTERM grace'),
            timedOut: true,
          });
          return;
        }
        graceTimer = setTimeout(() => {
          const groupSurvived = signalGroup(0);
          finish({
            exitCode: 1,
            reason: timeoutReason(
              groupSurvived
                ? `process group survived SIGKILL grace ${killGraceMs}ms`
                : 'process group absent after SIGKILL',
            ),
            timedOut: true,
          });
        }, killGraceMs);
      }, termGraceMs);
    }, timeoutMs);
  });
}

export async function awaitInteractiveEvidence(evidencePromise, cleanupErrors) {
  if (!evidencePromise) return;
  try {
    await evidencePromise;
  } catch (error) {
    cleanupErrors.push(`interactive evidence: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function publicationAllowed(playwrightExit, cleanupErrors) {
  return playwrightExit === 0 && cleanupErrors.length === 0;
}

export async function prepareRunArtifact(runId, startedAtMs, runPath) {
  if (!path.basename(runPath).includes(runId)) {
    throw new Error(`artifact path is not bound to run ID ${runId}: ${runPath}`);
  }
  const bytes = await readFile(runPath);
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`run artifact is not a PNG: ${runPath}`);
  }
  return {
    runId,
    startedAtMs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
}

async function acquireArtifactLock(lockPath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await open(lockPath, 'wx');
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'EEXIST' || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

function ownerIsNewer(owner, candidate) {
  return (
    owner.startedAtMs > candidate.startedAtMs ||
    (owner.startedAtMs === candidate.startedAtMs && owner.runId > candidate.runId)
  );
}

function sameOwner(owner, candidate) {
  return owner?.runId === candidate.runId && owner?.startedAtMs === candidate.startedAtMs;
}

function sharedArtifactPaths(sharedPath) {
  return {
    lockPath: `${sharedPath}.lock`,
    metadataPath: `${sharedPath}.metadata.json`,
    ownerPath: `${sharedPath}.owner.json`,
  };
}

async function withArtifactLock(sharedPath, operation) {
  const { lockPath } = sharedArtifactPaths(sharedPath);
  const lock = await acquireArtifactLock(lockPath);
  try {
    return await operation();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function invalidateSharedArtifactLocked(candidate, sharedPath) {
  const { metadataPath, ownerPath } = sharedArtifactPaths(sharedPath);
  const currentOwner = await readJsonIfPresent(ownerPath);
  if (currentOwner && ownerIsNewer(currentOwner, candidate)) {
    return { runId: candidate.runId, startedAtMs: candidate.startedAtMs, owned: false };
  }

  if (!sameOwner(currentOwner, candidate)) {
    const nonce = `${candidate.runId}.${process.pid}.${randomUUID()}`;
    const ownerTemporary = `${ownerPath}.${nonce}.tmp`;
    try {
      await writeFile(
        ownerTemporary,
        `${JSON.stringify({
          runId: candidate.runId,
          startedAtMs: candidate.startedAtMs,
        })}\n`,
        { flag: 'wx' },
      );
      await Promise.all([rm(sharedPath, { force: true }), rm(metadataPath, { force: true })]);
      await rename(ownerTemporary, ownerPath);
    } finally {
      await rm(ownerTemporary, { force: true });
    }
  } else {
    await Promise.all([rm(sharedPath, { force: true }), rm(metadataPath, { force: true })]);
  }

  return { runId: candidate.runId, startedAtMs: candidate.startedAtMs, owned: true };
}

export async function invalidateSharedArtifact(candidate, sharedPath) {
  return withArtifactLock(sharedPath, () => invalidateSharedArtifactLocked(candidate, sharedPath));
}

async function publishPreparedArtifactLocked(prepared, sharedPath) {
  const { metadataPath, ownerPath } = sharedArtifactPaths(sharedPath);
  const currentOwner = await readJsonIfPresent(ownerPath);
  if (!sameOwner(currentOwner, prepared)) {
    return {
      fresh: true,
      runId: prepared.runId,
      startedAtMs: prepared.startedAtMs,
      sha256: prepared.sha256,
      bytes: prepared.bytes.length,
      published: false,
    };
  }

  const nonce = `${prepared.runId}.${process.pid}.${randomUUID()}`;
  const artifactTemporary = `${sharedPath}.${nonce}.tmp`;
  const metadataTemporary = `${metadataPath}.${nonce}.tmp`;
  const metadata = {
    runId: prepared.runId,
    startedAtMs: prepared.startedAtMs,
    sha256: prepared.sha256,
    bytes: prepared.bytes.length,
  };
  try {
    await writeFile(artifactTemporary, prepared.bytes, { flag: 'wx' });
    await writeFile(metadataTemporary, `${JSON.stringify(metadata)}\n`, { flag: 'wx' });
    await rename(artifactTemporary, sharedPath);
    await rename(metadataTemporary, metadataPath);
  } finally {
    await Promise.all([rm(artifactTemporary, { force: true }), rm(metadataTemporary, { force: true })]);
  }
  return { fresh: true, ...metadata, published: true };
}

export async function publishPreparedArtifact(prepared, sharedPath) {
  return withArtifactLock(sharedPath, () => publishPreparedArtifactLocked(prepared, sharedPath));
}

export async function publishPreparedArtifactTransaction(prepared, sharedPath, publishEvidence) {
  return withArtifactLock(sharedPath, async () => {
    try {
      const artifact = await publishPreparedArtifactLocked(prepared, sharedPath);
      if (!artifact.published) {
        throw new Error(`artifact ownership changed before publication for run ${prepared.runId}`);
      }
      await publishEvidence(artifact);
      const { ownerPath } = sharedArtifactPaths(sharedPath);
      const currentOwner = await readJsonIfPresent(ownerPath);
      if (!sameOwner(currentOwner, prepared)) {
        throw new Error(`artifact ownership changed during evidence publication for run ${prepared.runId}`);
      }
      return artifact;
    } catch (error) {
      try {
        await invalidateSharedArtifactLocked(prepared, sharedPath);
      } catch (invalidationError) {
        throw new AggregateError(
          [error, invalidationError],
          'artifact or evidence publication failed and artifact invalidation also failed',
        );
      }
      throw error;
    }
  });
}

export async function scanResidueRoots(roots, needles, readDirectory = readdir) {
  const matches = [];
  async function scan(current, depth) {
    let entries;
    try {
      entries = await readDirectory(current, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (needles.some((needle) => candidate.toLowerCase().includes(needle))) {
        matches.push(candidate);
      } else if (entry.isDirectory() && !entry.isSymbolicLink() && depth < 3) {
        await scan(candidate, depth + 1);
      }
    }
  }
  for (const root of roots) await scan(root, 0);
  return [...new Set(matches)];
}
