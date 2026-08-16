/**
 * Right workspace panel: the `shell.right` column occupant. Collapsed it is a
 * compact full-height rail on the right edge; the layout column expands it to
 * the width the concession chain grants (open panels squeeze the center
 * column, mirroring the sidebar). Two tabs, modeled on the VS Code panel:
 * the terminal runs bash in the current session's workspace directory (it
 * auto-connects when the panel opens, so no manual start is needed), and the
 * Git tab shows the working-tree status parsed from `git status --porcelain`
 * as VS Code source-control groups (staged / unstaged / untracked). The
 * terminal output area uses a dark editor-style background and a prompt row;
 * the Git groups carry change-count badges.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { parseAnsiLines, type AnsiLine, IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pull the slot-declaration and standard-props merges into the type graph.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { api, type GitStatusInfo } from './api.ts'
import css from './styles.module.css'
import { workspacePathOf } from './workspace-path.ts'

/** Registration-side injected face: the layout toggle for the right column. */
export interface RightPanelInjected {
  /** Toggle the right column between the edge rail and the expanded panel. */
  toggleRight: () => void
}

/** Composed props of the `shell.right` entry. */
export type RightPanelProps =
  PropsRuntime<'shell.right'>
  & InjectFace<RightPanelInjected>

/** Client-side output cap: the oldest lines are dropped past this length. */
const OUTPUT_CAP = 8000

/** Poll interval while the terminal runs. */
const POLL_MS = 500

/** One porcelain status code with a VS Code-style glyph, or null for the space code. */
function codeGlyph(code: string): string | null {
  if (code === ' ' || code === '') return null
  if (code === 'M') return 'M'
  if (code === 'A') return 'A'
  if (code === 'D') return 'D'
  if (code === 'R') return 'R'
  if (code === 'C') return 'C'
  if (code === 'U') return 'U'
  return '?'
}

/** One change row regrouped into the VS Code source-control groups. */
interface GroupedChange {
  path: string
  /** The porcelain worktree-side code (M/A/D/...), space when none. */
  worktree: string
  /** The porcelain index-side code, space when none. */
  index: string
}

/** Split the flat change list into the three VS Code source-control groups. */
export function groupChanges(changes: Array<{ index: string; worktree: string; path: string }>): {
  staged: GroupedChange[]
  unstaged: GroupedChange[]
  untracked: GroupedChange[]
} {
  const staged: GroupedChange[] = []
  const unstaged: GroupedChange[] = []
  const untracked: GroupedChange[] = []
  for (const change of changes) {
    if (change.index === '?' && change.worktree === '?') {
      untracked.push({ path: change.path, worktree: change.worktree, index: change.index })
    } else if (change.index !== ' ') {
      staged.push({ path: change.path, worktree: change.worktree, index: change.index })
    } else {
      unstaged.push({ path: change.path, worktree: change.worktree, index: change.index })
    }
  }
  return { staged, unstaged, untracked }
}

/** One parsed output line: uncolored runs render as bare text, colored runs as spans. */
function renderAnsiLine(line: AnsiLine): ReactNode {
  return line.map((span, index) => span.style === undefined
    ? span.text
    : <span key={index} style={span.style}>{span.text}</span>)
}

/**
 * Render the right rail when collapsed or the tabbed panel when expanded.
 * @param props - slot props: layout owner state (collapsed/width), global
 * hooks, and the injected toggleRight callback.
 */
export function RightPanel(props: RightPanelProps): ReactNode {
  const { collapsed, toggleRight } = props
  const sessionId = props.useSessions(state => state.current)
  const path = workspacePathOf(props.useWorkspaces, sessionId)
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
  const inputRef = useRef<HTMLInputElement | null>(null)
  const spawningRef = useRef(false)

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
    if (collapsed || tab !== 'terminal' || path === undefined || spawned || spawningRef.current) return
    spawnRef.current()
  }, [collapsed, tab, path, spawned])

  useEffect(() => {
    if (collapsed || !spawned || exited) return undefined
    const id = window.setInterval(() => {
      void api.termPoll().then((result) => {
        if (!result.ok) return
        if (result.out !== '') {
          setOut((prev) => {
            // Raw PTY text is kept so cursor movements and SGR colors survive
            // to the ANSI renderer (parseAnsiLines) below.
            const next = prev + result.out
            return next.length > OUTPUT_CAP ? next.slice(next.length - OUTPUT_CAP) : next
          })
        }
        if (result.exited) setExited(true)
      }).catch(() => { /* transient poll failure */ })
    }, POLL_MS)
    return () => { window.clearInterval(id) }
  }, [collapsed, spawned, exited])

  useEffect(() => {
    if (boxRef.current !== null) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [out, collapsed])

  // Fetch the working-tree status whenever the Git tab becomes visible.
  useEffect(() => {
    if (collapsed || tab !== 'git' || path === undefined) return
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
  }, [collapsed, tab, path, gitTick])

  // Re-parse only when new output arrives; keystrokes re-render without cost.
  const parsedLines = useMemo(() => parseAnsiLines(out), [out])

  if (collapsed) {
    // The collapsed rail mirrors the left sidebar rail: a compact full-height
    // strip. The two panel tabs stack vertically; clicking one expands the
    // column already on that tab.
    return (
      <div className={css.rightRail} aria-label="右侧工作区面板">
        <button
          type="button"
          className={css.railTab}
          title="展开终端"
          onClick={() => { setTab('terminal'); toggleRight() }}
        >
          终端
        </button>
        <button
          type="button"
          className={css.railTab}
          title="展开 Git 工作区"
          onClick={() => { setTab('git'); toggleRight() }}
        >
          Git
        </button>
      </div>
    )
  }

  const running = spawned && !exited

  const kill = (): void => {
    void api.termKill().then(() => { setSpawned(false); setExited(true) }).catch(() => { /* ignore */ })
  }

  const send = (): void => {
    const text = input
    /* v8 ignore next -- the `!running` arm is unreachable: the inline input is hidden while not running */
    if (text === '' || !running) return
    setInput('')
    void api.termWrite(`${text}\n`).catch(() => { /* ignore */ })
  }

  const groups = git === null ? undefined : groupChanges(git.changes)
  const totalChanges = git?.changes.length ?? 0

  return (
    <div className={css.rightPanel}>
      <div className={css.panelHead}>
        <button
          type="button"
          className={tab === 'terminal' ? `${css.panelTab} ${css.panelTabOn}` : css.panelTab}
          onClick={() => { setTab('terminal') }}
        >
          {running ? <span className={css.termDot} aria-hidden /> : null}
          终端
        </button>
        <button
          type="button"
          className={tab === 'git' ? `${css.panelTab} ${css.panelTabOn}` : css.panelTab}
          onClick={() => { setTab('git') }}
        >
          Git 工作区
          {tab === 'git' && totalChanges > 0 ? <span className={css.panelTabBadge}>{totalChanges}</span> : null}
        </button>
        <span className={css.panelHeadSpacer} />
        {/* Collapse icon mirrors the sidebar's panel icon, pointing right
            (the column it closes sits on the right edge). */}
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
      {tab === 'terminal' ? (
        <div className={css.termBody}>
          <div className={css.termToolbar}>
            <button type="button" className={css.headBtn} onClick={() => { setOut('') }}>清屏</button>
            <button type="button" className={css.headBtn} onClick={kill} disabled={!spawned}>终止</button>
            <button
              type="button"
              className={css.headBtn}
              onClick={() => { spawnRef.current() }}
              disabled={busy || running || path === undefined}
            >
              启动
            </button>
          </div>
          {error === null ? null : <div className={css.termError}>{error}</div>}
          {/* One seamless dark surface, like the VS Code terminal: the shell's
              own stream (ANSI colors and cursor redraws replayed) fills the
              viewport, and the command input is an invisible field on the
              prompt line the shell just wrote. Clicking anywhere in the
              viewport focuses the command line; the focus call also scrolls
              the line into view when the output has pushed it below the
              fold. */}
          <div className={css.termOut} data-term-out ref={boxRef} onClick={() => { inputRef.current?.focus() }}>
            {out !== '' ? (
              parsedLines.map((line, index) => (
                <div className={css.termLineOut} key={index}>{renderAnsiLine(line)}</div>
              ))
            ) : (
              !spawned
                ? <div className={css.termStatus}>终端未连接。{path === undefined ? '当前会话没有工作区。' : `点击「启动」在 ${path} 打开 bash。`}</div>
                : exited ? <div className={css.termStatus}>终端已退出。</div>
                  : null
            )}
            {running ? (
              <div className={css.termLine}>
                <input
                  ref={inputRef}
                  aria-label="终端输入"
                  value={input}
                  onChange={(event) => { setInput(event.currentTarget.value) }}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); send() } }}
                  disabled={!running}
                  spellCheck={false}
                  autoFocus
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className={css.gitBody}>
          <div className={css.termToolbar}>
            <button
              type="button"
              className={css.headBtn}
              onClick={() => { setGitTick(tick => tick + 1) }}
              disabled={gitBusy || path === undefined}
            >
              刷新
            </button>
          </div>
          {gitError !== null ? <div className={css.termError}>{gitError}</div> : null}
          {git === null ? (
            <p className={css.gitStatus}>{gitBusy ? '加载中…' : '无法读取 Git 状态。'}</p>
          ) : (
            <>
              <div className={css.gitSummary}>
                <IconBranchOutline16 className={css.gitBranchIcon} size={14} />
                <span className={css.gitBranch}>{git.branch ?? '(detached HEAD)'}</span>
                {totalChanges > 0 ? <span className={css.gitTotal}>{totalChanges} 个更改</span> : null}
                {(git.ahead > 0 || git.behind > 0)
                  ? <span className={css.gitDelta}>
                    {git.ahead > 0 ? `领先 ${git.ahead}` : ''}
                    {git.ahead > 0 && git.behind > 0 ? ' · ' : ''}
                    {git.behind > 0 ? `落后 ${git.behind}` : ''}
                  </span>
                  : null}
              </div>
              {totalChanges === 0 ? (
                <p className={css.gitStatus}>工作区干净，没有未提交的变更。</p>
              ) : (
                // groups derives from the non-null git above; the totalChanges guard makes it present here.
                <GitGroupsBody groups={groups} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** One VS Code source-control group: a titled list with a change-count badge. */
function GitGroup({ title, changes, kind }: {
  title: string
  changes: GroupedChange[]
  kind: 'staged' | 'unstaged' | 'untracked'
}): ReactNode | null {
  if (changes.length === 0) return null
  return (
    <section className={css.gitGroup} data-kind={kind}>
      <div className={css.gitGroupHead}>
        <span className={css.gitGroupTitle}>{title}</span>
        <span className={css.gitGroupCount}>{changes.length}</span>
      </div>
      <ul className={css.gitList}>
        {changes.map((change, index) => (
          <li className={css.gitRow} key={`${change.path}:${index}`}>
            <GitRowGlyph change={change} />
            <code className={css.gitPath}>{change.path}</code>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The status-letter glyph for one change row. */
function GitRowGlyph({ change }: { change: GroupedChange }): ReactNode {
  /* v8 ignore next -- a change row always carries at least one non-space code, so the third fallback cannot run */
  const glyph = codeGlyph(change.index) ?? codeGlyph(change.worktree) ?? ''
  return <span className={css.gitGlyph} data-kind={glyph}>{glyph}</span>
}

/** The three source-control groups; the empty guard is defensive. */
function GitGroupsBody({ groups }: { groups: ReturnType<typeof groupChanges> | undefined }): ReactNode {
  /* v8 ignore next -- groups derives from the non-null git that guards this render, so the empty arm cannot run */
  if (groups === undefined) return null
  return (
    <div className={css.gitGroups}>
      <GitGroup title="暂存的更改" changes={groups.staged} kind="staged" />
      <GitGroup title="更改" changes={groups.unstaged} kind="unstaged" />
      <GitGroup title="未跟踪" changes={groups.untracked} kind="untracked" />
    </div>
  )
}
