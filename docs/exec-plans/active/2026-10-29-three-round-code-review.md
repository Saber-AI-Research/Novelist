# 三轮 Code Review 计划：AI Talk · Android/APK · 移动端体验

> Steps use checkbox (`- [ ]`) syntax for tracking.
> 状态：计划制定（2026-10-29）。基线 commit `6e9c7b8`（main），移动端平台化执行计划见
> `2026-10-28-mobile-platform.md`。
>
> 2026-11-03 状态复核：保留尚未完成的用户任务和发行前验收。当前发布阻塞、实际证据及候选包以[发布准备](2026-11-03-release-readiness.md)为准；本文原先的 `v1.1.0-beta.1` 目标不代表版本号已批准。后续日常开发遵循[Web-only 流程](../../development.md#commands)，原生门禁在发行准备阶段执行。

**Goal：** 在合并移动端分支之后、发 `v1.1.0-beta.1` 之前，用三轮递进式 review 确认
(1) AI Talk 的使用逻辑简单好用；(2) Android 构建与 APK 安装/升级全链路无问题；
(3) 移动端（手机/平板）真实使用简单、流畅、不丢稿。

**原则：**

- 三轮串行。每轮结束先修 P0/P1，再跑该轮回归门禁，再进入下一轮；下一轮不复查上一轮已关闭的问题。
- 每个发现必须带：文件:行号、复现步骤、严重级别（P0 丢数据/崩溃/不可用，P1 主流程卡住或明显困惑，P2 体验粗糙，P3 建议）。
- "简单好用"是可验证的：用本文的**用户任务清单**计步数、计点击数、计是否需要看文档。做不到的直接记 P1。
- 审查只提问题，不在 review 过程中顺手重构；修复在单独 commit 中，按轮次前缀 `review-r1/` `review-r2/` `review-r3/`。
- 不宣称未验证的结论：真机没跑过的项标 **[未验证]**，不写"应该没问题"。

---

## 第 1 轮 — AI Talk 使用逻辑（桌面 + 移动共用逻辑）

**审查范围**

| 层 | 文件 |
|---|---|
| 面板与交互 | `app/lib/components/AiTalkPanel.svelte`、`ai-talk/AiTalkImpl.svelte`（1814 行，重点）、`ai-talk/AiTalkSettings.svelte`、`ai-talk/PromptPresetManager.svelte` |
| 状态 | `ai-talk/settings.svelte.ts`（连接配置）、`ai-talk/sessions.svelte.ts`（会话）、`ai-talk/presets.svelte.ts`（提示词预设） |
| 协议/上下文 | `ai-talk/openai.ts`、`ai-talk/host.ts`、`ai-talk/compact.ts`、`ai-talk/cleanup.ts`、`ai-shared/{context,attachments,edit-suggestions,persistence,project-lifecycle,selection-state}.ts` |
| 共享 UI | `ai-shared/{AiComposer,AiContextBar,AiCommandMenu,AiMentionMenu,InlineEditReview,AiEditSuggestionCard,SessionTabs}.svelte` |
| 后端 | `core/src/commands/ai_bridge.rs`（SSE 流）、`core/src/commands/ai_files.rs`、`app/lib/services/{ai-chat,config-transfer}.ts` |
| 测试 | `tests/unit/components/ai-talk-*.test.ts`（8 个）、`tests/e2e/specs/ai-talk-settings.spec.ts`、`tests/e2e/specs/mobile/ai-talk-settings.spec.ts` |

**用户任务清单（每条记录步骤数/是否卡住）**

- [ ] T1 首次使用：从打开面板到发出第一条消息并收到流式回复。期望 ≤ 4 步（选服务商 → 填 key → 发送）；不需要填 base URL / model 就能跑通默认模板。
- [ ] T2 切换服务商：OpenAI → DeepSeek → 自定义网关，再切回来，key/model 各自保留不串。
- [ ] T3 带上下文提问：选中一段正文 → 面板出现"附上选区"提示 → 一键附上；`@` 提及项目内文件；`/` 命令菜单。
- [ ] T4 编辑建议：让模型改写一段 → 出现 suggestion card → 接受/拒绝/全部接受，正文变更正确且可撤销。
- [ ] T5 会话管理：新建、重命名、删除、切换项目后会话隔离（`ai-talk-project-scope.test.ts` 覆盖的语义在 UI 上也成立）。
- [ ] T6 长对话：触发 compact（压缩）→ 继续对话不丢关键上下文；错误（key 无效、网络断、429）给出一句话可操作提示而不是原始 JSON。
- [ ] T7 中断与恢复：发送中切到后台/关面板/切换文件 → 回来后内容仍在、不重复发送、不卡"思考中"状态（`onPageHidden` / `onVisibilityChange` 路径）。
- [ ] T8 保存：把对话存进项目（`saveChatToProject`）、写入记忆（`saveMemory`），文件名安全、CJK 标题不乱码。
- [ ] T9 配置迁移：WebDAV 配置传输（`config-transfer.ts`）把 AI 连接带到另一台设备后，key 可用、active profile 正确。

**代码审查要点**

- [ ] `settings.svelte.ts` 同时维护 `profiles[]` 和平铺的 `baseUrl/apiKey/model/temperature` 两份状态（`hydrateActiveProfile` 做镜像）。确认所有写入点都经过同一个入口，不存在只改一份导致 UI 与实际请求不一致的路径；评估是否应收敛为单一来源。
- [ ] API key 存放在 localStorage（文件头注释明示）。确认：(a) 是否有更合适的现有通道（移动端已有 Keychain/Keystore 用于云账号，`core/src/services/cloud.rs`）；(b) 导出/传输配置时 key 是否明文落盘到不该去的地方；(c) 清空连接（`ai-talk-settings.spec.ts` 已覆盖"删除所有连接"）后 localStorage 残留。
- [ ] `activeConfig()` 与 `buildChatContextFrom()`：上下文装配顺序（system prompt → preset → 当前文件 → 选区 → 附件 → 历史）是否可预测；`includeCurrentFile` 对大文件有没有上限，超限时是否告知用户。
- [ ] `runAssistantTurn` / `startTurnStream` / `cancelChat`：流取消后 Rust 侧 `ai_bridge.rs` 的任务是否真的终止（而不是继续消耗 token）；并发两次发送的保护；`stopClock` 泄漏。
- [ ] `openai.ts` 对非 OpenAI 服务商（Anthropic 兼容端点、Ollama）的差异处理：reasoning 字段、`temperature` 不支持的模型、SSE 中的 `[DONE]` 与错误帧。
- [ ] `PROVIDER_TEMPLATES` 默认 model 名是否仍有效（如 `claude-sonnet-4-5`、`gpt-4o-mini`），过期模型会让 T1 第一步就失败。
- [ ] `AiTalkImpl.svelte` 体量：标出可以无风险抽到 `composables/` 或 `services/` 的纯逻辑段（会话持久化 783–848、markdown 导出 688–737、计时/估算 578–887），作为 P3 记录，不在本轮动。
- [ ] 文案：`i18n/locales/{en,zh-CN}.ts` 中 AI Talk 相关键是否齐全，错误提示是否双语。

**执行方式**

```bash
pnpm test -- ai-talk                      # 8 个单测
pnpm test:e2e:browser -- ai-talk          # 桌面 + 移动 AI Talk 设置流
pnpm test:rust -- ai_bridge               # SSE 流与取消
```

- 代码审查：`/code-review high app/lib/components/ai-talk app/lib/components/ai-shared core/src/commands/ai_bridge.rs`，
  之后由人（或独立 subagent，不带上述结论）按 T1–T9 实际走一遍桌面 `pnpm tauri dev`。
- 真实服务商各连一次：OpenAI、DeepSeek、本地 Ollama（覆盖"无 key"路径）。

**出口标准**

- [ ] T1–T9 全部可走通，T1 ≤ 4 步。
- [ ] 无 P0/P1 遗留；P2 列入 `tech-debt-tracker.md` 或本轮修掉。
- [ ] 新增/修正的测试覆盖本轮修复的每个 P0/P1。

---

## 第 2 轮 — Android 构建、APK 与原生层

前置：第 1 轮的修复已合并，`pnpm test:all` 绿。

**审查范围**

| 层 | 文件 |
|---|---|
| 构建脚本 | `scripts/mobile.mjs`（`android doctor/check/build/publish/verify`）、`scripts/app-version.mjs` |
| CI | `.github/workflows/mobile-ci.yml`（android job：Clippy 双 ABI、debug APK）、`mobile-release.yml`（签名 universal APK、签名校验） |
| 原生工程 | `core/gen/android/`（`build.gradle.kts`、`app/`、`gradle.properties`、`tauri.settings.gradle`、`AndroidManifest.xml`） |
| Tauri 配置 | `core/tauri.android.conf.json`（`com.novelist.app`、minSdk 26、`$APPDATA/plugins/**` asset scope、updater 关闭） |
| Rust 平台层 | `core/src/services/{platform,portable,bundled_resources,file_watcher,cloud}.rs`、`core/src/commands/{sync,window,menu,publish,styled_copy}.rs` 中的 `cfg(mobile)`/`cfg(target_os = "android")` 分支、`core/src/lib.rs` 入口 |
| 文档 | `docs/design-docs/mobile-deployment.md`、`2026-10-28-mobile-platform.md` M0/M2/M5 |

**构建与分发检查**

- [ ] A1 干净机器复现：`pnpm mobile:android:doctor` → `check` → `build` 在全新 clone 上成功；doctor 对缺 NDK/JDK/SDK 的报错能直接指出装什么。
- [ ] A2 CI 一致性：`mobile-ci.yml` 的 SDK/NDK 版本（`android ci-sdk` 固定的值）与本机、与 `gradle.properties` 一致；缓存 key 不会让旧 NDK 产物污染。
- [ ] A3 APK 产物：universal APK 同时含 arm64-v8a + x86_64；16 KiB ELF/ZIP 对齐校验仍在；`.aab` 不产出；R8 混淆没有剥掉 Tauri/JNI 需要的类（检查 proguard 规则）。
- [ ] A4 签名与升级：`mobile-release.yml` 的签名校验步骤解析现代 APK Signature Scheme v2/v3（commit `1f671e0` 修过）；用上一 beta 签名的 APK 覆盖安装新 APK 成功；keystore 来自 Secrets 且**有离线备份记录**（M5 未勾选项，本轮必须关闭）。
- [ ] A5 版本：`core/Cargo.toml` 单一版本源 → `versionName`；`versionCode` 独立递增且 release 之间单调；两次 CI run 不会生成相同 `versionCode`。
- [ ] A6 Manifest/权限：只声明 INTERNET 等必要权限；`android:allowBackup`、`usesCleartextTraffic`（Ollama `http://localhost` 场景需要明确策略）、`exported` 标记、深链 `novelist://` 若已注册则有 intent-filter 验证。
- [ ] A7 更新路径：updater 在 Android 关闭，确认前端 `update-checker.ts`/`UpdateAvailableBanner` 在 Android 不弹、不请求 `latest.json`。

**原生/运行时检查（真机：OnePlus 8 Pro / Android 13；Android 8 / 10 / 平板用模拟器，见文末"设备矩阵与替代方案"）**

- [ ] A8 数据根：`/data/data` 与 `/data/user/0` 别名问题（M2 已修）在升级安装、多用户/工作资料下仍成立；最近项目列表在升级后可打开。
- [ ] A9 生命周期：HOME → force-stop → 重开，未点保存的文本仍在（M2 结论复验）；系统 Back 关最上层 layer 而不是退 App（`ffadb5c`）；横竖屏/字体大小/显示大小变更不重启丢状态。
- [ ] A10 IME：Gboard + 搜狗（M0 未勾选）输入段落、`「」`/`【】`、中文标点、组字中点格式栏不破坏组字；键盘弹出时编辑区缩短、工具栏可见（inset 逻辑）。
- [ ] A11 文件与分享：ZIP 导入（系统 picker `content://` 暂存）、导出到系统分享面板、取消分享不留垃圾文件。
- [ ] A12 网络：WebDAV 同步在 rustls 下连自签名/HTTP 服务器的行为与错误提示；AI Talk SSE 在移动网络切换 Wi-Fi ↔ 蜂窝时取消/重连。
- [ ] A13 插件：Android 允许 marketplace 安装（iOS 不允许）——安装、asset scope 加载、卸载、升级后插件仍可用；评注 iframe 真机加载。
- [ ] A14 包体与内存：确认 `mermaid`、`katex`、`@xyflow/svelte` 懒加载（M3 未勾选）；记录 APK 大小、冷启动时间、常驻内存，写入本文"实测表"。

**执行方式**

```bash
pnpm mobile:android:doctor && pnpm mobile:android:check
pnpm mobile:android:build          # debug APK
pnpm mobile:android:verify         # 对齐/签名校验
pnpm test:rust                     # 含 mobile-support crate
adb install -r <new.apk>           # 在装有上一 beta 的真机上覆盖安装
```

- 代码审查：`/code-review high scripts/mobile.mjs .github/workflows/mobile-ci.yml .github/workflows/mobile-release.yml core/gen/android core/src/services/platform.rs core/src/services/portable.rs`。
- 触发一次 `mobile-release.yml` 的 dry-run tag（`v1.1.0-beta.0-rc`），下载产物做 A3/A4。

**出口标准**

- [ ] A1–A14 全部有结论，真机项有截图/日志证据路径；**[未验证]** 项为零或已明确推迟并写明原因。
- [ ] 一次 tag 能产出可覆盖安装的签名 APK；keystore 备份记录存在。
- [ ] 无 P0/P1 遗留。

---

## 第 3 轮 — 移动端使用体验（简单、易用、流畅）

前置：第 2 轮修复已合并，Android CI 绿，手头有可安装的 APK 与 iOS 模拟器/真机。

**审查范围**

| 层 | 文件 |
|---|---|
| 平台外壳 | `app/lib/stores/platform.svelte.ts`、`app/App.svelte`、`MobileToolbar.svelte`、`MobilePanelBar.svelte`、`FormatToolbar.svelte`、`Welcome.svelte`、`Sidebar.svelte`/`FileTreeNode.svelte`、`TabBar.svelte`、`ZenMode.svelte` |
| 触控交互 | `app/lib/actions/long-press.ts`、`app/lib/editor/wysiwyg.ts` 移动分支、`composables/app-events.svelte.ts`、`app-lifecycle.svelte.ts`、`close-tab.svelte.ts` |
| 对话框/面板 | `NewProjectDialog`、`Settings`、`CloudAccountPanel`、`ExportDialog`、`PublishDialog`、`EditorShareMenu`、`Outline`、`CommandPalette` |
| 插件触控 | `canvas/*`、`kanban/KanbanImpl.svelte`、`MindmapOverlay.svelte`、`LiteraryImportDialog`、`TranslationImportDialog` |
| 服务 | `services/mobile-files.ts`、`services/share.ts`、`services/project-workspace-state.ts`、`services/autosave.ts` |
| 测试 | `tests/e2e/specs/mobile/{mobile-shell,ai-talk-settings,canvas-note-picker}.spec.ts`（iphone / ipad / ipad-landscape / android-phone 四个 project） |

**用户旅程（四种形态各走一次：Android 手机 = OnePlus 真机，Android 平板 = `novelist-tablet` 模拟器，iPhone = iOS 模拟器，iPad = 真机；分工见文末"设备矩阵与替代方案"）**

- [ ] J1 第一次打开：从安装到写下第一行字。期望 ≤ 3 步（新建项目 → 选模板 → 开始写），不出现任何桌面概念（目录选择、窗口、菜单栏）。
- [ ] J2 日常写作 30 分钟：中文 IME 连续输入、换段、加标题、插入模板（`$|$` anchor）、撤销/重做、格式栏；全程无明显卡顿（输入延迟 < 50ms 主观无感）、无滚动跳动、键盘不遮挡光标行。
- [ ] J3 管理章节：抽屉打开/关闭、新建/重命名/移动/删除章节、数字感知排序（第二章 < 第十章）、长按菜单，单手可完成。
- [ ] J4 用 AI Talk：手机全屏 sheet / 平板侧面板，附上选区提问 → 接受建议 → 关闭 sheet 回到编辑且光标位置不丢；发送中锁屏再回来。
- [ ] J5 同步：登录 WebDAV（Keychain/Keystore 保存）→ 首次同步 → 桌面改一段 → 手机前台重扫后自动更新；冲突时对话框在小屏可操作。
- [ ] J6 导入/导出/分享：从微信/文件 App 导入 `.md`/`.zip`；导出项目 zip 走系统分享；分享单章 HTML。
- [ ] J7 插件：canvas 拖动/缩放/连线、kanban 拖卡、mindmap、文学评注触控操作栏、书籍翻译窄屏布局——每个能完成一个最小任务。
- [ ] J8 设置：找到并修改字体大小、主题、自动保存、AI 连接，手机上滚动与分组清晰；不展示桌面专属项（`isMobile` 过滤的命令/设置）。
- [ ] J9 异常：断网写作、后台被杀、存储空间低、超大文件（>1 MB 单章）打开与滚动（tall-doc 模式在触控下的表现）。

**体验审查要点**

- [ ] 触控目标 ≥ 44×44 pt；手势冲突（编辑器选区拖动 vs 抽屉滑出 vs 系统返回手势）有明确优先级。
- [ ] safe-area / visualViewport / Android inset：刘海、手势条、键盘三种遮挡在 J2 中无一处挡住输入或按钮。
- [ ] 性能：Chrome DevTools 远程调试 / Safari Web Inspector 记录 J2 的长任务（> 50ms）与布局抖动；`platform.svelte.ts` 中的视口派生不在每次 resize 触发整树重渲染。
- [ ] 一致性：手机与平板只是布局不同，功能相同（D3 决策）；桌面 E2E 不因移动改动回归。
- [ ] 文案与引导：首次使用无需文档；每个空状态（无项目、无章节、未配置 AI、未登录云）有一句话 + 一个主按钮。
- [ ] 可访问性：系统字体放大 200% 下布局不破（`ffadb5c` 处理过显示大小变更，复验）；VoiceOver/TalkBack 能读到主要按钮。
- [ ] 将 J1–J9 中可自动化的步骤补进 `mobile-shell.spec.ts`，不能自动化的写进 `docs/design-docs/testing.md` 的真机矩阵。

**执行方式**

```bash
pnpm test:e2e:browser -- --project=iphone --project=ipad --project=ipad-landscape --project=android-phone
pnpm mobile:android:dev            # 真机热更新走 J1–J9
pnpm mobile:ios:dev                # 模拟器/真机
```

- 代码审查：`/code-review medium app/lib/stores/platform.svelte.ts app/lib/components/MobileToolbar.svelte app/lib/components/MobilePanelBar.svelte app/lib/actions/long-press.ts app/lib/services/mobile-files.ts`。
- 找一位没看过代码的人按 J1 走一遍并计时，作为"简单易用"的独立证据。

**出口标准**

- [ ] 四种形态 J1–J9 全部走通；J1 ≤ 3 步；J2 无 P1 级卡顿/遮挡。
- [ ] 真机矩阵（含 iOS IME，M0 未勾选项）有结论。
- [ ] 无 P0/P1 遗留；P2 进入 `tech-debt-tracker.md`。

---

## 设备矩阵与替代方案（2026-10-29 实际可用设备）

手头只有：**OnePlus 8 Pro（Android 13 / API 33，百度输入法，已装 `com.novelist.app`）** 与
**iPad Air 5（iPadOS 26.6.1，已配对、开发者模式开、本机有 Apple Development 签名，team `UN5YR5JATX`）**。
没有低版本 Android、Android 平板、iPhone 真机。按下表分工：真机只做模拟器做不到的事，
其余用模拟器补，表外形态在结论里标 **[未验证-<形态>]**，不用"应该没问题"糊过去。

| 覆盖目标 | 用什么 | 怎么开 | 能证明什么 / 不能证明什么 |
|---|---|---|---|
| Android 8.0（minSdk 26）升级安装、权限、数据根别名、生命周期 | 模拟器 `novelist-api26`（Pixel 2，google_apis arm64） | `emulator -avd novelist-api26`，见下 | 能：安装/覆盖安装、API 边界、`/data/user/0`、force-stop、Back、字体缩放。不能：厂商 ROM 差异、真实性能 |
| Android 10（API 29，scoped storage 切换点）导入/导出/分享 | 模拟器 `novelist-api29`（Pixel 3a） | 同上 | 能：`content://` 暂存、分享 intent 分发。不能：厂商分享面板 |
| Android 平板布局 | 模拟器 `novelist-tablet`（Pixel Tablet，API 33） | 同上 | 能：宽屏布局、横竖屏、AI Talk 侧面板 vs sheet。不能：触控笔、真实手感 |
| 低端机性能 | 同一模拟器加 `-memory 1536 -cores 2`，再把 OnePlus 开"电池省电 + 显示大小最大 + 字体最大" | — | 能：找出明显卡顿与布局破版。不能：给出可发布的性能数字（只记相对值） |
| Android IME（A10） | **OnePlus 真机**。百度已有；装 Gboard（Play）+ 搜狗（官网 APK 侧载） | `adb shell ime list -s` 确认，`adb shell ime set <id>` 切换 | 真机结论；模拟器只用 Gboard 做回归 |
| Android 真实网络/WebDAV/SSE 切网 | OnePlus 真机，Wi-Fi ↔ 蜂窝 | — | 真机结论 |
| iOS IME 矩阵（拼音/注音/日文）、听写、系统分享面板、iPad popover 锚点 | **iPad 真机**（取代原计划的 iPhone 真机项） | `pnpm mobile:ios:dev -- "黄业琦’s iPad"`（Vite 自动监听 `TAURI_DEV_HOST`，首次需在 iPad 设置里信任开发者） | 真机结论，对 iPhone 标 **[未验证-iPhone 真机]**（同一 WKWebView 与键盘栈，差异只在布局） |
| iPhone 布局、safe-area、键盘遮挡、sheet | iOS 模拟器 iPhone 17 / 17e / Air（已装） | `pnpm mobile:ios:dev`（不带设备名时选模拟器），模拟器 `Cmd+K` 开软键盘，设置里加中文键盘可测拼音候选 | 能：布局、视口、safe-area、拼音候选基本流程。不能：听写、真实键盘高度动画、分享面板 |
| iPad 模拟器形态（13 英寸等） | iPad Pro 13 / mini 模拟器 | 同上 | 布局补充 |
| 浏览器层回归 | Playwright `iphone / ipad / ipad-landscape / android-phone` 四个 project | `pnpm test:e2e:browser` | 自动化门禁，不替代真机 |

**模拟器准备（一次性）**

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"
sdkmanager "emulator" \
  "system-images;android-26;google_apis;arm64-v8a" \
  "system-images;android-29;google_apis;arm64-v8a" \
  "system-images;android-33;google_apis;arm64-v8a"
avdmanager create avd -n novelist-api26  -k "system-images;android-26;google_apis;arm64-v8a" -d pixel_2
avdmanager create avd -n novelist-api29  -k "system-images;android-29;google_apis;arm64-v8a" -d pixel_3a
avdmanager create avd -n novelist-tablet -k "system-images;android-33;google_apis;arm64-v8a" -d pixel_tablet
emulator -avd novelist-api26 -memory 1536 -cores 2 &   # 低端机档位
adb -s emulator-5554 install -r core/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

注意：`android doctor` 要求 `ANDROID_HOME` 与 `JAVA_HOME` 已导出（本机默认 shell 没有），建议写进 `~/.zshrc`。

**真机 IME 准备**

- OnePlus：Play 装 Gboard；搜狗从官网下 APK，`adb install`；每种 IME 跑一遍 A10 清单后 `adb shell ime set` 切下一个。
- iPad：设置 → 通用 → 键盘，加"简体拼音""注音""日本語-かな"，并开启"启用听写"。

### 预检实测（2026-10-29，APK = OnePlus 上已装的 v0.6.1 / versionCode 10004 / 45 MB，从真机 `pm path` 拉取）

| 环境 | WebView | 结果 |
|---|---|---|
| `novelist-api26`（Android 8.0，1.5 GB / 2 核） | 58.0.3029（镜像自带） | 安装成功，Rust 后端 `backend.setup.end` 186 ms，**前端全白**：logcat 无任何 `frontend.*` 阶段、无 console 输出，JS 未执行 |
| `novelist-api29`（Android 10） | 91.0.4472（镜像自带） | 安装成功，欢迎页完整渲染，`frontend.app.first-paint` 22.7 ms |
| OnePlus 8 Pro（Android 13） | 103.0.5060（OPPO 国内版 `WebViewGoogleCN`，minSdk 29，无法装到 API 26） | 已装，日常可用 |

bundle 实际依赖（扫描 `dist/assets`）：JS 需 `structuredClone`（Chrome 98）、`Object.hasOwn`（93）、`.at()`（92）；
CSS 需 `color-mix()`（111，**27 个文件**）、`dvh`（108）、`:has()` / `@container`（105）、`text-wrap`（114）。
Vite 未显式设置 `build.target`（默认 Chrome 87）。

**预检发现（归入第 2 轮）**

| # | 级别 | 位置 | 问题 | 复现 | 处理 |
|---|---|---|---|---|---|
| R2-pre-1 | P1 | `core/gen/android/app/src/main/java/com/novelist/app/MainActivity.kt`、`vite.config.ts` | 没有最低 WebView 版本门禁：WebView 过旧时静默白屏，用户无从得知要升级 Android System WebView | API 26 模拟器（WebView 58）启动 APK | 待修：Kotlin 侧 `WebView.getCurrentWebViewPackage()` 低于阈值时弹原生对话框并给出升级入口；`mobile-deployment.md` 记录最低 WebView；`vite.config.ts` 显式 `build.target` 并与阈值一致 |
| R2-pre-2 | P2（待真机确认） | 27 个 CSS 文件的 `color-mix()`、`dvh`、`text-wrap` | OnePlus WebView 103 < 111，`color-mix` 声明会被整条丢弃，主题色/边框可能退化；国内 ROM 自带 WebView 普遍落后 | 真机打开 App 对比桌面配色；或在 API 29 模拟器（WebView 91）上看 | 待确认后决定：PostCSS 回退、或把最低 WebView 定为 114 并在 R2-pre-1 门禁中体现 |

**Android 8 + 新 WebView 的覆盖缺口**：API 26 镜像无 Play，手机上的国内版 WebView minSdk 29 装不上。两条路二选一：
(a) 换 `system-images;android-28;google_apis_playstore;arm64-v8a`（Android 9 + Play 商店，登录后由 Play 更新 WebView）；
(b) 从 APKMirror 下载 Google 签名的 `com.google.android.webview` ≤ 138（最后支持 Android 8 的版本）侧载到 API 26。
未定前，Android 8 的结论只覆盖"旧 WebView 白屏"这一条。

## 产出物

每轮结束在本文下方追加：

```
### 第 N 轮结果（日期，commit）
| # | 级别 | 位置 | 问题 | 复现 | 修复 commit / 推迟原因 |
```

以及"实测表"（设备、系统版本、APK 大小、冷启动、常驻内存、IME 结论）。

三轮全部通过后：更新 `CHANGELOG.md`，把 `2026-10-28-mobile-platform.md` 中对应项勾选，
本文移入 `docs/exec-plans/completed/`。
