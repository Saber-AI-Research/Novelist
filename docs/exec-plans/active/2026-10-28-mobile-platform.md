# 移动端（iOS / Android）平台化执行计划

> Steps use checkbox (`- [ ]`) syntax for tracking.
> 状态：适配实现与 Android 真机验证已落地，iOS 原生验证转到用户批准的专用分支/草稿 PR 与 GitHub Xcode CI；不合并、不发布。Android 发布密钥已按用户选择在本机受限目录新建；Apple 发布身份与 TestFlight 审核仍需真实账号材料。

**Goal:** 在同一仓库、同一 Tauri v2 应用内交付 iOS 与 Android 版本；桌面端行为与数据布局保持不变。

**Architecture:** 不换框架。把 `core/` 拆为「平台无关领域层 + 桌面/移动外壳」；IPC 命令集合跨平台保持一致，桌面专属命令在移动端返回 `AppError::Unsupported`；前端通过平台能力表（capabilities）切换桌面布局与移动布局；移动端数据存放在 App 沙盒内，跨设备经现有 WebDAV 同步。

**Tech Stack:** Tauri v2 mobile（Xcode / Android NDK）、Rust、Svelte 5、CodeMirror 6、rquickjs、WebDAV（`services/webdav.rs`）。

---

## 1. 现状基线（2026-10-28，v0.6.1）

已具备：

- `core/src/lib.rs:332` 已有 `#[cfg_attr(mobile, tauri::mobile_entry_point)]`。
- `crate-type = ["lib", "cdylib", "staticlib"]` 已满足 Android（cdylib）与 iOS（staticlib）。
- WebDAV 同步、快照、项目身份（`adopt_sync_identity`）已存在，可直接作为移动端跨设备通道。
- 命令中心化：`app/lib/app-commands.ts` 是唯一 `commandRegistry.register` 点，触控 UI 可复用。

桌面耦合清单（代码扫描所得）：

| 区域 | 位置 | 性质 |
|---|---|---|
| 数据根目录 | `services/portable.rs:40` 用 `dirs::home_dir().expect(..)` + `~/.novelist`；`lib.rs:344` 在 Builder 创建**之前**调用 `portable::init()` | 移动端需 AppHandle 才能拿到沙盒路径 **[推断]** Android 上 home_dir 不可用或不可写 |
| 使用数据根的模块 | 30 个 Rust 文件（commands 15、services 13、models 2） | 需统一走一个入口 |
| 原生菜单 | `core/src/menu.rs`、`lib.rs:777` | 仅桌面 |
| 单实例 / CLI shim / portable | `lib.rs:742`、`commands/cli_shim.rs`、`services/portable.rs`、`app/lib/services/cli-*.ts` | 仅桌面 |
| 更新器 / 进程重启 | `lib.rs:795`、`app/lib/updater.ts`、`services/update-checker.ts` | 仅桌面（iOS 由 TestFlight 更新；Android APK 手动覆盖安装） |
| 外部进程 | `services/pandoc.rs`、`publish/*pandoc*`、`file.rs:1526-1548`（Claude/Codex CLI 桥接已随 AI Agent 移除，见 M1 前置） | 移动端不可用 |
| 剪贴板 | `arboard`：`commands/publish.rs:240`（读图）、`commands/styled_copy.rs:101`（写 HTML） | **[推断]** arboard 不支持 iOS/Android，编译失败 |
| 文件监听 | `notify` + `macos_fsevent` | **[推断]** iOS 无 FSEvents |
| 目录选择 | `open({ directory: true })` × 6：`App.svelte:546`、`NewProjectDialog.svelte:110`、`Settings.svelte:282`、`Sidebar.svelte:276`、`LiteraryImportDialog.svelte:146`、`TranslationImportDialog.svelte:143` | 移动端无「任意目录」语义 |
| 窗口 API | 26 个前端文件引用 `WebviewWindow` / `getCurrentWindow` / desktop 插件；多窗口 `novelist-*` | 移动端单窗口 |
| 鼠标交互 | 58 个组件中 42 个使用 hover / contextmenu / mousedown | 需触控替代 |
| 插件资源 scope | `tauri.conf.json` `assetProtocol.scope = $HOME/.novelist/plugins/**` | 需随数据根变化 |
| IPC 构建器 | `lib.rs:381` 与 `lib.rs:549` 两份 `collect_commands!`（`sync` feature 分支） | 再加平台 cfg 会变 4 份 |
| 生成目录 | `.gitignore` 忽略整个 `core/gen/` | `gen/apple`、`gen/android` 需入库 |

## 2. 关键设计决策

**D1 同仓同应用。** 不建独立移动仓库/应用；`tauri ios init` / `tauri android init` 产物入库（`core/gen/apple/`、`core/gen/android/`），`core/gen/schemas/` 继续忽略。理由：领域逻辑与插件只有一份。

**D2 命令集合跨平台一致。** 所有 `#[tauri::command]` 在所有平台注册；桌面专属命令体用 `#[cfg(desktop)]` 实现，`#[cfg(mobile)]` 分支返回新增的 `AppError::Unsupported(&'static str)`。理由：`app/lib/ipc/commands.ts` 由桌面 dev 生成，若按平台增删命令，绑定与移动端运行时不一致；同时避免把 `lib.rs` 的两份命令列表扩成四份。同期把两份 `collect_commands!` 收敛为一个宏/函数（`sync` feature 只影响命令体，不影响列表）。

**D3 平台能力表驱动 UI。** 新增命令 `get_platform_capabilities() -> PlatformCapabilities`，前端不做 UA 嗅探：

```rust
pub struct PlatformCapabilities {
    pub os: PlatformOs,            // macos | windows | linux | ios | android
    pub is_mobile: bool,           // phone/tablet 由前端实时视口派生；两者功能相同，仅布局不同
    pub native_menu: bool,
    pub multi_window: bool,
    pub pick_directory: bool,      // 任意目录作为项目
    pub external_processes: bool,  // pandoc 等外部二进制
    pub self_update: bool,
    pub cli_shim: bool,
    pub file_watcher: bool,
    pub plugin_install: bool,      // marketplace 安装：iOS false，Android / 桌面 true
    pub export_formats: Vec<String>,
}
```

**D4 移动端存储 = 沙盒项目库。** 移动端不支持「打开任意文件夹」：
- iOS 用户项目位于 `Documents/Projects/<project>`，开启 `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace`；Android 用户项目位于 App 私有目录 `Projects/`。设置、插件与同步元数据始终位于独立的 `app_data_dir`，**不暴露在 iOS「文件」App**。
- 导入：从系统文件选择器选 `.md/.txt/.epub/.zip` → 复制进项目库；导出：项目打 zip（已有 `zip` crate）→ 系统分享面板。
- 跨设备：WebDAV 同步是一等公民。
- 不做 Android SAF 外部目录与 iOS security-scoped bookmark（列入后续，非本计划）。

**D5 移动端持久化不存绝对路径。** iOS 应用容器路径会随更新变化，所有持久化（最近项目、workspace、同步/快照/统计索引、设置中的路径）在移动端以 `project_id` 或相对 data_root 的路径保存。桌面端格式不变。

**D6 移动端关闭文件监听。** 没有外部写入者（iOS「文件」App 原地编辑除外）；改为 App 回到前台（resume）时对已打开项目做一次基于 BLAKE3 的重扫描，复用现有自写抑制与冲突逻辑。

**D7 数据根延迟初始化。** 桌面保持早期 `portable::init()`（`~/.novelist` / portable，行为不变）；移动端在 `setup` 开始由 `app.path().app_data_dir()` 初始化 `portable::init_mobile()`，另保存用户项目库与缓存路径。保留 `novelist_home()` 为唯一既有数据根访问器，避免额外平行路径约定。初始化前访问数据根的代码路径须清零。

**D8 移动端功能边界（v1）。**

| 功能 | 桌面 | 移动 v1 |
|---|---|---|
| WYSIWYG 编辑、CJK/IME、字数统计 | ✓ | ✓（重点验收） |
| 项目树、新建/重命名/移动、模板面板、智能命名 | ✓ | ✓（触控交互） |
| 快照、写作统计、WebDAV 同步 | ✓ | ✓ |
| canvas / mindmap / kanban / literary-commentary / book-translation | ✓ | ✓（触控适配，见 M4） |
| 分屏、多窗口、标签条 | ✓ | ✗（单栏） |
| Pandoc 导出、styled copy、在线发布中依赖 pandoc 的部分 | ✓ | ✗；保留 Markdown/HTML 导出 + 分享面板 |
| AI Talk（OpenAI 兼容 HTTP 聊天，`ai_bridge.rs` SSE） | ✓ | ✓（窄屏布局，见 M3） |
| AI Agent（Claude / Codex CLI harness） | 已移除 | 已移除 |
| 图床上传、Google/LLM 翻译（HTTP） | ✓ | ✓（纯 reqwest） |
| 自动更新、CLI shim、portable、原生菜单 | ✓ | ✗ |
| 插件 marketplace 安装 | ✓ | Android ✓；iOS ✗（仅内置插件） |

## 3. 版本映射

| 版本 | 内容 | 平台 |
|---|---|---|
| 1.0.0 | M1 + M2 中与平台无关的结构迁移；版本号单一来源；桌面签名/发布流水线整理 | 仅桌面，用户无感 |
| 1.1.0-beta.N | M0–M4 完成；iOS TestFlight + Android 签名 APK（GitHub Release） | 桌面 + 移动 beta |
| 1.1.0 | 移动端随桌面同 tag 发布：iOS 持续走 TestFlight，Android 持续走 GitHub APK；不上 App Store / Google Play | 正式 |

## 4. 阶段与任务

### M0 工具链与原生工程

- [x] 安装四个 Rust targets：`aarch64-apple-ios`、`aarch64-apple-ios-sim`、`aarch64-linux-android`、`x86_64-linux-android`；安装 Android SDK 36、NDK 27.2、JDK 17、CocoaPods、XcodeGen。
- [x] GitHub `macos-26` / Xcode 26.6 Mobile CI（PR #6，run 40723119422）：iOS device/simulator Clippy、模拟器 `.app` 构建，以及全新 iPhone 17e 与 iPad 模拟器启动截图均通过。
- [x] 实际运行 `pnpm tauri ios init --ci --skip-targets-install` / `pnpm tauri android init --ci --skip-targets-install` 生成原生工程；将源码与 iPad 目标配置入库，排除机器路径/签名密钥/构建产物。
- [x] Android arm64 / x86_64 实际 Clippy 检查通过；两种 ABI 的 Release APK 已链接、R8 打包，并通过 16 KiB ELF/ZIP 对齐校验。
- [x] iOS 模拟器真实 Rust IPC 门禁在 iPhone 与 iPad 上均通过：内置资源、新建 Novel 项目（落盘 `Documents/Projects`）、WebKit 输入 CJK 并保存（磁盘字节一致）、文学评注 asset iframe 像素检查、Keychain 账号重启后仍在线、真实 Apache WebDAV 同步 5 个文件且服务端字节一致。
- [x] Android 真机验证主界面、沙盒项目库、CJK 保存、后台 flush、杀进程恢复、Keystore 升级保留、真实 WebDAV 双向传输、原生分享取消与评注 iframe。
- [ ] 真机 IME 冒烟：iOS 拼音/注音/日文、Android Gboard/搜狗/百度，在 CM6 中输入段落、`「」`/`【】`、中文标点。

**验收：** `docs/exec-plans/active/` 本文追加「M0 实测阻塞表」，替换全部 **[推断]** 条目；给出 IME 是否需要 CM6 层改造的结论。

### M1 Rust 平台分层（桌面零行为变化）

- [x] 前置：全平台移除 AI Agent harness（`claude_bridge.rs`、`codex_bridge.rs`、`ai-agent/` 面板、设置、快捷键、Apply Changes 链路及其死代码），保留 AI Talk 与书籍翻译的 LLM 参考译文。IPC 减少 9 个命令（含 `write_file_if_unchanged`、`delete_ai_session`）与一整类外部进程依赖。（2026-10-28 完成）
- [x] 按 target 隔离 updater / single-instance / process / arboard 等桌面依赖；Android 使用 rustls，避免交叉编译 OpenSSL；OS watcher 在移动端不启动，保留共享轮询逻辑。
- [x] `AppError::Unsupported` 与明确的平台错误已实现，不以成功 no-op 冒充桌面功能。
- [x] `lib.rs` 的重复命令列表已收敛；生成的 TypeScript IPC 保持对应原生实现。
- [x] 原生菜单、单实例、更新器、进程与冷启动 CLI 处理仅在桌面注册；移动端最早在 setup 初始化沙盒路径。
- [x] 移动端 Pandoc、styled copy、原生图像剪贴板、CLI shim、reveal、菜单刷新与 in-app devtools 返回明确不支持；UI 同步隐藏入口。移动 Release 不开启 WebView inspector。
- [x] `services/platform.rs` 与 `get_platform_capabilities` 已实现；phone/tablet 布局由实时视口派生。
- [x] `.github/workflows/mobile-ci.yml` 已实现 Android 与 iOS 平台门禁；每个 cargo target 顺序检查，避免 Tauri Android 插件共享生成目录竞态。

**验收：** 桌面/共享 Rust、前端与 Android 已实测；iOS 不因静态配置或 host 单测通过而视为验收，须等上述原生 CI 门禁。

### M2 存储与生命周期

- [x] `portable.rs` 保留唯一数据根访问器；移动端独立初始化私有元数据、用户项目库与缓存，桌面 portable 布局不变。
- [x] 初始化前的路径访问已隔离；Android 嵌入并解包内置资源，不用 std::fs 读取 `asset://`。
- [x] 同步/快照/统计使用稳定存储键与现有测试 seam；移动远端快照以项目身份隔离，避免同名项目碰撞。
- [x] 最近项目、工作区与文件引用保持库内/项目内相对身份；公共库 API 返回同一配置根拼写，避免 Android `/data/data` 与 `/data/user/0` 使工作区回退到绝对路径。
- [x] 库、暂存、ZIP 导入/导出、Markdown/HTML 导出 API 已实现；导入边界/原子发布/CJK/敏感文件排除有行为测试，项目创建复用模板命令。
- [x] iOS/Android 平台配置与私有插件 asset scope 已实现；Android 评注 iframe 已在真机加载。
- [x] 移动端保留 tracked-file 轮询与前台重扫；真实远端编辑下载后，Android 已打开的编辑器自动更新。
- [x] 缩短移动编辑保存延迟，隐藏/pagehide 时 flush；Android 未点击保存的文本经 HOME、force-stop 后仍在磁盘。后台回调不是唯一防丢稿保证。

**验收：** 移动模拟器中：创建项目 → 编辑 → 杀进程 → 重启，内容完整；App 更新安装后（模拟容器路径变化）最近项目仍可打开；WebDAV 与桌面双向同步一个项目无冲突。

### M3 前端平台外壳

- [x] `platform.svelte.ts` 原生能力与实时布局状态已接入，手机/平板保留完整编辑能力。
- [x] 窗口、菜单、更新、CLI、多窗口等调用按能力隔离；错误不靠隐藏异常掩盖。
- [x] 移动目录流程改用项目库与系统 picker 字节暂存，不把 `content://` 当作普通路径。
- [x] 复用 `App.svelte` 外壳，组合 `MobileToolbar` / `MobilePanelBar` / `FormatToolbar`，不复制第二套编辑器；手机抽屉/面板 sheet、平板宽屏布局与设置页已适配。
- [x] 格式、撤销/重做、文件移动、文件更多操作均保留触控入口并复用命令 registry；原生文字选择与 IME 不被桌面 contextmenu 截获。
- [x] iOS safe-area/visualViewport 与 Android 原生 system-bar/cutout/IME inset 已实现；Android 真机键盘弹出时编辑区实际缩短且工具栏可见。
- [ ] 在 iOS 真机完成输入法/听写矩阵；现有 CM6 输入与多字符提交回归、Android 原生 Unicode 输入及评注 `[` / `「` 触发已验证，不静默降级编辑器。
- [ ] 包体与内存：`mermaid`、`katex`、`@xyflow/svelte` 确认懒加载；记录 iOS WKWebView 冷启动时间与常驻内存。
- [x] AI Talk 手机全屏 sheet / 平板侧面板及后台流取消保留内容已实现；生产构建 390×844 / 768×1024 / 1024×768 可视检查无溢出。

**验收：** iPhone、iPad、Android 手机/平板四种形态完成「新建项目 → 写一章（中文 IME + 系统语音输入）→ 重命名 → 快照 → 同步」流程；桌面 E2E 全绿。

### M4 插件与核心特性

- [x] 原生 canvas / kanban / mindmap 保留已有手势引擎，补齐触控编辑/删除/重命名与可见控件；canvas 项目内引用可跨根迁移，移动端不读取项目外路径。
- [x] 文学评注触控操作栏与书籍翻译窄屏上下布局已实现；原生 Android 评注输入与保存已验证。
- [x] iOS 原生插件 iframe 与 Keychain 已在 iPhone/iPad 模拟器门禁中验证；UI-only 插件按声明式 iframe 激活，不要求不存在的 QuickJS 脚本。
- [ ] iOS 原生分享面板与 iPad popover 锚点需在真机上确认（模拟器门禁不弹出系统分享面板）。
- [x] iOS 仅内置插件限制已同时在 UI 与 Rust 执行，Android 保留既有插件流程。
- [x] 模板面板与 `$|$` caret anchor 在移动编辑器中工作（`mobile-shell.spec.ts` 在 iphone / ipad / ipad-landscape / android-phone 上覆盖）。

**验收：** 五个内置插件在 iPad 与 Android 平板上通过各自的冒烟清单。

### M5 打包与发布

- [x] `core/Cargo.toml` 为唯一应用版本源，删除私有 package.json 与 Tauri 配置的重复版本；共享读取/原子 bump 工具迁移所有发布校验。移动 CLI 从该源注入版本，独立递增 build number 不改 marketing version。
- [x] 移动标识符 `com.novelist.app`；桌面 `com.novelist.desktop` 与稳定 updater 通道不变。
- [x] iOS 最低 16.0、Android API 26；iPad family 1,2 与旋转配置已提交原生工程。
- [ ] iOS（仅 TestFlight）：Apple Developer 账号、分发证书与描述文件、App Store Connect API Key 存入 Secrets；`PrivacyInfo.xcprivacy`（文件时间戳、UserDefaults 等 required-reason API）；`ITSAppUsesNonExemptEncryption = false`（仅 HTTPS）；`Info.plist` 文件共享键。TestFlight 外部测试仍需通过 Beta App Review。
- [ ] Android（仅 GitHub APK）：发布 keystore 存入 Secrets，产出 universal 签名 `.apk`（arm64 + x86_64）；不产出 `.aab`、不填 Play Data safety。keystore 一旦发布不可更换，否则用户无法覆盖安装——需离线备份。
- [x] `mobile-ci.yml` / `mobile-release.yml`、稳定与 mobile beta tag 通道、签名校验/清理、TestFlight 上传脚本已实现；不修改 `latest.json`，不自动发布草稿。
- [ ] Homepage 下载页增加 TestFlight 公开邀请链接与 Android APK 下载入口（`Novelist-homepage/`）。

**验收：** 一次 `v1.1.0-beta.1` tag 同时产出桌面全平台、TestFlight 构建与签名 APK；APK 在 Android 8 真机上可覆盖安装上一 beta。

### M6 测试与文档（贯穿）

- [x] 四个移动浏览器 project 与桌面 WebKit 隔离门禁通过；test 模式关闭 watcher/HMR，避免文档/测试文件变动重载正在执行的页面。
- [x] Rust 覆盖 ZIP/路径边界、持久化迁移、账号绑定/取消/发布竞态、冲突选择和有界网络读取；原生 mobile-support crate 纳入 workspace。
- [x] `testing.md` 已列明确实机矩阵与证据边界；实际 Android 数据、分享、Keystore 与网络证据补充在下节，iOS 未验证项保留待办。
- [x] 架构、平台能力边界、开发/部署、文件生命周期、插件、覆盖策略与 CHANGELOG 已更新；文档不宣称未经验证的发布成功。
- [x] `tests/COVERAGE.md` 记录移动门禁与 native/mock 边界，不降低 coverage floor 或创建隐式豁免。

## 5. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| CM6 在移动虚拟键盘上的 CJK composition 行为 | 核心体验不可用 | 真机验证并修复输入路径；保留完整编辑，不静默降级为只读或源码替代 |
| iOS 审核：下载执行插件代码 | TestFlight Beta Review 拒审 | iOS 仅内置插件 |
| 数据根初始化时序（`lib.rs:344`） | 移动端启动崩溃 | D7 + M2 审计 |
| 绝对路径持久化 | iOS 更新后项目丢失 | D5 |
| 后台被系统回收导致未保存 | 丢稿 | M2 生命周期 flush |
| rquickjs bindgen 交叉编译 | 插件宿主不可用 | M0 验证；必要时为移动 target 预生成 bindings |
| WKWebView 内存上限 | 大文件/大画布崩溃 | tall-doc 阈值下调，懒加载重依赖 |
| 移动 CI 成本（macOS runner、签名） | 发版变慢 | 移动构建独立 workflow，可手动触发 |

## 6. 已定决策（2026-10-28）

- **Q1 iOS 分发：** 仅 TestFlight，不上 App Store。
- **Q2 Android 分发：** 仅 GitHub Release 签名 APK，不上 Google Play 与国内商店。
- **Q3 形态：** 平板 + 外接键盘优先；手机保留完整编辑能力（用户常用系统语音输入），不降级为只读。
- **AI：** 移除 AI Agent harness（全平台，含桌面）；AI Talk 保留并在移动端提供。
- **Q4 移动标识符：** `com.novelist.app`。
- **Q5 iOS 插件市场：** iOS 仅内置插件；Android 开放 marketplace。
- **Q6 最低系统版本：** iOS 16+、Android 8.0（API 26）+。

## 7. 账号、云同步与支持范围

- **部署账号**与**写作者账号**分离：前者是 Apple Developer / App Store Connect 与 Android 发布密钥，后者是用户自行选择的 WebDAV 服务账号。
- 不自建新的账号 SaaS。提供全局 WebDAV 账号配置、连接校验、远程项目发现/下载、当前项目绑定与已有三方同步。新设备下载保留同一个项目身份，不能通过新建同名项目冒充同一同步空间。
- 移动端凭据通过 iOS Keychain / Android Keystore 保存，不以本地明文文件作失败降级。桌面保持既有私有目录安全边界并明确其限制。
- 可选自托管使用成熟 Nextcloud 账号、设备应用密码、配额/撤销与备份；提供可执行部署配置与恢复步骤，不伪称已部署生产服务。
- 正文与基线本身就是离线待同步队列；先落盘再同步，离线不妨碍写作。冲突不得覆盖任一侧，错误必须可见。HTTPS 不是端到端加密，服务器管理员可以读取同步内容。
- TestFlight 构建有效期、Apple Beta Review、Android 签名备份、升级/导入导出、最低系统与 iPad 布局分别纳入发布/支持文档。

## 8. 当前验收记录与发布前置

- Android 13 真机：原生 IPC 与沙盒文件、账号 Keystore、升级保留、项目下载身份/基线、CJK 上传与远端返写、打开文件自动刷新、后台保存/force-stop 恢复、Markdown 分享取消均有实际结果。
- 评注真机：输入 `[` 与 `「` 实际进入“正在评注”，结束后正文 JSON 落盘为 comment insertion；不是仅在 mock 上转发输入事件。
- 通用 Android Release：arm64-v8a + x86_64 实际编译/R8 打包，约 45 MiB；16 KiB ELF 与 ZIP 对齐通过。版本未 bump，仍为 Cargo 中的 0.6.1。
- Apache mod_dav_fs 实际协议检查通过（17 pass / 4 warning / 0 fail）；fresh ETag 可暂时为 weak，客户端等待下一次有效基线，不放宽条件写入。stock WsgiDAV 4.4 未通过，被明确列为不支持，不能以延迟重试掩盖强 ETag 重用。
- GitHub iOS native 构建/截图：用户已批准新分支与草稿 PR；结果待实际 CI，不以本机 Swift 语法检查替代 SDK 编译。
- 发布账号材料、Apple Beta Review、隐私 URL/支持邮箱、真实 TestFlight 邀请与最终下载页仍是外部发布前置。Android 新发布密钥只在忽略的 `.local/android-signing/`，不得提交；正式分发前需两个离线备份。

