// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { groupChanges, GitPanel, type GitPanelProps } from '../src/client/git-panel.tsx'
import { api, type GitDiffResult } from '../src/client/api.ts'

vi.mock('../src/client/api.ts', () => ({
  api: {
    gitBranch: vi.fn(),
    gitBranches: vi.fn(),
    gitCheckout: vi.fn(),
    gitStatus: vi.fn(),
    gitAction: vi.fn(),
    gitDiff: vi.fn(),
  },
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: null, detached: false, path: '' })
  vi.mocked(api.gitBranches).mockResolvedValue({ ok: true, branches: [] })
  vi.mocked(api.gitCheckout).mockResolvedValue({ ok: true, message: '' })
  vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 0, behind: 0, changes: [] })
  vi.mocked(api.gitAction).mockResolvedValue({ ok: true })
  vi.mocked(api.gitDiff).mockResolvedValue({ ok: true, diff: '', untracked: false, path: '' })
})

const sid = (id: string) => id as SessionId

function hook<T>(snapshot: T): SnapshotSelectorHook<T> {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

function gitProps(overrides?: Partial<GitPanelProps>): GitPanelProps {
  const sessions: SessionListState = {
    ids: [], byId: {}, current: sid('s1'), phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
  const workspaces: WorkspaceListState = {
    items: [{ workspaceId: 'w1' as never, path: '/repo', title: 'repo', sessionIds: [sid('s1')], createdAt: '0', updatedAt: '0' }],
    archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined,
  }
  return {
    collapsed: false,
    width: 360,
    useSessions: hook(sessions),
    useWorkspaces: hook(workspaces),
    ...overrides,
  }
}

describe('groupChanges', () => {
  it('splits changes into staged, unstaged, and untracked groups', () => {
    const { staged, unstaged, untracked } = groupChanges([
      { index: 'M', worktree: ' ', path: 'a.ts' },
      { index: ' ', worktree: 'M', path: 'b.ts' },
      { index: '?', worktree: '?', path: 'new.txt' },
      { index: 'A', worktree: ' ', path: 'added.ts' },
    ])
    expect(staged.map(c => c.path)).toEqual(['a.ts', 'added.ts'])
    expect(unstaged.map(c => c.path)).toEqual(['b.ts'])
    expect(untracked.map(c => c.path)).toEqual(['new.txt'])
  })
})

describe('GitPanel', () => {
  it('shows git failure text variants', async () => {
    vi.mocked(api.gitStatus).mockRejectedValueOnce(new Error('git boom'))
    render(<GitPanel {...gitProps()} />)
    await waitFor(() => { expect(screen.getByText('git boom')).toBeTruthy() })

    vi.mocked(api.gitStatus).mockResolvedValueOnce({ ok: false, error: 'not a repo' } as never)
    fireEvent.click(screen.getByText('刷新'))
    await waitFor(() => { expect(screen.getByText('not a repo')).toBeTruthy() })

    vi.mocked(api.gitStatus).mockResolvedValueOnce({ ok: false } as never)
    fireEvent.click(screen.getByText('刷新'))
    await waitFor(() => { expect(screen.getByText('读取 Git 状态失败')).toBeTruthy() })
  })

  it('shows the detached-head branch label and suppresses an empty delta', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: null, ahead: 0, behind: 0, changes: [] })
    render(<GitPanel {...gitProps()} />)
    await waitFor(() => { expect(screen.getByText('(detached HEAD)')).toBeTruthy() })
    expect(screen.queryByText(/领先/)).toBeNull()
  })

  it('renders a behind-only delta without the ahead separator', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 0, behind: 3, changes: [] })
    render(<GitPanel {...gitProps()} />)
    await waitFor(() => { expect(screen.getByText(/落后 3/)).toBeTruthy() })
    expect(screen.queryByText(/领先/)).toBeNull()
    expect(screen.queryByText(/ · /)).toBeNull()
  })

  it('renders an ahead-and-behind delta with the separator', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 2, behind: 1, changes: [] })
    render(<GitPanel {...gitProps()} />)
    await waitFor(() => { expect(screen.getByText(/领先 2/)).toBeTruthy() })
    expect(screen.getByText(/落后 1/)).toBeTruthy()
    expect(screen.getByText(/ · /)).toBeTruthy()
  })

  it('renders an ahead-only delta without the behind label', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 5, behind: 0, changes: [] })
    render(<GitPanel {...gitProps()} />)
    await waitFor(() => { expect(screen.getByText(/领先 5/)).toBeTruthy() })
    expect(screen.queryByText(/落后/)).toBeNull()
  })

  it('renders a string rejection payload from the status fetch', async () => {
    vi.mocked(api.gitStatus).mockRejectedValueOnce('plain status boom')
    render(<GitPanel {...gitProps()} />)
    await waitFor(() => { expect(screen.getByText('plain status boom')).toBeTruthy() })
  })

  it('ignores a Git status rejection that lands after unmount', async () => {
    let rejectStatus: (reason: unknown) => void = () => {}
    vi.mocked(api.gitStatus).mockImplementation(() => new Promise((_resolve, reject) => { rejectStatus = reject }))
    const { unmount } = render(<GitPanel {...gitProps()} />)
    await waitFor(() => { expect(vi.mocked(api.gitStatus)).toHaveBeenCalled() })
    unmount()
    rejectStatus(new Error('late failure'))
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(screen.queryByText('late failure')).toBeNull()
  })
})

describe('git source-control interactions', () => {
  async function openGit(changes: Array<{ index: string; worktree: string; path: string }>): Promise<void> {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 0, behind: 0, changes })
    render(<GitPanel {...gitProps()} />)
    await waitFor(() => { expect(vi.mocked(api.gitStatus)).toHaveBeenCalledWith('/repo') })
    await waitFor(() => { expect(screen.getByLabelText('提交消息')).toBeTruthy() })
  }

  it('commits a message through the commit box and refreshes', async () => {
    await openGit([{ index: 'M', worktree: ' ', path: 'a.ts' }])
    const input = screen.getByLabelText('提交消息')
    fireEvent.change(input, { target: { value: 'fix: a' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'commit', { message: 'fix: a', all: false }) })
    await waitFor(() => { expect(screen.getByLabelText('提交消息')).toHaveProperty('value', '') })
    expect(vi.mocked(api.gitStatus).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('smart-commits everything when nothing is staged', async () => {
    await openGit([{ index: ' ', worktree: 'M', path: 'b.ts' }])
    fireEvent.change(screen.getByLabelText('提交消息'), { target: { value: 'wip' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'commit', { message: 'wip', all: true }) })
  })

  it('keeps the commit button disabled without a message or changes', async () => {
    await openGit([])
    const button = screen.getByRole('button', { name: '提交' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('提交消息'), { target: { value: 'x' } })
    const again = screen.getByRole('button', { name: '提交' }) as HTMLButtonElement
    expect(again.disabled).toBe(true)
  })

  it('stages and unstages individual files', async () => {
    await openGit([
      { index: 'M', worktree: ' ', path: 'staged.ts' },
      { index: ' ', worktree: 'M', path: 'un.ts' },
    ])
    fireEvent.click(within(screen.getByText('更改').closest('section') as HTMLElement).getByText('暂存'))
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'stage', { files: ['un.ts'] }) })
    fireEvent.click(within(screen.getByText('暂存的更改').closest('section') as HTMLElement).getByText('取消暂存'))
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'unstage', { files: ['staged.ts'] }) })
  })

  it('discards a worktree file and a staged file from HEAD', async () => {
    await openGit([
      { index: 'M', worktree: ' ', path: 'staged.ts' },
      { index: ' ', worktree: 'M', path: 'un.ts' },
    ])
    fireEvent.click(within(screen.getByText('更改').closest('section') as HTMLElement).getByText('放弃'))
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'discard', { files: ['un.ts'] }) })
    fireEvent.click(within(screen.getByText('暂存的更改').closest('section') as HTMLElement).getByText('放弃'))
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'discard', { files: ['staged.ts'], staged: true }) })
  })

  it('runs group-level stage/unstage/discard actions', async () => {
    await openGit([
      { index: 'M', worktree: ' ', path: 'staged.ts' },
      { index: ' ', worktree: 'M', path: 'un.ts' },
      { index: '?', worktree: '?', path: 'new.txt' },
    ])
    fireEvent.click(within(screen.getByText('更改').closest('section') as HTMLElement).getByText('全部暂存'))
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'stage', {}) })
    fireEvent.click(within(screen.getByText('更改').closest('section') as HTMLElement).getByText('放弃全部更改'))
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'discard', {}) })
    fireEvent.click(within(screen.getByText('暂存的更改').closest('section') as HTMLElement).getByText('全部取消暂存'))
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'unstage', {}) })
  })

  it('collapses and expands a group with its chevron', async () => {
    await openGit([
      { index: 'M', worktree: ' ', path: 'staged.ts' },
      { index: ' ', worktree: 'M', path: 'un.ts' },
      { index: '?', worktree: '?', path: 'new.txt' },
    ])
    expect(screen.getByText('staged.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起暂存的更改' }))
    expect(screen.queryByText('staged.ts')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开暂存的更改' }))
    expect(screen.getByText('staged.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起更改' }))
    expect(screen.queryByText('un.ts')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开更改' }))
    expect(screen.getByText('un.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起未跟踪' }))
    expect(screen.queryByText('new.txt')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开未跟踪' }))
    expect(screen.getByText('new.txt')).toBeTruthy()
  })

  it('discards all staged changes from HEAD via the group action', async () => {
    await openGit([
      { index: 'M', worktree: ' ', path: 'staged.ts' },
      { index: ' ', worktree: 'M', path: 'un.ts' },
    ])
    fireEvent.click(within(screen.getByText('暂存的更改').closest('section') as HTMLElement).getByText('放弃全部更改'))
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'discard', { staged: true }) })
  })

  it('ignores non-Enter keys in the commit box', async () => {
    await openGit([{ index: 'M', worktree: ' ', path: 'a.ts' }])
    fireEvent.change(screen.getByLabelText('提交消息'), { target: { value: 'x' } })
    fireEvent.keyDown(screen.getByLabelText('提交消息'), { key: 'a' })
    expect(vi.mocked(api.gitAction)).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('提交消息'), { target: { value: '' } })
    fireEvent.keyDown(screen.getByLabelText('提交消息'), { key: 'Enter' })
    expect(vi.mocked(api.gitAction)).not.toHaveBeenCalled()
  })

  it('shows git action failures and ignores rejections after unmount', async () => {
    await openGit([{ index: ' ', worktree: 'M', path: 'un.ts' }])
    const stageBtn = () => within(screen.getByText('更改').closest('section') as HTMLElement).getByText('暂存')
    vi.mocked(api.gitAction).mockResolvedValueOnce({ ok: false, error: 'conflict' })
    fireEvent.click(stageBtn())
    await waitFor(() => { expect(screen.getByText('conflict')).toBeTruthy() })
    vi.mocked(api.gitAction).mockRejectedValueOnce(new Error('git op boom'))
    fireEvent.click(stageBtn())
    await waitFor(() => { expect(screen.getByText('git op boom')).toBeTruthy() })
    vi.mocked(api.gitAction).mockRejectedValueOnce('plain op boom')
    fireEvent.click(stageBtn())
    await waitFor(() => { expect(screen.getByText('plain op boom')).toBeTruthy() })
    vi.mocked(api.gitAction).mockResolvedValueOnce({ ok: false })
    fireEvent.click(stageBtn())
    await waitFor(() => { expect(screen.getByText('Git 操作失败')).toBeTruthy() })
  })

  it('renders git group count badges', async () => {
    await openGit([
      { index: 'A', worktree: ' ', path: 'a.ts' },
      { index: ' ', worktree: 'M', path: 'b.ts' },
    ])
    expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(2)
  })
})

describe('git diff viewer', () => {
  async function openDiff(path: string, changes: Array<{ index: string; worktree: string; path: string }>): Promise<void> {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 0, behind: 0, changes })
    render(<GitPanel {...gitProps()} />)
    await waitFor(() => { expect(vi.mocked(api.gitStatus)).toHaveBeenCalledWith('/repo') })
    fireEvent.click(await screen.findByRole('button', { name: `查看 ${path} 的修改` }))
  }

  it('shows the unified diff for an unstaged file, colors its lines, and highlights the code', async () => {
    vi.mocked(api.gitDiff).mockResolvedValue({
      ok: true, untracked: false, path: 'un.ts',
      diff: 'diff --git a/un.ts b/un.ts\nindex 111..222 100644\n--- a/un.ts\n+++ b/un.ts\n@@ -1 +1 @@\n same line\n-old\n+const answer = 42\n',
    })
    await openDiff('un.ts', [{ index: ' ', worktree: 'M', path: 'un.ts' }])
    await waitFor(() => { expect(vi.mocked(api.gitDiff)).toHaveBeenCalledWith('/repo', 'un.ts', false) })
    await waitFor(() => { expect(screen.getByText('diff --git a/un.ts b/un.ts')).toBeTruthy() }, { timeout: 3000 })
    const addLine = [...document.querySelectorAll('[data-diff-kind="add"]')]
      .find(el => (el as HTMLElement).textContent?.includes('const answer = 42')) as HTMLElement
    expect(addLine.textContent).toContain('const answer = 42')
    const keyword = addLine.querySelector('span[style*="--shiki"]')
    expect(keyword?.textContent).toBe('const')
    expect(screen.getByText('@@ -1 +1 @@')).toBeTruthy()
    expect(screen.getByText('same line')).toBeTruthy()
    expect(screen.queryByLabelText('提交消息')).toBeNull()
  })

  it('diffs a staged file against HEAD', async () => {
    await openDiff('staged.ts', [{ index: 'M', worktree: ' ', path: 'staged.ts' }])
    await waitFor(() => { expect(vi.mocked(api.gitDiff)).toHaveBeenCalledWith('/repo', 'staged.ts', true) })
    await waitFor(() => { expect(screen.getByText('已暂存')).toBeTruthy() })
  })

  it('shows the raw content of an untracked file as additions', async () => {
    vi.mocked(api.gitDiff).mockResolvedValue({
      ok: true, untracked: true, path: 'new.txt', content: 'line one\nline two\n',
    })
    await openDiff('new.txt', [{ index: '?', worktree: '?', path: 'new.txt' }])
    await waitFor(() => { expect(screen.getByText('line one')).toBeTruthy() }, { timeout: 3000 })
    await waitFor(() => { expect(screen.getByText('未跟踪')).toBeTruthy() })
  })

  it('returns to the change list from the diff pane', async () => {
    vi.mocked(api.gitDiff).mockResolvedValue({
      ok: true, untracked: false, path: 'un.ts', diff: 'diff --git a/un.ts b/un.ts\n@@ -1 +1 @@\n+new\n-old\n',
    })
    await openDiff('un.ts', [{ index: ' ', worktree: 'M', path: 'un.ts' }])
    await waitFor(() => { expect(screen.getByText('diff --git a/un.ts b/un.ts')).toBeTruthy() }, { timeout: 3000 })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    await waitFor(() => { expect(screen.getByLabelText('提交消息')).toBeTruthy() })
    expect(screen.queryByText('diff --git a/un.ts b/un.ts')).toBeNull()
  })

  it('surfaces diff fetch failures and busy state', async () => {
    vi.mocked(api.gitDiff).mockResolvedValueOnce({ ok: false, error: 'boom' })
    await openDiff('un.ts', [{ index: ' ', worktree: 'M', path: 'un.ts' }])
    await waitFor(() => { expect(screen.getByText('boom')).toBeTruthy() }, { timeout: 3000 })
    vi.mocked(api.gitDiff).mockRejectedValueOnce(new Error('net down'))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看 un.ts 的修改' }))
    await waitFor(() => { expect(screen.getByText('net down')).toBeTruthy() }, { timeout: 3000 })
    vi.mocked(api.gitDiff).mockImplementationOnce(() => new Promise(() => {}))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看 un.ts 的修改' }))
    await waitFor(() => { expect(screen.getByText('加载中…')).toBeTruthy() })
  })

  it('shows a plain-string diff rejection payload', async () => {
    vi.mocked(api.gitDiff).mockRejectedValueOnce('plain diff boom')
    await openDiff('un.ts', [{ index: ' ', worktree: 'M', path: 'un.ts' }])
    await waitFor(() => { expect(screen.getByText('plain diff boom')).toBeTruthy() }, { timeout: 3000 })
  })

  it('falls back to the generic text for bare failure payloads', async () => {
    vi.mocked(api.gitDiff).mockResolvedValueOnce({ ok: false })
    await openDiff('un.ts', [{ index: ' ', worktree: 'M', path: 'un.ts' }])
    await waitFor(() => { expect(screen.getByText('读取修改内容失败。')).toBeTruthy() }, { timeout: 3000 })
  })

  it('handles an untracked payload without content defensively', async () => {
    vi.mocked(api.gitDiff).mockResolvedValueOnce({ ok: true, untracked: true, path: 'new.txt' })
    await openDiff('new.txt', [{ index: '?', worktree: '?', path: 'new.txt' }])
    await waitFor(() => { expect(screen.getByText('未跟踪')).toBeTruthy() }, { timeout: 3000 })
  })

  it('ignores diff results that land after the pane closes', async () => {
    let resolveDiff: (value: GitDiffResult | PromiseLike<GitDiffResult>) => void = () => {}
    vi.mocked(api.gitDiff).mockImplementationOnce(() => new Promise((resolve) => { resolveDiff = resolve }))
    await openDiff('un.ts', [{ index: ' ', worktree: 'M', path: 'un.ts' }])
    await waitFor(() => { expect(screen.getByText('加载中…')).toBeTruthy() }, { timeout: 3000 })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    resolveDiff({ ok: true, diff: 'late', untracked: false, path: 'un.ts' })
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(screen.getByLabelText('提交消息')).toBeTruthy()

    let rejectDiff: (reason: unknown) => void = () => {}
    vi.mocked(api.gitDiff).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectDiff = reject }))
    fireEvent.click(await screen.findByRole('button', { name: '查看 un.ts 的修改' }))
    await waitFor(() => { expect(screen.getByText('加载中…')).toBeTruthy() }, { timeout: 3000 })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    rejectDiff(new Error('late boom'))
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(screen.queryByText('late boom')).toBeNull()
    expect(screen.getByLabelText('提交消息')).toBeTruthy()
  })
})

describe('git glyph coverage', () => {
  it('maps every porcelain code through the row glyphs', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({
      ok: true, branch: 'x', ahead: 0, behind: 0,
      changes: [
        { index: 'A', worktree: ' ', path: 'a' },
        { index: 'R', worktree: ' ', path: 'b' },
        { index: 'C', worktree: ' ', path: 'c' },
        { index: 'U', worktree: 'U', path: 'd' },
        { index: ' ', worktree: 'D', path: 'f' },
        { index: 'M', worktree: ' ', path: 'g' },
      ],
    })
    render(<GitPanel {...gitProps()} />)
    await waitFor(() => { expect(screen.getAllByText('A').length).toBeGreaterThan(0) })
    expect(screen.getAllByText('R').length).toBeGreaterThan(0)
    expect(screen.getAllByText('C').length).toBeGreaterThan(0)
    expect(screen.getAllByText('U').length).toBeGreaterThan(0)
    expect(screen.getAllByText('D').length).toBeGreaterThan(0)
    expect(screen.getAllByText('M').length).toBeGreaterThan(0)
  })
})
