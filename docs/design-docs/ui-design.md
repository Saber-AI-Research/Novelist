# Novelist UI 设计方案

> **版本**: 0.2.0
> **日期**: 2026-04-08
> **状态（2026-11-03 复核）**：保留尚未实施的 UI 提案（如标签固定和书签面板）。下文“当前问题”、缺失功能表和未勾选路线图均记录 2026-04-08 的历史基线，不是当前缺陷清单；菜单、文件树、拖拽、工具栏、主题、搜索和设置等现有实现以 [架构总览](../../ARCHITECTURE.md)、[文件生命周期](file-lifecycle.md)、[编辑器](editor.md)和[设置架构](settings.md)为准。未实施提案未因此获得排期或发布承诺。

## 1. 历史基线（2026-04-08）

### 1.1 已实现功能

| 功能 | 状态 | 说明 |
|------|------|------|
| 打开文件夹 | OK | dialog 选择目录，加载文件树 |
| 打开/编辑文件 | OK | 点击侧边栏文件打开到 Tab |
| 保存文件 (Cmd+S) | OK | 原子写入 (write-tmp-then-rename) |
| 自动保存 | OK | 5 分钟间隔 |
| 文件监听 | OK | 外部修改检测 + 冲突对话框 |
| Tab 管理 | OK | 打开/关闭/切换 |
| 分栏编辑 | OK | Cmd+\\ 双栏 |
| 大纲面板 | OK | Cmd+Shift+O，标题导航 |
| 沉浸模式 | OK | F11，打字机滚动 + 段落聚焦 |
| 命令面板 | OK | Cmd+Shift+P |
| 导出 | OK | pandoc HTML/PDF/DOCX/EPUB |
| 最近项目 | OK | Welcome 页面展示 |
| 插件系统 | OK | QuickJS 沙盒，已有基础架构 |

### 1.2 已修复缺陷 (本次)

| 缺陷 | 修复 |
|------|------|
| 打开文件夹无反应 | 添加 `dialog:allow-open` 权限 |
| 图标 16-bit 导致启动崩溃 | 转换为 8-bit RGBA PNG |
| 无法创建文件 | 新增 `create_file` Rust 命令 + 侧边栏 UI |
| 无法创建文件夹 | 新增 `create_directory` 命令 + UI |
| 无法重命名 | 新增 `rename_item` 命令 + 右键菜单 |
| 无法删除 | 新增 `delete_item` 命令 + 右键菜单 |
| 窗口标题不更新 | 添加 `$effect` 动态更新标题 |

### 1.3 仍然缺失的功能

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 原生菜单栏 | P0 | macOS 上只有空菜单，缺少 File/Edit/View |
| 侧边栏文件夹展开/折叠 | P0 | 当前文件夹不可展开，子目录内容不可见 |
| 侧边栏宽度可拖拽 | P1 | 固定 240px |
| Tab 右键菜单 | P1 | 无 Close Others/Close All |
| 状态栏信息不足 | P1 | 仅 word count + cursor |
| Command Palette 模糊搜索 | P1 | 仅 substring 匹配 |
| 文件快速跳转 (Cmd+P) | P1 | 无 |
| Markdown 格式工具栏 | P2 | 无 |
| 手动主题切换 | P2 | 仅跟随系统 |
| 拖拽文件夹到窗口打开 | P2 | 无 drag/drop 支持 |
| Tab 拖拽排序 | P3 | 无 |
| 全局搜索 | P3 | 无 |

---

## 2. 原生菜单栏设计

当前 App 完全没有原生菜单栏。macOS 用户期望标准的 File/Edit/View 菜单。需要在 Rust 端使用 Tauri Menu API 构建。

### 2.1 菜单结构

```
Novelist
├── About Novelist
├── Settings...              Cmd+,
├── ─────────────
├── Hide Novelist            Cmd+H
├── Hide Others              Cmd+Alt+H
├── ─────────────
└── Quit Novelist            Cmd+Q

File
├── New File                 Cmd+N
├── Open Folder...           Cmd+O
├── Open Recent            ▸ (子菜单: 最近 10 个项目)
├── ─────────────
├── Save                     Cmd+S
├── Save All                 Cmd+Alt+S
├── ─────────────
├── Export...                Cmd+Shift+E
├── ─────────────
└── Close Tab                Cmd+W

Edit
├── Undo                     Cmd+Z
├── Redo                     Cmd+Shift+Z
├── ─────────────
├── Cut                      Cmd+X
├── Copy                     Cmd+C
├── Paste                    Cmd+V
├── Select All               Cmd+A
├── ─────────────
├── Find                     Cmd+F
└── Replace                  Cmd+H

View
├── Command Palette          Cmd+Shift+P
├── ─────────────
├── Toggle Sidebar           Cmd+B
├── Toggle Outline           Cmd+Shift+O
├── Toggle Split View        Cmd+\
├── ─────────────
├── Zen Mode                 F11
├── ─────────────
├── Zoom In                  Cmd+=
├── Zoom Out                 Cmd+-
└── Reset Zoom               Cmd+0

Help
├── Keyboard Shortcuts
└── About Novelist
```

### 2.2 实现方案

在 `core/src/lib.rs` 中用 `tauri::menu::MenuBuilder` 构建菜单，通过 `on_menu_event` 处理点击事件，再通过 Tauri Event 通知前端执行对应操作。

```
Rust 菜单点击 → emit("menu-action", { action: "new-file" }) → 前端 listen → 执行
```

### 2.3 与 Command Palette 的关系

所有菜单项同时注册到 Command Palette，保持快捷键一致。菜单 = 可视化入口，Palette = 键盘入口，两者调用同一个 handler。

---

## 3. 侧边栏设计

### 3.1 当前问题

- 文件夹不可展开/折叠，只显示顶级
- 宽度固定 240px，不可调整
- 无右键菜单 (已修复: 本次添加了 Rename/Delete)
- 无搜索/过滤
- 只有「文件树」一种面板

### 3.2 文件树改进

#### 3.2.1 可折叠目录树

```
▼ 📁 chapters/
    📄 01-beginning.md
    📄 02-development.md
▶ 📁 notes/                  ← 折叠状态
📄 README.md
```

- 点击文件夹名称展开/折叠子目录
- 子目录内容按需加载 (调用 `list_directory`)
- 展开状态保存在内存中 (不持久化，重新打开项目恢复默认)
- 缩进层级用 padding-left 表示，每级 16px

#### 3.2.2 可拖拽宽度

侧边栏右边缘添加 4px 拖拽手柄：
- 最小宽度: 180px
- 最大宽度: 400px
- 拖拽时显示 `col-resize` 光标
- 宽度保存到 `uiStore.sidebarWidth`

#### 3.2.3 右键上下文菜单

**文件右键:**
```
Rename              F2
Delete
────────
Copy Path
Reveal in Finder
```

**文件夹右键:**
```
New File
New Folder
────────
Expand All
Collapse All
────────
Rename              F2
Delete
────────
Copy Path
Reveal in Finder
```

`Expand All` / `Collapse All` 作用于该文件夹整棵子树（递归），底层调用
`projectStore.expandFolderRecursive(path)` /
`projectStore.collapseFolderRecursive(path)`。展开为宽度优先 + 惰性加载未
读取的子节点；折叠不释放已加载的子节点缓存，再次展开瞬时完成。

**空白区域右键:**
```
New File
New Folder
────────
Expand All
Collapse All
────────
Refresh
```

空白区域的 `Expand All` / `Collapse All` 以项目根目录为子树根。

#### 3.2.4 顶部搜索/过滤

在项目名下方添加输入框，实时过滤文件名：

```
┌───────────────────┐
│ [Open Folder] [+] │
│ My Novel          │
│ 🔍 Filter...      │  ← 新增
├───────────────────┤
│ ▼ 📁 chapters/    │
│    📄 01-begin... │
```

- 输入即过滤，无需回车
- 匹配文件名和路径
- 空输入显示全部

### 3.3 多面板 (P2)

侧边栏顶部 Tab 切换：

```
[Files] [Search] [Bookmarks]
```

- **Files**: 当前文件树 (默认)
- **Search**: 项目全局搜索 (P3 实现)
- **Bookmarks**: 收藏的文件/位置 (P3 实现)

---

## 4. 标签栏设计

### 4.1 当前问题

- 无右键菜单
- 无拖拽排序
- 无 Pin 功能
- Tab 溢出时只能水平滚动，无指示

### 4.2 右键上下文菜单

```
Close                        Cmd+W
Close Others
Close All
Close Saved
────────
Pin Tab
────────
Copy Path
Reveal in Sidebar
```

### 4.3 Tab 溢出处理

当 Tab 过多时：
- 显示左/右滚动箭头按钮
- 最右侧显示「...」下拉按钮，列出所有打开的 Tab
- 活跃 Tab 始终可见 (自动滚动到视图内)

### 4.4 Pin 功能

- Pin 的 Tab 靠左排列，不显示关闭按钮
- Pin 的 Tab 只显示图标，不显示文件名 (节省空间)
- 右键菜单中 Pin/Unpin 切换

### 4.5 脏标记改进

当前使用红色圆点 ●。改进为:
- 未保存: 文件名后显示小圆点，使用 accent 颜色
- 关闭脏 Tab 时弹出确认: "Save changes to {filename}?"，三个按钮: Save / Don't Save / Cancel

---

## 5. 状态栏设计

### 5.1 当前

```
2340 words | Goal: 117% | Ln 45, Col 12
```

### 5.2 改进方案

```
┌────────────────────────────────────────────────────────────────┐
│ 📁 My Novel │ Markdown │ UTF-8 │ LF ·· 2340 words │ ██░ 117% │ Ln 45, Col 12 │
└────────────────────────────────────────────────────────────────┘
```

**左侧区域:**
- 项目名称 (可点击切换项目)
- 文件类型标识 (Markdown)
- 编码 (UTF-8)
- 换行符 (LF / CRLF)

**右侧区域:**
- 字数统计 (点击切换: 字数 → 字符数 → 段落数 → 预计阅读时间)
- 写作目标进度条 (mini 进度条 + 百分比)
- 光标位置

### 5.3 交互细节

- 点击「字数」区域: 弹出详细统计面板 (字数/字符数/段落数/阅读时间)
- 点击「项目名」: 打开项目切换列表
- 点击「编码」: 未来支持编码切换 (当前只读)

---

## 6. Command Palette 设计

### 6.1 当前问题

- 仅 6 条命令
- substring 匹配，无模糊搜索
- 无文件跳转功能

### 6.2 双模式设计

参考 VS Code 的设计，Command Palette 支持两种模式:

**命令模式 (输入 `>` 前缀):**
```
┌─────────────────────────────────────────┐
│ > toggle                                │
├─────────────────────────────────────────┤
│ > Toggle Sidebar              Ctrl+B    │
│ > Toggle Outline              Ctrl+⇧+O  │
│ > Toggle Zen Mode             F11       │
│ > Toggle Split View           Ctrl+\    │
└─────────────────────────────────────────┘
```

**文件跳转模式 (无前缀，类似 Cmd+P):**
```
┌─────────────────────────────────────────┐
│ chapter                                 │
├─────────────────────────────────────────┤
│ 📄 01-beginning.md     chapters/       │
│ 📄 02-development.md   chapters/       │
│ 📄 03-climax.md        chapters/       │
└─────────────────────────────────────────┘
```

### 6.3 快捷键

- `Cmd+Shift+P`: 打开命令面板 (命令模式，自动带 `>`)
- `Cmd+P`: 打开命令面板 (文件跳转模式，无前缀)

### 6.4 模糊搜索

使用简单的模糊匹配算法:
- 按字符顺序匹配 (如 `tgl` 匹配 `Toggle`)
- 连续匹配加分
- 开头匹配加分
- 匹配字符高亮显示

### 6.5 扩展命令列表

除现有 6 条外，增加:

| 命令 | 快捷键 | 说明 |
|------|--------|------|
| New File | Cmd+N | 在当前目录创建文件 |
| Save All | Cmd+Alt+S | 保存所有脏文件 |
| Close Tab | Cmd+W | 关闭当前 Tab |
| Go to Line | Cmd+G | 跳转到指定行 |
| Export Project | Cmd+Shift+E | 打开导出对话框 |
| Change Theme | - | 切换主题 |
| Insert Timestamp | - | 插入当前时间 |
| Word Count Stats | - | 显示详细字数统计 |
| Reload File Tree | - | 刷新侧边栏文件列表 |
| Open Settings | Cmd+, | 打开设置 (未来) |

---

## 7. Markdown 格式工具栏

### 7.1 定位

面向不熟悉 Markdown 快捷键的用户，提供可视化格式按钮。位于 TabBar 和编辑区之间，可在 View 菜单中隐藏。

### 7.2 布局

```
┌──────────────────────────────────────────────────────────────┐
│ [B] [I] [S] [~] │ [H▾] [Link] [Image] [Code] │ [List] [☐] │ [Table]
└──────────────────────────────────────────────────────────────┘
```

| 按钮 | 功能 | 插入内容 |
|------|------|---------|
| **B** | 加粗 | `**文本**` |
| **I** | 斜体 | `*文本*` |
| **S** | 删除线 | `~~文本~~` |
| **~** | 行内代码 | `` `代码` `` |
| **H** | 标题 (下拉) | `# ` ~ `###### ` |
| **Link** | 链接 | `[文本](url)` |
| **Image** | 图片 | `![alt](url)` |
| **Code** | 代码块 | ` ```\n\n``` ` |
| **List** | 无序列表 | `- ` |
| **CheckList** | 任务列表 | `- [ ] ` |
| **Table** | 表格 | 插入 3x3 表格模板 |

### 7.3 行为

- 有选中文本时: 包裹选中文本
- 无选中文本时: 插入模板并移动光标到内容位置
- 工具栏默认隐藏，通过 View → Show Toolbar 开启
- 记住显示/隐藏状态

---

## 8. 主题与外观

### 8.1 当前

仅 light/dark 跟随系统 (`prefers-color-scheme` 媒体查询)。

### 8.2 改进方案

#### 内置主题

| 主题 | 说明 |
|------|------|
| Light | 当前默认亮色 |
| Dark | 当前默认暗色 |
| Sepia | 暖色调护眼 (米黄底，深褐字) |
| Nord | 冷色调 (基于 Nord 配色) |

#### 主题切换方式

- 状态栏右侧主题图标按钮
- Command Palette: `> Change Theme`
- 快捷键: `Cmd+K Cmd+T` (VS Code 风格)
- 选项: Light / Dark / Sepia / Nord / System (跟随系统)

#### Sepia 主题色值

```css
--novelist-bg: #f5f0e8;
--novelist-bg-secondary: #ede6d8;
--novelist-text: #433422;
--novelist-text-secondary: #7a6b5a;
--novelist-accent: #b07040;
--novelist-border: #d5c9b5;
--novelist-code-bg: #e8e0d0;
```

### 8.3 编辑器字体设置

通过 Settings 面板 (未来) 或 Command Palette 可配置:

- 字体族: Noto Serif SC / LXGW WenKai / 思源宋体 / 系统默认
- 字号: 14px / 16px / 18px / 20px
- 行距: 1.5 / 1.8 / 2.0
- 编辑区最大宽度: 680px / 720px / 800px / 100%

---

## 9. Welcome 页面改进

### 9.1 当前

简单的最近项目列表 + Open Directory 按钮。

### 9.2 改进方案

```
┌───────────────────────────────────────────────────┐
│                                                   │
│                   Novelist                        │
│           Lightweight Markdown Writer              │
│                                                   │
│  ┌─────────────┐  ┌─────────────┐                 │
│  │ Open Folder │  │  New File   │                 │
│  └─────────────┘  └─────────────┘                 │
│                                                   │
│  Recent Projects                                  │
│  ┌───────────────────────────────────────────┐    │
│  │ 📁 My Novel                               │    │
│  │    ~/writing/novel · 3 days ago           │    │
│  │ 📁 Research Paper                         │    │
│  │    ~/papers/2026 · 1 week ago             │    │
│  │ 📁 Course Notes                           │    │
│  │    ~/teaching/cs101 · 2 weeks ago         │    │
│  └───────────────────────────────────────────┘    │
│                                                   │
│  Tip: Cmd+Shift+P to open Command Palette        │
│                                                   │
└───────────────────────────────────────────────────┘
```

改进点:
- 增加「New File」按钮 (直接创建空白 .md 并打开)
- 最近项目显示相对时间 (3 days ago)
- 底部随机 Tip 提示快捷键
- 空项目列表时显示引导文案

---

## 10. 历史实现路线图（勾选状态不代表当前进度）

### Phase 1: 核心功能补全 (当前)

已完成:
- [x] 文件创建/删除/重命名
- [x] 右键上下文菜单
- [x] 动态窗口标题
- [x] 打开文件夹权限修复

### Phase 2: 菜单栏 + 侧边栏增强

- [ ] 原生菜单栏 (File/Edit/View/Help)
- [ ] 侧边栏文件夹可折叠
- [ ] 侧边栏宽度可拖拽
- [ ] 侧边栏文件过滤
- [ ] Cmd+P 文件快速跳转
- [ ] Command Palette 模糊搜索

### Phase 3: 编辑体验提升

- [ ] Markdown 格式工具栏
- [ ] Tab 右键菜单 (Close Others/Close All)
- [ ] 状态栏增强 (编码、换行符、详细统计)
- [ ] 关闭脏 Tab 时保存确认
- [ ] 拖拽文件夹到窗口打开

### Phase 4: 主题与个性化

- [ ] 内置主题 (Sepia / Nord)
- [ ] 手动主题切换
- [ ] 编辑器字体/字号/行距设置
- [ ] Welcome 页面改进

### Phase 5: 高级功能

- [ ] 全局项目搜索
- [ ] Tab 拖拽排序 + Pin
- [ ] 侧边栏多面板 (文件/搜索/书签)
- [ ] 设置面板 UI
