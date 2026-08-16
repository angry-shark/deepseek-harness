# Agent Note: The dedicated full-screen TUI front door

Status: implemented

English | [中文](2026-08-16-dsh-tui-front-door.zh.md)

## Problem

DeepSeek Harness shipped a full-screen terminal front door built on `@earendil-works/pi-tui` (`packages/ui/tui`), which the [TUI removal](../../archived/feature/2026-07-17-dedicated-full-screen-tui-front-door.md) deleted together with its `dsh` default-surface entrypoint. The package-renamed, interaction-split codebase that remained (interaction packages, core groups, the profile launcher) had no interactive terminal surface: `dsh --profile headless` answers one task and exits, ACP is automation-only, and the Web surface is a browser. A person at a terminal had no way to hold a live, resumable conversation.

## Decision

This change restores an interactive terminal front door as the `tui` profile of the `dsh` CLI itself, rather than reviving the removed implementation. The front door lives inside `apps/cli` (`src/tui`, exported as `@deepseek-ai/dsh/tui`) and the `dsh` package declares a `dsh.bundle` patch (`cordis.tui.yml`) that composes the `tui` profile over `dsh-base`. The old code targeted pre-rename APIs (`dsh-user-interaction`, `dsh-compact`, `dsh-session-projection-cache`, `agent.send`/`agent.steer` semantics) that no longer exist, and its 29k lines bundled features this codebase's current invariants would force redesigning; a fresh, focused front door over the current seams was the smaller and more maintainable foundation.

The front door is a Cordis plugin that owns terminal presentation and input only, following the headless-runner precedent for lifecycle: it injects `agents`, `agentDefaultModel`, `commands`, `sessions`, `sessionTitle`, `tools`, `userQuestions`, and `approval`, parses the launcher's inner arguments (owning `--resume <sessionId>` and the app's `--help`), creates its agent through `ctx.agents.create` (or resumes a persisted session through `ctx.agents.resume` with `--resume`), and drives the terminal from the durable `session/event` stream. It renders an append-origin transcript (assistant text and reasoning stream per step, tool cards paired through `callId` with `presentCall`/`presentResult` intents, the latest `todo/write` above the editor, the logged title as header and window title), submits editor input with `agent.followup()` while idle and `agent.steer()` while running, cancels with Esc/Ctrl+C, exits through `ctx.appExit`, and fails loud when either stream is not a TTY.

Human interaction runs through the existing seams: the front door registers the single `ctx.userQuestions` provider and an `approval/request` waterfall answerer (answering for its agent and every agent it owns, delegating the rest), both presented as single-select overlays behind one FIFO dialog queue. It registers `/help`, `/exit`, and `/clear` on `ctx.commands`, so command lifecycle stays logged and other commands (plan mode, compact, goal, feedback) join `/help` and autocomplete without new branches.

The front door lives in the CLI package instead of a separate package so the packed `dsh` tarball is self-contained: `npm install -g <dsh release .tgz URL>` resolves every remaining dependency (`@deepseek-ai/*` service packages, `@earendil-works/pi-tui`) from the npm registry, so one install command yields a working `dsh --profile tui` without publishing any new package. `PROFILE_TEMPLATES` and `INSTALLATION_OWNED_PROFILE_TUPLES` in `dsh-app-boot` gain `tui: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh']`, so the profile auto-initializes like `web` and `headless`, resolving the `dsh` package itself as the second bundle layer.

## Alternatives considered

- **Revive the removed `packages/ui/tui`** — rejected: it was written against removed APIs, its resume handoff and projection-cache machinery depend on services that no longer exist, and carrying its decisions forward would force re-deriving current invariants from 29k deleted lines.
- **Ship the front door as separate npm packages** — rejected: the packages' names were not on the registry and the fork cannot publish to the `@deepseek-ai` scope, so a URL install of the CLI would fail resolving them. Folding the front door into the CLI keeps the packed tarball self-contained.
- **Make the TUI plugin create the agent through config (`agent-loop.agents`)** — rejected because `--resume` must select a persisted identity; a runner that creates or resumes through `ctx.agents` keeps one code path and mirrors `dsh-headless`.

## Consequences

- A person at a terminal gets a full-screen, resumable conversation front door; non-TTY deployments still use `dsh --profile headless`.
- The front door adds `@earendil-works/pi-tui` to the `dsh` CLI's runtime dependencies (externalized, resolved from the npm registry).
- The TUI renders only what the durable log records and answers only through the interaction seams, so its model-visible and durable surface stays exactly what the log and services already guarantee.
- Multi-select questions, custom text answers, `@` file completion, a session picker, and workspace re-entry on resume remain deferred and are documented in the CLI README.
