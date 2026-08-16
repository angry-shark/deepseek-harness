# @deepseek-ai/dsh-client-ui-workspace-ext

[English](README.md) | 中文

工作区增强：输入框工具行的 Git 分支徽章（带锚定的分支切换菜单），以及运行在当前会话工作区目录里的右侧可收起分栏面板（终端 + Git 工作区）。

**Git 分支徽章** 填充 `conversation.input.left`（输入框工具行，权限等既有控件旁）。它通过全局 `useWorkspaces` hook 读取当前会话的工作区路径，经 node 半解析 `.git/HEAD` 显示分支名（detached 时显示短 sha）。点击徽章弹出锚定菜单，列出全部本地分支（`git for-each-ref`）；点击分支执行 `git checkout` 并刷新徽章，工作区阻止切换时菜单内显示 git 错误。

**工作区面板** 填充帧级浮层 `shell.overlay`。收起时是右缘全高竖条；点击展开为 360px 分栏面板，参考 VS Code 底部面板。**终端栏** 自动连接：打开面板即通过 `subprocess.spawnTerminal` 在当前工作区目录启动每进程一个的 bash 会话，含启动/终止/清屏控件、ANSI 清理后的输出区与命令输入行；展开时增量轮询输出，收起时宿主保留有界缓冲。**Git 工作区栏** 展示 `git status --porcelain` 解析出的工作区状态——分支名、领先/落后计数，以及每条变更的已暂存/未暂存状态标签，带手动刷新按钮。收起与展开通过宽度 + 淡入过渡动画（宽度动画期间内容保持挂载，settle 后卸载）。

node 半注册同源路由 `/api/workspace-ext`（`branch`、`branches`、`checkout`、`status`、`term/spawn|write|poll|kill|status`）。该能力可运行 git、可启动并喂给 shell，因此每个 handler 拒绝非回环 Host 头作为 DNS 重绑定防御。

两个目标槽位都由其他插件声明（ui-conversation 与 ui-layout），因此 `apply` 用 `slots.inject()` 按声明生命周期注册，并在声明槽位被恢复后重新注册。

## Model Experience

无。这些界面是浏览器外壳，不进入任何模型请求。

#### KV Cache 影响

无。本包既不组装也不发送 provider 请求。

## 已知限制与后续工作

- **每进程一个终端**——终端会话是进程级的，不按会话区分；切换会话后保持原工作目录，直到终端重新启动。
- **纯文本终端渲染**——输出做 ANSI 清理后以等宽文本渲染；全屏交互程序（编辑器、分页器）显示会退化。
- **git checkout 无保护**——切换是对工作区直接执行 `git checkout`；除展示 git 错误外没有 stash/冲突解决能力。
