// @ts-nocheck -- Vitest runs this Node-only harness test outside the app browser type environment.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const swiftc = '/usr/bin/swiftc';

describe.skipIf(process.platform !== 'darwin' || !existsSync(swiftc))('macOS native supervisor policy', () => {
  it('passes the Swift supervisor policy assertions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'novelist-supervisor-policy-'));
    try {
      const binary = path.join(root, 'supervisor-policy-test');
      await execFileAsync(swiftc, [
        '-parse-as-library',
        '-o',
        binary,
        'tests/e2e/native/macos-supervisor-policy.swift',
        'tests/e2e/native/macos-supervisor-policy-test.swift',
      ]);
      const { stdout } = await execFileAsync(binary, [], { encoding: 'utf8' });
      expect(stdout.trim()).toBe('macos-supervisor-policy-pass');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
