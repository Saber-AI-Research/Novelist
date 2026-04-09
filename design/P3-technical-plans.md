# P3 Long-term Technical Plans

## 1. Version Snapshots (版本快照)

**Goal:** Let writers create named snapshots of their work without requiring Git knowledge.

### Architecture

```
~/.novelist/snapshots/<project-hash>/
  <snapshot-id>/
    metadata.json     # { name, timestamp, file_count, total_bytes }
    files/
      chapter-01.md
      chapter-02.md
      ...
```

### Implementation

**Backend (Rust):**
- New module `src-tauri/src/services/snapshots.rs`
- Commands:
  - `create_snapshot(project_dir, name)` — copy all .md files + metadata into snapshot dir, use BLAKE3 hash of project path as namespace
  - `list_snapshots(project_dir)` — list all snapshots sorted by time
  - `restore_snapshot(project_dir, snapshot_id)` — overwrite project files with snapshot content (with confirmation)
  - `diff_snapshot(project_dir, snapshot_id, file_path)` — return line-level diff between current and snapshot version
  - `delete_snapshot(snapshot_id)` — remove a snapshot
- Storage: flat file copy (not git). Simple, no dependency. ~O(project size) per snapshot.
- Consider: LZ4 compression for large projects (add `lz4_flex` crate)

**Frontend (Svelte):**
- New component `SnapshotPanel.svelte` in the right panel area (alongside Outline/Draft)
- UI: List of snapshots with name, date, file count. Buttons: Create, Restore, Diff, Delete
- Diff view: Side-by-side or inline diff using a lightweight diff library (e.g., `diff-match-patch` or compute diff in Rust and send colored ranges)

**Key decisions:**
- Copy-based, not delta-based (simpler, acceptable for text files)
- Max snapshot count per project: 50 (configurable in project.toml)
- Auto-snapshot on export? (nice-to-have)

**Estimated scope:** ~500 LOC Rust, ~300 LOC Svelte. 1 new dependency (optional LZ4).

---

## 2. Outline Drag-and-Drop Reorder (大纲拖拽重排)

**Goal:** Allow writers to reorder chapters/sections by dragging headings in the Outline panel.

### Architecture

The Outline panel shows extracted headings. Drag-and-drop a heading = move that section's text (from heading line to next same-level heading) to the target position.

### Implementation

**Frontend:**
- Modify `src/lib/components/Outline.svelte` to add HTML5 drag-and-drop on each heading item
- On drop, compute:
  1. Source range: from source heading's `from` to next sibling heading's `from` (or end of doc)
  2. Target position: before the target heading's `from`
- Dispatch a CodeMirror transaction that:
  1. Deletes the source range
  2. Inserts it at the adjusted target position
  3. Wraps both in a single transaction for atomic undo

**Key challenges:**
- **Range calculation:** Must handle nested headings correctly. Moving an H2 should move its child H3/H4 sections too.
- **Position adjustment:** After deletion, insertion position shifts. Calculate offset carefully.
- **Large files:** For viewport-mode tabs, the edit must go through the Rope backend instead.

**Algorithm (pseudocode):**
```
function moveSection(doc, sourceHeadingFrom, targetHeadingFrom):
  sourceEnd = findNextSiblingHeading(doc, sourceHeadingFrom) ?? doc.length
  sectionText = doc.slice(sourceHeadingFrom, sourceEnd)
  
  if targetHeadingFrom > sourceHeadingFrom:
    adjustedTarget = targetHeadingFrom - (sourceEnd - sourceHeadingFrom)
  else:
    adjustedTarget = targetHeadingFrom
  
  return { delete: [sourceHeadingFrom, sourceEnd], insert: [adjustedTarget, sectionText] }
```

**Visual feedback:**
- Drag ghost: show heading text
- Drop indicator: horizontal line between headings
- Invalid drop zones: same position, or dropping parent inside child

**Estimated scope:** ~200 LOC Svelte (drag UI), ~100 LOC TypeScript (range calc). No new dependencies.

---

## 3. Writing Goals & Statistics (字数目标与统计)

**Goal:** Track daily writing progress, per-chapter word counts, and writing time.

### Architecture

```
~/.novelist/stats/<project-hash>/
  daily.json        # { "2026-04-08": { words_written: 1234, time_minutes: 45 } }
  sessions.json     # [{ start, end, words_start, words_end, file }]
```

### Implementation

**Backend (Rust):**
- New module `src-tauri/src/services/writing_stats.rs`
- Commands:
  - `start_writing_session(project_dir)` — record session start time + current total word count
  - `end_writing_session(project_dir, final_word_count)` — compute delta, save session
  - `get_daily_stats(project_dir, date_range)` — return daily aggregates
  - `get_chapter_stats(project_dir)` — return per-file word counts
- Session tracking: start on first keystroke after opening, end on app close or 5-min idle

**Frontend:**
- Modify `StatusBar.svelte`: show daily progress bar (already has `dailyGoal` + `goalPercent` derived values, extend them)
- New component `StatsPanel.svelte`:
  - Daily chart: simple bar chart of last 7/30 days (CSS-only bars, no charting library needed)
  - Per-chapter table: file name, word count, percentage of total
  - Writing streaks: consecutive days with words written
  - Session history: recent sessions with duration and word delta
- Project config extension (`project.toml`):
  ```toml
  [writing]
  daily_goal = 2000
  weekly_goal = 10000  # new
  ```

**Key decisions:**
- Stats stored locally, not synced (privacy-first)
- Word count delta = (end count - start count), can be negative (editing/deleting is normal)
- Idle detection: if no keystrokes for 5 min, pause session timer
- Chart rendering: pure CSS (no D3/chart.js), keep bundle small

**Estimated scope:** ~300 LOC Rust, ~400 LOC Svelte. No new dependencies.

---

## 4. Multi-device Sync (多设备协作/同步)

**Goal:** Sync novel projects across multiple devices.

### Architecture Options

#### Option A: File-based sync (Recommended for v1)
Leverage existing file sync services (iCloud, Dropbox, Syncthing) by keeping projects as plain files.

**What Novelist adds:**
- Conflict detection: enhanced file watcher that detects merge conflicts from sync services
- Lock files: `.novelist/locks/<filename>.lock` with device ID + timestamp to prevent concurrent editing
- Merge tool: for .md files, use line-level 3-way merge (common ancestor from last snapshot)

**Pros:** Zero infrastructure, works with any sync service, users already have these tools
**Cons:** No real-time collaboration, sync latency depends on service

#### Option B: CRDT-based real-time sync (Future)
Use a CRDT library for conflict-free real-time collaboration.

**Tech stack:**
- CRDT: `y-crdt` (Yjs Rust port) or `automerge`
- Transport: WebSocket to a lightweight relay server
- Server: Cloudflare Workers + Durable Objects (or self-hosted)

**Architecture:**
```
Device A (Novelist) <-> WebSocket <-> Relay Server <-> WebSocket <-> Device B (Novelist)
                                         |
                                    Durable Object
                                    (CRDT state)
```

**Implementation sketch:**
1. Replace CodeMirror's internal doc model with a CRDT-backed text type
2. Each keystroke → CRDT update → broadcast to peers
3. Relay server stores CRDT state for offline sync
4. On reconnect, merge diverged states (conflict-free by definition)

**Key challenges:**
- **CodeMirror + CRDT integration:** Need `y-codemirror.next` or custom binding
- **CJK IME handling:** Composition events must be buffered before applying to CRDT
- **Offline-first:** Full CRDT state must be persisted locally
- **Server cost:** Durable Objects charge per-request, but writing apps have low request volume

**Pros:** Real-time collaboration, conflict-free, works offline
**Cons:** Significant complexity, requires server infrastructure, increases app size

### Recommendation

**Phase 1:** Option A (file-based sync awareness) — 2-3 days of work
- Enhanced conflict detection for iCloud/Dropbox synced folders
- Lock file protocol
- Better merge dialog

**Phase 2:** Option B (CRDT) — evaluate after v0.5 based on user demand
- Only justified if users specifically request real-time collaboration
- Conflicts with "keep desktop lean" principle unless server is a separate service

**Estimated scope:**
- Phase 1: ~400 LOC Rust, ~200 LOC Svelte
- Phase 2: ~2000+ LOC, new crate dependencies, server component
