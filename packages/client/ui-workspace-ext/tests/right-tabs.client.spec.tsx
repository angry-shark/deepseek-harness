// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { RightTabs, type RightTabsProps } from '../src/client/right-tabs.tsx'
import { CommitPanel } from '../src/client/commit-panel.tsx'
import { api } from '../src/client/api.ts'

vi.mock('../src/client/api.ts', () => ({
  api: {
    gitBranch: vi.fn(),
    gitBranches: vi.fn(),
    gitCheckout: vi.fn(),
    gitStatus: vi.fn(),
    gitAction: vi.fn(),
    gitDiff: vi.fn(),
    gitLog: vi.fn(),
  },
}))

afterEach(() => { cleanup() })
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: null, detached: false, path: '' })
  vi.mocked(api.gitBranches).mockResolvedValue({ ok: true, branches: [] })
  vi.mocked(api.gitCheckout).mockResolvedValue({ ok: true, message: '' })
  vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 0, behind: 0, changes: [] })
  vi.mocked(api.gitAction).mockResolvedValue({ ok: true })
  vi.mocked(api.gitDiff).mockResolvedValue({ ok: true, diff: '', untracked: false, path: '' })
  vi.mocked(api.gitLog).mockResolvedValue({ ok: true, commits: [] })
})

const sid = (id: string) => id as SessionId

function hook<T>(snapshot: T): SnapshotSelectorHook<T> {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

function rightProps(overrides?: Partial<RightTabsProps>): RightTabsProps {
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

describe('RightTabs', () => {
  it('expanded shows the Git and 提交历史 tabs; collapsed shows them in the rail', () => {
    render(<RightTabs {...rightProps()} />)
    expect(screen.getByRole('button', { name: 'Git' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '提交历史' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '收起右侧栏' })).toBeTruthy()
    cleanup()
    render(<RightTabs {...rightProps({ collapsed: true })} />)
    expect(screen.getByRole('button', { name: 'Git' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '提交历史' })).toBeTruthy()
  })

  it('collapsed rail: clicking a tab expands the column on that tab', () => {
    const toggleRight = vi.fn()
    render(<RightTabs {...rightProps({ collapsed: true, toggleRight })} />)
    fireEvent.click(screen.getByRole('button', { name: '提交历史' }))
    expect(toggleRight).toHaveBeenCalledTimes(1)
  })

  it('expanded: switching tabs shows the corresponding panel content', async () => {
    vi.mocked(api.gitLog).mockResolvedValue({
      ok: true,
      commits: [{ hash: 'a1b2', date: '2026-08-18', author: 'Lin', message: 'feat: x' }],
    })
    render(<RightTabs {...rightProps()} />)
    // Git tab active by default: its status surface loads.
    await waitFor(() => { expect(vi.mocked(api.gitStatus)).toHaveBeenCalledWith('/repo') })
    fireEvent.click(screen.getByRole('button', { name: '提交历史' }))
    await waitFor(() => { expect(vi.mocked(api.gitLog)).toHaveBeenCalledWith('/repo') })
    await waitFor(() => { expect(screen.getByText('feat: x')).toBeTruthy() }, { timeout: 3000 })
  })
})

describe('CommitPanel', () => {
  function commitProps(overrides?: Partial<Parameters<typeof CommitPanel>[0]>): Parameters<typeof CommitPanel>[0] {
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

  it('lists branch commits and surfaces fetch failures', async () => {
    vi.mocked(api.gitLog).mockResolvedValue({
      ok: true,
      commits: [
        { hash: 'a1b2c3', date: '2026-08-18', author: 'Lin', message: 'feat: history' },
        { hash: 'd4e5f6', date: '2026-08-17', author: 'Lin', message: 'fix: typo' },
      ],
    })
    render(<CommitPanel {...commitProps()} />)
    await waitFor(() => { expect(screen.getByText('feat: history')).toBeTruthy() }, { timeout: 3000 })
    expect(screen.getByText('fix: typo')).toBeTruthy()
    expect(screen.getByText(/Lin · 2026-08-18/)).toBeTruthy()

    vi.mocked(api.gitLog).mockRejectedValueOnce(new Error('log boom'))
    fireEvent.click(screen.getByText('刷新'))
    await waitFor(() => { expect(screen.getByText('log boom')).toBeTruthy() })
  })

  it('shows the empty state for a branch without commits', async () => {
    render(<CommitPanel {...commitProps()} />)
    await waitFor(() => { expect(screen.getByText('当前分支暂无提交。')).toBeTruthy() }, { timeout: 3000 })
  })
})
