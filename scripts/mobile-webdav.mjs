// Loopback WebDAV server for the iOS simulator smoke (scripts/mobile-ios-smoke.mjs):
// the macOS system Apache 2.4 (/usr/sbin/httpd) with mod_dav_fs and Basic
// auth, run in the foreground as the invoking user. It listens on a free
// 127.0.0.1 port only; simulator apps share the host loopback. Every user
// gets a random password that is kept in memory and in an apr1 htpasswd file
// inside a private temporary directory, never in the evidence. The data
// served is whatever the app uploads during the run; stop() removes it all.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const HTTPD = '/usr/sbin/httpd';
const HTPASSWD = '/usr/sbin/htpasswd';
const MODULE_DIR = '/usr/libexec/apache2';
const MODULES = [
  ['mpm_prefork_module', 'mod_mpm_prefork.so'],
  ['unixd_module', 'mod_unixd.so'],
  ['authn_core_module', 'mod_authn_core.so'],
  ['authn_file_module', 'mod_authn_file.so'],
  ['authz_core_module', 'mod_authz_core.so'],
  ['authz_user_module', 'mod_authz_user.so'],
  ['auth_basic_module', 'mod_auth_basic.so'],
  ['dav_module', 'mod_dav.so'],
  ['dav_fs_module', 'mod_dav_fs.so'],
  ['mime_module', 'mod_mime.so'],
  ['log_config_module', 'mod_log_config.so'],
];
const START_MS = 20_000;
const STOP_MS = 10_000;

function fail(message, hints = []) {
  throw Object.assign(new Error(message), { hints: hints.filter(Boolean) });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function connects(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** PROPFIND Depth 0 on `urlPath`; resolves the HTTP status. */
function propfind(port, urlPath, auth) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'PROPFIND',
        path: urlPath,
        headers: {
          Depth: '0',
          'Content-Type': 'application/xml',
          ...(auth ? { Authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` } : {}),
        },
        timeout: 10_000,
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('timeout', () => request.destroy(new Error(`PROPFIND ${urlPath} timed out`)));
    request.on('error', reject);
    request.end('<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>');
  });
}

function conf(root, port, usernames) {
  return `ServerRoot "/usr"
Listen 127.0.0.1:${port}
PidFile "${root}/logs/httpd.pid"
${MODULES.map(([name, file]) => `LoadModule ${name} ${MODULE_DIR}/${file}`).join('\n')}
ServerName 127.0.0.1
ErrorLog "${root}/logs/error.log"
LogFormat "%t %r %>s" short
CustomLog "${root}/logs/access.log" short
DocumentRoot "${root}/srv"
DavLockDB "${root}/lock/DavLock"
# Apache 2.4 default validator: size + mtime. Weak for about 1 s after a write.
FileETag MTime Size
<Directory "${root}/srv">
  Require all denied
</Directory>
<Directory "${root}/srv/dav">
  Require valid-user
</Directory>
<Location "/dav/">
  Dav On
  AuthType Basic
  AuthName "novelist-dav"
  AuthUserFile "${root}/htpasswd"
  Require valid-user
</Location>
# Each account reaches only its own folder.
${usernames.map((username) => `<LocationMatch "^/dav/files/${username}(/|$)">\n  Require user ${username}\n</LocationMatch>`).join('\n')}
`;
}

function copyCapped(from, to, limit) {
  let size;
  try {
    size = fs.statSync(from).size;
  } catch {
    return { file: path.basename(to), missing: true };
  }
  const fd = fs.openSync(from, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(size, limit));
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    fs.writeFileSync(to, size > limit ? Buffer.concat([Buffer.from(`[smoke: only the last ${limit} of ${size} bytes kept]\n`), buffer]) : buffer);
  } finally {
    fs.closeSync(fd);
  }
  return { file: path.basename(to), bytes: size, truncated: size > limit };
}

/** Relative paths of all files below `dir`, sorted. */
export function listFiles(dir) {
  const found = [];
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else if (entry.isFile()) found.push(rel);
    }
  };
  walk(dir, '');
  return found.sort();
}

/**
 * Start the server with one account per name in `users`.
 * Returns { port, version, account(user) → {endpoint, username, password, root},
 * secrets(), accessLog(), stop({ logDir, logBytes }), stopSync() }.
 */
export async function startLoopbackWebDav({ users }) {
  for (const file of [HTTPD, HTPASSWD, ...MODULES.map(([, module]) => path.join(MODULE_DIR, module))]) {
    if (!fs.existsSync(file)) {
      fail(`the loopback WebDAV server needs ${file} (macOS system Apache 2.4 with mod_dav_fs)`, [
        'the cloud flow runs against macOS /usr/sbin/httpd; no other server is substituted',
      ]);
    }
  }
  const versionRun = spawnSync(HTTPD, ['-v'], { encoding: 'utf8', timeout: 10_000 });
  const version = /Server version:\s*(\S+)/.exec(versionRun.stdout ?? '')?.[1] ?? null;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'novelist-dav-')));
  fs.chmodSync(root, 0o700);
  for (const dir of ['logs', 'lock', 'srv/dav/files']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const accounts = new Map();
  let child = null;
  let stopped = false;

  const removeRoot = () => fs.rmSync(root, { recursive: true, force: true });
  // httpd runs in its own process group (prefork signals its whole group on
  // shutdown); a forced stop takes the workers with it.
  const stopSync = () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
    if (!stopped) removeRoot();
    stopped = true;
  };

  try {
    for (const [index, user] of users.entries()) {
      const username = `novelist-smoke-${user}`;
      const password = randomBytes(18).toString('base64url');
      // htpasswd reads the password from stdin (-i), never from argv.
      const made = spawnSync(HTPASSWD, ['-i', ...(index === 0 ? ['-c'] : []), path.join(root, 'htpasswd'), username], {
        input: `${password}\n`,
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (made.status !== 0) fail(`htpasswd could not add ${username} (status ${made.status})`, [made.stderr?.trim()]);
      const userRoot = path.join(root, 'srv', 'dav', 'files', username);
      fs.mkdirSync(userRoot);
      accounts.set(user, { username, password, root: userRoot });
    }
    const port = await freePort();
    const confFile = path.join(root, 'httpd.conf');
    fs.writeFileSync(confFile, conf(root, port, [...accounts.values()].map((account) => account.username)), { mode: 0o600 });
    const checked = spawnSync(HTTPD, ['-f', confFile, '-t'], { encoding: 'utf8', timeout: 10_000 });
    if (checked.status !== 0) fail('httpd rejected the WebDAV configuration', [`${checked.stdout ?? ''}${checked.stderr ?? ''}`.trim()]);

    let output = '';
    child = spawn(HTTPD, ['-f', confFile, '-D', 'FOREGROUND'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const keep = (chunk) => {
      if (output.length < 16_384) output += chunk.toString('utf8');
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    const errorLog = () => {
      try {
        return fs.readFileSync(path.join(root, 'logs', 'error.log'), 'utf8').trim().split('\n').slice(-10).join('\n');
      } catch {
        return '';
      }
    };

    const deadline = Date.now() + START_MS;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        fail(`httpd exited during startup (${child.exitCode ?? child.signalCode})`, [output.trim(), errorLog()]);
      }
      if (await connects(port)) break;
      if (Date.now() >= deadline) fail(`httpd did not listen on 127.0.0.1:${port} within ${START_MS / 1000} s`, [output.trim(), errorLog()]);
      await delay(100);
    }
    // The server must enforce the credentials: anonymous 401, each user 207
    // on its own folder and refused on every other account's folder.
    const probes = {};
    for (const [user, account] of accounts) {
      const folder = `/dav/files/${account.username}/`;
      const anonymous = await propfind(port, folder);
      const authenticated = await propfind(port, folder, account);
      const others = [];
      for (const other of accounts.values()) if (other !== account) others.push(await propfind(port, folder, other));
      probes[user] = { anonymous, authenticated, otherAccounts: others };
      if (anonymous !== 401 || authenticated !== 207 || others.some((status) => status !== 401 && status !== 403)) {
        fail(`the WebDAV server answered PROPFIND ${folder} with ${anonymous} anonymously, ${authenticated} as its user and ${others.join('/') || 'nothing'} as other users (expected 401, 207, 401/403)`, [errorLog()]);
      }
    }

    return {
      port,
      version,
      probes,
      account(user) {
        const account = accounts.get(user);
        if (!account) fail(`no WebDAV account for ${user}`);
        return { ...account, endpoint: `http://127.0.0.1:${port}/dav/files/${account.username}/` };
      },
      /** Every secret this server knows, for scanning the evidence. */
      secrets() {
        return [...accounts.values()].flatMap(({ username, password }) => [password, Buffer.from(`${username}:${password}`).toString('base64')]);
      },
      accessLog() {
        try {
          return fs.readFileSync(path.join(root, 'logs', 'access.log'), 'utf8');
        } catch {
          return '';
        }
      },
      /** Stop httpd, keep its (credential-free) logs, delete everything else. */
      async stop({ logDir, logBytes }) {
        if (stopped) return { stopped: true };
        const result = {};
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }, STOP_MS);
        result.exit = await exited;
        clearTimeout(timer);
        result.portClosed = !(await connects(port));
        if (logDir) {
          fs.mkdirSync(logDir, { recursive: true });
          result.accessLog = copyCapped(path.join(root, 'logs', 'access.log'), path.join(logDir, 'webdav-access.log'), logBytes);
          result.errorLog = copyCapped(path.join(root, 'logs', 'error.log'), path.join(logDir, 'webdav-error.log'), logBytes);
        }
        removeRoot();
        stopped = true;
        result.removed = !fs.existsSync(root);
        return result;
      },
      stopSync,
    };
  } catch (error) {
    stopSync();
    throw error;
  }
}
