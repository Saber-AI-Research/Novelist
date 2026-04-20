# Template Files Panel — Design

**Date:** 2026-04-20
**Status:** Approved (in-conversation)
**Scope:** Add a per-project, insertable "templates" feature with a new right-side panel, bundled defaults, and a command-palette entry to save the current file as a template.

## 1. Goals & non-goals

**Goals**

- Let users save and reuse frequently-written documents (outline, character sheet, chapter skeleton, …) inside each project.
- Ship a small, curated set of bundled default templates that are always available.
- Expose two distinct insert gestures per template: **insert at cursor** or **create new file in project**.
- Provide a `⌘⇧P` command to turn the currently-open file into a template in one shot.
- Storage is plain, portable `.md` files with YAML front-matter — readable by any editor; the project folder stays legible.

**Non-goals (v1)**

- No nested folders inside `.novelist/templates/`; the directory is flat.
- No per-template category metadata (grouping is only Built-in vs Project).
- No prompting / interactive variables (`{{prompt:Title}}`). Only static tokens.
- No sharing / import / export from ZIP. Power-users can copy files by hand.
- No keyboard-launcher for individual templates; the command palette gets only `Save current file as template…`.

## 2. Terminology

- **Project-scaffold template** — the pre-existing whole-project generator at `core/src/commands/template.rs` → `~/.novelist/templates/<id>/`. Used from the "New Project" flow. **Unchanged by this design.**
- **Template file / snippet template** — this design. A single `.md` file with front-matter, stored at `<project>/.novelist/templates/*.md` (user-owned) or shipped from `core/bundled-templates/*.md` (read-only bundled).

User-facing copy calls both "templates" because the two live in different surfaces (scaffold in the project-creation dialog; snippet in the right panel), so users do not meet them side-by-side.

## 3. Storage layout

```
<project>/.novelist/templates/        # user templates (editable)
  outline.md
  chapter-skeleton.md
  …

core/bundled-templates/               # shipped with the app (read-only)
  outline.md
  characters.md
  worldbuilding.md
  chapter-skeleton.md
```

Bundled templates are wired through `core/build.rs` → Tauri `resources` (mirroring how `bundled-plugins/` is already done) and read at runtime from the resource dir; they are **never** written.

Flat directory — no subfolders. Template IDs are filename stems, validated against `^[a-z0-9][a-z0-9-]*$` (same rule the plugin scaffolder uses).

## 4. File format

```md
---
name: 人物设定
mode: new-file
description: 主要人物的基础设定表
defaultFilename: 人物设定.md
---
# {filename}

## 基本信息
- 姓名：
- 年龄：
- 身份：

## 性格

## 背景故事
$|$
```

**Front-matter fields** (YAML subset — string values only, no nested structures):

| Field              | Required | For mode    | Description                                                                 |
|--------------------|----------|-------------|-----------------------------------------------------------------------------|
| `name`             | yes      | both        | Display name shown in the panel.                                             |
| `mode`             | yes      | —           | `insert` or `new-file`.                                                      |
| `description`      | no       | both        | Tooltip / secondary line in the panel.                                      |
| `defaultFilename`  | yes for `new-file` | new-file | Target filename. Supports `{2N}/{3N}/{cN}/{CN}/{rN}` numbering placeholders. |

**Body features**

- **Caret anchor** (`insert` mode only): the literal string `$|$`. On insert, the marker is stripped and the caret is placed at that offset. If multiple markers are present, only the first is honored; the rest are stripped silently.
- **Variable tokens** (both modes, expanded at execution time):
  - `{date}` → `YYYY-MM-DD` (local time)
  - `{time}` → `HH:mm` (local time, 24h)
  - `{filename}` → stem of the currently-active editor file; `""` if none
  - `{project}` → project folder name; `""` if no project open
  - Unknown tokens are left verbatim (no error).

- `defaultFilename` additionally passes through the existing filename numbering resolver so `第{2N}章 {filename}.md` lands as `第03章 空白.md` just like the smart-new-file flow.

## 5. Rust backend

New module: `core/src/commands/template_files.rs`.

### Types

```rust
#[derive(Serialize, Deserialize, Type, Clone)]
pub struct TemplateFileSummary {
  pub id: String,
  pub source: TemplateSource,   // Bundled | Project
  pub name: String,
  pub mode: TemplateMode,       // Insert | NewFile
  pub description: Option<String>,
  pub default_filename: Option<String>,
}

#[derive(Serialize, Deserialize, Type, Clone)]
pub struct TemplateFile {
  pub summary: TemplateFileSummary,
  pub body: String,
}

#[derive(Serialize, Deserialize, Type, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TemplateSource { Bundled, Project }

#[derive(Serialize, Deserialize, Type, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TemplateMode { Insert, NewFile }
```

### Commands

| Command                                                                                            | Description                                                                                              |
|----------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| `list_template_files(project_dir: Option<PathBuf>) -> Vec<TemplateFileSummary>`                    | Enumerates bundled + project. If an `id` exists in both, the **project** one wins (user override).       |
| `read_template_file(source, id, project_dir) -> TemplateFile`                                      | Returns metadata + body.                                                                                 |
| `write_template_file(project_dir, id, front_matter: FrontMatterInput, body) -> TemplateFileSummary`| Creates or overwrites `<project>/.novelist/templates/<id>.md`. Atomic (temp + rename). Returns summary.  |
| `rename_template_file(project_dir, old_id, new_id) -> TemplateFileSummary`                         | Renames. Refuses if `new_id` exists. Only operates on the project directory.                             |
| `delete_template_file(project_dir, id)`                                                            | Deletes `<project>/.novelist/templates/<id>.md`. Bundled IDs fail with `AppError::InvalidArgument`.      |
| `duplicate_bundled_template(project_dir, bundled_id, new_id: Option<String>) -> TemplateFileSummary` | Copies bundled body+front-matter into project, auto-bumping `-2` on collision when `new_id` is `None`.   |

Validation

- `id` must match `^[a-z0-9][a-z0-9-]*$` and length ≤ 64.
- `project_dir` must exist and be a directory; the `.novelist/templates/` subdir is created lazily.
- `mode == NewFile` requires `default_filename` to be non-empty; validated in `write_template_file`.

Atomic write reuses the temp-then-rename helper already used for project files.

### Front-matter parser

Hand-rolled, ~100 LOC. Accepts:
- Opening `---` on line 1 (or after a BOM), closing `---` on its own line.
- `key: value` pairs, one per line.
- Values: plain unquoted string OR double-quoted string with `\"`, `\\`, `\n` escapes.
- Unknown keys are preserved and round-tripped on write (future-proofing without adding a dep).

## 6. Frontend

### New files

- `app/lib/components/TemplatePanel.svelte` — right-panel body.
- `app/lib/components/TemplateDialog.svelte` — modal for create/edit.
- `app/lib/stores/templates.svelte.ts` — `$state` summary list + `refresh()` + `executeTemplate()`.
- `app/lib/utils/template-tokens.ts` — pure helpers: `resolveBody(body, ctx)`, `extractCursorAnchor(body) → {body, anchor}`, `resolveFilename(template, ctx, numberingCtx)`.

### Modified files

- `app/lib/stores/ui.svelte.ts` — extend `RightPanel` union with `'template'`.
- `app/App.svelte` — add toggle button + `<TemplatePanel/>` render slot; register the `saveCurrentFileAsTemplate` command; wire keyboard shortcut (none by default, but a row in the Shortcuts settings).
- `app/lib/i18n/locales/{en,zh-CN}.ts` — ~20 new `template.*` keys.
- `app/lib/ipc/commands.ts` — auto-regenerated; do not hand-edit.

### UI — panel

```
┌─ Templates ──────────────────────┐
│  [+ New template]                │
│                                  │
│  BUILT-IN                        │
│    📄 Outline              · bu  │
│    📄 Characters           · bu  │
│    📄 Worldbuilding        · bu  │
│    ↳  Chapter skeleton     · bu  │
│                                  │
│  PROJECT                         │
│    📄 人物设定·王二         · pr  │
│    ↳  场景分隔线           · pr  │
│                                  │
│  (empty state: "No project        │
│   templates yet. Click + New.")  │
└──────────────────────────────────┘
```

- Primary click on a row executes the template (insert or create-file, depending on mode).
- Row is focusable, keyboard `Enter` executes, `Menu`/right-click opens context menu.
- Mode badge: `↳` for insert, `📄` for new-file (final glyphs may be refined during polish).

**Context menu**

- **Project row:** *Insert / Create file* · *Edit…* · *Duplicate* · *Rename…* · *Delete*
- **Bundled row:** *Insert / Create file* · *Duplicate to project…*

Delete always confirms with `template.confirmDelete`.

### UI — dialog

Fields:
- `name` (text, required)
- `mode` (radio: Insert / New file)
- `defaultFilename` (text, shown only when mode = new-file, supports the `{2N}/...` placeholders)
- `description` (optional text)
- `body` (multi-line textarea, auto-grows)

Save button is disabled until required fields are filled. Cancel closes without writing. "Save current file as template…" from the palette pre-fills `body` with the active editor's content and `name` with the file stem.

### UI — execution semantics

**Insert mode**

1. `read_template_file` to get full body.
2. `ctx = { date, time, filename: activeFileStem, project: projectFolderName }`.
3. `resolved = resolveBody(body, ctx)`.
4. `{ text, anchor } = extractCursorAnchor(resolved)`.
5. `view = getActiveEditorView()`. If absent, show toast `template.needActiveEditor` and abort.
6. `from = view.state.selection.main.from`; `to = view.state.selection.main.to`.
7. `view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + (anchor >= 0 ? anchor : text.length) } })`.
8. `view.focus()`.

**New-file mode**

1. Resolve body (same as insert).
2. Resolve `defaultFilename` via the existing filename resolver.
3. Target directory:
   - If the sidebar file-tree has a selected folder, use it.
   - Else use the project root.
4. Call a new Rust command `create_file_with_body(dir, filename, body, allow_collision_bump: true) -> String` (returns resolved path). Reuses existing collision-bump logic from `rename_item`.
5. Open the resulting path as a new tab.

If the operation fails, show a toast with the error message and keep the panel open.

### Command palette

- `template.saveCurrentFileAsTemplate` — opens the dialog with `body` pre-filled from the active editor and `name` pre-filled from its stem. Disabled when no editor is active.

No per-template palette entries in v1.

## 7. Bundled defaults

Four templates, modeled on the long-novel project-scaffold content already in `template.rs`. Stored as real files at `core/bundled-templates/*.md` with front-matter.

| File                   | id                 | mode      | Notes                                                                  |
|------------------------|--------------------|-----------|-----------------------------------------------------------------------|
| `outline.md`           | `outline`          | new-file  | `defaultFilename: 大纲.md`. Body: outline skeleton from long-novel.    |
| `characters.md`        | `characters`       | new-file  | `defaultFilename: 人物设定.md`. Body: character sheet skeleton.        |
| `worldbuilding.md`     | `worldbuilding`    | new-file  | `defaultFilename: 世界观.md`. Body: worldbuilding skeleton.            |
| `chapter-skeleton.md`  | `chapter-skeleton` | insert    | Body: `# {filename}\n\n$|$`. Caret lands after the heading.            |

Source strings are lifted from the existing long-novel scaffolder (same UX, same vocabulary).

## 8. Testing

**Rust unit tests** (`core/src/commands/template_files.rs` `#[cfg(test)]` module)

- Front-matter parser: happy path, quoted strings, escapes, unknown keys preserved, missing close fence, BOM.
- List: only bundled, only project, overlap (project wins).
- Write → list round-trip.
- Rename: success, collision rejected, bundled rejected.
- Delete: success, bundled rejected, unknown id yields `AppError::NotFound`.
- Duplicate: default id bump, explicit id, collision with explicit id fails.

**Vitest unit tests** (`tests/unit/utils/template-tokens.test.ts`, `tests/unit/stores/templates.test.ts`)

- `resolveBody` expands all supported tokens; leaves unknowns verbatim.
- `extractCursorAnchor` — no marker, single marker, multiple markers (first wins).
- `resolveFilename` — passes through to the existing numbering resolver; respects `{filename}`.

**Playwright E2E** (`tests/e2e/specs/templates.spec.ts`)

- Open panel (right-side toggle). Assert Built-in group has four rows.
- Click `chapter-skeleton` → active editor contains the heading and caret is at the anchor.
- Click `outline` → new tab opens with `大纲.md`.
- `⌘⇧P` → `Save current file as template…` → dialog opens pre-filled → save → row appears under Project.
- Right-click a project row → Rename → refresh shows new id.
- Right-click a project row → Delete (confirm) → row disappears.
- Right-click a bundled row → menu has no Delete.

Tauri IPC mock (`tests/e2e/fixtures/tauri-mock.ts`) gains handlers for the six new commands.

## 9. Risks & mitigations

- **Conflation with project-scaffold templates.** Two features share the word "template"; solved by keeping them on different surfaces (project-creation dialog vs right panel) and different storage (`~/.novelist/templates/` vs `<project>/.novelist/templates/`).
- **Front-matter leaking into rendered preview.** Body passed to the editor / file create already has front-matter stripped by `read_template_file`. Direct `Open template file…` is a v2 concern; for v1 we do not surface a raw-edit action on the file.
- **Tokens meeting literal braces in user content.** Tokens are expanded at execution time only on template bodies, not on user-authored content; literal `{date}` in a user's prose is never touched because it never enters the token resolver.
- **Caret anchor conflicts with the numbering placeholders.** The anchor is `$|$` (dollar-pipe-dollar) — disjoint from the `{xN}` namespace. No parser ambiguity.

## 10. Rollout

Single PR / single commit train:

1. Bundled files + build.rs wiring.
2. Rust module + tests.
3. Frontend store + utils + tests.
4. Panel + dialog.
5. App.svelte wiring + i18n.
6. E2E tests + mock handlers.
7. CLAUDE.md "Recent Additions" entry.

No feature flag. No migration — new feature, additive only.
