import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, platform, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  acquireNativeRunLock,
  awaitInteractiveEvidence,
  buildRunOwnedPathInventory,
  invalidateSharedArtifact,
  nativeScenarioPolicy,
  pickEnvironment,
  prepareRunArtifact,
  publicationAllowed,
  publishPreparedArtifactTransaction,
  releaseNativeRunLock,
  resolveNativeRunLockPort,
  runOwnedPathResidue,
  scanResidueRoots,
  strictInteractiveEnvironmentValue,
  waitForPlaywrightChild,
  NATIVE_FIXTURE_TEARDOWN_TIMEOUT_MS,
  NATIVE_FIXTURE_TIMEOUT_MS,
  NATIVE_WORKFLOW_TIMEOUT_MS,
  PLAYWRIGHT_CHILD_KILL_GRACE_MS,
  PLAYWRIGHT_CHILD_REPORT_EXIT_BUFFER_MS,
  PLAYWRIGHT_CHILD_TERM_GRACE_MS,
  PLAYWRIGHT_CHILD_TIMEOUT_MS,
} from './native-run-support.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const userHome = homedir();
const sharedEvidencePath =
  process.env.NOVELIST_NATIVE_EVIDENCE_OVERRIDE ??
  path.join(rootDir, '.sisyphus/evidence/task-24-native-lifecycle.txt');
const sharedScreenshotPath =
  process.env.NOVELIST_NATIVE_SCREENSHOT_OVERRIDE ??
  path.join(rootDir, '.sisyphus/evidence/task-24-native-clipboard.png');
const pasteboardSource = path.join(rootDir, 'tests/e2e/native/macos-pasteboard.swift');
const supervisorSource = path.join(rootDir, 'tests/e2e/native/macos-app-supervisor.swift');
const supervisorPolicySource = path.join(rootDir, 'tests/e2e/native/macos-supervisor-policy.swift');
const startedAtMs = Date.now();
const runId = `t24${startedAtMs}${randomBytes(4).toString('hex')}`;
const runEvidencePath = path.join(tmpdir(), `novelist-task24-native-evidence-${runId}.txt`);
const nativeMode = process.env.NOVELIST_NATIVE_MODE ?? 'visual';
const testGrep = process.env.NOVELIST_NATIVE_TEST_GREP ?? 'real WKWebView native clipboard';
const scenarioPolicy = nativeScenarioPolicy(nativeMode, testGrep);
const identifier = `com.novelist.e2e.${runId}`;
const nativeRunLockPort = resolveNativeRunLockPort(process.env.NOVELIST_NATIVE_RUN_LOCK_PORT);
if (platform() !== 'darwin') {
  throw new Error(`Task 24 native smoke requires macOS; platform=${platform()}`);
}
const nativeRunLock = await acquireNativeRunLock(nativeRunLockPort, {
  pid: process.pid,
  runId,
  startedAtMs,
});

try {
  const allocatedRunRoot = await mkdtemp(path.join(tmpdir(), `novelist-task24-${runId}-`));
  const runRoot = await realpath(allocatedRunRoot);
  const projectDir = path.join(runRoot, '小说 项目');
  const homeDir = path.join(runRoot, 'home');
  const tempDir = path.join(runRoot, 'tmp');
  const socketPath = path.join('/tmp', `novelist-t24-${runId}.sock`);
  const tauriConfigPath = path.join(runRoot, 'tauri.e2e.conf.json');
  const clipboardSnapshotPath = path.join(runRoot, 'pasteboard.json');
  const clipboardHelperPath = path.join(runRoot, 'pasteboard-helper');
  const supervisorPath = path.join(runRoot, 'app-supervisor');
  const bundlePath = path.join(runRoot, `Novelist E2E ${runId}.app`);
  const pngPath = path.join(runRoot, 'cover.png');
  const screenshotPath = path.join(runRoot, `task-24-native-clipboard-${runId}.png`);
  const tauriLogPath = path.join(runRoot, 'tauri.log');
  const ownerPath = path.join(runRoot, '.novelist-task24-owner');
  const initialFilePath = path.join(projectDir, '甲 初稿.md');
  const playwrightOutputPath = path.join(runRoot, 'playwright-output');
  const runOwnedPaths = buildRunOwnedPathInventory({
    socket: socketPath,
    runRoot: runRoot,
    project: projectDir,
    home: homeDir,
    temp: tempDir,
    config: tauriConfigPath,
    clipboardSnapshot: clipboardSnapshotPath,
    pasteboardHelper: clipboardHelperPath,
    supervisor: supervisorPath,
    bundle: bundlePath,
    png: pngPath,
    screenshot: screenshotPath,
    tauriLog: tauriLogPath,
    owner: ownerPath,
    initialFile: initialFilePath,
    playwrightOutput: playwrightOutputPath,
  });
  let clipboardBefore = '';
  let snapshotTaken = false;
  let clipboardRestored = false;
  let childExitCode = 1;
  let childExitReason = 'Playwright child did not start';
  let interactiveInstructionTimer;
  let interactiveEvidencePromise;
  const interactiveEnvironment = strictInteractiveEnvironmentValue(process.env.NOVELIST_NATIVE_INTERACTIVE);

  function makeRedPng() {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      return value >>> 0;
    });
    const crc32 = (buffer) => {
      let crc = 0xffffffff;
      for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
      return (crc ^ 0xffffffff) >>> 0;
    };
    const u32 = (value) =>
      Buffer.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
    const chunk = (type, data) => {
      const body = Buffer.concat([Buffer.from(type), data]);
      return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
    };
    const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    const idat = Buffer.from([
      0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, 0x00, 0xff, 0x00, 0x00, 0xff, 0x05, 0x00, 0x01, 0xff,
    ]);
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', idat),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }

  async function allocatePort() {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.unref();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('failed to allocate native Vite port'));
          return;
        }
        const port = address.port;
        server.close((error) => (error ? reject(error) : resolve(port)));
      });
    });
  }

  function runHelper(command, argument) {
    return execFileSync(clipboardHelperPath, argument ? [command, argument] : [command], { encoding: 'utf8' }).trim();
  }

  function processRows() {
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
    });
    return output.split('\n').flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
    });
  }

  function runScopedProcesses() {
    const markers = [runRoot, projectDir, socketPath, identifier];
    return processRows().filter(
      (row) => row.pid !== process.pid && markers.some((marker) => row.command.includes(marker)),
    );
  }

  function pidExists(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function waitForPidsToExit(pids, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pids.every((pid) => !pidExists(pid))) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return pids.every((pid) => !pidExists(pid));
  }

  async function terminateRunProcesses(rows) {
    const pids = [...new Set(rows.map((row) => row.pid))];
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    if (await waitForPidsToExit(pids, 3_000)) return;
    for (const pid of pids) {
      if (!pidExists(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    if (!(await waitForPidsToExit(pids, 3_000))) {
      throw new Error(`run-scoped processes survived teardown: ${JSON.stringify(runScopedProcesses())}`);
    }
  }

  async function libraryResidue() {
    const roots = [
      path.join(userHome, 'Library/Application Support'),
      path.join(userHome, 'Library/Caches'),
      path.join(userHome, 'Library/HTTPStorages'),
      path.join(userHome, 'Library/Saved Application State'),
      path.join(userHome, 'Library/WebKit'),
    ];
    const needles = [runId.toLowerCase(), identifier.toLowerCase()];
    return scanResidueRoots(roots, needles);
  }

  async function appendEvidence(lines) {
    await appendFile(runEvidencePath, `${lines.join('\n')}\n`, 'utf8');
  }

  try {
    if (scenarioPolicy.acceptanceOwner) {
      await invalidateSharedArtifact({ runId, startedAtMs }, sharedScreenshotPath);
    }
    const port = await allocatePort();
    const devUrl = `http://127.0.0.1:${port}`;
    await mkdir(projectDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await mkdir(tempDir, { recursive: true });
    await writeFile(ownerPath, `${runId}\n`, 'utf8');
    await writeFile(initialFilePath, '# 甲 初稿\n初始原生内容。\n', 'utf8');
    await writeFile(pngPath, makeRedPng());
    await writeFile(
      tauriConfigPath,
      JSON.stringify(
        {
          productName: `Novelist E2E ${runId}`,
          identifier,
          build: {
            beforeDevCommand: `pnpm dev --host 127.0.0.1 --port ${port} --strictPort`,
            devUrl,
          },
          app: {
            security: {
              capabilities: [
                'default',
                {
                  identifier: `playwright-${runId}`,
                  description: 'Run-scoped permission for the native Playwright result bridge.',
                  windows: ['main'],
                  permissions: ['playwright:allow-pw-result'],
                },
              ],
            },
            windows: [
              {
                label: 'main',
                title: `Novelist E2E ${runId}`,
                width: 1200,
                height: 800,
                decorations: true,
                titleBarStyle: 'Overlay',
                hiddenTitle: true,
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    if (existsSync(socketPath)) throw new Error(`refusing stale native socket: ${socketPath}`);

    execFileSync('/usr/bin/swiftc', ['-o', clipboardHelperPath, pasteboardSource], { stdio: 'inherit' });
    execFileSync(
      '/usr/bin/swiftc',
      ['-parse-as-library', '-o', supervisorPath, supervisorPolicySource, supervisorSource],
      { stdio: 'inherit' },
    );
    clipboardBefore = runHelper('snapshot', clipboardSnapshotPath);
    snapshotTaken = true;
    await appendEvidence([
      `=== Task 24 native run ${runId} ===`,
      'command=pnpm test:e2e:tauri',
      `platform=${platform()} ${process.arch}`,
      'red_baseline=Project(s) "tauri" not found; available projects: webkit, chromium; exit=1',
      'backend=real Rust commands (no browser IPC mock)',
      'webview=macOS WKWebView via @srsholmes/tauri-playwright 0.2.2',
      'binary_command=node_modules/.bin/tauri dev --no-watch --features e2e-testing --config <run-config> -- -- <temp-project>',
      'initial_project_route=CLI argv pending-project queue',
      `run_root=${runRoot}`,
      `project=${projectDir}`,
      `home_cache_namespace=${homeDir}`,
      `bundle_identifier=${identifier}`,
      `dev_url=${devUrl}`,
      `socket=${socketPath}`,
      `native_run_mutex=${nativeRunLock.host}:${nativeRunLock.port}`,
      `clipboard_before_sha256=${clipboardBefore}`,
      `shared_evidence_publish_target=${sharedEvidencePath}`,
      `shared_artifact_publish_target=${sharedScreenshotPath}`,
      `run_artifact_path=${screenshotPath}`,
      `native_scenario=${scenarioPolicy.scenario}`,
      `artifact=${scenarioPolicy.artifact}`,
      `artifact_acceptance_owner=${scenarioPolicy.acceptanceOwner}`,
      `native_interactive=${interactiveEnvironment === '1'}`,
      `native_fixture_timeout_ms=${NATIVE_FIXTURE_TIMEOUT_MS}`,
      `native_workflow_timeout_ms=${NATIVE_WORKFLOW_TIMEOUT_MS}`,
      `native_fixture_teardown_timeout_ms=${NATIVE_FIXTURE_TEARDOWN_TIMEOUT_MS}`,
      `playwright_child_report_exit_buffer_ms=${PLAYWRIGHT_CHILD_REPORT_EXIT_BUFFER_MS}`,
      `playwright_child_watchdog_timeout_ms=${PLAYWRIGHT_CHILD_TIMEOUT_MS}`,
      `playwright_child_term_grace_ms=${PLAYWRIGHT_CHILD_TERM_GRACE_MS}`,
      `playwright_child_kill_grace_ms=${PLAYWRIGHT_CHILD_KILL_GRACE_MS}`,
    ]);

    const inheritedEnvironment = pickEnvironment(process.env, [
      'PATH',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'USER',
      'LOGNAME',
      'SHELL',
      'TERM',
      'COLORTERM',
      'CI',
      'CARGO_HOME',
      'RUSTUP_HOME',
      'CARGO_TARGET_DIR',
      'RUSTFLAGS',
      'DEVELOPER_DIR',
      'SDKROOT',
      'CC',
      'CXX',
      'MACOSX_DEPLOYMENT_TARGET',
      'NO_COLOR',
      'FORCE_COLOR',
    ]);
    const playwrightArgs = ['exec', 'playwright', 'test', '--config', 'playwright.tauri.config.ts', '--project=tauri'];
    playwrightArgs.push('--grep', testGrep);
    const child = spawn('pnpm', playwrightArgs, {
      cwd: rootDir,
      env: {
        ...inheritedEnvironment,
        HOME: homeDir,
        CARGO_HOME: process.env.CARGO_HOME ?? path.join(userHome, '.cargo'),
        RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(userHome, '.rustup'),
        TMPDIR: tempDir,
        XDG_CACHE_HOME: path.join(homeDir, '.cache'),
        XDG_CONFIG_HOME: path.join(homeDir, '.config'),
        XDG_DATA_HOME: path.join(homeDir, '.local/share'),
        NOVELIST_NATIVE_ROOT_DIR: rootDir,
        NOVELIST_NATIVE_RUN_ID: runId,
        NOVELIST_NATIVE_RUN_ROOT: runRoot,
        NOVELIST_NATIVE_IDENTIFIER: identifier,
        NOVELIST_NATIVE_BUNDLE: bundlePath,
        NOVELIST_NATIVE_SUPERVISOR: supervisorPath,
        NOVELIST_NATIVE_PROJECT_DIR: projectDir,
        NOVELIST_NATIVE_INITIAL_FILE: initialFilePath,
        NOVELIST_NATIVE_SOCKET: socketPath,
        NOVELIST_NATIVE_DEV_URL: devUrl,
        NOVELIST_NATIVE_TAURI_CONFIG: tauriConfigPath,
        NOVELIST_NATIVE_CLIPBOARD_HELPER: clipboardHelperPath,
        NOVELIST_NATIVE_PNG: pngPath,
        NOVELIST_NATIVE_TAURI_LOG: tauriLogPath,
        NOVELIST_NATIVE_EVIDENCE: runEvidencePath,
        NOVELIST_NATIVE_PLAYWRIGHT_OUTPUT: playwrightOutputPath,
        NOVELIST_NATIVE_SCREENSHOT: screenshotPath,
        NOVELIST_NATIVE_MODE: nativeMode,
        NOVELIST_NATIVE_ARTIFACT: scenarioPolicy.artifact,
        ...(interactiveEnvironment
          ? {
              NOVELIST_NATIVE_INTERACTIVE: interactiveEnvironment,
            }
          : {}),
        TAURI_PLAYWRIGHT_SOCKET: socketPath,
      },
      detached: true,
      stdio: 'inherit',
    });
    const childResultPromise = waitForPlaywrightChild(child);
    if (interactiveEnvironment) {
      const appExecutable = path.join(bundlePath, 'Contents/MacOS/NovelistE2E');
      interactiveInstructionTimer = setInterval(() => {
        try {
          const application = runScopedProcesses().find((row) => row.command.includes(appExecutable));
          if (!application) return;
          const appDisplayName = path.basename(bundlePath);
          const lines = [
            'native_interactive_activation=waiting timeout_seconds=120',
            `native_interactive_run_id=${runId}`,
            `native_interactive_app=${appDisplayName}`,
            `native_interactive_pid=${application.pid}`,
            `native_interactive_instruction=Click or activate '${appDisplayName}' in macOS within 120 seconds.`,
          ];
          process.stdout.write(`${lines.join('\n')}\n`);
          interactiveEvidencePromise = appendEvidence(lines);
          interactiveEvidencePromise.catch(() => {});
          clearInterval(interactiveInstructionTimer);
          interactiveInstructionTimer = undefined;
        } catch {
          // The next bounded poll retries while the run-scoped app is launching.
        }
      }, 250);
    }
    const forwardSignal = () => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ESRCH') return;
        process.stderr.write(
          `failed to signal Playwright process group: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    };
    process.once('SIGINT', forwardSignal);
    process.once('SIGTERM', forwardSignal);
    let childResult;
    try {
      childResult = await childResultPromise;
    } finally {
      process.off('SIGINT', forwardSignal);
      process.off('SIGTERM', forwardSignal);
    }
    childExitCode = childResult.exitCode;
    childExitReason = childResult.reason;
  } finally {
    if (interactiveInstructionTimer) clearInterval(interactiveInstructionTimer);
    const cleanupErrors = [];
    await awaitInteractiveEvidence(interactiveEvidencePromise, cleanupErrors);
    const cleanupNotes = [];
    let preparedArtifact = null;
    try {
      if (existsSync(tauriLogPath)) {
        const tauriLog = await readFile(tauriLogPath, 'utf8');
        await appendEvidence(['tauri_log_begin', tauriLog.trimEnd(), 'tauri_log_end']);
      }
    } catch (error) {
      cleanupErrors.push(`tauri log: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const rows = runScopedProcesses();
      if (rows.length > 0) cleanupNotes.push(`forced_process_cleanup=${JSON.stringify(rows)}`);
      await terminateRunProcesses(rows);
      const survivors = runScopedProcesses();
      if (survivors.length > 0) throw new Error(JSON.stringify(survivors));
      cleanupNotes.push('process_residue=[]');
    } catch (error) {
      cleanupErrors.push(`processes: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (scenarioPolicy.artifact === 'required' && childExitCode === 0) {
      try {
        preparedArtifact = await prepareRunArtifact(runId, startedAtMs, screenshotPath);
      } catch (error) {
        cleanupErrors.push(`artifact preparation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const residue = await libraryResidue();
      for (const item of residue) await rm(item, { recursive: true, force: true });
      const remaining = await libraryResidue();
      if (remaining.length > 0) throw new Error(JSON.stringify(remaining));
      cleanupNotes.push(`app_library_residue=[] removed=${JSON.stringify(residue)}`);
    } catch (error) {
      cleanupErrors.push(`app cache/state: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (snapshotTaken) {
      try {
        const after = runHelper('restore', clipboardSnapshotPath);
        clipboardRestored = after === clipboardBefore;
        if (!clipboardRestored) {
          throw new Error(`clipboard fingerprint mismatch: before=${clipboardBefore} after=${after}`);
        }
        cleanupNotes.push(`clipboard_restored_sha256=${after}`);
      } catch (error) {
        cleanupErrors.push(`clipboard: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      if (existsSync(socketPath)) await rm(socketPath, { force: true });
      if (existsSync(runRoot)) {
        const owner = (await readFile(ownerPath, 'utf8')).trim();
        if (owner !== runId) throw new Error(`ownership marker mismatch: ${owner}`);
        await rm(runRoot, { recursive: true, force: true });
      }
      const residue = runOwnedPathResidue(runOwnedPaths, existsSync);
      if (Object.values(residue).some(Boolean)) throw new Error(JSON.stringify(residue));
      cleanupNotes.push(`filesystem_residue=${JSON.stringify(residue)}`);
    } catch (error) {
      cleanupErrors.push(`filesystem: ${error instanceof Error ? error.message : String(error)}`);
    }

    const appendFinalRunEvidence = () =>
      appendEvidence([
        ...cleanupNotes,
        `clipboard_restored=${clipboardRestored}`,
        `playwright_exit=${childExitCode}`,
        `playwright_exit_reason=${JSON.stringify(childExitReason)}`,
        `cleanup_errors=${JSON.stringify(cleanupErrors)}`,
        `run_result=${childExitCode === 0 && cleanupErrors.length === 0 ? 'PASS' : 'FAIL'}`,
      ]);
    let evidencePublicationAttempted = false;
    if (preparedArtifact && scenarioPolicy.acceptanceOwner && publicationAllowed(childExitCode, cleanupErrors)) {
      try {
        await publishPreparedArtifactTransaction(preparedArtifact, sharedScreenshotPath, async (artifact) => {
          cleanupNotes.push(`artifact_provenance=${JSON.stringify(artifact)}`);
          evidencePublicationAttempted = true;
          await appendFinalRunEvidence();
          await mkdir(path.dirname(sharedEvidencePath), { recursive: true });
          await appendFile(sharedEvidencePath, await readFile(runEvidencePath));
        });
      } catch (error) {
        cleanupErrors.push(`artifact/evidence publication: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (scenarioPolicy.artifact === 'not_required') {
      cleanupNotes.push(
        `artifact_provenance=${JSON.stringify({
          fresh: false,
          runId,
          sha256: null,
          bytes: 0,
          published: false,
          reason: 'not_required',
        })}`,
      );
    } else {
      cleanupNotes.push(
        `artifact_provenance=${JSON.stringify({
          fresh: false,
          runId,
          sha256: preparedArtifact?.sha256 ?? null,
          bytes: preparedArtifact?.bytes.length ?? 0,
          published: false,
          reason: childExitCode !== 0 ? 'playwright_failed' : 'cleanup_failed',
        })}`,
      );
    }

    if (!evidencePublicationAttempted) {
      await appendFinalRunEvidence().catch((error) => cleanupErrors.push(`evidence: ${error.message}`));
    }

    if (
      !evidencePublicationAttempted &&
      scenarioPolicy.acceptanceOwner &&
      !publicationAllowed(childExitCode, cleanupErrors)
    ) {
      try {
        await invalidateSharedArtifact({ runId, startedAtMs }, sharedScreenshotPath);
      } catch (error) {
        cleanupErrors.push(`artifact invalidation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!evidencePublicationAttempted) {
      try {
        await mkdir(path.dirname(sharedEvidencePath), { recursive: true });
        await appendFile(sharedEvidencePath, await readFile(runEvidencePath));
      } catch (error) {
        cleanupErrors.push(`evidence publication: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new Error(`Task 24 teardown failed: ${cleanupErrors.join('; ')}`);
    }
  }

  if (childExitCode !== 0) process.exitCode = childExitCode;
} finally {
  try {
    await rm(runEvidencePath, { force: true });
    const residue = runOwnedPathResidue({ evidence: runEvidencePath }, existsSync);
    if (Object.values(residue).some(Boolean)) {
      throw new Error(`run-owned output survived teardown: ${JSON.stringify(residue)}`);
    }
  } finally {
    await releaseNativeRunLock(nativeRunLock);
    if (nativeRunLock.listener.listening) {
      throw new Error(`native run lock listener survived teardown: ${nativeRunLock.host}:${nativeRunLock.port}`);
    }
  }
}
