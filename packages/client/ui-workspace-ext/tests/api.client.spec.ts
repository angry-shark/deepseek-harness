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
    expect(JSON.parse((vi.mocked(fetch).mock.calls[1]![1] as RequestInit).body as string)).toEqual({ cwd: '/repo' })
    // Respawn passes the existing session id.
    await api.termSpawn('/repo', 'term-2')
    expect(JSON.parse((vi.mocked(fetch).mock.calls[2]![1] as RequestInit).body as string)).toEqual({ cwd: '/repo', session: 'term-2' })

    await api.termWrite('term-1', 'ls\n')
    expect(vi.mocked(fetch).mock.calls[3]![0]).toBe('/api/workspace-ext/term/write')
    expect(JSON.parse((vi.mocked(fetch).mock.calls[3]![1] as RequestInit).body as string)).toEqual({ session: 'term-1', text: 'ls\n' })

    await api.termResize('term-1', 96, 40)
    const resizeCall = vi.mocked(fetch).mock.calls[4]!
    expect(resizeCall[0]).toBe('/api/workspace-ext/term/resize')
    expect(JSON.parse((resizeCall[1] as RequestInit).body as string)).toEqual({ session: 'term-1', cols: 96, rows: 40 })

    await api.termKill('term-1')
    expect(vi.mocked(fetch).mock.calls[5]![0]).toBe('/api/workspace-ext/term/kill')
    expect(JSON.parse((vi.mocked(fetch).mock.calls[5]![1] as RequestInit).body as string)).toEqual({ session: 'term-1' })
  })

  it('reads terminal status and git diffs as GETs with encoded params', async () => {
    mockFetch()
    json.mockResolvedValue({ ok: true })
    await api.termStatus('term-1')
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('/api/workspace-ext/term/status?session=term-1')
    await api.gitDiff('/a b', 'src/x y.ts', false)
    expect(vi.mocked(fetch).mock.calls[1]![0]).toBe('/api/workspace-ext/diff?path=%2Fa%20b&file=src%2Fx%20y.ts&staged=0')
    await api.gitDiff('/repo', 'a.ts', true)
    expect(vi.mocked(fetch).mock.calls[2]![0]).toBe('/api/workspace-ext/diff?path=%2Frepo&file=a.ts&staged=1')
  })

  it('sends git action POSTs with per-action options', async () => {
    mockFetch()
    json.mockResolvedValue({ ok: true })
    await api.gitAction('/repo', 'stage', { files: ['a.ts'] })
    let call = vi.mocked(fetch).mock.calls[0]!
    expect(call[0]).toBe('/api/workspace-ext/git/action')
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ path: '/repo', action: 'stage', files: ['a.ts'] })

    await api.gitAction('/repo', 'commit', { message: 'fix', all: true })
    call = vi.mocked(fetch).mock.calls[1]!
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ path: '/repo', action: 'commit', message: 'fix', all: true })

    await api.gitAction('/repo', 'discard', { files: ['b.ts'], staged: true })
    call = vi.mocked(fetch).mock.calls[2]!
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ path: '/repo', action: 'discard', files: ['b.ts'], staged: true })

    // Defaults to an empty options object.
    await api.gitAction('/repo', 'unstage')
    call = vi.mocked(fetch).mock.calls[3]!
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ path: '/repo', action: 'unstage' })
  })

  it('propagates fetch failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    await expect(api.gitBranch('/repo')).rejects.toThrow('network down')
  })
})
