import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { workspacePathOf } from '../src/client/workspace-path.ts'

const sid = (id: string) => id as SessionId

function hook<T>(snapshot: T): SnapshotSelectorHook<T> {
  return function select<S>(selector: (state: T) => S): S {
    return selector(snapshot)
  }
}

function state(items: Array<{ sessionIds: string[]; path: string }>): WorkspaceListState {
  return {
    items: items as unknown as WorkspaceListState['items'],
    archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined,
  }
}

describe('workspacePathOf', () => {
  it('resolves the path of the workspace owning the session', () => {
    const path = workspacePathOf(hook(state([
      { sessionIds: ['other'], path: '/a' },
      { sessionIds: ['me'], path: '/b' },
    ])), sid('me'))
    expect(path).toBe('/b')
  })

  it('returns undefined when the session is unknown or absent', () => {
    const useWorkspaces = hook(state([{ sessionIds: ['other'], path: '/a' }]))
    expect(workspacePathOf(useWorkspaces, sid('nope'))).toBeUndefined()
    expect(workspacePathOf(useWorkspaces, undefined)).toBeUndefined()
  })

  it('returns undefined when the hook is absent', () => {
    expect(workspacePathOf(undefined, sid('me'))).toBeUndefined()
  })
})
