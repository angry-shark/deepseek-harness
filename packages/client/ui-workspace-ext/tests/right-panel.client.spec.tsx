// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { groupChanges, RightPanel, type RightPanelProps } from '../src/client/right-panel.tsx'
import { api, type GitDiffResult } from '../src/client/api.ts'

// xterm is exercised through a scripted fake: the component under test is our
// wiring (stream events → term.write, onData → termWrite, onResize → termResize,
// toolbar → clear/dispose), not xterm's own rendering engine. EventSource is
// faked the same way: the tests fire its onmessage handler with SSE payloads.
const { MockTerminal, MockFitAddon, MockEventSource } = vi.hoisted(() => {
  class MockTerminal {
    static instances: MockTerminal[] = []
    writes: string[] = []
    cleared = 0
    disposed = 0
    focused = 0
    resets = 0
    private dataHandler: ((data: string) => void) | null = null
    private resizeHandler: ((size: { cols: number; rows: number }) => void) | null = null
    constructor() { MockTerminal.instances.push(this) }
    open(): void {}
    write(data: string): void { this.writes.push(data) }
    clear(): void { this.cleared += 1 }
    dispose(): void { this.disposed += 1 }
    focus(): void { this.focused += 1 }
    reset(): void { this.resets += 1 }
    loadAddon(): void {}
    onData(handler: (data: string) => void): { dispose: () => void } {
      this.dataHandler = handler
      return { dispose: () => {} }
    }
    onResize(handler: (size: { cols: number; rows: number }) => void): { dispose: () => void } {
      this.resizeHandler = handler
      return { dispose: () => {} }
    }
    /** Test hook: fire one keystroke through the onData wiring. */
    typeData(data: string): void { this.dataHandler?.(data) }
    /** Test hook: fire one size change through the onResize wiring. */
    resizeTo(cols: number, rows: number): void { this.resizeHandler?.({ cols, rows }) }
  }
  class MockFitAddon {
    static instances: MockFitAddon[] = []
    fits = 0
    constructor() { MockFitAddon.instances.push(this) }
    activate(): void {}
    fit(): void { this.fits += 1 }
    dispose(): void {}
  }
  class MockEventSource {
    static instances: MockEventSource[] = []
    readonly url: string
    onmessage: ((event: { data: string }) => void) | null = null
    closed = false
    constructor(url: string) {
      this.url = url
      MockEventSource.instances.push(this)
    }
    close(): void { this.closed = true }
    /** Test hook: fire one SSE payload through the onmessage wiring. */
    emit(out: string, exited = false): void {
      this.onmessage?.({ data: JSON.stringify({ out, exited }) })
    }
  }
  return { MockTerminal, MockFitAddon, MockEventSource }
})

vi.mock('@xterm/xterm', () => ({ Terminal: MockTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: MockFitAddon }))

vi.mock('../src/client/api.ts', () => ({
  api: {
    gitBranch: vi.fn(),
    gitBranches: vi.fn(),
    gitCheckout: vi.fn(),
    gitStatus: vi.fn(),
    gitAction: vi.fn(),
    gitDiff: vi.fn(),
    termSpawn: vi.fn(),
    termWrite: vi.fn(),
    termResize: vi.fn(),
    termKill: vi.fn(),
    termStatus: vi.fn(),
  },
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  vi.clearAllMocks()
  MockTerminal.instances = []
  MockFitAddon.instances = []
  MockEventSource.instances = []
  // Spawns mint incrementing session ids, like the node half's counter.
  let spawnCount = 0
  vi.mocked(api.termSpawn).mockImplementation(async (cwd: string, session?: string) => {
    void cwd
    return session === undefined ? { ok: true, id: `term-${++spawnCount}` } : { ok: true, id: session }
  })
  // The terminal output arrives over SSE; the fake replaces the browser's
  // EventSource so tests drive the stream directly.
  vi.stubGlobal('EventSource', MockEventSource)
  // jsdom has no ResizeObserver; force the plain-window-resize branch so the
  // observer branch is deterministic (a dedicated test stubs it back in).
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined
  // Every call site awaits a promise; default all mocks to a resolved envelope
  // so tests that never exercise a route do not crash on `.then` of undefined.
  vi.mocked(api.gitBranch).mockResolvedValue({ ok: true, branch: null, detached: false, path: '' })
  vi.mocked(api.gitBranches).mockResolvedValue({ ok: true, branches: [] })
  vi.mocked(api.gitCheckout).mockResolvedValue({ ok: true, message: '' })
  vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 0, behind: 0, changes: [] })
  vi.mocked(api.gitAction).mockResolvedValue({ ok: true })
  vi.mocked(api.gitDiff).mockResolvedValue({ ok: true, diff: '', untracked: false, path: '' })
  vi.mocked(api.termWrite).mockResolvedValue({ ok: true })
  vi.mocked(api.termResize).mockResolvedValue({ ok: true })
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

/** The xterm instance of the pane bound to one session id. Xterms and
 *  streams are created together per pane, so the creation order matches. */
function termOf(sessionId: string): InstanceType<typeof MockTerminal> {
  const streamIndex = MockEventSource.instances.findIndex(x => x.url.includes(`session=${sessionId}`))
  if (streamIndex === -1) throw new Error(`no stream for session ${sessionId}`)
  const instance = MockTerminal.instances[streamIndex]
  if (instance === undefined) throw new Error(`no xterm for session ${sessionId}`)
  return instance
}

/** Render the panel and wait for the auto-connect terminal to materialize. */
async function connectTerminal(): Promise<void> {
  render(<RightPanel {...panelProps()} />)
  await waitFor(() => { expect(vi.mocked(api.termSpawn)).toHaveBeenCalledWith('/repo') }, { timeout: 3000 })
  await waitFor(() => { expect(MockTerminal.instances.length).toBe(1) }, { timeout: 3000 })
  await waitFor(() => { expect(MockEventSource.instances.length).toBe(1) }, { timeout: 3000 })
}

/** The SSE stream of one session; fire `emit` to deliver its output. */
function streamOf(sessionId: string): InstanceType<typeof MockEventSource> {
  const found = MockEventSource.instances.find(s => s.url.includes(`session=${sessionId}`))
  if (found === undefined) throw new Error(`no stream for session ${sessionId}`)
  return found
}

/** The single session id of the first (only) pane. */
function firstSessionId(): string {
  const stream = MockEventSource.instances[0]
  if (stream === undefined) throw new Error('no terminal stream was opened')
  return decodeURIComponent(stream.url.split('session=')[1] ?? '')
}

/** Session ids of the panes currently shown (not hidden by tab switching). */
function visiblePaneIds(): (string | null)[] {
  return [...document.querySelectorAll('[data-term-pane]')]
    .filter(pane => pane.getAttribute('data-term-hidden') !== 'true')
    .map(pane => pane.getAttribute('data-session'))
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

describe('RightPanel terminal', () => {
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
    expect(screen.queryByText('终端已退出。')).toBeNull()
  })

  it('expands into the tabbed panel when not collapsed', async () => {
    render(<RightPanel {...panelProps()} />)
    await waitFor(() => { expect(screen.getByText('Git 工作区')).toBeTruthy() })
    expect(screen.getByRole('button', { name: '收起右侧栏' })).toBeTruthy()
  })

  it('calls toggleRight from the collapse icon button', async () => {
    const toggleRight = vi.fn()
    render(<RightPanel {...panelProps({ toggleRight })} />)
    fireEvent.click(await screen.findByRole('button', { name: '收起右侧栏' }))
    expect(toggleRight).toHaveBeenCalledTimes(1)
  })

  it('auto-connects the terminal when the panel opens with a workspace path', async () => {
    await connectTerminal()
    // The xterm surface exists; no placeholder status text.
    expect(document.querySelector('[data-term-host]')).toBeTruthy()
    expect(screen.queryByText(/终端未连接/)).toBeNull()
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

  it('renders no terminal host before a session exists', async () => {
    const sessions: SessionListState = {
      ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    }
    render(<RightPanel {...panelProps({ useSessions: hook(sessions) })} />)
    await waitFor(() => { expect(screen.getByText(/终端未连接/)).toBeTruthy() })
    expect(document.querySelector('[data-term-host]')).toBeNull()
  })

  it('streams PTY output into the pane xterm verbatim', async () => {
    await connectTerminal()
    const sid = firstSessionId()
    streamOf(sid).emit('\u001b[32mhello\u001b[0m\n')
    // The raw stream reaches xterm untouched; xterm owns ANSI interpretation.
    await waitFor(() => { expect(termOf(sid).writes).toContain('\u001b[32mhello\u001b[0m\n') }, { timeout: 3000 })
  })

  it('hands clear-screen sequences to xterm unchanged', async () => {
    await connectTerminal()
    const sid = firstSessionId()
    streamOf(sid).emit('old line\n\u001b[2Jprompt$ ')
    await waitFor(() => {
      expect(termOf(sid).writes).toContain('old line\n\u001b[2Jprompt$ ')
    }, { timeout: 3000 })
  })

  it('streams keystrokes to the shell as they happen', async () => {
    await connectTerminal()
    const sid = firstSessionId()
    const t = termOf(sid)
    t.typeData('l')
    t.typeData('s')
    t.typeData('\r')
    await waitFor(() => { expect(vi.mocked(api.termWrite).mock.calls).toEqual([[sid, 'l'], [sid, 's'], [sid, '\r']]) })
  })

  it('clears the viewport when the typed command is literally clear', async () => {
    await connectTerminal()
    const sid = firstSessionId()
    const t = termOf(sid)
    for (const ch of ['c', 'l', 'e', 'a', 'r']) t.typeData(ch)
    t.typeData('\r')
    await waitFor(() => { expect(t.cleared).toBe(1) })
    // The keystrokes still stream to the shell.
    await waitFor(() => { expect(vi.mocked(api.termWrite).mock.calls).toEqual([
      [sid, 'c'], [sid, 'l'], [sid, 'e'], [sid, 'a'], [sid, 'r'], [sid, '\r'],
    ]) })
    // A partial or edited line does not clear.
    t.typeData('cl')
    t.typeData('\u0003') // Ctrl+C cancels the line
    t.typeData('p')
    t.typeData('\r')
    expect(t.cleared).toBe(1)
  })

  it('forwards xterm resize to the PTY', async () => {
    await connectTerminal()
    const sid = firstSessionId()
    termOf(sid).resizeTo(80, 24)
    await waitFor(() => { expect(vi.mocked(api.termResize)).toHaveBeenCalledWith(sid, 80, 24) })
  })

  it('marks the terminal exited and stops forwarding keystrokes', async () => {
    await connectTerminal()
    const sid = firstSessionId()
    streamOf(sid).emit('', true)
    await waitFor(() => { expect(screen.getByText('终端已退出。')).toBeTruthy() }, { timeout: 3000 })
    // The exit signal closes the stream and a dead shell ignores keystrokes.
    expect(streamOf(sid).closed).toBe(true)
    termOf(sid).typeData('x')
    expect(vi.mocked(api.termWrite)).not.toHaveBeenCalled()
  })

  it('clears the active terminal viewport from the toolbar', async () => {
    await connectTerminal()
    const sid = firstSessionId()
    fireEvent.click(screen.getByText('清屏'))
    expect(termOf(sid).cleared).toBe(1)
  })

  it('terminates the active session and removes its pane', async () => {
    await connectTerminal()
    const sid = firstSessionId()
    fireEvent.click(screen.getByText('终止'))
    await waitFor(() => { expect(vi.mocked(api.termKill)).toHaveBeenCalledWith(sid) })
    await waitFor(() => { expect(MockTerminal.instances[0]!.disposed).toBe(1) })
    await waitFor(() => { expect(document.querySelectorAll('[data-term-pane]').length).toBe(0) })
    await waitFor(() => { expect(screen.getByText(/终端未连接/)).toBeTruthy() })
  })

  it('stays stopped after 终止 until 启动 is pressed', async () => {
    await connectTerminal()
    fireEvent.click(screen.getByText('终止'))
    await waitFor(() => { expect(MockTerminal.instances[0]!.disposed).toBe(1) })
    // No silent auto-respawn: a pause passes with a single spawn.
    await new Promise((resolve) => { setTimeout(resolve, 650) })
    expect(vi.mocked(api.termSpawn).mock.calls.length).toBe(1)
    // A manual start creates a fresh terminal and a fresh stream connection.
    fireEvent.click(screen.getByText('启动'))
    await waitFor(() => { expect(MockTerminal.instances.length).toBe(2) }, { timeout: 3000 })
    await waitFor(() => { expect(MockEventSource.instances.length).toBe(2) }, { timeout: 3000 })
  })

  it('focuses the terminal when the viewport is clicked', async () => {
    await connectTerminal()
    const sid = firstSessionId()
    const t = termOf(sid)
    const before = t.focused
    fireEvent.click(document.querySelector(`[data-term-pane][data-session="${sid}"] [data-term-host]`) as HTMLElement)
    expect(t.focused).toBe(before + 1)
  })

  it('fits the terminal to its container and observes resizes', async () => {
    class FakeResizeObserver {
      static observed: Element[] = []
      private callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) { this.callback = callback }
      observe(target: Element): void {
        FakeResizeObserver.observed.push(target)
        // The fake is structurally a ResizeObserver (same method set).
        this.callback([], this)
      }
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): ResizeObserverEntry[] { return [] }
    }
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
    await connectTerminal()
    await waitFor(() => { expect(MockFitAddon.instances.length).toBe(1) })
    expect(MockFitAddon.instances[0]!.fits).toBeGreaterThanOrEqual(1)
    expect(FakeResizeObserver.observed.length).toBeGreaterThan(0)
  })

  it('creates a second terminal tab with 新终端 and switches to it', async () => {
    await connectTerminal()
    const sidA = firstSessionId()
    fireEvent.click(screen.getByRole('button', { name: '新终端' }))
    await waitFor(() => { expect(MockTerminal.instances.length).toBe(2) }, { timeout: 3000 })
    await waitFor(() => { expect(MockEventSource.instances.length).toBe(2) }, { timeout: 3000 })
    const sidB = MockEventSource.instances
      .map(x => decodeURIComponent(x.url.split('session=')[1] ?? ''))
      .find(id => id !== sidA)
    expect(sidB).toBeTruthy()
    // The second pane is active; the toolbar acts on it.
    streamOf(sidB!).emit('B-out')
    await waitFor(() => { expect(termOf(sidB!).writes).toContain('B-out') }, { timeout: 3000 })
    fireEvent.click(screen.getByText('清屏'))
    expect(termOf(sidB!).cleared).toBe(1)
    expect(termOf(sidA).cleared).toBe(0)
    // 新终端 is a tab switch: only the new pane shows; the first stays
    // mounted (its stream keeps running) but hidden.
    expect(document.querySelectorAll('[data-term-pane]').length).toBe(2)
    expect(visiblePaneIds()).toEqual([sidB])
    // Switching back to the first tab shows it and hides the second.
    fireEvent.click(screen.getByText('终端 1'))
    expect(visiblePaneIds()).toEqual([sidA])
    // The hidden pane's stream never stopped.
    streamOf(sidB!).emit('B-still')
    await waitFor(() => { expect(termOf(sidB!).writes).toContain('B-still') }, { timeout: 3000 })
  })

  it('splits a new terminal right after the active pane', async () => {
    await connectTerminal()
    const sidA = firstSessionId()
    // Two panes, then split again while the first is active.
    fireEvent.click(screen.getByRole('button', { name: '新终端' }))
    await waitFor(() => { expect(MockTerminal.instances.length).toBe(2) }, { timeout: 3000 })
    const sidB = MockEventSource.instances
      .map(x => decodeURIComponent(x.url.split('session=')[1] ?? ''))
      .find(id => id !== sidA)!
    fireEvent.click(screen.getByText('终端 1'))
    fireEvent.click(screen.getByRole('button', { name: '分屏' }))
    await waitFor(() => { expect(MockTerminal.instances.length).toBe(3) }, { timeout: 3000 })
    const sidC = MockEventSource.instances
      .map(x => decodeURIComponent(x.url.split('session=')[1] ?? ''))
      .find(id => id !== sidA && id !== sidB)!
    // 分屏 inserts the new pane right after the active one: [A, C, B].
    const paneIds = [...document.querySelectorAll('[data-term-pane]')].map(p => p.getAttribute('data-session'))
    expect(paneIds).toEqual([sidA, sidC, sidB])
    // The split shows the pane it was split from beside the new one; the
    // third tab stays hidden.
    expect(visiblePaneIds()).toEqual([sidA, sidC])
    // Switching to another tab shows only its singleton group…
    fireEvent.click(screen.getByText('终端 2'))
    expect(visiblePaneIds()).toEqual([sidB])
    // …and switching back to a member of the split group shows the whole
    // pair again — the split survives the tab switch.
    fireEvent.click(screen.getByText('终端 3'))
    expect(visiblePaneIds()).toEqual([sidA, sidC])
    // Focusing the other member keeps the pair stacked.
    fireEvent.click(screen.getByText('终端 1'))
    expect(visiblePaneIds()).toEqual([sidA, sidC])
  })

  it('renames a terminal tab by double-clicking its label', async () => {
    await connectTerminal()
    const sidA = firstSessionId()
    fireEvent.doubleClick(screen.getByText('终端 1'))
    const input = screen.getByLabelText('重命名终端 1')
    fireEvent.change(input, { target: { value: '日志' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('日志')).toBeTruthy()
    // The renamed label drives the close-button aria label and the toolbar.
    expect(screen.getByRole('button', { name: '关闭日志' })).toBeTruthy()
    expect(termOf(sidA).cleared).toBe(0)
    // An empty or unchanged commit leaves the label as-is.
    fireEvent.doubleClick(screen.getByText('日志'))
    const again = screen.getByLabelText('重命名日志')
    fireEvent.change(again, { target: { value: '   ' } })
    fireEvent.keyDown(again, { key: 'Enter' })
    expect(screen.getByText('日志')).toBeTruthy()
  })

  it('closes a pane from its tab and keeps the others', async () => {
    await connectTerminal()
    const sidA = firstSessionId()
    fireEvent.click(screen.getByRole('button', { name: '新终端' }))
    await waitFor(() => { expect(MockTerminal.instances.length).toBe(2) }, { timeout: 3000 })
    const sidB = MockEventSource.instances
      .map(x => decodeURIComponent(x.url.split('session=')[1] ?? ''))
      .find(id => id !== sidA)!
    fireEvent.click(screen.getByRole('button', { name: '关闭终端 2' }))
    await waitFor(() => { expect(vi.mocked(api.termKill)).toHaveBeenCalledWith(sidB) })
    await waitFor(() => { expect(document.querySelectorAll('[data-term-pane]').length).toBe(1) }, { timeout: 3000 })
    // The first pane is still live.
    streamOf(sidA).emit('A2')
    await waitFor(() => { expect(termOf(sidA).writes).toContain('A2') }, { timeout: 3000 })
  })

  it('closes an inactive pane while another stays active', async () => {
    await connectTerminal()
    const sidA = firstSessionId()
    fireEvent.click(screen.getByRole('button', { name: '新终端' }))
    await waitFor(() => { expect(MockTerminal.instances.length).toBe(2) }, { timeout: 3000 })
    const sidB = MockEventSource.instances
      .map(x => decodeURIComponent(x.url.split('session=')[1] ?? ''))
      .find(id => id !== sidA)!
    // 终端 2 is active; closing the inactive 终端 1 keeps 终端 2 active.
    fireEvent.click(screen.getByRole('button', { name: '关闭终端 1' }))
    await waitFor(() => { expect(document.querySelectorAll('[data-term-pane]').length).toBe(1) }, { timeout: 3000 })
    expect(document.querySelector('[data-term-pane]')?.getAttribute('data-session')).toBe(sidB)
    // The toolbar still acts on the surviving session.
    fireEvent.click(screen.getByText('清屏'))
    expect(termOf(sidB).cleared).toBe(1)
  })

  it('surfaces respawn failures from the 启动 button', async () => {
    await connectTerminal()
    const sid = firstSessionId()
    vi.mocked(api.termSpawn).mockResolvedValueOnce({ ok: false, error: 'respawn boom' })
    fireEvent.click(screen.getByText('启动'))
    await waitFor(() => { expect(screen.getByText('respawn boom')).toBeTruthy() })
    vi.mocked(api.termSpawn).mockRejectedValueOnce(new Error('respawn err'))
    fireEvent.click(screen.getByText('启动'))
    await waitFor(() => { expect(screen.getByText('respawn err')).toBeTruthy() })
    vi.mocked(api.termSpawn).mockRejectedValueOnce('plain respawn')
    fireEvent.click(screen.getByText('启动'))
    await waitFor(() => { expect(screen.getByText('plain respawn')).toBeTruthy() })
    // A generic failure payload falls back to the default text.
    vi.mocked(api.termSpawn).mockResolvedValueOnce({ ok: false })
    fireEvent.click(screen.getByText('启动'))
    await waitFor(() => { expect(screen.getByText('启动终端失败')).toBeTruthy() })
    // The session survives the failed restarts.
    expect(MockEventSource.instances.length).toBe(1)
    streamOf(sid).emit('still alive')
    await waitFor(() => { expect(termOf(sid).writes).toContain('still alive') }, { timeout: 3000 })
  })

  it('respawns one of two panes without disturbing the other', async () => {
    await connectTerminal()
    const sidA = firstSessionId()
    fireEvent.click(screen.getByRole('button', { name: '新终端' }))
    await waitFor(() => { expect(MockTerminal.instances.length).toBe(2) }, { timeout: 3000 })
    // Activate 终端 1 and restart it; the second pane keeps streaming.
    fireEvent.click(screen.getByText('终端 1'))
    fireEvent.click(screen.getByText('启动'))
    await waitFor(() => { expect(vi.mocked(api.termSpawn)).toHaveBeenLastCalledWith('/repo', sidA) }, { timeout: 3000 })
    await waitFor(() => { expect(MockTerminal.instances[0]!.resets).toBe(1) }, { timeout: 3000 })
    expect(MockTerminal.instances[1]!.resets).toBe(0)
    expect(MockEventSource.instances.length).toBe(2)
  })

  it('switches the active pane by clicking a tab', async () => {
    await connectTerminal()
    const sidA = firstSessionId()
    fireEvent.click(screen.getByRole('button', { name: '新终端' }))
    await waitFor(() => { expect(MockTerminal.instances.length).toBe(2) }, { timeout: 3000 })
    const sidB = MockEventSource.instances
      .map(x => decodeURIComponent(x.url.split('session=')[1] ?? ''))
      .find(id => id !== sidA)!
    // Term 1 (A) is active by default; clicking 终端 2 activates B, so the
    // toolbar's 清屏 hits B.
    fireEvent.click(screen.getByText('终端 2'))
    fireEvent.click(screen.getByText('清屏'))
    expect(termOf(sidB).cleared).toBe(1)
    expect(termOf(sidA).cleared).toBe(0)
  })

  it('restarts the active session in place with 启动', async () => {
    await connectTerminal()
    const sidA = firstSessionId()
    fireEvent.click(screen.getByText('启动'))
    await waitFor(() => { expect(vi.mocked(api.termSpawn)).toHaveBeenLastCalledWith('/repo', sidA) }, { timeout: 3000 })
    await waitFor(() => { expect(MockTerminal.instances[0]!.resets).toBe(1) }, { timeout: 3000 })
    // The pane and its stream stay on the same session id.
    expect(MockEventSource.instances.length).toBe(1)
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
    let resolveSpawn: (value: { ok: boolean; id?: string }) => void = () => {}
    vi.mocked(api.termSpawn).mockImplementation(() => new Promise((resolve) => { resolveSpawn = resolve }))
    render(<RightPanel {...panelProps()} />)
    await waitFor(() => { expect(vi.mocked(api.termSpawn)).toHaveBeenCalledTimes(1) })
    // Re-render (tab switch and back) while pending must not re-arm.
    fireEvent.click(screen.getByRole('button', { name: 'Git 工作区' }))
    fireEvent.click(screen.getByRole('button', { name: '终端' }))
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(vi.mocked(api.termSpawn)).toHaveBeenCalledTimes(1)
    resolveSpawn({ ok: true, id: 'term-1' })
    await waitFor(() => { expect(MockTerminal.instances.length).toBe(1) }, { timeout: 3000 })
  })

  it('does not auto-connect when the panel is collapsed', async () => {
    render(<RightPanel {...panelProps({ collapsed: true })} />)
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(vi.mocked(api.termSpawn)).not.toHaveBeenCalled()
  })
})

describe('RightPanel coverage arms', () => {
  it('streams output and drops malformed frames', async () => {
    await connectTerminal()
    const sid = firstSessionId()
    const s = streamOf(sid)
    s.emit('x')
    await waitFor(() => { expect(termOf(sid).writes).toContain('x') }, { timeout: 3000 })
    // A malformed frame is ignored; the stream keeps working.
    ;(s.onmessage as (event: { data: string }) => void)({ data: 'not json' })
    s.emit('y')
    await waitFor(() => { expect(termOf(sid).writes).toContain('y') }, { timeout: 3000 })
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

  it('tolerates kill, write and resize rejections', async () => {
    vi.mocked(api.termKill).mockRejectedValueOnce(new Error('kill fail'))
    vi.mocked(api.termWrite).mockRejectedValueOnce(new Error('write fail'))
    vi.mocked(api.termResize).mockRejectedValueOnce(new Error('resize fail'))
    await connectTerminal()
    const sid = firstSessionId()
    const t = termOf(sid)
    t.typeData('x') // write rejects → swallowed
    t.resizeTo(100, 40) // resize rejects → swallowed
    await waitFor(() => { expect(vi.mocked(api.termWrite)).toHaveBeenCalledWith(sid, 'x') })
    await waitFor(() => { expect(vi.mocked(api.termResize)).toHaveBeenCalledWith(sid, 100, 40) })
    fireEvent.click(screen.getByText('终止')) // kill rejects → swallowed
    await waitFor(() => { expect(vi.mocked(api.termKill)).toHaveBeenCalledWith(sid) })
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
    fireEvent.click(screen.getByRole('button', { name: '终端' }))
    expect(MockTerminal.instances.length).toBe(1)
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

  it('renders an ahead-and-behind delta with the separator', async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 2, behind: 1, changes: [] })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(screen.getByText(/领先 2/)).toBeTruthy() })
    expect(screen.getByText(/落后 1/)).toBeTruthy()
    expect(screen.getByText(/ · /)).toBeTruthy()
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
})

describe('git source-control interactions', () => {
  /** Open the Git tab with a fixed three-group status. */
  async function openGit(changes: Array<{ index: string; worktree: string; path: string }>): Promise<void> {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 0, behind: 0, changes })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(await screen.findByText('Git 工作区'))
    await waitFor(() => { expect(vi.mocked(api.gitStatus)).toHaveBeenCalledWith('/repo') })
    await waitFor(() => { expect(screen.getByLabelText('提交消息')).toBeTruthy() })
  }

  it('commits a message through the commit box and refreshes', async () => {
    await openGit([{ index: 'M', worktree: ' ', path: 'a.ts' }])
    const input = screen.getByLabelText('提交消息')
    fireEvent.change(input, { target: { value: 'fix: a' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'commit', { message: 'fix: a', all: false }) })
    // The message box clears after a successful commit and the status refreshes.
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
    // 暂存 lives on the unstaged group row; 取消暂存 on the staged group row.
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
    // The unstaged row's discard restores from the index.
    fireEvent.click(within(screen.getByText('更改').closest('section') as HTMLElement).getByText('放弃'))
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'discard', { files: ['un.ts'] }) })
    // The staged row's discard restores from HEAD.
    fireEvent.click(within(screen.getByText('暂存的更改').closest('section') as HTMLElement).getByText('放弃'))
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'discard', { files: ['staged.ts'], staged: true }) })
  })

  it('runs group-level stage/unstage/discard actions', async () => {
    await openGit([
      { index: 'M', worktree: ' ', path: 'staged.ts' },
      { index: ' ', worktree: 'M', path: 'un.ts' },
      { index: '?', worktree: '?', path: 'new.txt' },
    ])
    // 更改 group: stage all and discard all.
    fireEvent.click(within(screen.getByText('更改').closest('section') as HTMLElement).getByText('全部暂存'))
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'stage', {}) })
    fireEvent.click(within(screen.getByText('更改').closest('section') as HTMLElement).getByText('放弃全部更改'))
    await waitFor(() => { expect(vi.mocked(api.gitAction)).toHaveBeenCalledWith('/repo', 'discard', {}) })
    // 暂存的更改 group: unstage all and discard all from HEAD.
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
    // Collapse and expand the other two groups too.
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
    // An empty message with Enter is a no-op too.
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
    // A rejected payload surfaces its message.
    vi.mocked(api.gitAction).mockRejectedValueOnce(new Error('git op boom'))
    fireEvent.click(stageBtn())
    await waitFor(() => { expect(screen.getByText('git op boom')).toBeTruthy() })
    // A string rejection payload falls back to String().
    vi.mocked(api.gitAction).mockRejectedValueOnce('plain op boom')
    fireEvent.click(stageBtn())
    await waitFor(() => { expect(screen.getByText('plain op boom')).toBeTruthy() })
    // Generic failure fallback.
    vi.mocked(api.gitAction).mockResolvedValueOnce({ ok: false })
    fireEvent.click(stageBtn())
    await waitFor(() => { expect(screen.getByText('Git 操作失败')).toBeTruthy() })
  })

  it('renders git group count badges on the commit-enabled tab', async () => {
    await openGit([
      { index: 'A', worktree: ' ', path: 'a.ts' },
      { index: ' ', worktree: 'M', path: 'b.ts' },
    ])
    expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(2)
  })
})

describe('git diff viewer', () => {
  /** Open the Git tab and click the named file's row to view its changes. */
  async function openDiff(path: string, changes: Array<{ index: string; worktree: string; path: string }>): Promise<void> {
    vi.mocked(api.gitStatus).mockResolvedValue({ ok: true, branch: 'main', ahead: 0, behind: 0, changes })
    render(<RightPanel {...panelProps()} />)
    fireEvent.click(await screen.findByText('Git 工作区'))
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
    // The add/delete lines carry a sign gutter and shiki-highlighted code.
    const addLine = [...document.querySelectorAll('[data-diff-kind="add"]')]
      .find(el => (el as HTMLElement).textContent?.includes('const answer = 42')) as HTMLElement
    expect(addLine.textContent).toContain('const answer = 42')
    // The `const` keyword token resolves through a --shiki-* custom property.
    const keyword = addLine.querySelector('span[style*="--shiki"]')
    expect(keyword?.textContent).toBe('const')
    expect(screen.getByText('@@ -1 +1 @@')).toBeTruthy()
    expect(screen.getByText('same line')).toBeTruthy()
    // The commit box is hidden while viewing the diff.
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
    // A not-yet-answered fetch shows the loading state.
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
    // A resolution that lands after the pane closed.
    let resolveDiff: (value: GitDiffResult | PromiseLike<GitDiffResult>) => void = () => {}
    vi.mocked(api.gitDiff).mockImplementationOnce(() => new Promise((resolve) => { resolveDiff = resolve }))
    await openDiff('un.ts', [{ index: ' ', worktree: 'M', path: 'un.ts' }])
    await waitFor(() => { expect(screen.getByText('加载中…')).toBeTruthy() }, { timeout: 3000 })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    resolveDiff({ ok: true, diff: 'late', untracked: false, path: 'un.ts' })
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    expect(screen.getByLabelText('提交消息')).toBeTruthy()

    // A rejection that lands after the pane closed.
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
