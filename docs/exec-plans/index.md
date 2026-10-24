# Execution Plans

Last updated: 2026-05-27

Execution plans are temporary working artifacts. Once a plan has shipped,
move it to `completed/` or delete it if the durable decision has already
been captured in design docs.

## Active

- [2026-04-12 memory optimization](active/2026-04-12-memory-optimization.md)

## Completed Archive

Completed implementation drafts are kept as a historical audit trail. New work
should start from product specs, design docs, and the tech debt tracker.

- [2026-05-06 image hosting (v0.2.4)](completed/2026-05-06-image-host.md)
- [2026-05-06 publishing (v0.2.4)](completed/2026-05-06-publish.md)
- [2026-05-07 rename UX & filename macros (v0.2.4)](completed/2026-05-07-v0.2.4-rename-and-macros.md)

Keep active implementation plans under `docs/exec-plans/active/`.
When they ship, move them to `docs/exec-plans/completed/` and copy lasting
decisions into a product spec or design doc.

## Ongoing Tracker

- [Tech debt tracker](tech-debt-tracker.md)
