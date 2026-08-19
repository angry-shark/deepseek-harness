# dsh-desktop

[English](README.md) | 中文

DeepSeek Harness 的 Tauri 桌面壳：它以捆绑的 Node 二进制启动构建好的 `dsh` CLI，等待 harness 在 stdout 打印 `dsh web:` 就绪行，然后在原生 WebView 窗口中承载所服务的 Web GUI。关闭窗口即停止服务；服务自身退出时，壳会报告其最后输出并退出应用（[Agent Note](../../.agents/notes/implemented/feature/2026-08-14-desktop-tauri-shell.md)；早期的 Electron 壳是[归档历史](../../.agents/notes/archived/feature/2026-08-14-desktop-electron-shell.md)）。

本包为 `private: true`，绝不发布到 npm：`apps/*` 是 npm 发布面，而本应用以安装包形式分发。

## 布局

```
desktop/
  src-tauri/                the Rust shell (Tauri 2)
    src/main.rs             process lifecycle, window, navigation confinement
    src/server.rs           pure spawn/parse logic, unit-tested under cargo test
    tauri.conf.json         app and bundle configuration
    icons/                  generated from build/icon.png by `tauri icon`
  scripts/assemble-runtime.mjs
  scripts/fetch-node.mjs
  scripts/make-icon.mjs
  frontend-dist/            stub index.html; Tauri requires local frontend assets,
                            but the GUI is the remote page the harness serves
  build/                    gitignored: runtime closure, icon, node binary
```

## 前置条件

- `pnpm install` 与 `pnpm run build`：运行时闭包由 workspace 中已构建的包组装而来。
- `src-tauri` crate 需要 Rust 工具链（stable）；上游慢时请配置快速的 crates.io 镜像。
- `desktop:dev` 用 PATH 上的 `node` 运行 harness（`NODE_BIN` 可覆盖），其版本必须满足 harness 引擎下限（^22.19 || >=24）。打包构建自带 Node 二进制。

## 从检出仓库运行

```sh
pnpm run desktop:dev
```

`desktop:dev` 组装运行时闭包、下载 Node 二进制，然后以 debug 模式启动壳。每次运行都会重写 `build/dsh-runtime` 与 `build/node`，从而重新触发 tauri-build 的资源监听并重编整个 crate：每次运行都会有一次完整重编。

## 构建安装包

```sh
pnpm run desktop:package
pnpm run desktop:package:mac
pnpm run desktop:package:win
pnpm run desktop:package:linux
```

`scripts/fetch-node.mjs` 从 npmmirror CDN（`NODE_MIRROR` 可覆盖）下载固定版本的 Node 二进制（`NODE_VERSION` 可覆盖，默认 `24.14.0`），对照镜像的 `SHASUMS256.txt` 校验，并检查引擎下限。`tauri icon` 将 `build/icon.png` 转换为各平台图标格式；该图标是生成的占位图，正式发布前请替换。各平台需在自身操作系统（或 CI）上构建：运行时闭包取自当前平台的 `node_modules`，包含原生模块（koffi、node-pty）。

## 运行时如何组装

`scripts/assemble-runtime.mjs` 基于 workspace 自身已安装的依赖图构建自包含的 `build/dsh-runtime`，安装包因此永远不触碰 npm：

- `dsh/` 存放 dsh 包的 `lib/`、`config/` 与 `package.json`；壳启动 `dsh/lib/bin.js`。
- 生产闭包（dependencies、optionalDependencies，以及代码在运行时 import 的 peerDependencies——例如 `dsh-app-boot` 以 peer 方式 import 的 `cordis-plugin-group`）被复制为平铺的 `dsh/node_modules`，解引用所有符号链接，使 `link:` 覆盖的 vendor 包（cosmokit、schemastery、cordis 插件族）成为真实拷贝。解析到第二个真实位置的名称嵌套在其引用包之下，与 npm 的冲突布局一致。
- pi-ai 的供应商 SDK（openai、@mistralai、@google、@aws-sdk、@anthropic-ai/sdk）与 shiki 系列被排除：它们只会经 pi-ai 的惰性 provider 子路径被 import，或被内联进浏览器 bundle；配置非 DeepSeek 供应商时会得到清晰的缺依赖错误。

不能使用普通的 `pnpm deploy`：本检出使用的 registry 镜像对 deploy 重新解析的版本已过时，且 deploy 的虚拟 store 布局会让 link: 覆盖的包以指向本检出的符号链接存在。

打包应用以普通 bundle resource（`Resources/dsh-runtime`、`Resources/node`）携带闭包与 Node 二进制：其原生模块必须从磁盘加载，闭包按组装结果原样使用。`--expose-internals` 被显式传入，普通 npm 安装所用的 `node-addon-require-builtin` 兜底因此不再必要。

## 服务生命周期

- 壳以用户主目录为工作目录启动 `node --expose-internals dsh/lib/bin.js --profile web --port 0`，因此会话从这里开始。`--port 0` 让操作系统分配空闲端口；`--expose-internals` 是 harness 配置监听 HMR 服务的要求。
- `dsh web:` stdout 行即就绪信号；harness 只在其 Loader 配置树结算后打印该行。
- 退出时服务先收 SIGTERM，5 秒宽限后补 SIGKILL。Windows 上没有信号机制，直接终止。应用的退出处理器会强制杀掉仍在运行的服务，服务永远不会比壳存活更久。
- 单实例锁保证二次启动时聚焦已运行窗口。

## 安全姿态

渲染进程是 harness 自身服务的远程页面：WebView 完全没有 node 集成（系统 WebView 引擎），且导航被约束在 harness 源内——`on_navigation` 拒绝其他源、`on_new_window` 拒绝新窗口，两者都改由系统浏览器打开。

## 自定义标题栏与窗口控制 IPC

窗口是**无边框**的（`decorations(false)`）：GUI 的自定义标题栏（ui-layout 的 `TitleBar`）即拖拽区（`data-tauri-drag-region`），并拥有关闭/最大化/最小化控制，其样式与位置对齐打包平台的原生标准：**macOS 在顶部左侧显示红黄绿交通灯，Windows/Linux 在顶部右侧显示方形按钮**（由 user agent 判定）。为让远程页面调用 Tauri 窗口 API，开启了 `withGlobalTauri`，并新增 `window-controls` 能力（见 `src-tauri/capabilities/window-controls.json`），只授予 `core:window` 的最小化/最大化切换/关闭/开始拖拽/读取权限，且**严格限定**到 harness 源（`http://127.0.0.1:*`、`http://localhost:*`）的 `main` 窗口。通过该能力无法触达系统其它部分；`on_navigation`/`on_new_window` 约束不变。

## 已知限制与后续工作

- 安装包未签名，也没有自动更新机制。
- 解包后的 macOS 应用约 356 MB（运行时闭包约 233 MB、Node 二进制约 114 MB）；DMG 安装包会压缩负载。Node 二进制是上游完整构建，裁剪意味着维护自定义构建。
- 窗口标题为产品名（由自定义标题栏显示，并携带布局菜单）；没有托盘或后台行为——关闭窗口即停止服务。
- 向壳进程本身（而非其退出路径）发送 SIGTERM 会留下仍在运行的服务器子进程：壳无法清理它未曾看到终止的信号。
