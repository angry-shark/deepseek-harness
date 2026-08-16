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

/** Incremental terminal output since the previous poll. */
export interface TermPoll {
  ok: boolean
  out: string
  exited: boolean
  error?: string
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
  termSpawn: (cwd: string): Promise<{ ok: boolean; error?: string }> =>
    postJson('/api/workspace-ext/term/spawn', { cwd }),
  termWrite: (text: string): Promise<{ ok: boolean; error?: string }> =>
    postJson('/api/workspace-ext/term/write', { text }),
  termPoll: (): Promise<TermPoll> => getJson('/api/workspace-ext/term/poll'),
  termKill: (): Promise<{ ok: boolean }> => postJson('/api/workspace-ext/term/kill', {}),
  termStatus: (): Promise<TermStatus> => getJson('/api/workspace-ext/term/status'),
}
