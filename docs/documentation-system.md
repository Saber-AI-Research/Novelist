# Documentation System

Last updated: 2026-05-27

This page defines how Novelist keeps documentation useful after features ship.
The goal is simple: every notable change should leave one durable trace, and
every temporary plan should either move out of the active surface or disappear.

## Information Architecture

| Surface | Purpose | Update when |
|---|---|---|
| `docs/index.md` | Entry map for the whole docs tree. | A new docs area appears or an existing area changes purpose. |
| `CHANGELOG.md` | Canonical chronological list of user-visible release changes. | Preparing a release or recording an unreleased user-facing change. |
| `docs/releases/` | Release notes and update logs for shipped versions. | Cutting a release or summarizing a release band after it ships. |
| `docs/product-specs/` | Intended user behavior and acceptance criteria. | A feature changes what users can do or what behavior is guaranteed. |
| `docs/design-docs/` | Durable architecture, invariants, and engineering decisions. | A code path, data model, lifecycle rule, or testing rule must guide future work. |
| `docs/exec-plans/active/` | Unshipped implementation plans. | Work has a plan but is not yet delivered. |
| `docs/exec-plans/completed/` | Historical plans for shipped work. | A plan ships and is still useful as an audit trail. |
| `docs/references/` | Lookup material, examples, and external-reference notes. | A reference is useful but does not express a product contract or architecture decision. |

## Release Documentation Rule

`CHANGELOG.md` remains the source of truth for versioned changes. A release note
under `docs/releases/` complements it by answering the questions a maintainer
asks later:

1. What was the theme of this release?
2. Which product specs, design docs, or plans describe the shipped behavior?
3. Which verification surface mattered for the release?
4. What follow-up documentation or implementation debt remains?

Do not duplicate the whole changelog in a release note. Link to the changelog
and summarize the release band.

## Ship-Day Checklist

Before tagging a release:

1. Update `CHANGELOG.md` with the final version heading and date.
2. Add or update `docs/releases/YYYY-MM-DD-vX.Y.Z.md`.
3. Add the release to `docs/releases/index.md`.
4. Mark shipped product specs as shipped in `docs/product-specs/index.md`.
5. Move shipped plans from `docs/exec-plans/active/` to
   `docs/exec-plans/completed/`, or delete them if a durable doc supersedes
   them.
6. Update the relevant `docs/design-docs/` page when the implementation created
   a lasting invariant.
7. Refresh `docs/index.md` and any touched sub-index `Last updated` dates.

## Active Plan Hygiene

An active plan is only active if a maintainer should still pick it up and
execute it. Once a release contains the work:

- Move the plan to `docs/exec-plans/completed/` when the step-by-step record is
  useful for future audits.
- Delete the plan when it only repeats a product spec or design doc.
- Link the completed plan from the release note if it explains release context.



## Recent Cleanup

On 2026-05-27, the docs tree was reconciled after the v0.2.4 and v0.2.6 release
bands:

- Added `docs/releases/` as the update-log home inside `docs/`.
- Added release notes for v0.2.4 and v0.2.6.
- Moved the shipped v0.2.4 execution plans out of `active/`.
- Updated docs indexes so image hosting, publishing, and rename macros are
  represented as shipped product specs instead of active drafts.
