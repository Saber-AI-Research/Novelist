# New-User Onboarding

Status: draft
Last updated: 2026-11-03

## Goal

A first-time writer should understand the app within one minute and create
or open a project without reading documentation.

## Desired First Session

1. The user opens Novelist.
2. The welcome surface offers recent projects, open folder, and create new
   project.
3. A new project starts with a small, useful structure and bundled template
   options.
4. The first editor view demonstrates plain Markdown writing without a modal
   tutorial.
5. Export, templates, mindmap, and settings remain discoverable but do not
   interrupt writing.

New devices must support this whole flow without registration, login or a
network connection. Signed-out use is a permanent, fully supported mode.
Optional login can later restore selected configuration and WebDAV connection
information without replacing local projects. See
[optional account and configuration sync](2026-11-03-optional-account-and-config-sync.md).

## Acceptance Criteria

- A fresh installation can create/import, edit, save, reopen and export a
  local project while signed out and offline, with no blocking login screen.
- Manual WebDAV setup does not require a Novelist account; connecting to a
  remote server naturally requires network access.
- New project creation is possible without touching the filesystem manually.
- The default project includes at least one editable Markdown file.
- The first file can be saved, closed, reopened, and exported.
- CJK text can be typed immediately through an IME.
- The user can find keyboard shortcuts and template insertion from visible
  controls or command palette search.

## Test Harness

- Browser E2E: welcome, new project, template creation, editor typing.
- Rust tests: project scaffold and template file commands.
- Manual release smoke: create project, write CJK paragraph, export HTML.
