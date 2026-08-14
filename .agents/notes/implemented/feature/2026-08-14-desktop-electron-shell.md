# Agent Note: The desktop Electron shell

Status: implemented

English | [中文](2026-08-14-desktop-electron-shell.zh.md)

## Problem

The Web GUI is served by `dsh web`, which a person must start in a terminal and open in a browser. There is no way to hand someone a distributable application for macOS, Windows, or Linux: the product ships as an npm CLI. Wrapping the GUI in a native desktop app requires deciding where the shell lives (a top-level `desktop/` package, because `apps/*` is the npm release surface and a release member cannot be `private`), how the server runs inside it, and how the packaged app carries the entire dsh runtime without touching npm or this checkout.

## Decision

A new top-level workspace package `desktop/` (`@deepseek-ai/dsh-desktop`, `private: true`) is an Electron shell. Its main process spawns the built `dsh` CLI as a child of the Electron binary running as Node (`ELECTRON_RUN_AS_NODE=1`) with `--expose-internals --profile web --port 0`, treats the `dsh web:` stdout line (printed only after the Loader tree settles) as the readiness signal, and hosts the served GUI in a sandboxed `BrowserWindow` (`contextIsolation`, no node integration, `sandbox: true`; navigations and `window.open` away from the harness origin open in the system browser). Closing the window stops the server (SIGTERM, SIGKILL after 5 seconds); an unexpected server exit shows its stderr tail in a dialog and quits. A single-instance lock focuses the existing window on a second launch; the child's working directory is the user's home.

`--expose-internals` is required by the harness's config-watch HMR service. Plain Node installs satisfy it through the `node-addon-require-builtin` fallback, but that addon cannot read Electron's Node internals, so the shell passes the flag explicitly.

### The runtime closure

`scripts/assemble-runtime.mjs` builds a self-contained `build/dsh-runtime` from the workspace's own installed dependency graph: `dsh/` holds the dsh package's `lib/`, `config/`, and `package.json`, and the production closure — dependencies, optionalDependencies, and the peerDependencies the code imports at runtime (for example `cordis-plugin-group`, which `dsh-app-boot` imports as a peer that no package declares as a dependency) — is copied into a hoisted `dsh/node_modules`, dereferencing every symlink so `link:`-overridden vendor packages become real copies. A name that resolves to a second real location nests under its requiring package, mirroring npm's conflict layout.

A plain `pnpm deploy` was rejected: this checkout's registry mirror is stale for versions the deploy re-resolves (the lockfile's own `@tsdown/css@0.22.2` fetched fine, but the deploy's fresh resolution asked for a newer version the mirror lacks), and the deploy's virtual-store layout leaves the link:-overridden packages as symlinks into this checkout, so the result is not self-contained. The closure nests under `dsh/` because electron-builder's `extraResources` copy deliberately drops a ROOT-level `node_modules` directory (it exists to prevent double-packaging an app's own dependencies). The packaged app ships the runtime unpacked under `Contents/Resources/dsh-runtime` with `npmRebuild` disabled: its native modules (koffi, node-pty, node-addon-require-builtin) must load from disk, not from an asar.

### The pnpm strictDepBuilds repair

pnpm 11 treats packages with lifecycle scripts that are absent from `allowBuilds` as strict errors and auto-writes `"set this to true or false"` placeholders into `pnpm-workspace.yaml`, which made every `pnpm run` fail. The nine affected packages were given explicit `false` entries, matching the existing deny-by-default pattern.

## Alternatives considered

- **`apps/desktop` placement.** `apps/*` is the npm release surface: every `apps/*/package.json` is a dsh-family release member that must be public, version-bumped, and published with the family. A desktop installer belongs to no registry, so the shell lives in a top-level `desktop/` workspace member instead, `private: true`, outside every release pattern.
- **Tauri.** The Rust shell plus system WebViews would ship a much smaller installer, but introduces a Rust toolchain to a JavaScript workspace and three divergent WebView engines for a complex SPA (SSE, uploads, large lists). Electron reuses the repo's language and one Chromium.
- **`pnpm deploy` for the runtime closure.** Rejected in practice: the checkout's registry mirror is stale for versions the deploy re-resolves, and the deploy's virtual-store layout leaves the `link:`-overridden vendor packages as symlinks pointing back into this checkout, so the result is not self-contained. The assemble script instead copies the workspace's own installed dependency graph, dereferencing symlinks into a flat hoisted closure.
- **A separate bundled Node binary.** Shipping a second Node runtime doubles the payload; running the Electron binary itself with `ELECTRON_RUN_AS_NODE=1` reuses the already-shipped runtime. The bundled Node's version floor is checked at startup.
- **Running the harness in the main process.** A child process isolates server crashes from the shell, owns its own lifecycle and working directory, and can be terminated with SIGTERM/SIGKILL; in-process embedding would couple two lifecycles without reducing the packaged size.
- **`node_modules` at the runtime root.** electron-builder's `extraResources` copy deliberately drops a root-level `node_modules` directory, so the closure nests one level down under `dsh/`.

## Consequences

The shell costs the repo a ~190 MB macOS installer (the closure includes the pi-ai optional provider SDKs — openai, @mistralai, @google, @aws-sdk — that pruning would break), unsigned builds with no auto-update, and a Windows shutdown that cannot do graceful SIGTERM teardown. It buys a one-command product distribution path: `pnpm run desktop:package:<platform>` produces native installers whose runtime never touches npm or this checkout, giving macOS, Windows, and Linux users the full Web GUI with no terminal and no browser setup.

## Verification

- Unit tests (`desktop/tests/server.spec.ts`) cover URL-line parsing, the spawn invocation, the Node-engine check, and both runtime-root resolutions (dev and packaged layouts).
- The assembled runtime boots standalone: `dsh web` prints its URL, serves the SPA (HTTP 200), and exits cleanly on SIGTERM, using only the closure.
- The packaged macOS app boots the same way from `Contents/Resources/dsh-runtime`; `pnpm run desktop:package:mac` produces the dmg and zip installers. Windows and Linux installers require builds on those platforms (or CI).
