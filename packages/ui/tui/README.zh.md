# @deepseek-ai/dsh-tui

[English](README.md) | 中文

基于 [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui) 构建的 DeepSeek Harness agent 交互式全屏终端前端门面。它要求 stdin 和 stdout 都必须是 TTY；管道和脚本使用一次性 [`dsh --profile headless`](../../bundle/headless/README.md) 界面。

本包只负责终端呈现和输入。它注入 `agents`、`agentDefaultModel`、`commands`、`sessions`、`sessionTitle`、`tools`、`userQuestions` 和 `approval`，然后通过 `ctx.agents` 创建（或通过 `--resume <id>` 恢复）其配置的 agent，并从持久化的 `session/event` 流驱动终端。它注册进程内的 `ctx.userQuestions` provider 和 `approval/request` 应答器，因此 `ask_user_question` 和沙箱审批会在终端中以键盘对话框的形式处理。Agent 生命周期、持久化和面向模型的 [`tool-ask-user`](../../interaction/tool-ask-user/README.md) 工具仍归其所属包负责。

随附的 `dsh --profile tui` 组合在 [`dsh-base`](../../bundle/base/README.md) 之上，通过 [`dsh-tui-app`](../../bundle/tui-app/README.md) 组成。前端门面通过 `ctx.cmdlineArgs` 读取启动器的内部参数，拥有 `--resume <sessionId>` 和本应用的 `--help`，并在恢复终端后通过启动器提供的 `ctx.appExit` 退出。

## 渲染内容

对话记录从 append-origin 会话日志重建，因此恢复的会话会显示此前说过的一切。助手步骤流式呈现：文本和推理按（turn, step）累积，Markdown 正文在每次块到达时重新渲染；`showReasoning: false` 会隐藏推理块。工具调用通过持久化的 `callId` 与其结果配对，工具的 `presentCall`/`presentResult` 意图驱动卡片标题和正文（终端 `$` 卡片、diff `+`/`-` 块以及通用文本卡片），并带有一个进行中/错误/完成状态字形。最新的 `todo/write` 列表位于编辑器上方，并在下一个 `turn/start` 时清除。最新记录的会话标题成为头部副标题和终端窗口标题。Esc 或 Ctrl+C 取消正在进行的回合，Ctrl+L 重绘，空闲时 Ctrl+D 退出，`/exit` 取消、冲刷并退出。`@` 文件引用补全和恢复会话选择器暂缓。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `sessionId` | `main` | 前端门面创建并驱动的确切共享 agent/会话身份。 |
| `welcome` | — | 在会话有记录标题前显示的横幅副标题行。 |
| `showReasoning` | `true` | 渲染推理块。 |
| `color` | `true` | 应用内置 ANSI 调色板；`false` 去除所有样式。 |
| `title` | `DeepSeek Harness` | 终端窗口标题的产品后缀。 |

```yaml
- id: tui
  name: '@deepseek-ai/dsh-tui'
  config:
    sessionId: main
    welcome: 'Coding agent ready.'
    showReasoning: true
```

当任一进程流不是 TTY 时，启动在挂载前立即失败。释放时会停止终端、关闭待处理的对话框、释放所拥有的 agent 句柄，并且绝不会在 HMR 期间退出替换进程。

## 人工交互

注册的 `userQuestions` provider 将每个面向模型的问题（包括 plan-mode 评审）呈现为单选覆盖层；取消对话框会以 `ASK_ABORTED` 拒绝该问题。`approval/request` 应答器为前端门面的 agent 及其拥有的每个 agent（子 agent）作答，显示允许/拒绝对话框，并将其他 agent 的请求委托给链下的应答器。两者共享一个 FIFO 对话框队列，因此问题绝不会打断待处理的审批，反之亦然。

## 命令

前端门面在 `ctx.commands` 上注册 `/help`、`/exit` 和 `/clear`，因此它们像其他命令一样记录其生命周期，并动态加入 `/help`。未知的斜杠行会渲染警告提示，且绝不会到达模型。

## Model Experience

### 交互式提示输入

#### 模型看到的内容

每次非空的编辑器提交都成为一条普通的用户文本消息，在 agent 空闲时通过 `agent.followup()` 发送，运行时通过 `agent.steer()` 发送。斜杠命令和键绑定仅限终端；命令结果仍是终端提示，绝不会进入对话。

#### Token 影响

提交的文本在 agent loop 的常规会话历史和压缩规则下保留。头部、记录的标题、卡片、Markdown 渲染、状态行和帮助文本不增加 token。

#### KV Cache 影响

仅追加；新可见的内容跟随可复用的请求前缀，不会使现有 KV-cache 条目失效。

## 已知限制和待办工作

- **仅支持单选对话框** —— 尚不支持多选 `ask_user_question` 选项和自定义文本答案；多选问题表现为单选。
- **恢复仅限同一工作目录** —— `--resume` 会加载持久化会话，但前端门面不会重新进入会话记录的工作目录；文件系统和 shell 工具针对调用目录解析。
- **没有 `@` 补全或恢复选择器** —— 文件路径引用自动补全和交互式会话选择器暂缓；会话 id 必须在 `--resume` 中键入。
- **通过 profile 固定 JSONL 持久化** —— 前端门面读取 `ctx.agents.resume` 所依赖的任何后端；更换后端是组合选择。
- **兄弟插件可能破坏屏幕** —— 前端门面无法阻止其他条目向其拥有的 stdout 写入字节。
