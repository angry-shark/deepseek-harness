# dsh-desktop

English | [中文](README.zh.md)

The Tauri desktop shell for DeepSeek Harness: it spawns the built `dsh` CLI with the bundled Node binary, waits for the harness `dsh web:` readiness line on stdout, and hosts the served Web GUI in a native WebView window. Closing the window stops the server; a server that exits on its own reports its last output and quits the app ([Agent Note](../../.agents/notes/implemented/feature/2026-08-14-desktop-tauri-shell.md); the earlier Electron shell is [archived history](../../.agents/notes/archived/feature/2026-08-14-desktop-electron-shell.md)).

The package is `private: true` and never published to npm: `apps/*` is the npm release surface, while this app distributes installers instead.

## Layout

```
desktop/
  src-tauri/                the Rust shell (Tauri 2)
    src/main.rs             process lifecycle, window, navigation confinement
    src/server.rs           pure spawn/parse logic, unit-tested under cargo test
    tauri.conf.json         app and bundle configuration
    icons/                  generated from build/icon.png by `tauri icon`
  scripts/assemble-runtime.mjs
  scripts/fetch-node.mjs
  scripts/make-icon.mjs
  frontend-dist/            stub index.html; Tauri requires local frontend assets,
                            but the GUI is the remote page the harness serves
  build/                    gitignored: runtime closure, icon, node binary
```

## Prerequisites

- `pnpm install` and `pnpm run build`: the runtime closure is assembled from the workspace's built packages.
- A Rust toolchain (stable) for the `src-tauri` crate; configure a fast crates.io mirror when upstream is slow.
- `desktop:dev` runs the harness with `node` from PATH (`NODE_BIN` overrides), which must satisfy the harness engine floor (^22.19 || >=24). Packaged builds bundle their own Node binary.

## Run from a checkout

```sh
pnpm run desktop:dev
```

`desktop:dev` assembles the runtime closure, downloads the Node binary, and launches the shell in debug mode. The assembly rewrites `build/dsh-runtime` and `build/node` on every run, which re-triggers tauri-build's resource watching and recompiles the crate: expect a full rebuild per run.

## Build installers

```sh
pnpm run desktop:package
pnpm run desktop:package:mac
pnpm run desktop:package:win
pnpm run desktop:package:linux
```

`scripts/fetch-node.mjs` downloads the pinned Node binary (`NODE_VERSION` overrides, default `24.14.0`) from the npmmirror CDN (`NODE_MIRROR` overrides), verifies it against the mirror's `SHASUMS256.txt`, and checks the engine floor. `tauri icon` converts `build/icon.png` to the platform icon formats; the icon is a generated placeholder, so replace it before shipping. Build each platform on its own OS (or in CI): the runtime closure is assembled from the current platform's `node_modules`, including native modules (koffi, node-pty).

## How the runtime is assembled

`scripts/assemble-runtime.mjs` builds a self-contained `build/dsh-runtime` from the workspace's own installed dependency graph, so the installer never touches npm:

- `dsh/` holds the dsh package's `lib/`, `config/`, and `package.json`; the shell spawns `dsh/lib/bin.js`.
- The production closure (dependencies, optionalDependencies, and the peerDependencies the code imports at runtime — for example `cordis-plugin-group`, which `dsh-app-boot` imports as a peer) is copied into a hoisted `dsh/node_modules`, dereferencing every symlink so `link:`-overridden vendor packages (cosmokit, schemastery, the cordis plugin family) become real copies. A name resolving to a second real location nests under its requiring package, mirroring npm's conflict layout.
- The pi-ai provider SDKs (openai, @mistralai, @google, @aws-sdk, @anthropic-ai/sdk) and the shiki family are excluded: they are only ever imported through pi-ai's lazy provider subpaths or inlined in the browser bundle, and a configured non-DeepSeek provider gets a clear missing-dependency error.

A plain `pnpm deploy` cannot be used: this checkout's registry mirror is stale for versions the deploy re-resolves, and deploy's virtual-store layout leaves the link:-overridden packages as symlinks into this checkout.

The packaged app ships the closure and the Node binary as plain bundle resources (`Resources/dsh-runtime`, `Resources/node`): their native modules must load from disk, and the closure is used exactly as assembled. `--expose-internals` is passed explicitly, so the `node-addon-require-builtin` fallback that plain npm installs use is unnecessary.

## Server lifecycle

- The shell spawns `node --expose-internals dsh/lib/bin.js --profile web --port 0` with the user's home as working directory, so sessions start there. `--port 0` lets the OS pick a free port; `--expose-internals` is required by the harness's config-watch HMR service.
- The `dsh web:` stdout line is the readiness signal; the harness prints it only after its Loader tree settles.
- On quit the server gets SIGTERM, then SIGKILL after a 5-second grace period. On Windows there is no signal mechanism and termination is immediate. The app's exit handler force-kills any server still running, so a server never survives the shell.
- A single-instance lock focuses the running window on a second launch.

## Security posture

The renderer is a remote page served by the harness itself: the WebView has no node integration at all (system WebView engines), and navigation is confined to the harness origin — `on_navigation` denies other origins and `on_new_window` denies new windows, both opening in the system browser instead.

## Known limitations and deferred work

- Installers are unsigned and ship no auto-update mechanism.
- The unpacked macOS app is ~356 MB (the runtime closure is ~233 MB and the Node binary ~114 MB); the DMG installer compresses the payload. The Node binary is a full upstream build, so pruning it means shipping a custom build.
- The window title is the product name; no tray or background behavior exists — closing the window stops the server.
- Sending SIGTERM to the shell process itself (not its quit path) leaves the server child running, as the shell cannot clean up what it never saw terminate.
