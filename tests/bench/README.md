# Novelist bench scripts

## `bundle-size.sh`
Prints the gzipped size of each JS chunk in `dist/`. Useful before/after code-split changes.

## Startup timeline (no script — built in)

Instrumentation lives in the app itself. There's no harness; just run the app
and read the console + tracing log.

**Where it lives**:
- Frontend marks: `app/lib/utils/startup-timing.ts` (`startupMark('phase.name')`)
- Backend marks: `tracing::info!(target: "novelist::startup", …)` in `core/src/lib.rs::run`
- Forwarding: frontend calls `log_startup_phase` IPC so both streams merge in stderr

**How to read it**:

1. `pnpm tauri dev` (or a release build).
2. Frontend phases print as a table in the DevTools console once the app is mounted
   and has painted once — look for rows like `frontend.main.start`,
   `frontend.main.i18n-ready`, `frontend.main.mounted`,
   `frontend.app.onMount.begin`, `frontend.app.onMount.end`,
   `frontend.app.first-paint`.
3. Backend phases land in stderr (with `RUST_LOG=novelist=info` or default `debug`):
   - `backend.run.begin` — process start (0 ms baseline)
   - `backend.specta.ready` — tauri-specta builder assembled
   - `backend.setup.begin` / `.end` — Tauri `.setup` callback window
   - `frontend.*` rows are echoed here too, with their frontend-clock time.

**Reading the numbers**:

The two clocks have different origins (backend `t0` = just after
`tracing_subscriber::init`; frontend `t0` = `frontend.main.start`). Compare
**within each stream** — the valuable questions are:
- Where's the gap between `backend.setup.end` and `frontend.main.start`? That's
  webview load + initial JS parse.
- Where's the gap between `frontend.main.mounted` and
  `frontend.app.first-paint`? That's `onMount` + Svelte hydration + one frame.
- Any single phase >50 ms is a candidate for investigation.

**Baseline capture**:

Run the app cold (after `pkill Novelist`) three times, copy the table rows
into a scratch file. Re-run after an optimization; compare the same phases.
