/**
 * Shared workspace-path selection used by both slots: the git chip reads the
 * current session's workspace path and the terminal sidebar does too (through
 * the current-session id). The selector hook is invoked unconditionally so the
 * hook order stays stable across renders (rules of hooks); the session-id
 * guard lives inside the selector.
 */
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Resolve the workspace path that owns the given session.
 * @param useWorkspaces - the global workspaces selector hook (may be absent).
 * @param sessionId - the session to look up; absent resolves to undefined.
 * @returns the owning workspace's canonical path, or undefined.
 */
export function workspacePathOf(
  useWorkspaces: SnapshotSelectorHook<WorkspaceListState> | undefined,
  sessionId: SessionId | undefined,
): string | undefined {
  if (useWorkspaces === undefined) return undefined
  return useWorkspaces((state) => {
    if (sessionId === undefined) return undefined
    const workspace = state.items.find(entry => entry.sessionIds.includes(sessionId))
    return workspace === undefined ? undefined : workspace.path
  })
}
