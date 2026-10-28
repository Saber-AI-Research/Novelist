# Credits / 致谢

Novelist stands on the shoulders of many open-source projects.
Novelist 的实现建立在大量开源项目之上。

This document lists:
本文件列出:

1. Projects whose design or ideas Novelist explicitly draws from.
   Novelist 在设计或理念上明确借鉴的项目。
2. Third-party software bundled in or used by the Novelist application.
   Novelist 应用程序中打包或使用的第三方软件。

For Novelist's own license, see [`LICENSE`](LICENSE) (MIT).
Novelist 自身遵循 MIT 协议,见 [`LICENSE`](LICENSE)。

---

## 1. Design Inspiration / 设计灵感

The AI Talk panel in Novelist — including the shared command/mention
scaffolding shipped in v0.2.2 — was directly inspired by the following
project. We thank its author for showing how an embedded AI assistant
can fit naturally inside a writing tool.

Novelist 的 AI Talk 面板,以及在 v0.2.2 中加入的共享命令 / @-mention /
内联编辑脚手架,在设计上直接参考了以下项目。感谢该项目的作者展示了
"嵌入式 AI 助手与写作工具自然融合"的可能。

| Project | Author | License | Inspired |
|---|---|---|---|
| [obsidian-yolo](https://github.com/Lapis0x0/obsidian-yolo) | Lapis0x0 | MIT | AI chat + writing assistant integrated into a notes app (slash commands, knowledge-base mentions) |

This is a design reference only. Novelist does not vendor or
fork code from this project; it is MIT-licensed and credited
here as good-faith acknowledgement.

仅为设计参考。Novelist 未直接复用或 fork 该项目的代码;它采用 MIT
协议,此处出于诚信原则进行致谢。

---

## 2. Third-Party Software / 第三方软件

Novelist bundles or builds against the libraries below. Each library
is governed by its own license (most commonly MIT or Apache-2.0); for
authoritative license text consult the upstream package metadata.

Novelist 打包或编译依赖以下库,每个库遵循其自身的开源协议(多为 MIT 或
Apache-2.0)。完整的协议文本请查阅上游包的元数据。

### Frontend (npm)

**Editor core**
- [CodeMirror 6](https://codemirror.net/) — `@codemirror/*` (MIT)
- [Lezer](https://lezer.codemirror.net/) — `@lezer/*` (MIT)

**Framework / build**
- [Svelte](https://svelte.dev/) (MIT)
- [Vite](https://vitejs.dev/) (MIT)
- [TypeScript](https://www.typescriptlang.org/) (Apache-2.0)
- [Tailwind CSS](https://tailwindcss.com/) (MIT)

**Tauri integration**
- [Tauri](https://tauri.app/) — `@tauri-apps/api`, `@tauri-apps/cli`,
  `@tauri-apps/plugin-{dialog,shell,updater}` (MIT or Apache-2.0)

**Rendering / domain**
- [KaTeX](https://katex.org/) (MIT) — math rendering
- [Mermaid](https://mermaid.js.org/) (MIT) — diagram rendering
- [markmap-lib](https://markmap.js.org/) and `markmap-view` (MIT) — mindmap overlay
- [@xyflow/svelte](https://xyflow.com/) (MIT) — canvas / flow graph
- [opencc-js](https://github.com/nk2028/opencc-js) (Apache-2.0) — Chinese conversion
- [pinyin-pro](https://github.com/zh-lx/pinyin-pro) (MIT) — pinyin
- [svelte-dnd-action](https://github.com/isaacHagoel/svelte-dnd-action) (MIT) — drag and drop

**Testing / tooling**
- [Vitest](https://vitest.dev/) (MIT) and `@vitest/coverage-v8` (MIT)
- [Playwright](https://playwright.dev/) and `@playwright/test` (Apache-2.0)
- [happy-dom](https://github.com/capricorn86/happy-dom) (MIT)
- [svelte-check](https://www.npmjs.com/package/svelte-check) (MIT)

### Backend (Rust crates)

**Tauri runtime**
- [`tauri`](https://crates.io/crates/tauri), `tauri-build`,
  `tauri-plugin-{shell,dialog,updater}` (Apache-2.0 OR MIT)
- [`tauri-specta`](https://crates.io/crates/tauri-specta),
  [`specta`](https://crates.io/crates/specta), `specta-typescript` (MIT)

**Async / IO**
- [`tokio`](https://tokio.rs/) (MIT)
- [`reqwest`](https://crates.io/crates/reqwest) (Apache-2.0 OR MIT)
- [`futures-util`](https://crates.io/crates/futures-util) (Apache-2.0 OR MIT)
- [`notify`](https://crates.io/crates/notify) (Apache-2.0 OR MIT) — file watcher
- [`walkdir`](https://crates.io/crates/walkdir) (MIT OR Unlicense)
- [`tempfile`](https://crates.io/crates/tempfile) (Apache-2.0 OR MIT)
- [`dirs`](https://crates.io/crates/dirs) (Apache-2.0 OR MIT)

**Serialization / errors**
- [`serde`](https://serde.rs/) and `serde_json` (Apache-2.0 OR MIT)
- [`toml`](https://crates.io/crates/toml) (Apache-2.0 OR MIT)
- [`thiserror`](https://crates.io/crates/thiserror) (Apache-2.0 OR MIT)
- [`tracing`](https://tracing.rs/) and `tracing-subscriber` (MIT)

**Editor backbone**
- [`ropey`](https://crates.io/crates/ropey) (MIT) — rope buffer for huge files
- [`blake3`](https://crates.io/crates/blake3) (CC0-1.0 OR Apache-2.0) — file hashing for self-write suppression
- [`chardetng`](https://crates.io/crates/chardetng) (Apache-2.0 OR MIT) — encoding detection
- [`encoding_rs`](https://crates.io/crates/encoding_rs) (Apache-2.0 OR MIT) — encoding conversion
- [`base64`](https://crates.io/crates/base64) (Apache-2.0 OR MIT)
- [`url`](https://crates.io/crates/url) (Apache-2.0 OR MIT)
- [`once_cell`](https://crates.io/crates/once_cell) (Apache-2.0 OR MIT)
- [`objc`](https://crates.io/crates/objc) (MIT) — macOS Objective-C bridge

**Plugin sandbox**
- [`rquickjs`](https://crates.io/crates/rquickjs) (MIT) — Rust bindings for
- [QuickJS](https://bellard.org/quickjs/) (MIT) — JavaScript engine

### External tools

- [Pandoc](https://pandoc.org/) (GPL-2.0+) — invoked as an external
  binary for `Export to PDF / DOCX / EPUB`. Pandoc is *not* linked
  into the Novelist binary; it is launched as a separate process when
  the user requests an export, and is not bundled in our distributions.
  Pandoc 仅作为外部命令被调用,不与 Novelist 进行任何链接,也不打包在我们
  的分发包中。

---

## Reporting omissions / 报告遗漏

If you believe your project should be credited here, or a license is
incorrectly stated, please open an issue on the
[Novelist repository](https://github.com/Saber-AI-Research/Novelist).

如果你认为你的项目应该被列入致谢,或某个协议被错误地标注,请在
[Novelist 仓库](https://github.com/Saber-AI-Research/Novelist) 提出 issue。
