# Agent Note: Workspace enhancements (git branch chip + tabbed workspace panel) and the merged plugin-market Cordis tab

Status: implemented

English | [中文](2026-08-16-workspace-ext-git-branch-terminal.zh.md)

## Problem

The GUI offered no per-workspace git or terminal affordances: the composer row showed the access-mode chrome but no current branch, and there was no in-app terminal for the workspace directory. Separately, dynamic Cordis plugin management lived behind its own sidebar-foot entry (`cordis-panel` from ui-cordis), while the plugin market dialog (ui-market) browsed permanent plugins — two entries for two plugin concerns. A custom (non-DeepSeek) OpenAI-compatible provider also failed to load because the desktop runtime excluded the `openai` SDK.

## Decision

A new client plugin package `@deepseek-ai/dsh-client-ui-workspace-ext` ships both workspace surfaces:

- **Git branch chip** (`conversation.input.left`, composer tool row beside the access-mode chrome): resolves the current session's workspace path through the global `useWorkspaces` hook, reads `.git/HEAD` through the node half, and shows the branch (or the short detached HEAD sha). Clicking opens an anchored menu of local branches (`git for-each-ref`); choosing one runs `git checkout` and refreshes the chip, with git's error surfaced in the menu when the working tree blocks the switch.
- **Tabbed workspace panel** (`shell.overlay#workspace-panel`, modeled on the VS Code bottom panel): a full-height rail on the right edge (reading `终端 · Git`) that expands into a 360px panel with two tabs. The **终端 tab** auto-connects — opening the panel spawns one bash session per process via `subprocess.spawnTerminal` in the workspace directory when none is running and a workspace path exists — with start/terminate/clear controls, an ANSI-stripped output area, and a command input row; output is polled incrementally while open and the host keeps a bounded 64KiB buffer while collapsed. The **Git 工作区 tab** renders `git status --porcelain=v1 --branch` (branch name, ahead/behind counts, and per-change staged/unstaged status labels) with a refresh button. Collapse and expand animate through a width + fade transition: the content stays mounted for the 180ms width transition and unmounts at settle, so the rail label swaps in without a jump.

The node half registers same-origin routes under `/api/workspace-ext` (`branch`, `branches`, `checkout`, `status`, `term/spawn|write|poll|kill|status`). `parseGitStatus` decodes the `##` header (branch, detached HEAD, unborn branch, upstream delta) and the two-column porcelain code rows. Because the surface can run git and start/feed a shell, every handler refuses non-loopback Host headers as a DNS-rebinding defense.

The plugin market dialog (ui-market) gains a **Cordis 插件 tab** next to the market tab: a summary list of the session's dynamic Cordis plugins read through the already-injected `dynamicCordisRunner` Remote (name, plugin id, running state). ui-cordis's separate sidebar-foot entry now renders nothing — the sidebar keeps one plugin entry, and dynamic plugin browsing lives inside the market dialog. The Cordis run cards and approvals in the conversation flow are unchanged. The market trigger is a plain row in the sidebar foot; its styling matches the Settings trigger that sits directly below it (34px row / 36px rail circle, 12px radius, hover fill, label + glyph).

The desktop runtime keeps the OpenAI-compatible path working: `desktop/scripts/assemble-runtime.mjs` excludes the other pi-ai provider SDKs (`@mistralai/mistralai`, `@google/genai`, `@aws-sdk`, `@anthropic-ai/sdk`) so those providers fail loudly with a missing-dependency error, but `openai` stays in the closure — it is self-contained (~13 MB, zero runtime dependencies) and its completions path is the commonest custom-provider route.

## Alternatives considered

**A floating terminal panel instead of a sidebar** — rejected. The user asked for a right bar that behaves like the left sidebar (full-height, collapsible to a rail); the `shell.overlay` implementation mirrors that shape.

**Cross-package import of ui-cordis's CordisPanel into ui-market** — rejected. Package boundaries forbid importing another plugin's symbols; the Cordis tab renders its own summary read from the shared Remote instead of reusing the panel component.

**A child-slot seam for the full Cordis management panel inside the market dialog** — deferred. It preserves the stop/remove/approve panel actions at the cost of a new slot contract and ui-cordis retargeting; the summary tab covers browsing and the run cards cover approvals, so the merge shipped without it.

**Keeping all five pi-ai provider SDKs in the desktop closure** — rejected. Mistral, GenAI, Bedrock, and Anthropic together add ~50 MB of dead weight on every cold start for providers most installs never configure; each keeps its targeted missing-dependency error instead.

## Consequences

The workspace panel, the market trigger alignment, and the openai closure fix ship together in `@deepseek-ai/dsh-client-ui-workspace-ext` (client bundle) and `desktop/scripts/assemble-runtime.mjs` (runtime closure). The panel's `status` route and `parseGitStatus` are new node-half surface; the terminal auto-connect changes the panel's behavior from explicit start to start-on-open, so a session with a workspace path spawns bash as soon as the panel expands. The `openai` closure change grows the desktop runtime by ~13 MB and makes OpenAI-compatible providers resolvable; the other four provider SDKs still require their own missing-dependency error paths if configured. The profile-installed copy (`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-workspace-ext`, v0.5.3) carries the same client behavior for the running app; its node half needs an app restart to pick up the new route.
