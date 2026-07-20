# Reliability

Last updated: 2026-07-18

Reliability in Novelist means the writer's files are safe, the editor stays
responsive, and regressions are caught before release.

## Local Harness

```bash
pnpm harness --help
pnpm verify:quick
pnpm verify:ci
```

| Command | Purpose |
|---|---|
| `pnpm harness doctor` | Print local tool versions and project paths. |
| `pnpm verify:quick` | Fast local gate: `pnpm check`, unit tests, integration tests. |
| `pnpm verify:coverage` | Enforced Vitest coverage gate. |
| `pnpm verify:e2e` | Browser Playwright suite with mocked IPC; runs with `CI=1` so a foreign `localhost:1420` server fails fast. |
| `pnpm verify:rust` | Rust format, locked clippy/tests, and the pinned Pandoc 3.10 contract matrix. |
| `pnpm verify:ci` | Local CI mirror, including the pinned Pandoc 3.10 contract matrix. |

## CI Gate

The macOS CI job runs:

- `pnpm check`
- `pnpm test:coverage`
- `pnpm test:e2e:browser`
- `cargo fmt --all -- --check`
- `cargo clippy --all-targets --all-features -- -D warnings`
- `cargo test`
- `pnpm test:rust:pandoc` against pinned Pandoc 3.10

The Linux CI job runs Rust check and tests with Linux Tauri dependencies. The
Windows job runs native Pandoc lifecycle/security tests, while the macOS job
owns the pinned cross-format content matrix.

Tag releases use frozen pnpm and locked Cargo inputs. Platform builds remain
draft-only until the native macOS, Windows, and remaining matrix legs all pass;
the ARM macOS gate also reruns the pinned Pandoc 3.10 contract matrix.

The tag workflow deliberately creates a GitHub draft. A maintainer inspects the
complete asset set and `latest.json`, then publishes that draft explicitly.
The Homebrew tap job is disabled in the tag workflow because a draft release is
not a valid public cask source. After the GitHub release is public, update
`Saber-AI-Research/homebrew-novelist` in a separate reviewed operation using the
published Apple Silicon and Intel DMG SHA-256 values.

Local `verify:rust` and `verify:ci` runs require Pandoc 3.10 on `PATH`;
`pnpm harness doctor` reports the installed version or the missing dependency.

## Data Safety Rules

- User-data writes must be atomic: temp file then rename.
- Watcher self-write suppression uses BLAKE3 hashes.
- External changes must surface through conflict handling rather than silent
  overwrite.
- Generated IPC bindings must be regenerated after Rust command changes.

## Release Smoke

Before a release, run or verify:

1. `pnpm verify:ci`
2. `pnpm test:e2e:tauri` on the release platform when feasible
3. `pnpm tauri build`
4. Manual smoke: open project, type CJK text, save, rename, reopen, export
5. Inspect the draft assets and updater JSON, publish the draft, then update the
   Homebrew cask separately
