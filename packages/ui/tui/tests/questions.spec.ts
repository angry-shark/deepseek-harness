/**
 * The dialog host: FIFO overlay presentation, option mapping, and the
 * approval/question answerers settling through a fake TUI.
 */
import { describe, expect, it, vi } from 'vitest'
import { SelectList, type Component } from '@earendil-works/pi-tui'
import type { TUI } from '@earendil-works/pi-tui'
import { createPalette } from '../src/theme.ts'
import { DialogHost, askApproval, askQuestion, questionOptions } from '../src/questions.ts'

const emptyTheme = {
  selectedPrefix: (text: string) => text,
  selectedText: (text: string) => text,
  description: (text: string) => text,
  scrollInfo: (text: string) => text,
  noMatch: (text: string) => text,
}

/** The fake TUI's concrete type: plain vi.fn properties, not interface methods. */
type FakeTui = ReturnType<typeof fakeTui>

function fakeTui() {
  return {
    showOverlay: vi.fn(() => ({ hide: vi.fn() })),
    hideOverlay: vi.fn(),
  }
}

function shownList(tui: FakeTui): SelectList {
  const calls = vi.mocked(tui.showOverlay).mock.calls as unknown as [Component][]
  const overlay = calls[0]?.[0]
  const walk = (node: Component | undefined): SelectList | undefined => {
    if (node instanceof SelectList) return node
    const children = (node as { children?: Component[] } | undefined)?.children
    if (children === undefined) return undefined
    for (const child of children) {
      const found = walk(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  const list = walk(overlay)
  if (list === undefined) throw new Error('no SelectList in the shown overlay')
  return list
}

/** The overlay handle mock captured by the last showOverlay call. */
function shownHandle(tui: FakeTui): { hide: ReturnType<typeof vi.fn> } {
  const results = vi.mocked(tui.showOverlay).mock.results as unknown as { value: { hide: ReturnType<typeof vi.fn> } }[]
  return results[0]?.value as { hide: ReturnType<typeof vi.fn> }
}

describe('questionOptions', () => {
  it('maps labels and optional descriptions', () => {
    expect(questionOptions([
      { label: 'a' },
      { label: 'b', description: 'the b option' },
    ])).toEqual([
      { value: 'a', label: 'a' },
      { value: 'b', label: 'b', description: 'the b option' },
    ])
  })
  it('yields an empty list without options', () => {
    expect(questionOptions(undefined)).toEqual([])
  })
})

describe('DialogHost', () => {
  it('shows one dialog at a time and settles the promise on close', async () => {
    const tui = fakeTui()
    const host = new DialogHost(tui as unknown as TUI, createPalette(false))
    let close: (outcome: { kind: 'answered'; label: string }) => void
    const pending = host.request((onClose) => {
      close = onClose
      return new SelectList([], 1, emptyTheme)
    }, undefined)
    expect(vi.mocked(tui.showOverlay)).toHaveBeenCalledTimes(1)
    close!({ kind: 'answered', label: 'yes' })
    await expect(pending).resolves.toEqual({ kind: 'answered', label: 'yes' })
    expect(shownHandle(tui).hide).toHaveBeenCalledTimes(1)
  })

  it('starts the next queued dialog once the active one closes', async () => {
    const tui = fakeTui()
    const host = new DialogHost(tui as unknown as TUI, createPalette(false))
    let closeFirst: (outcome: { kind: 'cancelled' }) => void
    const first = host.request((onClose) => {
      closeFirst = onClose
      return new SelectList([], 1, emptyTheme)
    }, undefined)
    let closeSecond: (outcome: { kind: 'cancelled' }) => void
    const second = host.request((onClose) => {
      closeSecond = onClose
      return new SelectList([], 1, emptyTheme)
    }, undefined)
    expect(vi.mocked(tui.showOverlay)).toHaveBeenCalledTimes(1)
    closeFirst!({ kind: 'cancelled' })
    await expect(first).resolves.toEqual({ kind: 'cancelled' })
    expect(vi.mocked(tui.showOverlay)).toHaveBeenCalledTimes(2)
    closeSecond!({ kind: 'cancelled' })
    await expect(second).resolves.toEqual({ kind: 'cancelled' })
  })

  it('cancels every pending dialog on closeAll', async () => {
    const tui = fakeTui()
    const host = new DialogHost(tui as unknown as TUI, createPalette(false))
    const pending = host.request(() => new SelectList([], 1, emptyTheme), undefined)
    host.closeAll()
    await expect(pending).resolves.toEqual({ kind: 'cancelled' })
  })
})

describe('approval answerer', () => {
  it('returns allowed-once when the user chooses Allow', async () => {
    const tui = fakeTui()
    const host = new DialogHost(tui as unknown as TUI, createPalette(false))
    const pending = askApproval(host, { agent: {} as never, toolName: 'bash', reason: 'run a command' })
    shownList(tui).onSelect?.({ value: 'allowed-once', label: 'Allow' })
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('returns rejected when the user chooses Reject', async () => {
    const tui = fakeTui()
    const host = new DialogHost(tui as unknown as TUI, createPalette(false))
    const pending = askApproval(host, { agent: {} as never, toolName: 'bash' })
    shownList(tui).onSelect?.({ value: 'rejected', label: 'Reject' })
    await expect(pending).resolves.toBe('rejected')
  })
})

describe('askQuestion', () => {
  it('settles with the chosen label', async () => {
    const tui = fakeTui()
    const host = new DialogHost(tui as unknown as TUI, createPalette(false))
    const pending = askQuestion(host, {
      questions: [{ id: 'q1', question: 'pick one', options: [{ label: 'yes' }] }],
    })
    shownList(tui).onSelect?.({ value: 'yes', label: 'yes' })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['yes'] }] })
  })

  it('rejects a cancelled dialog as ASK_ABORTED', async () => {
    const tui = fakeTui()
    const host = new DialogHost(tui as unknown as TUI, createPalette(false))
    const pending = askQuestion(host, {
      questions: [{ id: 'q1', question: 'pick one', options: [{ label: 'yes' }] }],
    })
    shownList(tui).onCancel?.()
    await expect(pending).rejects.toThrow('ask_user_question was aborted before the user answered')
  })

  it('rejects an empty question list as EMPTY_QUESTIONS', async () => {
    const tui = fakeTui()
    const host = new DialogHost(tui as unknown as TUI, createPalette(false))
    await expect(askQuestion(host, { questions: [] })).rejects.toThrow('at least one question')
  })
})
