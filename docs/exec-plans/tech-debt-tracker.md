# Tech Debt Tracker

Last updated: 2026-04-25

This file tracks issues that are too broad for a single inline TODO but too
real to lose. Link active plans here rather than adding new floating drafts.

| Area | Risk | Current state | Next action |
|---|---|---|---|
| Documentation drift | Medium | Older docs referenced `docs/design-docs/` and `CLAUDE.md` as primary entry points. | Keep `AGENTS.md`, `ARCHITECTURE.md`, and `docs/*` indexes current when moving docs. |
| E2E runtime cost | Medium | Browser E2E is part of CI; Tauri E2E exists but is release-oriented. | Keep `pnpm verify:quick` fast and reserve `pnpm verify:ci` for PR readiness. |
| WebDAV/sync UX | Medium | Sync services and commands exist, but release confidence depends on more conflict and network testing. | Add targeted sync product spec before expanding UI. |
| Huge-file editor modules | Medium | Vitest coverage is lower for CM6-heavy modules by design. | Maintain Playwright flows and precision tests for viewport, scroll, and selection behavior. |
| Plugin marketplace | Low/medium | Concept docs exist; bundled plugins are core product features today. | Decide whether marketplace is near-term product scope or keep it parked. |
