// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { groupChanges, RightPanel, type RightPanelProps } from '../src/client/right-panel.tsx'
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
    collapsed: false,
    width: 360,
    toggleRight: vi.fn(),
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

describe('RightPanel', () => {
  it('renders the rail as vertical tabs and expands on tab click', () => {
    const toggleRight = vi.fn()
    render(<RightPanel {...panelProps({ collapsed: true, toggleRight })} />)
    expect(screen.getByRole('button', { name: '终端' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Git' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '终端' }))
    expect(toggleRight).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Git' }))
    expect(toggleRight).toHaveBeenCalledTimes(2)
  })

  it('opens the Git tab when its rail tab is clicked', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'dev', ahead: 0, behind: 0, changes: [] })
    function Harness() {
      const [collapsed, setCollapsed] = useState(true)
      return <RightPanel {...panelProps({ collapsed, toggleRight: () => { setCollapsed(value => !value) } })} />
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Git' }))
    await waitFor(() => { expect(screen.getByText('Git 工作区')).toBeTruthy() })
    await waitFor(() => { expect(vi.mocked(api.gitStatus)).toHaveBeenCalledWith('/repo') })
    // The Git tab is active: its summary renders instead of the terminal.
    await waitFor(() => { expect(screen.getByText('dev')).toBeTruthy() })
    expect(screen.queryByLabelText('终端输入')).toBeNull()
  })

  it('expands into the tabbed panel when not collapsed', async () => {
    render(<RightPanel {...panelProps()} />)
    await waitFor(() => { expect(screen.getByText('Git 工作区')).toBeTruthy() })
    expect(screen.getByRole('button', { name: '收起右侧栏' })).toBeTruthy()
  })

  it('auto-connects the terminal when the panel opens with a workspace path', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: false })
    render(<RightPanel {...panelProps()} />)
    await waitFor(() => { expect(vi.mocked(api.termSpawn)).toHaveBeenCalledWith('/repo') }, { timeout: 3000 })
    // The live session renders the command line; no placeholder text.
    await waitFor(() => { expect(screen.getByLabelText('终端输入')).toBeTruthy() }, { timeout: 3000 })
    expect(screen.queryByText(/等待输出/)).toBeNull()
  })

  it('does not auto-connect without a workspace path and disables 启动', async () => {
    const sessions: SessionListState = {
      ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    }
    render(<RightPanel {...panelProps({ useSessions: hook(sessions) })} />)
    await waitFor(() => { expect(screen.getByText('终端未连接。当前会话没有工作区。')).toBeTruthy() })
    expect(vi.mocked(api.termSpawn)).not.toHaveBeenCalled()
    const startButton = screen.getByText('启动') as HTMLButtonElement
    expect(startButton.disabled).toBe(true)
  })

  it('renders ANSI-colored output as styled spans', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '\u001b[32mhello\u001b[0m\n', exited: false })
    render(<RightPanel {...panelProps()} />)
    await waitFor(() => { expect(vi.mocked(api.termSpawn)).toHaveBeenCalled() }, { timeout: 3000 })
    await waitFor(() => { expect(screen.getByText(/hello/)).toBeTruthy() }, { timeout: 3000 })
    expect(screen.queryByText('\u001b[32m')).toBeNull()
    // The run carries the resolved foreground color on its span.
    const hello = screen.getByText('hello')
    expect(hello.tagName).toBe('SPAN')
    expect(hello.style.color).not.toBe('')
  })

  it('marks the terminal exited when the poll says so', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: true })
    render(<RightPanel {...panelProps()} />)
    await waitFor(() => { expect(screen.getByText('终端已退出。')).toBeTruthy() }, { timeout: 3000 })
  })

  it('sends the input with a trailing newline', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: false })
    vi.mocked(api.termWrite).mockResolvedValue({ ok: true })
    render(<RightPanel {...panelProps()} />)
    await waitFor(() => { expect(vi.mocked(api.termSpawn)).toHaveBeenCalled() })
    const input = screen.getByLabelText('终端输入')
    fireEvent.change(input, { target: { value: 'ls' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(vi.mocked(api.termWrite)).toHaveBeenCalledWith('ls\n') })
    // Enter key on the inline terminal line sends the typed command.
    fireEvent.change(input, { target: { value: 'pwd' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(vi.mocked(api.termWrite)).toHaveBeenCalledWith('pwd\n') })
  })

  it('clears the output and terminates the session', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: 'some output\n', exited: false })
    vi.mocked(api.termKill).mockResolvedValue({ ok: true })
    render(<RightPanel {...panelProps()} />)
    await waitFor(() => { expect(screen.getByText(/some output/)).toBeTruthy() }, { timeout: 3000 })
    fireEvent.click(screen.getByText('清屏'))
    expect(screen.queryByText(/some output/)).toBeNull()
    fireEvent.click(screen.getByText('终止'))
    await waitFor(() => { expect(vi.mocked(api.termKill)).toHaveBeenCalled() })
  })

  it('shows the Git workspace tab with branch, delta and grouped changes', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({
      ok: true, branch: 'dev', ahead: 2, behind: 1,
      changes: [
        { index: 'M', worktree: ' ', path: 'src/a.ts' },
        { index: ' ', worktree: 'M', path: 'src/b.ts' },
        { index: '?', worktree: '?', path: 'new.txt' },
      ],
    })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(vi.mocked(api.gitStatus)).toHaveBeenCalledWith('/repo') })
    await waitFor(() => { expect(screen.getByText('dev')).toBeTruthy() })
    expect(screen.getByText(/领先 2/)).toBeTruthy()
    expect(screen.getByText(/落后 1/)).toBeTruthy()
    // VS Code source-control groups with counts.
    expect(screen.getByText('暂存的更改')).toBeTruthy()
    expect(screen.getByText('更改')).toBeTruthy()
    expect(screen.getByText('未跟踪')).toBeTruthy()
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText('src/b.ts')).toBeTruthy()
    expect(screen.getByText('new.txt')).toBeTruthy()
    // The Git tab badge shows the total change count.
    expect(screen.getByText('3')).toBeTruthy()
    // The VS Code source-control summary carries the total-change pill.
    expect(screen.getByText('3 个更改')).toBeTruthy()
  })

  it('shows a clean workspace and refreshes the Git tab', async () => {
    vi.mocked(api.gitStatus)
      .mockResolvedValueOnce({ ok: true, branch: 'main', ahead: 0, behind: 0, changes: [] })
      .mockResolvedValueOnce({
        ok: true, branch: 'main', ahead: 0, behind: 0,
        changes: [{ index: 'D', worktree: ' ', path: 'gone.ts' }],
      })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(screen.getByText(/工作区干净/)).toBeTruthy() })
    fireEvent.click(screen.getByText('刷新'))
    await waitFor(() => { expect(screen.getByText('gone.ts')).toBeTruthy() })
    expect(screen.getByText('暂存的更改')).toBeTruthy()
  })

  it('calls toggleRight from the collapse icon button', async () => {
    const toggleRight = vi.fn()
    render(<RightPanel {...panelProps({ toggleRight })} />)
    fireEvent.click(await screen.findByRole('button', { name: '收起右侧栏' }))
    expect(toggleRight).toHaveBeenCalledTimes(1)
  })

  it('shows spawn failures from the auto-connect', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: false, error: 'pty busy' })
    render(<RightPanel {...panelProps()} />)
    await waitFor(() => { expect(screen.getByText('pty busy')).toBeTruthy() }, { timeout: 3000 })
  })

  it('treats a rejected auto-connect as a plain failure message', async () => {
    vi.mocked(api.termSpawn).mockRejectedValue('plain spawn')
    render(<RightPanel {...panelProps()} />)
    await waitFor(() => { expect(screen.getByText('plain spawn')).toBeTruthy() }, { timeout: 3000 })
  })

  it('does not auto-connect twice while a spawn is in flight', async () => {
    let resolveSpawn: (value: { ok: boolean }) => void = () => {}
    vi.mocked(api.termSpawn).mockImplementation(() => new Promise((resolve) => { resolveSpawn = resolve }))
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: false })
    render(<RightPanel {...panelProps()} />)
    await waitFor(() => { expect(vi.mocked(api.termSpawn)).toHaveBeenCalledTimes(1) })
    // Re-render (tab switch and back) while pending must not re-arm.
    fireEvent.click(screen.getByText('Git 工作区'))
    fireEvent.click(screen.getByText('终端'))
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(vi.mocked(api.termSpawn)).toHaveBeenCalledTimes(1)
    resolveSpawn({ ok: true })
    await waitFor(() => { expect(screen.getByLabelText('终端输入')).toBeTruthy() }, { timeout: 3000 })
  })

  it('focuses the terminal input when the viewport is clicked', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: false })
    render(<RightPanel {...panelProps()} />)
    await waitFor(() => { expect(screen.getByLabelText('终端输入')).toBeTruthy() }, { timeout: 3000 })
    // A click on the output area bubbles to the viewport handler and focuses
    // the command line, like clicking anywhere in the VS Code terminal.
    fireEvent.click(document.querySelector('[data-term-out]') as HTMLElement)
    await waitFor(() => { expect(document.activeElement).toBe(screen.getByLabelText('终端输入')) })
  })

  it('ignores viewport clicks while the terminal is not running', async () => {
    const sessions: SessionListState = {
      ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    }
    render(<RightPanel {...panelProps({ useSessions: hook(sessions) })} />)
    await waitFor(() => { expect(screen.getByText(/终端未连接/)).toBeTruthy() })
    // No command input exists yet; the click handler short-circuits.
    fireEvent.click(document.querySelector('[data-term-out]') as HTMLElement)
    expect(document.activeElement?.tagName).toBe('BODY')
  })
})

describe('RightPanel coverage arms', () => {
  it('ignores failed polls, caps long output, and tolerates poll rejections', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll)
      .mockResolvedValueOnce({ ok: false, out: '', exited: false })
      .mockResolvedValueOnce({ ok: true, out: 'x'.repeat(9000), exited: false })
    render(<RightPanel {...panelProps()} />)
    await waitFor(() => {
      const termOut = document.querySelector('[data-term-out]')
      expect(termOut?.textContent?.length).toBe(8000)
    }, { timeout: 3000 })
    vi.mocked(api.termPoll).mockRejectedValueOnce(new Error('transient'))
    await new Promise((resolve) => { setTimeout(resolve, 600) })
    expect(screen.getByText(/^x{8000}$/)).toBeTruthy()
  })

  it('shows the generic spawn failure and rejection payloads from the manual 启动 button', async () => {
    vi.mocked(api.termSpawn).mockResolvedValueOnce({ ok: false })
    render(<RightPanel {...panelProps()} />)
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
    await waitFor(() => { expect(screen.getByLabelText('终端输入')).toBeTruthy() }, { timeout: 3000 })
    const input = screen.getByLabelText('终端输入')
    fireEvent.keyDown(input, { key: 'Enter' }) // empty input → no write
    await waitFor(() => { expect(vi.mocked(api.termWrite)).not.toHaveBeenCalled() })
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'Enter' }) // write rejects → swallowed
    await waitFor(() => { expect(vi.mocked(api.termWrite)).toHaveBeenCalledWith('x\n') })
    fireEvent.click(screen.getByText('终止')) // kill rejects → swallowed
    await waitFor(() => { expect(vi.mocked(api.termKill)).toHaveBeenCalled() })
  })

  it('ignores non-Enter keys in the input', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: false })
    render(<RightPanel {...panelProps()} />)
    await waitFor(() => { expect(screen.getByLabelText('终端输入')).toBeTruthy() }, { timeout: 3000 })
    fireEvent.change(screen.getByLabelText('终端输入'), { target: { value: 'pwd' } })
    fireEvent.keyDown(screen.getByLabelText('终端输入'), { key: 'a' })
    expect(vi.mocked(api.termWrite)).not.toHaveBeenCalled()
  })

  it('handles Git tab failures and the terminal without a running session', async () => {
    vi.mocked(api.gitStatus).mockRejectedValueOnce(new Error('git boom'))
    render(<RightPanel {...panelProps()} />)
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
    expect(screen.getByLabelText('终端输入')).toBeTruthy()
  })

  it('shows the detached-head branch label and suppresses an empty delta', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: null, ahead: 0, behind: 0, changes: [] })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(screen.getByText('(detached HEAD)')).toBeTruthy() })
    expect(screen.queryByText(/领先/)).toBeNull()
  })

  it('renders a behind-only delta without the ahead separator', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 0, behind: 3, changes: [] })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(screen.getByText(/落后 3/)).toBeTruthy() })
    expect(screen.queryByText(/领先/)).toBeNull()
    expect(screen.queryByText(/ · /)).toBeNull()
  })

  it('renders an ahead-only delta without the behind label', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 5, behind: 0, changes: [] })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(screen.getByText(/领先 5/)).toBeTruthy() })
    expect(screen.queryByText(/落后/)).toBeNull()
  })

  it('renders a string rejection payload from the Git tab', async () => {
    vi.mocked(api.gitStatus).mockRejectedValueOnce('plain status boom')
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(screen.getByText('plain status boom')).toBeTruthy() })
  })

  it('ignores a Git status rejection that lands after the tab unmounts', async () => {
    let rejectStatus: (reason: unknown) => void = () => {}
    vi.mocked(api.gitStatus).mockImplementation(() => new Promise((_resolve, reject) => { rejectStatus = reject }))
    const { unmount } = render(<RightPanel {...panelProps()} />)
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(vi.mocked(api.gitStatus)).toHaveBeenCalled() })
    unmount()
    rejectStatus(new Error('late failure'))
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    // The late rejection is swallowed; nothing re-renders.
    expect(screen.queryByText('late failure')).toBeNull()
  })

  it('does not auto-connect when the panel is collapsed', async () => {
    render(<RightPanel {...panelProps({ collapsed: true })} />)
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(vi.mocked(api.termSpawn)).not.toHaveBeenCalled()
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
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(screen.getAllByText('A').length).toBeGreaterThan(0) })
    expect(screen.getAllByText('R').length).toBeGreaterThan(0)
    expect(screen.getAllByText('C').length).toBeGreaterThan(0)
    expect(screen.getAllByText('U').length).toBeGreaterThan(0)
    expect(screen.getAllByText('D').length).toBeGreaterThan(0)
    expect(screen.getAllByText('M').length).toBeGreaterThan(0)
  })
})
