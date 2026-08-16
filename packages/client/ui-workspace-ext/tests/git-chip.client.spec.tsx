// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { GitBranchChip, type GitBranchChipProps } from '../src/client/git-chip.tsx'
import css from '../src/client/styles.module.css'
import { api, type GitBranchInfo } from '../src/client/api.ts'

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

afterEach(cleanup)
beforeEach(() => { vi.clearAllMocks() })

const sid = (id: string) => id as SessionId

function hook<T>(snapshot: T): SnapshotSelectorHook<T> {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

function workspaceState(items: WorkspaceListState['items']): WorkspaceListState {
  return {
    items, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined,
  }
}

function chipProps(overrides?: Partial<GitBranchChipProps>): GitBranchChipProps {
  return {
    useWorkspaces: hook(workspaceState([
      { workspaceId: 'w1' as never, path: '/repo', title: 'repo', sessionIds: [sid('s1')], createdAt: '0', updatedAt: '0' },
    ])),
    sessionId: sid('s1'),
    ...overrides,
  } as unknown as GitBranchChipProps
}

describe('GitBranchChip', () => {
  it('renders nothing without a workspace path or a git branch', () => {
    const { container } = render(<GitBranchChip {...chipProps({ sessionId: sid('unknown') })} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the current branch after the fetch resolves', async () => {
    vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: 'dev', detached: false, path: '/repo' })
    render(<GitBranchChip {...chipProps()} />)
    await waitFor(() => { expect(screen.getByText('dev')).toBeTruthy() })
    expect(vi.mocked(api.gitBranch)).toHaveBeenCalledWith('/repo')
    // The trigger chrome matches the sibling access-mode selector: a branch
    // svg icon and a chevron, no text glyphs.
    const chip = screen.getByRole('button')
    expect(chip.querySelectorAll('svg').length).toBe(2)
    expect(chip.textContent).not.toContain('⎇')
  })

  it('stays hidden when the repository has no branch (detached short sha still shows)', async () => {
    vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: null, detached: false, path: '/repo' })
    const { container } = render(<GitBranchChip {...chipProps()} />)
    await waitFor(() => { expect(container.firstChild).toBeNull() })
  })

  it('opens the switcher menu with local branches and marks the current one', async () => {
    vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: 'dev', detached: false, path: '/repo' })
    vi.mocked(api.gitBranches).mockResolvedValue({ ok: true, branches: ['dev', 'main'] })
    render(<GitBranchChip {...chipProps()} />)
    fireEvent.click(await screen.findByText('dev'))
    await waitFor(() => { expect(screen.getByText('main')).toBeTruthy() })
    expect(screen.getByText('✓')).toBeTruthy()
  })

  it('closes the menu and refreshes after a successful checkout', async () => {
    vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: 'dev', detached: false, path: '/repo' })
    vi.mocked(api.gitBranches).mockResolvedValue({ ok: true, branches: ['dev', 'main'] })
    vi.mocked(api.gitCheckout).mockResolvedValue({ ok: true, message: 'Switched' })
    render(<GitBranchChip {...chipProps()} />)
    fireEvent.click(await screen.findByText('dev'))
    const main = await screen.findByText('main')
    fireEvent.click(main)
    await waitFor(() => { expect(vi.mocked(api.gitCheckout)).toHaveBeenCalledWith('/repo', 'main') })
    await waitFor(() => { expect(vi.mocked(api.gitBranch)).toHaveBeenCalledTimes(2) })
    expect(screen.queryByText('main')).toBeNull()
  })

  it('surfaces checkout failures in the menu', async () => {
    vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: 'dev', detached: false, path: '/repo' })
    vi.mocked(api.gitBranches).mockResolvedValue({ ok: true, branches: ['dev', 'main'] })
    vi.mocked(api.gitCheckout).mockResolvedValue({ ok: false, error: 'dirty tree' })
    render(<GitBranchChip {...chipProps()} />)
    fireEvent.click(await screen.findByText('dev'))
    fireEvent.click(await screen.findByText('main'))
    await waitFor(() => { expect(screen.getByText('dirty tree')).toBeTruthy() })
  })

  it('reports an empty branch list', async () => {
    vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: 'dev', detached: false, path: '/repo' })
    vi.mocked(api.gitBranches).mockResolvedValue({ ok: true, branches: [] })
    render(<GitBranchChip {...chipProps()} />)
    fireEvent.click(await screen.findByText('dev'))
    await waitFor(() => { expect(screen.getByText('无本地分支')).toBeTruthy() })
  })
})

describe('GitBranchChip coverage arms', () => {
  it('stays hidden when the branch fetch fails', async () => {
    vi.mocked(api.gitBranch).mockRejectedValue(new Error('boom'))
    const { container } = render(<GitBranchChip {...chipProps()} />)
    await waitFor(() => { expect(container.firstChild).toBeNull() })
  })

  it('toggles the menu closed on a second click', async () => {
    vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: 'dev', detached: false, path: '/repo' })
    vi.mocked(api.gitBranches).mockResolvedValue({ ok: true, branches: ['dev'] })
    const { container } = render(<GitBranchChip {...chipProps()} />)
    fireEvent.click(await screen.findByText('dev'))
    await waitFor(() => { expect(container.querySelector(`.${css.gitItemCurrent}`)).toBeTruthy() })
    fireEvent.click(screen.getAllByText('dev')[0]!)
    await waitFor(() => { expect(container.querySelector(`.${css.gitMenu}`)).toBeNull() })
  })

  it('falls back to an empty branch list on partial or failed answers', async () => {
    vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: 'dev', detached: false, path: '/repo' })
    // ok without a branches key → empty
    vi.mocked(api.gitBranches).mockResolvedValueOnce({ ok: true })
    render(<GitBranchChip {...chipProps()} />)
    fireEvent.click(await screen.findByText('dev'))
    await waitFor(() => { expect(screen.getByText('无本地分支')).toBeTruthy() })
    fireEvent.click(screen.getByText('dev'))
    // ok:false → empty
    vi.mocked(api.gitBranches).mockResolvedValueOnce({ ok: false })
    fireEvent.click(await screen.findByText('dev'))
    await waitFor(() => { expect(screen.getByText('无本地分支')).toBeTruthy() })
    fireEvent.click(screen.getByText('dev'))
    // rejection → empty
    vi.mocked(api.gitBranches).mockRejectedValueOnce(new Error('nope'))
    fireEvent.click(await screen.findByText('dev'))
    await waitFor(() => { expect(screen.getByText('无本地分支')).toBeTruthy() })
  })

  it('ignores clicking the current branch and shows the generic failure text', async () => {
    vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: 'dev', detached: false, path: '/repo' })
    vi.mocked(api.gitBranches).mockResolvedValue({ ok: true, branches: ['dev', 'main'] })
    vi.mocked(api.gitCheckout).mockResolvedValueOnce({ ok: false })
    const { container } = render(<GitBranchChip {...chipProps()} />)
    fireEvent.click(await screen.findByText('dev'))
    const menu = await waitFor(() => container.querySelector(`.${css.gitMenu}`))
    expect(menu).toBeTruthy()
    // current branch click is a no-op
    const devItem = screen.getAllByText('dev')[1]!
    fireEvent.click(devItem)
    expect(vi.mocked(api.gitCheckout)).not.toHaveBeenCalled()
    // a failed checkout without an error message shows the generic text
    fireEvent.click(screen.getAllByText('main')[0]!)
    await waitFor(() => { expect(screen.getByText('切换分支失败')).toBeTruthy() })
  })

  it('surfaces checkout rejections with Error and string payloads', async () => {
    vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: 'dev', detached: false, path: '/repo' })
    vi.mocked(api.gitBranches).mockResolvedValue({ ok: true, branches: ['dev', 'main'] })
    vi.mocked(api.gitCheckout).mockRejectedValueOnce(new Error('transport'))
    const { container } = render(<GitBranchChip {...chipProps()} />)
    fireEvent.click(await screen.findByText('dev'))
    await waitFor(() => { expect(container.querySelector(`.${css.gitMenu}`)).toBeTruthy() })
    fireEvent.click(screen.getAllByText('main')[0]!)
    await waitFor(() => { expect(screen.getByText('transport')).toBeTruthy() })
    fireEvent.click(screen.getAllByText('dev')[0]!)
    vi.mocked(api.gitCheckout).mockRejectedValueOnce('plain')
    await waitFor(() => { expect(container.querySelector(`.${css.gitMenu}`)).toBeNull() })
    fireEvent.click(screen.getAllByText('dev')[0]!)
    await waitFor(() => { expect(screen.getAllByText('main').length).toBeGreaterThan(0) })
    fireEvent.click(screen.getAllByText('main')[0]!)
    await waitFor(() => { expect(screen.getByText('plain')).toBeTruthy() })
  })

  it('marks the title of a detached HEAD', async () => {
    vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: 'abc1234', detached: true, path: '/repo' })
    render(<GitBranchChip {...chipProps()} />)
    const chip = await screen.findByText('abc1234')
    expect(chip.parentElement?.getAttribute('title')).toContain('detached HEAD')
  })
})

describe('GitBranchChip lifecycle guards', () => {
  it('ignores late branch answers after unmount', async () => {
    let resolveBranch!: (value: GitBranchInfo) => void
    let rejectBranch!: (error: Error) => void
    vi.mocked(api.gitBranch)
      .mockImplementationOnce(() => new Promise<GitBranchInfo>((resolve) => { resolveBranch = resolve }))
      .mockImplementationOnce(() => new Promise<GitBranchInfo>((_resolve, reject) => { rejectBranch = reject }))
    const { unmount, container } = render(<GitBranchChip {...chipProps()} />)
    unmount()
    resolveBranch({ ok: true, branch: 'dev', detached: false, path: '/repo' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(container.firstChild).toBeNull()

    const second = render(<GitBranchChip {...chipProps()} />)
    second.unmount()
    rejectBranch(new Error('late'))
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(second.container.firstChild).toBeNull()
  })
})
