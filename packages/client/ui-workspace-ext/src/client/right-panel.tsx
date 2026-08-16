/**
 * Right workspace panel: a full-height rail on the right edge that expands
 * into a 360px tabbed panel. Two tabs, modeled on the VS Code bottom panel:
 * the terminal runs bash in the current session's workspace directory (it
 * auto-connects when the panel opens, so no manual start is needed), and the
 * Git tab shows the working-tree status parsed from `git status --porcelain`.
 * Collapse and expand animate through a width + fade transition (the content
 * stays mounted while the width animates, then unmounts at settle).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull the slot-declaration and standard-props merges into the type graph.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { api, type GitStatusInfo } from './api.ts'
import css from './styles.module.css'
import { workspacePathOf } from './workspace-path.ts'

/** Composed props of the `shell.overlay` entry. */
export type RightPanelProps = PropsRuntime<'shell.overlay'>

/** Client-side output cap: the oldest lines are dropped past this length. */
const OUTPUT_CAP = 8000

/** Poll interval while the terminal runs. */
const POLL_MS = 500

/** Width transition duration; matches the .rightPanel transition. */
const COLLAPSE_SETTLE_MS = 180

/** Strip ANSI/OSC escape sequences so terminal output renders as plain text. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_][0-9]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/** One-character status code with a stable label, or null for the space code. */
function codeLabel(code: string): string | null {
  if (code === ' ' || code === '') return null
  if (code === '?') return '未跟踪'
  if (code === 'M') return '已修改'
  if (code === 'A') return '已添加'
  if (code === 'D') return '已删除'
  if (code === 'R') return '已重命名'
  if (code === 'C') return '已复制'
  if (code === 'U') return '冲突'
  return code
}

/**
 * Render the right rail when collapsed or the tabbed panel when expanded.
 * @param props - slot props with the global session/workspace hooks.
 */
export function RightPanel(props: RightPanelProps): ReactNode {
  const sessionId = props.useSessions(state => state.current)
  const path = workspacePathOf(props.useWorkspaces, sessionId)
  const [expanded, setExpanded] = useState(false)
  const [settled, setSettled] = useState(true)
  const [tab, setTab] = useState<'terminal' | 'git'>('terminal')
  const [spawned, setSpawned] = useState(false)
  const [exited, setExited] = useState(true)
  const [out, setOut] = useState('')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [git, setGit] = useState<GitStatusInfo | null>(null)
  const [gitBusy, setGitBusy] = useState(false)
  const [gitError, setGitError] = useState<string | null>(null)
  const [gitTick, setGitTick] = useState(0)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const spawningRef = useRef(false)

  // The content stays mounted while the collapse width animates, then
  // unmounts (and the rail takes over) at settle; expanding unmounts the rail
  // immediately so the fade-in starts on the first frame.
  useEffect(() => {
    if (expanded) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [expanded])
  const showing = expanded || !settled

  // The spawn routine lives in a ref so the auto-connect effect below can
  // call it without re-arming on every render.
  /* v8 ignore next -- the initial ref value is replaced before any render's effects run, so it never executes */
  const spawnRef = useRef<() => void>(() => { /* replaced below */ })
  spawnRef.current = () => {
    // UI-disabled guard arms: the button is disabled while busy or without a path,
    // and the auto-connect effect checks the same flags.
    /* v8 ignore next 2 -- both guard arms are unreachable from the UI */
    if (spawningRef.current || path === undefined) return
    spawningRef.current = true
    setBusy(true)
    setError(null)
    setOut('')
    void api.termSpawn(path).then((result) => {
      if (result.ok) {
        setSpawned(true)
        setExited(false)
      } else {
        setError(result.error ?? '启动终端失败')
      }
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught))
    }).finally(() => {
      spawningRef.current = false
      setBusy(false)
    })
  }

  // Auto-connect: opening the panel with the terminal tab active spawns a
  // fresh session when none is running and a workspace path exists.
  useEffect(() => {
    if (!expanded || tab !== 'terminal' || path === undefined || spawned || spawningRef.current) return
    spawnRef.current()
  }, [expanded, tab, path, spawned])

  useEffect(() => {
    if (!expanded || !spawned || exited) return undefined
    const id = window.setInterval(() => {
      void api.termPoll().then((result) => {
        if (!result.ok) return
        if (result.out !== '') {
          setOut((prev) => {
            const next = prev + stripAnsi(result.out)
            return next.length > OUTPUT_CAP ? next.slice(next.length - OUTPUT_CAP) : next
          })
        }
        if (result.exited) setExited(true)
      }).catch(() => { /* transient poll failure */ })
    }, POLL_MS)
    return () => { window.clearInterval(id) }
  }, [expanded, spawned, exited])

  useEffect(() => {
    if (boxRef.current !== null) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [out, expanded])

  // Fetch the working-tree status whenever the Git tab becomes visible.
  useEffect(() => {
    if (!expanded || tab !== 'git' || path === undefined) return
    let current = true
    setGitBusy(true)
    setGitError(null)
    void api.gitStatus(path).then((result) => {
      if (!current) return
      if (result.ok) {
        setGit(result)
      } else {
        setGitError(result.error ?? '读取 Git 状态失败')
        setGit(null)
      }
    }).catch((caught: unknown) => {
      if (current) {
        setGitError(caught instanceof Error ? caught.message : String(caught))
        setGit(null)
      }
    }).finally(() => {
      if (current) setGitBusy(false)
    })
    return () => { current = false }
  }, [expanded, tab, path, gitTick])

  const running = spawned && !exited

  const kill = (): void => {
    void api.termKill().then(() => { setSpawned(false); setExited(true) }).catch(() => { /* ignore */ })
  }

  const send = (): void => {
    const text = input
    /* v8 ignore next -- the `!running` arm is unreachable: the input and 发送 button are disabled while not running */
    if (text === '' || !running) return
    setInput('')
    void api.termWrite(`${text}\n`).catch(() => { /* ignore */ })
  }

  return (
    <div
      className={expanded ? css.rightPanel : settled ? css.rightRail : css.rightPanelCollapsing}
      onClick={!showing ? () => { setExpanded(true) } : undefined}
      title={!showing ? '展开工作区面板' : undefined}
    >
      {showing ? (
        <div className={css.panelContent}>
          <div className={css.panelHead}>
            <button
              type="button"
              className={tab === 'terminal' ? `${css.panelTab} ${css.panelTabOn}` : css.panelTab}
              onClick={() => { setTab('terminal') }}
            >
              终端
            </button>
            <button
              type="button"
              className={tab === 'git' ? `${css.panelTab} ${css.panelTabOn}` : css.panelTab}
              onClick={() => { setTab('git') }}
            >
              Git 工作区
            </button>
            <span className={css.panelCwd} title={path}>{path?.split('/').filter(Boolean).pop() ?? ''}</span>
            <button type="button" className={css.termBtn} onClick={() => { setExpanded(false) }}>收起</button>
          </div>
          {tab === 'terminal' ? (
            <div className={css.termBody}>
              {error === null ? null : <div className={css.termError}>{error}</div>}
              <div className={css.termOut} ref={boxRef}>
                <pre>
                  {out !== '' ? out
                    : !spawned ? `终端未连接。${path === undefined ? '当前会话没有工作区。' : '点击「启动」在 ' + path + ' 打开 bash。'}`
                      : running ? '等待输出…'
                        : '终端已退出。'}
                </pre>
              </div>
              <div className={css.termInput}>
                <input
                  value={input}
                  onChange={(event) => { setInput(event.currentTarget.value) }}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); send() } }}
                  placeholder="输入命令，回车执行"
                  disabled={!running}
                  spellCheck={false}
                />
                <button type="button" className={css.termBtn} onClick={send} disabled={!running}>发送</button>
              </div>
              <div className={css.termActions}>
                <button type="button" className={css.termBtn} onClick={() => { spawnRef.current() }} disabled={busy || running || path === undefined}>启动</button>
                <button type="button" className={css.termBtn} onClick={kill} disabled={!spawned}>终止</button>
                <button type="button" className={css.termBtn} onClick={() => { setOut('') }}>清屏</button>
              </div>
            </div>
          ) : (
            <div className={css.gitBody}>
              {gitError !== null ? <div className={css.termError}>{gitError}</div> : null}
              {git === null ? (
                <p className={css.gitStatus}>{gitBusy ? '加载中…' : '无法读取 Git 状态。'}</p>
              ) : (
                <>
                  <div className={css.gitSummary}>
                    <span className={css.gitBranch}>{git.branch ?? '(detached HEAD)'}</span>
                    {(git.ahead > 0 || git.behind > 0)
                      ? <span className={css.gitDelta}>
                        {git.ahead > 0 ? `领先 ${git.ahead}` : ''}
                        {git.ahead > 0 && git.behind > 0 ? ' · ' : ''}
                        {git.behind > 0 ? `落后 ${git.behind}` : ''}
                      </span>
                      : null}
                  </div>
                  <p className={css.gitStatus}>
                    {git.changes.length === 0 ? '工作区干净，没有未提交的变更。' : `${git.changes.length} 个变更`}
                  </p>
                  {git.changes.length > 0 ? (
                    <ul className={css.gitList}>
                      {git.changes.map((change, index) => (
                        <li className={css.gitRow} key={`${change.path}:${index}`}>
                          <span className={css.gitCodes}>
                            <span className={css.gitCode} data-kind={change.index}>{codeLabel(change.index) ?? ''}</span>
                            <span className={css.gitCode} data-kind={change.worktree}>{codeLabel(change.worktree) ?? ''}</span>
                          </span>
                          <code className={css.gitPath}>{change.path}</code>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
              <div className={css.termActions}>
                <button
                  type="button"
                  className={css.termBtn}
                  disabled={gitBusy || path === undefined}
                  onClick={() => { setGitTick(tick => tick + 1) }}
                >
                  刷新
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className={css.railLabel}>终端 · Git</div>
      )}
    </div>
  )
}
