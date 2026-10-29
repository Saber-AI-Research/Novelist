#!/usr/bin/env bash
# Create the Docker secret files compose.yaml needs, once, before the first
# `docker compose up`. Existing files are kept (rerunning never rotates a
# secret behind a running database).
#
#   ./init-secrets.sh <nextcloud-admin-login>
#
# Values are random hex: the Nextcloud image interpolates them into shell
# commands and a Redis URL, so they must not contain quotes, `$`, `&` or `#`.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

admin="${1:-}"
if [[ ! "$admin" =~ ^[A-Za-z0-9][A-Za-z0-9._@-]{2,63}$ ]]; then
  echo "usage: $0 <nextcloud-admin-login>   (3-64 chars: letters, digits, . _ @ -)" >&2
  exit 2
fi
command -v openssl >/dev/null || { echo "error: openssl is required" >&2; exit 1; }

umask 077
mkdir -p secrets
chmod 700 secrets

created=()
for name in db_password db_root_password redis_password nextcloud_admin_password; do
  if [[ -s "secrets/$name" ]]; then
    echo "keeping existing secrets/$name"
  else
    openssl rand -hex 32 > "secrets/$name"
    created+=("$name")
  fi
done
if [[ -s secrets/nextcloud_admin_user ]]; then
  echo "keeping existing secrets/nextcloud_admin_user ($(cat secrets/nextcloud_admin_user))"
else
  printf '%s\n' "$admin" > secrets/nextcloud_admin_user
  created+=(nextcloud_admin_user)
fi

# Compose bind-mounts these files unchanged into containers that read them as
# different users (mysql, redis, www-data), so the files are world-readable
# and the 0700 directory keeps other accounts on this host out.
chmod 644 secrets/*

if ((${#created[@]})); then
  echo "created: ${created[*]}"
fi
echo "The admin password is in secrets/nextcloud_admin_password; it is used only for the first install."
echo "Store it in a password manager. Back up the whole secrets/ directory together with the database."
