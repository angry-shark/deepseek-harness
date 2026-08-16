# Agent Note: 工作区增强（Git 分支徽章 + 分栏工作区面板）与合并进插件市场的 Cordis tab

Status: implemented

[English](2026-08-16-workspace-ext-git-branch-terminal.md) | 中文

## 问题

GUI 没有按工作区提供 git 或终端能力：输入框工具行只显示权限等既有控件，不显示当前分支；应用内也没有针对工作区目录的终端。另一方面，动态 Cordis 插件管理（ui-cordis 的 `cordis-panel`）和永久插件市场弹窗（ui-market）各自占用一个左侧栏底部入口——两个插件入口、两套关注点。此外，桌面运行时排除了 `openai` SDK，配置非 DeepSeek 的 OpenAI 兼容供应商会加载失败。

## 决策

新增客户端插件包 `@deepseek-ai/dsh-client-ui-workspace-ext`，提供两个工作区能力：

- **Git 分支徽章**（`conversation.input.left`，输入框工具行权限控件旁）：通过全局 `useWorkspaces` hook 解析当前会话的工作区路径，由 node 半读取 `.git/HEAD`，显示分支名（detached 时显示短 sha）。点击弹出锚定的本地分支菜单（`git for-each-ref`），选择后执行 `git checkout` 并刷新徽章；工作区有未提交改动导致切换失败时，菜单内直接显示 git 错误。徽章样式与相邻的权限选择器一致：28px 圆角胶囊，含分支 SVG 图标、分支名与旋转下箭头。
- **工作区面板**（`shell.right` 布局列，参考 VS Code 面板）：ui-layout 框架新增第四列，位于详情列与窗口右缘之间。与左侧栏一样，该列参与框架的让步链（先缩详情列，再缩右列，最后两者自动关闭；`ctx.layout.toggleRight()` 驱动 rail ⟷ 面板切换），并且像左侧栏竖条一样，收起时始终渲染紧凑的 40px 边缘竖条（从不归零——用户要求右侧栏像左侧栏一样表现）。竖条上纵向排列两个面板标签，点击某个标签即在该标签上展开面板。展开为分栏面板：头部只有标签行与图标收起按钮（左侧栏面板图标的方向镜像），各 tab 内容区自带操作工具条（终端为清屏/终止/启动，Git 为刷新）。**终端 tab** 自动连接——面板打开且存在工作区路径、无运行中会话时，自动通过 `subprocess.spawnTerminal` 在工作区目录启动一个会话（每进程一个），运行用户默认 shell（`process.env.SHELL`，macOS 未设置时为 zsh），其视口对齐 VS Code 终端：同一块深色可滚动表面渲染 shell 自身的输出流，保留 ANSI 颜色并回放光标重绘（进度条、换行回显、彩色提示符都正常），点击视口任意位置聚焦命令行（同 VS Code 终端），命令输入是 shell 最后一行提示符下方的无边框字段（回车执行），原生竖线光标是唯一光标；展开时增量轮询输出，收起时宿主保留 64KiB 有界缓冲。**Git 工作区 tab** 参考 VS Code 源代码管理面板：渲染 `git status --porcelain=v1 --branch` 解析结果（分支名、领先/落后计数），摘要行展示分支图标、分支名、变更总数胶囊与领先/落后计数，变更行按「暂存的更改 / 更改 / 未跟踪」分组列出，每条带状态字母徽标与分组计数徽章，Git tab 上显示变更总数徽章，另有手动刷新按钮。

node 半注册同源路由 `/api/workspace-ext`（`branch`、`branches`、`checkout`、`status`、`term/spawn|write|poll|kill|status`）。`parseGitStatus` 解析 `##` 头（分支、detached HEAD、未出生的分支、上游 delta）与双列 porcelain 状态码行。由于该能力可运行 git、可启动并喂给 shell，每个 handler 拒绝非回环 Host 头作为 DNS 重绑定防御。

插件市场弹窗（ui-market）携带 **Cordis 插件 tab**（与市场 tab 并列）：通过已注入的 `dynamicCordisRunner` Remote 读取当前会话的动态 Cordis 插件摘要列表（名称、plugin id、运行状态、运行状态圆点），ui-cordis 的独立侧栏入口渲染空。插件市场后端（`@deepseek-ai/dsh-host-plugin-market`：目录、git 源、安装/卸载 Remotes）由 web-app bundle 层挂载，远程浏览与安装可用；部署里的 workspace-ext 副本不再补丁市场界面（其手写 trigger/弹窗已移除——真正的 ui-market 负责侧栏触发项与弹窗）。市场触发项是侧栏底部的普通行，其样式与紧邻下方的「设置」触发项一致（34px 行 / 36px rail 圆形、12px 圆角、hover 填充、图标 + 文字）。

桌面运行时保留 OpenAI 兼容路径可用：`desktop/scripts/assemble-runtime.mjs` 仍排除其余 pi-ai provider SDK（`@mistralai/mistralai`、`@google/genai`、`@aws-sdk`、`@anthropic-ai/sdk`），这些供应商配置时会得到明确的缺依赖错误；但 `openai` 保留在 closure 中——它完全自包含（约 13MB、零运行时依赖），且其 completions 路径是最常见的自定义供应商路由。

## 备选方案

**浮层式终端面板而非侧栏**——否决。用户要求像左侧栏一样全高、可收起为竖条的右侧栏；先以 `shell.overlay` 浮层实现，后续迭代把面板移入 `shell.right` 布局列，让展开的面板真正挤压中间内容区。

**ui-market 跨包导入 ui-cordis 的 CordisPanel**——否决。包边界禁止导入其他插件的符号；Cordis tab 改为读取共享 Remote 渲染自己的摘要列表。

**在市场弹窗内用子槽位承载完整 Cordis 管理面板**——推迟。它需要新增槽位契约并改造 ui-cordis 的注册目标；摘要 tab 已覆盖浏览、运行卡片已覆盖审批，合并先按现状落地。

**把五个 pi-ai provider SDK 全部保留在桌面 closure**——否决。Mistral、GenAI、Bedrock、Anthropic 合计给每次冷启动增加约 50MB 死重，而多数安装不会配置这些供应商；每个保留各自的定向缺依赖错误。

## 影响

工作区面板、市场触发项样式对齐与 openai closure 修复随 `@deepseek-ai/dsh-client-ui-workspace-ext`（客户端 bundle）与 `desktop/scripts/assemble-runtime.mjs`（运行时 closure）一起交付。面板的 `status` 路由与 `parseGitStatus` 是新增的 node 半能力；终端自动连接把面板行为从显式启动改为打开即启动，有工作区路径的会话在面板展开时即 spawn bash。`openai` closure 改动使桌面运行时增加约 13MB，并让 OpenAI 兼容供应商可解析；其余四个 provider SDK 若被配置仍需各自的缺依赖错误路径。profile 持久安装（`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-workspace-ext`，v0.5.5）为运行中应用提供相同的客户端行为；其 node 半需重启应用才能加载新路由。
