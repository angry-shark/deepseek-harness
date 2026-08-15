# @deepseek-ai/dsh-client-ui-market

English | [中文](README.zh.md)

The plugin market sidebar surface. The browser plugin registers one localized `sidebar.footer.action` contribution with id `plugin-market` — a trigger row (icon and label in the wide column, icon-only in the rail) that opens a centered modal panel. The panel manages the configured git plugin sources (add/remove/refresh with per-source fetch state) and lists the catalog from `ctx.remote.pluginMarket.catalog()` through [`api-remotes`](../../api/remotes/README.md), with each plugin's source tag (curated/local/remote), install state, mount status, and failure message. Install writes the plugin into the persistent store and mounts it; uninstall is a two-click confirm. The panel refetches whenever the host emits `market/installed-change` or `market/sources-change` or the connection resets, via an injected revision hook.

The same plugin also loads installed Client halves onto the page: it reads `pluginMarket/installed`, fetches each mounted Client-half source with `pluginMarket/getClientCode`, and mounts it through the dynamic-package runner (closure evaluation, module-table factory, loader entry), so fiber effects own cleanup. Install is its own consent, so no separate approval step gates a Client half. Render or guard failures are logged to the console rather than steered to a session, because market plugins have no owning agent.

## Model Experience

None, as this package only presents Host-owned plugin state in the sidebar and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Client halves load on page load, not on demand** — every installed Client half is fetched and mounted when the page boots; a large store costs one startup round per plugin.
- **No plugin authoring UI** — the market installs from the built-in catalog or from plugin folders the user drops into the store; creating a plugin in the browser is not offered here.
