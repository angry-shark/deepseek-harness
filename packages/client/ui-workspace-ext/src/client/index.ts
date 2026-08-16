/**
 * Workspace enhancements, browser half. Two registrations: the git branch
 * chip with its anchored switcher menu fills the composer tool row's
 * `conversation.input.left` seat, and the right workspace panel fills the
 * frame's `shell.right` column (rail when collapsed, tabbed panel when open).
 * Both talk to the node half's same-origin /api/workspace-ext routes.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pull the standard-props merge into the type graph.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { GitBranchChip } from './git-chip.tsx'
import { RightPanel } from './right-panel.tsx'

export type { GitBranchChipProps } from './git-chip.tsx'
export type { RightPanelProps } from './right-panel.tsx'
export { workspacePathOf } from './workspace-path.ts'
export { api, type GitBranchInfo, type GitBranchesResult, type GitCheckoutResult, type GitStatusInfo, type TermPoll, type TermStatus } from './api.ts'

/** Required services: the slot registry and the layout panel actions. */
export const inject = ['slots', 'layout']

/**
 * Register the git chip and the workspace panel once their slot declarations
 * are on the ledger (activation order between entries is unconstrained).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    { name: 'conversation.input.left', id: 'git-branch-chip', order: -100 },
    GitBranchChip,
  ))
  ctx.slots.inject('shell.right', () => ctx.slots.register({
    name: 'shell.right',
    // The layout service face drives the rail <-> panel transition through
    // ctx.layout.toggleRight (the same contract ui-sidebar uses).
    inject: () => ({ toggleRight: () => { ctx.layout.toggleRight() } }),
  }, RightPanel))
}
