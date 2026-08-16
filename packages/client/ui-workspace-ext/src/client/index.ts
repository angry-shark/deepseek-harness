/**
 * Workspace enhancements, browser half. Two registrations: the git branch
 * chip with its anchored switcher menu fills the composer tool row's
 * `conversation.input.left` seat, and the right terminal sidebar fills the
 * frame-wide `shell.overlay` layer (rail when collapsed, panel when open).
 * Both talk to the node half's same-origin /api/workspace-ext routes.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pull the standard-props merge into the type graph.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { GitBranchChip } from './git-chip.tsx'
import { TerminalBar } from './terminal-bar.tsx'

export type { GitBranchChipProps } from './git-chip.tsx'
export type { TerminalBarProps } from './terminal-bar.tsx'
export { stripAnsi } from './terminal-bar.tsx'
export { workspacePathOf } from './workspace-path.ts'
export { api, type GitBranchInfo, type GitBranchesResult, type GitCheckoutResult, type TermPoll, type TermStatus } from './api.ts'

/** Required services: the slot registry. */
export const inject = ['slots']

/**
 * Register the git chip and the terminal sidebar once their slot declarations
 * are on the ledger (activation order between entries is unconstrained).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    { name: 'conversation.input.left', id: 'git-branch-chip', order: -100 },
    GitBranchChip,
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'terminal-bar', order: 100 },
    TerminalBar,
  ))
}
