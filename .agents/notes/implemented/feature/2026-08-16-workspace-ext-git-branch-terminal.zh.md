# Agent Note: 工作区增强（Git 分支徽章 + 终端侧栏）与合并进插件市场的 Cordis tab

Status: implemented

[English](2026-08-16-workspace-ext-git-branch-terminal.md) | 中文

## 问题

GUI 没有按工作区提供 git 或终端能力：输入框工具行只显示权限等既有控件，不显示当前分支；应用内也没有针对工作区目录的终端。另一方面，动态 Cordis 插件管理（ui-cordis 的 `cordis-panel`）和永久插件市场弹窗（ui-market）各自占用一个左侧栏底部入口——两个插件入口、两套关注点。

## 决策

新增客户端插件包 `@deepseek-ai/dsh-client-ui-workspace-ext`，提供两个工作区能力：

- **Git 分支徽章**（`conversation.input.left`，输入框工具行权限控件旁）：通过全局 `useWorkspaces` hook 解析当前会话的工作区路径，由 node 半读取 `.git/HEAD`，显示分支名（detached 时显示短 sha）。点击弹出锚定的本地分支菜单（`git for-each-ref`），选择后执行 `git checkout` 并刷新徽章；工作区有未提交改动导致切换失败时，菜单内直接显示 git 错误。
- **终端侧栏**（`shell.overlay`）：右缘全高竖排标签，展开为 360px 面板，通过 `subprocess.spawnTerminal` 在工作区目录启动一个 bash 会话（每进程一个），提供启动/终止/清屏/收起、ANSI 清理后的输出区与命令输入行。展开时增量轮询输出；收起时宿主保留 64KiB 有界缓冲。

node 半注册同源路由 `/api/workspace-ext`（`branch`、`branches`、`checkout`、`term/spawn|write|poll|kill|status`）。由于该能力可运行 git、可启动并喂给 shell，每个 handler 拒绝非回环 Host 头作为 DNS 重绑定防御。

插件市场弹窗（ui-market）新增 **Cordis 插件 tab**（与市场 tab 并列）：通过已注入的 `dynamicCordisRunner` Remote 读取当前会话的动态 Cordis 插件摘要列表（名称、plugin id、运行状态）。ui-cordis 的独立侧栏入口改为渲染空，侧栏保留单一插件入口，动态插件浏览并入市场弹窗；对话流内的 Cordis 运行卡片与审批保持不变。

## 备选方案

**浮层式终端面板而非侧栏**——否决。用户要求像左侧栏一样全高、可收起为竖条的右侧栏；`shell.overlay` 实现贴合该形态。

**ui-market 跨包导入 ui-cordis 的 CordisPanel**——否决。包边界禁止导入其他插件的符号；Cordis tab 改为读取共享 Remote 渲染自己的摘要列表。

**在市场弹窗内用子槽位承载完整 Cordis 管理面板**——推迟。它需要新增槽位契约并改造 ui-cordis 的注册目标；摘要 tab 已覆盖浏览、运行卡片已覆盖审批，合并先按现状落地。
