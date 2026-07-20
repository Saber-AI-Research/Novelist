// @ts-nocheck -- Vitest runs this Node-only harness test outside the app browser type environment.
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const launcher = path.resolve('tests/e2e/native/launch-tauri.sh');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native Tauri launcher', () => {
  it('executes the local Tauri CLI directly without package-script dotenv rehydration', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'novelist-native-launcher-'));
    roots.push(root);
    const binDir = path.join(root, 'node_modules/.bin');
    const fakePath = path.join(root, 'fake-bin');
    const outputPath = path.join(root, 'output.txt');
    const logPath = path.join(root, 'tauri.log');
    await mkdir(binDir, { recursive: true });
    await mkdir(fakePath, { recursive: true });
    await writeFile(path.join(root, '.env'), 'F2_PRIVATE_SECRET=rehydrated\n');
    await writeFile(path.join(binDir, 'tauri'), `#!/bin/bash\nprintf 'secret=%s args=%s\\n' "\${F2_PRIVATE_SECRET-unset}" "$*" > "${outputPath}"\n`);
    await chmod(path.join(binDir, 'tauri'), 0o755);
    await writeFile(path.join(fakePath, 'pnpm'), '#!/bin/bash\nexit 99\n');
    await chmod(path.join(fakePath, 'pnpm'), 0o755);

    await execFileAsync('/bin/bash', [launcher, 'dev', '--no-watch'], {
      cwd: root,
      env: {
        PATH: `${fakePath}:/bin:/usr/bin`,
        NOVELIST_NATIVE_ROOT_DIR: root,
        NOVELIST_NATIVE_TAURI_LOG: logPath,
      },
    });

    expect(await readFile(outputPath, 'utf8')).toBe('secret=unset args=dev --no-watch\n');
  });
});
