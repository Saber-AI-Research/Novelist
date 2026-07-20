#!/usr/bin/env bash
set -euo pipefail

: "${NOVELIST_NATIVE_TAURI_LOG:?missing NOVELIST_NATIVE_TAURI_LOG}"
: "${NOVELIST_NATIVE_ROOT_DIR:?missing NOVELIST_NATIVE_ROOT_DIR}"

tauri_cli="$NOVELIST_NATIVE_ROOT_DIR/node_modules/.bin/tauri"
if [[ ! -x "$tauri_cli" ]]; then
  printf 'local Tauri CLI is missing or not executable: %s\n' "$tauri_cli" >&2
  exit 66
fi

exec "$tauri_cli" "$@" \
  > >(tee -a "$NOVELIST_NATIVE_TAURI_LOG") \
  2> >(tee -a "$NOVELIST_NATIVE_TAURI_LOG" >&2)
