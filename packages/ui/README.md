# ui/ — interactive terminal presentation

English | [中文](README.zh.md)

The terminal presentation plane: one full-screen front door that renders a harness agent's durable session and lets a person drive it. These are **product** packages — the interactive counterpart to the `web` surface. The automation-only ACP transport stays under [`acp/`](../acp/README.md), and one-shot tasks use `dsh --profile headless`.

| Package | Role | ctx key |
|---|---|---|
| [`tui/`](tui/README.md) | The full-screen terminal front door: transcript, editor, questions/approval dialogs, slash commands. | (plugin, provides interaction providers) |

The front door consumes the shared interaction services — [`commands`](../interaction/commands/README.md), [`user-questions`](../interaction/user-questions/README.md), [`user-approval`](../interaction/user-approval/README.md) — through the same seams the Web host uses, and the shipped `tui` profile composes it over [`dsh-base`](../bundle/base/README.md) via [`dsh-tui-app`](../bundle/tui-app/README.md).
