/**
 * Same-origin HTTP client for the workspace-ext host routes. The node half
 * registers these routes under /api/workspace-ext; every response is a JSON
 * envelope with an `ok` flag. Kept as plain fetch calls so the browser half
 * needs no Host RPC plumbing for these process-local capabilities.
 */

/** Current-branch answer: branch name or short sha when detached. */
export interface GitBranchInfo {
  ok: boolean
  branch: string | null
  detached: boolean
  path: string
  error?: string
}

/** Local-branch list answer. */
export interface GitBranchesResult {
  ok: boolean
  branches?: string[]
  error?: string
}

/** Checkout answer with the git message when it succeeds. */
export interface GitCheckoutResult {
  ok: boolean
  message?: string
  error?: string
}

/** Terminal existence answer. */
export interface TermStatus {
  ok: boolean
  running: boolean
  exited: boolean
  error?: string
}

/** Working-tree status: branch + ahead/behind + porcelain change rows. */
export interface GitStatusInfo {
  ok: boolean
  branch: string | null
  ahead: number
  behind: number
  changes: Array<{ index: string; worktree: string; path: string }>
  error?: string
}

/** One git mutation (stage/unstage/discard/commit) answer. */
export interface GitActionResult {
  ok: boolean
  error?: string
}

/** One file's modification content for the Git tab diff viewer. */
export interface GitDiffResult {
  ok: boolean
  error?: string
  /** Unified diff text for a tracked file. */
  diff?: string
  /** True when the file is untracked and `content` carries the raw text. */
  untracked?: boolean
  /** The full file text when the file is untracked. */
  content?: string
  /** The changed path. */
  path?: string
}

/** Result of listing the branch's commit history. */
export interface GitLogResult {
  ok: boolean
  error?: string
  commits?: GitCommitInfo[]
}

/** One commit in the branch history. */
export interface GitCommitInfo {
  hash: string
  date: string
  author: string
  message: string
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  return response.json() as Promise<T>
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  // the empty-payload fallback is defensive: every exported helper passes an object
  /* v8 ignore next -- the `?? {}` right arm cannot be reached by the exported helpers */
  const payload = JSON.stringify(body ?? {})
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })
  return response.json() as Promise<T>
}

/** The workspace-ext host API surface. */
export const api = {
  gitBranch: (path: string): Promise<GitBranchInfo> =>
    getJson(`/api/workspace-ext/branch?path=${encodeURIComponent(path)}`),
  gitBranches: (path: string): Promise<GitBranchesResult> =>
    getJson(`/api/workspace-ext/branches?path=${encodeURIComponent(path)}`),
  gitCheckout: (path: string, branch: string): Promise<GitCheckoutResult> =>
    postJson('/api/workspace-ext/checkout', { path, branch }),
  gitStatus: (path: string): Promise<GitStatusInfo> =>
    getJson(`/api/workspace-ext/status?path=${encodeURIComponent(path)}`),
  gitDiff: (path: string, file: string, staged: boolean): Promise<GitDiffResult> =>
    getJson(`/api/workspace-ext/diff?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}&staged=${staged ? 1 : 0}`),
  gitLog: (path: string): Promise<GitLogResult> =>
    getJson(`/api/workspace-ext/git/log?path=${encodeURIComponent(path)}`),
  gitAction: (
    path: string,
    action: 'stage' | 'unstage' | 'discard' | 'commit',
    opts: { files?: string[]; message?: string; all?: boolean; staged?: boolean } = {},
  ): Promise<GitActionResult> => {
    // Only truthy flags cross the wire: `staged: false` would otherwise leak
    // into the payload and read as an explicit (wrong) discard mode.
    const body: Record<string, unknown> = { path, action }
    if (opts.files !== undefined) body.files = opts.files
    if (opts.message !== undefined) body.message = opts.message
    if (opts.all === true) body.all = true
    if (opts.staged === true) body.staged = true
    return postJson('/api/workspace-ext/git/action', body)
  },
  termSpawn: (cwd: string, session?: string): Promise<{ ok: boolean; id?: string; error?: string }> =>
    postJson('/api/workspace-ext/term/spawn', session === undefined ? { cwd } : { cwd, session }),
  termWrite: (session: string, text: string): Promise<{ ok: boolean; error?: string }> =>
    postJson('/api/workspace-ext/term/write', { session, text }),
  termResize: (session: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> =>
    postJson('/api/workspace-ext/term/resize', { session, cols, rows }),
  termKill: (session: string): Promise<{ ok: boolean; error?: string }> =>
    postJson('/api/workspace-ext/term/kill', { session }),
  termStatus: (session: string): Promise<TermStatus> =>
    getJson(`/api/workspace-ext/term/status?session=${encodeURIComponent(session)}`),
}
