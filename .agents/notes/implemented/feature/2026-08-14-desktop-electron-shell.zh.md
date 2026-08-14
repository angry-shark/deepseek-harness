# Agent Note：桌面 Electron 壳

[English](2026-08-14-desktop-electron-shell.md) | 中文

Status: implemented

## 问题

Web GUI 由 `dsh web` 服务，用户必须先在终端启动它再打开浏览器。目前没有向他人交付可分发应用（macOS、Windows、Linux）的方式：产品以 npm CLI 形式发布。将 GUI 包成原生桌面应用，需要决定壳放在哪里（顶层 `desktop/` 包，因为 `apps/*` 是 npm 发布面，发布成员不能是 `private`）、服务器如何在其中运行，以及打包应用如何在不触碰 npm 与本检出仓库的情况下携带完整的 dsh 运行时。

## 决策

新建顶层 workspace 包 `desktop/`（`@deepseek-ai/dsh-desktop`，`private: true`），作为 Electron 壳。其主进程将构建好的 `dsh` CLI 作为 Electron 二进制以 Node 模式（`ELECTRON_RUN_AS_NODE=1`）的子进程启动，参数为 `--expose-internals --profile web --port 0`；把 `dsh web:` stdout 行（仅在 Loader 配置树结算后打印）视为就绪信号，并在沙箱化的 `BrowserWindow`（`contextIsolation`、无 node 集成、`sandbox: true`；离开 harness 源的导航与 `window.open` 改由系统浏览器打开）中承载所服务的 GUI。关闭窗口即停止服务（SIGTERM，5 秒后补 SIGKILL）；服务意外退出时以对话框显示其 stderr 尾部并退出。单实例锁保证二次启动聚焦既有窗口；子进程的工作目录为用户主目录。

`--expose-internals` 是 harness 配置监听 HMR 服务的要求。普通 Node 安装通过 `node-addon-require-builtin` 兜底满足，但该插件无法读取 Electron 的 Node 内部，因此壳显式传入该 flag。

### 运行时闭包

`scripts/assemble-runtime.mjs` 基于 workspace 自身已安装的依赖图构建自包含的 `build/dsh-runtime`：`dsh/` 存放 dsh 包的 `lib/`、`config/` 与 `package.json`；生产闭包——dependencies、optionalDependencies，以及代码在运行时 import 的 peerDependencies（例如 `dsh-app-boot` 以 peer 方式 import、且无任何包将其声明为依赖的 `cordis-plugin-group`）——被复制为平铺的 `dsh/node_modules`，解引用所有符号链接，使 `link:` 覆盖的 vendor 包成为真实拷贝。解析到第二个真实位置的名称嵌套在其引用包之下，与 npm 的冲突布局一致。

普通 `pnpm deploy` 被否决：本检出使用的 registry 镜像对 deploy 重新解析的版本已过时（锁文件自身的 `@tsdown/css@0.22.2` 拉取正常，但 deploy 的全新解析要的是镜像缺失的更新版本），且 deploy 的虚拟 store 布局会让 link: 覆盖的包以指向本检出的符号链接存在，结果不自包含。闭包嵌套在 `dsh/` 下，是因为 electron-builder 的 `extraResources` 拷贝会刻意丢弃根级别的 `node_modules` 目录（其存在正是为了防止重复打包应用自身的依赖）。打包应用以未打包形式在 `Contents/Resources/dsh-runtime` 下携带运行时，并禁用 `npmRebuild`：其原生模块（koffi、node-pty、node-addon-require-builtin）必须从磁盘而非 asar 加载。

### pnpm strictDepBuilds 修复

pnpm 11 将带生命周期脚本但未列入 `allowBuilds` 的包视为严格错误，并向 `pnpm-workspace.yaml` 自动写入 `"set this to true or false"` 占位符，导致所有 `pnpm run` 失败。受影响的九个包被显式设为 `false`，与既有的默认拒绝模式一致。

## 备选方案

- **放在 `apps/desktop`。** `apps/*` 是 npm 发布面：每个 `apps/*/package.json` 都是 dsh 家族发布成员，必须公开、随家族 bump 版本并发布。桌面安装包不属于任何 registry，因此壳放在顶层 `desktop/` workspace 成员中，`private: true`，避开所有发布模式。
- **Tauri。** Rust 壳加系统 WebView 能把安装包做小得多，但会给 JavaScript workspace 引入 Rust 工具链，而且三个系统 WebView 引擎对一个复杂 SPA（SSE、上传、大列表）行为分歧大。Electron 复用仓库语言与单一 Chromium。
- **用 `pnpm deploy` 组装运行时闭包。** 实际被否决：本检出使用的 registry 镜像对 deploy 重新解析的版本已过时，且 deploy 的虚拟 store 布局会让 `link:` 覆盖的 vendor 包以指向本检出的符号链接存在，结果不自包含。组装脚本改为复制 workspace 自身已安装的依赖图，把符号链接解引用为平铺提升闭包。
- **单独捆绑 Node 二进制。** 再带一个 Node 运行时会使体积翻倍；以 `ELECTRON_RUN_AS_NODE=1` 运行 Electron 二进制本身即可复用已携带的运行时。捆绑 Node 的版本下限在启动时检查。
- **在主进程内运行 harness。** 子进程把服务崩溃与壳隔离，拥有自己的生命周期与工作目录，可用 SIGTERM/SIGKILL 终止；进程内嵌入会把两个生命周期耦合在一起，却不减少打包体积。
- **`node_modules` 放在运行时根目录。** electron-builder 的 `extraResources` 拷贝会刻意丢弃根级别的 `node_modules` 目录，因此闭包嵌套在 `dsh/` 下一层。

## 后果

该壳让仓库付出了约 190 MB 的 macOS 安装包（闭包包含 pi-ai 的可选供应商 SDK——openai、@mistralai、@google、@aws-sdk——裁剪会破坏它们）、未签名且无自动更新的构建，以及无法优雅 SIGTERM 收尾的 Windows 关闭。它换来了单命令的产品分发路径：`pnpm run desktop:package:<platform>` 产出原生安装包，其运行时永不触碰 npm 与本检出，让 macOS、Windows、Linux 用户无需终端与浏览器配置即可使用完整 Web GUI。

## 验证

- 单元测试（`desktop/tests/server.spec.ts`）覆盖 URL 行解析、spawn 调用、Node 引擎检查，以及两种运行时根目录解析（dev 与打包布局）。
- 组装后的运行时可独立启动：`dsh web` 打印 URL、服务 SPA（HTTP 200），并在 SIGTERM 下干净退出，全程只使用闭包。
- 打包后的 macOS 应用以同样方式从 `Contents/Resources/dsh-runtime` 启动；`pnpm run desktop:package:mac` 产出 dmg 与 zip 安装包。Windows 与 Linux 安装包需在对应平台（或 CI）上构建。
