<div align="center">
  <img src="assets/branding/logo.png" alt="Novelist" width="128">

  # Novelist

  **A writing app that grows with you.**
  **一款与你一起成长的写作工具。**

  *Beautiful · Lightweight · Extensible · Free and open source*
  *优雅 · 轻巧 · 可扩展 · 自由开源*

  [![Release](https://img.shields.io/github/v/release/Saber-AI-Research/Novelist?display_name=tag)](https://github.com/Saber-AI-Research/Novelist/releases/latest)
  [![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
  [![Stars](https://img.shields.io/github/stars/Saber-AI-Research/Novelist?style=flat)](https://github.com/Saber-AI-Research/Novelist/stargazers)

  [Download / 下载](#download--下载) ·
  [Features / 特性](#features--特性) ·
  [Plugins / 插件](docs/references/creating-plugins.md) ·
  [Docs / 文档](docs/development.md) ·
  [Website](https://novelist.dev)

</div>

---

<div align="center">
  <img src="assets/screenshots/editor.png" alt="Novelist editor — headings, lists, tables, math, and CJK prose inline" width="900">
</div>

## Download / 下载

Latest release: **[v0.2.2](https://github.com/Saber-AI-Research/Novelist/releases/tag/v0.2.2)** · 最新版本

| Platform / 平台 | File / 文件 |
|---|---|
| macOS (Apple Silicon) | [`Novelist_0.2.2_aarch64.dmg`](https://github.com/Saber-AI-Research/Novelist/releases/download/v0.2.2/Novelist_0.2.2_aarch64.dmg) |
| Windows | [`Novelist_0.2.2_x64_en-US.msi`](https://github.com/Saber-AI-Research/Novelist/releases/download/v0.2.2/Novelist_0.2.2_x64_en-US.msi) · [`x64-setup.exe`](https://github.com/Saber-AI-Research/Novelist/releases/download/v0.2.2/Novelist_0.2.2_x64-setup.exe) |
| Linux (deb) | [`Novelist_0.2.2_amd64.deb`](https://github.com/Saber-AI-Research/Novelist/releases/download/v0.2.2/Novelist_0.2.2_amd64.deb) |
| Linux (rpm) | [`Novelist-0.2.2-1.x86_64.rpm`](https://github.com/Saber-AI-Research/Novelist/releases/download/v0.2.2/Novelist-0.2.2-1.x86_64.rpm) |
| Linux (AppImage) | [`Novelist_0.2.2_amd64.AppImage`](https://github.com/Saber-AI-Research/Novelist/releases/download/v0.2.2/Novelist_0.2.2_amd64.AppImage) |

System requirements / 系统要求 — macOS 11+ · Windows 10+ (64-bit) · Linux glibc 2.31+

## Features / 特性

### What You See Is What You Mean · 所见即所想

Just start typing. Your formatting appears instantly as you write — no switching between editing and preview. Headings, lists, quotes, tables, math, and CJK prose are all styled in place.

直接开始写。你的格式会在输入的同时即时呈现——不需要在编辑与预览之间切换。标题、列表、引用、表格、公式与中文段落，全部一体化呈现。

<div align="center">
  <img src="assets/screenshots/rich-content.png" alt="Rich content — tables, math, code, lists" width="900">
</div>

### Light, Yet Unstoppable · 轻巧而强劲

Novelist is tiny — about 12 MB. It launches instantly and barely touches your battery or memory. Even on files with hundreds of thousands of lines, editing stays smooth at 60 fps.

Novelist 只有约 12 MB。秒开、极低的电量与内存占用。哪怕是几十万行的超大文件，依然能保持 60 帧的流畅编辑。

### Designed for Deep Work · 为深度写作而生

| Feature | 中文 |
|---|---|
| **Zen Mode** — everything disappears except your words | **禅模式** — 除了你的文字，其他一切退场 |
| **Focus Mode** — the paragraph you're writing stays bright | **聚焦模式** — 正在写的段落最亮 |
| **Typewriter Mode** — current line stays centered | **打字机模式** — 当前行始终停在屏幕中央 |
| **Outline Panel** — jump to any heading | **大纲面板** — 跳转到任意章节 |
| **Word Goals** — daily target with progress | **字数目标** — 每日目标与进度 |
| **Multi-window** — research & writing side by side | **多窗口** — 研究与写作并排进行 |

<div align="center">
  <img src="assets/screenshots/zen.png" alt="Novelist in Zen Mode — centered column, minimal chrome" width="900">
</div>

### See the Shape of Your Story · 看见故事的轮廓

One keystroke (`⌘⇧M`) expands your document into a mindmap — every heading becomes a branch, every chapter a node. Zoom, fold, and jump straight to any section.

一次按键 (`⌘⇧M`)，将整篇文档展开成一张思维导图——每一个标题化为一条分支，每一个章节化为一个节点。

<div align="center">
  <img src="assets/screenshots/mindmap-overlay.png" alt="Novelist mindmap overlay — document headings radiate as a graph" width="900">
</div>

### Write in Any Language · 任意语言流畅书写

First-class support for **Chinese, Japanese, and Korean** — designed in from the start, not bolted on. Smooth IME, accurate character/word counting, proper line breaks and punctuation.

对**中文、日语、韩语**的一流支持——从第一天起就这样设计。流畅的输入法、精确的字数统计、合乎习惯的断行与标点。

<div align="center">
  <img src="assets/screenshots/cjk.png" alt="Novelist with a Chinese chapter — proper CJK typography and word count" width="900">
</div>

### Extend with Plugins · 通过插件扩展

QuickJS-sandboxed plugins, in-app scaffolding, native panels for AI Talk and AI Agent (Claude CLI). Browse the marketplace or write your own.

QuickJS 沙箱的插件系统，应用内一键脚手架，原生 AI Talk / AI Agent 面板（Claude CLI）。浏览市场或自己写一个。

### Details That Matter · 值得留意的细节

| | |
|:-:|:-:|
| <img src="assets/screenshots/split-view.png" alt="Split view" width="420"> <br> **Split view** · 分屏视图 | <img src="assets/screenshots/mermaid.png" alt="Mermaid + LaTeX" width="420"> <br> **Diagrams & math** · 图表与公式 |
| <img src="assets/screenshots/settings.png" alt="Settings" width="420"> <br> **Make it yours** · 随你调校 | <img src="assets/screenshots/export.png" alt="Export" width="420"> <br> **Export anywhere** · 随处导出 (HTML / PDF / DOCX / EPUB via Pandoc) |

## Quick Start / 快速开始

```bash
pnpm install
pnpm tauri dev      # dev with hot reload
pnpm tauri build    # production build
```

See [Development Guide / 开发指南](docs/development.md) for prerequisites and details.

## Documentation / 文档

| Document | Description |
|---|---|
| [Docs Index](docs/index.md) | Map of documentation structure |
| [Development Guide / 开发指南](docs/development.md) | Prerequisites, commands, project structure |
| [Keyboard Shortcuts / 快捷键](docs/references/keyboard-shortcuts.md) | All keyboard shortcuts |
| [Creating Themes / 创建主题](docs/references/creating-themes.md) | How to add custom themes |
| [Creating Plugins / 创建插件](docs/references/creating-plugins.md) | Plugin system guide |
| [Architecture](ARCHITECTURE.md) | Current system map and project status |
| [Reliability](docs/RELIABILITY.md) | Development and test harness |
| [Design Overview / 设计概览](docs/design-docs/design-overview.md) | Architecture & design decisions |
| [AGENTS.md](AGENTS.md) | Instructions for AI coding assistants |

## Design Philosophy / 设计理念

**"Prompt as UI"** — Novelist is designed to be customized by AI coding assistants editing the source directly, rather than through complex configuration UIs. The source code IS the API.

**"Prompt 即 UI"** — Novelist 的设计理念是通过 AI 编程助手直接修改源码来定制，而非复杂的配置界面。源码即接口。

## Contributing / 贡献

Issues, plugins, themes, and translations are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

欢迎 issue、插件、主题与翻译贡献。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## Acknowledgements / 致谢

Novelist's two AI panels (AI Talk and AI Agent) were inspired by
[claudian](https://github.com/YishenTu/claudian) and
[obsidian-yolo](https://github.com/Lapis0x0/obsidian-yolo) — thanks to
their authors for showing how an embedded AI agent can fit naturally
inside a writing tool. A full list of design references and bundled
third-party software is in [CREDITS.md](CREDITS.md).

Novelist 的两个 AI 面板受
[claudian](https://github.com/YishenTu/claudian) 与
[obsidian-yolo](https://github.com/Lapis0x0/obsidian-yolo)
启发,感谢这些项目的作者。完整的设计参考与第三方依赖清单见
[CREDITS.md](CREDITS.md)。

## License / 许可

[MIT](LICENSE) — Copyright © 2026 Chivier · Saber AI Research
