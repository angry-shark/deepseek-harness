# Agent Note: 工作区增强（Git 分支徽章 + 分栏工作区面板）与合并进插件市场的 Cordis tab

Status: implemented

[English](2026-08-16-workspace-ext-git-branch-terminal.md) | 中文

## 问题

GUI 没有按工作区提供 git 或终端能力：输入框工具行只显示权限等既有控件，不显示当前分支；应用内也没有针对工作区目录的终端。另一方面，动态 Cordis 插件管理（ui-cordis 的 `cordis-panel`）和永久插件市场弹窗（ui-market）各自占用一个左侧栏底部入口——两个插件入口、两套关注点。此外，桌面运行时排除了 `openai` SDK，配置非 DeepSeek 的 OpenAI 兼容供应商会加载失败。

## 决策

新增客户端插件包 `@deepseek-ai/dsh-client-ui-workspace-ext`，提供两个工作区能力：

- **Git 分支徽章**（`conversation.input.left`，输入框工具行权限控件旁）：通过全局 `useWorkspaces` hook 解析当前会话的工作区路径，由 node 半读取 `.git/HEAD`，显示分支名（detached 时显示短 sha）。点击弹出锚定的本地分支菜单（`git for-each-ref`），选择后执行 `git checkout` 并刷新徽章；工作区有未提交改动导致切换失败时，菜单内直接显示 git 错误。徽章样式与相邻的权限选择器一致：28px 圆角胶囊，含分支 SVG 图标、分支名与旋转下箭头。
- **工作区面板**（`shell.right` 布局列，参考 VS Code 面板）：ui-layout 框架新增第四列，位于详情列与窗口右缘之间。与左侧栏一样，该列参与框架的让步链（先缩详情列，再缩右列，最后两者自动关闭；`ctx.layout.toggleRight()` 驱动 rail ⟷ 面板切换），并且像左侧栏竖条一样，收起时始终渲染紧凑的 40px 边缘竖条（从不归零——用户要求右侧栏像左侧栏一样表现）。竖条上纵向排列两个面板标签，点击某个标签即在该标签上展开面板。展开为分栏面板：头部只有标签行与图标收起按钮（左侧栏面板图标的方向镜像），各 tab 内容区自带操作工具条（终端为清屏/终止/启动，Git 为刷新）。**终端 tab** 自动连接——面板打开且存在工作区路径、无运行中会话时，自动通过 `subprocess.spawnTerminal` 在工作区目录启动一个会话（每进程一个），运行用户默认 shell（`process.env.SHELL`，macOS 未设置时为 zsh），并以 `TERM=xterm-256color` 启动。输出通过 SSE（`term/stream`，取代 500ms 轮询）实时到达浏览器，回显在几十毫秒内渲染；客户端按键写入按序串行，快速输入不会在线路上乱序（subprocess spec 新增可选 `name`；默认的 `dumb` 类型对应的 terminfo 条目没有清屏能力，会使 `/usr/bin/clear` 变成无声的 no-op）。其视口是真正的终端模拟器（xterm.js，与 VS Code 使用同一引擎）：shell 的 PTY 输出流被忠实回放——清屏、光标移动序列、ANSI 颜色、滚动缓冲与全屏程序的行为都与真实终端一致——按键直接流向 shell，由 shell 通过输出流回显，因此光标精确地停在提示符之后。终端按面板宽度自适应（FitAddon + ResizeObserver），并通过新增的 `term/resize` 路由把实时尺寸变化转发给 PTY（终端句柄新增可选 `resize`）；面板体在收起或切到 Git 栏时保持挂载，因此终端会继续运行，如同隐藏的 VS Code 面板。工具条保留清屏（xterm `clear()`；字面 `clear` 命令也会在客户端清空视口，因此在 node 半启用真实 TERM 之前也能工作）、终止与启动。多终端与分屏随 node 半的会话表落地：`spawn` 分配 `term-N` id（传入已有 id 时原地重启该会话），每个终端路由按 id 寻址一个会话，客户端为每个会话渲染一个分栏并带 VS Code 式标签条，标签切换显示哪个终端——只渲染活动分栏所属分组的分栏，因此「分屏」生成的孪生对即使切换标签也保持堆叠；隐藏的分栏保持挂载（xterm 回滚缓冲与 SSE 流在切换间存活）。「新终端」追加一个标签并切换过去，「分屏」在活动会话之后插入新分栏并与它同组，双击标签名即可就地重命名，标签可关闭会话；关闭最后一个后不再自动重启。**Git 工作区 tab 的 diff 查看器**对代码做语法高亮：「+」/「-」行带固定宽度的符号栏，其后的代码按文件扩展名选择语言，经由共享的 shiki 高亮器（`highlightLines`，来自重新作为 peer 依赖的 dsh-client-ui-primitives）着色，懒加载的语言在加载完成后重新渲染。**Git 工作区 tab** 参考 VS Code 源代码管理面板：渲染 `git status --porcelain=v1 --branch` 解析结果（分支名、领先/落后计数），摘要行展示分支图标、分支名、变更总数胶囊与领先/落后计数，变更行按「暂存的更改 / 更改 / 未跟踪」分组列出，每条带状态字母徽标与分组计数徽章，Git tab 上显示变更总数徽章，另有手动刷新按钮。它还带有 VS Code SCM 交互：顶部提交框（消息输入 + 提交按钮，回车提交，无暂存内容时智能提交全部变更）、可折叠分组的箭头、分组头部操作（全部暂存 / 全部取消暂存 / 放弃全部更改），以及悬停浮现的单文件暂存 / 取消暂存 / 放弃按钮。这些变更通过单一 node 半路由 `POST /api/workspace-ext/git/action` 执行，`action` 字段为白名单（`stage` / `unstage` / `discard` / `commit`）；`discard` 在文件已暂存时从 HEAD 还原，`commit` 带 `all` 时先暂存全部。放弃只作用于已跟踪变更——未跟踪行仅提供暂存，绝不删除文件。

node 半注册同源路由 `/api/workspace-ext`（`branch`、`branches`、`checkout`、`status`、`diff`、`git/action`、`term/spawn|write|resize|stream|kill|status`）；`diff` 路由支撑 Git 栏的 Codex 式修改查看器——已跟踪文件显示统一 diff（`git diff`，已暂存时用 `--cached`），未跟踪文件显示原文。`parseGitStatus` 解析 `##` 头（分支、detached HEAD、未出生的分支、上游 delta）与双列 porcelain 状态码行。由于该能力可运行 git、可启动并喂给 shell，每个 handler 拒绝非回环 Host 头作为 DNS 重绑定防御。

插件市场弹窗（ui-market）携带 **Cordis 插件 tab**（与市场 tab 并列）：通过已注入的 `dynamicCordisRunner` Remote 读取当前会话的动态 Cordis 插件摘要列表（名称、plugin id、运行状态、运行状态圆点），ui-cordis 的独立侧栏入口渲染空。插件市场后端（`@deepseek-ai/dsh-host-plugin-market`：目录、git 源、安装/卸载 Remotes）由 web-app bundle 层挂载，远程浏览与安装可用；部署里的 workspace-ext 副本不再补丁市场界面（其手写 trigger/弹窗已移除——真正的 ui-market 负责侧栏触发项与弹窗）。市场触发项是侧栏底部的普通行，其样式与紧邻下方的「设置」触发项一致（34px 行 / 36px rail 圆形、12px 圆角、hover 填充、图标 + 文字）。

桌面运行时保留 OpenAI 兼容路径可用：`desktop/scripts/assemble-runtime.mjs` 仍排除其余 pi-ai provider SDK（`@mistralai/mistralai`、`@google/genai`、`@aws-sdk`、`@anthropic-ai/sdk`），这些供应商配置时会得到明确的缺依赖错误；但 `openai` 保留在 closure 中——它完全自包含（约 13MB、零运行时依赖），且其 completions 路径是最常见的自定义供应商路由。

## 备选方案

**浮层式终端面板而非侧栏**——否决。用户要求像左侧栏一样全高、可收起为竖条的右侧栏；先以 `shell.overlay` 浮层实现，后续迭代把面板移入 `shell.right` 布局列，让展开的面板真正挤压中间内容区。

**ui-market 跨包导入 ui-cordis 的 CordisPanel**——否决。包边界禁止导入其他插件的符号；Cordis tab 改为读取共享 Remote 渲染自己的摘要列表。

**在市场弹窗内用子槽位承载完整 Cordis 管理面板**——推迟。它需要新增槽位契约并改造 ui-cordis 的注册目标；摘要 tab 已覆盖浏览、运行卡片已覆盖审批，合并先按现状落地。

**把五个 pi-ai provider SDK 全部保留在桌面 closure**——否决。Mistral、GenAI、Bedrock、Anthropic 合计给每次冷启动增加约 50MB 死重，而多数安装不会配置这些供应商；每个保留各自的定向缺依赖错误。

## 影响

工作区面板、市场触发项样式对齐与 openai closure 修复随 `@deepseek-ai/dsh-client-ui-workspace-ext`（客户端 bundle）与 `desktop/scripts/assemble-runtime.mjs`（运行时 closure）一起交付。面板的 `status` 路由与 `parseGitStatus` 是新增的 node 半能力，`git/action` 路由与 SCM 提交/分组/文件交互是随后的源代码管理轮次；终端自动连接把面板行为从显式启动改为打开即启动，有工作区路径的会话在面板展开时即 spawn bash。真实终端轮次用手写行渲染器替换为 xterm.js，并加入 `TERM=xterm-256color` 与 `term/resize` 路由；低延迟轮次把 500ms 轮询换成 SSE 输出流（浏览器实测回显约 44ms），Git 栏新增 `diff` 路由与 Codex 式逐文件修改查看器；多终端轮次把单会话单例改成会话表与按 id 寻址的路由，并新增分栏/标签分屏 UI，其标签后来改为切换显示哪个终端（分屏是持久分组：切到任一成员都保持双栏堆叠，关闭某一成员时优先回退到同组兄弟）；标签名支持双击重命名，Git diff 查看器经共享 shiki 高亮器（dsh-client-ui-primitives 重新成为 peer 依赖，仅为高亮而引入，两个图标仍内联）高亮代码，右侧栏拖拽上限由 520 增至 760px（RIGHT_MAX）。`openai` closure 改动使桌面运行时增加约 13MB，并让 OpenAI 兼容供应商可解析；其余四个 provider SDK 若被配置仍需各自的缺依赖错误路径。profile 持久安装（`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-workspace-ext`）为运行中应用提供相同的客户端行为；其 node 半需重启应用才能加载新的 spawn `name`、resize 路由以及此前的用户 shell 改动。
