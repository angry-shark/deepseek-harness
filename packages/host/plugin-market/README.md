# @deepseek-ai/dsh-host-plugin-market

English | [中文](README.zh.md)

Persistent plugin market: a user plugin store under the Harness home, a built-in curated catalog, configurable git plugin sources, and install/uninstall/status Remotes. `PluginMarketGateway` registers the `pluginMarket` service and publishes ten generated direct Remotes: `pluginMarket/catalog`, `pluginMarket/installed`, `pluginMarket/installPlugin`, `pluginMarket/uninstall`, `pluginMarket/getClientCode`, `pluginMarket/invoke`, `pluginMarket/sources`, `pluginMarket/addSource`, `pluginMarket/removeSource`, and `pluginMarket/refreshSources`.

Each installed plugin is a directory under the store root (default `$DSH_HOME/plugins`) holding `plugin.json`: `name`, `purpose`, and the optional Host/Client halves as async function bodies in the same dialect `cordis_define` accepts. Halves may also be authored in TypeScript under `src/host.ts` / `src/client.ts` — the market compiles them with esbuild (type-only imports only, no value imports or exports) — or shipped prebuilt as `dist/host.js` / `dist/client.js`. The service mounts every store plugin's Host half at boot and on install through the `cordis-host-runner` sandbox, so an installed plugin survives a restart by construction — the files are read again next boot. The Client half is served on demand (`getClientCode`) and mounted by the browser-side [`ui-market`](../../client/ui-market/README.md) package.

Configured git sources (deployment `sources` config plus user-added URLs persisted to `sources.json` under the store) are cloned into a content-addressed cache and their `plugins/` layouts scanned into the catalog with a `remote` origin; `refreshSources` re-fetches them, and `addSource`/`removeSource` manage the user list. Plugin authors start from the [`plugin-repo` template](../../../examples/plugin-repo/README.md).

The service is Remote-only and declares no same-process Cordis `Context` merge beyond the forwarded event. Client packages consume it through the explicit [`api-remotes`](../../api/remotes/README.md) assembly rather than importing the Host implementation. Its public payload types live under `./types`, and Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

## Model Experience

None, as this Host-only market service registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Catalog plugins carry no versions** — a built-in plugin's definition is fixed at the product build; a store copy diverges from a later catalog revision until the user reinstalls. A source refresh re-fetches the catalog but does not update already-installed store copies.
- **No enable/disable** — a plugin is either installed and mounted, or uninstalled. A mounted-but-idle state is not offered.
- **Store manifests are JSON only** — a plugin dropped into the store must use `plugin.json`; directory layouts with `package.json` or `cordis.yml` are not scanned.
