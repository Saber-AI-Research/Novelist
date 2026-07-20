# Competitive Analysis Summary

> **Status: historical research.** Architecture recommendations below record
> early alternatives, not current product contracts. Current behavior is defined
> by `docs/design-docs/` and the indexed feature specifications.

## Feature Coverage Matrix

| 能力维度 | MiaoYan | Typora | Obsidian | Scrivener | WonderPen | Notesnook |
|---------|:-------:|:------:|:--------:|:---------:|:---------:|:---------:|
| **轻量 (<30MB)** | ✅ 12MB | ⚠️ 93MB | ❌ 300MB+ | ❌ 150MB | ❌ ~100MB | ❌ 150MB+ |
| **WYSIWYG Markdown** | ❌ 分屏预览 | ✅ 业界最佳 | ⚠️ Live Preview 尚可 | ❌ 富文本 | ⚠️ 有预览 | ⚠️ 大文件崩溃 |
| **插件系统** | ❌ | ❌ | ✅ 1000+社区插件 | ❌ | ❌ | ❌ |
| **多项目管理** | ❌ 单目录 | ❌ 单文件 | ⚠️ 单vault切换慢 | ❌ 单项目 | ⚠️ 库概念 | ❌ 笔记本 |
| **纯 Markdown 文件** | ✅ | ✅ | ⚠️ 有私有语法 | ❌ RTF/.scriv | ❌ JSON | ❌ 加密DB |
| **外部工具兼容** | ✅ vim/AI可编辑 | ✅ | ⚠️ wikilink等 | ❌ 专有格式 | ❌ | ❌ |
| **Zen Mode** | ⚠️ 基础 | ✅ 打字机+专注 | ⚠️ 需插件 | ✅ Composition | ✅ 暗室模式 | ❌ |
| **大文件性能 (10MB+)** | ⚠️ 降级高亮 | ⚠️ 较好 | ⚠️ 较好 | ⚠️ 鼓励拆分 | ❌ 卡片卡顿 | ❌ 5万字崩 |
| **写作专用功能** | ❌ | ❌ | ❌ 需插件 | ✅ 最强 | ✅ 字数目标/卡片 | ❌ |
| **跨平台** | ❌ macOS only | ✅ Win/Mac/Linux | ✅ 全平台 | ⚠️ Win/Mac/iOS | ✅ 全平台 | ✅ 全平台+Web |
| **导出能力** | ⚠️ 基础 | ✅ 多格式 | ⚠️ 需插件 | ✅ Compile系统 | ✅ 多格式 | ⚠️ 有限 |

> **结论：没有任何产品同时满足 "轻量 + 插件 + 多项目 + 纯Markdown + WYSIWYG"，这是 Novelist 的核心定位。**

## Architecture Comparison

| Tool | Tech Stack | App Size | Editor Engine | File Format |
|------|-----------|----------|---------------|-------------|
| **MiaoYan** | Swift/AppKit native | ~12MB | NSTextView + cmark-gfm preview | Plain .md files |
| **Typora** | Electron (custom fork) | ~93MB installer | Custom MD engine + morphdom | Plain .md files |
| **WonderPen** | Electron | ~100MB+ | Markdown + WYSIWYG | JSON (proprietary) |
| **Scrivener** | Native (Cocoa/MFC) | ~150MB | Rich text (RTF) | .scriv package (RTF + XML) |
| **Notesnook** | Electron + React | ~150MB+ | TipTap/ProseMirror | Encrypted DB |
| **Obsidian** | Electron + CodeMirror 6 | ~300MB+ | CodeMirror 6 + custom MD | Plain .md in vault |

## Key Insights by Feature Area

### 1. WYSIWYG / Near-WYSIWYG Markdown

- **Typora** is the gold standard: inline rendering with syntax hidden until cursor focus. Custom engine, not off-the-shelf.
- **Obsidian** uses CodeMirror 6 with Live Preview mode — good but not as seamless as Typora.
- **Notesnook** uses TipTap/ProseMirror — rich-text first, not truly markdown-native. Severe performance issues at 50k+ words.
- **MiaoYan** is split-pane only (edit left, preview right), not true WYSIWYG.
- **Lesson**: True WYSIWYG markdown needs a custom rendering layer. CodeMirror 6 with decorations is the most pragmatic path.

### 2. Lightweight Client (<30MB)

- **MiaoYan** achieves ~12MB by: native Swift, system WebKit, no bundled browser, 6 SPM deps, no database.
- **Typora** claims lightweight but is actually ~93MB due to Electron/Chromium.
- **Lesson**: To hit <30MB, must avoid Electron. Options:
  - **Tauri** (Rust + system webview): ~5-15MB typical. Best web-tech option.
  - **Native** (Swift/GTK/Win32): Smallest but platform-specific.
  - **Tauri is the sweet spot** — web frontend skills, Rust backend, system webview, tiny binary.

### 3. Plugin Architecture

- **Obsidian** has the best plugin system (1000+ community plugins), but it's heavy.
- **Typora** has ZERO plugin support — major weakness.
- **Scrivener** has ZERO plugin support.
- **WonderPen** has no plugins.
- **Notesnook** has no plugins.
- **Lesson**: Plugin architecture is a massive differentiator. None of the lightweight competitors have it.

### 4. Project-Level Management

- **Scrivener** is best at single-project management (Binder tree, Corkboard, Outliner) but terrible at multi-project.
- **Obsidian** is vault-based — switching vaults is clunky, can't have cross-vault references.
- **WonderPen** has library concept with tree structure, decent but limited.
- **VSCode** model (open any directory) is most flexible but has no writing-specific features.
- **Lesson**: "Open directory" model like VSCode, with writing-specific project metadata, is the winning approach.

### 5. External Tool Compatibility

- **MiaoYan**: Plain .md files — fully compatible with external editors.
- **Typora**: Plain .md files — fully compatible.
- **Scrivener**: Proprietary .scriv format with RTF — terrible for external tools.
- **WonderPen**: JSON storage — poor external compatibility.
- **Notesnook**: Encrypted DB — zero external compatibility.
- **Obsidian**: Plain .md files but some proprietary syntax (callouts, wikilinks).
- **Lesson**: Plain markdown files + minimal project metadata in a separate config file. No proprietary syntax.

### 6. Performance with Large Files

- **Notesnook**: Breaks at 50k+ words (TipTap/ProseMirror DOM limitation).
- **Typora**: Handles large files reasonably well with morphdom diffing.
- **MiaoYan**: Degrades gracefully (reduces syntax highlighting for large docs).
- **Scrivener**: Encourages splitting into small documents, so rarely faces this.
- **Lesson**: For 10MB+ text files, need:
  - Virtual scrolling (only render visible viewport)
  - Tree-sitter for incremental parsing
  - Rope data structure or piece table for text buffer
  - CodeMirror 6 already does viewport-only rendering

### 7. Zen Mode / Focus Writing

- **Typora**: Excellent focus mode and typewriter mode.
- **WonderPen**: Darkroom mode (locks you in until word goal), typewriter mode, composition mode.
- **Scrivener**: Composition mode (full-screen overlay).
- **Lesson**: Must have: full-screen zen mode, typewriter scrolling, focus on current paragraph (dim others).

## Competitive Gaps = Our Opportunities

1. **No lightweight editor has plugins** — MiaoYan/Typora are small but not extensible.
2. **No plugin-capable editor is lightweight** — Obsidian/VSCode are extensible but bloated.
3. **No tool does multi-project well** — Scrivener is single-project, Obsidian is single-vault.
4. **No tool combines WYSIWYG markdown + project management + plain files** in one lightweight package.
5. **External AI tool integration** is unaddressed — editors either ignore AI or bundle their own.

## Recommended Technology Stack for Novelist

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Framework** | **Tauri v2** | System webview → ~5-15MB binary. Rust backend for performance. |
| **Editor** | **CodeMirror 6** | Virtual scrolling, tree-sitter-ready, proven WYSIWYG (Obsidian uses it). |
| **Frontend** | **Solid.js** or **Svelte** | Minimal runtime (~7KB vs React 45KB). Fast, small. |
| **Markdown Parser** | **markdown-it** + custom plugins | Extensible, proven, lightweight. Or tree-sitter for incremental. |
| **File Storage** | **Plain .md files** | External tool friendly. |
| **Project Config** | **project.toml** per project | Minimal project metadata; export choices are request-local. |
| **Plugin System** | **WASM sandboxed** or **JS via quickjs** | Safe, cross-platform, fast. |
| **Large File Handling** | **CodeMirror 6 viewport rendering** + lazy loading | CM6 already handles millions of lines. |

## Core Architecture Decision Points

### 决策 1：编辑器方案

**选项 A — CodeMirror 6 Live Preview（Obsidian 路线）**
- 优势：已验证的方案，虚拟滚动开箱即用，社区生态好，装饰器系统可做 WYSIWYG
- 劣势：WYSIWYG 效果不如 Typora 那么无缝，需要大量自定义装饰器开发
- 适合：追求稳定性和插件生态

**选项 B — 自研渲染层（Typora 路线）**
- 优势：WYSIWYG 体验最佳，完全控制渲染
- 劣势：开发成本极高，需要自己处理虚拟滚动、IME、无障碍等
- 适合：追求极致编辑体验，团队有能力长期投入

**建议**：选 CodeMirror 6，在装饰器层投入精力逼近 Typora 效果。80% 的体验 20% 的成本。

### 决策 2：项目模型

```
~/my-novel/                     # 用户项目目录
├── .novelist/                  # 项目元数据（git 可忽略或可提交）
│   ├── project.toml            # 项目配置：名称、类型(novel/paper/script)、排序
│   ├── plugins.toml            # 插件配置
│   └── workspace.json          # UI 状态：打开的标签页、侧栏宽度（不提交）
├── chapters/
│   ├── 01-开头.md
│   ├── 02-发展.md
│   └── 03-高潮.md
├── notes/
│   └── 角色设定.md
└── references/
    └── 参考资料.md
```

- **"打开目录"模式**：像 VSCode 一样打开任意目录，自动识别 `.novelist/` 为项目
- **多项目**：支持同时打开多个项目窗口 / 标签组，快速切换（Cmd+Shift+P 项目选择器）
- **无 `.novelist/` 也能用**：打开任意 .md 文件即可编辑，零配置入门
- **项目类型模板**：论文、剧本、网文、教案/slides 各有预设结构

### 决策 3：插件系统

**选项 A — WASM 沙箱**
- 优势：安全隔离、跨平台、性能好
- 劣势：API 受限，开发门槛高，生态还不成熟

**选项 B — QuickJS 执行 JS 插件**
- 优势：JS 生态大，开发门槛低，API 灵活
- 劣势：需要自己设计沙箱，安全风险需要管控

**选项 C — 混合方案（推荐）**
- 核心插件 API 用 JS（QuickJS 或 Deno 嵌入），降低开发门槛
- 性能敏感插件可选 WASM
- 插件权限分级：只读插件（主题/语法高亮）vs 读写插件（白板/导出）vs 系统插件（文件系统/网络）

### 决策 4：导出系统（当前实现）

- 导出选项仅存在于当前对话框请求中，不使用 `.novelist/export.toml`
- Rust 只接受固定格式参数；插件不能注册 Pandoc 参数或新导出格式
- HTML 可嵌入当前主题；EPUB、DOCX、PDF 使用固定安全参数
- 导出时不修改源文件，完成后原子替换目标文件

### 决策 5：大文件性能策略

1. **CodeMirror 6 虚拟滚动**：只渲染可见视口，天然支持百万行
2. **增量解析**：tree-sitter 或 lezer（CM6 原生）做增量语法解析
3. **文件分块加载**：Rust 后端流式读取大文件，前端按需请求
4. **高亮降级**：超过阈值（如 500KB）自动简化语法高亮
5. **Rope 数据结构**：Rust 端用 ropey 库管理文本缓冲区，编辑操作 O(log n)

### 决策 6：Zen Mode 设计

- **全屏沉浸**：隐藏所有 UI，只剩文字和光标
- **打字机模式**：光标始终在屏幕中央，文本向上滚动
- **段落聚焦**：当前段落正常显示，其余段落淡化（可调透明度）
- **背景音**：可选白噪音/雨声（插件实现）
- **字数目标**：可设定本次写作目标，进度条低调显示
- **快捷键**：一键进出（如 F11 或 Cmd+Shift+Z）

## Target Positioning

```
            轻量 ←————————→ 重量
              │
    MiaoYan ● │
              │        ● Typora
              │
  ★ Novelist  │
              │
              │              ● Obsidian
              │    ● WonderPen
              │         ● Notesnook
              │                    ● Scrivener
              │
   简单 ←—————┼————————→ 功能丰富
              │
```

Novelist 的定位：**轻量级别接近 MiaoYan，功能丰富度介于 Typora 和 Obsidian 之间，通过插件系统达到 Obsidian 级别的可扩展性。**
