# @deepseek-ai/dsh-client-ui-market

[English](README.md) | 中文

插件市场侧栏界面。浏览器插件注册一个本地化的 `sidebar.footer.action` 贡献，id 为 `plugin-market`——一个触发器行（宽栏显示图标与文字，窄栏仅图标），点击打开居中模态面板。面板管理已配置的 git 插件源（添加/移除/刷新，含每个源的状态），并通过 [`api-remotes`](../../api/remotes/README.md) 调用 `ctx.remote.pluginMarket.catalog()` 列出目录，展示每个插件的来源标签（精选/本地/远程）、安装状态、挂载状态与失败信息。安装将插件写入持久化仓库并挂载；卸载需要两次点击确认。每当宿主发出 `market/installed-change`、`market/sources-change` 或连接重置时，面板通过注入的 revision 钩子重新拉取。

同一插件还会把已安装插件的 Client 半身加载到当前页面：读取 `pluginMarket/installed`，用 `pluginMarket/getClientCode` 获取每个已挂载 Client 半身的源码，再通过动态包运行器（闭包求值、模块表工厂、loader 条目）挂载，由 fiber 副作用负责清理。安装本身就是用户授权，因此 Client 半身不再需要单独的审批步骤。渲染或守卫失败记入控制台，而不转向某个会话，因为市场插件没有归属的 agent。

## Model Experience

无，本包仅在侧栏呈现宿主持有的插件状态，不注册任何面向模型的内容。

#### KV Cache 影响

无；本包既不组装也不发送模型请求。

## Known Limitations and Deferred Work

- **Client 半身在页面加载时统一装载，而非按需**——每个已安装的 Client 半身都会在页面启动时被拉取并挂载；插件较多时每次启动多一次往返。
- **没有插件创作界面**——市场只能从内置目录或用户放入仓库的插件文件夹安装；暂不在浏览器中提供创建插件的功能。
