/**
 * Plugin market surface, browser half: the sidebar-foot trigger, the market
 * panel, and the loader that keeps this page's installed Client halves
 * converged with the host store. Install is its own user consent, so Client
 * halves load without a separate approval step.
 */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the sidebar's SlotMap merge ('sidebar.footer.action').
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { MarketRoot, type MarketRootInjected } from './MarketRoot.tsx'
import { MarketClientRunner } from './market-runner.ts'
import { en, zh, type MarketLocaleKey } from './locales.ts'

export type { MarketRootInjected, MarketRootProps } from './MarketRoot.tsx'
export type { MarketLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin market trigger, panel chrome, and catalog copy. */
    market: MarketLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'market'

/**
 * Required services (cordis fiber inject). The `dynamicCordisRunner` seat
 * parks this plugin until the runner service exists, so the Client-half loader
 * never races cordis-client-runner at boot; `remote.pluginMarket` and the
 * `remote.dynamicCordisRunner` namespace park it until the host market and
 * runner services exist.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginMarket', 'remote.dynamicCordisRunner', 'dynamicCordisRunner']

/**
 * Mount the market surface and the installed Client-half loader.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-market: dictionaries')
  const t = ctx.locale.bind(NS)

  const runner = new MarketClientRunner(ctx)
  ctx.effect(() => () => { runner.dispose() }, 'ui-market: client-half runner')

  // Keep the page converged with the installed store: initial load, host
  // store changes, and reconnects all re-read the snapshot.
  const refreshClientHalves = (): void => {
    void ctx.remote.pluginMarket.installed().then(async (answered) => {
      if (answered.ok) await runner.sync(answered.value.entries)
    }).catch((error: unknown) => {
      console.error('[ui-market] loading installed client halves failed:', error)
    })
  }
  refreshClientHalves()
  ctx.effect(
    () => ctx.remote.$on('market/installed-change', () => { refreshClientHalves() }),
    'ui-market: store change refresh',
  )
  ctx.effect(
    () => ctx.on('connection/reset', () => { refreshClientHalves() }),
    'ui-market: reconnect refresh',
  )

  // Panel refresh ticks: the same two sources bump a revision the panel's
  // framework hook subscribes to.
  let revision = 0
  const listeners = new Set<() => void>()
  const bump = (): void => {
    revision += 1
    for (const listener of [...listeners]) listener()
  }
  ctx.effect(
    () => ctx.remote.$on('market/installed-change', () => { bump() }),
    'ui-market: revision events',
  )
  ctx.effect(
    () => ctx.remote.$on('market/sources-change', () => { bump() }),
    'ui-market: sources revision events',
  )
  ctx.effect(
    () => ctx.on('connection/reset', () => { bump() }),
    'ui-market: reconnect revision',
  )
  const revisionSource = {
    getSnapshot: () => revision,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  const injected = (): MarketRootInjected => ({
    hooks: { revision: revisionSource },
    list: async () => {
      const answered = await ctx.remote.pluginMarket.catalog()
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    install: async (id) => {
      const answered = await ctx.remote.pluginMarket.installPlugin(id)
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    uninstall: async (id) => {
      const answered = await ctx.remote.pluginMarket.uninstall(id)
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    sources: async () => {
      const answered = await ctx.remote.pluginMarket.sources()
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    addSource: async (url) => {
      const answered = await ctx.remote.pluginMarket.addSource(url)
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    removeSource: async (url) => {
      const answered = await ctx.remote.pluginMarket.removeSource(url)
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    refreshSources: async () => {
      const answered = await ctx.remote.pluginMarket.refreshSources()
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    cordisPlugins: async () => {
      const answered = await ctx.remote.dynamicCordisRunner.inventory()
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value.map(row => ({
        pluginId: String(row.pluginId),
        name: row.packages[0]?.name ?? row.pluginId,
        running: row.activeRun !== undefined,
        ...(row.currentPackageId === undefined ? {} : { currentPackageId: String(row.currentPackageId) }),
      }))
    },
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'plugin-market',
    order: 0,
    label: () => t('trigger'),
    locale: NS,
    inject: injected,
  }, MarketRoot))
}
