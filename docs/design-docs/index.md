# Design Docs Index

Last updated: 2026-11-03

This directory holds the durable design record for Novelist. Historical
implementation plans live in `docs/exec-plans/`; this directory is for the
decisions that still guide future work.

## Core Architecture

| Topic | File |
|---|---|
| Product and architecture overview | [design-overview.md](design-overview.md) |
| Core beliefs | [core-beliefs.md](core-beliefs.md) |
| Editor, WYSIWYG, slash menu, context menu, large docs | [editor.md](editor.md) |
| File lifecycle, watcher, self-write suppression | [file-lifecycle.md](file-lifecycle.md) |
| Plugin system and bundled plugin constraints | [plugin-system.md](plugin-system.md) |
| Settings overlay model | [settings.md](settings.md) |
| CLI entry point and window routing | [cli-and-windows.md](cli-and-windows.md) |
| Feature boundaries | [feature-boundaries.md](feature-boundaries.md) |

## Quality And Operations

| Topic | File |
|---|---|
| Testing strategy | [testing.md](testing.md) |
| Precision testing discipline | [testing-precision.md](testing-precision.md) |
| Startup instrumentation | [startup-instrumentation.md](startup-instrumentation.md) |
| Rendering pipeline | [rendering-pipeline.md](rendering-pipeline.md) |
| Huge-file scroll stabilizer | [scroll-stabilizer-bug.md](scroll-stabilizer-bug.md) |
| Mobile builds, signing, TestFlight/APK distribution, accounts and support | [mobile-deployment.md](mobile-deployment.md) |

## Retained Proposals

| Topic | File |
|---|---|
| Deferred UI proposals; original baseline is historical | [ui-design.md](ui-design.md) |
| Unfinished in-app marketplace proposal | [plugin-marketplace-design.md](plugin-marketplace-design.md) |
| Deferred technical ideas; implemented portions are marked | [P3-technical-plans.md](P3-technical-plans.md) |
