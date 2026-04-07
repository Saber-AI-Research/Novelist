# Novelist Phase 3: File Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add file watching (detect external edits), auto-save (5-min interval), conflict resolution, self-trigger suppression, and large file tier detection.

**Architecture:** Rust backend runs a `notify` file watcher per open project, debounces events, checks blake3 hashes to detect real changes, and emits Tauri events to the frontend. Frontend handles conflict prompts and auto-save timer. Large files (>1MB) disable WYSIWYG decorations for performance.

**Tech Stack:** notify 7, blake3, tokio, ropey (for future huge file mode), Tauri events

**Spec:** `design/design-overview.md` sections 5.3, 5.4

**Scope:** File watcher, conflict detection, auto-save, self-trigger suppression, large file tier detection (disable WYSIWYG >1MB). The "huge file viewport mode" (>10MB with ropey) is deferred to a later phase due to complexity.

---

### Task 1: File Watcher Service (Rust)

**Files:**
- Create: `src-tauri/src/services/mod.rs`
- Create: `src-tauri/src/services/file_watcher.rs`
- Modify: `src-tauri/src/models/file_state.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands/mod.rs`

Implement:
- `FileState` struct: `{ path, mtime, blake3_hash }` per open file
- `FileWatcherService` managed by Tauri state:
  - `start_watching(dir_path)` — creates a `notify::RecommendedWatcher` on the directory
  - Debounces events (100ms) before processing
  - On file change: compute blake3 hash, compare with stored hash
  - If hash differs and file is in the open file set: emit Tauri event `file-changed` with `{ path, external: bool }`
- Self-trigger suppression: `IgnoreSet` — before each write, register `(path, Instant::now())`. Watcher checks ignore set, skips if path has token < 2s old.
- Commands:
  - `start_file_watcher(dir_path: String)` — start watching a directory
  - `stop_file_watcher()` — stop watching
  - `register_open_file(path: String)` — track a file for change detection (compute initial hash)
  - `unregister_open_file(path: String)` — stop tracking

Update `write_file` in `commands/file.rs` to register an ignore token before writing.

### Task 2: Auto-Save and Conflict Resolution (Frontend)

**Files:**
- Modify: `src/lib/components/Editor.svelte`
- Modify: `src/lib/stores/tabs.svelte.ts`
- Create: `src/lib/components/ConflictDialog.svelte`
- Modify: `src/App.svelte`

Implement:
- Auto-save timer: every 5 minutes, save all dirty tabs via IPC
- Listen to Tauri event `file-changed`:
  - If file is NOT dirty in editor → auto-reload silently
  - If file IS dirty → show ConflictDialog with "Keep Mine" / "Load Theirs" options
- ConflictDialog: simple modal with two buttons
- On project open (Sidebar): call `start_file_watcher`
- On file open: call `register_open_file`
- On file close: call `unregister_open_file`

### Task 3: Large File Tier Detection

**Files:**
- Modify: `src/lib/components/Editor.svelte`
- Modify: `src/lib/editor/setup.ts`

Implement:
- In Editor.svelte, when opening a file: check file size from FileEntry
- If size > 1MB: create editor WITHOUT wysiwygPlugin (plain markdown highlighting only)
- If size <= 1MB: create editor WITH wysiwygPlugin (full WYSIWYG)
- `createEditorExtensions()` takes an optional `{ wysiwyg: boolean }` parameter

---

## Phase 3 deliverables:
- File watcher detects external changes
- Conflict dialog for dirty files
- Auto-save every 5 minutes
- Self-trigger suppression prevents reacting to own saves
- Large files (>1MB) gracefully degrade to plain highlighting
