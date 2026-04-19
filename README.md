<div align="center">
  <img src="assets/branding/novelist-icon.png" alt="Novelist" width="128">

  # Novelist

  **A lightweight WYSIWYG Markdown editor for novelists.**

  **轻量级所见即所得 Markdown 写作工具。**

  [![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

  [Features](#features--特性) | [Download](#download--下载) | [Development](docs/development.md) | [Plugins](docs/creating-plugins.md)

</div>

---

## Screenshot / 截图

> TODO: Add screenshot here

## Features / 特性

- **WYSIWYG Markdown** — Typora-style live preview / 类 Typora 实时预览
- **GFM & Extensions** — Tables, task lists, strikethrough / 表格、任务列表、删除线
- **Split View** — Two-pane editing (Cmd+\\) / 双栏编辑
- **Zen Mode** — Fullscreen + typewriter scrolling (F11) / 全屏 + 打字机滚动
- **Themes** — Light, Dark, Sepia, Nord, GitHub, Dracula / 多主题切换
- **Sidebar Folder Tree** — Recursive tree with drag-drop reorder / 递归文件夹树，支持拖拽重排
- **Plugin System** — QuickJS sandbox with in-app scaffolding / QuickJS 沙箱，支持应用内脚手架
- **Project Search** — Cmd+Shift+F across the project / 项目内搜索
- **Multi-Window** — Cmd+Shift+N for a new independent window / 多窗口
- **Export** — HTML, PDF, DOCX, EPUB via Pandoc / 多格式导出
- **CJK-Aware** — Proper word count & IME handling / 中日韩文字支持
- **Large Files** — Tiered performance up to 10MB+ / 大文件分级优化
- **Project Management** — Multi-project switching / 多项目管理

## Download / 下载

> Coming soon — Currently build from source only.
>
> 即将发布 — 目前仅支持从源码构建。

## Quick Start / 快速开始

```bash
pnpm install
pnpm tauri dev
```

See [Development Guide](docs/development.md) for prerequisites and details.

开发环境配置详见 [开发指南](docs/development.md)。

## Documentation / 文档

| Document | Description |
|----------|-------------|
| [Development Guide / 开发指南](docs/development.md) | Prerequisites, commands, project structure |
| [Keyboard Shortcuts / 快捷键](docs/keyboard-shortcuts.md) | All keyboard shortcuts |
| [Creating Themes / 创建主题](docs/creating-themes.md) | How to add custom themes |
| [Creating Plugins / 创建插件](docs/creating-plugins.md) | Plugin system guide |
| [Design Overview / 设计概览](docs/design/design-overview.md) | Architecture & design decisions |

## Design Philosophy / 设计理念

**"Prompt as UI"** — Novelist is designed to be customized by AI coding assistants editing the source directly, rather than through complex configuration UIs. The source code IS the API.

**"Prompt 即 UI"** — Novelist 的设计理念是通过 AI 编程助手直接修改源码来定制，而非复杂的配置界面。源码即接口。

## Contributing / 贡献

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License / 许可

[MIT](LICENSE) - Copyright (c) 2026 Chivier
