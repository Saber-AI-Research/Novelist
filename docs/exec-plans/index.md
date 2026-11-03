# Execution Plans

Last updated: 2026-11-03

Execution plans are temporary working artifacts. Once a plan has shipped,
move it to `completed/` or delete it if the durable decision has already
been captured in design docs.

## Active

- [2026-11-03 mobile and WebDAV release readiness](active/2026-11-03-release-readiness.md)
- [2026-11-03 optional account and configuration sync: platform acceptance pending](active/2026-11-03-optional-account-and-config-sync.md)
- [2026-10-29 three-round AI Talk, Android and mobile review](active/2026-10-29-three-round-code-review.md)
- [2026-10-28 mobile platform (iOS / Android)](active/2026-10-28-mobile-platform.md)
- [2026-04-12 memory optimization follow-up](active/2026-04-12-memory-optimization.md)

## Completed Archive

The retained [template-files design](completed/2026-04-20-template-files-panel-design.md)
contains the file format and execution contract that is not yet consolidated
into a dedicated durable page. Treat its rollout section as historical.

Superseded sidebar, naming, snapshot/WebDAV, AI-plugin, testing, icon,
localization, unsaved-dialog, image-host and publishing drafts were removed on
2026-11-03. Their current contracts live in [design docs](../design-docs/index.md),
[product specs](../product-specs/index.md), [frontend conventions](../FRONTEND.md)
and [plugin author references](../references/creating-plugins.md).

Keep active implementation plans under `docs/exec-plans/active/`.
When they ship, move them to `docs/exec-plans/completed/` and copy lasting
decisions into a product spec or design doc.

## Ongoing Tracker

- [Tech debt tracker](tech-debt-tracker.md)
