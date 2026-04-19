# Project-mode New File Naming, H1 Auto-rename, and File-tree Sort

**Date**: 2026-04-19
**Status**: Draft (awaiting user review)
**Scope**: Project mode only. Single-file (scratch) mode is unchanged.

---

## 1. Goals

1. **Frictionless new file**: in project mode, "New file" creates a real file on disk with a sensible name — no save dialog, no timestamp-junk filename.
2. **Smart chapter inference**: when the active folder already contains chapter-like files (`第一章.md`, `01-intro.md`, `Chapter 1.md`, …), the new file gets the next number in that sequence.
3. **H1 auto-rename**: while a file's name is still a system-generated placeholder, saving the file renames it to match the first H1. Once the user manually renames it, auto-rename stops (Option B from brainstorming).
4. **User-configurable default template**: when no chapter pattern can be inferred, fall back to a template the user picks in Settings (default `Untitled {N}`).
5. **Numeric-aware file tree sort**: the sidebar must order `第二章.md` before `第十章.md`, not after. Provide explicit sort modes (name/number, asc/desc, optionally by mtime) the user can toggle.

These changes touch the save pipeline non-trivially. §7 details the architectural impact and risk mitigation.

---

## 2. Behavior Matrix

| Trigger | Condition | Result |
|---|---|---|
| Sidebar **+** / Cmd+N / palette "New File" | Project open | Compute filename (see §3), `create_file`, open tab. **No dialog.** |
| Sidebar **+** | No project (single-file mode) | Existing scratch behavior — unchanged |
| Save (Cmd+S) | Tab's filename is in placeholder set, doc has H1 | Atomic write, then `rename_item` to new name, update tab + window title |
| Save (autosave timer) | Same as above | Same as above (rename runs on every save while still placeholder) |
| Save | Filename **not** in placeholder set | Atomic write only (current behavior) |
| Save | Placeholder filename, doc has **no** H1 | Atomic write only; filename stays placeholder |
| Sidebar rename, drag-drop, external rename | Any | File leaves placeholder set permanently |
| Settings: change default template | — | Saved to settings; affects new files only; existing files untouched |

Once-and-only-once: a file becomes "placeholder" the moment Novelist creates it via the new-file flow, and stops being placeholder the moment its filename successfully transitions to one derived from H1 (or the user renames it). After that, the H1 path is dead for this file.

---

## 3. Pattern Library

### 3.1 Number Forms

| Form | Examples | Notes |
|---|---|---|
| Arabic | `1`, `2`, `42` | Width preserved per file: if the existing series uses `01`, the next is `02..09..10`, not `10` |
| Arabic padded | `01`, `001` | Width detected from the **maximum padding** in the series |
| Chinese lower | `一 二 … 十 十一 … 九十九 一百 …` | Implementation supports 1–999 |
| Chinese upper | `壹 贰 叁 …` | Recognized; generated only if the series uses them |
| Roman | `I II III IV V …` | Optional, gated by `if any file in folder matches`; never auto-applied otherwise |

The number-formatter and number-parser live in `app/lib/utils/numbering.ts` and are pure functions — fully unit-testable.

### 3.2 Wrapping & Punctuation

Brackets/quotes commonly seen around chapter numbers or titles:

```
[]   【】   （）   ()   「」   『』   ""   ''   <>   《》
```

Recognition: any of these may surround the number, the title, or both.
Generation: copy whatever wrapping is dominant in the folder. If mixed, pick the most-common; on tie, pick the first encountered.

### 3.3 Templates (Recognition + Generation)

Each template = `{ prefix, number_form, separator, title_slot?, wrap? }`. Recognition is a regex per family; generation re-renders with the same shape.

**Chinese chapter prefixes** (no title slot — H1 appends with space):
- `第{N}章`, `第{N}回`, `第{N}节`, `第{N}卷`, `第{N}部`
- `卷{N}`, `章{N}`
- `{N}、`, `{N}.`, `{N}：` (numeric list)
- Wrapped: `【第{N}章】`, `[第{N}章]`, `（第{N}章）`, `「第{N}章」`

**Western chapter prefixes** (no title slot):
- `Chapter {N}`, `Ch{N}`, `Ch.{N}`
- `Part {N}`, `Volume {N}`, `Vol{N}`, `Section {N}`
- Wrapped variants: `[Chapter {N}]`, etc.

**Number-prefix with title slot** (literal `Untitled` initially, replaced by H1):
- `{N}-{title}`, `{N}_{title}`, `{N}.{title}`, `{N} {title}`, `{N}{title}` (no-sep)

**Suffix forms**:
- `{title}-{N}`, `{title}_{N}`, `{title} {N}`

**Bare**:
- `{N}` (just the number, e.g., `01.md`)

**Special skip-list** (excluded from sequence inference, recognized as siblings but not advanced):
- 序章, 序, 楔子, 引子, 前言, 终章, 尾声, 番外, 后记, 附录
- Prologue, Epilogue, Foreword, Afterword, Appendix

### 3.4 Inference Rules at New-File Time

1. List sibling files in the **target folder** (the folder the user is creating the file in — root if no folder is focused, otherwise the focused folder).
2. Try each template family. A family **matches the folder** when:
   - At least **2** sibling files match the same template (auto-detect threshold), **OR**
   - The user-configured default template (from Settings) is in this family (threshold drops to 0)
3. Among matching families, pick the one with the most matches. Ties: the order of the table above.
4. The proposed number is `max(matched numbers) + 1`. Width / wrapping / punctuation copied from the dominant existing match. When the family was selected via the "default template" path (no existing files matched), use the template's literal shape as-is — width 1 for Arabic, single Chinese-lower digit for `{N}` in `第{N}章`, etc.
5. Title slot (if the template has one) initially filled with `Untitled`.
6. Collision handling: if the proposed filename already exists, **bump the number** until free (`第三章` taken → try `第四章`). For templates without a sequential number (rare — only the bare default), append ` 2`, ` 3`, …

### 3.5 H1 → Filename Replacement

When a save fires and the current filename matches a placeholder template:

| Filename now | H1 text | New filename |
|---|---|---|
| `Untitled 1.md` | `开篇` | `开篇.md` |
| `Untitled 1.md` | (empty) | unchanged |
| `第三章.md` | `开篇` | `第三章 开篇.md` |
| `Chapter 3.md` | `Opening` | `Chapter 3 Opening.md` |
| `03-Untitled.md` | `开篇` | `03-开篇.md` |
| `03_Untitled.md` | `Opening` | `03_Opening.md` |
| `【第三章】.md` | `开篇` | `【第三章】开篇.md` (no space when wrap is closing bracket) |

Rule: if the template has a `{title}` slot, the literal `Untitled` substring is replaced by the H1; otherwise the H1 is appended after the existing stem with a single space — except no space is inserted when the stem ends in any of: `]`, `】`, `）`, `)`, `」`, `』`, `>`, `》`, `:`, `：`, `、`, `.`.

H1 sanitization (filename-safe):
- Strip leading `# ` and trailing whitespace
- Strip `.md` if the user accidentally typed it
- Replace forbidden filesystem chars (`/ \ : * ? " < > |`) with `-`; collapse repeats
- Trim length to 80 chars (UTF-8 char-aware, not byte-aware)
- If empty after sanitization → no rename
- If starts with `.` → prepend `_` (avoid hidden files)

After successful rename, the file is no longer in the placeholder set. Future H1 edits do nothing.

---

## 4. Settings UI

New section in **Settings > Editor**, between "Auto-save" and "Language":

```
┌─ New file in project ─────────────────────────────────┐
│                                                       │
│ Detect chapter patterns from folder         [✓]       │
│   When on, scans the folder and picks the next        │
│   number in the existing series.                      │
│                                                       │
│ Default filename template                             │
│ ┌───────────────────────────────────┐  ▾ presets      │
│ │ Untitled {N}                      │                 │
│ └───────────────────────────────────┘                 │
│ Used when no folder pattern is detected.              │
│ Preview: Untitled 1.md, Untitled 2.md, Untitled 3.md  │
│                                                       │
│ Auto-rename placeholder files from H1       [✓]       │
│   Only affects auto-generated names.                  │
│   Stops once you manually rename.                     │
│                                                       │
└───────────────────────────────────────────────────────┘
```

**Preset dropdown** options:
- `Untitled {N}` (default)
- `第{N}章`
- `Chapter {N}`
- `{N}-{title}`
- `{N}.{title}`
- *Custom…* (keeps whatever the user typed)

**Template syntax** (v1 — minimal):
- `{N}` — the number; width matches the existing folder series, else 1 digit / Chinese-lower
- `{title}` — optional title slot, populated with `Untitled` initially
- All other characters are literal

**Validation**: template must contain `{N}` exactly once. UI shows a red hint when invalid.

**Persistence**: settings stored alongside other editor prefs (existing settings backend / localStorage path — to be confirmed during implementation). Per-app, not per-project (v1 — see §10 open question 1).

---

## 5. File-tree Sort

### 5.1 Sort Modes

Frontend-only. Backend `list_directory` returns entries unsorted; `projectStore` sorts each level on render. (Backend change: drop the current "folders first + lowercase alpha" sort to avoid double-work; or keep it as a stable default and let frontend re-sort. Decision: **drop backend sort**, single source of truth.)

| Mode ID | Behavior |
|---|---|
| `name-asc` | Locale-aware string compare, case-insensitive |
| `name-desc` | Reverse of above |
| `numeric-asc` *(default)* | Extract leading/trailing number per filename; sort by `(group, number, residual_string)`. Files with no number sort after numbered files within their group. |
| `numeric-desc` | Reverse |
| `mtime-desc` | Recently modified first (requires backend to return mtime — already in `FileEntry`?) |
| `mtime-asc` | Oldest first |
| `created-desc` / `created-asc` | If creation time is available; else hide these modes |

Independent of sort mode: **folders always grouped first**, then files. (Toggle to mix folders/files is YAGNI v1.)

### 5.2 Numeric Sort Algorithm

For each filename:
1. Find the leftmost run of decimal digits OR Chinese numerals (whichever appears first; or if both, the leftmost wins).
2. If found, split the name into `(prefix, number, suffix)`.
3. Sort key: `(prefix.toLowerCase(), parsed_number, suffix.toLowerCase())`.
4. Files with no number sort by `(name.toLowerCase(),)` and rank after files with numbers when prefixes match.

Examples sorted ascending:
```
第一章.md       → ("第", 1, "章.md")
第二章.md       → ("第", 2, "章.md")
第十章.md       → ("第", 10, "章.md")
第二十一章.md   → ("第", 21, "章.md")
01-intro.md     → ("", 1, "-intro.md")
02-rising.md    → ("", 2, "-rising.md")
10-finale.md    → ("", 10, "-finale.md")
notes.md        → no number, sorts after all the above within the same prefix group
```

The numeric-parser **reuses the parser from §3.1** (single source of truth; tested once).

### 5.3 UI

Sidebar header gets a small sort menu (icon button with dropdown, next to the existing folder name area):

```
[ project-name           ⇅▾  + ]
                         │
                         ├ Name (A → Z)
                         ├ Name (Z → A)
                         ├ Number (1 → N)   ✓
                         ├ Number (N → 1)
                         ├ Modified (newest)
                         └ Modified (oldest)
```

Persistence: per-project (so a novel uses numeric, a docs folder uses alpha). Stored in the project config (`.novelist/project.json` or equivalent — confirm path during implementation). Falls back to global default on first open.

---

## 6. Save Function — Architectural Changes

This is the biggest change. The new responsibility: **after a successful write, the save call may rename the file**, which cascades through tabs, window title, sidebar, file watcher, and encoding state.

### 6.1 Current save flow (as-is)

```
Cmd+S / autosave
  → tabsStore.syncFromView(tabId)         // pull content from CodeMirror
  → commands.writeFile(path, content)      // backend atomic write
       └ writes self-write hash so the watcher ignores the next event
  → tab.isDirty = false
```

### 6.2 New save flow (to-be)

```
Cmd+S / autosave
  → tabsStore.syncFromView(tabId)
  → commands.writeFile(path, content)
  → if isPlaceholder(path):
        h1 = extractFirstH1(content)
        if h1:
            newName = renderName(path, template, h1)
            newName = resolveCollision(parentDir, newName)
            if newName != basename(path):
                newPath = await commands.renameItem(path, newName, { allowCollisionBump: true })
                // backend registers (oldPath, newPath) as a self-rename
                tabsStore.updatePath(tabId, newPath)        // also updates split-pane sibling tabs
                projectStore.refreshTreeForFolder(parentDir(newPath))
                emit('tab-renamed', { tabId, oldPath, newPath })  // for other windows
  → tab.isDirty = false
```

### 6.3 New / modified backend pieces

- **`rename_item` enhancement**: add an `allow_collision_bump: bool` argument. When true, on collision, append ` 2`, ` 3`, … (mirrors `create_file`'s logic). Returns the actual final path.
  - Backwards-compat: existing call sites pass `false` (or we make it `Option<bool>` defaulting to false).
- **File watcher self-rename suppression**: extend the existing `WriteIgnore` set in `core/src/services/file_watcher.rs` to also ignore a `Rename(old, new)` event. Add a `register_rename_ignore(old_path, new_path)` API; `rename_item` calls it before `tokio::fs::rename`.
- **Encoding state migration**: `EncodingState` keys by canonical path. After rename, transfer the entry from old key to new key.
- **`list_directory`**: drop the in-Rust sort (sort moves to frontend); keep returning unsorted entries.

### 6.4 Frontend pieces

- **`app/lib/utils/numbering.ts`** *(new)*: pure number parser/formatter (Arabic / Chinese / Roman); used by both placeholder generation and numeric sort.
- **`app/lib/utils/placeholder.ts`** *(new)*: template parsing, placeholder detection (`isPlaceholder(filename, template)`), filename rendering, H1 → filename replacement, sanitization.
- **`app/lib/utils/h1.ts`** *(new)*: extract first H1 from markdown (skip frontmatter, skip code blocks).
- **`app/lib/stores/tabs.svelte.ts`**: new `updatePath(tabId, newPath)` method; broadcast `tab-renamed` event for cross-window tabs / split-pane siblings.
- **`app/lib/stores/project.svelte.ts`**: holds the `sortMode` rune (per project); sort applied in the `FileNode` tree builder; `refreshTreeForFolder(path)` for targeted refresh after rename.
- **`app/lib/components/Sidebar.svelte`**: sort dropdown UI in header.
- **`app/lib/components/Settings.svelte`**: new "New file in project" section with template input + preset dropdown + preview line.
- **`app/App.svelte`**: `handleNewFile` no longer creates `novelist_scratch_<ts>.md` — it calls `placeholder.computeNewName(folder, template)` first.
- **`app/lib/utils/scratch.ts`**: keep `isScratchFile` for legacy single-file scratch only; project-mode placeholder detection moves to `placeholder.ts`. (Migration: existing `novelist_scratch_*` files in user folders are still recognized as placeholders for one release, then we remove the legacy regex.)

### 6.5 Multi-window / split-view consistency

- **Same file open in two windows**: window A renames → fires Tauri global event `file-renamed` (already infra exists for `recent-projects-changed`?  if not, add it). Window B's tabsStore listens, updates matching tab's `filePath`.
- **Same file in left + right split panes**: tabsStore should iterate **all** panes when updating filePath (currently `tabsStore.findByPath` may only return one). Audit during implementation.
- **Race on near-simultaneous saves from two windows**: writeFile is atomic per call; rename is atomic. Worst case: two renames target `开篇.md`, the second collision-bumps to `开篇 2.md`. Documented behavior, not a bug.

### 6.6 Failure modes

| Failure | Behavior |
|---|---|
| `writeFile` fails (disk full / permission) | Tab stays dirty; no rename attempted; existing error toast |
| Write succeeds, rename fails (target locked / permission) | File is saved (good); tab stays at old path; status bar warning ("Couldn't rename to '开篇.md'"); placeholder state preserved so next save retries |
| User undoes the H1 right after save | File already renamed; undo doesn't re-rename (rename isn't on the editor undo stack) — documented limitation |
| Frontmatter contains `title:` but no H1 | v1: ignored. v2 maybe use frontmatter title (open question 2) |
| Two H1s in doc | Use the first one |
| H1 inside fenced code block | Skipped by the H1 extractor |

---

## 7. Edge Cases — Folder Inference

- **Empty folder + default template `Untitled {N}`**: first file → `Untitled 1.md`. Good.
- **Empty folder + default template `第{N}章`**: first file → `第一章.md` (template-driven, no folder match needed).
- **Folder with mix of `第一章.md` and `notes.md`**: `第一章` matches chapter family (count 1 — below auto threshold of 2); user has no override → fall back to default template. Add a single 2nd matching file and inference kicks in.
- **Folder with `第二章.md` only (gap at 第一章)**: next is `第三章`. Doesn't try to fill gaps (YAGNI).
- **Folder with `序章.md` + `第一章.md`**: 序章 in skip-list → next is `第二章`.
- **Folder with `第一章.md, 第二章.md, 01.md`**: chapter family wins (count 2 vs. bare-number count 1) → `第三章.md`. When counts truly tie, the preference order in §10 Q3 decides.
- **Subfolder context**: "new file" target = currently focused folder in sidebar, else project root. Pattern inference uses **siblings within that folder only** — not recursive.

---

## 8. Test Plan

### 8.1 Vitest unit tests (`tests/unit/`)

Pure functions, no IPC. New files:

`tests/unit/utils/numbering.test.ts`
- Arabic parse/format (incl. padding preservation)
- Chinese-lower parse/format (1, 10, 99, 100, 999)
- Chinese-upper parse/format (壹–玖, 拾)
- Roman parse/format (I, IV, IX, XL, XC)
- Edge: empty, non-numeric, zero, negative (reject)

`tests/unit/utils/placeholder.test.ts`
- Template parsing: `Untitled {N}` → descriptor; `第{N}章` → descriptor; `{N}-{title}` → descriptor with title slot
- Template validation: missing `{N}`, multiple `{N}`, malformed
- Folder inference: empty folder + default template, mixed folder, threshold logic, skip-list, tied families
- `isPlaceholder(filename)`: positive/negative cases for every template family + wrapping variants
- Render new name: H1 replacement vs. append, bracket/separator handling, sanitization
- Collision bump

`tests/unit/utils/h1.test.ts`
- First-H1 extraction
- Skip frontmatter (`---` block at top)
- Skip fenced code blocks (```)
- Skip indented code blocks (4-space)
- Setext heading (`Title\n====`) — recognize as H1
- ATX heading variants (`#`, `# `, `#  `, with trailing `#`)
- No H1 → returns null

`tests/unit/stores/project-sort.test.ts` *(new)*
- Each sort mode produces expected order on a fixed input
- Numeric mode: `第二章.md < 第十章.md` (the bug we're fixing)
- Numeric mode: handles mixed Arabic + Chinese
- Folder grouping preserved across modes
- Files with no number ordered correctly within group

### 8.2 Rust tests (`core/src/commands/file.rs::tests`, `core/src/services/file_watcher.rs::tests`)

- `rename_item` with `allow_collision_bump=true`: collision bumps to ` 2`, ` 3`
- `rename_item` preserves file content
- `rename_item` updates encoding-state map key
- File watcher: `register_rename_ignore` suppresses the rename event
- File watcher: external rename (no ignore registered) **does** fire reload
- `list_directory` returns unsorted (verify the change)

### 8.3 E2E tests (`tests/e2e/specs/`)

`tests/e2e/specs/new-file-naming.spec.ts` *(new)*
- Project mode + empty folder + default template → `Untitled 1.md` appears in sidebar
- Project mode + folder with `第一章.md, 第二章.md` → new file is `第三章.md`
- Project mode + folder with `01-intro.md, 02-rising.md` → new file is `03-Untitled.md`
- Type `# 开篇`, Cmd+S → file renamed to `开篇.md` (sidebar updates, window title updates)
- Type `# 开篇`, autosave fires → same rename
- Manually rename file, then change H1 → no rename (placeholder state cleared)
- Settings: change template to `第{N}章` → new file in empty folder is `第一章.md`
- Collision: type `# 开篇` while `开篇.md` exists in folder → renamed to `开篇 2.md`

`tests/e2e/specs/sidebar-sort.spec.ts` *(new)*
- Default sort = `numeric-asc`; folder with `第二章.md, 第十章.md, 第一章.md` shows in order 1, 2, 10
- Switch to `name-asc`: order becomes 1, 10, 2 (lex)
- Switch to `name-desc`: reversed
- Switch to `mtime-desc`: most recently modified file is first
- Sort mode persists across reloads

E2E test fixture additions:
- `tauri-mock.ts`: handlers for `rename_item` (with collision-bump arg), `list_directory` (return unsorted)
- `mockState`: helper to seed file mtime

### 8.4 Manual smoke test (pre-release)

- Tier 3 (real Tauri) run of both new spec files
- Verify the rename does not bork file-watcher: open external `tail -F` on the file (or external editor) and ensure no spurious reload
- Two windows open same project, rename in window A, confirm tab updates in window B
- Split view with same file in both panes, rename, both tabs update
- 100-file folder with mixed patterns: sort modes complete in <50ms (perf sanity)

---

## 9. Implementation Phases

Suggested PR breakdown (each independently shippable):

**Phase 1 — Pure utility libs + tests** (no UI changes)
- `numbering.ts`, `placeholder.ts`, `h1.ts` + their unit tests
- `project-sort.ts` comparator + unit tests

**Phase 2 — Backend changes**
- `rename_item` collision-bump arg
- File watcher rename-ignore
- Encoding-state migration on rename
- `list_directory` drop sort
- Rust tests
- Regenerate TS bindings

**Phase 3 — Frontend wiring**
- `App.svelte::handleNewFile` uses placeholder lib
- Save flow in `Editor.svelte` / `tabsStore` calls rename
- `Sidebar.svelte` sort dropdown + header UI
- `projectStore` sortMode rune + tree sort
- `Settings.svelte` new section
- E2E mocks updated

**Phase 4 — E2E + polish**
- Both new E2E spec files
- I18n strings (en + zh-CN)
- Edge-case fixes from Tier-3 smoke

---

## 10. Open Questions (need user decision)

1. **Per-project vs. global template**: §4 currently says global. Some users may want a different default per project (novel vs. documentation). Add per-project override now or YAGNI? *Default if undecided: global only in v1.*
2. **Frontmatter `title:` field**: if doc has frontmatter with `title:` but no H1, should we use `title:` for the rename? *Default if undecided: no, H1 only — simpler.*
3. **Tied template families**: when two families match the same number of files (§7 example), what's the preference order? *Default: Chinese chapter > Western chapter > number-prefix-with-slot > number-prefix-no-slot > suffix > bare.*
4. **Sort scope of "always folders first"**: should this be a separate toggle, or hard-coded? *Default: hard-coded in v1, expose as toggle later if asked.*
5. **Migration of `novelist_scratch_*` files in user project folders**: keep recognizing them as placeholders for one release? *Default: yes, then remove the legacy regex.*
6. **`{N:02}` padding syntax**: implement now or v2? *Default: v2; v1 detects width from existing folder series only.*

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Save → rename race when autosave fires twice quickly | Medium | Serialize per tab: queue saves; rename is part of the save promise |
| File watcher reload loop (rename event missed by ignore) | High | Rename ignore registered **before** the syscall; integration test watches for unintended reloads |
| Two windows open same file; rename in one; the other writes to old path | Medium | Cross-window `file-renamed` event; if write to vanished path fails, surface error; explicit limitation in docs |
| User expects H1 rename to keep tracking H1 changes | Low | Documented in Settings copy ("Stops once you manually rename") and in `creating-themes.md`-style docs |
| Numeric sort surprises users who relied on lex order | Low | Default to `numeric-asc` but expose mode picker; persist per-project so the choice sticks |
| Bracket / quote handling differs across IMEs (full-width vs. half-width) | Low | Pattern lib treats full-width and half-width as separate variants but both recognized; generation copies the dominant style in the folder |

---

## 12. Out of Scope

- Renaming folders based on contents (only files)
- Bulk rename / batch operations
- Templates with multiple `{N}` placeholders
- Custom regex pattern editor in Settings (the preset list + free-form template covers 99% of cases)
- Sort by file size
- Collapsing the "always folders first" rule into a free toggle
