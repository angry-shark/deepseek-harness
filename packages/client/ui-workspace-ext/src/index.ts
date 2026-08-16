/**
 * Workspace enhancements, node half: the host end of the git-branch and
 * terminal features.
 *
 * Registers same-origin HTTP routes under /api/workspace-ext that the browser
 * half calls to read the git branch of the active workspace, list and switch
 * local branches, and drive one bash terminal per process. The surface can
 * run git and start/feed a shell, so every handler refuses non-loopback Host
 * headers (DNS-rebinding defense).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'
// Empty type imports carry the webServer Context merge.
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Cordis plugin name. */
export const name = 'workspace-ext'

/** Required services: the route registry. */
export const inject = ['webServer']

/** Route prefix shared by the terminal endpoints. */
const TERMINAL_ROUTE = '/api/workspace-ext/term'

/** In-memory terminal output cap; the browser polls incrementally. */
const TERMINAL_BUFFER_CAP = 65536

/** One process-scoped terminal session: handle, unread output buffer, exit flag. */
const term = { handle: null as SubprocessTerminalHandle | null, buffer: '', exited: true, decoder: new TextDecoder() }

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** DNS-rebinding defense: only loopback Host headers may touch this surface. */
function loopbackHost(req: IncomingMessage): boolean {
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
}

/** Read a JSON request body; malformed or missing payloads resolve to {}. */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>
      } catch {
        // malformed JSON — treat as empty payload
      }
      resolve(body)
    })
    req.on('error', () => { resolve({}) })
  })
}

/** The user's default shell (zsh on macOS when unset), like the VS Code terminal. */
function userShell(): string {
  const explicit = process.env.SHELL
  if (typeof explicit === 'string' && explicit !== '') return explicit
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

/** Read .git/HEAD, following the gitdir-pointer file form used by worktrees/submodules. */
async function readGitHead(fs: FileSystem, root: string): Promise<string | null> {
  try {
    const target = await fs.resolve('.git/HEAD', { cwd: root })
    return await fs.readText(target)
  } catch {
    // .git may be a plain file (worktree/submodule) — fall through
  }
  try {
    const gitTarget = await fs.resolve('.git', { cwd: root })
    const git = await fs.readText(gitTarget)
    const m = /^gitdir:\s*(.+)$/m.exec(git)
    if (m === null) return null
    /* v8 ignore next -- the capture group always matches when the regex matched, so the fallback arm cannot run */
    const p = m[1] !== undefined ? m[1].trim() : ''
    const headPath = p.startsWith('/') ? `${p}/HEAD` : `${root}/${p}/HEAD`
    const target = await fs.resolve(headPath)
    return await fs.readText(target)
  } catch {
    return null
  }
}

/** Run one git command in a repo root, collecting stdout/stderr. */
type GitRun = { exitCode: number | null; out: string; err: string }

/** One working-tree change row from `git status --porcelain`. */
export interface GitStatusChange {
  /** The staged-side status code (index column). */
  index: string
  /** The unstaged-side status code (worktree column). */
  worktree: string
  /** The changed path, unquoted. */
  path: string
}

/** Parsed `git status --porcelain=v1 --branch` output. */
export interface GitStatus {
  /** The checked-out branch name, or null on a detached HEAD. */
  branch: string | null
  /** Commits ahead of the upstream (0 when none is tracked). */
  ahead: number
  /** Commits behind the upstream (0 when none is tracked). */
  behind: number
  /** Every non-branch line, in porcelain order. */
  changes: GitStatusChange[]
}

/**
 * Parse `git status --porcelain=v1 --branch` output: the `##` header carries
 * the branch and ahead/behind counts, every following line is one
 * two-column status code plus a path. The header's bracket section holds the
 * upstream delta; the branch slot reads `HEAD (no branch)` (detached) or the
 * branch name, and an unborn branch reports `No commits yet on <name>`.
 */
export function parseGitStatus(out: string): GitStatus {
  const status: GitStatus = { branch: null, ahead: 0, behind: 0, changes: [] }
  const lines = out.split('\n')
  let bodyStart = 0
  /* v8 ignore next -- split always yields at least one element, so the empty fallback cannot run */
  const header = lines[0] ?? ''
  if (header.startsWith('## ')) {
    bodyStart = 1
    let rest = header.slice(3)
    const bracket = / \[(.*)\]$/.exec(rest)
    let delta = ''
    if (bracket !== null) {
      /* v8 ignore next -- the capture group always matched when the regex matched, so the fallback arm cannot run */
      delta = bracket[1] ?? ''
      rest = rest.slice(0, -bracket[0].length)
    }
    /* v8 ignore next -- split always yields at least one element, so the empty fallback cannot run */
    const name = rest.split('...')[0] ?? ''
    const unborn = /^No commits yet on (.+)$/.exec(name)
    const detached = name === 'HEAD (no branch)'
    /* v8 ignore next -- the capture group always matched when the regex matched, so the fallback arm cannot run */
    if (unborn !== null) status.branch = unborn[1] ?? null
    else if (!detached) status.branch = name === '' ? null : name
    const aheadMatch = /ahead (\d+)/.exec(delta)
    const behindMatch = /behind (\d+)/.exec(delta)
    status.ahead = aheadMatch === null ? 0 : Number(aheadMatch[1])
    status.behind = behindMatch === null ? 0 : Number(behindMatch[1])
  }
  for (const line of lines.slice(bodyStart)) {
    if (line === '') continue
    const code = line.slice(0, 2)
    const path = line.length > 3 ? line.slice(3) : ''
    if (code === '  ') continue
    /* v8 ignore next -- a non-empty line always has at least its first character, so both fallback arms cannot run */
    status.changes.push({ index: code[0] ?? '', worktree: code[1] ?? '', path })
  }
  return status
}

async function runGit(subprocess: SubprocessRuntime, root: string, args: string[]): Promise<GitRun> {
  let git = 'git'
  try {
    const resolved = await subprocess.resolveExecutable('git')
    if (typeof resolved === 'string' && resolved !== '') git = resolved
  } catch {
    // keep the bare name
  }
  const handle = subprocess.spawn({
    argv: [git, ...args],
    cwd: root,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 131072 },
      stderr: { maxBytes: 131072 },
    },
    graceMs: 15000,
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  return {
    exitCode: outcome.exitCode,
    out: stdout === undefined ? '' : stdout.text,
    err: stderr === undefined ? '' : stderr.text,
  }
}

function disposeTerm(): void {
  const handle = term.handle
  term.handle = null
  term.exited = true
  if (handle !== null) {
    void handle.terminate().catch(() => { /* ignore */ })
  }
}

/**
 * Mount the git and terminal routes.
 * @param ctx - host plugin context carrying webServer.
 */
export function apply(ctx: Context): void {
  const webServer = ctx.webServer

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/workspace-ext/branch',
    handler: async (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      const fs = ctx.get('fs')
      /* v8 ignore next -- node:http always sets url on server requests */
      const url = new URL(req.url ?? '/', 'http://x')
      const root = url.searchParams.get('path') ?? ''
      if (fs === undefined || root === '') { json(res, 400, { ok: false, error: 'missing path' }); return }
      // readGitHead never throws: both internal branches swallow and return null.
      const head = await readGitHead(fs, root)
      if (head === null) { json(res, 200, { ok: true, branch: null, detached: false, path: root }); return }
      const trimmed = head.trim()
      if (trimmed === '') { json(res, 200, { ok: true, branch: null, detached: false, path: root }); return }
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(trimmed)
      if (ref !== null) { json(res, 200, { ok: true, branch: ref[1], detached: false, path: root }); return }
      json(res, 200, { ok: true, branch: trimmed.slice(0, 7), detached: true, path: root })
    },
  }), 'workspace-ext: branch route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/workspace-ext/branches',
    handler: async (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      const subprocess = ctx.get('subprocess')
      /* v8 ignore next -- node:http always sets url on server requests */
      const url = new URL(req.url ?? '/', 'http://x')
      const root = url.searchParams.get('path') ?? ''
      if (subprocess === undefined || root === '') { json(res, 400, { ok: false, error: 'missing path' }); return }
      try {
        const r = await runGit(subprocess, root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
        if (r.exitCode !== 0) { json(res, 200, { ok: false, error: (r.err || r.out || `git exited ${r.exitCode}`).trim() }); return }
        const branches = r.out.split('\n').map(s => s.trim()).filter(s => s !== '')
        json(res, 200, { ok: true, branches })
      } catch (error) {
        /* v8 ignore next -- lint-enforced Error-only test rejections leave the String fallback uncovered */
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'workspace-ext: branches route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/workspace-ext/checkout',
    handler: async (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      const subprocess = ctx.get('subprocess')
      const args = await readBody(req)
      const root = typeof args.path === 'string' ? args.path : ''
      const branch = typeof args.branch === 'string' ? args.branch : ''
      if (subprocess === undefined || root === '' || branch === '') { json(res, 400, { ok: false, error: 'missing path or branch' }); return }
      try {
        const r = await runGit(subprocess, root, ['checkout', branch])
        if (r.exitCode !== 0) { json(res, 200, { ok: false, error: (r.err || r.out || `git checkout exited ${r.exitCode}`).trim() }); return }
        json(res, 200, { ok: true, message: (r.out || r.err || '').trim() })
      } catch (error) {
        /* v8 ignore next -- lint-enforced Error-only test rejections leave the String fallback uncovered */
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'workspace-ext: checkout route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/workspace-ext/status',
    handler: async (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      const subprocess = ctx.get('subprocess')
      /* v8 ignore next -- node:http always sets url on server requests */
      const url = new URL(req.url ?? '/', 'http://x')
      const root = url.searchParams.get('path') ?? ''
      if (subprocess === undefined || root === '') { json(res, 400, { ok: false, error: 'missing path' }); return }
      try {
        const r = await runGit(subprocess, root, ['status', '--porcelain=v1', '--branch'])
        if (r.exitCode !== 0) { json(res, 200, { ok: false, error: (r.err || r.out || `git exited ${r.exitCode}`).trim() }); return }
        const parsed = parseGitStatus(r.out)
        json(res, 200, { ok: true, ...parsed })
      } catch (error) {
        /* v8 ignore next -- lint-enforced Error-only test rejections leave the String fallback uncovered */
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'workspace-ext: status route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${TERMINAL_ROUTE}/spawn`,
    handler: async (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      const subprocess = ctx.get('subprocess')
      if (subprocess === undefined) { json(res, 200, { ok: false, error: 'subprocess service unavailable' }); return }
      const args = await readBody(req)
      const cwd = typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : undefined
      if (cwd === undefined) { json(res, 400, { ok: false, error: 'missing cwd' }); return }
      try {
        const handle = await subprocess.spawnTerminal({
          argv: [userShell()],
          cwd,
          rows: 30,
          cols: 120,
          graceMs: 3000,
        })
        term.handle = handle
        term.buffer = ''
        term.exited = false
        handle.output.on('data', (chunk: Buffer) => {
          try {
            term.buffer += term.decoder.decode(chunk, { stream: true })
            if (term.buffer.length > TERMINAL_BUFFER_CAP) term.buffer = term.buffer.slice(term.buffer.length - TERMINAL_BUFFER_CAP)
          } catch {
            term.buffer += String(chunk)
          }
        })
        // Exit handlers are latched to the handle they were attached to: a
        // replaced session (a later spawn) must not mark the current one exited.
        handle.output.on('end', () => { if (term.handle === handle) term.exited = true })
        void handle.done.then(() => { if (term.handle === handle) term.exited = true })
          .catch(() => { if (term.handle === handle) term.exited = true })
        json(res, 200, { ok: true })
      } catch (error) {
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'workspace-ext: terminal spawn route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${TERMINAL_ROUTE}/write`,
    handler: async (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      const args = await readBody(req)
      if (term.handle === null) { json(res, 200, { ok: false, error: 'no terminal running' }); return }
      try {
        await term.handle.write(typeof args.text === 'string' ? args.text : '')
        json(res, 200, { ok: true })
      } catch (error) {
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'workspace-ext: terminal write route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${TERMINAL_ROUTE}/poll`,
    handler: (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      const out = term.buffer
      term.buffer = ''
      json(res, 200, { ok: true, out, exited: term.exited })
    },
  }), 'workspace-ext: terminal poll route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${TERMINAL_ROUTE}/kill`,
    handler: async (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      await readBody(req)
      disposeTerm()
      json(res, 200, { ok: true })
    },
  }), 'workspace-ext: terminal kill route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${TERMINAL_ROUTE}/status`,
    handler: (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      json(res, 200, { ok: true, running: term.handle !== null, exited: term.exited })
    },
  }), 'workspace-ext: terminal status route')

  ctx.effect(() => () => { disposeTerm() }, 'workspace-ext: terminal cleanup')
}
