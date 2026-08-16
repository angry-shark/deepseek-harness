# @deepseek-ai/dsh-client-ui-workspace-ext

English | [中文](README.zh.md)

Workspace enhancements: a git branch chip with an anchored branch switcher in
the composer tool row, and a right-side collapsible terminal sidebar running
bash in the current session's workspace directory.

The **git branch chip** fills `conversation.input.left` (the composer tool row,
beside the access-mode chrome). It reads the current session's workspace path
through the global `useWorkspaces` hook, resolves `.git/HEAD` through the node
half, and shows the branch name (or the short detached HEAD sha). Clicking the
chip opens an anchored menu listing every local branch (`git for-each-ref`);
clicking a branch runs `git checkout` and refreshes the chip, with the git
error surfaced in the menu when the working tree blocks the switch.

The **terminal sidebar** fills the frame-wide `shell.overlay` layer. Collapsed
it is a full-height rail on the right edge (like the left sidebar's rail);
clicking expands it into a 360px panel with start/terminate/clear/collapse
controls, an ANSI-stripped output area, and a command input row. The terminal
is one bash session per process spawned through `subprocess.spawnTerminal`
in the current workspace directory; output is polled incrementally while the
panel is open and the host keeps a bounded buffer while it is collapsed.

The node half registers same-origin routes under `/api/workspace-ext`
(`branch`, `branches`, `checkout`, `term/spawn|write|poll|kill|status`). The
surface can run git and start/feed a shell, so every handler refuses
non-loopback Host headers as a DNS-rebinding defense.

Both target slots are declared by other plugins (ui-conversation and
ui-layout), so `apply` uses `slots.inject()` to register for each declaration
lifetime and re-register after a declaring slot is restored.

## Model Experience

None, as these surfaces are browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One terminal per process** — the terminal session is process-scoped and
  not keyed per session; switching sessions keeps the original working
  directory until the terminal is respawned.
- **Plain-text terminal rendering** — output is ANSI-stripped and rendered as
  monospace text; full-screen interactive programs (editors, pagers) render
  degraded.
- **Git checkout is unguarded** — the switch is a direct `git checkout` of
  the workspace; there is no stash/conflict resolution affordance beyond
  surfacing git's error.
