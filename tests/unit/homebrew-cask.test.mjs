import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const temporaryRoots = [];

// Stands in for the GitHub CLI: `release view` serves the requested fields of a fixture release and
// applies the caller's `-q` expression with real jq, as gh does; `release download` writes fake DMGs.
const GH_STUB = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const release = JSON.parse(fs.readFileSync(process.env.CASK_RELEASE_FIXTURE, 'utf8'));
const tag = args[2] && !args[2].startsWith('-') ? args[2] : release.tagName;
if (tag !== release.tagName) {
  process.stderr.write('release not found: ' + tag + '\\n');
  process.exit(1);
}
if (args[0] === 'release' && args[1] === 'view') {
  const selected = {};
  for (const field of option('--json').split(',')) {
    if (!(field in release)) {
      process.stderr.write('Unknown JSON field: ' + field + '\\n');
      process.exit(1);
    }
    selected[field] = release[field];
  }
  const query = option('-q') ?? option('--jq');
  process.stdout.write(
    query
      ? execFileSync('jq', ['-r', query], { input: JSON.stringify(selected), encoding: 'utf8' })
      : JSON.stringify(selected) + '\\n',
  );
} else if (args[0] === 'release' && args[1] === 'download') {
  fs.appendFileSync(process.env.CASK_DOWNLOAD_MARKER, tag + '\\n');
  args.forEach((arg, index) => {
    if (arg === '--pattern') fs.writeFileSync(path.join(option('--dir'), args[index + 1]), 'dmg:' + args[index + 1]);
  });
} else {
  process.stderr.write('unexpected gh invocation: ' + args.join(' ') + '\\n');
  process.exit(92);
}
`;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function runBump(release, version) {
  const root = await mkdtemp(path.join(tmpdir(), 'novelist-cask-gate-'));
  temporaryRoots.push(root);
  const bin = path.join(root, 'bin');
  const output = path.join(root, 'tap');
  await mkdir(bin);
  await mkdir(path.join(output, 'Casks'), { recursive: true });
  const cask = path.join(output, 'Casks/novelist.rb');
  await writeFile(cask, 'stable cask bytes\n');
  const fixture = path.join(root, 'release.json');
  await writeFile(fixture, JSON.stringify(release));
  const gh = path.join(bin, 'gh');
  await writeFile(gh, GH_STUB);
  await chmod(gh, 0o755);
  const marker = path.join(root, 'download');
  const result = await exec('bash', ['scripts/bump-homebrew-cask.sh', version, '--out', output], {
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CASK_RELEASE_FIXTURE: fixture,
      CASK_DOWNLOAD_MARKER: marker,
    },
    timeout: 10_000,
  }).then(
    ({ stderr }) => ({ code: 0, stderr }),
    error => ({ code: error.code, stderr: String(error.stderr) }),
  );
  return { ...result, cask, marker };
}

const sha256 = text => createHash('sha256').update(text).digest('hex');

describe.skipIf(process.platform === 'win32')('[regression] stable Homebrew release gate', () => {
  it.each([
    ['prerelease', '0.5.0-rc.1', { tagName: 'v0.5.0-rc.1', isDraft: false, isPrerelease: true }],
    ['draft', '0.5.0', { tagName: 'v0.5.0', isDraft: true, isPrerelease: false }],
  ])('refuses a %s release before download and preserves the existing stable cask', async (state, version, release) => {
    const { code, stderr, cask, marker } = await runBump(release, version);

    expect(code).toBe(1);
    expect(stderr).toContain(
      `Release v${version} is ${state}; only published stable releases may update the cask.`,
    );
    expect(await readFile(cask, 'utf8')).toBe('stable cask bytes\n');
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('renders the cask from the downloaded DMGs of a published stable release', async () => {
    const { code, stderr, cask, marker } = await runBump(
      { tagName: 'v0.5.0', isDraft: false, isPrerelease: false },
      '0.5.0',
    );

    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(await readFile(marker, 'utf8')).toBe('v0.5.0\n');
    const rendered = await readFile(cask, 'utf8');
    expect(rendered).toContain('version "0.5.0"');
    expect(rendered).toContain(`sha256 arm:   "${sha256('dmg:Novelist_0.5.0_aarch64.dmg')}",`);
    expect(rendered).toContain(`intel: "${sha256('dmg:Novelist_0.5.0_x64.dmg')}"`);
  }, 15_000);
});
