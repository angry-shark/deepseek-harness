// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { TerminalBar, stripAnsi, type TerminalBarProps } from '../src/client/terminal-bar.tsx'
import { api } from '../src/client/api.ts'

vi.mock('../src/client/api.ts', () => ({
  api: {
    gitBranch: vi.fn(),
    gitBranches: vi.fn(),
    gitCheckout: vi.fn(),
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
})

const sid = (id: string) => id as SessionId

function hook<T>(snapshot: T): SnapshotSelectorHook<T> {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

function barProps(overrides?: Partial<TerminalBarProps>): TerminalBarProps {
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

describe('TerminalBar', () => {
  it('renders the rail and expands into the panel', async () => {
    render(<TerminalBar {...barProps()} />)
    fireEvent.click(screen.getByText('终端'))
    await waitFor(() => { expect(screen.getByText('启动')).toBeTruthy() })
    expect(screen.getByText('/repo'.split('/').pop() ?? '')).toBeTruthy()
  })

  it('spawns the terminal, polls output and shows it stripped', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '\u001b[32mhello\u001b[0m\n', exited: false })
    render(<TerminalBar {...barProps()} />)
    fireEvent.click(screen.getByText('终端'))
    fireEvent.click(await screen.findByText('启动'))
    await waitFor(() => { expect(vi.mocked(api.termSpawn)).toHaveBeenCalledWith('/repo') })
    await waitFor(() => { expect(screen.getByText(/hello/)).toBeTruthy() }, { timeout: 3000 })
    expect(screen.queryByText('\u001b[32m')).toBeNull()
  })

  it('marks the terminal exited when the poll says so', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: true })
    render(<TerminalBar {...barProps()} />)
    fireEvent.click(screen.getByText('终端'))
    fireEvent.click(await screen.findByText('启动'))
    await waitFor(() => { expect(screen.getByText('终端已退出。')).toBeTruthy() }, { timeout: 3000 })
  })

  it('sends the input with a trailing newline', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: false })
    vi.mocked(api.termWrite).mockResolvedValue({ ok: true })
    render(<TerminalBar {...barProps()} />)
    fireEvent.click(screen.getByText('终端'))
    fireEvent.click(await screen.findByText('启动'))
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
    render(<TerminalBar {...barProps()} />)
    fireEvent.click(screen.getByText('终端'))
    fireEvent.click(await screen.findByText('启动'))
    await waitFor(() => { expect(screen.getByText(/some output/)).toBeTruthy() }, { timeout: 3000 })
    fireEvent.click(screen.getByText('清屏'))
    expect(screen.queryByText(/some output/)).toBeNull()
    fireEvent.click(screen.getByText('终止'))
    await waitFor(() => { expect(vi.mocked(api.termKill)).toHaveBeenCalled() })
  })

  it('collapses back to the rail', async () => {
    render(<TerminalBar {...barProps()} />)
    fireEvent.click(screen.getByText('终端'))
    fireEvent.click(await screen.findByText('收起'))
    expect(screen.queryByText('启动')).toBeNull()
    expect(screen.getByText('终端')).toBeTruthy()
  })

  it('shows spawn failures and disables 启动 without a workspace path', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: false, error: 'pty busy' })
    render(<TerminalBar {...barProps()} />)
    fireEvent.click(screen.getByText('终端'))
    fireEvent.click(await screen.findByText('启动'))
    await waitFor(() => { expect(screen.getByText('pty busy')).toBeTruthy() })

    // No session → no workspace path → 启动 disabled.
    const sessions: SessionListState = {
      ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    }
    render(<TerminalBar {...barProps({ useSessions: hook(sessions) })} />)
    fireEvent.click(screen.getAllByText('终端')[1]!)
    const buttons = screen.getAllByText('启动')
    expect((buttons[buttons.length - 1] as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('TerminalBar coverage arms', () => {
  it('ignores failed polls, caps long output, and tolerates poll rejections', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll)
      .mockResolvedValueOnce({ ok: false, out: '', exited: false })
      .mockResolvedValueOnce({ ok: true, out: 'x'.repeat(9000), exited: false })
    render(<TerminalBar {...barProps()} />)
    fireEvent.click(screen.getByText('终端'))
    fireEvent.click(await screen.findByText('启动'))
    await waitFor(() => {
      const pre = document.querySelector('pre')
      expect(pre?.textContent?.length).toBe(8000)
    }, { timeout: 3000 })
    vi.mocked(api.termPoll).mockRejectedValueOnce(new Error('transient'))
    await new Promise((resolve) => { setTimeout(resolve, 600) })
    expect(screen.getByText(/^x{8000}$/)).toBeTruthy()
  })

  it('shows the generic spawn failure and rejection payloads', async () => {
    vi.mocked(api.termSpawn).mockResolvedValueOnce({ ok: false })
    render(<TerminalBar {...barProps()} />)
    fireEvent.click(screen.getByText('终端'))
    fireEvent.click(await screen.findByText('启动'))
    await waitFor(() => { expect(screen.getByText('启动终端失败')).toBeTruthy() })

    vi.mocked(api.termSpawn).mockRejectedValueOnce(new Error('spawn error'))
    fireEvent.click(screen.getByText('启动'))
    await waitFor(() => { expect(screen.getByText('spawn error')).toBeTruthy() })

    vi.mocked(api.termSpawn).mockRejectedValueOnce('plain spawn')
    fireEvent.click(screen.getByText('启动'))
    await waitFor(() => { expect(screen.getByText('plain spawn')).toBeTruthy() })
  })

  it('tolerates kill and write rejections and ignores empty sends', async () => {
    vi.mocked(api.termSpawn).mockResolvedValue({ ok: true })
    vi.mocked(api.termPoll).mockResolvedValue({ ok: true, out: '', exited: false })
    vi.mocked(api.termKill).mockRejectedValueOnce(new Error('kill fail'))
    vi.mocked(api.termWrite).mockRejectedValueOnce(new Error('write fail'))
    render(<TerminalBar {...barProps()} />)
    fireEvent.click(screen.getByText('终端'))
    fireEvent.click(await screen.findByText('启动'))
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
    render(<TerminalBar {...barProps()} />)
    fireEvent.click(screen.getByText('终端'))
    fireEvent.click(await screen.findByText('启动'))
    fireEvent.change(screen.getByPlaceholderText('输入命令，回车执行'), { target: { value: 'pwd' } })
    fireEvent.keyDown(screen.getByPlaceholderText('输入命令，回车执行'), { key: 'a' })
    expect(vi.mocked(api.termWrite)).not.toHaveBeenCalled()
  })
})
