// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { RightPanel, type RightPanelProps } from '../src/client/right-panel.tsx'
import { api } from '../src/client/api.ts'

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
    height: 220,
    toggleBottom: vi.fn(),
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

describe('RightPanel terminal', () => {
  it('renders the toolbar, the panes area, and the vertical tab column', async () => {
    render(<RightPanel {...panelProps()} />)
    expect(screen.getByRole('button', { name: '清屏' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '新终端' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '分屏' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '收起底部面板' })).toBeTruthy()
    // The terminal auto-connects into the (horizontal) panes area.
    await waitFor(() => { expect(document.querySelector('[data-term-pane]')).toBeTruthy() }, { timeout: 3000 })
  })

  it('calls toggleBottom from the collapse icon button', async () => {
    const toggleBottom = vi.fn()
    render(<RightPanel {...panelProps({ toggleBottom })} />)
    fireEvent.click(await screen.findByRole('button', { name: '收起底部面板' }))
    expect(toggleBottom).toHaveBeenCalledTimes(1)
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

  it('groups a split under one tab in the vertical column and renders panes side-by-side', async () => {
    await connectTerminal()
    const sidA = firstSessionId()
    // Split the active terminal: the new pane joins the same split group.
    fireEvent.click(screen.getByRole('button', { name: '分屏' }))
    await waitFor(() => { expect(MockTerminal.instances.length).toBe(2) }, { timeout: 3000 })
    const sidB = MockEventSource.instances
      .map(x => decodeURIComponent(x.url.split('session=')[1] ?? ''))
      .find(id => id !== sidA)!
    // Both panes are in the same tab group; the split pane is a nested sub-tab.
    const tabs = [...document.querySelectorAll('[data-tab-group]')]
    const groups = new Set(tabs.map(t => t.getAttribute('data-tab-group')))
    expect(groups.size).toBe(1)
    expect(tabs.some(t => t.getAttribute('data-nested') !== undefined)).toBe(true)
    // Both panes of the split group are visible together (side-by-side row).
    expect(visiblePaneIds()).toEqual([sidA, sidB])
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
    // A pending spawn must not re-arm on a re-render.
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
})
