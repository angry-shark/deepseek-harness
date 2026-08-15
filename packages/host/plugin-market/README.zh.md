# @deepseek-ai/dsh-host-plugin-market

[English](README.md) | 中文

持久化插件市场：Harness 主目录下的用户插件仓库、内置精选目录、可配置的 git 插件源，以及安装/卸载/状态 Remote。`PluginMarketGateway` 注册 `pluginMarket` 服务并发布十个生成的直连 Remote：`pluginMarket/catalog`、`pluginMarket/installed`、`pluginMarket/installPlugin`、`pluginMarket/uninstall`、`pluginMarket/getClientCode`、`pluginMarket/invoke`、`pluginMarket/sources`、`pluginMarket/addSource`、`pluginMarket/removeSource` 与 `pluginMarket/refreshSources`。

每个已安装插件是仓库根目录（默认 `$DSH_HOME/plugins`）下的一个目录，内含 `plugin.json`：`name`、`purpose`，以及可选的 Host/Client 半身——与 `cordis_define` 接受的 async 函数体同一方言。半身也可以用 TypeScript 编写于 `src/host.ts` / `src/client.ts`（市场用 esbuild 编译；仅允许 type-only 导入，禁止 value 导入与导出），或以 `dist/host.js` / `dist/client.js` 形式预构建。服务在启动与安装时通过 `cordis-host-runner` 沙箱挂载每个仓库插件的 Host 半身，因此已安装插件天然跨重启持久：下次启动时重新读取这些文件。Client 半身按需提供（`getClientCode`），由浏览器侧的 [`ui-market`](../../client/ui-market/README.md) 包挂载。

目录合并内置精选列表（`BUILTIN_CATALOG`，两个示例插件）与每个仓库插件，并标注各自的安装与挂载状态。已配置的 git 源（部署 `sources` 配置 + 用户持久化到 `sources.json` 的 URL）克隆进内容寻址缓存，其 `plugins/` 布局以 `remote` 来源并入目录；`refreshSources` 重新抓取，`addSource`/`removeSource` 管理用户列表。插件作者从 [`plugin-repo` 模板](../../../examples/plugin-repo/README.md) 起步。`installPlugin` 将目录插件复制进仓库并挂载；`uninstall` 卸载并删除仓库目录。用户自行放入仓库的插件按存在即已安装处理。每次仓库变化都会发出 `market/installed-change` 事件，客户端原样转发。

该服务仅提供 Remote，除转发事件外不合并同进程 Cordis `Context`。客户端包通过显式的 [`api-remotes`](../../api/remotes/README.md) 装配消费，而非直接导入 Host 实现。公开载荷类型位于 `./types`，Typert 生成 `./typert` 与 `./remote` 暴露的 Host 与 Client Remote 产物。

## Model Experience

无，此 Host 端市场服务不注册任何提示词、工具、消息或模型请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## Known Limitations and Deferred Work

- **目录插件没有版本**——内置插件的定义随产品构建固定；商店副本在用户重装前不会跟随目录的新版本。
- **没有启用/停用**——插件要么已安装并挂载，要么已卸载；不提供已挂载但闲置的状态。
- **仓库清单仅支持 JSON**——放入仓库的插件必须使用 `plugin.json`；`package.json` 或 `cordis.yml` 目录布局不会被扫描。
