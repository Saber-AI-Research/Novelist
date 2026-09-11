import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === 'win32')('[regression] stable Homebrew release gate', () => {
  it('refuses a prerelease before download and preserves the existing stable cask', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'novelist-cask-gate-'));
    temporaryRoots.push(root);
    const bin = path.join(root, 'bin');
    const output = path.join(root, 'tap');
    await mkdir(bin);
    await mkdir(path.join(output, 'Casks'), { recursive: true });
    const cask = path.join(output, 'Casks/novelist.rb');
    await writeFile(cask, 'stable cask bytes\n');
    const gh = path.join(bin, 'gh');
    await writeFile(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'release' && args[1] === 'view') {
  const fields = args[args.indexOf('--json') + 1].split(',');
  process.stdout.write(fields.includes('isPrerelease') ? 'prerelease\\n' : 'false\\n');
} else {
  require('node:fs').writeFileSync(process.env.CASK_DOWNLOAD_MARKER, 'download requested');
  process.exit(92);
}
`);
    await chmod(gh, 0o755);
    const marker = path.join(root, 'download');
    let rejected = false;
    let diagnostic = '';
    try {
      await exec('bash', ['scripts/bump-homebrew-cask.sh', '0.5.0-rc.1', '--out', output], {
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CASK_DOWNLOAD_MARKER: marker },
        timeout: 3_000,
      });
    } catch (error) {
      rejected = true;
      diagnostic = error instanceof Error ? error.message : String(error);
    }
    expect(rejected).toBe(true);
    expect(diagnostic).toContain('only published stable releases');
    expect(await readFile(cask, 'utf8')).toBe('stable cask bytes\n');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
