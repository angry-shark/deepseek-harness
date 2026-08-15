import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { BUILTIN_CATALOG, PluginMarketGateway, STORE_MANIFEST } from '../src/index.ts'

/** Host-half test plugin: registers one echo handler. */
const HOST_ECHO = `
return {
  name: 'test-echo',
  apply(ctx) {
    harness.handle('echo', async (args) => args)
    ctx.effect(() => () => {}, 'test-echo: cleanup')
  },
}
`

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A throwaway store root, cleaned up by the suite. */
function tempRoot(): string {
  const root = join('/tmp', `dsh-market-test-${Math.random().toString(16).slice(2)}`)
  roots.push(root)
  return root
}

async function harness(
  root: string,
  config: { sources?: string[] } = {},
): Promise<{ ctx: Context; market: PluginMarketGateway }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(PluginMarketGateway, { root, ...config })
  const market = ctx.get('pluginMarket') as PluginMarketGateway
  return { ctx, market }
}

/** Build a local git repo with one `plugins/<id>` plugin folder. */
function createGitSource(files: Record<string, string>): { url: string } {
  const dir = tempRoot()
  const pluginDir = join(dir, 'plugins', 'ts-hello')
  for (const [relative, content] of Object.entries(files)) {
    const path = join(pluginDir, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  }
  run(['init', '-q', '-b', 'main'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'test'])
  run(['add', '.'])
  run(['commit', '-qm', 'init'])
  return { url: `file://${dir}` }
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Wait until every installed entry has settled, or specific ids appear. */
async function settleInstalled(
  market: PluginMarketGateway,
  expectedIds?: string[],
): Promise<void> {
  await vi.waitFor(() => {
    const entries = market.installed().entries
    if (expectedIds !== undefined) {
      for (const id of expectedIds) {
        const entry = entries.find(candidate => candidate.id === id)
        expect(entry, `store entry ${id} loaded`).toBeDefined()
        expect(entry!.status, `store entry ${id} settled`).toBeDefined()
      }
      return
    }
    expect(entries.every(entry => entry.status !== undefined)).toBe(true)
  }, { timeout: 5000 })
}

describe('PluginMarketGateway', () => {
  it('publishes the catalog/install/uninstall verbs under the pluginMarket namespace', async () => {
    const root = tempRoot()
    const { market } = await harness(root)
    expect(market.typertRemote).toMatchObject({
      serviceKey: 'pluginMarket',
      namespace: 'pluginMarket',
    })
    expect(remoteMethods(market).map(method => method.method)).toEqual([
      'catalog', 'installed', 'installPlugin', 'uninstall', 'getClientCode', 'invoke',
      'sources', 'addSource', 'removeSource', 'refreshSources',
    ])
  })

  it('lists the built-in catalog as not installed on an empty store', async () => {
    const root = tempRoot()
    const { market } = await harness(root)
    const snapshot = market.catalog()
    expect(snapshot.entries.map(entry => entry.id)).toEqual(BUILTIN_CATALOG.map(definition => definition.id))
    expect(snapshot.entries.every(entry => !entry.installed)).toBe(true)
    expect(market.installed().entries).toEqual([])
  })

  it('installs a catalog plugin persistently and mounts its Host half', async () => {
    const root = tempRoot()
    const { market } = await harness(root)
    const id = BUILTIN_CATALOG[0]!.id
    const result = await market.installPlugin(id)
    expect(result.ok).toBe(true)
    expect(existsSync(join(root, id, STORE_MANIFEST))).toBe(true)
    expect(market.installed().entries).toEqual([
      expect.objectContaining({ id, hasHost: true, status: 'mounted', runId: result.runId }),
    ])
    const echoed = await market.invoke(id, result.runId!, 'greeter.hello', { name: 'world' })
    expect(echoed.ok).toBe(true)
    expect(echoed.value).toMatchObject({ greeting: 'Hello, world!' })
    expect(typeof (echoed.value as { at?: unknown }).at).toBe('string')
  })

  it('re-mounts installed plugins from the store on a fresh process', async () => {
    const root = tempRoot()
    const first = await harness(root)
    const id = BUILTIN_CATALOG[0]!.id
    expect((await first.market.installPlugin(id)).ok).toBe(true)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await harness(root)
    await settleInstalled(second.market)
    const entries = second.market.installed().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id, status: 'mounted' })
    expect(typeof entries[0]?.runId).toBe('string')
    const entry = entries[0]!
    const echoed = await second.market.invoke(id, entry.runId!, 'greeter.hello', null)
    expect(echoed.ok).toBe(true)
  })

  it('uninstalls: unmounts the Host half and deletes the store directory', async () => {
    const root = tempRoot()
    const { market } = await harness(root)
    const id = BUILTIN_CATALOG[0]!.id
    await market.installPlugin(id)
    expect(existsSync(join(root, id))).toBe(true)
    const result = await market.uninstall(id)
    expect(result.ok).toBe(true)
    expect(existsSync(join(root, id))).toBe(false)
    expect(market.installed().entries).toEqual([])
    const entry = market.catalog().entries.find(candidate => candidate.id === id)!
    expect(entry.installed).toBe(false)
  })

  it('serves Client-half source for an installed client plugin', async () => {
    const root = tempRoot()
    const { market } = await harness(root)
    const id = BUILTIN_CATALOG[1]!.id
    const result = await market.installPlugin(id)
    expect(result.ok).toBe(true)
    expect(market.installed().entries).toEqual([
      expect.objectContaining({ id, hasClient: true, status: 'mounted' }),
    ])
    const source = market.getClientCode(id, result.runId!)
    expect(source.name).toBe(BUILTIN_CATALOG[1]!.name)
    expect(source.code).toContain('client-clock')
  })

  it('surfaces a store-only user plugin alongside the catalog', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'user-plugin'), { recursive: true })
    writeFileSync(join(root, 'user-plugin', STORE_MANIFEST), JSON.stringify({
      name: 'User Plugin',
      purpose: 'A plugin the user dropped into the store.',
      host: HOST_ECHO,
    }))
    const { market } = await harness(root)
    await settleInstalled(market)
    const snapshot = market.catalog()
    const entry = snapshot.entries.find(candidate => candidate.id === 'user-plugin')
    expect(entry).toMatchObject({
      id: 'user-plugin',
      name: 'User Plugin',
      source: 'store',
      installed: true,
      status: 'mounted',
    })
  })

  it('reports a Host half that fails to mount', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'broken'), { recursive: true })
    writeFileSync(join(root, 'broken', STORE_MANIFEST), JSON.stringify({
      name: 'Broken',
      purpose: 'Host code that throws.',
      host: '\nthrow new Error("boom")\n',
    }))
    const { market } = await harness(root)
    await settleInstalled(market)
    const entry = market.installed().entries.find(candidate => candidate.id === 'broken')!
    expect(entry.status).toBe('failed')
    expect(entry.error).toContain('boom')
  })

  it('compiles a TypeScript Host half dropped into the store', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'ts-echo', 'src'), { recursive: true })
    writeFileSync(join(root, 'ts-echo', 'plugin.json'), JSON.stringify({
      name: 'TS Echo',
      purpose: 'A TS-authored host half.',
    }))
    writeFileSync(join(root, 'ts-echo', 'src', 'host.ts'), `
import type { Context } from '@deepseek-ai/cordis'
const tag: string = 'ts-echo'
return {
  name: 'ts-echo',
  apply(ctx: Context) {
    harness.handle('echo', async (args) => ({ tag, args }))
    ctx.effect(() => () => {}, 'ts-echo: cleanup')
  },
}
`)
    const { market } = await harness(root)
    await settleInstalled(market, ['ts-echo'])
    const entry = market.installed().entries.find(candidate => candidate.id === 'ts-echo')!
    expect(entry.status).toBe('mounted')
    const echoed = await market.invoke(entry.id, entry.runId!, 'echo', { n: 1 })
    expect(echoed).toMatchObject({ ok: true, value: { tag: 'ts-echo', args: { n: 1 } } })
  })

  it('rejects a TS half with value imports', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'ts-bad'), { recursive: true })
    writeFileSync(join(root, 'ts-bad', 'plugin.json'), JSON.stringify({
      name: 'TS Bad',
      purpose: 'A TS half that violates the import rule.',
    }))
    mkdirSync(join(root, 'ts-bad', 'src'), { recursive: true })
    writeFileSync(join(root, 'ts-bad', 'src', 'host.ts'), `
import { helper } from './helper'
return { apply() { helper() } }
`)
    const { market } = await harness(root)
    await settleInstalled(market, ['ts-bad'])
    const entry = market.installed().entries.find(candidate => candidate.id === 'ts-bad')!
    expect(entry.status).toBe('failed')
    expect(entry.error).toContain('value imports')
  })

  it('reports configured sources and fetches a git source into the catalog', async () => {
    const git = hasGit()
    if (!git) return
    const root = tempRoot()
    const source = createGitSource({
      'plugin.json': JSON.stringify({ name: 'TS Hello', purpose: 'A TS plugin from a git source.' }),
      'src/host.ts': `
return { name: 'ts-hello', apply(ctx) { ctx.effect(() => () => {}, 'ts-hello: cleanup') } }
`,
    })
    const { market } = await harness(root, { sources: [source.url] })
    await vi.waitFor(() => {
      const snapshot = market.sources()
      const row = snapshot.sources.find(candidate => candidate.url === source.url)
      expect(row?.ok).toBe(true)
    }, { timeout: 20000 })
    const row = market.sources().sources.find(candidate => candidate.url === source.url)!
    expect(row.pluginCount).toBe(1)
    const catalog = market.catalog()
    const entry = catalog.entries.find(candidate => candidate.id === 'ts-hello')!
    expect(entry).toMatchObject({ source: 'remote', installed: false })
    const result = await market.installPlugin(entry.id)
    expect(result.ok).toBe(true)
    expect(market.installed().entries.some(installed => installed.id === 'ts-hello')).toBe(true)
  })

  it('adds and removes a user-configured source through the Remote', async () => {
    const git = hasGit()
    if (!git) return
    const root = tempRoot()
    const source = createGitSource({
      'plugin.json': JSON.stringify({ name: 'TS Hello', purpose: 'A TS plugin from a git source.' }),
      'src/client.ts': 'return { name: \'ts-hello\', apply(ctx) {} }',
    })
    const { market } = await harness(root)
    const added = await market.addSource(source.url)
    expect(added.ok).toBe(true)
    await vi.waitFor(() => {
      expect(market.catalog().entries.some(entry => entry.id === 'ts-hello' && entry.source === 'remote')).toBe(true)
    }, { timeout: 20000 })
    const removed = market.removeSource(source.url)
    expect(removed.ok).toBe(true)
    expect(market.catalog().entries.some(entry => entry.id === 'ts-hello')).toBe(false)
  })
})
