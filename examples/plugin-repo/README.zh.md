# dsh-plugin-repo-template —— DeepSeek Harness 插件仓库模板

[English](README.md) | 中文

本目录是 **DeepSeek Harness 插件市场的插件仓库模板**。复制它来初始化你自己的插件仓库，然后在市场中把它添加为**插件源**（`插件市场 → 插件源 → 添加源`）。市场里的所有插件**都用 TypeScript 编写**；市场按需编译每个半身（或直接消费本模板 `pnpm build` 产出的 `dist/` 编译体）。

```text
plugin-repo/
├── plugins/                  # one folder per plugin; the folder name IS the plugin id
│   └── hello/
│       ├── plugin.json       # required metadata: name, purpose
│       └── src/
│           ├── host.ts       # optional Host half (TypeScript function body)
│           └── client.ts     # optional Client half (TypeScript function body)
├── types/dsh-plugin.d.ts     # ambient `harness`/`React`/`host`/`styles` symbols for editor checking
├── scripts/build.mjs         # optional prebuild: src/*.ts → dist/*.js
└── tsconfig.json             # editor type-checking for halves
```

## 插件标准

### 身份与清单

- 一个插件 = `plugins/` 下的一个目录；**目录名即稳定的插件 id**（`hello`、`my-tool`……）。使用小写字母、数字与连字符。
- `plugin.json` 为必需，必须声明字符串 `name`（显示名）与 `purpose`（一行描述）。两个半身都可选；没有任何半身的插件合法但无行为。

### 半身

半身是一个**异步函数体**：把它当作位于 `return (async () => { … })()` 内部来编写——顶层语句加上最终 `return` 一个插件（一个函数，或带 `apply(ctx)` 以及可选 `name`/`inject` 的对象）。市场用 esbuild 剥离类型，然后在 Host 沙箱或浏览器闭包中求值。

- `src/host.ts` — Host 半身。可用符号：`ctx`（受限上下文：`get`/`on`/`provide`/`effect` + 注入的服务）、`harness`（`handle`/`defineTool`/`registerTool`）、`console`、`btoa`/`atob`、`TextEncoder`/`TextDecoder`。网络、文件系统、定时器与子进程被拦截——在声明对应服务后，通过 `ctx.fs`、`ctx.web`、`ctx.bash` 或 cordis 定时器完成这些能力。
- `src/client.ts` — Client 半身。可用符号：`React`、受守卫的 `ctx`（注入服务、`effect`、声明 `timer` 后的定时器助手）、`styles`（`insert(css)`）、`host`（`call(method, args)`，与 Host 半身的 `harness.handle` 配对）、`console`。浏览器全局 `fetch`、`setTimeout`/`setInterval`、`require` 被拦截并给出教学错误。

### TypeScript 规则

- **仅允许 type-only 导入**：`import type { … } from "…"` 在编译时被擦除，这是半身引用 `@deepseek-ai/*` 包类型的方式。单行与多行写法均可。
- **禁止 value 导入与导出**：沙箱只求值一个没有模块解析的函数体。要么内联辅助代码，要么通过 `harness.handle`/`host.call` 暴露。
- 类型标注随意使用；`types/dsh-plugin.d.ts` 加 `pnpm install && pnpm typecheck` 可提供编辑器级检查。
- 市场**按需编译**（`src/*.ts` → 编译体），当仓库自带 `dist/host.js`/`dist/client.js` 时优先消费。

### 生命周期

- `apply(ctx)` 在挂载时执行；`ctx.effect(callback, label)`（或注册返回的 disposer）在卸载时回卷。插件注册的一切都必须是其自身 fiber 的副作用。
- Host 半身在启动与安装时挂载；Client 半身在页面启动或安装时加载。卸载会同时撤回两者。

### 信任

来自 git 源的插件是**安装即执行的远程代码**。只安装你控制或信任的源；把源 URL 视作一次执行授权。

## SOP —— 从零到安装

1. **初始化**：复制本模板；`git init`；修改 `package.json`（name/description）；`pnpm install`。
2. **编写**：创建 `plugins/<id>/plugin.json` 与 `plugins/<id>/src/` 下的半身；`pnpm typecheck` 获得编辑器级信心。
3. **本地验证**：提交并推送，然后在市场面板「插件源 → 添加源」填入仓库 URL；插件会以「远程」徽标出现在目录中。
4. **安装**：点击「安装」；Host 半身立即挂载，Client 半身加载到当前页面。验证可见效果（例如 `hello` 的设置行）与 Host 日志。
5. **发布更新**：`pnpm build`（可选）、提交、推送；在市场点「刷新源」重新抓取。
6. **移除**：「卸载」删除商店副本；「移除源」删除仓库及其目录条目。

## 已知限制

- 插件没有版本：源更新在「刷新源」时重新抓取，但已安装的商店副本保持已安装状态，直到重装。
- 没有启用/停用状态：已安装即已挂载。
- 商店保存的是编译后的函数体而非 `.ts` 源码；源码请保留在 git 仓库中。
