# `@deepseek-ai/dsh-tui-app`

English | [中文](README.zh.md)

The dsh interactive-terminal bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md): it sets the coding persona, keeps the shared tool and interaction rows, and inserts this bundle's `tui` row — the [`@deepseek-ai/dsh-tui`](../../ui/tui/README.md) front door. It mounts no Host, HTTP server, Web runtime, or browser plugin. The front door creates (or, with `--resume <id>`, resumes) its own agent through the core registry and owns the terminal screen until the user exits.

`dsh --profile tui` auto-initializes this bundle from the shipped profile template; the front door reads the launcher's inner arguments, so `dsh --profile tui --resume <id>` resumes a persisted session and `dsh --profile tui --help` prints the terminal app's help.

## Composition

| Plugin | Role |
|---|---|
| `@deepseek-ai/dsh-tui` | The full-screen front door: transcript, editor, questions/approval dialogs, slash commands. |
| `dsh-base` rows | Shared core: model adapters, tools, persistence, sandbox and approval policy, settings, credentials, telemetry. |

## Config

| Key | Default | Routed to |
|---|---|---|
| `sessionId` | `main` | The fresh session identity the front door creates. |
| `welcome` | `Coding agent ready.` | Banner subtitle shown until the session has a logged title. |
| `showReasoning` | `true` | Whether reasoning blocks render. |

The shipped `cordis.patch.yml` overrides only the surface-owned persona; every other value the base bundle owns stays neutral for this mode.

## Model Experience

### Interactive prompt input

#### What the model sees

The bundle adds no model-bound content itself; the front door's ordinary user-text submissions are the conversation. The persona — a paragraph interpolating `{{model}}` and `{{cwd}}` — is the only text this bundle contributes to the request prefix.

#### Token effect

The persona paragraph is part of the system prompt once per session.

#### KV Cache effect

The persona is stable for the life of the process, so it does not invalidate the cache across turns.

## Known Limitations and Deferred Work

- **A TTY is required** — non-interactive deployments use `dsh --profile headless`; this profile fails loud when either stream is a pipe.
- **One agent owns the screen** — the composition creates a single agent; concurrent interactive sessions are other processes.
