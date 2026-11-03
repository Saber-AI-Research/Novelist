# 移动端与 WebDAV 发布准备（2026-11-03）

状态：发布前验收进行中；未发布、未创建 tag，未修改版本号。
基线：`6e9c7b8`，Cargo 版本 `0.6.1`。本次 APK 含工作区的 WebDAV 连接验证修复。

## 发布判断

可以准备真机测试，暂不能宣称正式发布就绪。最新正式版仍为 `v0.6.1`；本地相较该 tag 有 12 个提交。下一版本号尚未确定，原有 review 草稿提及的 `v1.1.0-beta.1` 不作为已批准版本号。

- [ ] 关闭 WebKit 光标几何回归的偶发失败，查明布局/测量时序或产品原因；不扩大容差掩盖失败。
- [ ] 确定版本号，用 `node scripts/app-version.mjs bump X.Y.Z` 同步 Cargo 源与锁文件，再重新构建候选包。
- [ ] 将最终修复提交（本地有 3 个尚未推送到 origin/main 的提交），并在同一提交上跑 CI 与 Mobile CI；现有成功记录不覆盖本地 `6e9c7b8` 及本次工作区修复。
- [ ] Android 发布密钥有两个离线备份；本地密钥存在不能证明备份完成。
- [ ] GitHub `mobile-release` 环境及签名/上传材料可用。当前账户查询 environments 未返回环境，指定环境 secrets/variables 接口均为 404；不能当作已配置，也不能据此断言所有材料不存在。
- [ ] TestFlight 分发证书、描述文件、ASC API、app 记录与外部 Beta Review 完成；开发安装或模拟器构建不等于 TestFlight 就绪。
- [ ] 发布说明、隐私 URL、支持邮箱、首页 Android 下载和 TestFlight 邀请链接完成核对。

注意：旧三轮 review 草稿中的 `v1.1.0-beta.0-rc` 不符合 mobile-release 的 `vX.Y.Z-beta.N` 规则。应在确定版本后使用未发布且 N >= 1 的合法 beta tag；不要为试跑创建或移动正式 tag。

## 本次修复

`core/src/services/webdav.rs` 的旧“测试连接”只检查 HTTP 2xx，因此普通登录网页也会成功。现要求 HTTP 207、受限的 XML 响应体（最多 1 MiB）、合法 Multi-Status 且含 collection。错误状态、登录 HTML、损坏 XML、文件 URL、空 Multi-Status 均有回归覆盖。

这是只读连接探测，不证明 PUT/DELETE 权限、强 ETag 或完整同步兼容性。正式支持服务器还需运行协议检查；不能在 UI 中把连接成功当作同步验收通过。

## 当前验证

- `pnpm check`：0 errors / 0 warnings。
- `pnpm test`：159 files / 2198 tests passed。
- 真实本机 Apache mod_dav_fs 协议检查：17 pass / 4 warning / 0 fail。包含中文、空格、#/% 名称、创建/读取/替换/删除、过期 If-Match 拒绝。四项警告涉及响应/写入后暂时的弱 ETag；不降低客户端条件写入要求。临时目录已移除，服务端口已关闭。
- Android doctor：SDK 36、NDK 27.2.12479018、JDK 17、arm64 和 x86_64 Rust targets 可用。
- iOS doctor：Xcode 26.6、iPhoneOS/Simulator SDK 与 device/simulator Rust targets 可用。本地进程未提供分发/上传环境变量，不代表 GitHub 或钥匙串不存在材料。
- `pnpm test:rust`：1252 主库测试 + 13 个移动支持插件测试通过，5 个测试默认忽略（真实 Pandoc 合同另行显式运行）；新增连接误判用例已通过。
- `cargo fmt --all -- --check`：通过。
- `pnpm test:bench`：dist 10,700 KiB，小于 15,360 KiB 门槛；未构建 DMG，DMG 检查跳过。
- `cargo clippy --locked --all-targets --all-features -- -D warnings`：通过。
- `pnpm test:rust:pandoc`（真实 Pandoc 3.10）：3 tests passed，覆盖 CJK HTML/DOCX/EPUB 与 Styled Copy/发布安全合同。
- 独立服务全部浏览器矩阵：620 passed / 3 skipped / 1 failed（624 total）。桌面 Chromium 与 iPhone/iPad/iPad 横屏/Android 手机项目均无失败；WebKit `marker-boundary.spec.ts:86` 有一次 wrapped caret X 坐标偏差 2 px（期望 1068.5、实际 1070.5）。同文件单 worker 连续三轮 30/30 通过；根因未确认，保留为发布门禁不稳定项，不能把整套写成全绿。原失败截图与页面上下文留在 `test-results/release-readiness/`，诊断重跑使用独立目录。
- Android universal release APK：`Novelist_0.6.1_10005_android-universal.apk`，47,092,393 bytes（44.91 MiB），`com.novelist.app`，versionCode `10005`，versionName `0.6.1`，arm64-v8a + x86_64。沿用本地发布密钥，证书指纹与配置匹配；apksigner 签名、manifest、ZIP 和双 ABI ELF 的 16 KiB 对齐全部通过。没有安装到任何设备。
- APK SHA-256：`2ce845d6158a9ce578e3354913b79ace34d7db34621efab2ef95c886e2cbb3d7`。
- 持久测试包与 `.sha256`：`.local/release-readiness/2026-11-03/Novelist_0.6.1_10005_android-universal.apk`（另有标准输出 `core/target/mobile-release/`）。build manifest 记录源码提交、WebDAV 补丁及其摘要；工作区含未提交修复，不能声称是干净 tag 产物。

最初的浏览器运行复用了端口 1420 的长期 Vite 服务，其编译响应缺少当前源码已有的 key-visibility 控件。这轮失败不计为通过。独立端口 1421 重新启动服务，以当前源码重跑全部项目，保留原开发服务。

## 代码检查后续项

- 已修复原 P2 连接测试状态问题：`Settings.svelte` 在 URL、用户名、密码、应用目录或“直接使用地址目录”选择变化时清除旧结果并递增请求代次；只有当前项目和当前代次的请求可回写结果。本轮 WebKit 回归在修复前复现“修改配置后仍显示旧成功”，修复后通过，同时覆盖请求未完成时修改凭据、旧请求完成后不恢复绿色状态。此结果仅证明浏览器 UI/模拟 IPC 合同，未运行原生或真机验证。
- 本轮没有重新编译/安装 iOS 候选包，也没有实际 TestFlight 上传；doctor 与既往 CI 只能证明相应范围，不能代替当前候选真机验收。

## 真机测试顺序（设备由用户后续指定）

对测试稿操作，先导出备份。每项记录设备型号、OS、WebView/输入法、APK SHA-256、build number、操作和实际结果。

| 范围 | 操作 | 验收标准 |
|---|---|---|
| 安装/升级 | 先确认旧包签名和 versionCode，再覆盖安装 | 同签名且版本递增；项目、账号和配置保留；不卸载绕过失败 |
| WebDAV 连接 | 正确账号、错误密码、错误目录、登录页、重定向、离线、TLS 错误 | 只接受有效 WebDAV 目录；不忽略证书，不转发凭据到重定向 |
| 服务兼容 | 对预定 HTTPS/Nextcloud 服务运行 conformance | 强 ETag、条件写入/删除、CJK 路径通过；本机 Apache 的通过不替代目标服务验收 |
| 双端同步 | A 上传、B 下载；B 编辑后 A 拉取 | 正文逐字节一致，当前打开文档刷新 |
| 冲突/删除 | 两端离线改同一稿；测试保留双方、远端更新后删除 | 无静默覆盖/丢稿，旧 ETag 返回冲突；冲突副本保留 |
| 中断/恢复 | Wi-Fi/蜂窝切换、飞行模式、后台、force-stop、重开 | 状态可恢复、无重复上传/误删，未保存稿落盘 |
| AI 配置传输 | 显式选择是否带 key，传到另一设备，再撤销/删除配置 | active profile 正确；无未授权覆盖；凭据不进入日志/测试证据 |
| 编辑/输入法 | CJK 组字、标点、组字中格式按钮、听写 | 不打断组字、不丢字，键盘不遮正文与操作区 |
| 系统适配 | 返回键、旋转、系统字号/显示大小、平板分屏 | 不崩溃、状态保留、触控目标可用 |
| 文件/插件 | ZIP 导入导出、分享取消、内置插件、Android marketplace | 文件可读，取消不误报成功；iOS 分享/iPad popover 真机验证 |

Android 8/10、16 KiB 页面设备、真实平板以及 iOS 输入法/分享属于独立覆盖项；浏览器模拟设备不能代替原生真机结果。既往 iPad 验收不替代本候选包验收。

## 文档清理盘点（2026-11-03 复核）

| 路径（相对 monorepo） | 结论 | 原因与风险 |
|---|---|---|
| `task7-manual-desktop-snapshot.md` | 可清理候选，3102 bytes | 2026-07-17 Styled Copy 界面可访问性快照；无源码引用，不参与构建；删除会失去当时 UI 证据 |
| `task7-qa-console-errors.log` | 可清理候选，84 bytes | 同期控制台摘要（0 error / 17 warning），无构建依赖；不是当前版本验收 |
| `.playwright-mcp/` | 可逐项清理旧截图，先确认保留证据 | 49 files / 2,001,260 bytes；属于历史 UI 截图，不是源文件，但可能是唯一人工测试截图 |
| `.omo/`、`.sisyphus/` | 暂保留 | 根目录两处各 41 files / 715,400 bytes，存在历史计划、问题、决策与验收索引；需先比对/归档再删 |
| `Novelist-app/.omo/` | 暂保留 | 288 files / 16,037,402 bytes，含未跟踪的计划与验证证据；不能按缓存整体清理 |
| `Novelist-app/docs/exec-plans/active/` | 保留并更新状态 | 移动端计划和三轮 review 仍有未关闭发布前置 |
| `Novelist-app/docs/exec-plans/completed/` | 已选择性清理 | 已被现有设计/产品文档覆盖的实施草稿已删除；保留尚承载独立文件格式合同的模板设计；长期 WebDAV/快照依据现位于 `docs/design-docs/settings.md` 和 `file-lifecycle.md` |
| `Novelist-app/.local/android-signing/` | 保留 | 密钥、升级测试备份及恢复材料，不能作为构建缓存清理 |

根目录两个 task7 文件仅约 3 KiB，清理收益主要是减少杂项。待确认后可只删除这两个文件；本次未删除历史测试/恢复证据。

## 证据

本轮日志、构建 manifest、WebDAV 补丁与失败截图位于 `.local/release-readiness/2026-11-03/`；不包含密码或私钥。浏览器为 mock IPC，WebDAV conformance 为真实 HTTP，APK 校验为静态产物校验，三者不等价于真机完整同步通过。
