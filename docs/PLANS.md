# Plans

Last updated: 2026-11-03

## Active Plan Surface

- Release readiness, optional-account platform acceptance, mobile review and
  memory follow-up are listed in [exec-plans/index.md](exec-plans/index.md).
- Broader maintenance items are tracked in
  [exec-plans/tech-debt-tracker.md](exec-plans/tech-debt-tracker.md).

## Completed Plan Archive

Keep a completed plan only while it contains useful evidence or a contract not
yet covered by durable docs. The retained records are listed in
[exec-plans/index.md](exec-plans/index.md). Delete superseded implementation
drafts and repair incoming links; release notes should link to current product
specs or design docs.

Use those files as historical evidence only. For new work, start with:

1. Product behavior in `docs/product-specs/`.
2. Durable design constraints in `docs/design-docs/`.
3. A focused execution plan under `docs/exec-plans/active/`.
4. A completed-plan move or deletion once the feature ships.

## Plan Hygiene

- Do not leave stale implementation drafts in the primary docs surface.
- A completed plan should either be deleted or moved to `completed/`.
- A design decision that still matters belongs in `design-docs/`, not in an
  old plan.
