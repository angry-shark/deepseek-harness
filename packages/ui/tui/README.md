# @deepseek-ai/dsh-tui

English | [中文](README.zh.md)

The interactive full-screen terminal front door for DeepSeek Harness agents, built on [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui). It requires both stdin and stdout to be TTYs; pipes and scripts use the one-shot [`dsh --profile headless`](../../bundle/headless/README.md) surface instead.

This package owns terminal presentation and input only. It injects `agents`, `agentDefaultModel`, `commands`, `sessions`, `sessionTitle`, `tools`, `userQuestions`, and `approval`, then creates (or, with `--resume <id>`, resumes) its configured agent through `ctx.agents` and drives the terminal from the durable `session/event` stream. It registers the in-process `ctx.userQuestions` provider and the `approval/request` answerer, so `ask_user_question` and sandbox approvals settle as keyboard dialogs at the terminal. Agent lifecycle, persistence, and the model-facing [`tool-ask-user`](../../interaction/tool-ask-user/README.md) tool remain the owning packages' contracts.

The shipped `dsh --profile tui` composition rides over [`dsh-base`](../../bundle/base/README.md) through [`dsh-tui-app`](../../bundle/tui-app/README.md). The front door reads the launcher's inner arguments through `ctx.cmdlineArgs`, owns `--resume <sessionId>` and this app's `--help`, and exits through the launcher-provided `ctx.appExit` after restoring the terminal.

## What it renders

The transcript rebuilds the conversation from the append-origin session log, so a resumed session shows exactly what was said before. Assistant steps stream: text and reasoning accumulate per (turn, step) and the Markdown body re-renders on each chunk; `showReasoning: false` hides reasoning blocks. Tool calls pair with their results through the durable `callId`, and the tool's own `presentCall`/`presentResult` intents drive card titles and bodies (terminal `$` cards, diff `+`/`-` hunks, and the generic text card) with a pending/error/done status glyph. The latest `todo/write` list sits above the editor and clears on the next `turn/start`. The latest logged session title becomes the header subtitle and the terminal window title. Esc or Ctrl+C cancels a running turn, Ctrl+L redraws, Ctrl+D exits while idle, and `/exit` cancels, flushes, and exits. `@` file reference completion and resume-session pickers are deferred.

## Config

| Key | Default | Meaning |
|---|---|---|
| `sessionId` | `main` | Exact shared agent/session identity the front door creates and drives. |
| `welcome` | — | Banner subtitle row shown until the session has a logged title. |
| `showReasoning` | `true` | Render reasoning blocks. |
| `color` | `true` | Apply the built-in ANSI palette; `false` strips all styling. |
| `title` | `DeepSeek Harness` | Product suffix for the terminal window title. |

```yaml
- id: tui
  name: '@deepseek-ai/dsh-tui'
  config:
    sessionId: main
    welcome: 'Coding agent ready.'
    showReasoning: true
```

Startup fails loud before mounting when either process stream is not a TTY. Disposal stops the terminal, closes pending dialogs, disposes the owned agent handle, and never exits a replacement process during HMR.

## Human interaction

The registered `userQuestions` provider presents each model-facing question (including plan-mode reviews) as a single-select overlay; cancelling the dialog rejects the ask as `ASK_ABORTED`. The `approval/request` answerer answers for the front door's agent and every agent it owns (subagents), showing an Allow/Reject dialog, and delegates other agents' requests down the chain. Both share one FIFO dialog queue, so a question never interrupts a pending approval and vice versa.

## Commands

The front door registers `/help`, `/exit`, and `/clear` on `ctx.commands`, so they log their lifecycle like every other command and join `/help` dynamically. Unknown slash lines render a warning notice and never reach the model.

## Model Experience

### Interactive prompt input

#### What the model sees

Each non-empty editor submission becomes one ordinary user text message, sent with `agent.followup()` while the agent is idle and `agent.steer()` while it runs. Slash commands and keybindings are terminal-only; command results remain terminal notices and never enter the conversation.

#### Token effect

Submitted text is retained under the agent loop's normal session-history and compaction rules. Headers, the logged title, cards, Markdown rendering, status lines, and help text add no tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Single-select dialogs only** — multi-select `ask_user_question` options and custom text answers are not yet supported; a multi-select question behaves as single-select.
- **Resume is same-workspace only** — `--resume` loads the persisted session but the front door does not re-enter the session's recorded working directory; filesystem and shell tools resolve against the invoking directory.
- **No `@` completion or resume picker** — file-path references autocomplete and the interactive session selector are deferred; session ids must be typed in `--resume`.
- **Fixed JSONL persistence via the profile** — the front door reads whatever `ctx.agents.resume` is backed by; swapping the backend is a composition choice.
- **Sibling plugins can corrupt the screen** — the front door cannot prevent another entry from writing bytes to the stdout it owns.
