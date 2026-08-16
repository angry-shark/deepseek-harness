import { describe, expect, it, vi } from 'vitest'
import type { MarketRootInjected } from '../src/client/MarketRoot.tsx'
import { apply } from '../src/client/index.ts'

interface RegisteredEntry {
  name: string
  id?: string
  inject?: () => MarketRootInjected
}

function bench() {
  const registered: RegisteredEntry[] = []
  const slots = {
    inject: vi.fn((_name: string, callback: () => unknown) => {
      const disposer = callback()
      if (typeof disposer === 'function') (disposer as () => void)()
    }),
    register: vi.fn((options: RegisteredEntry) => {
      registered.push(options)
      return () => {}
    }),
  }
  const locale = { register: vi.fn(), bind: vi.fn(() => (key: string) => key) }
  const runner = { getSnapshot: vi.fn(() => ({ rows: [], approvals: [] })), subscribe: vi.fn(() => () => {}) }
  const remoteListeners: Array<() => void> = []
  const remote = {
    pluginMarket: { installed: vi.fn(async () => ({ ok: true, value: { entries: [] } })) },
    dynamicCordisRunner: { inventory: vi.fn(async () => ({ ok: true, value: [] })) },
    $on: vi.fn((_event: string, fn: () => void) => {
      remoteListeners.push(fn)
      return () => {}
    }),
  }
  const ctx = {
    slots,
    locale,
    remote,
    get: (key: string) => (key === 'dynamicCordisRunner' ? runner : undefined),
    effect: (callback: () => unknown) => {
      const result = callback()
      return typeof result === 'function' ? result : () => {}
    },
    on: vi.fn(() => () => {}),
  }
  return { ctx, registered, remote, remoteListeners }
}

describe('ui-market apply', () => {
  it('registers the sidebar trigger and exposes the Cordis inventory face', async () => {
    const { ctx, registered, remote } = bench()
    ;(remote.dynamicCordisRunner.inventory as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: [
        { pluginId: 'wrke-1', packages: [{ name: '工作区增强' }], activeRun: { pluginRunId: 'r1' }, currentPackageId: 'pkg-1' },
        { pluginId: 'other-2', packages: [], activeRun: undefined },
      ],
    })
    apply(ctx as never)

    const entry = registered.find(entry => entry.id === 'plugin-market')
    expect(entry).toBeDefined()
    expect(entry?.name).toBe('sidebar.footer.action')

    const face = entry?.inject?.()
    expect(face).toBeDefined()
    const plugins = await face!.cordisPlugins()
    expect(plugins).toEqual([
      { pluginId: 'wrke-1', name: '工作区增强', running: true, currentPackageId: 'pkg-1' },
      { pluginId: 'other-2', name: 'other-2', running: false, currentPackageId: undefined },
    ])
    expect(remote.dynamicCordisRunner.inventory).toHaveBeenCalled()

    // A failed inventory read surfaces as a thrown error.
    ;(remote.dynamicCordisRunner.inventory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false, error: { code: 'boom', message: 'nope' },
    })
    await expect(face!.cordisPlugins()).rejects.toThrow('nope')
  })
})
