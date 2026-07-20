# Release Notes

Last updated: 2026-07-20

Release notes are maintainer-facing update logs for shipped versions. They
summarize the release band, link the specs and design docs that matter, and
record follow-up work that should not live only in git history.

For the canonical chronological change list, use
[`../../CHANGELOG.md`](../../CHANGELOG.md).

## Releases

| Version | Date | Theme | Primary docs |
|---|---:|---|---|
| [v0.4.0](2026-07-20-v0.4.0.md) | 2026-07-20 | Styled Copy, update-safe publishing, editor workflow reliability, and lifecycle hardening. | [`2026-07-20-styled-copy.md`](../product-specs/2026-07-20-styled-copy.md), [`2026-05-06-publish.md`](../product-specs/2026-05-06-publish.md), [`file-lifecycle.md`](../design-docs/file-lifecycle.md) |
| [v0.2.6](2026-05-23-v0.2.6.md) | 2026-05-23 | Reliability hardening, portable distribution groundwork, and release prep. | [`file-lifecycle.md`](../design-docs/file-lifecycle.md), [`2026-05-19-windows-portable-zip-design.md`](../superpowers/specs/2026-05-19-windows-portable-zip-design.md), [`2026-05-19-single-file-open-routing-design.md`](../superpowers/specs/2026-05-19-single-file-open-routing-design.md) |
| [v0.2.4](2026-05-14-v0.2.4.md) | 2026-05-14 | Image hosting, publishing, filename macros, and sidebar/editor polish. | [`2026-05-06-image-host.md`](../product-specs/2026-05-06-image-host.md), [`2026-05-06-publish.md`](../product-specs/2026-05-06-publish.md), [`2026-05-07-v0.2.4-rename-and-macros.md`](../product-specs/2026-05-07-v0.2.4-rename-and-macros.md) |

Older releases are tracked in [`../../CHANGELOG.md`](../../CHANGELOG.md). Add
dedicated release notes here when a release had enough product, architecture, or
operations context that a future maintainer would otherwise need to reconstruct
it from commits.

## Release Note Template

Use this shape for future files:

```markdown
# vX.Y.Z Release Notes

**Date:** YYYY-MM-DD
**Tag:** `vX.Y.Z`
**Package version:** `X.Y.Z`

## Theme

One paragraph describing what changed and why this release exists.

## Shipped

- User-visible change.
- Reliability or platform change.
- Documentation or operations change.

## Documentation Map

- Product spec: `docs/product-specs/...`
- Design doc: `docs/design-docs/...`
- Completed plan: `docs/exec-plans/completed/...`

## Verification Notes

- Command or manual smoke surface used for the release.

## Follow-Ups

- Work intentionally left for a later release.
```
