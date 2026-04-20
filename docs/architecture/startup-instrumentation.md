# Startup Instrumentation

`app/lib/utils/startup-timing.ts` (`startupMark(name)` /
`startupReport()`) records phase boundaries with `performance.now()` and
forwards to the Rust tracing stream via `log_startup_phase` so frontend +
backend phases appear in one `stderr` log.

- **Backend marks** live in `core/src/lib.rs::run`:
  `backend.run.begin`, `backend.specta.ready`, `backend.setup.begin`,
  `backend.setup.end`.
- **Frontend marks**: `frontend.main.start`, `.i18n-ready`, `.mounted`,
  `frontend.app.onMount.begin`, `frontend.app.onMount.end`,
  `.first-paint`.

See `tests/bench/README.md` for how to read the numbers.
