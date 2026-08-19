/**
 * Workspace enhancements, browser half. Three registrations: the git branch
 * chip with its anchored switcher menu fills the composer tool row's
 * `conversation.input.left` seat, the terminal fills the frame's `shell.bottom`
 * track (VS Code-style: split panes side by side, a vertical tab column on the
 * right), and the tabbed right workspace panel (Git + 提交历史) fills the
 * `shell.right` column. All talk to the node half's same-origin
 * /api/workspace-ext routes.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pull the standard-props merge into the type graph.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { GitBranchChip } from './git-chip.tsx'
import { RightPanel } from './right-panel.tsx'
import { RightTabs } from './right-tabs.tsx'

export type { GitBranchChipProps } from './git-chip.tsx'
export type { RightPanelProps } from './right-panel.tsx'
export type { RightTabsProps } from './right-tabs.tsx'
export type { GitPanelProps } from './git-panel.tsx'
export type { CommitPanelProps } from './commit-panel.tsx'
export { workspacePathOf } from './workspace-path.ts'
export { api, type GitActionResult, type GitBranchInfo, type GitBranchesResult, type GitCheckoutResult, type GitCommitInfo, type GitDiffResult, type GitLogResult, type GitStatusInfo, type TermStatus } from './api.ts'

/** Required services: the slot registry and the layout panel actions. */
export const inject = ['slots', 'layout']

/**
 * Register the git chip, the bottom terminal, and the tabbed right panel once
 * their slot declarations are on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    { name: 'conversation.input.left', id: 'git-branch-chip', order: -100 },
    GitBranchChip,
  ))
  ctx.slots.inject('shell.bottom', () => ctx.slots.register({
    name: 'shell.bottom',
    // The layout service face opens/closes the bottom track (the layout menu's
    // 底部 button drives it through ctx.layout.toggleBottom).
    inject: () => ({ toggleBottom: () => { ctx.layout.toggleBottom() } }),
  }, RightPanel))
  ctx.slots.inject('shell.right', () => ctx.slots.register({
    name: 'shell.right',
    // The layout service face opens/closes the right column (the 右侧 button
    // and the rail tabs drive it through ctx.layout.toggleRight).
    inject: () => ({ toggleRight: () => { ctx.layout.toggleRight() } }),
  }, RightTabs))
}
