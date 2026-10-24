# Memory Optimization Implementation Plan

> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Novelist's runtime memory footprint from ~120MB RSS (release) to under 80MB by eliminating unnecessary allocations, deferring heavy subsystem initialization, and optimizing the dependency tree.

**Architecture:** Lazy initialization of QuickJS runtime and reqwest HTTP stack; replace eagerly-allocated Tokio multi-thread runtime with current-thread where feasible; reduce WebView JS bundle via code-splitting and tree-shaking improvements; configure QuickJS memory limits.

**Tech Stack:** Rust (Tauri v2), rquickjs, reqwest, tokio, Svelte 5, CodeMirror 6, Vite

---

## Current Memory Profile Analysis

### Measured Values (macOS ARM64, release build, idle — no file open)

| Component | RSS | Notes |
|-----------|-----|-------|
| Rust process (Novelist binary) | ~118 MB | Includes WebKit framework mappings |
| WebKit WebContent (WKWebView) | ~97 MB | Shared WebKit rendering process |
| **Total user-visible** | **~215 MB** | Combined Rust + WebView |

### Breakdown of Rust Process (118 MB RSS)

| Region | Dirty/Resident | Notes |
|--------|---------------|-------|
| `__TEXT` (code) | 410 MB mapped, ~20 MB resident | Tauri + all deps code pages (CoW) |
| `__DATA_CONST` | 19 MB | Global constants from linked frameworks |
| `MALLOC_SMALL` | 17.5 MB | Heap allocations |
| `__DATA` | 8.7 MB | Mutable globals |
| `__DATA_DIRTY` | 3.6 MB | Modified data pages |
| `Stack` (26 threads) | ~900 KB | Tokio multi-thread + OS threads |
| `MALLOC_LARGE` | ~600 KB dirty | Individual large allocations |

### Key Memory Consumers (Startup)

1. **QuickJS Runtime** (~2-5 MB) — Allocated eagerly in `PluginHostState::new()` even if no plugins are installed
2. **Tokio `rt-multi-thread`** (~2-3 MB) — Spawns worker threads (one per CPU core) at startup; Novelist's async workload is minimal (file I/O, rare sync)
3. **reqwest + rustls + ring** (code pages, ~3-5 MB resident) — Full HTTP client with TLS stack linked in; only used for WebDAV sync (rare)
4. **`specta-typescript`** — Linked in release builds but only called in `#[cfg(debug_assertions)]` (dead code in production, still adds to `__TEXT`)
5. **Font file** (1.8 MB woff2) — Loaded into WebView memory on first paint (unavoidable for CJK support, but notable)
6. **CodeMirror JS bundle** (~770 KB uncompressed JS) — Three chunks loaded immediately: core (224K), extensions (220K), app (228K), lezer (96K)

### Thread Count (Release)

26 threads at idle:
- Tokio worker threads (CPU cores × 1, ~8-10 on modern Mac)
- Tokio blocking pool (spawned on demand, but pool infrastructure exists)
- File watcher (notify) thread
- Main thread + WebKit IPC threads

---

## Optimization Tasks

### Task 1: Lazy-Initialize QuickJS Runtime

**Files:**
- Modify: `core/src/services/plugin_host/sandbox.rs:54-67`
- Test: inline `#[cfg(test)]` module in same file

Currently `PluginHostState::new()` creates a `Runtime::new()` immediately. Most users have zero plugins installed. Defer until `load_plugin` is first called.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_host_starts_without_runtime_allocation() {
        let state = PluginHostState::new();
        let inner = state.inner.lock().unwrap();
        assert!(inner.runtime.is_none(), "Runtime should not be allocated at startup");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd core && cargo test plugin_host_starts_without_runtime_allocation -- --nocapture`
Expected: FAIL — `inner.runtime` is currently not `Option`, it's always allocated

- [ ] **Step 3: Make Runtime optional in PluginHostInner**

```rust
struct PluginHostInner {
    runtime: Option<Runtime>,
    plugins: HashMap<String, PluginInstance>,
    document_content: String,
    selection: (usize, usize),
    word_count: usize,
    registered_commands: Vec<RegisteredCommand>,
}
```

- [ ] **Step 4: Update `PluginHostState::new()` to not allocate runtime**

```rust
impl PluginHostState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(PluginHostInner {
                runtime: None,
                plugins: HashMap::new(),
                document_content: String::new(),
                selection: (0, 0),
                word_count: 0,
                registered_commands: Vec::new(),
            }),
        }
    }
}
```

- [ ] **Step 5: Add helper to get-or-create runtime**

```rust
impl PluginHostInner {
    fn runtime(&mut self) -> Result<&Runtime, String> {
        if self.runtime.is_none() {
            self.runtime = Some(
                Runtime::new().map_err(|e| format!("Failed to create QuickJS runtime: {e}"))?
            );
        }
        Ok(self.runtime.as_ref().unwrap())
    }
}
```

- [ ] **Step 6: Update `load_plugin` to use `inner.runtime()?`**

Change:
```rust
let context = Context::full(&inner.runtime).map_err(|e| format!("QuickJS context error: {e}"))?;
```
To:
```rust
let rt = inner.runtime()?;
let context = Context::full(rt).map_err(|e| format!("QuickJS context error: {e}"))?;
```

- [ ] **Step 7: Run all tests**

Run: `cd core && cargo test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add core/src/services/plugin_host/sandbox.rs
git commit -m "perf: lazy-init QuickJS runtime — saves ~3MB when no plugins loaded"
```

**Estimated savings:** ~2-5 MB RSS for users without plugins (majority)

---

### Task 2: Set QuickJS Memory Limits

**Files:**
- Modify: `core/src/services/plugin_host/sandbox.rs`

QuickJS has no memory limit by default — a misbehaving plugin can consume unbounded memory. Add a limit.

- [ ] **Step 1: Add memory limit when creating runtime**

In the `runtime()` helper from Task 1:

```rust
fn runtime(&mut self) -> Result<&Runtime, String> {
    if self.runtime.is_none() {
        let rt = Runtime::new().map_err(|e| format!("Failed to create QuickJS runtime: {e}"))?;
        // Limit plugin memory to 16MB — prevents runaway allocations
        rt.set_memory_limit(16 * 1024 * 1024);
        // Limit stack to 512KB per context
        rt.set_max_stack_size(512 * 1024);
        self.runtime = Some(rt);
    }
    Ok(self.runtime.as_ref().unwrap())
}
```

- [ ] **Step 2: Write test for memory limit enforcement**

```rust
#[test]
fn plugin_runtime_has_memory_limit() {
    let state = PluginHostState::new();
    let manifest = PluginManifest {
        plugin: crate::models::plugin::PluginMeta {
            id: "test-mem".into(),
            name: "Test Memory".into(),
            version: "1.0.0".into(),
            description: "".into(),
            permissions: vec![],
        },
        ui: None,
    };
    // This plugin tries to allocate a huge array — should fail gracefully
    let source = r#"
        try {
            let arr = [];
            for (let i = 0; i < 10000000; i++) arr.push("x".repeat(1000));
        } catch(e) {
            // Expected: out of memory
        }
    "#;
    let result = state.load_plugin(manifest, source);
    // Should not crash the process
    assert!(result.is_ok() || result.unwrap_err().contains("memory"));
}
```

- [ ] **Step 3: Run tests**

Run: `cd core && cargo test plugin_runtime_has_memory_limit -- --nocapture`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add core/src/services/plugin_host/sandbox.rs
git commit -m "perf: set QuickJS memory limit (16MB) and stack limit (512KB)"
```

**Estimated savings:** Prevents unbounded growth; caps worst-case at 16 MB per plugin host

---

### Task 3: Make reqwest/TLS a Cargo Feature (Conditional Compilation)

**Files:**
- Modify: `core/Cargo.toml`
- Modify: `core/src/services/mod.rs`
- Modify: `core/src/services/sync.rs`
- Modify: `core/src/services/webdav.rs`
- Modify: `core/src/commands/sync.rs`
- Modify: `core/src/lib.rs`

reqwest + rustls + hyper + h2 + ring is a massive dependency tree (~290 transitive crates). It adds significant `__TEXT` mapped pages and initialization cost. It's only used for WebDAV sync, which most users never enable. Gate it behind a feature flag.

- [ ] **Step 1: Add feature flag in Cargo.toml**

```toml
[features]
default = ["sync"]
dev = ["tauri/devtools"]
sync = ["dep:reqwest"]

[dependencies]
reqwest = { version = "0.12", features = ["rustls-tls"], optional = true }
```

- [ ] **Step 2: Gate sync module with `#[cfg(feature = "sync")]`**

In `core/src/services/mod.rs`:
```rust
pub mod file_watcher;
pub mod pandoc;
pub mod plugin_host;
pub mod rope_document;
pub mod snapshots;
pub mod writing_stats;

#[cfg(feature = "sync")]
pub mod sync;
#[cfg(feature = "sync")]
pub mod webdav;
```

- [ ] **Step 3: Gate sync commands in lib.rs**

Wrap sync command registrations:
```rust
#[cfg(feature = "sync")]
use commands::sync::{get_sync_config, save_sync_config, sync_now, test_sync_connection};
```

And in the `collect_commands!` macro, use conditional compilation or a separate registration block.

- [ ] **Step 4: Provide stub commands when sync is disabled**

In `core/src/commands/sync.rs`, add stubs:
```rust
#[cfg(not(feature = "sync"))]
pub mod stubs {
    use crate::AppError;
    
    #[tauri::command]
    #[specta::specta]
    pub async fn sync_now(_project_dir: String) -> Result<String, AppError> {
        Err(AppError::Custom("Sync feature not enabled in this build".into()))
    }
    // ... similar for other sync commands
}
```

- [ ] **Step 5: Verify build without sync feature**

Run: `cd core && cargo build --no-default-features`
Expected: Compiles without reqwest

- [ ] **Step 6: Verify build with sync feature (default)**

Run: `cd core && cargo build`
Expected: Compiles with reqwest (backwards compatible)

- [ ] **Step 7: Commit**

```bash
git add core/Cargo.toml core/src/services/mod.rs core/src/commands/sync.rs core/src/lib.rs
git commit -m "perf: gate reqwest/sync behind feature flag — saves ~3-5MB __TEXT pages when disabled"
```

**Estimated savings:** ~3-5 MB reduction in `__TEXT` resident pages when sync is not compiled in. Even when compiled in, this documents the separation clearly.

---

### Task 4: Reduce Tokio Thread Pool

**Files:**
- Modify: `core/Cargo.toml`

Novelist's async work is lightweight: file reads/writes, occasional directory walks, and (rare) HTTP sync. A multi-thread runtime with 8+ worker threads is overkill. However, Tauri itself manages the runtime, so the best approach is to reduce the thread count.

- [ ] **Step 1: Research — Check if Tauri respects TOKIO_WORKER_THREADS**

Tauri v2 uses `tokio::runtime::Builder` internally. We can set `TOKIO_WORKER_THREADS=2` to limit worker threads.

- [ ] **Step 2: Set thread count in main.rs**

```rust
fn main() {
    // Limit Tokio worker threads — Novelist's async workload is light (file I/O only)
    if std::env::var("TOKIO_WORKER_THREADS").is_err() {
        std::env::set_var("TOKIO_WORKER_THREADS", "2");
    }
    novelist_lib::run()
}
```

- [ ] **Step 3: Verify thread count reduction**

Run app, then: `ps -M <pid> | wc -l`
Expected: Thread count drops from ~26 to ~18 (fewer Tokio workers)

- [ ] **Step 4: Run full test suite to verify no performance regression**

Run: `cd core && cargo test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add core/src/main.rs
git commit -m "perf: limit Tokio worker threads to 2 — saves ~1MB stack per removed thread"
```

**Estimated savings:** Each thread stack is ~512KB-1MB. Reducing from 8→2 workers saves ~3-6 MB virtual, ~500KB-1MB RSS.

---

### Task 5: Lazy-Load CodeMirror Extensions Chunk

**Files:**
- Modify: `src/lib/components/Editor.svelte`
- Modify: `src/lib/editor/setup.ts` (split)
- Create: `src/lib/editor/extensions-lazy.ts`

Currently all CM6 extensions (220KB `codemirror-ext` chunk) are loaded at startup even before a file is opened. Defer until the user actually opens a file.

- [ ] **Step 1: Create lazy extension loader**

Create `src/lib/editor/extensions-lazy.ts`:
```typescript
// Lazy-loaded extensions — only imported when editor is mounted
export async function loadEditorExtensions() {
  const { createEditorExtensions, createEditorState, scrollStabilizer } = await import('./setup');
  return { createEditorExtensions, createEditorState, scrollStabilizer };
}
```

- [ ] **Step 2: Update Editor.svelte to use dynamic import**

In Editor.svelte, change:
```typescript
// Before
import { createEditorExtensions, createEditorState } from '$lib/editor/setup';

// After
let editorSetup: typeof import('$lib/editor/setup') | null = null;

onMount(async () => {
  editorSetup = await import('$lib/editor/setup');
  // ... create editor with editorSetup.createEditorExtensions(...)
});
```

- [ ] **Step 3: Verify via Network tab**

Run `pnpm tauri dev`, open DevTools Network tab.
Expected: `codemirror-ext-*.js` is NOT loaded until a file is opened.

- [ ] **Step 4: Commit**

```bash
git add src/lib/editor/extensions-lazy.ts src/lib/components/Editor.svelte
git commit -m "perf: lazy-load CodeMirror extensions chunk until file is opened"
```

**Estimated savings:** ~220KB JS parse/compile deferred (reduces WebView startup memory by ~2-4 MB)

---

### Task 6: Move specta-typescript to dev-dependencies

**Files:**
- Modify: `core/Cargo.toml`

`specta-typescript` is only used inside `#[cfg(debug_assertions)]` for code generation, but it's listed as a regular dependency, meaning it's linked into release builds.

- [ ] **Step 1: Check current usage**

Verify it's only used in debug:
```rust
#[cfg(debug_assertions)]
builder.export(specta_typescript::Typescript::new()...);
```

- [ ] **Step 2: Move to dev-dependencies and cfg-gate the import**

In `Cargo.toml`:
```toml
[dependencies]
# Remove: specta-typescript = "0.0.11"

[dev-dependencies]
tempfile = "3"
specta-typescript = "0.0.11"
```

In `lib.rs`, wrap the export code:
```rust
#[cfg(debug_assertions)]
{
    use specta_typescript;
    builder.export(
        specta_typescript::Typescript::new()
            .header("// @ts-nocheck\n// Auto-generated by tauri-specta\n"),
        "../src/lib/ipc/commands.ts",
    ).expect("Failed to export typescript bindings");
}
```

- [ ] **Step 3: Verify release build**

Run: `cd core && cargo build --release`
Expected: Compiles, `specta-typescript` not linked

- [ ] **Step 4: Verify dev build still generates bindings**

Run: `cd core && cargo build`
Expected: Compiles with bindings generation

- [ ] **Step 5: Commit**

```bash
git add core/Cargo.toml core/src/lib.rs
git commit -m "perf: move specta-typescript to dev-dependencies — not needed in release"
```

**Estimated savings:** Removes dead code from release binary, small reduction in `__TEXT`

---

### Task 7: Reduce Font Memory Pressure

**Files:**
- Modify: `src/app.css`

The 1.8 MB LXGW WenKai font is loaded immediately via `@font-face`. For users who don't write CJK, this is wasted memory. Use `font-display: swap` and `unicode-range` to allow partial loading.

- [ ] **Step 1: Add font-display and unicode-range**

```css
@font-face {
  font-family: "LXGW WenKai Screen";
  src: url("./assets/fonts/LXGWWenKaiScreen-Regular.woff2") format("woff2");
  font-weight: normal;
  font-style: normal;
  font-display: swap;
  /* Only load for CJK characters — latin fallback to system font */
  unicode-range: U+2E80-9FFF, U+F900-FAFF, U+FE30-FE4F, U+20000-2FA1F, U+3000-303F, U+FF00-FFEF;
}
```

- [ ] **Step 2: Add system font fallback for Latin text**

Ensure the CSS `font-family` stack has a system font first for Latin:
```css
--novelist-editor-font: -apple-system, BlinkMacSystemFont, "Segoe UI", "LXGW WenKai Screen", sans-serif;
```

Or if the CJK font is preferred for all text, at minimum ensure `font-display: swap` so it doesn't block rendering.

- [ ] **Step 3: Test with CJK content**

Open a file with Chinese text, verify the font loads and renders correctly.

- [ ] **Step 4: Test with Latin-only content**

Open a pure English file, check DevTools — font file should not be fetched (if unicode-range is used).

- [ ] **Step 5: Commit**

```bash
git add src/app.css
git commit -m "perf: add font-display:swap and unicode-range to defer CJK font loading"
```

**Estimated savings:** ~1.8 MB deferred for non-CJK users; faster first paint for all users

---

### Task 8: Add Diagnostic Memory Reporting Command

**Files:**
- Create: `core/src/commands/diagnostics.rs`
- Modify: `core/src/commands/mod.rs`
- Modify: `core/src/lib.rs`

Add a command that reports current memory usage (for users and debugging). This helps validate optimization results.

- [ ] **Step 1: Create diagnostics command**

```rust
use serde::Serialize;
use specta::Type;

#[derive(Serialize, Type)]
pub struct MemoryInfo {
    /// RSS in bytes (macOS: from rusage)
    pub rss_bytes: u64,
    /// Number of open rope documents
    pub rope_docs: usize,
    /// Number of loaded plugins
    pub plugins_loaded: usize,
    /// Whether file watcher is active
    pub file_watcher_active: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn get_memory_info(
    rope_state: tauri::State<'_, crate::services::rope_document::RopeDocumentState>,
    plugin_state: tauri::State<'_, crate::services::plugin_host::sandbox::PluginHostState>,
    watcher_state: tauri::State<'_, crate::services::file_watcher::FileWatcherState>,
) -> Result<MemoryInfo, crate::AppError> {
    // Get RSS via libc::getrusage on macOS
    let rss_bytes = {
        let mut rusage = std::mem::zeroed::<libc::rusage>();
        unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut rusage) };
        (rusage.ru_maxrss as u64) // macOS returns bytes
    };

    let rope_docs = rope_state.docs.lock()
        .map(|d| d.len())
        .unwrap_or(0);

    let plugins_loaded = plugin_state.plugin_count();
    let file_watcher_active = watcher_state.is_active();

    Ok(MemoryInfo {
        rss_bytes,
        rope_docs,
        plugins_loaded,
        file_watcher_active,
    })
}
```

- [ ] **Step 2: Register the command**

Add to `lib.rs` command collection and add helper methods to state types.

- [ ] **Step 3: Test**

Run: `cd core && cargo test diagnostics`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add core/src/commands/diagnostics.rs core/src/commands/mod.rs core/src/lib.rs
git commit -m "feat: add get_memory_info diagnostic command for memory profiling"
```

---

## Summary of Expected Savings

| Optimization | Estimated Savings | Difficulty |
|-------------|-------------------|-----------|
| Lazy QuickJS | 2-5 MB | Low |
| QuickJS memory limits | Caps worst-case | Low |
| Feature-gate reqwest | 3-5 MB (`__TEXT`) | Medium |
| Reduce Tokio threads | 0.5-1 MB RSS | Low |
| Lazy CM6 extensions | 2-4 MB WebView | Medium |
| specta-typescript dev-dep | ~0.5 MB `__TEXT` | Low |
| Font unicode-range | 1.8 MB deferred | Low |
| **Total** | **~10-20 MB** | |

Target: 118 MB → ~95-105 MB RSS (release, idle), with WebView memory also reduced.

## Non-Actionable Observations

These consume memory but cannot reasonably be optimized:
- **WebKit framework mapped pages** (~400 MB virtual, ~20 MB resident): Required by Tauri's WKWebView, shared across processes
- **Tauri core `__TEXT`**: The framework itself maps ~30 MB of code pages
- **System libraries** (`__DATA_CONST` ~19 MB): Shared macOS framework data, CoW shared
- **The 11 MB release binary**: Already optimized with `lto=true`, `strip=true`, `panic=abort`, `codegen-units=1`
