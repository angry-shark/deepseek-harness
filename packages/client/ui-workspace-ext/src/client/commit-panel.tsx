/**
 * Git commit history panel: the `提交历史` tab of the right workspace panel.
 * Fetches the branch's `git log` through the node half and lists each commit
 * (short hash, date, author, subject), refreshed by a toolbar button.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { workspacePathOf } from './workspace-path.ts'
import { api, type GitCommitInfo } from './api.ts'
import css from './styles.module.css'

/** Composed props of the `shell.right` content (forwarded by the tab shell). */
export type CommitPanelProps =
  PropsRuntime<'shell.right'>

/**
 * The commit-history tab body.
 * @param props - slot props: layout owner state (collapsed/width), global
 * hooks, and the injected toggleRight callback.
 */
export function CommitPanel(props: CommitPanelProps): ReactNode {
  const { collapsed } = props
  const sessionId = props.useSessions(state => state.current)
  const path = workspacePathOf(props.useWorkspaces, sessionId)
  const [commits, setCommits] = useState<GitCommitInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (collapsed || path === undefined) return
    let current = true
    setBusy(true)
    setError(null)
    void api.gitLog(path).then((result) => {
      if (!current) return
      if (result.ok) setCommits(result.commits ?? [])
      else setError(result.error ?? '读取提交记录失败')
    }).catch((caught: unknown) => {
      if (current) setError(caught instanceof Error ? caught.message : String(caught))
    }).finally(() => {
      if (current) setBusy(false)
    })
    return () => { current = false }
  }, [collapsed, path, tick])

  return (
    <div className={css.gitPanelBody}>
      <div className={css.termToolbar}>
        <button
          type="button"
          className={css.headBtn}
          onClick={() => { setTick(tick => tick + 1) }}
          disabled={busy || path === undefined}
        >
          刷新
        </button>
      </div>
      {error !== null ? <div className={css.termError}>{error}</div> : null}
      {commits === null ? (
        <p className={css.gitStatus}>{busy ? '加载中…' : '无法读取提交记录。'}</p>
      ) : commits.length === 0 ? (
        <p className={css.gitStatus}>当前分支暂无提交。</p>
      ) : (
        <ul className={css.gitCommits}>
          {commits.map((commit, index) => (
            <li className={css.gitCommitRow} key={`${commit.hash}:${index}`}>
              <code className={css.gitCommitHash}>{commit.hash}</code>
              <div className={css.gitCommitMeta}>
                <span className={css.gitCommitMsg}>{commit.message}</span>
                <span className={css.gitCommitSub}>{commit.author} · {commit.date}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
