/**
 * Git branch chip: a composer-row pill showing the current workspace branch
 * with an anchored branch-switcher menu (list of local branches, checkout on
 * click). Reads the session's workspace path through the global useWorkspaces
 * hook and talks to the node half's /api/workspace-ext routes.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconBranchOutline16, IconChevronDownOutline14 } from './icons.tsx'
// Type-only: pull the slot-declaration and standard-props merges into the type graph.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { api, type GitBranchInfo } from './api.ts'
import css from './styles.module.css'
import { workspacePathOf } from './workspace-path.ts'

/** Composed props of the `conversation.input.left` entry. */
export type GitBranchChipProps = PropsRuntime<'conversation.input.left'>

interface BranchMenuState {
  open: boolean
  branches: string[] | null
  busy: boolean
  error: string | null
}

/**
 * Render the branch chip (or nothing when the session has no git workspace).
 * @param props - slot props with the global hooks and the session id.
 */
export function GitBranchChip(props: GitBranchChipProps): ReactNode | null {
  const path = workspacePathOf(props.useWorkspaces, props.sessionId)
  const [info, setInfo] = useState<GitBranchInfo | null>(null)
  const [menu, setMenu] = useState<BranchMenuState>({ open: false, branches: null, busy: false, error: null })
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let alive = true
    if (path === undefined) {
      setInfo(null)
      return undefined
    }
    void api.gitBranch(path).then((result) => {
      if (alive) setInfo(result)
    }).catch(() => { if (alive) setInfo(null) })
    return () => { alive = false }
  }, [path, refresh])

  if (path === undefined || info === null || !info.ok || info.branch === null || info.branch === '') return null

  const openMenu = (): void => {
    if (menu.open) {
      setMenu({ open: false, branches: null, busy: false, error: null })
      return
    }
    setMenu({ open: true, branches: null, busy: false, error: null })
    void api.gitBranches(path).then((result) => {
      setMenu(prev => ({ ...prev, branches:  result.ok && result.branches !== undefined ? result.branches : [] }))
    }).catch(() => {
      setMenu(prev => ({ ...prev, branches: [] }))
    })
  }

  const checkout = (branch: string): void => {
    /* v8 ignore next -- the current branch is disabled in the menu, so this guard cannot be reached from the UI */
    if (branch === info.branch) return
    setMenu(prev => ({ ...prev, busy: true, error: null }))
    void api.gitCheckout(path, branch).then((result) => {
      if (result.ok) {
        setMenu({ open: false, branches: null, busy: false, error: null })
        setRefresh(tick => tick + 1)
      } else {
        setMenu(prev => ({ ...prev, busy: false, error: result.error ?? '切换分支失败' }))
      }
    }).catch((error: unknown) => {
      setMenu(prev => ({ ...prev, busy: false, error: error instanceof Error ? error.message : String(error) }))
    })
  }

  return (
    <span className={css.gitWrap}>
      <button
        type="button"
        className={css.gitChip}
        title={`${info.detached ? 'detached HEAD · ' : ''}${info.path}（点击切换分支）`}
        onClick={openMenu}
      >
        {/* SVG chrome matching the sibling access-mode selector: a neutral
            icon + label + rotating chevron, all in the trigger's text color. */}
        <span className={css.gitIcon} aria-hidden><IconBranchOutline16 size={14} /></span>
        <span className={css.gitName}>{info.branch}</span>
        <span className={menu.open ? `${css.gitCaret} ${css.gitCaretOpen}` : css.gitCaret} aria-hidden>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {menu.open ? (
        <div className={css.gitMenu}>
          {menu.busy ? <div className={css.gitMenuNote}>切换中…</div>
            : menu.error !== null ? <div className={`${css.gitMenuNote} ${css.gitMenuError}`}>{menu.error}</div>
              : menu.branches === null ? <div className={css.gitMenuNote}>加载中…</div>
                : menu.branches.length === 0 ? <div className={css.gitMenuNote}>无本地分支</div>
                  : (
                    <div>
                      {menu.branches.map(branch => (
                        <button
                          key={branch}
                          type="button"
                          className={branch === info.branch ? `${css.gitItem} ${css.gitItemCurrent}` : css.gitItem}
                          onClick={() => { checkout(branch) }}
                          disabled={menu.busy || branch === info.branch}
                        >
                          <span className={css.gitItemMark}>{branch === info.branch ? '✓' : ''}</span>
                          <span>{branch}</span>
                        </button>
                      ))}
                    </div>
                  )}
        </div>
      ) : null}
    </span>
  )
}
