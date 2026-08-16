# Agent Note: 专用全屏 TUI 前端门面

Status: implemented

[English](2026-08-16-dsh-tui-front-door.md) | 中文

## Problem

DeepSeek Harness 曾随附一个基于 `@earendil-works/pi-tui` 构建的全屏终端前端门面（`packages/ui/tui`），[TUI 移除](../../archived/feature/2026-07-17-dedicated-full-screen-tui-front-door.md)连同其 `dsh` 默认界面入口一起删除了它。改名包、拆分交互层之后的代码库（interaction 包、core 分组、profile 启动器）没有交互式终端界面：`dsh --profile headless` 回答一个任务后退出，ACP 仅限自动化，Web 界面是浏览器。在终端前的人无法进行实时的、可恢复的对话。

## Decision

本次变更把交互式终端前端门面恢复为 `dsh` CLI 自身的 `tui` profile，而不是复活被移除的实现。前端门面住在 `apps/cli` 内（`src/tui`，导出为 `@deepseek-ai/dsh/tui`），`dsh` 包声明一个 `dsh.bundle` patch（`cordis.tui.yml`），在 `dsh-base` 之上组合出 `tui` profile。旧代码面向已不存在的改名前 API（`dsh-user-interaction`、`dsh-compact`、`dsh-session-projection-cache`、`agent.send`/`agent.steer` 语义），其 2.9 万行代码捆绑的功能在当前不变量下需要重新设计；在现有接缝之上构建一个全新、聚焦的前端门面是更小、更可维护的基础。

前端门面是一个 Cordis 插件，只负责终端呈现和输入，生命周期遵循 headless-runner 的先例：它注入 `agents`、`agentDefaultModel`、`commands`、`sessions`、`sessionTitle`、`tools`、`userQuestions` 和 `approval`，解析启动器的内部参数（拥有 `--resume <sessionId>` 和本应用的 `--help`），通过 `ctx.agents.create` 创建 agent（或通过 `--resume` 用 `ctx.agents.resume` 恢复持久化会话），并从持久化的 `session/event` 流驱动终端。它渲染 append-origin 对话记录（助手文本和推理按步流式呈现，工具卡片通过 `callId` 配对并使用 `presentCall`/`presentResult` 意图，最新的 `todo/write` 位于编辑器上方，记录的标题作为头部和窗口标题），在空闲时用 `agent.followup()` 提交编辑器输入，运行时用 `agent.steer()`，Esc/Ctrl+C 取消，通过 `ctx.appExit` 退出，并在任一流不是 TTY 时立即失败。

人工交互通过现有接缝运行：前端门面注册唯一的 `ctx.userQuestions` provider 和一个 `approval/request` 瀑布应答器（为其 agent 及它拥有的每个 agent 作答，其余委托），两者都作为单选覆盖层呈现，共享一个 FIFO 对话框队列。它在 `ctx.commands` 上注册 `/help`、`/exit` 和 `/clear`，因此命令生命周期保持记录，其他命令（plan mode、compact、goal、feedback）无需新分支即可加入 `/help` 和自动补全。

`dsh-tui-app` 以编码 persona 和 `tui` 行叠加在 `dsh-base` 之上；`dsh-app-boot` 中的 `PROFILE_TEMPLATES` 和 `INSTALLATION_OWNED_PROFILE_TUPLES` 增加 `tui`，因此 `dsh --profile tui` 像 `web` 和 `headless` 一样自动初始化。包目录为 `tui-app`（与 `web-app` 一致），使包目录名在组间保持唯一，从而 tsconfig `paths` 通配符 `@deepseek-ai/dsh-*` 能无歧义地将 `@0xleon/dsh-tui` 解析到 `packages/ui/tui`。

## Alternatives considered

- **复活被移除的 `packages/ui/tui`** —— 被拒绝：它是针对已移除 API 编写的，其恢复交接和 projection-cache 机制依赖不再存在的服务，沿用其决策需要从 2.9 万行已删除代码中重新推导当前不变量。
- **把前端门面作为独立 npm 包发布** —— 被拒绝：这些包名不在 registry 上，而 fork 无法发布到 `@deepseek-ai` scope，因此 URL 安装 CLI 会因解析它们而失败。把前端门面并入 CLI 包使打包的 tarball 自包含。
- **让 TUI 插件通过配置（`agent-loop.agents`）创建 agent** —— 被拒绝，因为 `--resume` 必须选择持久化身份；通过 `ctx.agents` 创建或恢复的 runner 保持单一路径，并镜像 `dsh-headless`。

## Consequences

- 在终端前的人获得全屏、可恢复的对话前端门面；非 TTY 部署仍使用 `dsh --profile headless`。
- 前端门面为 `dsh` CLI 的运行时依赖增加 `@earendil-works/pi-tui`（外部化，从 npm registry 解析）。
- TUI 只渲染持久化日志记录的内容，且只通过交互接缝作答，因此其模型可见和持久化界面恰好是日志与服务已保证的内容。
- 多选问题、自定义文本答案、`@` 文件补全、会话选择器以及恢复时的工作目录重入暂缓，并在 CLI README 中记录。
