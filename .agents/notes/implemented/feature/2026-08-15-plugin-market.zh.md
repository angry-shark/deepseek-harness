# Agent Note: 插件市场——来自侧栏的持久化用户插件

Status: implemented

[English](2026-08-15-plugin-market.md) | 中文

## Problem

会话中创建的动态 Cordis 插件是进程局部的：重启即消失，因此想持久保留插件的用户没有受支持的途径，浏览器端也没有浏览、安装或卸载持久化插件的界面。侧栏底部预留的 `sidebar.footer.action` 插槽此前无人占用。

## Decision

两个包为 Web 客户端带来插件市场。

`@deepseek-ai/dsh-host-plugin-market` 拥有持久化用户插件仓库，位于 `$DSH_HOME/plugins/<id>/plugin.json` —— `name`、`purpose` 以及可选的 Host/Client 半身（`cordis_define` 方言）——在启动与安装时通过 `cordis-host-runner` 沙箱挂载每个仓库插件的 Host 半身，并发布十个 `pluginMarket` Remote：`catalog`、`installed`、`installPlugin`、`uninstall`、`getClientCode`、`invoke`、`sources`、`addSource`、`removeSource` 与 `refreshSources`。半身用 TypeScript 编写（`src/host.ts` / `src/client.ts`）并由 esbuild 按需编译（仅 type-only 导入，禁止 value 导入与导出）；存在预构建 `dist/*.js` 时优先。已配置的 git 源（部署 `sources` 配置 + 用户持久化到 `sources.json` 的 URL）克隆进内容寻址缓存，其 `plugins/` 布局以 `remote` 来源并入目录。内置精选目录（`BUILTIN_CATALOG`）附带两个示例插件（`host-greeter`、`client-clock`）；用户自行放入仓库的插件按存在即已安装处理。每次仓库变化发出 `market/installed-change`，每次源变化发出 `market/sources-change`；api-remotes 装配原样转发两者。

`@deepseek-ai/dsh-client-ui-market` 注册 `sidebar.footer.action` 触发器（宽栏显示图标与文字，窄栏仅图标）与一个居中模态面板，管理已配置的 git 源（添加/移除/刷新，含每个源的状态）并列出带安装状态的目录，同时通过 `dynamicCordisRunner` 服务 face 将已安装插件的 Client 半身加载到当前页面。该 runner face 新增两个独立动词——`loadStandalone` 与 `retractStandalone`——因为安装本身就是用户授权，且市场插件没有归属的会话：Client 半身不再需要单独的审批步骤，宿主会忽略无会话归属的半身的渲染/守卫失败报告。

`cordis-host-runner` 包现在导出其沙箱与生命周期工具（`createSandbox`、`evaluateHostCode`、`precheckCode`、`startHostHalf`、`isPlugin`、`normalizeHandler`），使市场与聊天创建的 runner 走同一条受守卫的 Host 挂载路径。

## Alternatives considered

### 为什么不持久化聊天创建的动态插件，而是另建仓库？

动态 runner 的注册表按会话隔离且有审批门禁；市场需要全局、用户所有的仓库。分开两条生命周期可同时保住两个契约：聊天插件保持临时，市场插件是磁盘文件、每次启动重新挂载。

### 为什么不把已安装插件写入 profile 的 `cordis.patch.yml`？

patch 文件是组合层——patch 按 id 定位行——每次安装都让 HMR 重载整个 include 代价过高。独立仓库目录把插件代码排除在组合文件之外，并让安装/卸载保持原子性（写入或删除一个目录）。

### 为什么不直接导入动态 runner 的客户端引擎？

client bundle 纯度门禁禁止跨包 value import，而 runner 是服务；市场通过其 face 协作。新增两个独立动词把引擎（闭包求值、模块表工厂、loader 条目）保留在单一所有者手中。

### 为什么不让沙箱直接执行 TypeScript？

沙箱与浏览器闭包只求值无模块解析的纯 JS 函数体。用 esbuild 把 TS 编译成同一函数体形态可保持单一运行时与单一方言；value 导入在编译期以教学错误拒绝，而不是在挂载时失败。

### 为什么不在 `docs/` 放规范页，而是提供可复制的模板？

规范面向插件仓库所有者，因此标准与 SOP 放在可复制的 [`plugin-repo` 模板](../../../../examples/plugin-repo/README.md) 中；市场 README 链接它而非重复。

## Consequences

已安装插件天然跨重启持久：仓库是磁盘上的纯 JSON，启动时重新读取并挂载，且可无头工作。代价是：目录插件没有版本（商店副本在重装前不会跟随目录的新版本）、没有启用/停用状态（已安装即已挂载）、仓库清单仅支持 JSON。浏览器在页面加载时统一装载所有已安装的 Client 半身而非按需加载，Host 半身通过带标签的沙箱控制台输出日志。

## Testing

Host 单元测试覆盖目录投影、安装持久化、重启重新挂载、卸载、Client 源码提供、纯仓库插件、挂载失败上报、TS 半身编译（含 value 导入拒绝）、git 源抓取进目录与源添加/移除。Client 组件测试覆盖触发器、面板状态、源管理、安装/卸载手势与错误呈现。针对源码启动的 web profile 的实时浏览器验证，实际执行了两个示例插件的安装、设置-通用中的 Client 半身时钟行、Host 半身挂载日志、重启持久化与卸载。
