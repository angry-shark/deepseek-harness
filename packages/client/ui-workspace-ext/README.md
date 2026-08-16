# @deepseek-ai/dsh-client-ui-workspace-ext

English | [中文](README.zh.md)

Workspace enhancements: a git branch chip with an anchored branch switcher in the composer tool row, and a right workspace column (terminal + Git source control tabs) running bash in the current session's workspace directory.

The **git branch chip** fills `conversation.input.left` (the composer tool row, beside the access-mode chrome). It reads the current session's workspace path through the global `useWorkspaces` hook, resolves `.git/HEAD` through the node half, and shows the branch name (or the short detached HEAD sha). Clicking the chip opens an anchored menu listing every local branch (`git for-each-ref`); clicking a branch runs `git checkout` and refreshes the chip, with the git error surfaced in the menu when the working tree blocks the switch. The chip matches the sibling permission selector's chrome: a 28px rounded pill with the branch SVG icon, the branch label, and a rotating chevron.

The **workspace panel** fills the `shell.right` layout column, between the details column and the frame's right edge. Like the sidebar, the column participates in the frame's concession chain — an open panel squeezes the center column instead of overlaying it. Collapsed it is a compact full-height edge rail carrying the two panel tabs stacked vertically; clicking a tab expands the column on that tab. Expanded it is a tabbed panel modeled on the VS Code panel: the panel header holds just the tabs and an icon collapse button (the sidebar's panel icon, mirrored for the right edge), and each tab's content carries its own action toolbar — clear / terminate / start for the terminal, refresh for Git. The **terminal tab** auto-connects: opening the panel spawns one session per process through `subprocess.spawnTerminal` in the current workspace directory, running the user's default shell (`process.env.SHELL`, zsh on macOS when unset). Its viewport mirrors the VS Code terminal — one dark scrollable surface renders the shell's own stream with ANSI colors and cursor redraws replayed (progress bars, wrapped echoes and colored prompts look right), clicking anywhere in the viewport focuses the command line, the command input is an invisible field below the shell's last prompt line (Enter sends), and the native caret is the only cursor; output is polled incrementally while the panel is open and the host keeps a bounded buffer while it is collapsed. The **Git workspace tab** is modeled on the VS Code source-control panel: a summary row with the branch icon, the branch name, a total-change pill and the ahead/behind counts, then the change rows grouped into staged / unstaged / untracked lists with per-status letter glyphs and change-count badges, plus a manual refresh button and a total-count badge on the Git tab.

The node half registers same-origin routes under `/api/workspace-ext` (`branch`, `branches`, `checkout`, `status`, `term/spawn|write|poll|kill|status`). The surface can run git and start/feed a shell, so every handler refuses non-loopback Host headers as a DNS-rebinding defense.

Both target slots are declared by other plugins (ui-conversation and ui-layout), so `apply` uses `slots.inject()` to register for each declaration lifetime and re-register after a declaring slot is restored.

## Model Experience

None, as these surfaces are browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One terminal per process** — the terminal session is process-scoped and not keyed per session; switching sessions keeps the original working directory until the terminal is respawned.
- **Plain-text terminal rendering** — output is ANSI-stripped and rendered as monospace text; full-screen interactive programs (editors, pagers) render degraded.
- **Git checkout is unguarded** — the switch is a direct `git checkout` of the workspace; there is no stash/conflict resolution affordance beyond surfacing git's error.
