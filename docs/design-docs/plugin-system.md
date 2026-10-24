# Plugin System

## Layout

- Plugins live in `~/.novelist/plugins/<id>/` with `manifest.toml` +
  `index.js`. The id is the folder name: it must match `[a-z0-9][a-z0-9-]*`
  and equal `manifest.plugin.id`, and `ui.entry` must be a relative path of
  plain components inside that folder. `scan_plugins` skips (and logs) any
  folder breaking these rules, and every command (`set_plugin_enabled`,
  `load_plugin`, `reload_plugin`) rejects such ids before touching disk, so
  no plugin can claim another plugin's id or load code from outside the
  plugins folder.
- Sandboxed via QuickJS with permissions: `read` exposes
  `getDocument`/`getSelection`/`getWordCount`, `write` (which implies
  `read`) adds `replaceSelection`/`replaceRange`. QuickJS plugins have no
  filesystem or network API at all.
- Plugin commands appear in the command palette.
- Built-in plugins are bundled via `core/build.rs` → `core/bundled-plugins/`
  → Tauri resources → installed to `~/.novelist/plugins/` by
  `ensure_bundled_plugins` (version-gated). A plugin is `builtin` only when
  its folder ships in those bundled resources; the flag is computed by the
  host, never read from a manifest, and privileged host features gate on it.
  An update copies the bundled folder to a hidden `.<id>.staging-*` sibling,
  moves the old install aside and renames the staged copy into place, so an
  interrupted update never leaves a half-copied plugin carrying the new
  version; leftovers are removed on the next start.
- Enabling a plugin loads it first and persists the enabled flag only after a
  successful load. `plugin-settings.json` read-modify-write transactions are
  serialized and written atomically (temp + fsync + rename).

## QuickJS resource limits

Each loaded Rust-hosted plugin owns a lazily created QuickJS runtime with a
64 MiB heap limit, 256 KiB stack limit and 500 ms deadline per load/command.
The deadline covers injected API code, plugin code, getters and result conversion.
Source and aggregate returned text are bounded at 8 MiB; result arrays are
bounded at 10,000 entries because Rust-side copies are not charged to the JS heap.
Diagnostics are bounded without invoking untrusted exception stringification.

Failed reloads preserve the previous plugin. A failed command publishes no
partial replacements and drops only the offending plugin runtime/registrations,
discarding retained heap and queued jobs. Commands must finish synchronously;
Promise-returning handlers fail explicitly.

The 500 ms deadline is enforced through QuickJS's interrupt hook, which
native code such as the regex engine never polls: `/(a+)+$/` against a long
non-matching string would otherwise run forever. Every plugin therefore runs
on its own thread, and plugin JS never executes under the host lock. Callers
(on `spawn_blocking`) wait at most 2 s for a load or command; past that the
host drops the instance and its commands and reports a time-limit error. The
abandoned thread cannot be killed safely, so it keeps one CPU core busy until
the app quits, but every other plugin and IPC call stays responsive. These
are in-process limits, not OS isolation or limits on UI iframe plugins/total
app RSS.

## UI plugin isolation

UI plugins (panels and file handlers) run in iframes with
`sandbox="allow-scripts allow-forms allow-modals"` and no
`allow-same-origin`, so every plugin document gets an opaque origin: it can
script neither the host nor a sibling plugin frame, and has no
`localStorage`/IndexedDB/cookies. Plugin frames get no Tauri IPC.

Host and plugin talk over one `MessageChannel` per plugin document
(`app/lib/services/plugin-host-channel.ts`, plugin side
`plugins/host-channel.ts`). After the iframe's host-initiated load the host
transfers a port with `{ type: 'novelist-plugin-connect' }`; afterwards both
directions use only that port, and window `message` events carry no authority.
A later load the host did not initiate (the plugin navigated its own frame)
never receives a port: file handlers show their load error and release their
document sessions. Privileged features (the translation-reference bridge)
additionally require the host-computed `builtin` flag plus the permission.

Document content flows only to plugins holding `read`: panels receive
`content-update` and file handlers `file-open`/`file-sync` only with it, and
file handlers may send `file-state`/`file-save`/`mark-dirty` only with
`write`.

Bundled single-file entries are built through `singleFilePlugin()`
(`plugins/vite-single-file.ts`), which inlines every script and inserts a
CSP meta tag as the first `<head>` element: `default-src 'none'`, only the
build's own inline scripts by SHA-256, `style-src 'unsafe-inline'`,
`img-src data: blob:`, `connect-src 'none'`, no frames, forms or base URL.
HTML derived from a manuscript therefore cannot run handlers or reach the
network (`tests/e2e/specs/plugin-csp.spec.ts`). Third-party plugins are
responsible for their own CSP: an iframe plugin without one can still make
network requests from its opaque origin, although it never sees document
text without `read`.

## File-handler document sessions

`services/plugin-document-sessions.ts` owns the shared snapshots and per-file
write queue across plugin editor panes. Each iframe receives a host-issued
`documentId` for an exact tab/path/project/reload-version/content snapshot.
Mutating messages require that token and a valid revision; revoked snapshots
cannot overwrite a reload, navigation, or another pane's edit. Accepted state
updates every tab of the file and moves sibling iframes onto fresh tokens.
When the sibling still shows the same tab, path, project and reload version,
the host sends `file-sync` instead of `file-open` to plugins that announced
`capabilities: ['file-sync']` in `plugin-ready`; they swap the content in
place and keep caret, mode, scroll and focus, so typing in one split pane
never resets (or steals focus from) the other. Plugins without the capability
keep receiving `file-open`. Only still-current content is marked saved after
the queued write completes.

Racing local edits are not merged or silently marked saved. The host retains a
bounded history of revoked snapshots and exposes a rejected unsynchronized edit
in a conflict banner. Restoring it requires an explicit user action and a still
open target in the same project; dismissal keeps the shared version.

Plugins flush pending saves under their original token before adopting a new
`file-open` or `file-sync`, never under the new document's token. Bundled
plugin versions are advanced with protocol changes so the version-gated
installer updates existing installations. See
[Creating Plugins](../references/creating-plugins.md) for the current message
contract.

## WKWebView + asset protocol quirks

Getting UI plugins to work on macOS WKWebView was non-trivial. Violating
any of these rules causes silent 403s or blank iframes:

- **UI plugins use the asset protocol**: `tauri.conf.json` enables
  `assetProtocol` with scope `$HOME/.novelist/plugins/**`. On macOS,
  `convertFileSrc` encodes the absolute entry path as a single URL segment;
  WKWebView consequently resolves `./assets/...` at the protocol root instead
  of beside `index.html`.
- **Entries are single-file**: the asset protocol answers with
  `Access-Control-Allow-Origin: <app origin>`, so the opaque-origin plugin
  frame cannot load separate module scripts or stylesheets (they are CORS
  requests). Every bundled plugin builds with `singleFilePlugin()`. Sandboxed
  frames do load the asset-protocol entry document itself: WebKit's block on
  custom-protocol navigation from sandboxed frames applies only to schemes
  without a registered handler (verified in WKWebView; Playwright's WebKit,
  which has no `asset:` handler, logs that block instead).
- **The main window does not run plugin code**: its CSP `script-src` is
  `'self'` only; `asset:` appears in `frame-src` (plugin iframes) and
  `img-src`.
- **`.kanban` is a file-handler extension**: `Sidebar.svelte`'s
  `textExtensions` list routes these to the kanban plugin via
  `extensionStore.getFileHandler()`. Same pattern for `.canvas`.

## Mindmap overlay

Built into the app (not a plugin panel). Trigger with `Cmd+Shift+M`. The
overlay is implemented in `app/lib/components/MindmapOverlay.svelte`,
consumes active-editor content, and renders via `markmap-lib` +
`markmap-view` directly in Svelte (no iframe, so theme CSS variables
propagate naturally). Fold logic lives in `app/lib/utils/mindmap.ts`
(`applyFoldLevel`) and is unit-tested in
`tests/unit/utils/mindmap.test.ts`. The plugin in `plugins/mindmap/` is
retained as a reference implementation but is filtered out of the
side-panel list in `App.svelte`.

## Literary commentary projects

Literary commentary is a dedicated `literary-study` project type backed by
the bundled `literary-commentary` file-handler plugin. The New Project
dialog always exposes this type in its own `literary-study` category,
independently of the deferred plugin scan. The import dialog uses a bounded
preview region with internal scrolling and a non-shrinking action footer so
the create/replace action remains reachable in compact desktop windows.
Opening a literary project ensures the bundled `.litstudy` handler is enabled
before the file tree is committed.

EPUB/TXT inspection and project mutations live in
`core/src/commands/literary_study.rs`. Imported chapters are stored below
`学习内容/`; `.novelist/literary-study.json` records source metadata and the
ordered chapter paths plus the selected import layout. The import dialog offers
two folder strategies (`by-volume` and `flat`) and two numbering strategies
(`global` and `per-volume`; flat layout always uses global numbering to prevent
collisions). By-volume import no longer creates a synthetic `章节/` directory:
unvolumed front matter lives directly under `学习内容/`, while real volumes get
stable numbered folders. Filename cleanup is enabled by default and removes
redundant leading forms such as `0004 第一章` or `第一卷` without changing the
chapter/volume titles stored inside `.litstudy` data. Bare structural headings
become a concise numbered filename such as `0004.litstudy`. Components are
UTF-8-byte bounded before writing so long CJK titles remain portable.

The native right panel reads a bounded overview through
`read_literary_study_overview`, while the iframe editor owns transcription,
inline comments, mistake markers, and revision-safe saves. Its single-file
entry posts `plugin-ready` after mounting; the host waits for that handshake
before sending the document and presents a retryable error instead of a blank
editor when startup fails. The transparent input capture follows the rendered
caret so the operating-system IME candidate window opens beside the current
writing position. Pre-edit pinyin is never compared or saved;
`compositionend` is the authoritative transaction, so selecting a candidate
replaces the pinyin and commits the selected CJK text exactly once.

Pre-edit text renders in a **floating overlay pinned under the caret**, not
inline. It used to be an inline `<span>`, which meant every pinyin keystroke
re-flowed all the pending grey source after the caret — the whole page
appeared to shiver while composing. The overlay is `position: fixed`, so the
transcript behind it cannot move; `literary-plugin-render.spec.ts` asserts
that the pending text's bounding box is pixel-identical before and after a
composition starts.

Transcription is the default interaction; committed `【` or `「` enters inline
comment input, and only the matching closer returns to transcription: `】` for
a comment opened with `【`, `」` for one opened with `「`. Brackets opened
inside a comment nest and stay comment text, so `【此处「风骨」妙】` is one
comment; the open-bracket stack (`CommentBrackets`) is carried across IME
commits and undo snapshots. A comment toggled on by the shortcut ends at either
closer. If the source itself expects an opening bracket at the frontier, it
remains transcribable as source; `Cmd/Ctrl+Shift+Enter` can explicitly toggle
commentary at that position. Both delimiter pairs work when the caret is
rewound into earlier text. IME duplicate suppression compares the committed
content, not merely `insertFromComposition`, so a distinct punctuation commit
immediately following composition is retained.

### The caret model

The document records only how far the source has been transcribed
(`sourceCursor`); the reader's own output lives entirely in `insertions`
anchored at source offsets. Editing used to happen exclusively at that
frontier, so arrow keys did nothing and there was no way to go back and
annotate a passage already copied.

`engine.ts` therefore layers a **caret index** over the model: a UTF-16
offset into the *rendered copied region* (source prefix plus every insertion
anchored inside it), where `0` is the top of the chapter and
`renderedLength(file)` is the frontier. It is view state, not document
state — the `.litstudy` schema is unchanged. `resolveCaret` maps an index
back to a `CaretAnchor`; `buildRenderPieces(file, caretIndex)` places the
caret marker and splits the piece around it, and every copied piece carries
`data-caret-start` so a click maps back to an index.

The editing rules follow from what the artefact *is*: the source is the
model being studied, so it is fixed.

| Caret position | Typing | Backspace |
|---|---|---|
| At the frontier | Matching source advances `sourceCursor`; anything else becomes a mistake mark | Deletes inline text, then un-transcribes source |
| Rewound | Always an insertion — commentary in comment mode, a mistake mark otherwise | Deletes insertion text only; **stops at the first source character** |

A rewound caret paints wider and amber to say that typing annotates rather
than transcribes, the footer swaps the progress readout for a "回改前文"
notice, and `Escape` returns to the frontier (after leaving comment mode, if
active). `↑`/`↓` use real geometry — the transcript wraps, so a logical line
spans many visual rows — probing `caretPositionFromPoint` a row at a time and
holding the original column so repeated presses travel straight down.

Backspace deletes the actual rendered tail, including comments after
returning to transcription; Option/Ctrl+Backspace and Command+Backspace
retain word/line deletion, while Command/Ctrl+Z and redo restore complete
input transactions (the caret index rides along in the undo snapshot).
Enter uses the same caret-aware committed-text path as typing: in an earlier
annotation it inserts there and preserves the transcription frontier. Native
IME Enter confirmation remains excluded, including keyCode 229.
Other system shortcuts are not intercepted.

`Tab` is the follow-along assist key: one press commits exactly the next
reference character as one ordinary edit, and holding it follows the
platform key-repeat rate. `Shift+Tab` fills in the rest of the current
sentence — stopping after the first terminator and absorbing trailing
closing punctuation — for a character the reader cannot produce without
holding the key down. `F6` remains wired as the original alias; it was the
only binding, but on a Mac keyboard it needs `Fn` to reach. Auto-typing
always appends at the frontier, so it returns the caret there first.

### Host typography

Plugin iframes get their look from a single `theme-update` message. That
payload carries the `--novelist-editor-*` vars (font, size, line-height,
max width) alongside the palette — see `app/lib/utils/plugin-theme.ts` —
because a plugin that renders a document body is part of the writing
surface. Without them, Settings → Editor → Width moved the main editor
while the literary editor stayed pinned at its own hard-coded column.

Replacing a book is a staged transaction under the shared project-settings
guard. Original config/metadata bytes are durably saved in the backup before
chapters move. Compatible chapter progress is preserved by volume/title and
source-prefix matching. On failure, rollback atomically copies original chapters
back without consuming the backup. Any restore error (including a missing moved
original) retains every surviving original and reports the recovery directory.
Only successful rollback or committed replacement removes that backup.

## Book translation projects

`create_book_translation_project` (`core/src/commands/book_translation.rs`)
turns an inspected EPUB/TXT (the same `inspect_literary_source` used by
literary projects) into `翻译内容/NNNN.novtrans` chapter files. Each non-empty
source line becomes one translation segment, because both importers emit one
paragraph per line. Project names follow the literary rule (one path
component, no separators) and the dialog derives the default from the book
title with `sanitizeFilenameStem`. Chapter JSON ends with a newline, matching
the plugin serializer, and the plugin only writes a chapter before chapter
navigation when it holds unsaved local edits.

Reference translations are a deliberate, host-mediated exception to "no HTTP
API calls in the kernel": `services/translation-reference.ts` calls Google
Cloud Translation v2 and the active AI Talk profile on behalf of the bundled
`book-translation` iframe. Moving the request into the plugin would hand the
user's Google key and AI Talk credentials to plugin iframe code, so the host
keeps the secrets and relays plain text only. The Google key travels in the
`X-goog-api-key` header (never the URL, which bridge errors quote); non-2xx
bodies are reduced to their `error.message`; and requests are aborted
(`aiFetchStreamCancel`) when the requesting iframe unmounts or reloads.
Results arriving after an in-place `file-sync` are delivered under the
iframe's current token.

## Plugin scaffolding

`scaffold_plugin(id, display_name?)` Rust command creates
`~/.novelist/plugins/<id>/` with a starter `manifest.toml` + `index.js`.
Triggered from Settings > Plugins via the "+" button and
`PluginScaffoldDialog.svelte`. ID pattern: `[a-z0-9][a-z0-9-]*`.

`HelpTooltip.svelte` is used in Settings > Plugins to explain the
manifest/permissions model inline.
