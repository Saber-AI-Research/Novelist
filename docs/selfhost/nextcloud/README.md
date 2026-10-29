# Self-hosted Novelist sync server (Nextcloud)

Deployable configuration for a private WebDAV server that Novelist's cloud
account and project sync can use: the official Nextcloud image with MariaDB
and Redis, managed with Docker Compose. Writers get ordinary Nextcloud users;
there is no Novelist-specific login service.

This directory is configuration, not a running service. Nothing here implies
that a public instance exists. The files were validated with
`docker compose config` (Compose v5.1.2); a live start and the WebDAV
conformance test against it have **not** been run in this repository yet.

## Security model (read first)

- **Transport:** phones only talk to the server over HTTPS. Novelist refuses
  `http://` except for loopback addresses and never follows redirects.
- **Not end-to-end encrypted:** Nextcloud stores manuscripts as ordinary files.
  The server administrator, anyone with access to the host, its disks or its
  backups, and an attacker who compromises the server can read every writer's
  projects. Nextcloud server-side encryption keeps its keys on the same server
  and does not change this. Only host writers who trust the operator.
- **Isolation:** each writer is a separate Nextcloud user with their own file
  tree, quota, sessions and app passwords. Sharing can be disabled entirely
  (below) so users cannot see each other.
- **Credentials:** writers sign in to Novelist with an **app password** per
  device, never their account password. Novelist stores it in the iOS Keychain
  or Android Keystore on that device only. Revoking the app password on the
  server cuts that device off.
- **Exposure:** by default Nextcloud listens on `127.0.0.1:8080` only; MariaDB
  and Redis publish no ports and sit on an internal network without outbound
  access. Secrets are Docker secret files, not environment variables.

## Contents

| File | Purpose |
|---|---|
| `compose.yaml` | Nextcloud (Apache), cron worker, MariaDB, Redis, networks, volumes, secrets |
| `compose.npm.yaml` | Optional override: join an existing Nginx Proxy Manager network and drop the loopback port |
| `.env.example` | Non-secret settings (domain, ports, upload limit, proxy options, image pins) |
| `init-secrets.sh` | Creates random secret files in `secrets/` (mode 0700 directory) |
| `.gitignore` | Keeps `.env`, `secrets/` and `backups/` out of git |

Pinned images (tags and multi-arch digests checked on Docker Hub, 2026-10-28):

| Image | Tag | Digest |
|---|---|---|
| Nextcloud (34 = current `stable`/`production` channel) | `nextcloud:34.0.5-apache` | `sha256:393d46e80fc241374a1b69064408cf0d54476580d7a00eb74cae3f4f2b2bb8a0` |
| MariaDB (11.8, recommended for Nextcloud 34) | `mariadb:11.8.9-noble` | `sha256:c4124d1afa875e47f2892edf26b482fa54f796e2f342d3717a04ca091a22a9bd` |
| Redis | `redis:8.10.3-trixie` | `sha256:298641b35ac51aa999f9bb85707d6681fe635ce59cda51886a0b6adc1da37b8e` |

Compare after pulling: `docker image inspect --format '{{index .RepoDigests 0}}' nextcloud:34.0.5-apache`.
Docker Hub rebuilds tags for base-image security fixes, so a newer digest for
the same tag is expected over time.

## Requirements

- A Linux host with Docker Engine and Docker Compose 2.24.4 or newer, 2 GB RAM
  or more, and disk for manuscripts, versions and backups.
- A DNS name for the server and a TLS reverse proxy in front of it: an existing
  Nginx Proxy Manager (`compose.npm.yaml`) or any proxy on the same host.
- Outbound HTTPS from the host (images, Let's Encrypt, Nextcloud app store).

## Install

```bash
cd docs/selfhost/nextcloud          # or copy this directory to the server
cp .env.example .env                # set NEXTCLOUD_DOMAIN (and the proxy values below)
./init-secrets.sh ncadmin           # admin login of your choice
docker compose pull
docker compose up -d                # loopback mode
docker compose ps                   # db and redis must become healthy
docker compose logs -f app          # wait for "Nextcloud was successfully installed"
```

`init-secrets.sh` writes `db_password`, `db_root_password`, `redis_password`,
`nextcloud_admin_user` and `nextcloud_admin_password`. The admin password is
used only by the first install: store it in a password manager and keep the
`secrets/` directory with your backups (the database password in it is still
in use). Do not hand-edit secrets to contain quotes, `$`, `&` or `#`; the image
interpolates them into shell commands and a Redis URL.

Run administrative commands as `www-data`:

```bash
occ() { docker compose exec -u www-data app php occ "$@"; }
occ status
occ background:cron                  # the cron service runs jobs every 5 minutes
occ config:system:set default_phone_region --value DE   # your ISO country code
```

## TLS, domain and reverse proxy

The admin and every writer must use `https://<NEXTCLOUD_DOMAIN>/`. Novelist's
WebDAV URL for a writer is
`https://<NEXTCLOUD_DOMAIN>/remote.php/dav/files/<login>/`. It must answer
directly: a redirect (http→https, a missing trailing slash, another host)
makes Novelist refuse the server.

### Existing Nginx Proxy Manager

1. Find the proxy network and its subnet:
   `docker network inspect proxy -f '{{(index .IPAM.Config 0).Subnet}}'`.
   Set `NPM_NETWORK` and `NPM_PROXY_SUBNET` in `.env`, and uncomment
   `COMPOSE_FILE=compose.yaml:compose.npm.yaml` there so every `docker compose`
   command below (backup, restore, `occ`) includes the override.
2. Start (the loopback port is removed): `docker compose up -d`, then check
   with `docker compose config` that `app` has no `ports` and joins the proxy
   network.
3. In NPM, add a proxy host for `NEXTCLOUD_DOMAIN`: scheme `http`, forward host
   `novelist-nextcloud`, port `80`, *Block common exploits* on. On the SSL tab
   request a Let's Encrypt certificate and enable *Force SSL*, *HTTP/2* and
   *HSTS*. In *Advanced*, allow large and long uploads:

   ```nginx
   client_max_body_size 1024m;
   proxy_request_buffering off;
   proxy_read_timeout 3600s;
   proxy_send_timeout 3600s;
   ```

   Keep `client_max_body_size` at or above `PHP_UPLOAD_LIMIT`.
4. The override sets `OVERWRITEPROTOCOL=https`, `OVERWRITEHOST`,
   `OVERWRITECLIURL`, trusts `X-Forwarded-*` only from `NPM_PROXY_SUBNET`
   (`TRUSTED_PROXIES`), and disables Apache's own `X-Real-IP` rewriting so
   Nextcloud sees real client addresses for brute-force protection.

Changing proxy hosts in a shared NPM affects other services: coordinate with
whoever runs it.

### Another reverse proxy on the same host

Forward `https://NEXTCLOUD_DOMAIN` to `http://127.0.0.1:${NEXTCLOUD_HTTP_PORT}`
with `Host`, `X-Real-IP`, `X-Forwarded-For` and `X-Forwarded-Proto` headers,
and set in `.env`:

```
NEXTCLOUD_OVERWRITE_PROTOCOL=https
NEXTCLOUD_OVERWRITE_HOST=<NEXTCLOUD_DOMAIN>
NEXTCLOUD_OVERWRITE_CLI_URL=https://<NEXTCLOUD_DOMAIN>
```

The image trusts `X-Real-IP` from private addresses, which covers the Docker
bridge gateway the proxy connects through. Serve the full certificate chain;
Android rejects servers that send only the leaf certificate.

### Check

```bash
curl -fsS https://<NEXTCLOUD_DOMAIN>/status.php   # "installed":true,"maintenance":false
occ config:system:get trusted_domains
```

Then open the admin overview (Administration settings → Overview) and fix
every security and setup warning it lists.

## Policies for a writers' server

```bash
occ app:enable twofactor_totp                                   # TOTP second factor (shipped app)
occ twofactorauth:enforce --on --group writers                  # require 2FA for writers
occ config:app:set files default_quota --value "5 GB"           # default per-user quota
occ config:app:set core shareapi_enabled --value no             # optional: no sharing between users
```

With 2FA, WebDAV clients cannot use the account password at all; every device
needs an app password, which is what Novelist expects.

## Writer accounts

Create one user per writer. Read the initial password without echo so it
stays out of the shell history and process list:

```bash
read -rs OC_PASS && export OC_PASS
docker compose exec -u www-data -e OC_PASS app \
  php occ user:add --password-from-env --display-name "Writer Name" --group writers alice
unset OC_PASS
occ user:setting alice files quota "10 GB"                      # per-user quota override
```

Hand the initial password over through a separate channel. The writer then:

1. Signs in at `https://<NEXTCLOUD_DOMAIN>/`, changes the password and sets up
   TOTP (Personal settings → Security).
2. Creates one app password per device: Personal settings → Security →
   Devices & sessions → *Create new app password*, named after the device
   (for example "Novelist iPad").
3. In Novelist: Settings → Sync → **Cloud account**: URL
   `https://<NEXTCLOUD_DOMAIN>/remote.php/dav/files/<login>/`, the login name
   (not the display name) and the app password. Novelist keeps projects in
   `novelist-sync/` and snapshots in `novelist-snapshots/` under that folder.

An admin can also issue an app password for a user; it is shown once and has
reduced capabilities when created without the user's password:

```bash
occ user:auth-tokens:add --name "Novelist iPhone" alice
```

### Lost device, offboarding, incidents

```bash
occ user:auth-tokens:list alice            # sessions and app passwords with ids
occ user:auth-tokens:delete alice 42       # revoke one device
occ user:disable alice                     # block the account (sessions end within minutes)
occ twofactorauth:disable alice totp       # writer lost their second factor
occ user:resetpassword --password-from-env alice   # with OC_PASS exported as above
```

Writers can revoke their own devices in Devices & sessions. Revoking a device
does not delete anything on it: the projects stay on the device, and sync
fails with 401 until a new app password is entered.

## WebDAV conformance check

Run from a checkout of the Novelist repository against the real HTTPS URL,
with a writer (or test) account:

```bash
NOVELIST_WEBDAV_USER=alice pnpm mobile:webdav:conformance -- \
  --url https://<NEXTCLOUD_DOMAIN>/remote.php/dav/files/alice/
```

It asks for the app password without echo (or reads
`NOVELIST_WEBDAV_PASSWORD`), never prints it, creates
`novelist-conformance-<time>-<random>/` and removes it again. It checks that
the URL answers PROPFIND without redirects, MKCOL with CJK/space/`#`/`%`
names, `If-None-Match: *` creates and then refuses to overwrite (412), listings
carry strong ETags that change with content, stale `If-Match` PUT and DELETE
are refused with 412 and current ones succeed. Exit status 0 means all
required checks passed; warnings (for example no ETag on the PUT response)
only cost extra requests in Novelist.

Do not let writers sync against a server that fails it: a server that keeps an
ETag after a change or deletes on a stale `If-Match` can silently overwrite or
delete another device's edits (stock WsgiDAV 4.4 fails this way; see
[Sync server requirements](../../design-docs/mobile-deployment.md#sync-server-requirements)).

## Backup

Back up the database, both volumes, `.env` and `secrets/` together, in
maintenance mode so they are consistent:

```bash
mkdir -p backups
stamp=$(date +%Y%m%d-%H%M%S)
occ maintenance:mode --on
docker compose exec -T db sh -c \
  'MYSQL_PWD="$(cat /run/secrets/db_password)" exec mariadb-dump --single-transaction --default-character-set=utf8mb4 -unextcloud nextcloud' \
  > "backups/db-$stamp.sql"
docker compose run --rm --no-deps -T -v "$PWD/backups:/backup" --entrypoint tar app \
  -C /var/www/html -czf "/backup/files-$stamp.tar.gz" .
occ maintenance:mode --off
tar -czf "backups/settings-$stamp.tar.gz" .env secrets
```

The files archive contains `config/` (with the instance secret) and every
writer's manuscripts: store backups encrypted, off the host, and test restores.
Writers can recover single files themselves from Versions and Deleted files in
the web UI, within the retention Nextcloud applies.

## Restore

```bash
docker compose down                         # keeps volumes
docker volume rm novelist-nextcloud_db novelist-nextcloud_html novelist-nextcloud_data
tar -xzf backups/settings-<stamp>.tar.gz    # the .env and secrets/ that match the backup
docker compose up -d db redis
docker compose run --rm --no-deps -T -v "$PWD/backups:/backup:ro" --entrypoint tar app \
  -C /var/www/html -xzf "/backup/files-<stamp>.tar.gz"
docker compose exec -T db sh -c \
  'MYSQL_PWD="$(cat /run/secrets/db_password)" exec mariadb -unextcloud nextcloud' \
  < backups/db-<stamp>.sql
docker compose up -d
occ maintenance:mode --off
occ maintenance:data-fingerprint            # tells clients the server went back in time
```

After a restore, files changed on devices after the backup look like local
edits to Novelist and upload on the next sync; files changed on both sides are
reported as conflicts for the writer to resolve.

## Upgrade

Nextcloud upgrades one major version at a time (34 → 35 → 36).

1. Back up (above) and read the release notes of the target version.
2. Find the new tag on Docker Hub (`nextcloud:<major>.<minor>.<patch>-apache`)
   and check the database versions it supports in the Nextcloud admin manual.
3. Set `NEXTCLOUD_IMAGE` (and `MARIADB_IMAGE`/`REDIS_IMAGE` if needed) in
   `.env`, then:

   ```bash
   docker compose pull
   docker compose up -d                # the entrypoint runs `occ upgrade`
   docker compose logs -f app
   occ status
   occ db:add-missing-indices
   occ maintenance:repair --include-expensive
   ```

4. Run the WebDAV conformance check again.

`MARIADB_AUTO_UPGRADE=1` lets the MariaDB container upgrade its system tables
when the MariaDB image changes.

## Operations

| Task | Command |
|---|---|
| Service state | `docker compose ps` |
| Logs | `docker compose logs --tail 200 app` and `docker compose exec -u www-data app tail -n 100 /var/www/html/data/nextcloud.log` |
| Background jobs | `occ background:cron` once; the `cron` service then runs every 5 minutes |
| Quota used | `occ user:info alice` |
| Stop / start | `docker compose stop` / `docker compose up -d` |
| Remove everything | `docker compose down -v` deletes all manuscripts: back up first |

| Symptom | Check |
|---|---|
| Novelist reports a redirect | The URL must be the final `https://…/remote.php/dav/files/<login>/`; no http→https hop |
| 401 | Login name vs display name; app password revoked; account disabled |
| 507 Insufficient Storage | Quota (`occ user:info`) or disk space |
| 413 from the proxy | Raise `client_max_body_size` and `PHP_UPLOAD_LIMIT` |
| 423 Locked | Redis healthy (`docker compose ps`)? Cron running? |
| "Access through untrusted domain" | `occ config:system:get trusted_domains`; add the domain with `occ config:system:set trusted_domains 1 --value=<domain>` |
| Wrong client IPs / brute-force throttling of everyone | `TRUSTED_PROXIES` / proxy headers |
