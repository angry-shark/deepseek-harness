# dsh-plugin-repo-template — DeepSeek Harness plugin repository

English | [中文](README.zh.md)

This directory is the **plugin repository template** for the DeepSeek Harness plugin market. Copy it to initialize your own plugin repository, then add the repository as a **plugin source** in the market (`插件市场 → 插件源 → 添加源`). Every plugin in the market is **authored in TypeScript**; the market compiles each half on demand (or consumes the `dist/` bodies this template's `pnpm build` produces).

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

## Plugin standard

### Identity and manifest

- One plugin = one folder under `plugins/`; the **folder name is the stable plugin id** (`hello`, `my-tool`, …). Use lowercase letters, digits, and hyphens.
- `plugin.json` is required and must declare string `name` (display label) and `purpose` (one-line description). Both halves are optional; a plugin with no half is valid but inert.

### Halves

A half is an **async function body**: write the file as if its content sat inside `return (async () => { … })()` — top-level statements and a final `return` of a plugin (a function, or an object with `apply(ctx)` and optional `name`/`inject`). The market strips types with esbuild, then evaluates the body in the Host sandbox or the browser closure.

- `src/host.ts` — Host half. Available symbols: `ctx` (restricted context: `get`/`on`/`provide`/`effect` + injected services), `harness` (`handle`/`defineTool`/`registerTool`), `console`, `btoa`/`atob`, `TextEncoder`/`TextDecoder`. Network, filesystem, timers, and processes are withheld — route them through `ctx.fs`, `ctx.web`, `ctx.bash`, or cordis timers after declaring the service.
- `src/client.ts` — Client half. Available symbols: `React`, the guarded `ctx` (injected services, `effect`, timer helpers after declaring `timer`), `styles` (`insert(css)`), `host` (`call(method, args)` pairs with the Host half's `harness.handle`), `console`. Browser globals `fetch`, `setTimeout`/`setInterval`, and `require` are withheld with teaching errors.

### TypeScript rules

- **Type-only imports only**: `import type { … } from "…"` is erased at compile time and is how a half names types from `@deepseek-ai/*` packages. Single- and multi-line forms both work.
- **No value imports and no exports**: the sandbox evaluates one body with no module resolution. Inline helper code instead, or expose it through `harness.handle`/`host.call`.
- Type annotations are welcome; `types/dsh-plugin.d.ts` plus `pnpm install && pnpm typecheck` give editor coverage.
- The market **compiles on demand** (`src/*.ts` → body) and prefers `dist/host.js`/`dist/client.js` when the repository ships them.

### Lifecycle

- `apply(ctx)` runs on mount; `ctx.effect(callback, label)` (or a returned disposer from a registration) unwinds on unload. Everything a plugin registers must be an effect of its own fiber.
- Host mounts happen at boot and on install; Client halves load when the page boots or on install. Uninstall retracts both.

### Trust

A plugin from a git source is **remote code that executes on install**. Install only from sources you control or trust; treat the source URL as an execution grant.

## SOP — from zero to installed

1. **Initialize**: copy this template; `git init`; edit `package.json` (name/description); `pnpm install`.
2. **Author**: create `plugins/<id>/plugin.json` and the halves under `plugins/<id>/src/`; `pnpm typecheck` for editor-level confidence.
3. **Validate locally**: commit and push, then in the market panel add your repository URL under 插件源 → 添加源; the plugin appears in the catalog with a 远程 badge.
4. **Install**: click 安装; a Host half mounts immediately, a Client half loads on this page. Verify visible effects (e.g., the `hello` settings row) and the Host log.
5. **Publish updates**: `pnpm build` (optional), commit, push; in the market click 刷新源 to re-fetch.
6. **Remove**: 卸载 deletes the store copy; 移除源 drops the repository and its catalog entries.

## Known limitations

- Plugins have no versions: a source update re-fetches on 刷新源, but a store copy already installed stays as installed until reinstalled.
- No enable/disable state: installed means mounted.
- The store keeps the compiled body, not the `.ts` sources; keep sources in the git repository.
