# ui/ — 交互式终端呈现

[English](README.md) | 中文

终端呈现平面：一个全屏前端门面，渲染 harness agent 的持久会话并允许用户驱动它。这些都是**产品**包——Web 界面的交互式对应物。仅自动化的 ACP 传输仍属于 [`acp/`](../acp/README.md)，一次性任务使用 `dsh --profile headless`。

| 包 | 角色 | ctx key |
|---|---|---|
| [`tui/`](tui/README.md) | 全屏终端前端门面：对话记录、编辑器、问题/审批对话框、斜杠命令。 | （插件，提供交互 provider） |

前端门面通过与 Web host 相同的接缝消费共享交互服务——[`commands`](../interaction/commands/README.md)、[`user-questions`](../interaction/user-questions/README.md)、[`user-approval`](../interaction/user-approval/README.md)——并且随附的 `tui` profile 在 [`dsh-base`](../bundle/base/README.md) 之上通过 [`dsh-tui-app`](../bundle/tui-app/README.md) 组合它。
