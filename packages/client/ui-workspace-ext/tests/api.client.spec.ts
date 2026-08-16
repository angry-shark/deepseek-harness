import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/client/api.ts'

const json = vi.fn(async (_value?: unknown): Promise<unknown> => undefined)

function mockFetch(): void {
  vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    return Promise.resolve({
      json: async () => json(method === 'POST' ? init?.body : undefined) as unknown,
    } as Response)
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  json.mockReset()
})

describe('workspace-ext api client', () => {
  it('builds the git GET requests with an encoded path', async () => {
    mockFetch()
    json.mockResolvedValue({ ok: true })
    await api.gitBranch('/a b')
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(call[0]).toBe('/api/workspace-ext/branch?path=%2Fa%20b')
    expect(call[1]?.headers).toEqual({ accept: 'application/json' })
    await api.gitBranches('/repo')
    expect(vi.mocked(fetch).mock.calls[1]![0]).toBe('/api/workspace-ext/branches?path=%2Frepo')
    await api.gitStatus('/repo')
    expect(vi.mocked(fetch).mock.calls[2]![0]).toBe('/api/workspace-ext/status?path=%2Frepo')
  })

  it('sends JSON POST bodies for checkout and terminal commands', async () => {
    mockFetch()
    json.mockResolvedValue({ ok: true })
    await api.gitCheckout('/repo', 'main')
    const call = vi.mocked(fetch).mock.calls[0]!
    expect(call[0]).toBe('/api/workspace-ext/checkout')
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ path: '/repo', branch: 'main' })

    await api.termSpawn('/repo')
    expect(vi.mocked(fetch).mock.calls[1]![0]).toBe('/api/workspace-ext/term/spawn')

    await api.termWrite('ls\n')
    expect(vi.mocked(fetch).mock.calls[2]![0]).toBe('/api/workspace-ext/term/write')

    await api.termKill()
    expect(vi.mocked(fetch).mock.calls[3]![0]).toBe('/api/workspace-ext/term/kill')
    expect(JSON.parse((vi.mocked(fetch).mock.calls[3]![1] as RequestInit).body as string)).toEqual({})
  })

  it('reads terminal poll and status as GETs', async () => {
    mockFetch()
    json.mockResolvedValue({ ok: true })
    await api.termPoll()
    await api.termStatus()
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/workspace-ext/term/poll')
    expect(vi.mocked(fetch).mock.calls[1]![0]).toBe('/api/workspace-ext/term/status')
  })

  it('propagates fetch failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await expect(api.gitBranch('/repo')).rejects.toThrow('network down')
  })
})
