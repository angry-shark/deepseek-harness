# @deepseek-ai/dsh-client-ui-workspace-ext

[English](README.md) | 中文

工作区增强：输入框工具行的 Git 分支徽章（带锚定的分支切换菜单），以及右侧工作区列（终端 + Git 源代码管理 tab），运行在当前会话工作区目录里的 bash。

**Git 分支徽章** 填充 `conversation.input.left`（输入框工具行，权限等既有控件旁）。它通过全局 `useWorkspaces` hook 读取当前会话的工作区路径，经 node 半解析 `.git/HEAD` 显示分支名（detached 时显示短 sha）。点击徽章弹出锚定菜单，列出全部本地分支（`git for-each-ref`）；点击分支执行 `git checkout` 并刷新徽章，工作区阻止切换时菜单内显示 git 错误。徽章样式与相邻的权限选择器一致：28px 圆角胶囊，含分支 SVG 图标、分支名与旋转下箭头。

**工作区面板** 填充 `shell.right` 布局列，位于详情列与窗口右缘之间。与左侧栏一样，该列参与框架的让步链——面板展开时挤压中间内容区而非覆盖其上。收起时是紧凑的全高边缘竖条，上面纵向排列两个面板标签；点击某个标签即在该标签上展开面板。展开为分栏面板，参考 VS Code 面板：面板头部只有标签行与图标收起按钮（左侧栏面板图标的方向镜像），各 tab 内容区自带操作工具条（终端为清屏/终止/启动，Git 为刷新）。**终端栏** 自动连接：打开面板即通过 `subprocess.spawnTerminal` 在当前工作区目录启动每进程一个的会话，运行用户默认 shell（`process.env.SHELL`，macOS 未设置时为 zsh）。其视口对齐 VS Code 终端——同一块深色可滚动表面渲染 shell 自身的输出流，保留 ANSI 颜色并回放光标重绘（进度条、换行回显、彩色提示符都正常），点击视口任意位置聚焦命令行（同 VS Code 终端），命令输入是 shell 最后一行提示符下方的无边框字段（回车执行），原生竖线光标是唯一光标；展开时增量轮询输出，收起时宿主保留有界缓冲。**Git 工作区栏** 参考 VS Code 源代码管理面板：摘要行展示分支图标、分支名、变更总数胶囊与领先/落后计数，变更行按「暂存的更改 / 更改 / 未跟踪」分组列出，每条带状态字母徽标与分组计数徽章，另有手动刷新按钮与 Git tab 上的变更总数徽章。

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
