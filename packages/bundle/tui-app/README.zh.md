# `@deepseek-ai/dsh-tui-app`

[English](README.md) | 中文

dsh 交互式终端 bundle。[`cordis.patch.yml`](cordis.patch.yml) 叠加在 [`dsh-base`](../base/README.md) 之上：它设置编码 persona，保留共享的工具和交互行，并插入本 bundle 的 `tui` 行——[`@deepseek-ai/dsh-tui`](../../ui/tui/README.md) 前端门面。它不挂载 Host、HTTP 服务器、Web 运行时或浏览器插件。前端门面通过核心注册表创建（或通过 `--resume <id>` 恢复）自己的 agent，并在用户退出前拥有终端屏幕。

`dsh --profile tui` 从随附的 profile 模板自动初始化此 bundle；前端门面读取启动器的内部参数，因此 `dsh --profile tui --resume <id>` 会恢复持久化会话，`dsh --profile tui --help` 会打印终端应用的帮助。

## 组合

| 插件 | 角色 |
|---|---|
| `@deepseek-ai/dsh-tui` | 全屏前端门面：对话记录、编辑器、问题/审批对话框、斜杠命令。 |
| `dsh-base` 行 | 共享核心：模型适配器、工具、持久化、沙箱与审批策略、设置、凭据、遥测。 |

## 配置

| 键 | 默认值 | 路由到 |
|---|---|---|
| `sessionId` | `main` | 前端门面创建的新的会话身份。 |
| `welcome` | `Coding agent ready.` | 在会话有记录标题前显示的横幅副标题。 |
| `showReasoning` | `true` | 是否渲染推理块。 |

随附的 `cordis.patch.yml` 只覆盖本界面拥有的 persona；base bundle 拥有的其他值在此模式下保持中性。

## Model Experience

### 交互式提示输入

#### 模型看到的内容

该 bundle 本身不添加任何绑定模型的内容；前端门面的普通用户文本提交就是对话。persona——一段插值 `{{model}}` 和 `{{cwd}}` 的段落——是本 bundle 对请求前缀贡献的唯一文本。

#### Token 影响

persona 段落每会话在系统提示中出现一次。

#### KV Cache 影响

persona 在进程生命周期内保持稳定，因此不会使跨回合的缓存失效。

## 已知限制和待办工作

- **需要 TTY** —— 非交互式部署使用 `dsh --profile headless`；当任一流是管道时此 profile 会立即失败。
- **一个 agent 拥有屏幕** —— 该组合只创建一个 agent；并发交互式会话是其他进程。
