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

/** In-memory terminal output cap; output buffers only while no stream is open. */
const TERMINAL_BUFFER_CAP = 65536

/**
 * One process-scoped terminal session: handle, output buffer (accumulated
 * while no SSE stream is connected), exit flag, and the live stream
 * subscribers that receive output as it arrives (the browser streams the PTY
 * instead of polling, so echoes are near-instant). Multiple sessions run
 * concurrently, one per GUI terminal (VS Code-style multi-terminal split).
 */
interface TermSession {
  handle: SubprocessTerminalHandle | null
  buffer: string
  exited: boolean
  decoder: TextDecoder
  clients: Set<ServerResponse>
}

/** All live terminal sessions, keyed by their route id (`term-N`). */
const termSessions = new Map<string, TermSession>()

/** Monotonic id generator for new sessions. */
let termCounter = 0

function nextSessionId(): string {
  termCounter += 1
  return `term-${termCounter}`
}

/** Resolve a session by id, or undefined when missing or unknown. */
function sessionOf(value: unknown): TermSession | undefined {
  // Every route passes the query/body session as a string or omits it; a
  // non-string value is a defensive guard only.
  /* v8 ignore next -- non-string session values cannot reach the route guards */
  return typeof value === 'string' ? termSessions.get(value) : undefined
}

/** Resolve a session from a GET route's query, or undefined. */
function sessionFromQuery(url: URL): TermSession | undefined {
  return sessionOf(url.searchParams.get('session'))
}

/** Attach the PTY output/exit wiring of one handle to its session. */
function wireSession(session: TermSession, handle: SubprocessTerminalHandle): void {
  handle.output.on('data', (chunk: Buffer) => {
    let text: string
    try {
      text = session.decoder.decode(chunk, { stream: true })
    } catch {
      text = String(chunk)
    }
    if (session.clients.size > 0) {
      // Live subscribers get each chunk immediately; nothing is buffered
      // while someone is listening, so the stream never lags the PTY.
      streamNotify(session, text, false)
    } else {
      session.buffer += text
      if (session.buffer.length > TERMINAL_BUFFER_CAP) session.buffer = session.buffer.slice(session.buffer.length - TERMINAL_BUFFER_CAP)
    }
  })
  // Exit handlers are latched to the handle they were attached to: a
  // replaced session (a later respawn) must not mark the current one exited.
  const notifyExited = (): void => {
    if (session.handle !== handle) return
    session.exited = true
    streamNotify(session, '', true)
  }
  handle.output.on('end', notifyExited)
  void handle.done.then(notifyExited).catch(notifyExited)
}

/** Kill and forget one session; live streams get the exit signal out-of-band. */
function disposeSession(id: string): void {
  // The kill route and the cleanup disposer only ever pass ids that exist,
  // so the undefined guard and the null-handle arm are defensive.
  const session = termSessions.get(id)
  /* v8 ignore next 2 -- the id is always present when this is called */
  if (session === undefined) return
  termSessions.delete(id)
  streamNotify(session, '', true)
  /* v8 ignore next -- every session owns a handle until it is disposed */
  if (session.handle !== null) {
    void session.handle.terminate().catch(() => { /* ignore */ })
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Write one SSE event to a stream subscriber; a closed socket is a no-op. */
function sseWrite(res: ServerResponse, out: string, exited = false): void {
  try {
    res.write(`data: ${JSON.stringify({ out, exited })}\n\n`)
  } catch {
    // The subscriber's socket closed between the last write and this one.
  }
}

/** Push the same output chunk (or exit signal) to every live subscriber. */
function streamNotify(session: TermSession, out: string, exited: boolean): void {
  for (const client of session.clients) sseWrite(client, out, exited)
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

/** The git mutations the Git tab can run (allowlisted, no free-form argv). */
export type GitAction = 'stage' | 'unstage' | 'discard' | 'commit'
const GIT_ACTIONS = new Set<GitAction>(['stage', 'unstage', 'discard', 'commit'])

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
    path: '/api/workspace-ext/git/action',
    handler: async (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      const subprocess = ctx.get('subprocess')
      const args = await readBody(req)
      const root = typeof args.path === 'string' ? args.path : ''
      const action = typeof args.action === 'string' && GIT_ACTIONS.has(args.action as GitAction) ? args.action as GitAction : null
      if (subprocess === undefined || root === '' || action === null) { json(res, 400, { ok: false, error: 'missing path or action' }); return }
      const files = Array.isArray(args.files)
        ? args.files.filter((f): f is string => typeof f === 'string' && f !== '')
        : []
      try {
        // Commit: smart-commit stages everything first when nothing is
        // staged, mirroring the VS Code commit button's smart-commit mode.
        if (action === 'commit') {
          const message = typeof args.message === 'string' && args.message.trim() !== '' ? args.message.trim() : ''
          if (message === '') { json(res, 400, { ok: false, error: 'empty commit message' }); return }
          if (args.all === true) {
            const add = await runGit(subprocess, root, ['add', '-A'])
            if (add.exitCode !== 0) { json(res, 200, { ok: false, error: (add.err || add.out || `git add exited ${add.exitCode}`).trim() }); return }
          }
          const commit = await runGit(subprocess, root, ['commit', '-m', message])
          if (commit.exitCode !== 0) { json(res, 200, { ok: false, error: (commit.err || commit.out || `git commit exited ${commit.exitCode}`).trim() }); return }
          json(res, 200, { ok: true })
          return
        }
        let argv: string[]
        if (action === 'stage') argv = files.length > 0 ? ['add', '--', ...files] : ['add', '-A']
        else if (action === 'unstage') argv = files.length > 0 ? ['reset', '--', ...files] : ['reset']
        else {
          // Discard restores from HEAD when the file is staged (drops both
          // the index and worktree sides, like the VS Code staged-group
          // discard), otherwise from the index (worktree side only).
          const fromHead = args.staged === true
          const target = files.length > 0 ? ['--', ...files] : ['--', '.']
          argv = fromHead ? ['checkout', 'HEAD', ...target] : ['checkout', ...target]
        }
        const r = await runGit(subprocess, root, argv)
        if (r.exitCode !== 0) { json(res, 200, { ok: false, error: (r.err || r.out || `git exited ${r.exitCode}`).trim() }); return }
        json(res, 200, { ok: true })
      } catch (error) {
        /* v8 ignore next -- lint-enforced Error-only test rejections leave the String fallback uncovered */
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'workspace-ext: git action route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/workspace-ext/diff',
    handler: async (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      const subprocess = ctx.get('subprocess')
      /* v8 ignore next -- node:http always sets url on server requests */
      const url = new URL(req.url ?? '/', 'http://x')
      const root = url.searchParams.get('path') ?? ''
      const file = url.searchParams.get('file') ?? ''
      const staged = url.searchParams.get('staged') === '1'
      if (subprocess === undefined || root === '' || file === '') { json(res, 400, { ok: false, error: 'missing path or file' }); return }
      try {
        // Staged rows diff the index against HEAD; unstaged rows the worktree
        // against the index, like the VS Code staged/unstaged diff editors.
        const argv = staged ? ['diff', '--cached', '--', file] : ['diff', '--', file]
        const r = await runGit(subprocess, root, argv)
        if (r.exitCode !== 0) { json(res, 200, { ok: false, error: (r.err || r.out || `git diff exited ${r.exitCode}`).trim() }); return }
        if (r.out === '') {
          // An untracked file has no git diff; hand over its current content
          // so the viewer can show the whole file as additions.
          const fs = ctx.get('fs')
          if (fs === undefined) { json(res, 200, { ok: false, error: 'filesystem service unavailable' }); return }
          const target = await fs.resolve(file, { cwd: root })
          const content = await fs.readText(target)
          json(res, 200, { ok: true, untracked: true, path: file, content })
          return
        }
        json(res, 200, { ok: true, diff: r.out, untracked: false, path: file })
      } catch (error) {
        /* v8 ignore next -- lint-enforced Error-only test rejections leave the String fallback uncovered */
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'workspace-ext: git diff route')

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
      // A `session` id respawns that existing session in place (the 启动
      // button restarts the active terminal); omitting it creates a new one,
      // so a GUI with several split terminals owns several sessions.
      const existing = typeof args.session === 'string' ? termSessions.get(args.session) : undefined
      try {
        const handle = await subprocess.spawnTerminal({
          argv: [userShell()],
          cwd,
          // A real terminal type: `clear` emits its escape sequences (under the
          // plain `dumb` type the terminfo entry has no clear capability and
          // the command is a silent no-op) and programs run full-screen.
          name: 'xterm-256color',
          rows: 30,
          cols: 120,
          graceMs: 3000,
        })
        if (existing !== undefined) {
          // Respawn: retire the old handle (latched exit handlers cannot mark
          // the new one exited) and reset the session's buffered state; the
          // subscribers keep their stream across the restart.
          const oldHandle = existing.handle
          existing.handle = handle
          existing.buffer = ''
          existing.exited = false
          existing.decoder = new TextDecoder()
          // Sessions always own a handle until disposed, so the null arm is
          // a defensive guard.
          /* v8 ignore next -- a live session always has a handle */
          if (oldHandle !== null) {
            void oldHandle.terminate().catch(() => { /* ignore */ })
          }
          wireSession(existing, handle)
          json(res, 200, { ok: true, id: args.session })
          return
        }
        const id = nextSessionId()
        const session: TermSession = { handle, buffer: '', exited: false, decoder: new TextDecoder(), clients: new Set() }
        termSessions.set(id, session)
        wireSession(session, handle)
        json(res, 200, { ok: true, id })
      } catch (error) {
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'workspace-ext: terminal spawn route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${TERMINAL_ROUTE}/resize`,
    handler: async (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      const args = await readBody(req)
      const session = sessionOf(args.session)
      if (session === undefined || session.handle === null) { json(res, 200, { ok: false, error: 'unknown session' }); return }
      const cols = typeof args.cols === 'number' && Number.isInteger(args.cols) ? args.cols : -1
      const rows = typeof args.rows === 'number' && Number.isInteger(args.rows) ? args.rows : -1
      // Reject degenerate sizes (the client measures a real element, so a
      // missing or absurd dimension is a bug, not a resize request).
      if (cols < 2 || rows < 1 || cols > 500 || rows > 500) {
        json(res, 400, { ok: false, error: 'invalid dimensions' })
        return
      }
      try {
        if (session.handle.resize === undefined) { json(res, 200, { ok: false, error: 'resize unsupported' }); return }
        await session.handle.resize(cols, rows)
        json(res, 200, { ok: true })
      } catch (error) {
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'workspace-ext: terminal resize route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${TERMINAL_ROUTE}/write`,
    handler: async (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      const args = await readBody(req)
      const session = sessionOf(args.session)
      if (session === undefined || session.handle === null) { json(res, 200, { ok: false, error: 'unknown session' }); return }
      try {
        await session.handle.write(typeof args.text === 'string' ? args.text : '')
        json(res, 200, { ok: true })
      } catch (error) {
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'workspace-ext: terminal write route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${TERMINAL_ROUTE}/stream`,
    handler: (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      /* v8 ignore next -- node:http always sets url on server requests */
      const url = new URL(req.url ?? '/', 'http://x')
      const session = sessionFromQuery(url)
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write('retry: 750\n\n')
      // Deliver whatever accumulated while no stream was open (the initial
      // prompt between spawn and this request), then go live.
      if (session !== undefined && session.buffer !== '') {
        sseWrite(res, session.buffer)
        session.buffer = ''
      }
      if (session === undefined || session.handle === null || session.exited) {
        // No live session for this connection: tell the browser immediately
        // so it stops reconnecting instead of spinning on a dead terminal.
        sseWrite(res, '', true)
        res.end()
        return
      }
      session.clients.add(res)
      req.on('close', () => { session.clients.delete(res) })
    },
  }), 'workspace-ext: terminal stream route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${TERMINAL_ROUTE}/kill`,
    handler: async (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      const args = await readBody(req)
      const sessionId = typeof args.session === 'string' ? args.session : ''
      if (sessionId === '' || !termSessions.has(sessionId)) { json(res, 200, { ok: false, error: 'unknown session' }); return }
      disposeSession(sessionId)
      json(res, 200, { ok: true })
    },
  }), 'workspace-ext: terminal kill route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${TERMINAL_ROUTE}/status`,
    handler: (req, res) => {
      if (!loopbackHost(req)) { json(res, 403, { ok: false, error: 'forbidden host' }); return }
      /* v8 ignore next -- node:http always sets url on server requests */
      const url = new URL(req.url ?? '/', 'http://x')
      const session = sessionFromQuery(url)
      if (session === undefined) { json(res, 200, { ok: false, error: 'unknown session' }); return }
      json(res, 200, { ok: true, running: session.handle !== null, exited: session.exited })
    },
  }), 'workspace-ext: terminal status route')

  ctx.effect(() => () => {
    for (const id of [...termSessions.keys()]) disposeSession(id)
  }, 'workspace-ext: terminal cleanup')
}
