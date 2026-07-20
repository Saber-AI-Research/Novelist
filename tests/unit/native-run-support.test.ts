// @ts-nocheck -- Vitest runs this Node-only harness test outside the app browser type environment.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import * as nativeRunSupport from '../e2e/native/native-run-support.mjs';
import {
  awaitInteractiveEvidence,
  buildRunOwnedPathInventory,
  computeContainedScreenshotCrop,
  dirtyConflictStatePreserved,
  invalidateSharedArtifact,
  pickEnvironment,
  prepareRunArtifact,
  publicationAllowed,
  publishPreparedArtifact,
  publishPreparedArtifactTransaction,
  RUN_OWNED_PATH_KEYS,
  runOwnedPathResidue,
  scanResidueRoots,
  strictInteractiveEnvironmentValue,
} from '../e2e/native/native-run-support.mjs';

const roots: string[] = [];
const execFileAsync = promisify(execFile);
const nativeRunSupportUrl = pathToFileURL(path.resolve('tests/e2e/native/native-run-support.mjs')).href;

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test loopback port unavailable');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function runLockContender(port: number, startAtMs: number): Promise<{ code: number; output: string }> {
  const source = `
    import { acquireNativeRunLock, releaseNativeRunLock } from ${JSON.stringify(nativeRunSupportUrl)};
    const port = Number(process.argv[1]);
    const startAtMs = Number(process.argv[2]);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAtMs - Date.now())));
    try {
      const lock = await acquireNativeRunLock(port, {
        pid: process.pid,
        runId: 'contender-' + process.pid,
        startedAtMs: Date.now(),
      });
      process.stdout.write('ACQUIRED\\n');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await releaseNativeRunLock(lock);
    } catch (error) {
      process.stdout.write('REJECTED:' + (error instanceof Error ? error.message : String(error)) + '\\n');
      process.exitCode = 2;
    }
  `;
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', source, String(port), String(startAtMs)],
      { encoding: 'utf8' },
    );
    return { code: 0, output: stdout.trim() };
  } catch (error) {
    if (!error || typeof error !== 'object' || !('stdout' in error) || !('code' in error)) throw error;
    return { code: Number(error.code), output: String(error.stdout).trim() };
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native run support', () => {
  it.skipIf(process.platform === 'win32')('rejects canonical bundle escapes before destructive cleanup', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'novelist-native-containment-'));
    roots.push(root);
    const runRoot = path.join(root, 'run');
    const outsideRoot = path.join(root, 'outside');
    const symlinkParent = path.join(runRoot, 'escape-parent');
    await Promise.all([mkdir(runRoot, { recursive: true }), mkdir(outsideRoot, { recursive: true })]);
    await symlink(outsideRoot, symlinkParent, 'dir');

    const cases = [`${runRoot}/../outside/lexical.app`, path.join(symlinkParent, 'symlink.app')];
    for (const bundle of cases) {
      const sentinel = path.join(bundle, 'sentinel.txt');
      await mkdir(bundle, { recursive: true });
      await writeFile(sentinel, 'preserve');
      const failure = await execFileAsync(
        '/bin/bash',
        ['tests/e2e/native/e2e-runner.sh', path.join(root, 'missing-binary')],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            NOVELIST_NATIVE_RUN_ROOT: runRoot,
            NOVELIST_NATIVE_BUNDLE: bundle,
            NOVELIST_NATIVE_IDENTIFIER: 'com.novelist.e2e.containment',
            NOVELIST_NATIVE_SUPERVISOR: path.join(root, 'missing-supervisor'),
          },
        },
      ).then(
        () => null,
        (error) => error,
      );

      expect(failure).not.toBeNull();
      expect(failure.code).toBe(64);
      expect(failure.stdout).not.toContain('native_stage=bundle state=begin');
      expect(await readFile(sentinel, 'utf8')).toBe('preserve');
    }

    const containedBundle = path.join(runRoot, 'contained.app');
    const containedFailure = await execFileAsync(
      '/bin/bash',
      ['tests/e2e/native/e2e-runner.sh', path.join(root, 'missing-binary')],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          NOVELIST_NATIVE_RUN_ROOT: runRoot,
          NOVELIST_NATIVE_BUNDLE: containedBundle,
          NOVELIST_NATIVE_IDENTIFIER: 'com.novelist.e2e.contained',
          NOVELIST_NATIVE_SUPERVISOR: path.join(root, 'missing-supervisor'),
        },
      },
    ).then(
      () => null,
      (error) => error,
    );

    expect(containedFailure).not.toBeNull();
    expect(containedFailure.code).toBe(66);
    expect(containedFailure.stdout).toContain('native_stage=bundle state=begin');
  });

  it('requires a screenshot only for the visual lifecycle acceptance scenario', () => {
    expect(nativeRunSupport.nativeScenarioPolicy).toBeTypeOf('function');
    expect(nativeRunSupport.nativeScenarioPolicy('visual', 'real WKWebView native clipboard')).toEqual({
      scenario: 'visual-lifecycle',
      mode: 'visual',
      artifact: 'required',
      acceptanceOwner: true,
    });
  });

  it('does not require or own a screenshot for the rapid-reload scenario', () => {
    expect(nativeRunSupport.nativeScenarioPolicy('visual', 'rapid external v1 v2 v3')).toEqual({
      scenario: 'rapid-reload',
      mode: 'visual',
      artifact: 'not_required',
      acceptanceOwner: false,
    });
  });

  it('does not require or own a screenshot in explicit nonvisual mode', () => {
    const cases = [
      ['real WKWebView native clipboard', 'visual-lifecycle'],
      ['rapid external v1 v2 v3', 'rapid-reload'],
      ['custom native selection', 'custom'],
    ];
    for (const [testGrep, scenario] of cases) {
      expect(nativeRunSupport.nativeScenarioPolicy('nonvisual-behavior', testGrep)).toEqual({
        scenario,
        mode: 'nonvisual-behavior',
        artifact: 'not_required',
        acceptanceOwner: false,
      });
    }
  });

  it('uses a fixed native mutex port and validates explicit overrides', () => {
    expect(nativeRunSupport.resolveNativeRunLockPort).toBeTypeOf('function');
    expect(nativeRunSupport.resolveNativeRunLockPort(undefined)).toBe(43_124);
    expect(nativeRunSupport.resolveNativeRunLockPort('45123')).toBe(45_123);
    expect(() => nativeRunSupport.resolveNativeRunLockPort('0')).toThrow('invalid native run lock port');
    expect(() => nativeRunSupport.resolveNativeRunLockPort('65536')).toThrow('invalid native run lock port');
    expect(() => nativeRunSupport.resolveNativeRunLockPort('45123.5')).toThrow('invalid native run lock port');
  });

  it('allows exactly one of two processes to acquire the loopback native mutex', async () => {
    const port = await allocateLoopbackPort();
    const startAtMs = Date.now() + 1_000;

    const results = await Promise.all([runLockContender(port, startAtMs), runLockContender(port, startAtMs)]);

    expect(results.filter((result) => result.output === 'ACQUIRED')).toHaveLength(1);
    expect(
      results.filter((result) => result.output === `REJECTED:native run already active: 127.0.0.1:${port}`),
    ).toHaveLength(1);
    expect(results.map((result) => result.code).sort()).toEqual([0, 2]);
  });

  it('reacquires the loopback native mutex after its holder exits without cleanup', async () => {
    const port = await allocateLoopbackPort();
    const source = `
      import { acquireNativeRunLock } from ${JSON.stringify(nativeRunSupportUrl)};
      const lock = await acquireNativeRunLock(Number(process.argv[1]), {
        pid: process.pid,
        runId: 'crashing-holder',
        startedAtMs: Date.now(),
      });
      process.stdout.write('ACQUIRED\\n', () => process.exit(17));
    `;
    let holderResult;
    try {
      await execFileAsync(process.execPath, ['--input-type=module', '--eval', source, String(port)], {
        encoding: 'utf8',
      });
      throw new Error('holder unexpectedly exited successfully');
    } catch (error) {
      holderResult = error;
    }
    expect(holderResult).toMatchObject({ code: 17, stdout: 'ACQUIRED\n' });

    const lock = await nativeRunSupport.acquireNativeRunLock(port, {
      pid: process.pid,
      runId: 'reacquired-after-exit',
      startedAtMs: Date.now(),
    });
    await nativeRunSupport.releaseNativeRunLock(lock);
  });

  it('releases the native mutex listener before returning', async () => {
    const port = await allocateLoopbackPort();
    const lock = await nativeRunSupport.acquireNativeRunLock(port, {
      pid: process.pid,
      runId: 'listener-release',
      startedAtMs: Date.now(),
    });
    expect(lock.listener.listening).toBe(true);

    await nativeRunSupport.releaseNativeRunLock(lock);

    expect(lock.listener.listening).toBe(false);
    const reacquired = await nativeRunSupport.acquireNativeRunLock(port, {
      pid: process.pid,
      runId: 'listener-reacquired',
      startedAtMs: Date.now(),
    });
    await nativeRunSupport.releaseNativeRunLock(reacquired);
  });

  it('copies only allowlisted environment names', () => {
    expect(pickEnvironment({ PATH: '/bin', LANG: 'en_US.UTF-8', PRIVATE_TOKEN: 'secret' }, ['PATH', 'LANG'])).toEqual({
      PATH: '/bin',
      LANG: 'en_US.UTF-8',
    });
  });

  it('enables interactive activation only for the exact value 1', () => {
    expect(strictInteractiveEnvironmentValue(undefined)).toBeUndefined();
    expect(strictInteractiveEnvironmentValue('1')).toBe('1');
    expect(strictInteractiveEnvironmentValue('0')).toBeUndefined();
    expect(strictInteractiveEnvironmentValue('true')).toBeUndefined();
    expect(strictInteractiveEnvironmentValue(' 1 ')).toBeUndefined();
  });

  it('computes a contained high-DPI crop with the native content offset', () => {
    expect(
      computeContainedScreenshotCrop(
        { width: 2_400, height: 1_600 },
        { innerWidth: 1_200, innerHeight: 780 },
        { x: 100, y: 150, width: 300, height: 200 },
      ),
    ).toEqual({
      scale: 2,
      contentTop: 40,
      crop: { x: 200, y: 340, width: 600, height: 400 },
    });
  });

  it('rejects finite positive crop dimensions that underflow to zero after scaling', () => {
    const positive = Number.MIN_VALUE;
    expect(() =>
      computeContainedScreenshotCrop(
        { width: positive, height: 1 },
        { innerWidth: 1, innerHeight: 1 },
        { x: positive, y: positive, width: positive, height: positive },
      ),
    ).toThrow('scaled crop dimensions must be greater than zero');
  });

  it.each([
    [
      'image width',
      { width: Number.NaN, height: 800 },
      { innerWidth: 1_200, innerHeight: 780 },
      { x: 10, y: 10, width: 100, height: 100 },
    ],
    [
      'image height',
      { width: 1_200, height: Number.POSITIVE_INFINITY },
      { innerWidth: 1_200, innerHeight: 780 },
      { x: 10, y: 10, width: 100, height: 100 },
    ],
    [
      'viewport width',
      { width: 1_200, height: 800 },
      { innerWidth: Number.NEGATIVE_INFINITY, innerHeight: 780 },
      { x: 10, y: 10, width: 100, height: 100 },
    ],
    [
      'viewport height',
      { width: 1_200, height: 800 },
      { innerWidth: 1_200, innerHeight: Number.NaN },
      { x: 10, y: 10, width: 100, height: 100 },
    ],
    [
      'crop x',
      { width: 1_200, height: 800 },
      { innerWidth: 1_200, innerHeight: 780 },
      { x: Number.NaN, y: 10, width: 100, height: 100 },
    ],
    [
      'crop y',
      { width: 1_200, height: 800 },
      { innerWidth: 1_200, innerHeight: 780 },
      { x: 10, y: Number.POSITIVE_INFINITY, width: 100, height: 100 },
    ],
    [
      'crop width',
      { width: 1_200, height: 800 },
      { innerWidth: 1_200, innerHeight: 780 },
      { x: 10, y: 10, width: Number.NaN, height: 100 },
    ],
    [
      'crop height',
      { width: 1_200, height: 800 },
      { innerWidth: 1_200, innerHeight: 780 },
      { x: 10, y: 10, width: 100, height: Number.NEGATIVE_INFINITY },
    ],
  ])('rejects nonfinite %s before native image metrics', (_label, image, viewport, crop) => {
    expect(() => computeContainedScreenshotCrop(image, viewport, crop)).toThrow('must be finite');
  });

  it.each([
    [
      'zero image width',
      { width: 0, height: 800 },
      { innerWidth: 1_200, innerHeight: 780 },
      { x: 10, y: 10, width: 100, height: 100 },
    ],
    [
      'negative image height',
      { width: 1_200, height: -1 },
      { innerWidth: 1_200, innerHeight: 780 },
      { x: 10, y: 10, width: 100, height: 100 },
    ],
    [
      'zero viewport width',
      { width: 1_200, height: 800 },
      { innerWidth: 0, innerHeight: 780 },
      { x: 10, y: 10, width: 100, height: 100 },
    ],
    [
      'negative viewport height',
      { width: 1_200, height: 800 },
      { innerWidth: 1_200, innerHeight: -1 },
      { x: 10, y: 10, width: 100, height: 100 },
    ],
    [
      'zero crop width',
      { width: 1_200, height: 800 },
      { innerWidth: 1_200, innerHeight: 780 },
      { x: 10, y: 10, width: 0, height: 100 },
    ],
    [
      'negative crop height',
      { width: 1_200, height: 800 },
      { innerWidth: 1_200, innerHeight: 780 },
      { x: 10, y: 10, width: 100, height: -1 },
    ],
  ])('rejects %s before native image metrics', (_label, image, viewport, crop) => {
    expect(() => computeContainedScreenshotCrop(image, viewport, crop)).toThrow('must be greater than zero');
  });

  it('rejects a negative content offset and negative crop origins', () => {
    expect(() =>
      computeContainedScreenshotCrop(
        { width: 2_400, height: 1_500 },
        { innerWidth: 1_200, innerHeight: 780 },
        { x: 10, y: 10, width: 100, height: 100 },
      ),
    ).toThrow('content offset');
    expect(() =>
      computeContainedScreenshotCrop(
        { width: 2_400, height: 1_600 },
        { innerWidth: 1_200, innerHeight: 780 },
        { x: -1, y: 10, width: 100, height: 100 },
      ),
    ).toThrow('origin');
    expect(() =>
      computeContainedScreenshotCrop(
        { width: 2_400, height: 1_600 },
        { innerWidth: 1_200, innerHeight: 780 },
        { x: 10, y: -1, width: 100, height: 100 },
      ),
    ).toThrow('origin');
  });

  it('rejects crops extending past the viewport or screenshot right and bottom bounds', () => {
    expect(() =>
      computeContainedScreenshotCrop(
        { width: 2_400, height: 1_600 },
        { innerWidth: 1_200, innerHeight: 780 },
        { x: 1_150, y: 10, width: 100, height: 100 },
      ),
    ).toThrow('right bound');
    expect(() =>
      computeContainedScreenshotCrop(
        { width: 2_400, height: 1_600 },
        { innerWidth: 1_200, innerHeight: 780 },
        { x: 10, y: 750, width: 100, height: 50 },
      ),
    ).toThrow('bottom bound');
  });

  it('reports every named run-owned path without scanning other runs', () => {
    const present = new Set(['/run/root', '/tmp/run-output.txt']);
    expect(
      runOwnedPathResidue(
        {
          runRoot: '/run/root',
          project: '/run/root/project',
          evidence: '/tmp/run-output.txt',
          unrelated: '/tmp/other-run.txt',
        },
        (candidate) => present.has(candidate),
      ),
    ).toEqual({
      runRoot: true,
      project: false,
      evidence: true,
      unrelated: false,
    });
  });

  it('builds the exact canonical run-owned path inventory', () => {
    const expectedKeys = [
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
    ];
    const inventory = Object.fromEntries(expectedKeys.map((key) => [key, `/owned/${key}`]));

    expect(RUN_OWNED_PATH_KEYS).toEqual(expectedKeys);
    expect(buildRunOwnedPathInventory(inventory)).toEqual(inventory);
  });

  it('rejects missing or unexpected run-owned inventory keys without scanning other runs', () => {
    const complete = Object.fromEntries(RUN_OWNED_PATH_KEYS.map((key) => [key, `/owned/${key}`]));
    const missingSocket = { ...complete };
    delete missingSocket.socket;

    expect(() => buildRunOwnedPathInventory(missingSocket)).toThrow('missing=["socket"] unexpected=[]');
    expect(() =>
      buildRunOwnedPathInventory({
        ...complete,
        otherRun: '/tmp/novelist-task24-other-run',
      }),
    ).toThrow('missing=[] unexpected=["otherRun"]');
  });

  it('accepts the unsaved editor/store split while a dirty conflict is unresolved', () => {
    const expected = {
      editorContent: '# 甲 初稿\n轮询回退最新内容。\n\n本地未保存内容',
      storeContent: '# 甲 初稿\n轮询回退最新内容。\n',
      filePath: '/project/甲 初稿.md',
    };
    const dirtySnapshot = {
      content: expected.editorContent,
      storeContent: expected.storeContent,
      dirty: true,
      composing: false,
      filePath: expected.filePath,
    };

    expect(dirtyConflictStatePreserved(dirtySnapshot, { ...dirtySnapshot }, expected)).toBe(true);
  });

  it.each([
    ['editor overwritten by theirs', { content: '# 甲 初稿\n外部冲突内容。\n' }],
    ['store overwritten by theirs', { storeContent: '# 甲 初稿\n外部冲突内容。\n' }],
    ['dirty cleared', { dirty: false }],
    ['composition resumed', { composing: true }],
    ['path changed', { filePath: '/project/乙 修订.md' }],
  ])('rejects unresolved dirty conflict state when %s', (_label, mutation) => {
    const expected = {
      editorContent: 'local editor content',
      storeContent: 'pre-edit store content',
      filePath: '/project/甲 初稿.md',
    };
    const dirtySnapshot = {
      content: expected.editorContent,
      storeContent: expected.storeContent,
      dirty: true,
      composing: false,
      filePath: expected.filePath,
    };

    expect(dirtyConflictStatePreserved(dirtySnapshot, { ...dirtySnapshot, ...mutation }, expected)).toBe(false);
  });

  it('awaits rejected interactive evidence as a cleanup failure before artifact publication', async () => {
    const cleanupErrors: string[] = [];
    const rejectedEvidence = Promise.reject(new Error('interactive append failed'));
    rejectedEvidence.catch(() => {});

    await awaitInteractiveEvidence(rejectedEvidence, cleanupErrors);

    expect(cleanupErrors).toEqual(['interactive evidence: interactive append failed']);
    let artifactPublished = false;
    if (publicationAllowed(0, cleanupErrors)) artifactPublished = true;
    expect(artifactPublished).toBe(false);

    const runner = await readFile('tests/e2e/native/run-native-smoke.mjs', 'utf8');
    const retained = runner.indexOf('interactiveEvidencePromise = appendEvidence(lines);');
    const handled = runner.indexOf('interactiveEvidencePromise.catch(() => {});', retained);
    const awaited = runner.indexOf(
      'await awaitInteractiveEvidence(interactiveEvidencePromise, cleanupErrors);',
      handled,
    );
    const artifactTransaction = runner.indexOf('await publishPreparedArtifactTransaction(', awaited);

    expect(retained).toBeGreaterThan(-1);
    expect(handled).toBeGreaterThan(retained);
    expect(awaited).toBeGreaterThan(handled);
    expect(artifactTransaction).toBeGreaterThan(awaited);
    expect(runner).not.toContain('void appendEvidence(lines)');
  });

  it('forwards the strict interactive flag and requires visible WebKit in visual mode', async () => {
    const [runner, fixture] = await Promise.all([
      readFile('tests/e2e/native/run-native-smoke.mjs', 'utf8'),
      readFile('tests/e2e/native/fixtures/native-app.ts', 'utf8'),
    ]);

    expect(runner).toContain('strictInteractiveEnvironmentValue(process.env.NOVELIST_NATIVE_INTERACTIVE)');
    expect(runner).toContain('NOVELIST_NATIVE_INTERACTIVE: interactiveEnvironment');
    expect(runner).toContain('native_interactive_instruction=');
    expect(runner).toContain('process.stdout.write');
    expect(fixture).toContain("document.visibilityState === 'visible'");
  });

  it('invalidates stale shared evidence and publishes run-bound bytes atomically', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'novelist-native-support-'));
    roots.push(root);
    const runPath = path.join(root, 'artifact-t24-test.png');
    const sharedPath = path.join(root, 'shared.png');
    const owner = { runId: 't24-test', startedAtMs: 100 };
    await writeFile(sharedPath, 'stale');
    await writeFile(`${sharedPath}.metadata.json`, '{"runId":"stale-run"}\n');

    await expect(invalidateSharedArtifact(owner, sharedPath)).resolves.toEqual({
      ...owner,
      owned: true,
    });
    await expect(readFile(sharedPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(`${sharedPath}.metadata.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(`${sharedPath}.owner.json`, 'utf8'))).toEqual(owner);

    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('fresh-native-png'),
    ]);
    await writeFile(runPath, bytes);
    const prepared = await prepareRunArtifact(owner.runId, owner.startedAtMs, runPath);
    const result = await publishPreparedArtifact(prepared, sharedPath);

    expect(result).toEqual({
      fresh: true,
      runId: 't24-test',
      startedAtMs: 100,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      published: true,
    });
    expect(await readFile(sharedPath)).toEqual(bytes);
  });

  it('holds the artifact lock through a failing evidence callback and rolls back without deadlock', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'novelist-native-transaction-lock-'));
    roots.push(root);
    const sharedPath = path.join(root, 'shared.png');
    const runPath = path.join(root, 'artifact-lock-owner.png');
    const owner = { runId: 'lock-owner', startedAtMs: 100 };
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('lock-owner'),
    ]);
    await writeFile(runPath, bytes);
    const prepared = await prepareRunArtifact(owner.runId, owner.startedAtMs, runPath);
    await invalidateSharedArtifact(owner, sharedPath);
    let lockHeld = false;

    await expect(
      publishPreparedArtifactTransaction(prepared, sharedPath, async () => {
        try {
          const competingLock = await open(`${sharedPath}.lock`, 'wx');
          await competingLock.close();
          await rm(`${sharedPath}.lock`, { force: true });
        } catch (error) {
          if (error && typeof error === 'object' && error.code === 'EEXIST') {
            lockHeld = true;
          } else {
            throw error;
          }
        }
        throw new Error('evidence callback failed');
      }),
    ).rejects.toThrow('evidence callback failed');

    expect(lockHeld).toBe(true);
    await expect(readFile(sharedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${sharedPath}.metadata.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revalidates ownership after evidence publication and preserves a newer racing owner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'novelist-native-transaction-race-'));
    roots.push(root);
    const sharedPath = path.join(root, 'shared.png');
    const runPath = path.join(root, 'artifact-race-current.png');
    const current = { runId: 'race-current', startedAtMs: 100 };
    const newer = { runId: 'race-newer', startedAtMs: 200 };
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const currentBytes = Buffer.concat([signature, Buffer.from('current')]);
    const newerBytes = Buffer.concat([signature, Buffer.from('newer')]);
    await writeFile(runPath, currentBytes);
    const prepared = await prepareRunArtifact(current.runId, current.startedAtMs, runPath);
    await invalidateSharedArtifact(current, sharedPath);

    await expect(
      publishPreparedArtifactTransaction(prepared, sharedPath, async () => {
        await Promise.all([
          writeFile(sharedPath, newerBytes),
          writeFile(`${sharedPath}.metadata.json`, `${JSON.stringify({ ...newer, bytes: newerBytes.length })}\n`),
          writeFile(`${sharedPath}.owner.json`, `${JSON.stringify(newer)}\n`),
        ]);
      }),
    ).rejects.toThrow('artifact ownership changed during evidence publication');

    expect(await readFile(sharedPath)).toEqual(newerBytes);
    expect(JSON.parse(await readFile(`${sharedPath}.owner.json`, 'utf8'))).toEqual(newer);
  });

  it('rolls back a published artifact on later evidence failure without deleting a newer owner', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'novelist-native-transaction-'));
    roots.push(root);
    const sharedPath = path.join(root, 'shared.png');
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const currentPath = path.join(root, 'artifact-run-current.png');
    const newerPath = path.join(root, 'artifact-run-newer.png');
    const currentBytes = Buffer.concat([signature, Buffer.from('current')]);
    const newerBytes = Buffer.concat([signature, Buffer.from('newer')]);
    await Promise.all([writeFile(currentPath, currentBytes), writeFile(newerPath, newerBytes)]);
    const current = await prepareRunArtifact('run-current', 100, currentPath);
    const newer = await prepareRunArtifact('run-newer', 200, newerPath);

    await invalidateSharedArtifact(current, sharedPath);
    await expect(
      publishPreparedArtifactTransaction(current, sharedPath, async (artifact) => {
        expect(artifact.published).toBe(true);
        expect(await readFile(sharedPath)).toEqual(currentBytes);
        throw new Error('shared evidence failed');
      }),
    ).rejects.toThrow('shared evidence failed');
    await expect(readFile(sharedPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(`${sharedPath}.metadata.json`)).rejects.toMatchObject({ code: 'ENOENT' });

    await invalidateSharedArtifact(current, sharedPath);
    await expect(
      publishPreparedArtifactTransaction(current, sharedPath, async () => {
        await Promise.all([
          writeFile(sharedPath, newerBytes),
          writeFile(
            `${sharedPath}.metadata.json`,
            `${JSON.stringify({
              runId: newer.runId,
              startedAtMs: newer.startedAtMs,
              sha256: newer.sha256,
              bytes: newerBytes.length,
            })}\n`,
          ),
          writeFile(
            `${sharedPath}.owner.json`,
            `${JSON.stringify({
              runId: newer.runId,
              startedAtMs: newer.startedAtMs,
            })}\n`,
          ),
        ]);
        throw new Error('shared evidence failed after ownership changed');
      }),
    ).rejects.toThrow('shared evidence failed after ownership changed');
    expect(await readFile(sharedPath)).toEqual(newerBytes);
    expect(JSON.parse(await readFile(`${sharedPath}.metadata.json`, 'utf8'))).toMatchObject({
      runId: 'run-newer',
      startedAtMs: 200,
    });

    let evidencePublished = false;
    await expect(
      publishPreparedArtifactTransaction(current, sharedPath, async () => {
        evidencePublished = true;
      }),
    ).rejects.toThrow('artifact ownership changed before publication');
    expect(evidencePublished).toBe(false);
    expect(await readFile(sharedPath)).toEqual(newerBytes);
  });

  it('runs artifact and shared evidence publication in one rollback transaction', async () => {
    const runner = await readFile('tests/e2e/native/run-native-smoke.mjs', 'utf8');
    const transaction = runner.indexOf('await publishPreparedArtifactTransaction(');
    const sharedEvidence = runner.indexOf(
      'await appendFile(sharedEvidencePath, await readFile(runEvidencePath));',
      transaction,
    );

    expect(transaction).toBeGreaterThan(-1);
    expect(sharedEvidence).toBeGreaterThan(transaction);
  });

  it('removes shared success evidence when the current owner invalidates after failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'novelist-native-support-'));
    roots.push(root);
    const sharedPath = path.join(root, 'shared.png');
    const runPath = path.join(root, 'artifact-dirty-run.png');
    const owner = { runId: 'dirty-run', startedAtMs: 100 };
    const bytes = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('dirty-run'),
    ]);
    await writeFile(runPath, bytes);
    await invalidateSharedArtifact(owner, sharedPath);
    const prepared = await prepareRunArtifact(owner.runId, owner.startedAtMs, runPath);
    await publishPreparedArtifact(prepared, sharedPath);

    await expect(invalidateSharedArtifact(owner, sharedPath)).resolves.toEqual({
      ...owner,
      owned: true,
    });

    await expect(readFile(sharedPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(`${sharedPath}.metadata.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(`${sharedPath}.owner.json`, 'utf8'))).toEqual(owner);
  });

  it('refuses publication for failed Playwright or dirty cleanup', () => {
    expect(publicationAllowed(1, [])).toBe(false);
    expect(publicationAllowed(0, ['cache enumeration failed'])).toBe(false);
    expect(publicationAllowed(0, [])).toBe(true);
  });

  it('rejects artifacts whose owned path is not bound to the run ID', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'novelist-native-support-'));
    roots.push(root);
    const runPath = path.join(root, 'other-run.png');
    await writeFile(runPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    await expect(prepareRunArtifact('t24-owner', 100, runPath)).rejects.toThrow('not bound to run ID');
  });

  it('prevents an older overlapping run from publishing or clearing newer evidence', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'novelist-native-support-'));
    roots.push(root);
    const sharedPath = path.join(root, 'shared.png');
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const olderPath = path.join(root, 'artifact-run-older.png');
    const newerPath = path.join(root, 'artifact-run-newer.png');
    const olderBytes = Buffer.concat([signature, Buffer.from('older')]);
    const newerBytes = Buffer.concat([signature, Buffer.from('newer')]);
    await writeFile(olderPath, olderBytes);
    await writeFile(newerPath, newerBytes);
    const older = await prepareRunArtifact('run-older', 100, olderPath);
    const newer = await prepareRunArtifact('run-newer', 200, newerPath);

    await Promise.all([invalidateSharedArtifact(older, sharedPath), invalidateSharedArtifact(newer, sharedPath)]);
    expect(JSON.parse(await readFile(`${sharedPath}.owner.json`, 'utf8'))).toEqual({
      runId: 'run-newer',
      startedAtMs: 200,
    });

    const [newerPublication, olderPublication] = await Promise.all([
      publishPreparedArtifact(newer, sharedPath),
      publishPreparedArtifact(older, sharedPath),
    ]);
    expect(newerPublication.published).toBe(true);
    expect(olderPublication.published).toBe(false);

    await expect(invalidateSharedArtifact(older, sharedPath)).resolves.toEqual({
      runId: 'run-older',
      startedAtMs: 100,
      owned: false,
    });

    expect(await readFile(sharedPath)).toEqual(newerBytes);
    expect(JSON.parse(await readFile(`${sharedPath}.metadata.json`, 'utf8'))).toMatchObject({
      runId: 'run-newer',
      startedAtMs: 200,
      sha256: createHash('sha256').update(newerBytes).digest('hex'),
    });
  });

  it('claims owned evidence before Playwright and invalidates failed ownership after reporting', async () => {
    const runner = await readFile('tests/e2e/native/run-native-smoke.mjs', 'utf8');
    const ownershipCalls = [
      ...runner.matchAll(/await invalidateSharedArtifact\(\{ runId, startedAtMs \}, sharedScreenshotPath\)/g),
    ].map((match) => match.index);

    expect(ownershipCalls).toHaveLength(2);
    expect(ownershipCalls[0]).toBeLessThan(runner.indexOf('const child = spawn('));
    expect(runner.slice(ownershipCalls[0] - 180, ownershipCalls[0])).toContain('if (scenarioPolicy.acceptanceOwner)');
    expect(ownershipCalls[1]).toBeGreaterThan(runner.lastIndexOf('await appendEvidence('));
    expect(runner.slice(ownershipCalls[1] - 220, ownershipCalls[1])).toContain('!evidencePublicationAttempted');
    expect(runner.slice(ownershipCalls[1] - 220, ownershipCalls[1])).toContain('scenarioPolicy.acceptanceOwner');
  });

  it('gates native screenshot ownership and publication with the scenario policy', async () => {
    const runner = await readFile('tests/e2e/native/run-native-smoke.mjs', 'utf8');
    const policy = runner.indexOf('const scenarioPolicy = nativeScenarioPolicy(nativeMode, testGrep);');
    const initialOwnership = runner.indexOf(
      'await invalidateSharedArtifact({ runId, startedAtMs }, sharedScreenshotPath);',
    );

    expect(policy).toBeGreaterThan(-1);
    expect(policy).toBeLessThan(initialOwnership);
    expect(runner).toContain('if (scenarioPolicy.acceptanceOwner) {');
    expect(runner).toContain('NOVELIST_NATIVE_ARTIFACT: scenarioPolicy.artifact');
    expect(runner).toContain("scenarioPolicy.artifact === 'required'");
    expect(runner).toContain("reason: 'not_required'");
  });

  it('holds one exclusive native wrapper lock across setup and final evidence teardown', async () => {
    const runner = await readFile('tests/e2e/native/run-native-smoke.mjs', 'utf8');
    const acquisition = runner.indexOf('const nativeRunLock = await acquireNativeRunLock(');
    const runRootAllocation = runner.indexOf('await mkdtemp(');
    const sharedOwnership = runner.indexOf('await invalidateSharedArtifact(');
    const finalEvidence = runner.lastIndexOf('await appendEvidence(');
    const release = runner.lastIndexOf('await releaseNativeRunLock(nativeRunLock);');

    expect(acquisition).toBeGreaterThan(-1);
    expect(acquisition).toBeLessThan(runRootAllocation);
    expect(acquisition).toBeLessThan(sharedOwnership);
    expect(release).toBeGreaterThan(finalEvidence);
    expect(runner).toContain('resolveNativeRunLockPort(process.env.NOVELIST_NATIVE_RUN_LOCK_PORT)');
    expect(runner).not.toContain('NOVELIST_NATIVE_RUN_LOCK_OVERRIDE');
  });

  it('uses the validated run-owned inventory and verifies cleanup plus lock listener release', async () => {
    const runner = await readFile('tests/e2e/native/run-native-smoke.mjs', 'utf8');
    expect(runner).toContain('const runOwnedPaths = buildRunOwnedPathInventory({');
    expect(runner).toContain('runOwnedPathResidue(runOwnedPaths, existsSync)');
    expect(runner).toContain('runOwnedPathResidue({ evidence: runEvidencePath }, existsSync)');
    expect(runner).toContain('nativeRunLock.listener.listening');
  });

  it('validates screenshot crop containment before invoking cropped native metrics', async () => {
    const lifecycle = await readFile('tests/e2e/native/specs/native-lifecycle.spec.ts', 'utf8');
    const validation = lifecycle.indexOf('computeContainedScreenshotCrop(');
    const croppedMetrics = lifecycle.indexOf('const coverMetrics = await imageMetrics([');

    expect(validation).toBeGreaterThan(-1);
    expect(croppedMetrics).toBeGreaterThan(validation);
  });

  it('does not let the Swift metrics helper silently intersect an invalid crop', async () => {
    const helper = await readFile('tests/e2e/native/macos-pasteboard.swift', 'utf8');
    expect(helper).not.toContain('.intersection(imageBounds)');
    expect(helper).toContain('requestedBounds');
    expect(helper).toContain('crop rectangle is outside image bounds');
  });

  it('samples screenshot crop coordinates without a second vertical flip', async () => {
    const helper = await readFile('tests/e2e/native/macos-pasteboard.swift', 'utf8');
    expect(helper).toContain('bitmap.colorAt(x: x, y: topY)');
    expect(helper).not.toContain('bitmap.pixelsHigh - 1 - topY');
  });

  it('keeps live native reports outside Vite watch and skips non-required capture', async () => {
    const [runner, config, fixture, lifecycle] = await Promise.all([
      readFile('tests/e2e/native/run-native-smoke.mjs', 'utf8'),
      readFile('playwright.tauri.config.ts', 'utf8'),
      readFile('tests/e2e/native/fixtures/native-app.ts', 'utf8'),
      readFile('tests/e2e/native/specs/native-lifecycle.spec.ts', 'utf8'),
    ]);

    const childExit = runner.indexOf('childResult = await childResultPromise;');
    const sharedEvidencePublication = runner.indexOf(
      'await appendFile(sharedEvidencePath, await readFile(runEvidencePath));',
    );
    expect(runner).toContain('const runEvidencePath = path.join(tmpdir()');
    expect(runner).toContain('NOVELIST_NATIVE_EVIDENCE: runEvidencePath');
    expect(runner).toContain("const playwrightOutputPath = path.join(runRoot, 'playwright-output')");
    expect(runner).toContain('NOVELIST_NATIVE_PLAYWRIGHT_OUTPUT: playwrightOutputPath');
    expect(childExit).toBeGreaterThan(-1);
    expect(sharedEvidencePublication).toBeGreaterThan(childExit);
    expect(config).toContain("process.env['NOVELIST_NATIVE_PLAYWRIGHT_OUTPUT']");
    expect(fixture).toContain("artifactRequirement: requiredArtifactRequirement('NOVELIST_NATIVE_ARTIFACT')");
    expect(lifecycle).toContain("if (nativeEnv.artifactRequirement === 'not_required')");
    const nonRequiredCapture = lifecycle.indexOf("if (nativeEnv.artifactRequirement === 'not_required')");
    const snapshotStage = lifecycle.search(/runNativeStage\(\s*'snapshot'/);
    expect(snapshotStage).toBeGreaterThan(-1);
    expect(nonRequiredCapture).toBeLessThan(snapshotStage);
  });

  it('propagates inaccessible cleanup-root enumeration failures', async () => {
    const denied = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    await expect(
      scanResidueRoots(['/denied'], ['needle'], async () => {
        throw denied;
      }),
    ).rejects.toBe(denied);
  });

  it('treats a missing cleanup root as empty', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    await expect(
      scanResidueRoots(['/missing'], ['needle'], async () => {
        throw missing;
      }),
    ).resolves.toEqual([]);
  });
});
