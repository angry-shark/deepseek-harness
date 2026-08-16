# Agent Note: 工作区增强（Git 分支徽章 + 分栏工作区面板）与合并进插件市场的 Cordis tab

Status: implemented

[English](2026-08-16-workspace-ext-git-branch-terminal.md) | 中文

## 问题

GUI 没有按工作区提供 git 或终端能力：输入框工具行只显示权限等既有控件，不显示当前分支；应用内也没有针对工作区目录的终端。另一方面，动态 Cordis 插件管理（ui-cordis 的 `cordis-panel`）和永久插件市场弹窗（ui-market）各自占用一个左侧栏底部入口——两个插件入口、两套关注点。此外，桌面运行时排除了 `openai` SDK，配置非 DeepSeek 的 OpenAI 兼容供应商会加载失败。

## 决策

新增客户端插件包 `@deepseek-ai/dsh-client-ui-workspace-ext`，提供两个工作区能力：

- **Git 分支徽章**（`conversation.input.left`，输入框工具行权限控件旁）：通过全局 `useWorkspaces` hook 解析当前会话的工作区路径，由 node 半读取 `.git/HEAD`，显示分支名（detached 时显示短 sha）。点击弹出锚定的本地分支菜单（`git for-each-ref`），选择后执行 `git checkout` 并刷新徽章；工作区有未提交改动导致切换失败时，菜单内直接显示 git 错误。
- **分栏工作区面板**（`shell.overlay#workspace-panel`，参考 VS Code 底部面板）：右缘全高竖排标签（显示「终端 · Git」），展开为 360px 双 tab 面板。**终端 tab** 自动连接——面板打开且存在工作区路径、无运行中会话时，自动通过 `subprocess.spawnTerminal` 在工作区目录启动一个 bash 会话（每进程一个），提供启动/终止/清屏、ANSI 清理后的输出区与命令输入行；展开时增量轮询输出，收起时宿主保留 64KiB 有界缓冲。**Git 工作区 tab** 渲染 `git status --porcelain=v1 --branch` 解析结果（分支名、领先/落后计数、每条变更的已暂存/未暂存状态标签），带手动刷新按钮。收起与展开通过宽度 + 淡入过渡动画：180ms 宽度过渡期间内容保持挂载，settle 后卸载，竖条标签无跳变切换。

node 半注册同源路由 `/api/workspace-ext`（`branch`、`branches`、`checkout`、`status`、`term/spawn|write|poll|kill|status`）。`parseGitStatus` 解析 `##` 头（分支、detached HEAD、未出生的分支、上游 delta）与双列 porcelain 状态码行。由于该能力可运行 git、可启动并喂给 shell，每个 handler 拒绝非回环 Host 头作为 DNS 重绑定防御。

插件市场弹窗（ui-market）新增 **Cordis 插件 tab**（与市场 tab 并列）：通过已注入的 `dynamicCordisRunner` Remote 读取当前会话的动态 Cordis 插件摘要列表（名称、plugin id、运行状态）。ui-cordis 的独立侧栏入口改为渲染空，侧栏保留单一插件入口，动态插件浏览并入市场弹窗；对话流内的 Cordis 运行卡片与审批保持不变。市场触发项是侧栏底部的普通行，其样式与紧邻下方的「设置」触发项一致（34px 行 / 36px rail 圆形、12px 圆角、hover 填充、图标 + 文字）。

桌面运行时保留 OpenAI 兼容路径可用：`desktop/scripts/assemble-runtime.mjs` 仍排除其余 pi-ai provider SDK（`@mistralai/mistralai`、`@google/genai`、`@aws-sdk`、`@anthropic-ai/sdk`），这些供应商配置时会得到明确的缺依赖错误；但 `openai` 保留在 closure 中——它完全自包含（约 13MB、零运行时依赖），且其 completions 路径是最常见的自定义供应商路由。

## 备选方案

**浮层式终端面板而非侧栏**——否决。用户要求像左侧栏一样全高、可收起为竖条的右侧栏；`shell.overlay` 实现贴合该形态。

**ui-market 跨包导入 ui-cordis 的 CordisPanel**——否决。包边界禁止导入其他插件的符号；Cordis tab 改为读取共享 Remote 渲染自己的摘要列表。

**在市场弹窗内用子槽位承载完整 Cordis 管理面板**——推迟。它需要新增槽位契约并改造 ui-cordis 的注册目标；摘要 tab 已覆盖浏览、运行卡片已覆盖审批，合并先按现状落地。

**把五个 pi-ai provider SDK 全部保留在桌面 closure**——否决。Mistral、GenAI、Bedrock、Anthropic 合计给每次冷启动增加约 50MB 死重，而多数安装不会配置这些供应商；每个保留各自的定向缺依赖错误。

## 影响

工作区面板、市场触发项样式对齐与 openai closure 修复随 `@deepseek-ai/dsh-client-ui-workspace-ext`（客户端 bundle）与 `desktop/scripts/assemble-runtime.mjs`（运行时 closure）一起交付。面板的 `status` 路由与 `parseGitStatus` 是新增的 node 半能力；终端自动连接把面板行为从显式启动改为打开即启动，有工作区路径的会话在面板展开时即 spawn bash。`openai` closure 改动使桌面运行时增加约 13MB，并让 OpenAI 兼容供应商可解析；其余四个 provider SDK 若被配置仍需各自的缺依赖错误路径。profile 持久安装（`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-workspace-ext`，v0.5.3）为运行中应用提供相同的客户端行为；其 node 半需重启应用才能加载新路由。
