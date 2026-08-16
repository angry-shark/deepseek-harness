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
    apply({ slots } as never)
    expect(inject).toEqual(['slots'])
    expect(registered.map(entry => `${entry.name}#${entry.id ?? ''}`).sort()).toEqual([
      'conversation.input.left#git-branch-chip',
      'shell.overlay#workspace-panel',
    ])
  })
})
