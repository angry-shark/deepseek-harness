/**
 * The curated catalog that ships with the market: small, real plugins that
 * demonstrate each half's lifecycle. Catalog definitions are plain async
 * function bodies in the same dialect `cordis_define` accepts — a Host half
 * evaluates in the `node:vm` sandbox, a Client half in the browser closure.
 */

import type { MarketPluginDefinition, MarketPluginId } from './types.ts'

/** Host-half demo: registers one `harness.handle` and logs its lifecycle. */
const HOST_GREETER_HOST = `
return {
  name: 'host-greeter',
  apply(ctx) {
    const stop = harness.handle('greeter.hello', async (args) => {
      const name = args !== null && typeof args === 'object' && typeof args.name === 'string' ? args.name : 'harness'
      return { greeting: 'Hello, ' + name + '!', at: new Date().toISOString() }
    })
    console.log('[host-greeter] mounted by the plugin market')
    ctx.effect(() => () => {
      console.log('[host-greeter] unmounted')
      stop()
    }, 'host-greeter: unload cleanup')
  },
}
`

/** Client-half demo: a live clock row in General settings. */
const CLIENT_CLOCK_CLIENT = `
const NS = 'market.clock'
return {
  name: 'client-clock',
  inject: ['slots', 'locale', 'timer'],
  apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, {
      zh: { title: '当前时间' },
      en: { title: 'Current time' },
    }), 'client-clock: dictionaries')
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: 'client-clock',
      order: 90,
      locale: NS,
    }, function ClockRow(props) {
      const [now, setNow] = React.useState(() => new Date())
      React.useEffect(() => {
        const stop = ctx.interval(() => setNow(new Date()), 1000)
        return stop
      }, [])
      return React.createElement('div', null, props.t('title') + ': ' + now.toLocaleTimeString())
    }))
  },
}
`

/** Brand one catalog id at the owning boundary. */
function marketId(id: string): MarketPluginId {
  return id as MarketPluginId
}

/** The plugins the market offers out of the box. */
export const BUILTIN_CATALOG: readonly MarketPluginDefinition[] = [
  {
    id: marketId('host-greeter'),
    name: '主机问候',
    purpose: 'Host 端示例：注册一个 greeter.hello 处理器，展示 Host half 的安装与持久挂载。',
    host: HOST_GREETER_HOST,
  },
  {
    id: marketId('client-clock'),
    name: '侧栏时钟',
    purpose: 'Client 端示例：在设置-通用中显示实时时钟，展示 Client half 的安装与页面加载。',
    client: CLIENT_CLOCK_CLIENT,
  },
]
