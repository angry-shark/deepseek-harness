import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { apply, inject, name, parseGitStatus, type GitStatus } from '../src/index.ts'

function makeRes(): ServerResponse {
  const res = { status: 0, body: '' } as unknown as ServerResponse
  res.writeHead = vi.fn((code: number) => { (res as unknown as { status: number }).status = code }) as never
  res.end = vi.fn((body?: unknown) => { (res as unknown as { body: string }).body = typeof body === 'string' ? body : '' }) as never
  return res
}

function makeReq(method: string, url: string, host = '127.0.0.1:52351', body?: Record<string, unknown>): IncomingMessage {
  const req = { method, url, headers: { host } } as IncomingMessage
  req.on = ((event: string, fn: (...args: unknown[]) => void) => {
    if (event === 'data' && body !== undefined) queueMicrotask(() => { fn(Buffer.from(JSON.stringify(body))) })
    if (event === 'end') queueMicrotask(fn)
    if (event === 'error' && body === undefined) { /* never fires */ }
    return req
  }) as never
  return req
}

interface Route { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }

function bench(): { ctx: Context; routes: Route[]; disposers: (() => void)[] } {
  const routes: Route[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    webServer: { register: (route: Route) => { routes.push(route); return () => {} } },
    effect: (callback: () => unknown) => {
      const result = callback()
      if (typeof result === 'function') disposers.push(result as () => void)
      return () => {}
    },
    get: (key: string) => (ctx as unknown as Record<string, unknown>)[`svc:${key}`],
  } as unknown as Context
  ;(ctx as unknown as Record<string, unknown>)['svc:webServer'] = ctx.webServer
  apply(ctx)
  return { ctx, routes, disposers }
}

/** Build a fake subprocess with a plan of git results and a terminal handle. */
function fakeSubprocess(gitResults: Array<{ exitCode: number | null; out?: string; err?: string }>): SubprocessRuntime {
  let spawnCount = 0
  let terminal: FakeTerminal | undefined
  const subprocess = {
    resolveExecutable: vi.fn(async (cmd: string) => (cmd === 'git' ? '/usr/bin/git' : cmd)),
    spawn: vi.fn((spec: { argv: string[] }) => {
      void spec
      const plan = gitResults[spawnCount] ?? { exitCode: 0, out: '', err: '' }
      spawnCount += 1
      return {
        done: Promise.resolve({ exitCode: plan.exitCode, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: plan.out ?? '', nextOffset: (plan.out ?? '').length, lossy: false }) },
          stderr: { readFrom: () => ({ text: plan.err ?? '', nextOffset: (plan.err ?? '').length, lossy: false }) },
        },
      }
    }),
    spawnTerminal: vi.fn(async (spec: unknown) => {
      terminal = new FakeTerminal()
      void spec
      return terminal
    }),
  } as unknown as SubprocessRuntime
  const handle = { current: () => terminal }
  Object.defineProperty(handle, 'current', { get: () => terminal })
  return subprocess
}

class FakeTerminal {
  pid = 1
  writes: string[] = []
  terminated = false
  private listeners: Record<string, Array<(payload?: unknown) => void>> = {}
  readonly output = {
    on: (event: string, fn: (payload?: unknown) => void): void => {
      (this.listeners[event] ??= []).push(fn)
    },
    emit: (event: string, payload?: unknown): void => {
      for (const fn of this.listeners[event] ?? []) fn(payload)
    },
  }
  readonly done: Promise<{ code: number }>
  resolveDone!: (value: { code: number }) => void
  constructor() {
    this.done = new Promise((resolve) => { this.resolveDone = resolve })
  }
  async write(data: string): Promise<void> { this.writes.push(data) }
  async inspectForeground(): Promise<{ processGroupId: number; inputWaiting: boolean } | undefined> { return undefined }
  async signalForeground(): Promise<number> { return 0 }
  async terminate(): Promise<void> {
    this.terminated = true
    this.output.emit('end')
    this.resolveDone({ code: 0 })
  }
}

/** Parse the JSON body captured by {@link makeRes}. */
function bodyOf(res: ServerResponse): Record<string, unknown> {
  return JSON.parse((res as unknown as { body: string }).body) as Record<string, unknown>
}

const byPath = (routes: Route[], path: string): Route => {
  const route = routes.find(r => r.path === path)
  if (route === undefined) throw new Error(`missing route ${path}`)
  return route
}

describe('workspace-ext node half', () => {
  it('exports the plugin contract and registers every route', () => {
    expect(name).toBe('workspace-ext')
    expect(inject).toEqual(['webServer'])
    const { routes } = bench()
    expect(routes.map(r => r.path).sort()).toEqual([
      '/api/workspace-ext/branch',
      '/api/workspace-ext/branches',
      '/api/workspace-ext/checkout',
      '/api/workspace-ext/status',
      '/api/workspace-ext/term/kill',
      '/api/workspace-ext/term/poll',
      '/api/workspace-ext/term/spawn',
      '/api/workspace-ext/term/status',
      '/api/workspace-ext/term/write',
    ])
  })

  it('refuses non-loopback hosts on every route', async () => {
    const { routes } = bench()
    for (const route of routes) {
      const res = makeRes()
      await route.handler(makeReq('GET', route.path, 'evil.example'), res)
      expect((res as unknown as { status: number }).status).toBe(403)
    }
  })

  it('reads the branch from .git/HEAD (ref and detached forms)', async () => {
    const { ctx, routes } = bench()
    const fs = {
      resolve: vi.fn(async (p: string, opts?: { cwd?: string }) => {
        const path = p.startsWith('/') ? p : `${opts?.cwd ?? ''}/${p}`
        return { key: path, path }
      }),
      readText: vi.fn(async (target: { path: string }) => {
        if (target.path.endsWith('/.git/HEAD')) return 'ref: refs/heads/dev\n'
        throw new Error('ENOENT')
      }),
    } as unknown as FileSystem
    ;(ctx as unknown as Record<string, unknown>)['svc:fs'] = fs
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/branch').handler(
      makeReq('GET', '/api/workspace-ext/branch?path=%2Frepo'), res)
    expect(bodyOf(res)).toEqual({
      ok: true, branch: 'dev', detached: false, path: '/repo',
    })

    ;(fs.readText as ReturnType<typeof vi.fn>).mockImplementation((target: { path: string }) => {
      if (target.path.endsWith('/.git/HEAD')) return 'abc1234def5678\n'
      throw new Error('ENOENT')
    })
    const res2 = makeRes()
    await byPath(routes, '/api/workspace-ext/branch').handler(
      makeReq('GET', '/api/workspace-ext/branch?path=%2Frepo'), res2)
    expect(bodyOf(res2)).toEqual({
      ok: true, branch: 'abc1234', detached: true, path: '/repo',
    })
  })

  it('follows a gitdir-pointer .git file and handles an empty or missing HEAD', async () => {
    const { ctx, routes } = bench()
    const fs = {
      resolve: vi.fn(async (p: string, opts?: { cwd?: string }) => {
        const path = p.startsWith('/') ? p : `${opts?.cwd ?? ''}/${p}`
        return { key: path, path }
      }),
      readText: vi.fn(async (target: { path: string }) => {
        if (target.path.endsWith('/.git')) return 'gitdir: /worktrees/w1\n'
        if (target.path === '/worktrees/w1/HEAD') return 'ref: refs/heads/topic\n'
        throw new Error('ENOENT')
      }),
    } as unknown as FileSystem
    ;(ctx as unknown as Record<string, unknown>)['svc:fs'] = fs
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/branch').handler(
      makeReq('GET', '/api/workspace-ext/branch?path=%2Frepo'), res)
    expect(bodyOf(res)).toEqual({
      ok: true, branch: 'topic', detached: false, path: '/repo',
    })

    // Missing HEAD entirely → branch null; blank HEAD → branch null.
    ;(fs.readText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'))
    const res2 = makeRes()
    await byPath(routes, '/api/workspace-ext/branch').handler(
      makeReq('GET', '/api/workspace-ext/branch?path=%2Frepo'), res2)
    expect(bodyOf(res2).branch).toBeNull()

    ;(fs.readText as ReturnType<typeof vi.fn>).mockResolvedValue('\n')
    const res3 = makeRes()
    await byPath(routes, '/api/workspace-ext/branch').handler(
      makeReq('GET', '/api/workspace-ext/branch?path=%2Frepo'), res3)
    expect(bodyOf(res3).branch).toBeNull()
  })

  it('rejects missing paths and surfaces read failures', async () => {
    const { ctx, routes } = bench()
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/branch').handler(
      makeReq('GET', '/api/workspace-ext/branch'), res)
    expect((res as unknown as { status: number }).status).toBe(400)

    ;(ctx as unknown as Record<string, unknown>)['svc:fs'] = {
      resolve: vi.fn(async () => { throw new Error('boom') }),
    }
    const res2 = makeRes()
    await byPath(routes, '/api/workspace-ext/branch').handler(
      makeReq('GET', '/api/workspace-ext/branch?path=%2Frepo'), res2)
    // readGitHead swallows read failures and reports no branch.
    const body = bodyOf(res2)
    expect(body.ok).toBe(true)
    expect(body.branch).toBeNull()
  })

  it('lists local branches through git for-each-ref', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([{ exitCode: 0, out: 'dev\nmain\n\n' }])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/branches').handler(
      makeReq('GET', '/api/workspace-ext/branches?path=%2Frepo'), res)
    expect(bodyOf(res)).toEqual({
      ok: true, branches: ['dev', 'main'],
    })

    // git failure surfaces stderr.
    const subprocess2 = fakeSubprocess([{ exitCode: 128, err: 'fatal: not a git repository' }])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess2
    const res2 = makeRes()
    await byPath(routes, '/api/workspace-ext/branches').handler(
      makeReq('GET', '/api/workspace-ext/branches?path=%2Frepo'), res2)
    const body2 = bodyOf(res2)
    expect(body2.ok).toBe(false)
    expect(body2.error).toContain('fatal')

    // resolveExecutable failure keeps the bare name.
    const subprocess3 = fakeSubprocess([{ exitCode: 0, out: 'x\n' }])
    ;(subprocess3.resolveExecutable as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('nope'))
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess3
    const res3 = makeRes()
    await byPath(routes, '/api/workspace-ext/branches').handler(
      makeReq('GET', '/api/workspace-ext/branches?path=%2Frepo'), res3)
    expect(bodyOf(res3).branches).toEqual(['x'])

    // Missing path → 400.
    const res4 = makeRes()
    await byPath(routes, '/api/workspace-ext/branches').handler(makeReq('GET', '/api/workspace-ext/branches'), res4)
    expect((res4 as unknown as { status: number }).status).toBe(400)
  })

  it('switches branches through git checkout', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([{ exitCode: 0, out: "Switched to branch 'main'\n" }])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/checkout').handler(
      makeReq('POST', '/api/workspace-ext/checkout', '127.0.0.1:52351', { path: '/repo', branch: 'main' }), res)
    expect(bodyOf(res)).toEqual({
      ok: true, message: "Switched to branch 'main'",
    })

    const subprocess2 = fakeSubprocess([{ exitCode: 1, err: 'error: dirty tree' }])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess2
    const res2 = makeRes()
    await byPath(routes, '/api/workspace-ext/checkout').handler(
      makeReq('POST', '/api/workspace-ext/checkout', '127.0.0.1:52351', { path: '/repo', branch: 'main' }), res2)
    const body2 = bodyOf(res2)
    expect(body2.ok).toBe(false)
    expect(body2.error).toContain('dirty')

    const res3 = makeRes()
    await byPath(routes, '/api/workspace-ext/checkout').handler(
      makeReq('POST', '/api/workspace-ext/checkout', '127.0.0.1:52351', {}), res3)
    expect((res3 as unknown as { status: number }).status).toBe(400)
  })

  it('reports the working-tree status through git status --porcelain', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([{
      exitCode: 0,
      out: '## dev...origin/dev [ahead 2, behind 1]\n M src/a.ts\nA  new.txt\n?? untracked.md\n',
    }])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/status').handler(
      makeReq('GET', '/api/workspace-ext/status?path=%2Frepo'), res)
    expect(bodyOf(res)).toEqual({
      ok: true,
      branch: 'dev',
      ahead: 2,
      behind: 1,
      changes: [
        { index: ' ', worktree: 'M', path: 'src/a.ts' },
        { index: 'A', worktree: ' ', path: 'new.txt' },
        { index: '?', worktree: '?', path: 'untracked.md' },
      ],
    })

    // git failure surfaces stderr.
    const subprocess2 = fakeSubprocess([{ exitCode: 128, err: 'fatal: not a git repository' }])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess2
    const res2 = makeRes()
    await byPath(routes, '/api/workspace-ext/status').handler(
      makeReq('GET', '/api/workspace-ext/status?path=%2Frepo'), res2)
    const body2 = bodyOf(res2)
    expect(body2.ok).toBe(false)
    expect(body2.error).toContain('fatal')

    // A failure with only stdout and one with no streams keep their fallbacks.
    const subprocess3 = fakeSubprocess([{ exitCode: 1, out: 'conflict' }, { exitCode: 1 }])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess3
    const res3 = makeRes()
    await byPath(routes, '/api/workspace-ext/status').handler(
      makeReq('GET', '/api/workspace-ext/status?path=%2Frepo'), res3)
    expect(bodyOf(res3).error).toBe('conflict')
    const res4 = makeRes()
    await byPath(routes, '/api/workspace-ext/status').handler(
      makeReq('GET', '/api/workspace-ext/status?path=%2Frepo'), res4)
    expect(bodyOf(res4).error).toBe('git exited 1')

    // Missing path → 400; missing service → 400.
    const res5 = makeRes()
    await byPath(routes, '/api/workspace-ext/status').handler(makeReq('GET', '/api/workspace-ext/status'), res5)
    expect((res5 as unknown as { status: number }).status).toBe(400)
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = undefined
    const res6 = makeRes()
    await byPath(routes, '/api/workspace-ext/status').handler(
      makeReq('GET', '/api/workspace-ext/status?path=%2Frepo'), res6)
    expect((res6 as unknown as { status: number }).status).toBe(400)
  })

  it('parses detached, unborn, and plain branch headers', () => {
    expect(parseGitStatus('## HEAD (no branch)\n M a\n')).toEqual({
      branch: null, ahead: 0, behind: 0,
      changes: [{ index: ' ', worktree: 'M', path: 'a' }],
    })
    expect(parseGitStatus('## No commits yet on main\n')).toEqual({
      branch: 'main', ahead: 0, behind: 0, changes: [],
    })
    expect(parseGitStatus('## main\n')).toEqual({
      branch: 'main', ahead: 0, behind: 0, changes: [],
    })
    expect(parseGitStatus('## main...origin/main [behind 3]\n')).toEqual({
      branch: 'main', ahead: 0, behind: 3, changes: [],
    })
    // A bare repository without a branch header yields no branch.
    const bare = parseGitStatus('?? file\n')
    expect(bare.branch).toBeNull()
    expect(bare.changes).toEqual([{ index: '?', worktree: '?', path: 'file' }])
    // Rows with only whitespace codes are skipped.
    expect(parseGitStatus('## main\n  \n  clean.txt\n').changes).toEqual([])
    // The `space-space` code row is skipped entirely.
    const spaced: GitStatus = parseGitStatus('## main\n   x\n')
    expect(spaced.changes).toEqual([])
    // A header with an upstream but no local name reports no branch.
    expect(parseGitStatus('## ...origin/main [ahead 1]\n').branch).toBeNull()
    // A single-character row keeps the code columns short.
    expect(parseGitStatus('## main\nM\n')).toEqual({
      branch: 'main', ahead: 0, behind: 0,
      changes: [{ index: 'M', worktree: '', path: '' }],
    })
  })

  it('spawns, writes, polls, kills and reports the terminal', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const spawnRoute = byPath(routes, '/api/workspace-ext/term/spawn')

    // Spawn success.
    const res = makeRes()
    await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), res)
    expect(bodyOf(res).ok).toBe(true)
    const terminal = (subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mock.results[0]!.value as Promise<FakeTerminal>

    // Spawn missing cwd → 400.
    const resMissing = makeRes()
    await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', {}), resMissing)
    expect((resMissing as unknown as { status: number }).status).toBe(400)

    // Spawn failure surfaces the error.
    ;(subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('pty busy'))
    const resFail = makeRes()
    await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resFail)
    const failBody = bodyOf(resFail)
    expect(failBody.ok).toBe(false)
    expect(failBody.error).toBe('pty busy')

    // No subprocess service.
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = undefined
    const resNone = makeRes()
    await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resNone)
    expect(bodyOf(resNone).error).toBe('subprocess service unavailable')

    // Terminal output accumulates, is capped, and polls incrementally.
    const t = await terminal
    const bigChunk = Buffer.from('x'.repeat(70000))
    t.output.emit('data', bigChunk)
    const resPoll = makeRes()
    await byPath(routes, '/api/workspace-ext/term/poll').handler(makeReq('GET', '/api/workspace-ext/term/poll'), resPoll)
    const poll = bodyOf(resPoll)
    expect(poll.ok).toBe(true)
    expect((poll.out as string).length).toBe(65536)
    expect(poll.exited).toBe(false)

    // Write delivers text; then the terminal exits via done.
    const resWrite = makeRes()
    await byPath(routes, '/api/workspace-ext/term/write').handler(
      makeReq('POST', '/api/workspace-ext/term/write', '127.0.0.1:52351', { text: 'ls\n' }), resWrite)
    expect(bodyOf(resWrite).ok).toBe(true)
    expect(t.writes).toEqual(['ls\n'])

    t.resolveDone({ code: 0 })
    await t.done
    const resPoll2 = makeRes()
    await byPath(routes, '/api/workspace-ext/term/poll').handler(makeReq('GET', '/api/workspace-ext/term/poll'), resPoll2)
    expect(bodyOf(resPoll2).exited).toBe(true)

    // Status reflects liveness.
    const resStatus = makeRes()
    await byPath(routes, '/api/workspace-ext/term/status').handler(makeReq('GET', '/api/workspace-ext/term/status'), resStatus)
    const status = bodyOf(resStatus)
    expect(status.ok).toBe(true)
    expect(status.running).toBe(true)

    // Kill terminates and clears.
    const resKill = makeRes()
    await byPath(routes, '/api/workspace-ext/term/kill').handler(
      makeReq('POST', '/api/workspace-ext/term/kill', '127.0.0.1:52351', {}), resKill)
    expect(bodyOf(resKill).ok).toBe(true)
    expect(t.terminated).toBe(true)
    const resStatus2 = makeRes()
    await byPath(routes, '/api/workspace-ext/term/status').handler(makeReq('GET', '/api/workspace-ext/term/status'), resStatus2)
    expect(bodyOf(resStatus2).running).toBe(false)

    // Write with no terminal → error.
    const resNoTerm = makeRes()
    await byPath(routes, '/api/workspace-ext/term/write').handler(
      makeReq('POST', '/api/workspace-ext/term/write', '127.0.0.1:52351', { text: 'x' }), resNoTerm)
    expect(bodyOf(resNoTerm).error).toBe('no terminal running')
  })

  it('handles malformed bodies and write/terminate failures', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const spawnRoute = byPath(routes, '/api/workspace-ext/term/spawn')

    // Malformed JSON body → treated as empty (spawn then 400s on cwd).
    const resBad = makeRes()
    await spawnRoute.handler(
      { method: 'POST', url: '/api/workspace-ext/term/spawn', headers: { host: '127.0.0.1:52351' }, on: (event: string, fn: (...a: unknown[]) => void) => {
        if (event === 'data') queueMicrotask(() => { fn(Buffer.from('not-json')) })
        if (event === 'end') queueMicrotask(fn)
      } } as unknown as IncomingMessage, resBad)
    expect((resBad as unknown as { status: number }).status).toBe(400)

    // Terminal handle write failure surfaces the error.
    const writeRoute = byPath(routes, '/api/workspace-ext/term/write')
    const badTerminal = new FakeTerminal()
    badTerminal.write = vi.fn(async () => { throw new Error('eio') })
    ;(subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce(badTerminal)
    const resSpawn = makeRes()
    await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resSpawn)
    const resWriteFail = makeRes()
    await writeRoute.handler(makeReq('POST', '/api/workspace-ext/term/write', '127.0.0.1:52351', { text: 'x' }), resWriteFail)
    expect(bodyOf(resWriteFail).error).toBe('eio')

    // Terminate rejection is swallowed by the cleanup disposer.
    badTerminal.terminate = vi.fn(async () => { throw new Error('gone') })
    const resKill = makeRes()
    await byPath(routes, '/api/workspace-ext/term/kill').handler(
      makeReq('POST', '/api/workspace-ext/term/kill', '127.0.0.1:52351', {}), resKill)
    expect(bodyOf(resKill).ok).toBe(true)
  })

  it('decoder fallback handles non-buffer chunks', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const t = new FakeTerminal()
    ;(subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce(t)
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/term/spawn').handler(
      makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), res)
    t.output.emit('data', 'raw-string-chunk')
    const resPoll = makeRes()
    await byPath(routes, '/api/workspace-ext/term/poll').handler(makeReq('GET', '/api/workspace-ext/term/poll'), resPoll)
    expect(bodyOf(resPoll).out).toBe('raw-string-chunk')
  })

  it('cleanup disposers terminate an active terminal', async () => {
    const { ctx, routes, disposers } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const t = new FakeTerminal()
    ;(subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce(t)
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/term/spawn').handler(
      makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), res)
    for (const dispose of disposers) dispose()
    expect(t.terminated).toBe(true)
    // A second pass runs disposeTerm with no handle (idempotent no-op).
    for (const dispose of disposers) dispose()
    const resStatus = makeRes()
    await byPath(routes, '/api/workspace-ext/term/status').handler(makeReq('GET', '/api/workspace-ext/term/status'), resStatus)
    expect(bodyOf(resStatus).running).toBe(false)
  })

  it('marks the terminal exited when its done promise rejects', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const t = new FakeTerminal()
    Object.defineProperty(t, 'done', { value: Promise.reject(new Error('transport lost')) })
    ;(subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce(t)
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/term/spawn').handler(
      makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), res)
    // let the rejection propagate through the catch handler
    await new Promise((resolve) => { queueMicrotask(() => { resolve(undefined) }) })
    const resPoll = makeRes()
    await byPath(routes, '/api/workspace-ext/term/poll').handler(makeReq('GET', '/api/workspace-ext/term/poll'), resPoll)
    expect(bodyOf(resPoll).exited).toBe(true)
  })

  it('survives malformed and scalar request bodies and stream errors', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const spawnRoute = byPath(routes, '/api/workspace-ext/term/spawn')

    const scalarRes = makeRes()
    await spawnRoute.handler(
      { method: 'POST', url: '/api/workspace-ext/term/spawn', headers: { host: '127.0.0.1:52351' }, on: (event: string, fn: (...a: unknown[]) => void) => {
        if (event === 'data') queueMicrotask(() => { fn(Buffer.from('42')) })
        if (event === 'end') queueMicrotask(fn)
      } } as unknown as IncomingMessage, scalarRes)
    expect((scalarRes as unknown as { status: number }).status).toBe(400)

    const errorRes = makeRes()
    await spawnRoute.handler(
      { method: 'POST', url: '/api/workspace-ext/term/spawn', headers: { host: '127.0.0.1:52351' }, on: (event: string, fn: (...a: unknown[]) => void) => {
        if (event === 'error') queueMicrotask(() => { fn(new Error('reset')) })
        if (event === 'end') queueMicrotask(fn)
      } } as unknown as IncomingMessage, errorRes)
    expect((errorRes as unknown as { status: number }).status).toBe(400)
  })

  it('handles a subprocess without collected streams', async () => {
    const { ctx, routes } = bench()
    const subprocess = {
      resolveExecutable: vi.fn(async () => '/usr/bin/git'),
      spawn: vi.fn(() => ({ done: Promise.resolve({ exitCode: 0, signal: null }), collected: {} })),
    } as unknown as SubprocessRuntime
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/branches').handler(
      makeReq('GET', '/api/workspace-ext/branches?path=%2Frepo'), res)
    expect(bodyOf(res)).toEqual({ ok: true, branches: [] })
  })
})

describe('workspace-ext node half — coverage arms', () => {
  it('rejects requests without a host header', async () => {
    const { routes } = bench()
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/branch').handler(
      { method: 'GET', url: '/api/workspace-ext/branch?path=%2Frepo', headers: {} } as IncomingMessage, res)
    expect((res as unknown as { status: number }).status).toBe(403)
  })

  it('handles a .git file without the gitdir line and with a relative gitdir path', async () => {
    const { ctx, routes } = bench()
    const fs = {
      resolve: vi.fn(async (p: string, opts?: { cwd?: string }) => {
        const path = p.startsWith('/') ? p : `${opts?.cwd ?? ''}/${p}`
        return { key: path, path }
      }),
      readText: vi.fn(async (target: { path: string }) => {
        if (target.path.endsWith('/.git')) return 'packed-refs\n' // no gitdir line
        throw new Error('ENOENT')
      }),
    } as unknown as FileSystem
    ;(ctx as unknown as Record<string, unknown>)['svc:fs'] = fs
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/branch').handler(
      makeReq('GET', '/api/workspace-ext/branch?path=%2Frepo'), res)
    expect(bodyOf(res).branch).toBeNull()

    // Relative gitdir path resolves against the workspace root.
    ;(fs.readText as ReturnType<typeof vi.fn>).mockImplementation((target: { path: string }) => {
      if (target.path.endsWith('/.git')) return 'gitdir: worktrees/w1\n'
      if (target.path === '/repo/worktrees/w1/HEAD') return 'ref: refs/heads/rel\n'
      throw new Error('ENOENT')
    })
    const res2 = makeRes()
    await byPath(routes, '/api/workspace-ext/branch').handler(
      makeReq('GET', '/api/workspace-ext/branch?path=%2Frepo'), res2)
    expect(bodyOf(res2).branch).toBe('rel')
  })

  it('keeps the bare git name when resolveExecutable returns empty', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([{ exitCode: 0, out: 'dev\n' }])
    ;(subprocess.resolveExecutable as ReturnType<typeof vi.fn>).mockResolvedValue('')
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/branches').handler(
      makeReq('GET', '/api/workspace-ext/branches?path=%2Frepo'), res)
    expect(bodyOf(res).branches).toEqual(['dev'])
  })

  it('rejects branches without a subprocess service', async () => {
    const { ctx, routes } = bench()
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = undefined
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/branches').handler(
      makeReq('GET', '/api/workspace-ext/branches?path=%2Frepo'), res)
    expect((res as unknown as { status: number }).status).toBe(400)
  })

  it('surfaces git failures with output-only or empty streams', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([
      { exitCode: 1, out: 'conflict' },
      { exitCode: 1 },
      { exitCode: 1, out: 'local changes' },
      { exitCode: 0, err: 'Switched to branch x' },
    ])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess

    const res1 = makeRes()
    await byPath(routes, '/api/workspace-ext/branches').handler(
      makeReq('GET', '/api/workspace-ext/branches?path=%2Frepo'), res1)
    expect(bodyOf(res1).error).toBe('conflict')

    const res2 = makeRes()
    await byPath(routes, '/api/workspace-ext/branches').handler(
      makeReq('GET', '/api/workspace-ext/branches?path=%2Frepo'), res2)
    expect(bodyOf(res2).error).toBe('git exited 1')

    const res3 = makeRes()
    await byPath(routes, '/api/workspace-ext/checkout').handler(
      makeReq('POST', '/api/workspace-ext/checkout', '127.0.0.1:52351', { path: '/repo', branch: 'main' }), res3)
    expect(bodyOf(res3).error).toBe('local changes')

    const res4 = makeRes()
    await byPath(routes, '/api/workspace-ext/checkout').handler(
      makeReq('POST', '/api/workspace-ext/checkout', '127.0.0.1:52351', { path: '/repo', branch: 'main' }), res4)
    expect(bodyOf(res4).message).toBe('Switched to branch x')
  })

  it('rejects when the git process done promise rejects', async () => {
    const { ctx, routes } = bench()
    const rejectSubprocess = {
      resolveExecutable: vi.fn(async () => '/usr/bin/git'),
      spawn: vi.fn(() => ({ done: Promise.reject(new Error('git boom')), collected: {} })),
    } as unknown as SubprocessRuntime
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = rejectSubprocess
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/branches').handler(
      makeReq('GET', '/api/workspace-ext/branches?path=%2Frepo'), res)
    expect(bodyOf(res).error).toBe('git boom')

    const stringSubprocess = {
      resolveExecutable: vi.fn(async () => '/usr/bin/git'),
      spawn: vi.fn(() => ({ done: Promise.reject(new Error('plain-string')), collected: {} })),
    } as unknown as SubprocessRuntime
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = stringSubprocess
    const res2 = makeRes()
    await byPath(routes, '/api/workspace-ext/checkout').handler(
      makeReq('POST', '/api/workspace-ext/checkout', '127.0.0.1:52351', { path: '/repo', branch: 'main' }), res2)
    expect(bodyOf(res2).error).toBe('plain-string')
  })

  it('writes an empty string when the text field is missing', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const t = new FakeTerminal()
    ;(subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce(t)
    const resSpawn = makeRes()
    await byPath(routes, '/api/workspace-ext/term/spawn').handler(
      makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resSpawn)
    const resWrite = makeRes()
    await byPath(routes, '/api/workspace-ext/term/write').handler(
      makeReq('POST', '/api/workspace-ext/term/write', '127.0.0.1:52351', {}), resWrite)
    expect(bodyOf(resWrite).ok).toBe(true)
    expect(t.writes).toEqual([''])
  })

  it('surfaces non-Error spawn and write failures as strings', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    ;(subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mockRejectedValueOnce('pty-string')
    const resSpawn = makeRes()
    await byPath(routes, '/api/workspace-ext/term/spawn').handler(
      makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resSpawn)
    expect(bodyOf(resSpawn).error).toBe('pty-string')

    const badTerminal = new FakeTerminal()
    badTerminal.write = vi.fn(async () => { throw 'eio-string' })
    ;(subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce(badTerminal)
    const resSpawn2 = makeRes()
    await byPath(routes, '/api/workspace-ext/term/spawn').handler(
      makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resSpawn2)
    const resWrite = makeRes()
    await byPath(routes, '/api/workspace-ext/term/write').handler(
      makeReq('POST', '/api/workspace-ext/term/write', '127.0.0.1:52351', { text: 'x' }), resWrite)
    expect(bodyOf(resWrite).error).toBe('eio-string')
  })
})

describe('workspace-ext node half — final arms', () => {
  it('rejects a branch request with a path when the fs service is absent', async () => {
    const { ctx, routes } = bench()
    ;(ctx as unknown as Record<string, unknown>)['svc:fs'] = undefined
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/branch').handler(
      makeReq('GET', '/api/workspace-ext/branch?path=%2Frepo'), res)
    expect((res as unknown as { status: number }).status).toBe(400)
  })

  it('rejects a branches request without a path when the service exists', async () => {
    const { ctx, routes } = bench()
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = fakeSubprocess([])
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/branches').handler(
      makeReq('GET', '/api/workspace-ext/branches'), res)
    expect((res as unknown as { status: number }).status).toBe(400)
  })

  it('rejects a checkout with a path but no branch', async () => {
    const { ctx, routes } = bench()
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = fakeSubprocess([])
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/checkout').handler(
      makeReq('POST', '/api/workspace-ext/checkout', '127.0.0.1:52351', { path: '/repo' }), res)
    expect((res as unknown as { status: number }).status).toBe(400)
  })

  it('covers checkout stream combinations', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([
      { exitCode: 1 }, // no err or out → template error
      { exitCode: 0 }, // no out or err → empty message
    ])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const res1 = makeRes()
    await byPath(routes, '/api/workspace-ext/checkout').handler(
      makeReq('POST', '/api/workspace-ext/checkout', '127.0.0.1:52351', { path: '/repo', branch: 'main' }), res1)
    expect(bodyOf(res1).error).toBe('git checkout exited 1')
    const res2 = makeRes()
    await byPath(routes, '/api/workspace-ext/checkout').handler(
      makeReq('POST', '/api/workspace-ext/checkout', '127.0.0.1:52351', { path: '/repo', branch: 'main' }), res2)
    expect(bodyOf(res2).message).toBe('')
  })

  it('rejects checkout with an Error payload and branches with a string payload', async () => {
    const { ctx, routes } = bench()
    const rejectSubprocess = {
      resolveExecutable: vi.fn(async () => '/usr/bin/git'),
      spawn: vi.fn(() => ({ done: Promise.reject(new Error('checkout boom')), collected: {} })),
    } as unknown as SubprocessRuntime
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = rejectSubprocess
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/checkout').handler(
      makeReq('POST', '/api/workspace-ext/checkout', '127.0.0.1:52351', { path: '/repo', branch: 'main' }), res)
    expect(bodyOf(res).error).toBe('checkout boom')

    const stringSubprocess = {
      resolveExecutable: vi.fn(async () => '/usr/bin/git'),
      spawn: vi.fn(() => ({ done: Promise.reject(new Error('branch-string')), collected: {} })),
    } as unknown as SubprocessRuntime
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = stringSubprocess
    const res2 = makeRes()
    await byPath(routes, '/api/workspace-ext/branches').handler(
      makeReq('GET', '/api/workspace-ext/branches?path=%2Frepo'), res2)
    expect(bodyOf(res2).error).toBe('branch-string')
  })

  it('rejects status with Error and string payloads', async () => {
    const { ctx, routes } = bench()
    const rejectSubprocess = {
      resolveExecutable: vi.fn(async () => '/usr/bin/git'),
      spawn: vi.fn(() => ({ done: Promise.reject(new Error('status boom')), collected: {} })),
    } as unknown as SubprocessRuntime
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = rejectSubprocess
    const res = makeRes()
    await byPath(routes, '/api/workspace-ext/status').handler(
      makeReq('GET', '/api/workspace-ext/status?path=%2Frepo'), res)
    expect(bodyOf(res).error).toBe('status boom')

    const stringSubprocess = {
      resolveExecutable: vi.fn(async () => '/usr/bin/git'),
      spawn: vi.fn(() => ({ done: Promise.reject(new Error('status-string')), collected: {} })),
    } as unknown as SubprocessRuntime
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = stringSubprocess
    const res2 = makeRes()
    await byPath(routes, '/api/workspace-ext/status').handler(
      makeReq('GET', '/api/workspace-ext/status?path=%2Frepo'), res2)
    expect(bodyOf(res2).error).toBe('status-string')
  })
})
