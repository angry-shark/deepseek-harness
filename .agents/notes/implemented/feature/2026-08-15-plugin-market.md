# Agent Note: The plugin market — persistent user plugins from the sidebar

Status: implemented

English | [中文](2026-08-15-plugin-market.zh.md)

## Problem

Dynamic Cordis plugins created in a session are process-local: they vanish on restart, so a user who wants a plugin to persist has no supported path, and no browser surface exists for browsing, installing, or uninstalling persistent plugins. The sidebar foot already reserved a `sidebar.footer.action` slot that nothing occupied.

## Decision

Two packages add a plugin market to the Web client.

`@deepseek-ai/dsh-host-plugin-market` owns a persistent user plugin store at `$DSH_HOME/plugins/<id>/plugin.json` — `name`, `purpose`, and optional Host/Client halves in the `cordis_define` dialect — mounts every store plugin's Host half at boot and on install through the `cordis-host-runner` sandbox, and publishes ten `pluginMarket` Remotes: `catalog`, `installed`, `installPlugin`, `uninstall`, `getClientCode`, `invoke`, `sources`, `addSource`, `removeSource`, and `refreshSources`. Halves are authored in TypeScript (`src/host.ts` / `src/client.ts`) and compiled on demand with esbuild (type-only imports only, no value imports or exports); prebuilt `dist/*.js` bodies win when present. Configured git sources (deployment `sources` config plus user URLs persisted to `sources.json`) are cloned into a content-addressed cache and their `plugins/` layouts scanned into the catalog with a `remote` origin. The built-in curated catalog (`BUILTIN_CATALOG`) ships two demo plugins (`host-greeter`, `client-clock`); a plugin the user drops into the store is installed by presence. Every store change emits `market/installed-change`, and every source change emits `market/sources-change`; the api-remotes assembly forwards both verbatim.

`@deepseek-ai/dsh-client-ui-market` registers the `sidebar.footer.action` trigger (icon plus label in the wide column, icon-only in the rail) and a centered modal panel managing the configured git sources (add/remove/refresh with per-source state) and listing the catalog with install state, and loads installed Client halves onto the page through the `dynamicCordisRunner` service face. The runner face gained two standalone verbs — `loadStandalone` and `retractStandalone` — because install is its own consent and market plugins have no owning session: no approval step gates a Client half, and render/guard failures for halves no session owns are ignored by the host.

The `cordis-host-runner` package now exports its sandbox and lifecycle helpers (`createSandbox`, `evaluateHostCode`, `precheckCode`, `startHostHalf`, `isPlugin`, `normalizeHandler`) so the market mounts Host halves through the same guarded path the chat-created runner uses.

## Alternatives considered

### Why not have the market evaluate TypeScript directly in the sandbox?

The sandbox and browser closure evaluate plain-JS function bodies with no module resolution. Compiling TS to the same body shape with esbuild keeps one runtime and one dialect; value imports are rejected at compile time with a teaching error instead of failing at mount.

### Why not ship a spec page in `docs/` instead of a copyable template?

The spec's audience is a plugin-repo owner, so the standard and SOP live in the copyable [`plugin-repo` template](../../../../examples/plugin-repo/README.md); the market READMEs link it rather than restating it.

### Why not persist chat-created dynamic plugins instead of a separate store?

The dynamic runner's registry is session-scoped and approval-gated; a market needs a global, user-owned store. Keeping the two lifecycles separate preserves both contracts: chat plugins stay ephemeral, market plugins are files on disk re-mounted at every boot.

### Why not write installed plugins into the profile's `cordis.patch.yml`?

The patch file is a composition layer — patches target rows by id — and HMR-reloading the whole include on every install is heavy. A dedicated store directory keeps plugin code out of composition files and makes install/uninstall atomic (write or delete one directory).

### Why not import the dynamic runner's client engine directly?

The client bundle purity gate forbids cross-plugin value imports, and the runner is a service; the market collaborates through its face. Adding the two standalone verbs keeps the engine (closure evaluation, module-table factory, loader entries) in its single owner.

## Consequences

Installed plugins survive restarts by construction: the store is plain JSON on disk, re-read and re-mounted at boot, and works headless. The cost: catalog plugins carry no versions (a store copy diverges from a later catalog revision until reinstall), there is no enable/disable state (installed means mounted), and store manifests are JSON-only. The browser loads every installed Client half at page load rather than on demand, and Host halves log through the tagged sandbox console.

## Testing

Host unit specs cover catalog projection, install persistence, restart re-mount, uninstall, client-source serving, store-only plugins, mount-failure reporting, TS-half compilation (including value-import rejection), git-source fetching into the catalog, and source add/remove. Client component specs cover the trigger, panel states, source management, install/uninstall gestures, and error presentation. Live browser verification against a source-launched web profile exercised install of both demo plugins, the client-half clock row in Settings → General, host-half mount logs, restart persistence, and uninstall.
