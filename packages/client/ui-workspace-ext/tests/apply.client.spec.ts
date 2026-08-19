import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

describe('workspace-ext browser apply', () => {
  it('registers the git chip, the bottom terminal, and the Git panel slots', () => {
    const registered: Array<{ name: string; id?: string }> = []
    const slots = {
      inject: vi.fn((_name: string, callback: () => unknown) => {
        const disposer = callback()
        if (typeof disposer === 'function') (disposer as () => void)()
      }),
      register: vi.fn((options: { name: string; id?: string }) => {
        registered.push(options)
        return () => {}
      }),
    }
    const layout = { toggleBottom: vi.fn(), toggleRight: vi.fn() }
    apply({ slots, layout } as never)
    expect(inject).toEqual(['slots', 'layout'])
    expect(registered.map(entry => entry.name).sort()).toEqual([
      'conversation.input.left',
      'shell.bottom',
      'shell.right',
    ])
    // Each panel registration injects its layout toggle, forwarding to the
    // layout service.
    const bottom = registered.find(entry => entry.name === 'shell.bottom') as
      { inject?: (() => { toggleBottom: () => void }) | undefined }
    bottom.inject?.()?.toggleBottom()
    expect(layout.toggleBottom).toHaveBeenCalledTimes(1)
    const right = registered.find(entry => entry.name === 'shell.right') as
      { inject?: (() => { toggleRight: () => void }) | undefined }
    right.inject?.()?.toggleRight()
    expect(layout.toggleRight).toHaveBeenCalledTimes(1)
  })
})
