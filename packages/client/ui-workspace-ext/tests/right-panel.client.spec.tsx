// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { RightPanel, stripAnsi, type RightPanelProps } from '../src/client/right-panel.tsx'
import { api } from '../src/client/api.ts'

vi.mock('../src/client/api.ts', () => ({
  api: {
    gitBranch: vi.fn(),
    gitBranches: vi.fn(),
    gitCheckout: vi.fn(),
    gitStatus: vi.fn(),
    termSpawn: vi.fn(),
    termWrite: vi.fn(),
    termPoll: vi.fn(),
    termKill: vi.fn(),
    termStatus: vi.fn(),
  },
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
beforeEach(() => {
  vi.clearAllMocks()
  // Every call site awaits a promise; default all mocks to a resolved envelope
  // so tests that never exercise a route do not crash on `.then` of undefined.
  vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: null, detached: false, path: '' })
  vi.mocked(api.gitBranches).mockResolvedValue({ ok: true, branches: [] })
  vi.mocked(api.gitCheckout).mockResolvedValue({ ok: true, message: '' })
  vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 0, behind: 0, changes: [] })
  vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
  vi.mocked(api.termWrite).mockResolvedValue({ ok: true })
  vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: false })
  vi.mocked(api.termKill).mockResolvedValue({ ok: true })
  vi.mocked(api.termStatus).mockResolvedValue({ ok: true, running: false, exited: true })
})

const sid = (id: string) => id as SessionId

function hook<T>(snapshot: T): SnapshotSelectorHook<T> {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

function panelProps(overrides?: Partial<RightPanelProps>): RightPanelProps {
  const sessions: SessionListState = {
    ids: [], byId: {}, current: sid('s1'), phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
  const workspaces: WorkspaceListState = {
    items: [{ workspaceId: 'w1' as never, path: '/repo', title: 'repo', sessionIds: [sid('s1')], createdAt: '0', updatedAt: '0' }],
    archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined,
  }
  return {
    useSessions: hook(sessions),
    useWorkspaces: hook(workspaces),
    ...overrides,
  }
}

describe('stripAnsi', () => {
  it('removes OSC and CSI sequences and normalizes line endings', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red')
    expect(stripAnsi('\u001b]0;title\u0007ok')).toBe('ok')
    expect(stripAnsi('a\r\nb\rc')).toBe('a\nb\nc')
  })
})

describe('RightPanel', () => {
  it('renders the rail and expands into the tabbed panel', async () => {
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await waitFor(() => { expect(screen.getByText('Git 工作区')).toBeTruthy() })
    expect(screen.getByText('/repo'.split('/').pop() ?? '')).toBeTruthy()
  })

  it('auto-connects the terminal when the panel opens with a workspace path', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: false })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await waitFor(() => { expect(vi.mocked(api.termSpawn)).toHaveBeenCalledWith('/repo') }, { timeout: 3000 })
    // No manual 启动 click needed; the session is live.
    await waitFor(() => { expect(screen.getByText('等待输出…')).toBeTruthy() }, { timeout: 3000 })
  })

  it('does not auto-connect without a workspace path and disables 启动', async () => {
    const sessions: SessionListState = {
      ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    }
    render(<RightPanel {...panelProps({ useSessions: hook(sessions) })} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await waitFor(() => { expect(screen.getByText('终端未连接。当前会话没有工作区。')).toBeTruthy() })
    expect(vi.mocked(api.termSpawn)).not.toHaveBeenCalled()
    const startButton = screen.getByText('启动') as HTMLButtonElement
    expect(startButton.disabled).toBe(true)
  })

  it('polls output and shows it stripped', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '\u001b[32mhello\u001b[0m\n', exited: false })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await waitFor(() => { expect(vi.mocked(api.termSpawn)).toHaveBeenCalled() }, { timeout: 3000 })
    await waitFor(() => { expect(screen.getByText(/hello/)).toBeTruthy() }, { timeout: 3000 })
    expect(screen.queryByText('\u001b[32m')).toBeNull()
  })

  it('marks the terminal exited when the poll says so', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: true })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await waitFor(() => { expect(screen.getByText('终端已退出。')).toBeTruthy() }, { timeout: 3000 })
  })

  it('sends the input with a trailing newline', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: false })
    vi.mocked(api.termWrite).mockResolvedValue({ ok: true })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await waitFor(() => { expect(vi.mocked(api.termSpawn)).toHaveBeenCalled() })
    fireEvent.change(screen.getByPlaceholderText('输入命令，回车执行'), { target: { value: 'ls' } })
    fireEvent.click(screen.getByText('发送'))
    await waitFor(() => { expect(vi.mocked(api.termWrite)).toHaveBeenCalledWith('ls\n') })
    // Enter key also sends.
    fireEvent.change(screen.getByPlaceholderText('输入命令，回车执行'), { target: { value: 'pwd' } })
    fireEvent.keyDown(screen.getByPlaceholderText('输入命令，回车执行'), { key: 'Enter' })
    await waitFor(() => { expect(vi.mocked(api.termWrite)).toHaveBeenCalledWith('pwd\n') })
  })

  it('clears the output and terminates the session', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: 'some output\n', exited: false })
    vi.mocked(api.termKill).mockResolvedValue({ ok: true })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await waitFor(() => { expect(screen.getByText(/some output/)).toBeTruthy() }, { timeout: 3000 })
    fireEvent.click(screen.getByText('清屏'))
    expect(screen.queryByText(/some output/)).toBeNull()
    fireEvent.click(screen.getByText('终止'))
    await waitFor(() => { expect(vi.mocked(api.termKill)).toHaveBeenCalled() })
  })

  it('shows the Git workspace tab with branch, delta and changes', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({
      ok: true, branch: 'dev', ahead: 2, behind: 1,
      changes: [
        { index: 'M', worktree: ' ', path: 'src/a.ts' },
        { index: '?', worktree: '?', path: 'new.txt' },
      ],
    })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(vi.mocked(api.gitStatus)).toHaveBeenCalledWith('/repo') })
    await waitFor(() => { expect(screen.getByText('dev')).toBeTruthy() })
    expect(screen.getByText(/领先 2/)).toBeTruthy()
    expect(screen.getByText(/落后 1/)).toBeTruthy()
    expect(screen.getByText('2 个变更')).toBeTruthy()
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText('new.txt')).toBeTruthy()
  })

  it('shows a clean workspace and refreshes the Git tab', async () => {
    vi.mocked(api.gitStatus)
      .mockResolvedValueOnce({ ok: true, branch: 'main', ahead: 0, behind: 0, changes: [] })
      .mockResolvedValueOnce({
        ok: true, branch: 'main', ahead: 0, behind: 0,
        changes: [{ index: 'D', worktree: ' ', path: 'gone.ts' }],
      })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(screen.getByText(/工作区干净/)).toBeTruthy() })
    fireEvent.click(screen.getByText('刷新'))
    await waitFor(() => { expect(screen.getByText('gone.ts')).toBeTruthy() })
  })

  it('collapses back to the rail after the settle delay', async () => {
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await screen.findByText('Git 工作区')
    fireEvent.click(screen.getByText('收起'))
    // Content unmounts immediately; the rail appears once the 180ms settle fires.
    await waitFor(() => { expect(screen.getByText('终端 · Git')).toBeTruthy() }, { timeout: 3000 })
  })

  it('shows spawn failures from the auto-connect', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: false, error: 'pty busy' })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await waitFor(() => { expect(screen.getByText('pty busy')).toBeTruthy() }, { timeout: 3000 })
  })

  it('treats a rejected auto-connect as a plain failure message', async () => {
    vi.mocked(api.termSpawn).mockRejectedValue('plain spawn')
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await waitFor(() => { expect(screen.getByText('plain spawn')).toBeTruthy() }, { timeout: 3000 })
  })

  it('does not auto-connect twice while a spawn is in flight', async () => {
    let resolveSpawn: (value: { ok: boolean }) => void = () => {}
    vi.mocked(api.termSpawn).mockImplementation(() => new Promise((resolve) => { resolveSpawn = resolve }))
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: false })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await waitFor(() => { expect(vi.mocked(api.termSpawn)).toHaveBeenCalledTimes(1) })
    // Re-render (tab switch and back) while pending must not re-arm.
    fireEvent.click(screen.getByText('Git 工作区'))
    fireEvent.click(screen.getByText('终端'))
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(vi.mocked(api.termSpawn)).toHaveBeenCalledTimes(1)
    resolveSpawn({ ok: true })
    await waitFor(() => { expect(screen.getByText('等待输出…')).toBeTruthy() }, { timeout: 3000 })
  })
})

describe('RightPanel coverage arms', () => {
  it('ignores failed polls, caps long output, and tolerates poll rejections', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll)
      .mockResolvedValueOnce({ ok: false, out: '', exited: false })
      .mockResolvedValueOnce({ ok: true, out: 'x'.repeat(9000), exited: false })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await waitFor(() => {
      const pre = document.querySelector('pre')
      expect(pre?.textContent?.length).toBe(8000)
    }, { timeout: 3000 })
    vi.mocked(api.termPoll).mockRejectedValueOnce(new Error('transient'))
    await new Promise((resolve) => { setTimeout(resolve, 600) })
    expect(screen.getByText(/^x{8000}$/)).toBeTruthy()
  })

  it('shows the generic spawn failure and rejection payloads from the manual 启动 button', async () => {
    vi.mocked(api.termSpawn).mockResolvedValueOnce({ ok: false })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await waitFor(() => { expect(vi.mocked(api.termSpawn)).toHaveBeenCalled() }, { timeout: 3000 })
    await waitFor(() => { expect(screen.getByText('启动终端失败')).toBeTruthy() })

    vi.mocked(api.termSpawn).mockRejectedValueOnce(new Error('spawn error'))
    fireEvent.click(screen.getByText('启动'))
    await waitFor(() => { expect(screen.getByText('spawn error')).toBeTruthy() })
  })

  it('tolerates kill and write rejections and ignores empty sends', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: false })
    vi.mocked(api.termKill).mockRejectedValueOnce(new Error('kill fail'))
    vi.mocked(api.termWrite).mockRejectedValueOnce(new Error('write fail'))
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await waitFor(() => { expect(screen.getByText('等待输出…')).toBeTruthy() }, { timeout: 3000 })
    fireEvent.click(screen.getByText('发送')) // empty input → no write
    await waitFor(() => { expect(vi.mocked(api.termWrite)).not.toHaveBeenCalled() })
    fireEvent.change(screen.getByPlaceholderText('输入命令，回车执行'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('发送')) // write rejects → swallowed
    await waitFor(() => { expect(vi.mocked(api.termWrite)).toHaveBeenCalledWith('x\n') })
    fireEvent.click(screen.getByText('终止')) // kill rejects → swallowed
    await waitFor(() => { expect(vi.mocked(api.termKill)).toHaveBeenCalled() })
  })

  it('ignores non-Enter keys in the input', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: false })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    await waitFor(() => { expect(screen.getByText('等待输出…')).toBeTruthy() }, { timeout: 3000 })
    fireEvent.change(screen.getByPlaceholderText('输入命令，回车执行'), { target: { value: 'pwd' } })
    fireEvent.keyDown(screen.getByPlaceholderText('输入命令，回车执行'), { key: 'a' })
    expect(vi.mocked(api.termWrite)).not.toHaveBeenCalled()
  })

  it('handles Git tab failures and the terminal without a running session', async () => {
    vi.mocked(api.gitStatus).mockRejectedValueOnce(new Error('git boom'))
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(screen.getByText('git boom')).toBeTruthy() })

    // Not-ok payload keeps the failure text.
    vi.mocked(api.gitStatus).mockResolvedValueOnce({ ok: false, error: 'not a repo' } as never)
    fireEvent.click(screen.getByText('刷新'))
    await waitFor(() => { expect(screen.getByText('not a repo')).toBeTruthy() })

    // Generic payload error fallback.
    vi.mocked(api.gitStatus).mockResolvedValueOnce({ ok: false } as never)
    fireEvent.click(screen.getByText('刷新'))
    await waitFor(() => { expect(screen.getByText('读取 Git 状态失败')).toBeTruthy() })

    // Back to terminal: the auto-connect session is live.
    fireEvent.click(screen.getByText('终端'))
    expect(screen.getByText('等待输出…')).toBeTruthy()
  })

  it('shows the detached-head branch label and suppresses an empty delta', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: null, ahead: 0, behind: 0, changes: [] })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(screen.getByText('(detached HEAD)')).toBeTruthy() })
    expect(screen.queryByText(/领先/)).toBeNull()
  })

  it('renders a behind-only delta without the ahead separator', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 0, behind: 3, changes: [] })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(screen.getByText(/落后 3/)).toBeTruthy() })
    expect(screen.queryByText(/领先/)).toBeNull()
    expect(screen.queryByText(/ · /)).toBeNull()
  })

  it('renders an ahead-only delta without the behind label', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 5, behind: 0, changes: [] })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(screen.getByText(/领先 5/)).toBeTruthy() })
    expect(screen.queryByText(/落后/)).toBeNull()
  })

  it('renders a string rejection payload from the Git tab', async () => {
    vi.mocked(api.gitStatus).mockRejectedValueOnce('plain status boom')
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(screen.getByText('plain status boom')).toBeTruthy() })
  })

  it('ignores a Git status rejection that lands after the tab unmounts', async () => {
    let rejectStatus: (reason: unknown) => void = () => {}
    vi.mocked(api.gitStatus).mockImplementation(() => new Promise((_resolve, reject) => { rejectStatus = reject }))
    const { unmount } = render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(vi.mocked(api.gitStatus)).toHaveBeenCalled() })
    unmount()
    rejectStatus(new Error('late failure'))
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    // The late rejection is swallowed; nothing re-renders.
    expect(screen.queryByText('late failure')).toBeNull()
  })
})

describe('codeLabel', () => {
  it('maps every porcelain code to a stable label', async () => {
    // The label map is exercised through a rendered change row.
    vi.mocked(api.gitStatus).mockResolvedValue({
      ok: true, branch: 'x', ahead: 0, behind: 0,
      changes: [
        { index: 'A', worktree: ' ', path: 'a' },
        { index: 'R', worktree: ' ', path: 'b' },
        { index: 'C', worktree: ' ', path: 'c' },
        { index: 'U', worktree: 'U', path: 'd' },
        { index: 'X', worktree: ' ', path: 'e' },
        { index: ' ', worktree: 'D', path: 'f' },
      ],
    })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(screen.getByText('终端 · Git'))
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(screen.getByText('已添加')).toBeTruthy() })
    expect(screen.getByText('已重命名')).toBeTruthy()
    expect(screen.getByText('已复制')).toBeTruthy()
    expect(screen.getAllByText('冲突').length).toBeGreaterThan(0)
    expect(screen.getByText('X')).toBeTruthy()
    expect(screen.getAllByText('已删除').length).toBeGreaterThan(0)
  })
})
