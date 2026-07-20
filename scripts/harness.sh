#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE_DIR="$ROOT_DIR/core"

usage() {
  cat <<'EOF'
Novelist development and test harness

Usage:
  bash scripts/harness.sh <command>

Commands:
  doctor       Print local tool versions and missing-tool hints.
  quick        Fast local gate: Svelte check + Vitest unit/integration.
  unit         Vitest unit and integration suites only.
  coverage     Vitest coverage gate.
  e2e          Browser Playwright suite with mocked Tauri IPC.
  native-smoke Real macOS Tauri/WKWebView smoke with the Rust backend.
  rust         Rust fmt, clippy, tests, and pinned Pandoc 3.10 contracts.
  ci           Local CI mirror, including pinned Pandoc 3.10 contracts.
  build        Frontend production build.
  tauri-build  Full Tauri production build.

Common flows:
  pnpm verify:quick     Before small frontend/doc changes.
  pnpm verify:ci        Before opening or merging a PR.
  pnpm test:e2e:ui      Interactive Playwright debugging.
  pnpm verify:native-smoke  Native macOS Tauri smoke.
EOF
}

section() {
  printf '\n==> %s\n' "$1"
}

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    return 1
  fi
}

run_root() {
  section "$*"
  (cd "$ROOT_DIR" && "$@")
}

run_core() {
  section "(core) $*"
  (cd "$CORE_DIR" && "$@")
}

run_root_ci() {
  section "CI=1 $*"
  (cd "$ROOT_DIR" && CI=1 "$@")
}

doctor() {
  section "Tool versions"
  need node
  node --version
  need pnpm
  pnpm --version
  need rustc
  rustc --version
  need cargo
  cargo --version
  need pandoc
  pandoc --version

  if command -v tauri >/dev/null 2>&1; then
    tauri --version
  else
    printf 'tauri CLI is available through pnpm: pnpm tauri --version\n'
  fi

  section "Project"
  printf 'root: %s\n' "$ROOT_DIR"
  printf 'core: %s\n' "$CORE_DIR"
}

unit() {
  run_root pnpm test:unit
  run_root pnpm test:integration
}

quick() {
  run_root pnpm check
  unit
}

coverage() {
  run_root pnpm test:coverage
}

e2e() {
  # Force Playwright's CI server policy so a stray localhost:1420 from another
  # project fails fast instead of being silently reused.
  run_root_ci pnpm test:e2e:browser
}

native_smoke() {
  run_root pnpm test:e2e:tauri
}

rust_gate() {
  run_core cargo fmt --all -- --check
  run_core cargo clippy --locked --all-targets --all-features -- -D warnings
  run_core cargo test --locked
  run_root pnpm test:rust:pandoc
}

ci() {
  run_root pnpm check
  coverage
  e2e
  rust_gate
}

case "${1:-}" in
  doctor) doctor ;;
  quick) quick ;;
  unit) unit ;;
  coverage) coverage ;;
  e2e) e2e ;;
  native-smoke) native_smoke ;;
  rust) rust_gate ;;
  ci) ci ;;
  build) run_root pnpm build ;;
  tauri-build) run_root pnpm tauri build -- --locked ;;
  ""|-h|--help|help) usage ;;
  *)
    printf 'Unknown harness command: %s\n\n' "$1" >&2
    usage >&2
    exit 2
    ;;
esac
