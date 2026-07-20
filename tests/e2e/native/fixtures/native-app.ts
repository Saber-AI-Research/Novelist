import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test as base } from '@playwright/test';
import {
  PluginClient,
  TauriPage,
  TauriProcessManager,
} from '@srsholmes/tauri-playwright';

import {
  NATIVE_FIXTURE_TEARDOWN_TIMEOUT_MS,
  NATIVE_FIXTURE_TIMEOUT_MS,
  NATIVE_WORKFLOW_TIMEOUT_MS,
  runNativeStage,
} from '../native-timeouts';

const execFileAsync = promisify(execFile);

export const nativeEnv = {
  rootDir: requiredEnv('NOVELIST_NATIVE_ROOT_DIR'),
  runRoot: requiredEnv('NOVELIST_NATIVE_RUN_ROOT'),
  bundlePath: requiredEnv('NOVELIST_NATIVE_BUNDLE'),
  projectDir: requiredEnv('NOVELIST_NATIVE_PROJECT_DIR'),
  socketPath: requiredEnv('NOVELIST_NATIVE_SOCKET'),
  configPath: requiredEnv('NOVELIST_NATIVE_TAURI_CONFIG'),
  clipboardHelper: requiredEnv('NOVELIST_NATIVE_CLIPBOARD_HELPER'),
  pngPath: requiredEnv('NOVELIST_NATIVE_PNG'),
  evidencePath: requiredEnv('NOVELIST_NATIVE_EVIDENCE'),
  screenshotPath: requiredEnv('NOVELIST_NATIVE_SCREENSHOT'),
  artifactRequirement: requiredArtifactRequirement('NOVELIST_NATIVE_ARTIFACT'),
  tauriLogPath: requiredEnv('NOVELIST_NATIVE_TAURI_LOG'),
};

export interface NativeApp {
  page: TauriPage;
  command<T>(name: string, args?: unknown[]): Promise<T>;
  log(...lines: string[]): Promise<void>;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required native test environment: ${name}`);
  return value;
}

function requiredArtifactRequirement(name: string): 'required' | 'not_required' {
  const value = requiredEnv(name);
  if (value !== 'required' && value !== 'not_required') {
    throw new Error(`invalid native artifact requirement: ${value}`);
  }
  return value;
}

async function appCommand<T>(page: TauriPage, name: string, args: unknown[] = []): Promise<T> {
  return page.evaluate<T>(`(async () => {
    const module = await import('/app/lib/ipc/commands.ts');
    const fn = module.commands[${JSON.stringify(name)}];
    if (typeof fn !== 'function') throw new Error('unknown app command: ' + ${JSON.stringify(name)});
    const result = await fn(...${JSON.stringify(args)});
    if (result && result.status === 'error') throw new Error(result.error);
    return result && result.status === 'ok' ? result.data : result;
  })()`);
}

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

async function processTree(rootPid: number): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,command=']);
  const rows = stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
  const pids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!pids.has(row.ppid) || pids.has(row.pid)) continue;
      pids.add(row.pid);
      changed = true;
    }
  }
  return rows.filter((row) => pids.has(row.pid));
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(rows: ProcessRow[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (rows.every((row) => !pidExists(row.pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return rows.every((row) => !pidExists(row.pid));
}

async function stopManager(manager: TauriProcessManager): Promise<ProcessRow[]> {
  const child = Reflect.get(manager, 'process') as { pid?: number } | null;
  const tree = child?.pid ? await processTree(child.pid) : [];
  manager.stop();
  if (!(await waitForExit(tree, 5_000))) {
    for (const row of [...tree].reverse()) {
      if (!pidExists(row.pid)) continue;
      try { process.kill(row.pid, 'SIGTERM'); } catch {}
    }
  }
  if (!(await waitForExit(tree, 12_000))) {
    for (const row of [...tree].reverse()) {
      if (!pidExists(row.pid)) continue;
      try { process.kill(row.pid, 'SIGKILL'); } catch {}
    }
  }
  const survivors = tree.filter((row) => pidExists(row.pid));
  if (survivors.length > 0) {
    throw new Error(`native child process residue: ${JSON.stringify(survivors)}`);
  }
  return tree;
}

export const test = base.extend<{ nativeApp: NativeApp }>({
  nativeApp: [async ({}, use, testInfo) => {
    expect(existsSync(nativeEnv.socketPath), 'native socket must be unique and absent before launch').toBe(false);
    const log = async (...lines: string[]) => {
      await appendFile(nativeEnv.evidencePath, `${lines.join('\n')}\n`, 'utf8');
    };
    const manager = new TauriProcessManager({
      command: '/bin/bash',
      args: [
        path.join(nativeEnv.rootDir, 'tests/e2e/native/launch-tauri.sh'),
        'dev',
        '--runner',
        path.join(nativeEnv.rootDir, 'tests/e2e/native/e2e-runner.sh'),
        '--no-watch',
        '--features',
        'e2e-testing',
        '--config',
        nativeEnv.configPath,
        '--',
        '--',
        nativeEnv.projectDir,
      ],
      cwd: nativeEnv.rootDir,
      socketPath: nativeEnv.socketPath,
      startTimeout: 360,
    });
    let client: PluginClient | null = null;
    let teardownError: unknown = null;
    try {
      await runNativeStage('build_bundle_socket', 360_000, () => manager.start(), log);
      client = new PluginClient(nativeEnv.socketPath);
      await runNativeStage('bridge_connect', 15_000, () => client!.connect(), log);
      await runNativeStage('bridge_ping', 10_000, async () => {
        expect((await client!.send({ type: 'ping' })).ok).toBe(true);
      }, log);
      const page = new TauriPage(client);
      page.setDefaultTimeout(10_000);
      const requireVisibleWebKit = process.env.NOVELIST_NATIVE_MODE !== 'nonvisual-behavior';
      const webKitReadiness = requireVisibleWebKit
        ? `document.visibilityState === 'visible' && document.readyState === 'complete' && !!window.__PW_ACTIVE__ && !!window.__TAURI_INTERNALS__ && !!document.querySelector('#app > *')`
        : `document.readyState === 'complete' && !!window.__PW_ACTIVE__ && !!window.__TAURI_INTERNALS__ && !!document.querySelector('#app > *')`;
      await runNativeStage('dom_visibility', 30_000, () => page.waitForFunction(
        webKitReadiness,
        25_000,
      ), log);
      const child = Reflect.get(manager, 'process') as { pid?: number } | null;
      await log(
        `plugin_socket_ready=true socket=${nativeEnv.socketPath}`,
        'plugin_ping=true',
        `binary_pid=${child?.pid ?? 'unknown'}`,
        `window_ready=true url=${await page.url()}`,
      );
      const workflowStartedAt = Date.now();
      await log(
        `native_stage=workflow state=begin timeout_ms=${NATIVE_WORKFLOW_TIMEOUT_MS} at=${new Date(workflowStartedAt).toISOString()}`,
      );
      await use({
        page,
        command: (name, args) => runNativeStage(
          `ipc_${name}`,
          20_000,
          () => appCommand(page, name, args),
          log,
        ),
        log,
      });
      await log(
        `native_stage=workflow state=${testInfo.status === 'passed' ? 'pass' : 'fail'} elapsed_ms=${Date.now() - workflowStartedAt} test_status=${testInfo.status ?? 'unknown'} at=${new Date().toISOString()}`,
      );
    } finally {
      client?.disconnect();
      try {
        const tree = await runNativeStage(
          'teardown_processes',
          NATIVE_FIXTURE_TEARDOWN_TIMEOUT_MS,
          () => stopManager(manager),
          log,
        );
        await appendFile(
          nativeEnv.evidencePath,
          `native_process_tree=${JSON.stringify(tree)}\nnative_process_tree_residue=[]\n`,
          'utf8',
        );
        if (existsSync(nativeEnv.socketPath)) await rm(nativeEnv.socketPath, { force: true });
        if (existsSync(nativeEnv.socketPath)) throw new Error(`socket survived fixture teardown: ${nativeEnv.socketPath}`);
      } catch (error) {
        teardownError = error;
      }
      if (teardownError) throw teardownError;
    }
  }, { timeout: NATIVE_FIXTURE_TIMEOUT_MS }],
});

export { expect };
