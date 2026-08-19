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

/** A response capturing SSE frames; the test drives 'close' to disconnect. */
function makeSseRes(): ServerResponse {
  const frames: string[] = []
  const res = { status: 0, body: '', frames, writeHead: () => {}, write: (frame: string) => { frames.push(frame) }, end: () => {} } as unknown as ServerResponse
  res.writeHead = vi.fn((code: number) => { (res as unknown as { status: number }).status = code }) as never
  ;(res as unknown as { write: (frame: string) => void }).write = (frame: string) => { frames.push(frame) }
  return res
}

/** Parse the SSE frames written to a response into their JSON payloads. */
function ssePayloads(res: ServerResponse): Array<{ out: string; exited: boolean }> {
  const frames = (res as unknown as { frames: string[] }).frames
  return frames
    .filter(frame => frame.startsWith('data: '))
    .map(frame => JSON.parse(frame.slice('data: '.length)) as { out: string; exited: boolean })
}

function makeReq(method: string, url: string, host = '127.0.0.1:52351', body?: Record<string, unknown>): IncomingMessage {
  const closeListeners: Array<() => void> = []
  const req = { method, url, headers: { host } } as IncomingMessage
  req.on = ((event: string, fn: (...args: unknown[]) => void) => {
    if (event === 'data' && body !== undefined) queueMicrotask(() => { fn(Buffer.from(JSON.stringify(body))) })
    if (event === 'end') queueMicrotask(fn)
    if (event === 'close') closeListeners.push(fn)
    if (event === 'error' && body === undefined) { /* never fires */ }
    return req
  }) as never
  ;(req as unknown as { emitClose: () => void }).emitClose = () => {
    for (const listener of closeListeners) listener()
  }
  return req
}

/** Disconnect a stream request, unsubscribing it like a closed socket. */
function closeStream(req: IncomingMessage): void {
  ;(req as unknown as { emitClose: () => void }).emitClose()
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
  const terminals: FakeTerminal[] = []
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
      const t = new FakeTerminal()
      terminal = t
      terminals.push(t)
      void spec
      return t
    }),
  } as unknown as SubprocessRuntime
  const handle = { current: () => terminal, all: () => terminals }
  Object.defineProperty(handle, 'current', { get: () => terminal })
  Object.defineProperty(handle, 'all', { get: () => terminals })
  return subprocess
}

class FakeTerminal {
  pid = 1
  writes: string[] = []
  resizes: Array<{ cols: number; rows: number }> = []
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
  rejectDone!: (reason: unknown) => void
  constructor() {
    this.done = new Promise((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject })
  }
  async write(data: string): Promise<void> { this.writes.push(data) }
  async resize(cols: number, rows: number): Promise<void> { this.resizes.push({ cols, rows }) }
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
      '/api/workspace-ext/diff',
      '/api/workspace-ext/git/action',
      '/api/workspace-ext/status',
      '/api/workspace-ext/term/kill',
      '/api/workspace-ext/term/resize',
      '/api/workspace-ext/term/spawn',
      '/api/workspace-ext/term/status',
      '/api/workspace-ext/term/stream',
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

  it('runs stage/unstage/discard git actions with allowlisted argv', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([{ exitCode: 0 }])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const route = byPath(routes, '/api/workspace-ext/git/action')
    const spawnSpecs = (subprocess.spawn as ReturnType<typeof vi.fn>).mock.calls as Array<[{ argv: string[] }]>

    // Stage specific files and all files.
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'stage', files: ['a.ts', 'b.ts'] }), makeRes())
    expect(spawnSpecs[0]![0].argv).toEqual(['/usr/bin/git', 'add', '--', 'a.ts', 'b.ts'])
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'stage' }), makeRes())
    expect(spawnSpecs[1]![0].argv).toEqual(['/usr/bin/git', 'add', '-A'])

    // Unstage specific files and all files.
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'unstage', files: ['a.ts'] }), makeRes())
    expect(spawnSpecs[2]![0].argv).toEqual(['/usr/bin/git', 'reset', '--', 'a.ts'])
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'unstage' }), makeRes())
    expect(spawnSpecs[3]![0].argv).toEqual(['/usr/bin/git', 'reset'])

    // Discard worktree changes for one file and for all files.
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'discard', files: ['a.ts'] }), makeRes())
    expect(spawnSpecs[4]![0].argv).toEqual(['/usr/bin/git', 'checkout', '--', 'a.ts'])
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'discard' }), makeRes())
    expect(spawnSpecs[5]![0].argv).toEqual(['/usr/bin/git', 'checkout', '--', '.'])

    // Discard staged changes restores from HEAD.
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'discard', files: ['a.ts'], staged: true }), makeRes())
    expect(spawnSpecs[6]![0].argv).toEqual(['/usr/bin/git', 'checkout', 'HEAD', '--', 'a.ts'])
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'discard', staged: true }), makeRes())
    expect(spawnSpecs[7]![0].argv).toEqual(['/usr/bin/git', 'checkout', 'HEAD', '--', '.'])
  })

  it('commits staged changes and smart-commits everything when asked', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([{ exitCode: 0, out: '[main abc123] msg\n' }])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const route = byPath(routes, '/api/workspace-ext/git/action')
    const spawnSpecs = (subprocess.spawn as ReturnType<typeof vi.fn>).mock.calls as Array<[{ argv: string[] }]>

    const res = makeRes()
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'commit', message: 'fix: x' }), res)
    expect(bodyOf(res).ok).toBe(true)
    expect(spawnSpecs[0]![0].argv).toEqual(['/usr/bin/git', 'commit', '-m', 'fix: x'])

    // Smart commit (all=true) stages everything first.
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'commit', message: '  all of it  ', all: true }), makeRes())
    expect(spawnSpecs[1]![0].argv).toEqual(['/usr/bin/git', 'add', '-A'])
    expect(spawnSpecs[2]![0].argv).toEqual(['/usr/bin/git', 'commit', '-m', 'all of it'])
  })

  it('rejects empty commit messages and unknown actions with 400s', async () => {
    const { ctx, routes } = bench()
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = fakeSubprocess([])
    const route = byPath(routes, '/api/workspace-ext/git/action')
    const res = makeRes()
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'commit', message: '   ' }), res)
    expect((res as unknown as { status: number }).status).toBe(400)

    const res2 = makeRes()
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'cherry-pick' }), res2)
    expect((res2 as unknown as { status: number }).status).toBe(400)

    const res3 = makeRes()
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '', action: 'stage' }), res3)
    expect((res3 as unknown as { status: number }).status).toBe(400)

    const res4 = makeRes()
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', {}), res4)
    expect((res4 as unknown as { status: number }).status).toBe(400)
  })

  it('surfaces git action failures and subprocess rejections', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([
      { exitCode: 1, err: 'fatal: pathspec did not match' },
      { exitCode: 1, out: 'nothing to commit' },
      { exitCode: 1 },
      { exitCode: 1 }, // git add fails during smart commit
      { exitCode: 0 }, // git add succeeds on the retry
      { exitCode: 1 }, // git commit fails with empty streams
    ])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const route = byPath(routes, '/api/workspace-ext/git/action')

    const res = makeRes()
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'stage', files: ['nope'] }), res)
    expect(bodyOf(res).error).toContain('pathspec')

    const res2 = makeRes()
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'commit', message: 'x' }), res2)
    expect(bodyOf(res2).error).toBe('nothing to commit')

    const res3 = makeRes()
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'unstage' }), res3)
    expect(bodyOf(res3).error).toBe('git exited 1')

    // Smart-commit staging failure surfaces the git add error.
    const resAdd = makeRes()
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'commit', message: 'x', all: true }), resAdd)
    expect(bodyOf(resAdd).error).toBe('git add exited 1')

    // Commit failure with neither stream falls back to the template.
    const resTpl = makeRes()
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'commit', message: 'x', all: true }), resTpl)
    expect(bodyOf(resTpl).error).toBe('git commit exited 1')

    const rejectSubprocess = {
      resolveExecutable: vi.fn(async () => '/usr/bin/git'),
      spawn: vi.fn(() => ({ done: Promise.reject(new Error('git action boom')), collected: {} })),
    } as unknown as SubprocessRuntime
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = rejectSubprocess
    const res4 = makeRes()
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'stage' }), res4)
    expect(bodyOf(res4).error).toBe('git action boom')

    const res5 = makeRes()
    await route.handler(makeReq('POST', '/api/workspace-ext/git/action', '127.0.0.1:52351', { path: '/repo', action: 'commit', message: 'x', all: true }), res5)
    expect(bodyOf(res5).error).toBe('git action boom')
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

  it('serves worktree and staged diffs, and untracked content for new files', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([
      { exitCode: 0, out: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n' },
    ])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const resolveFs = vi.fn(async (p: string, opts?: { cwd?: string }) => ({ key: `${opts?.cwd ?? ''}/${p}`, path: `${opts?.cwd ?? ''}/${p}` }))
    const fs = {
      resolve: resolveFs,
      readText: vi.fn(async () => 'brand new file\nline two\n'),
    } as unknown as FileSystem
    ;(ctx as unknown as Record<string, unknown>)['svc:fs'] = fs
    const route = byPath(routes, '/api/workspace-ext/diff')

    // Unstaged diff: `git diff -- file`.
    const res = makeRes()
    await route.handler(makeReq('GET', '/api/workspace-ext/diff?path=%2Frepo&file=a.ts&staged=0'), res)
    const body = bodyOf(res)
    expect(body.ok).toBe(true)
    const firstArgv = ((subprocess.spawn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { argv: string[] }).argv
    expect(firstArgv).toEqual(['/usr/bin/git', 'diff', '--', 'a.ts'])
    expect(body.diff).toContain('@@ -1 +1 @@')
    expect(body.untracked).toBe(false)

    // Staged diff: `git diff --cached -- file`.
    const resStaged = makeRes()
    await route.handler(makeReq('GET', '/api/workspace-ext/diff?path=%2Frepo&file=a.ts&staged=1'), resStaged)
    expect(bodyOf(resStaged).ok).toBe(true)
    const stagedArgv = ((subprocess.spawn as ReturnType<typeof vi.fn>).mock.calls[1]![0] as { argv: string[] }).argv
    expect(stagedArgv).toEqual(['/usr/bin/git', 'diff', '--cached', '--', 'a.ts'])

    // An untracked file has no diff output: the route falls back to reading
    // the current content through the filesystem.
    ;(subprocess.spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      done: Promise.resolve({ exitCode: 0, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
    }))
    const resNew = makeRes()
    await route.handler(makeReq('GET', '/api/workspace-ext/diff?path=%2Frepo&file=new.txt&staged=0'), resNew)
    const newBody = bodyOf(resNew)
    expect(newBody.untracked).toBe(true)
    expect(newBody.content).toBe('brand new file\nline two\n')
    expect(resolveFs).toHaveBeenCalledWith('new.txt', { cwd: '/repo' })

    // Missing parameters → 400; git failure surfaces its message.
    const resMissing = makeRes()
    await route.handler(makeReq('GET', '/api/workspace-ext/diff?path=%2Frepo'), resMissing)
    expect((resMissing as unknown as { status: number }).status).toBe(400)
    const resMissingRoot = makeRes()
    await route.handler(makeReq('GET', '/api/workspace-ext/diff?file=a.ts&staged=0'), resMissingRoot)
    expect((resMissingRoot as unknown as { status: number }).status).toBe(400)
    ;(subprocess.spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      done: Promise.resolve({ exitCode: 128, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: 'fatal: not a git repo', nextOffset: 0, lossy: false }) },
      },
    }))
    const resFail = makeRes()
    await route.handler(makeReq('GET', '/api/workspace-ext/diff?path=%2Frepo&file=a.ts&staged=0'), resFail)
    expect(bodyOf(resFail).error).toBe('fatal: not a git repo')

    // A git failure with empty streams falls back to the exit code message.
    ;(subprocess.spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      done: Promise.resolve({ exitCode: 129, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
    }))
    const resCode = makeRes()
    await route.handler(makeReq('GET', '/api/workspace-ext/diff?path=%2Frepo&file=a.ts&staged=0'), resCode)
    expect(bodyOf(resCode).error).toBe('git diff exited 129')

    // A git failure with only stdout prefers it over the exit code.
    ;(subprocess.spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      done: Promise.resolve({ exitCode: 130, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: 'stdout noise', nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
    }))
    const resOut = makeRes()
    await route.handler(makeReq('GET', '/api/workspace-ext/diff?path=%2Frepo&file=a.ts&staged=0'), resOut)
    expect(bodyOf(resOut).error).toBe('stdout noise')

    // Untracked fallback without the filesystem service reports the gap.
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    ;(ctx as unknown as Record<string, unknown>)['svc:fs'] = undefined
    ;(subprocess.spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      done: Promise.resolve({ exitCode: 0, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
    }))
    const resNoFs = makeRes()
    await route.handler(makeReq('GET', '/api/workspace-ext/diff?path=%2Frepo&file=new.txt&staged=0'), resNoFs)
    expect(bodyOf(resNoFs).error).toBe('filesystem service unavailable')
  })

  it('spawns, streams, writes, kills and reports the terminal', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const spawnRoute = byPath(routes, '/api/workspace-ext/term/spawn')
    const streamRoute = byPath(routes, '/api/workspace-ext/term/stream')

    // Spawn success returns a session id; the spec carries a real terminal
    // type so `clear` works, like VS Code.
    const res = makeRes()
    await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), res)
    const spawnBody = bodyOf(res)
    expect(spawnBody.ok).toBe(true)
    expect(spawnBody.id).toBe('term-1')
    const expectedShell = process.env.SHELL !== undefined && process.env.SHELL !== '' ? process.env.SHELL : '/bin/zsh'
    expect((subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual({
      argv: [expectedShell],
      cwd: '/repo',
      name: 'xterm-256color',
      rows: 30,
      cols: 120,
      graceMs: 3000,
    })
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

    // Output arriving before any stream is open accumulates in the buffer,
    // is capped, and drains into the first stream connection.
    const t = await terminal
    t.output.emit('data', Buffer.from('prompt$ '))
    t.output.emit('data', Buffer.from('x'.repeat(70000)))
    const reqStream = makeReq('GET', '/api/workspace-ext/term/stream?session=term-1')
    const resStream = makeSseRes()
    await streamRoute.handler(reqStream, resStream)
    const drained = ssePayloads(resStream)
    expect(drained.length).toBe(1)
    expect(drained[0]!.out.length).toBe(65536)
    expect(drained[0]!.exited).toBe(false)

    // Live output forwards to the connected stream immediately.
    t.output.emit('data', Buffer.from('live-chunk'))
    await new Promise(resolve => setImmediate(resolve))
    const live = ssePayloads(resStream)
    expect(live[live.length - 1]!.out).toBe('live-chunk')

    // Write delivers text; then the terminal exits via done and the stream
    // receives the exit signal.
    const resWrite = makeRes()
    await byPath(routes, '/api/workspace-ext/term/write').handler(
      makeReq('POST', '/api/workspace-ext/term/write', '127.0.0.1:52351', { session: 'term-1', text: 'ls\n' }), resWrite)
    expect(bodyOf(resWrite).ok).toBe(true)
    expect(t.writes).toEqual(['ls\n'])

    t.resolveDone({ code: 0 })
    await t.done
    await new Promise(resolve => setImmediate(resolve))
    const exitedFrames = ssePayloads(resStream)
    expect(exitedFrames[exitedFrames.length - 1]!.exited).toBe(true)

    // Status reflects liveness.
    const resStatus = makeRes()
    await byPath(routes, '/api/workspace-ext/term/status').handler(makeReq('GET', '/api/workspace-ext/term/status?session=term-1'), resStatus)
    const status = bodyOf(resStatus)
    expect(status.ok).toBe(true)
    expect(status.running).toBe(true)

    // A stream opened against a dead terminal answers with the exit signal
    // and closes instead of hanging.
    const resDead = makeSseRes()
    await streamRoute.handler(makeReq('GET', '/api/workspace-ext/term/stream?session=term-1'), resDead)
    expect(ssePayloads(resDead)[0]!.exited).toBe(true)

    // An unknown session stream answers the same way.
    const resGhost = makeSseRes()
    await streamRoute.handler(makeReq('GET', '/api/workspace-ext/term/stream?session=term-99'), resGhost)
    expect(ssePayloads(resGhost)[0]!.exited).toBe(true)

    // Kill terminates and clears, notifying live streams out-of-band.
    const reqStream2 = makeReq('GET', '/api/workspace-ext/term/stream?session=term-1')
    const resStream2 = makeSseRes()
    await streamRoute.handler(reqStream2, resStream2)
    const resKill = makeRes()
    await byPath(routes, '/api/workspace-ext/term/kill').handler(
      makeReq('POST', '/api/workspace-ext/term/kill', '127.0.0.1:52351', { session: 'term-1' }), resKill)
    expect(bodyOf(resKill).ok).toBe(true)
    expect(t.terminated).toBe(true)
    await new Promise(resolve => setImmediate(resolve))
    const killFrames = ssePayloads(resStream2)
    expect(killFrames[killFrames.length - 1]!.exited).toBe(true)
    const resStatus2 = makeRes()
    await byPath(routes, '/api/workspace-ext/term/status').handler(makeReq('GET', '/api/workspace-ext/term/status?session=term-1'), resStatus2)
    expect(bodyOf(resStatus2).error).toBe('unknown session')

    // Write with an unknown session → error.
    const resNoTerm = makeRes()
    await byPath(routes, '/api/workspace-ext/term/write').handler(
      makeReq('POST', '/api/workspace-ext/term/write', '127.0.0.1:52351', { session: 'term-1', text: 'x' }), resNoTerm)
    expect(bodyOf(resNoTerm).error).toBe('unknown session')

    // Killing an unknown or non-string session is an error too.
    const resKillGhost = makeRes()
    await byPath(routes, '/api/workspace-ext/term/kill').handler(
      makeReq('POST', '/api/workspace-ext/term/kill', '127.0.0.1:52351', { session: 'term-99' }), resKillGhost)
    expect(bodyOf(resKillGhost).error).toBe('unknown session')
    const resKillBad = makeRes()
    await byPath(routes, '/api/workspace-ext/term/kill').handler(
      makeReq('POST', '/api/workspace-ext/term/kill', '127.0.0.1:52351', { session: 123 }), resKillBad)
    expect(bodyOf(resKillBad).error).toBe('unknown session')

    // Disconnect the live subscribers so no test leaks into the next one.
    closeStream(reqStream)
    closeStream(reqStream2)
  })

  it('runs several sessions side by side and respawns one in place', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const spawnRoute = byPath(routes, '/api/workspace-ext/term/spawn')
    const streamRoute = byPath(routes, '/api/workspace-ext/term/stream')

    // Two GUI terminals = two independent sessions (split panes).
    const resA0 = makeRes()
    await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resA0)
    const idA = bodyOf(resA0).id as string
    const resB = makeRes()
    await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resB)
    const idB = bodyOf(resB).id as string
    expect(idB).not.toBe(idA)
    const all = (subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mock.results
    const terminalA = await all[0]!.value as Promise<FakeTerminal>
    const terminalB = await all[1]!.value as Promise<FakeTerminal>

    // Each session streams its own output.
    const reqA = makeReq('GET', `/api/workspace-ext/term/stream?session=${idA}`)
    const resA = makeSseRes()
    await streamRoute.handler(reqA, resA)
    ;(await terminalA).output.emit('data', Buffer.from('A-out'))
    await new Promise(resolve => setImmediate(resolve))
    expect(ssePayloads(resA)[0]!.out).toBe('A-out')
    ;(await terminalB).output.emit('data', Buffer.from('B-out'))
    await new Promise(resolve => setImmediate(resolve))
    expect(ssePayloads(resA).length).toBe(1)

    // Writes address the right session.
    const resWriteB = makeRes()
    await byPath(routes, '/api/workspace-ext/term/write').handler(
      makeReq('POST', '/api/workspace-ext/term/write', '127.0.0.1:52351', { session: idB, text: 'hi\n' }), resWriteB)
    expect(bodyOf(resWriteB).ok).toBe(true)
    expect((await terminalB).writes).toEqual(['hi\n'])
    expect((await terminalA).writes).toEqual([])

    // Respawn B in place: same id, a fresh handle, subscribers intact.
    const oldHandle = await terminalB
    const resRespawn = makeRes()
    await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo', session: idB }), resRespawn)
    expect(bodyOf(resRespawn).id).toBe(idB)
    expect(oldHandle.terminated).toBe(true)
    const newHandle = await all[2]!.value as Promise<FakeTerminal>
    ;(await newHandle).output.emit('data', Buffer.from('B2'))
    await new Promise(resolve => setImmediate(resolve))
    expect(ssePayloads(resA).length).toBe(1) // A's stream untouched
    const reqB2 = makeReq('GET', `/api/workspace-ext/term/stream?session=${idB}`)
    const resB2 = makeSseRes()
    await streamRoute.handler(reqB2, resB2)
    expect(ssePayloads(resB2)[0]!.out).toBe('B2')

    // The old handle's exit must not latch onto the respawned session.
    oldHandle.resolveDone({ code: 0 })
    await oldHandle.done
    const resStatus = makeRes()
    await byPath(routes, '/api/workspace-ext/term/status').handler(makeReq('GET', `/api/workspace-ext/term/status?session=${idB}`), resStatus)
    expect(bodyOf(resStatus).exited).toBe(false)

    closeStream(reqA)
    closeStream(reqB2)
  })

  it('resizes the running terminal and rejects bad dimensions', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const resizeRoute = byPath(routes, '/api/workspace-ext/term/resize')

    // Unknown session → error.
    const resNone = makeRes()
    await resizeRoute.handler(makeReq('POST', '/api/workspace-ext/term/resize', '127.0.0.1:52351', { session: 'term-9', cols: 80, rows: 24 }), resNone)
    expect(bodyOf(resNone).error).toBe('unknown session')

    // Spawn, then a valid resize forwards to the handle.
    const resSpawn = makeRes()
    await byPath(routes, '/api/workspace-ext/term/spawn').handler(
      makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resSpawn)
    const idA = bodyOf(resSpawn).id as string
    const terminal = await ((subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mock.results[0]!.value as Promise<FakeTerminal>)
    const res = makeRes()
    await resizeRoute.handler(makeReq('POST', '/api/workspace-ext/term/resize', '127.0.0.1:52351', { session: idA, cols: 96, rows: 40 }), res)
    expect(bodyOf(res).ok).toBe(true)
    expect(terminal.resizes).toEqual([{ cols: 96, rows: 40 }])

    // Degenerate or missing dimensions → 400.
    for (const bad of [{ cols: 1, rows: 24 }, { cols: 80, rows: 0 }, { cols: 'x', rows: 24 }, {}]) {
      const resBad = makeRes()
      await resizeRoute.handler(makeReq('POST', '/api/workspace-ext/term/resize', '127.0.0.1:52351', { session: idA, ...bad }), resBad)
      expect((resBad as unknown as { status: number }).status).toBe(400)
    }

    // A handle without resize support reports the gap.
    ;(subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce(Object.assign(new FakeTerminal(), { resize: undefined }))
    const resSpawn2 = makeRes()
    await byPath(routes, '/api/workspace-ext/term/spawn').handler(
      makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resSpawn2)
    const idB = bodyOf(resSpawn2).id as string
    const resUnsupported = makeRes()
    await resizeRoute.handler(makeReq('POST', '/api/workspace-ext/term/resize', '127.0.0.1:52351', { session: idB, cols: 80, rows: 24 }), resUnsupported)
    expect(bodyOf(resUnsupported).error).toBe('resize unsupported')

    // A rejecting resize surfaces its message.
    ;(subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Object.assign(new FakeTerminal(), {
        resize: async (): Promise<void> => { throw new Error('pty gone') },
      }),
    )
    const resSpawn3 = makeRes()
    await byPath(routes, '/api/workspace-ext/term/spawn').handler(
      makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resSpawn3)
    const idC = bodyOf(resSpawn3).id as string
    const resReject = makeRes()
    await resizeRoute.handler(makeReq('POST', '/api/workspace-ext/term/resize', '127.0.0.1:52351', { session: idC, cols: 80, rows: 24 }), resReject)
    expect(bodyOf(resReject).error).toBe('pty gone')

    // A non-Error rejection payload falls back to String().
    ;(subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      Object.assign(new FakeTerminal(), {
        resize: async (): Promise<void> => { throw 'plain resize boom' },
      }),
    )
    const resSpawn4 = makeRes()
    await byPath(routes, '/api/workspace-ext/term/spawn').handler(
      makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resSpawn4)
    const idD = bodyOf(resSpawn4).id as string
    const resRejectPlain = makeRes()
    await resizeRoute.handler(makeReq('POST', '/api/workspace-ext/term/resize', '127.0.0.1:52351', { session: idD, cols: 80, rows: 24 }), resRejectPlain)
    expect(bodyOf(resRejectPlain).error).toBe('plain resize boom')
  })

  it('keeps a replaced terminal from marking the current one exited', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const spawnRoute = byPath(routes, '/api/workspace-ext/term/spawn')

    const resA = makeRes()
    await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resA)
    expect(bodyOf(resA).ok).toBe(true)
    const terminalAPromise = (subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mock.results[0]!.value as Promise<FakeTerminal>
    const terminalA = await terminalAPromise

    // A second spawn (a fresh page auto-connect) replaces the current handle.
    const resB = makeRes()
    await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resB)
    const idB = bodyOf(resB).id as string
    const terminalBPromise = (subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mock.results[1]!.value as Promise<FakeTerminal>
    const terminalB = await terminalBPromise

    // The replaced session finishing must not latch exited onto the current one.
    terminalA.resolveDone({ code: 0 })
    await terminalA.done
    terminalA.output.emit('end')
    const reqStream = makeReq('GET', `/api/workspace-ext/term/stream?session=${idB}`)
    const resStream = makeSseRes()
    await byPath(routes, '/api/workspace-ext/term/stream').handler(reqStream, resStream)
    // A live connection starts silent: no buffered output, no exit signal.
    expect(ssePayloads(resStream)).toEqual([])

    // The current session's stream ending marks it exited.
    terminalB.output.emit('end')
    await new Promise(resolve => setImmediate(resolve))
    const framesMid = ssePayloads(resStream)
    expect(framesMid[framesMid.length - 1]!.exited).toBe(true)

    // The current session's done resolution keeps it exited.
    terminalB.resolveDone({ code: 0 })
    await terminalB.done
    await new Promise(resolve => setImmediate(resolve))
    const framesDone = ssePayloads(resStream)
    expect(framesDone[framesDone.length - 1]!.exited).toBe(true)
    closeStream(reqStream)
  })

  it('latches a rejecting done to the handle that rejected', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const spawnRoute = byPath(routes, '/api/workspace-ext/term/spawn')

    await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), makeRes())
    const terminalAPromise = (subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mock.results[0]!.value as Promise<FakeTerminal>
    const terminalA = await terminalAPromise
    const resB = makeRes()
    await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resB)
    const idB = bodyOf(resB).id as string
    const terminalBPromise = (subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mock.results[1]!.value as Promise<FakeTerminal>
    const terminalB = await terminalBPromise

    // The replaced session rejecting must not latch exited onto the current one.
    terminalA.rejectDone(new Error('pty closed'))
    await terminalA.done.catch(() => { /* expected rejection */ })
    const reqStream = makeReq('GET', `/api/workspace-ext/term/stream?session=${idB}`)
    const resStream = makeSseRes()
    await byPath(routes, '/api/workspace-ext/term/stream').handler(reqStream, resStream)
    expect(ssePayloads(resStream)).toEqual([])

    // The current session rejecting marks the terminal exited.
    terminalB.rejectDone(new Error('pty closed'))
    await terminalB.done.catch(() => { /* expected rejection */ })
    await new Promise(resolve => setImmediate(resolve))
    const frames = ssePayloads(resStream)
    expect(frames[frames.length - 1]!.exited).toBe(true)
    closeStream(reqStream)
  })

  it('spawns the user default shell, falling back per platform', async () => {
    const { ctx, routes } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const spawnRoute = byPath(routes, '/api/workspace-ext/term/spawn')
    const spawnSpecs = (subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mock.calls as Array<[{ argv: string[] }]>

    const realShell = process.env.SHELL
    const realPlatform = process.platform
    try {
      // SHELL set → used verbatim.
      process.env.SHELL = '/opt/homebrew/bin/zsh'
      const res = makeRes()
      await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), res)
      expect(bodyOf(res).ok).toBe(true)
      expect(spawnSpecs[0]![0].argv[0]).toBe('/opt/homebrew/bin/zsh')

      // SHELL unset → macOS defaults to zsh, everywhere else to bash.
      process.env.SHELL = ''
      const resMac = makeRes()
      await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resMac)
      expect(spawnSpecs[1]![0].argv[0]).toBe('/bin/zsh')

      Object.defineProperty(process, 'platform', { value: 'linux' })
      const resLinux = makeRes()
      await spawnRoute.handler(makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resLinux)
      expect(spawnSpecs[2]![0].argv[0]).toBe('/bin/bash')
    } finally {
      if (realShell === undefined) delete process.env.SHELL
      else process.env.SHELL = realShell
      Object.defineProperty(process, 'platform', { value: realPlatform })
    }
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
    const idA = bodyOf(resSpawn).id as string
    const resWriteFail = makeRes()
    await writeRoute.handler(makeReq('POST', '/api/workspace-ext/term/write', '127.0.0.1:52351', { session: idA, text: 'x' }), resWriteFail)
    expect(bodyOf(resWriteFail).error).toBe('eio')

    // Terminate rejection is swallowed by the cleanup disposer.
    badTerminal.terminate = vi.fn(async () => { throw new Error('gone') })
    const resKill = makeRes()
    await byPath(routes, '/api/workspace-ext/term/kill').handler(
      makeReq('POST', '/api/workspace-ext/term/kill', '127.0.0.1:52351', { session: idA }), resKill)
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
    const idA = bodyOf(res).id as string
    t.output.emit('data', 'raw-string-chunk')
    const reqStream = makeReq('GET', `/api/workspace-ext/term/stream?session=${idA}`)
    const resStream = makeSseRes()
    await byPath(routes, '/api/workspace-ext/term/stream').handler(reqStream, resStream)
    expect(ssePayloads(resStream)[0]!.out).toBe('raw-string-chunk')
    closeStream(reqStream)
  })

  it('cleanup disposers terminate every active terminal', async () => {
    const { ctx, routes, disposers } = bench()
    const subprocess = fakeSubprocess([])
    ;(ctx as unknown as Record<string, unknown>)['svc:subprocess'] = subprocess
    const resS1 = makeRes()
    await byPath(routes, '/api/workspace-ext/term/spawn').handler(
      makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resS1)
    const idA = bodyOf(resS1).id as string
    const resS2 = makeRes()
    await byPath(routes, '/api/workspace-ext/term/spawn').handler(
      makeReq('POST', '/api/workspace-ext/term/spawn', '127.0.0.1:52351', { cwd: '/repo' }), resS2)
    const idB = bodyOf(resS2).id as string
    const all = (subprocess.spawnTerminal as ReturnType<typeof vi.fn>).mock.results
    const t1 = await (all[0]!.value as Promise<FakeTerminal>)
    const t2 = await (all[1]!.value as Promise<FakeTerminal>)
    for (const dispose of disposers) dispose()
    expect(t1.terminated).toBe(true)
    expect(t2.terminated).toBe(true)
    // A second pass is an idempotent no-op.
    for (const dispose of disposers) dispose()
    const resStatus = makeRes()
    await byPath(routes, '/api/workspace-ext/term/status').handler(makeReq('GET', `/api/workspace-ext/term/status?session=${idA}`), resStatus)
    expect(bodyOf(resStatus).error).toBe('unknown session')
    const resStatusB = makeRes()
    await byPath(routes, '/api/workspace-ext/term/status').handler(makeReq('GET', `/api/workspace-ext/term/status?session=${idB}`), resStatusB)
    expect(bodyOf(resStatusB).error).toBe('unknown session')
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
    const idA = bodyOf(res).id as string
    // let the rejection propagate through the catch handler
    await new Promise((resolve) => { queueMicrotask(() => { resolve(undefined) }) })
    const reqStream = makeReq('GET', `/api/workspace-ext/term/stream?session=${idA}`)
    const resStream = makeSseRes()
    await byPath(routes, '/api/workspace-ext/term/stream').handler(reqStream, resStream)
    expect(ssePayloads(resStream)[0]!.exited).toBe(true)
    closeStream(reqStream)
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
    const idA = bodyOf(resSpawn).id as string
    const resWrite = makeRes()
    await byPath(routes, '/api/workspace-ext/term/write').handler(
      makeReq('POST', '/api/workspace-ext/term/write', '127.0.0.1:52351', { session: idA }), resWrite)
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
    const idB = bodyOf(resSpawn2).id as string
    const resWrite = makeRes()
    await byPath(routes, '/api/workspace-ext/term/write').handler(
      makeReq('POST', '/api/workspace-ext/term/write', '127.0.0.1:52351', { session: idB, text: 'x' }), resWrite)
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
