# AI Plugins — YOLO & Claudian

> Design spec for two first-party-maintained but distributed-as-third-party AI plugins that extend Novelist without bloating the app kernel. Written 2026-04-20, implemented alongside a minimal host-side AI bridge.

## Intent

Add two plugin experiences that mirror well-known Obsidian plugins:

- **YOLO** (<https://github.com/Lapis0x0/obsidian-yolo>) — chat + inline rewrite backed by any OpenAI-compatible HTTP endpoint. User supplies API key; no CLI dependency.
- **Claudian** (<https://github.com/YishenTu/claudian>) — chat backed by a locally-installed `claude` Code CLI, using its `stream-json` protocol. Inherits the agent/tool-use capabilities of Claude Code without reimplementing them.

Both are built in-tree under `plugins/<id>/` but **not** added to `core/bundled-plugins/`. They are opt-in: users install manually (future: via marketplace) or a dev script copies them into `~/.novelist/plugins/` for local testing. This keeps the shipped binary lean — only the Rust bridge is added to core.

## Constraints honoured

- "Prompt as UI" — no HTTP/LLM logic in the core editor; all model calls are scoped to plugins through a narrow IPC bridge.
- Bundle size — no AI SDKs, no vector DB, no React/Lexical. Each plugin is a small Svelte app. Claude integration uses the user's pre-installed `claude` binary (no Node sidecar).
- Existing plugin architecture — plugins declare `[ui] type = "panel"` (loaded via `ExtensionStore`), run in un-sandboxed iframes served by the asset protocol, and communicate with the host through `postMessage`.
- Novelist ecosystem — Svelte 5 runes, Vite, Tailwind-consistent styling. No React.

## Deliberate non-goals (deferred)

To ship a correct MVP tonight, these are out of scope:

- YOLO: vault RAG, Tab autocomplete ghost text, MCP, multi-provider UI, Smart Space, agent tool use, OAuth flows.
- Claudian: session resume/fork UI, plan-mode toggle, permission-prompt modal, MCP config merging, skills/subagents, rewind.
- Shared: per-plugin keyring secret storage (API keys live in plugin-local `localStorage` for now — iframe origin is unique per plugin so isolation holds).

These are all layerable on top of the shipped architecture.

## Architecture

### Layer 1 — Rust bridge (`core/src/commands/ai_bridge.rs`, `core/src/commands/claude_bridge.rs`)

Two new IPC command families. Both unconditionally compiled (not behind a feature flag) — each adds <500 LoC. `reqwest` moves out of the `sync` feature gate.

**`ai_fetch_stream`** — generic OpenAI-compatible streaming POST.

```
ai_fetch_stream_start(req: AiFetchRequest) -> Result<String /* stream_id */>
ai_fetch_stream_cancel(stream_id: String) -> Result<()>

struct AiFetchRequest {
  url: String,                  // full URL, e.g. "https://api.openai.com/v1/chat/completions"
  headers: Vec<(String, String)>,
  body: String,                 // raw JSON (plugin owns shape)
  sse: bool,                    // true → parse text/event-stream, false → return full body at end
}

// Emits on channel "ai-stream://{stream_id}":
// { kind: "chunk",  data: String }     — one SSE "data: ..." payload (without "data: " prefix)
// { kind: "done" }
// { kind: "error", message: String, status?: u16 }
```

Uses `reqwest::Client` with streaming body; a per-stream `CancellationToken` stored in `PluginHostState`-style map. Validates URL (only `https:` or configured dev overrides) and rejects on redirect to different host.

**`claude_cli`** — subprocess bridge.

```
claude_cli_detect() -> Option<DetectedCli>       // path + version
claude_cli_spawn(req: ClaudeSpawnRequest) -> Result<String /* session_id */>
claude_cli_send(session_id: String, line: String) -> Result<()>   // one stream-json line, appended with \n
claude_cli_kill(session_id: String) -> Result<()>

struct ClaudeSpawnRequest {
  cli_path: Option<String>,       // override auto-detect
  cwd: Option<String>,            // default: user's active project root
  system_prompt: Option<String>,
  add_dirs: Vec<String>,
  permission_mode: Option<String>, // "acceptEdits" | "bypassPermissions" | etc.
  model: Option<String>,
  session_uuid: String,            // plugin-owned UUID, passed as --session-id
  extra_args: Vec<String>,         // escape hatch
}

// Spawns: claude -p --input-format stream-json --output-format stream-json \
//                --include-partial-messages --session-id <uuid> \
//                [--system-prompt …] [--add-dir …] [--cwd via spawn cwd] [--model …]
//
// Emits on channel "claude-stream://{session_id}":
// { kind: "stdout-line", data: String }  // raw JSON line from claude
// { kind: "stderr-line", data: String }
// { kind: "exit",        code: Option<i32> }
// { kind: "error",       message: String }
```

Detection heuristics ported from Claudian's `findClaudeCLIPath.ts`: check `$PATH`, `~/.claude/local/claude`, `~/.local/bin/claude`, common node-manager shims (nvm, volta, asdf, homebrew), then `@anthropic-ai/claude-code/cli.js` under npm global dirs. On not-found, the plugin shows a "Claude Code not installed" empty state with a link to <https://docs.claude.com/en/docs/claude-code/overview>.

Cancellation: `claude_cli_kill` sends SIGTERM then, after 2s, SIGKILL.

### Layer 2 — Host postMessage bridge (`app/lib/services/plugin-bridge.svelte.ts`)

One shared service that listens to `message` events from every plugin iframe and routes to Rust or back into Novelist stores. Plugins use a tiny SDK (`plugins/shared/sdk.ts`, duplicated per plugin so they remain independent build units) that wraps postMessage in async/iterator APIs.

Bridge methods (all correlation-ID based):

| Method | Rust/Host action |
| --- | --- |
| `editor.getSelection()` → `{text, from, to, fullDoc, filePath}` | Read `tabsStore.activeTab` + its `EditorView` |
| `editor.replaceRange({from, to, text})` | Post back into the active `EditorView` via `view.dispatch` |
| `editor.insertAtCursor({text})` | Same |
| `project.getCwd()` → `string` | Read `projectStore.currentProjectPath` |
| `project.getActiveFilePath()` → `string \| null` | From active tab |
| `ai.fetchStream(req)` → async iterator of chunks | Calls `ai_fetch_stream_start`, subscribes to event, forwards chunks back via `postMessage` |
| `ai.cancelStream(id)` | Calls `ai_fetch_stream_cancel` |
| `claude.detect()` → `DetectedCli \| null` | |
| `claude.spawn(req)` → `session_id` | |
| `claude.send({session_id, line})` | |
| `claude.kill(session_id)` | |
| `claude.events(session_id)` → async iterator | Subscribes to `claude-stream://…` events |

Security: the bridge validates `event.source` against the known iframe's `contentWindow`, and only services requests from iframes registered as plugin panels. Plugins without the right manifest permission are rejected (see Layer 3).

### Layer 3 — Plugin permission model (manifest)

Extend `PluginManifest.plugin.permissions` with two new tokens:

- `"ai:http"` — gates `ai.*` bridge methods.
- `"ai:claude-cli"` — gates `claude.*` bridge methods.

`read`/`write`/`ui` remain as-is. The bridge checks the plugin's manifest (already loaded in `PluginHost`) before dispatching. Settings > Plugins UI will list these, so users see what each plugin can do.

### Layer 4 — Plugin: `plugins/yolo/`

Svelte 5 panel plugin. Single entry (`index.html` → `src/main.ts` → `App.svelte`).

Manifest:

```toml
[plugin]
id = "yolo"
name = "YOLO"
version = "0.1.0"
description = "Chat + inline rewrite powered by any OpenAI-compatible endpoint"
author = "Novelist Team"
permissions = ["read", "write", "ui", "ai:http"]

[ui]
type = "panel"
entry = "index.html"
label = "YOLO"
```

Features in MVP:

1. **Chat tab** — textarea input, streaming response rendered as markdown (reuse Novelist's lightweight `renderMarkdown` helper; bundled in plugin). History kept in memory + `localStorage`. "Clear" button.
2. **Inline rewrite** — "Apply to selection" button: takes the current editor selection + an instruction → streams into a diff preview (added/removed lines) → Accept replaces the selection, Reject discards. Implemented with prompt template: `"Rewrite the following text according to the instruction. Return ONLY the rewritten text. Instruction: {instr}\n\n{text}"`.
3. **Settings** — API base URL (default `https://api.openai.com/v1`), API key (stored in `localStorage` under the plugin's iframe origin), model name (default `gpt-4o-mini`), temperature, system prompt. Settings are expanded via a gear icon in the panel header.
4. **Context controls** — checkbox "Include current file" to prepend the active doc as a user message; "Include selection" for selection chat.

No `@`-trigger / Quick Ask inline popup in MVP (it requires deeper editor integration — slash-command works fine as a substitute, see below).

Optional follow-up integration (lands if time permits in MVP worktree, else deferred): register `/yolo` slash command via the existing QuickJS plugin API (`index.js` companion) so users can launch YOLO from the editor. The QuickJS plugin only opens the panel and focuses its input — all actual AI work happens in the iframe.

### Layer 5 — Plugin: `plugins/claudian/`

Svelte 5 panel plugin with identical structure to YOLO, but backed by the claude CLI bridge.

Manifest:

```toml
[plugin]
id = "claudian"
name = "Claudian"
version = "0.1.0"
description = "Chat with a local Claude Code CLI session — inherits its tool-use and file-edit capabilities"
author = "Novelist Team"
permissions = ["read", "write", "ui", "ai:claude-cli"]

[ui]
type = "panel"
entry = "index.html"
label = "Claudian"
```

Features in MVP:

1. **Single persistent session** — spawns one `claude -p --input-format stream-json --output-format stream-json --include-partial-messages` process on first send, reuses for the life of the panel.
2. **Chat UI** — user input (textarea), message list with markdown rendering, streaming partial text as it arrives. Tool use blocks are rendered as collapsible `<details>` ("Claude ran Bash: `ls`") without interactive approval (MVP runs with `--permission-mode=acceptEdits` gated by a setting).
3. **Context** — on spawn, sets `cwd` to the current Novelist project root and `--add-dir` for the project. On each user turn, optionally prepends "The user is currently editing `<path>`:" if enabled.
4. **Settings** — claude binary path override, permission mode (default `acceptEdits`, toggle to `bypassPermissions` with a warning), model (optional), system prompt (optional).
5. **Empty state when CLI absent** — calls `claude.detect()` on mount; if null, shows install instructions instead of the chat UI.

### Stream-JSON message shape (for reference)

The claude CLI emits one JSON object per line. Shape (abridged):

```jsonc
// assistant partial
{"type":"assistant","message":{"content":[{"type":"text","text":"…streaming…"}]}}
// tool use
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}
// tool result
{"type":"user","message":{"content":[{"type":"tool_result","content":"…"}]}}
// final
{"type":"result","subtype":"success","result":"…","total_cost_usd":0.012}
```

Input we send (one JSON per line):

```jsonc
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}
```

## Worktree layout

Two git worktrees under `.worktrees/`, created sequentially:

- `.worktrees/plugin-yolo/` on branch `feat/plugin-yolo` — contains:
  - Rust bridge (`core/src/commands/ai_bridge.rs`, `core/src/commands/claude_bridge.rs`) + registration
  - Frontend `plugin-bridge.svelte.ts` service + App.svelte wiring
  - Frontend `extensionStore` permission gate
  - `plugins/yolo/` (full plugin)

- `.worktrees/plugin-claudian/` on branch `feat/plugin-claudian`, branched off `feat/plugin-yolo` — contains:
  - (inherits the bridge from yolo branch)
  - `plugins/claudian/` (full plugin)

When merging: merge `feat/plugin-yolo` first; then rebase `feat/plugin-claudian` onto main (bridge already landed) and merge.

## Testing

- **Rust unit tests** (`cargo test`): `ai_bridge::tests` cover URL validation + SSE line parser; `claude_bridge::tests` cover CLI detection heuristics + argument construction (no actual spawn).
- **Frontend unit tests** (`vitest`): `plugin-bridge` message routing with a fake MessageEvent source.
- **Plugin build smoke test**: `pnpm --filter plugin-yolo build` and `pnpm --filter plugin-claudian build` both succeed with the plugin vite configs.
- **Manual E2E** (documented, not automated): install plugins into `~/.novelist/plugins/`, open app, verify chat and rewrite flows against a real endpoint and a real `claude` CLI.

Full Playwright E2E of either plugin would require mocking the AI bridge — reasonable follow-up work, not blocking MVP.

## Risks & mitigations

- **CSP for HTTP**: iframe-sourced `fetch()` to arbitrary hosts would fail under the current `connect-src`. Avoided entirely by proxying through Rust.
- **Claude CLI version drift**: `--include-partial-messages` and the `stream-json` format have changed shape over past versions. We parse defensively (unknown types logged, not crashed) and show the detected version in settings.
- **Cost surprises**: both plugins show a footer "last response: $X.XX" from the CLI's `total_cost_usd` / OpenAI usage response. No automated budget cap in MVP — flagged in settings help text.
- **Secrets**: `localStorage` per iframe origin is adequate for MVP (iframe origin is `asset://…/yolo/index.html` — distinct from the main app and from other plugins). Keychain follow-up once we add `ai:http` to marketplace review criteria.
