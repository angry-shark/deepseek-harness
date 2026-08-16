// @vitest-environment jsdom
/**
 * MarketRoot component spec: trigger rail/wide rendering, panel fetch states,
 * install/uninstall gestures (two-click confirm), and error presentation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
// Type-only: pulls the 'market' LocaleNamespaceMap merge and the composed
// props' locale seat into this program, like the client entry does in the app.
import type {} from '../src/client/index.ts'
import { MarketRoot, type MarketRootProps } from '../src/client/MarketRoot.tsx'
import type {
  MarketCatalogSnapshot, MarketPluginId, MarketRunId, MarketSourcesSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** A bound `t` like the locale seat provides (interpolation included). */
const t: MarketRootProps['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

/** Catalog fixture: one installed host plugin and one installable client plugin. */
const SNAPSHOT: MarketCatalogSnapshot = {
  entries: [
    {
      id: 'host-greeter' as MarketPluginId,
      name: '主机问候',
      purpose: 'Host 端示例插件。',
      source: 'builtin',
      installed: true,
      status: 'mounted',
      runId: 'market-1' as MarketRunId,
    },
    {
      id: 'client-clock' as MarketPluginId,
      name: '侧栏时钟',
      purpose: 'Client 端示例插件。',
      source: 'builtin',
      installed: false,
    },
  ],
}

function props(overrides: Partial<MarketRootProps> = {}): MarketRootProps {
  const useRevision: MarketRootProps['useRevision'] = selector => selector(0)
  // Global standard kit stubs: MarketRoot consumes none of these hooks.
  const unusedHook = (() => { throw new Error('unused by MarketRoot') }) as never
  return {
    wide: true,
    t,
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    useRevision,
    list: vi.fn(async () => SNAPSHOT),
    install: vi.fn(async () => ({ ok: true })),
    uninstall: vi.fn(async () => ({ ok: true })),
    sources: vi.fn(async () => ({ sources: [] } satisfies MarketSourcesSnapshot)),
    addSource: vi.fn(async () => ({ ok: true })),
    removeSource: vi.fn(async () => ({ ok: true })),
    refreshSources: vi.fn(async () => ({ sources: [] } satisfies MarketSourcesSnapshot)),
    cordisPlugins: vi.fn(async () => []),
    ...overrides,
  }
}

describe('MarketRoot', () => {
  it('renders the trigger with the market label in the wide column', () => {
    const { getByRole } = render(<MarketRoot {...props()} />)
    const trigger = getByRole('button', { name: zh.trigger })
    expect(trigger.textContent).toContain(zh.trigger)
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the rail trigger icon-only', () => {
    const { getByRole } = render(<MarketRoot {...props({ wide: false })} />)
    const trigger = getByRole('button', { name: zh.trigger })
    expect(trigger.textContent).not.toContain(zh.trigger)
  })

  it('opens the panel and lists the catalog with install state', async () => {
    const { getByRole, findByText } = render(<MarketRoot {...props()} />)
    fireEvent.click(getByRole('button', { name: zh.trigger }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(await findByText('主机问候')).toBeTruthy()
    expect(screen.getByText(zh.statusMounted)).toBeTruthy()
    // The not-installed entry offers an Install button instead of a status tag.
    expect(screen.getByRole('button', { name: zh.install })).toBeTruthy()
  })

  it('installs a catalog plugin on the install button', async () => {
    const install = vi.fn(async () => ({ ok: true }))
    const { getByRole, findAllByRole } = render(<MarketRoot {...props({ install })} />)
    fireEvent.click(getByRole('button', { name: zh.trigger }))
    const buttons = await findAllByRole('button', { name: zh.install })
    fireEvent.click(buttons[0]!)
    await waitFor(() => { expect(install).toHaveBeenCalledWith('client-clock') })
  })

  it('uninstalls through a two-click confirm', async () => {
    const uninstall = vi.fn(async () => ({ ok: true }))
    const { getByRole, findAllByRole, findByText } = render(<MarketRoot {...props({ uninstall })} />)
    fireEvent.click(getByRole('button', { name: zh.trigger }))
    const buttons = await findAllByRole('button', { name: zh.uninstall })
    // First click arms the confirm; uninstall is not called yet.
    fireEvent.click(buttons[0]!)
    expect(uninstall).not.toHaveBeenCalled()
    const confirmingLabel = zh.uninstallConfirm.replace('{name}', '主机问候')
    expect(await findByText(confirmingLabel)).toBeTruthy()
    // Second click commits.
    const confirming = await findAllByRole('button', { name: confirmingLabel })
    fireEvent.click(confirming[0]!)
    await waitFor(() => { expect(uninstall).toHaveBeenCalledWith('host-greeter') })
  })

  it('surfaces an action failure in the panel', async () => {
    const install = vi.fn(async () => ({ ok: false, message: 'boom' }))
    const { getByRole, findAllByRole, findByText } = render(<MarketRoot {...props({ install })} />)
    fireEvent.click(getByRole('button', { name: zh.trigger }))
    const buttons = await findAllByRole('button', { name: zh.install })
    fireEvent.click(buttons[0]!)
    expect(await findByText(zh.actionError.replace('{message}', 'boom'))).toBeTruthy()
  })

  it('filters the catalog by query', async () => {
    const { getByRole, findByText } = render(<MarketRoot {...props()} />)
    fireEvent.click(getByRole('button', { name: zh.trigger }))
    await findByText('主机问候')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '时钟' } })
    expect(screen.queryByText('主机问候')).toBeNull()
    expect(screen.getByText('侧栏时钟')).toBeTruthy()
  })

  it('refetches when the revision hook moves', async () => {
    let revisionValue = 0
    const useRevision: MarketRootProps['useRevision'] = selector => selector(revisionValue)
    const list = vi.fn(async () => SNAPSHOT)
    const view = render(<MarketRoot {...props({ useRevision, list })} />)
    fireEvent.click(view.getByRole('button', { name: zh.trigger }))
    await screen.findByText('主机问候')
    expect(list).toHaveBeenCalledTimes(1)
    revisionValue += 1
    view.rerender(<MarketRoot {...props({ useRevision, list })} />)
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
  })

  it('closes on Escape', async () => {
    const { getByRole, queryByRole } = render(<MarketRoot {...props()} />)
    fireEvent.click(getByRole('button', { name: zh.trigger }))
    await screen.findByRole('dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(queryByRole('dialog')).toBeNull() })
  })

  it('carries the English dictionary on the locale seat', () => {
    const enT: MarketRootProps['t'] = (key, params) => {
      const template = (en as Record<string, string>)[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in params ? String(params[name]) : match)
    }
    const { getByRole } = render(<MarketRoot {...props({ t: enT })} />)
    expect(getByRole('button', { name: 'Plugin Market' })).toBeTruthy()
  })

  it('lists configured sources and adds a new one', async () => {
    const sources = vi.fn(async () => ({
      sources: [{ url: 'https://example.com/plugins.git', ok: true, pluginCount: 2 }],
    } satisfies MarketSourcesSnapshot))
    const addSource = vi.fn(async () => ({ ok: true }))
    const { getByRole, findByText } = render(<MarketRoot {...props({ sources, addSource })} />)
    fireEvent.click(getByRole('button', { name: zh.trigger }))
    await findByText('https://example.com/plugins.git')
    expect(await findByText(zh.sourceOk.replace('{count}', '2'))).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: zh.addSource }), {
      target: { value: 'https://example.com/new.git' },
    })
    fireEvent.click(screen.getByRole('button', { name: zh.addSource }))
    await waitFor(() => { expect(addSource).toHaveBeenCalledWith('https://example.com/new.git') })
  })

  it('removes a configured source', async () => {
    const sources = vi.fn(async () => ({
      sources: [{ url: 'https://example.com/plugins.git', ok: true, pluginCount: 1 }],
    } satisfies MarketSourcesSnapshot))
    const removeSource = vi.fn(async () => ({ ok: true }))
    const { getByRole, findByText } = render(<MarketRoot {...props({ sources, removeSource })} />)
    fireEvent.click(getByRole('button', { name: zh.trigger }))
    await findByText('https://example.com/plugins.git')
    fireEvent.click(screen.getByRole('button', { name: zh.removeSource }))
    await waitFor(() => { expect(removeSource).toHaveBeenCalledWith('https://example.com/plugins.git') })
  })
})

describe('MarketRoot cordis tab', () => {
  it('switches to the Cordis tab and lists the dynamic plugins', async () => {
    const { getByRole, findByText } = render(<MarketRoot {...props({
      cordisPlugins: vi.fn(async () => [
        { pluginId: 'wrke-1', name: '工作区增强', running: true, currentPackageId: 'pkg-1' },
        { pluginId: 'other-2', name: 'other-2', running: false },
      ]),
    })} />)
    fireEvent.click(getByRole('button', { name: zh.trigger }))
    fireEvent.click(await findByText(zh.tabCordis))
    expect(await findByText('工作区增强')).toBeTruthy()
    expect(await findByText('wrke-1')).toBeTruthy()
    expect(await findByText(zh.cordisRunning)).toBeTruthy()
    expect(await findByText(zh.cordisStopped)).toBeTruthy()
    // the market catalog stays hidden while the Cordis tab is active
    expect(screen.queryByText('主机问候')).toBeNull()
    // switching back restores the catalog
    fireEvent.click(screen.getByText(zh.tabMarket))
    expect(await screen.findByText('主机问候')).toBeTruthy()
  })

  it('renders the Cordis empty state', async () => {
    const { getByRole, findByText } = render(<MarketRoot {...props()} />)
    fireEvent.click(getByRole('button', { name: zh.trigger }))
    fireEvent.click(await findByText(zh.tabCordis))
    expect(await findByText(zh.cordisEmpty)).toBeTruthy()
  })

  it('renders the Cordis error state', async () => {
    const { getByRole, findByText } = render(<MarketRoot {...props({
      cordisPlugins: vi.fn(async () => { throw new Error('boom') }) as unknown as MarketRootProps['cordisPlugins'],
    })} />)
    fireEvent.click(getByRole('button', { name: zh.trigger }))
    fireEvent.click(await findByText(zh.tabCordis))
    expect(await findByText(zh.cordisError)).toBeTruthy()
  })

  it('renders the Cordis loading state while the read is pending', async () => {
    const { getByRole, findByText } = render(<MarketRoot {...props({
      cordisPlugins: vi.fn(() => new Promise(() => {})) as unknown as MarketRootProps['cordisPlugins'],
    })} />)
    fireEvent.click(getByRole('button', { name: zh.trigger }))
    fireEvent.click(await findByText(zh.tabCordis))
    expect(await findByText(zh.cordisLoading)).toBeTruthy()
  })
})
