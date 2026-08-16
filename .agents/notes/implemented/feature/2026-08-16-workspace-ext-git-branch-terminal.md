# Agent Note: Workspace enhancements (git branch chip + terminal sidebar) and the merged plugin-market Cordis tab

Status: implemented

English | [中文](2026-08-16-workspace-ext-git-branch-terminal.zh.md)

## Problem

The GUI offered no per-workspace git or terminal affordances: the composer row showed the access-mode chrome but no current branch, and there was no in-app terminal for the workspace directory. Separately, dynamic Cordis plugin management lived behind its own sidebar-foot entry (`cordis-panel` from ui-cordis), while the plugin market dialog (ui-market) browsed permanent plugins — two entries for two plugin concerns.

## Decision

A new client plugin package `@deepseek-ai/dsh-client-ui-workspace-ext` ships both workspace surfaces:

- **Git branch chip** (`conversation.input.left`, composer tool row beside the access-mode chrome): resolves the current session's workspace path through the global `useWorkspaces` hook, reads `.git/HEAD` through the node half, and shows the branch (or the short detached HEAD sha). Clicking opens an anchored menu of local branches (`git for-each-ref`); choosing one runs `git checkout` and refreshes the chip, with git's error surfaced in the menu when the working tree blocks the switch.
- **Terminal sidebar** (`shell.overlay`): a full-height rail on the right edge that expands into a 360px panel running one bash session per process via `subprocess.spawnTerminal` in the workspace directory, with start/terminate/clear/collapse controls, an ANSI-stripped output area, and a command input row. Output is polled incrementally while open; the host keeps a bounded 64KiB buffer while collapsed.

The node half registers same-origin routes under `/api/workspace-ext` (`branch`, `branches`, `checkout`, `term/spawn|write|poll|kill|status`). Because the surface can run git and start/feed a shell, every handler refuses non-loopback Host headers as a DNS-rebinding defense.

The plugin market dialog (ui-market) gains a **Cordis 插件 tab** next to the market tab: a summary list of the session's dynamic Cordis plugins read through the already-injected `dynamicCordisRunner` Remote (name, plugin id, running state). ui-cordis's separate sidebar-foot entry now renders nothing — the sidebar keeps one plugin entry, and dynamic plugin browsing lives inside the market dialog. The Cordis run cards and approvals in the conversation flow are unchanged.

## Alternatives considered

**A floating terminal panel instead of a sidebar** — rejected. The user asked for a right bar that behaves like the left sidebar (full-height, collapsible to a rail); the `shell.overlay` implementation mirrors that shape.

**Cross-package import of ui-cordis's CordisPanel into ui-market** — rejected. Package boundaries forbid importing another plugin's symbols; the Cordis tab renders its own summary read from the shared Remote instead of reusing the panel component.

**A child-slot seam for the full Cordis management panel inside the market dialog** — deferred. It preserves the stop/remove/approve panel actions at the cost of a new slot contract and ui-cordis retargeting; the summary tab covers browsing and the run cards cover approvals, so the merge shipped without it.
