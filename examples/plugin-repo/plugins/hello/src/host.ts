/**
 * Host half of the `hello` plugin, authored in TypeScript as an async function
 * body: the market strips types and `import type` with esbuild, then evaluates
 * the result inside the cordis sandbox, where `ctx` and `harness` are the
 * available symbols. No value imports, no exports — write the body as if it
 * were inside `return (async () => { … })()`.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'

const tag: string = 'hello'

return {
  name: 'hello',
  apply(ctx: Context) {
    const stop = harness.handle('hello.greet', async (args: JsonValue) => {
      const name = args !== null && typeof args === 'object' && typeof args.name === 'string'
        ? args.name
        : 'harness'
      return { tag, greeting: `Hello, ${name}!`, at: new Date().toISOString() }
    })
    ctx.effect(() => () => { stop() }, 'hello: unload cleanup')
  },
}
