# Memory Optimization Follow-up

Last updated: 2026-11-03
Status: unfinished profiling and startup work; the original implementation draft has been reconciled with current code.

## Implemented boundaries

- QuickJS runtimes are created when a plugin loads, with memory, stack and execution limits in `core/src/services/plugin_host/sandbox.rs`. Preserve the current [plugin resource contract](../../design-docs/plugin-system.md#quickjs-resource-limits).
- `specta-typescript` is optional behind the `codegen` Cargo feature. Normal release builds do not require the code-generation dependency.
- `app/app.css` already uses `font-display: swap` and CJK `unicode-range` for the bundled font.
- HTTP is used by AI Talk, publishing, image hosts and the optional account client as well as WebDAV. The old proposal to make all HTTP/TLS support conditional on the `sync` feature no longer matches the product.

## Remaining work

1. Capture a fresh release-build baseline for the Rust process and WebView separately, including idle startup, opening a manuscript and loading plugins. The April RSS and estimated savings were historical measurements, not current acceptance evidence.
2. Evaluate Tokio worker count against current filesystem and network workloads before changing runtime configuration. The old two-worker suggestion was not an established runtime contract.
3. Measure when the editor/extension chunks load and whether deferring them improves startup without delaying the first document. Use the current `app/` source layout; the old draft's `src/` paths are obsolete.
4. Decide whether a memory diagnostic command is useful after profiling. The original draft proposed one, but it is not a current IPC contract; report current resident memory separately from peak RSS if implemented.

## Completion evidence

Record the same process set and workload before and after each selected optimization, with startup latency and CJK editing behavior. Do not treat estimated allocation savings or mapped virtual bytes as measured resident-memory reduction. Use [startup instrumentation](../../design-docs/startup-instrumentation.md) and the current [testing strategy](../../design-docs/testing.md); daily development follows the [Web-only workflow](../../development.md#commands), with native profiling and platform acceptance reserved for release preparation.
