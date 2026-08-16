import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

describe('workspace-ext browser apply', () => {
  it('registers the git chip and the workspace panel slots', () => {
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
    const layout = { toggleRight: vi.fn() }
    apply({ slots, layout } as never)
    expect(inject).toEqual(['slots', 'layout'])
    expect(registered.map(entry => entry.name).sort()).toEqual([
      'conversation.input.left',
      'shell.right',
    ])
    // The shell.right registration injects the layout toggle; the injected
    // callback must forward to the layout service.
    const right = registered.find(entry => entry.name === 'shell.right') as
      { inject?: (() => { toggleRight: () => void }) | undefined }
    const face = right.inject?.()
    face?.toggleRight()
    expect(layout.toggleRight).toHaveBeenCalledTimes(1)
  })
})
