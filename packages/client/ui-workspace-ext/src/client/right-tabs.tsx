/**
 * The right workspace panel shell (the `shell.right` occupant), now tabbed:
 * Git and 提交历史 (commit history) live as tabs, and further tabs can be
 * added. Collapsed it renders a compact edge rail carrying just the tabs;
 * clicking a tab expands the column on that tab. The active tab's content is
 * one of the tab panels, rendered with this entry's own shell.right props.
 */
import { useState, type ReactNode } from 'react'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { GitPanel } from './git-panel.tsx'
import { CommitPanel } from './commit-panel.tsx'
import css from './styles.module.css'

/** Registration-side injected face: the right-column toggle. */
export interface RightTabsInjected {
  /** Toggle the right column between the edge rail and the expanded panel. */
  toggleRight: () => void
}

/** Composed props of the `shell.right` entry. */
export type RightTabsProps =
  PropsRuntime<'shell.right'>
  & InjectFace<RightTabsInjected>

/** The right panel's tabs; order is the rail/header order. */
const TABS: ReadonlyArray<{ key: 'git' | 'log'; label: string }> = [
  { key: 'git', label: 'Git' },
  { key: 'log', label: '提交历史' },
]

/**
 * The tabbed right workspace panel. Collapsed it shows the rail with just the
 * tab buttons; expanded it shows the tab strip header + the active surface.
 * @param props - slot props: layout owner state (collapsed/width), global
 * hooks, and the injected toggleRight callback.
 */
export function RightTabs(props: RightTabsProps): ReactNode {
  const { collapsed, toggleRight } = props
  const [active, setActive] = useState<'git' | 'log'>('git')

  if (collapsed) {
    return (
      <div className={css.rightRail} aria-label="右侧工作区面板">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={css.railTab}
            data-tab={key}
            title={`展开${label}`}
            onClick={() => { setActive(key); toggleRight() }}
          >
            {label}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className={css.rightTabsBody}>
      <div className={css.panelHead}>
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={active === key ? `${css.panelTab} ${css.panelTabOn}` : css.panelTab}
            data-tab={key}
            onClick={() => { setActive(key) }}
          >
            {label}
          </button>
        ))}
        <span className={css.panelHeadSpacer} />
        <button
          type="button"
          className={css.collapseBtn}
          aria-label="收起右侧栏"
          title="收起右侧栏"
          onClick={() => { toggleRight() }}
        >
          <span className={css.panelRightIcon} aria-hidden />
        </button>
      </div>
      {active === 'git' ? <GitPanel {...props} /> : <CommitPanel {...props} />}
    </div>
  )
}
