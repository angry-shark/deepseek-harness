/**
 * Client half of the `hello` plugin, authored in TypeScript as an async
 * function body. The browser closure evaluates the compiled body with `React`
 * and the guarded `ctx` as symbols; `styles` and `host` are also available,
 * while browser globals (fetch, timers) are withheld — use `ctx.interval`
 * after declaring `timer`, or route work to the Host half via `harness.handle`
 * + `host.call`.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

const NS = 'hello.settings'

return {
  name: 'hello-client',
  inject: ['slots', 'locale'],
  apply(ctx: ClientContext) {
    ctx.effect(() => ctx.locale.register(NS, {
      zh: { title: 'Hello 插件' },
      en: { title: 'Hello plugin' },
    }), 'hello: dictionaries')
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: 'hello',
      order: 80,
      locale: NS,
    }, function HelloRow(props: { t: (key: string) => string }) {
      return React.createElement('div', null, props.t('title'))
    }))
  },
}
