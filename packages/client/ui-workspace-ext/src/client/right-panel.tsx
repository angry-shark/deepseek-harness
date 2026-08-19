/**
 * Right workspace panel: the `shell.right` column occupant. Collapsed it is a
 * compact full-height rail on the right edge; the layout column expands it to
 * the width the concession chain grants (open panels squeeze the center
 * column, mirroring the sidebar). Two tabs, modeled on the VS Code panel:
 * the terminal runs the user's shell in the current session's workspace
 * directory through a real PTY rendered by xterm.js (the same terminal
 * engine VS Code uses — clear-screen, cursor motion, colors and scrollback
 * behave like the real thing), and the Git tab shows the working-tree status
 * parsed from `git status --porcelain` as VS Code source-control groups
 * (staged / unstaged / untracked). The terminal surface uses a dark
 * editor-style background; the Git groups carry change-count badges.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  grammarLoadCount,
  highlightLines,
  subscribeGrammarLoaded,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull the slot-declaration and standard-props merges into the type graph.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { api, type GitActionResult, type GitDiffResult, type GitStatusInfo } from './api.ts'
import { IconBranchOutline16, IconChevronDownOutline14 } from './icons.tsx'
import css from './styles.module.css'
import { XTERM_CSS } from './xterm-styles.ts'
import { workspacePathOf } from './workspace-path.ts'

// xterm's stylesheet is a plain css file the browser bundle cannot load
// through the build's css pipeline, so it ships as a string and is installed
// once in the same add-if-missing style the build uses for css modules. The
// already-present arm only trips when the module evaluates twice (HMR or a
// second bundle load) and the first pass already appended the tag.
/* v8 ignore next -- module double-evaluation: the tag is added on first pass */
if (typeof document !== 'undefined' && document.querySelector('style[data-wse-xterm]') === null) {
  const tag = document.createElement('style')
  tag.dataset.wseXterm = ''
  tag.textContent = XTERM_CSS
  document.head.appendChild(tag)
}

/** Registration-side injected face: the layout toggle for the right column. */
export interface RightPanelInjected {
  /** Toggle the right column between the edge rail and the expanded panel. */
  toggleRight: () => void
}

/** Composed props of the `shell.right` entry. */
export type RightPanelProps =
  PropsRuntime<'shell.right'>
  & InjectFace<RightPanelInjected>

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

/**
 * Render the right rail when collapsed or the tabbed panel when expanded.
 * The panel body stays mounted while collapsed so the terminal keeps
 * streaming into xterm (a hidden surface re-fits when shown), like a VS Code
 * terminal that keeps running while the panel is hidden.
 * @param props - slot props: layout owner state (collapsed/width), global
 * hooks, and the injected toggleRight callback.
 */
export function RightPanel(props: RightPanelProps): ReactNode {
  const { collapsed, toggleRight } = props
  const sessionId = props.useSessions(state => state.current)
  const path = workspacePathOf(props.useWorkspaces, sessionId)
  const [tab, setTab] = useState<'terminal' | 'git'>('terminal')
  // One entry per open terminal pane (VS Code-style multi-terminal): every
  // session is a tab. Only the panes that share the active pane's split group
  // render, so a 分屏 pair stays stacked even after switching to another tab.
  const [panes, setPanes] = useState<TermPane[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [git, setGit] = useState<GitStatusInfo | null>(null)
  const [gitBusy, setGitBusy] = useState(false)
  const [gitError, setGitError] = useState<string | null>(null)
  const [gitTick, setGitTick] = useState(0)
  const [commitMsg, setCommitMsg] = useState('')
  const [gitAction, setGitAction] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<{ staged: boolean; unstaged: boolean; untracked: boolean }>({
    staged: false, unstaged: false, untracked: false,
  })
  // The Git tab diff viewer: the file being inspected (with its group's
  // staged flag) and the fetched content.
  const [diffView, setDiffView] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState<GitDiffResult | null>(null)
  const [diffBusy, setDiffBusy] = useState(false)
  // The xterm instances live in refs keyed by their node session id; panes
  // register on mount so the toolbar can act on the active one.
  const termRefs = useRef(new Map<string, Terminal>())
  const fitAddonRefs = useRef(new Map<string, FitAddon>())
  const paneSeqRef = useRef(0)
  const groupSeqRef = useRef(0)
  const spawningRef = useRef(false)
  // Set when the user kills the last session: the auto-connect effect must not
  // silently respawn a terminal the user just stopped (VS Code leaves the
  // panel dead until a fresh start).
  const stoppedRef = useRef(false)

  // The spawn routine lives in a ref so the auto-connect effect below can
  // call it without re-arming on every render.
  /* v8 ignore next -- the initial ref value is replaced before any render's effects run, so it never executes */
  const spawnSessionRef = useRef<(insertAfterKey: string | null) => void>(() => { /* replaced below */ })
  spawnSessionRef.current = (insertAfterKey: string | null) => {
    // UI-disabled guard arms: the buttons are disabled while busy or without
    // a path, and the auto-connect effect checks the same flags.
    /* v8 ignore next 2 -- both guard arms are unreachable from the UI */
    if (path === undefined || spawningRef.current) return
    spawningRef.current = true
    setBusy(true)
    setError(null)
    stoppedRef.current = false
    void api.termSpawn(path).then((result) => {
      if (!result.ok || result.id === undefined) {
        setError(result.error ?? '启动终端失败')
        return
      }
      paneSeqRef.current += 1
      // 分屏 joins the active pane's split group; 新终端 starts a fresh group.
      const anchor = insertAfterKey === null ? null : panes.find(p => p.key === insertAfterKey)
      groupSeqRef.current += 1
      const group = anchor?.group ?? `group-${groupSeqRef.current}`
      const pane: TermPane = { key: `pane-${paneSeqRef.current}`, id: result.id, group, label: `终端 ${paneSeqRef.current}`, exited: false }
      setPanes((prev) => {
        // 分屏 inserts the new terminal right after the active pane; 新终端
        // appends at the end — in the stacked layout both split the view.
        if (insertAfterKey === null) return [...prev, pane]
        const at = prev.findIndex(p => p.key === insertAfterKey)
        // The insertion anchor is always a live pane (the split button uses
        // the active key), so the fallback arm is defensive.
        /* v8 ignore next 2 -- the active pane always exists when 分屏 fires */
        if (at === -1) return [...prev, pane]
        const next = [...prev]
        next.splice(at + 1, 0, pane)
        return next
      })
      setActiveKey(pane.key)
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught))
    }).finally(() => {
      spawningRef.current = false
      setBusy(false)
    })
  }

  // Auto-connect: opening the panel with the terminal tab active spawns a
  // first session when none exists and a workspace path is available —
  // unless the user stopped the last one explicitly.
  useEffect(() => {
    if (collapsed || tab !== 'terminal' || path === undefined || panes.length > 0 || spawningRef.current || stoppedRef.current) return
    spawnSessionRef.current(null)
  }, [collapsed, tab, path, panes.length])

  // Stable pane callbacks: the TerminalPane effects key on them, so they must
  // not change identity between renders. Focusing a pane just selects it as
  // active; its split group stays visible.
  const focusPane = useCallback((key: string) => { setActiveKey(key) }, [])
  const exitPane = useCallback((key: string) => {
    // The exited pane is always still mounted when its stream reports exit.
    /* v8 ignore next 2 -- exit events arrive only for live panes */
    setPanes(prev => prev.map(p => p.key === key ? { ...p, exited: true } : p))
  }, [])
  const renamePane = useCallback((key: string, label: string) => {
    setPanes(prev => prev.map(p => p.key === key ? { ...p, label } : p))
  }, [])
  const termReady = useCallback((id: string, term: Terminal, fit: FitAddon) => {
    termRefs.current.set(id, term)
    fitAddonRefs.current.set(id, fit)
  }, [])
  const termDisposed = useCallback((id: string) => {
    termRefs.current.delete(id)
    fitAddonRefs.current.delete(id)
  }, [])

  // Fetch the diff for the file the user opened in the Git tab (a Codex/VS
  // Code-style "view the modification" affordance).
  useEffect(() => {
    if (diffView === null || path === undefined) return
    let current = true
    setDiffBusy(true)
    setDiff(null)
    void api.gitDiff(path, diffView.path, diffView.staged).then((result) => {
      if (current) setDiff(result)
    }).catch((caught: unknown) => {
      if (current) setDiff({ ok: false, error: caught instanceof Error ? caught.message : String(caught) })
    }).finally(() => {
      if (current) setDiffBusy(false)
    })
    return () => { current = false }
  }, [diffView, path])

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

  // The active pane drives the toolbar (清屏/终止/启动).
  const activePane = panes.find(p => p.key === activeKey) ?? null
  const running = panes.some(p => !p.exited)
  // The panes shown together: all members of the active pane's split group,
  // so a 分屏 pair stays stacked; everything else is a hidden, still-mounted
  // tab (specified by group).
  const activeGroup = activePane?.group

  const closePane = (pane: TermPane): void => {
    // Closing the last pane stops auto-respawn: the panel stays dead until
    // 启动 / 新终端 / 分屏 starts something, like a closed VS Code group.
    stoppedRef.current = panes.length === 1
    void api.termKill(pane.id).then(() => {
      setPanes(prev => prev.filter(p => p.key !== pane.key))
      if (activeKey === pane.key) {
        // Prefer a surviving sibling of the closed pane's split group, else
        // any remaining pane.
        const sibling = panes.find(p => p.key !== pane.key && p.group === pane.group)
        const next = sibling ?? panes.find(p => p.key !== pane.key)
        setActiveKey(next?.key ?? null)
      }
    }).catch(() => { /* ignore */ })
  }

  const clearActive = (): void => {
    // The toolbar buttons disable without an active pane, so the null arm
    // cannot fire from the UI.
    /* v8 ignore next 2 -- buttons are disabled with no active pane */
    if (activePane !== null) termRefs.current.get(activePane.id)?.clear()
  }

  const killActive = (): void => {
    /* v8 ignore next 2 -- buttons are disabled with no active pane */
    if (activePane !== null) closePane(activePane)
  }

  const startActive = (): void => {
    // 启动 restarts the active session in place; with no pane it creates one.
    if (activePane !== null) {
      // The button disables while busy or without a path.
      /* v8 ignore next 2 -- both guard arms are unreachable from the UI */
      if (path === undefined || spawningRef.current) return
      spawningRef.current = true
      setBusy(true)
      setError(null)
      void api.termSpawn(path, activePane.id).then((result) => {
        if (!result.ok) {
          setError(result.error ?? '启动终端失败')
          return
        }
        // The node respawned in place; clear the pane's xterm for a fresh screen.
        termRefs.current.get(activePane.id)?.reset()
        setPanes(prev => prev.map(p => p.key === activePane.key ? { ...p, exited: false } : p))
      }).catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught))
      }).finally(() => {
        spawningRef.current = false
        setBusy(false)
      })
    } else {
      spawnSessionRef.current(null)
    }
  }

  // One git mutation: guard against double clicks and concurrent ops, run the
  // node-half route, then refresh the status so the panel reflects the new
  // working-tree state (the same refresh path the 刷新 button drives).
  const runGitAction = (action: 'stage' | 'unstage' | 'discard' | 'commit', opts: {
    files?: string[]
    message?: string
    all?: boolean
    staged?: boolean
  } = {}): void => {
    // The action buttons render only with a workspace path and disable while
    // an op is in flight, so neither guard arm can fire from the UI.
    /* v8 ignore next 2 -- both guard arms are unreachable from the UI */
    if (path === undefined || gitAction !== null) return
    setGitAction(action)
    setGitError(null)
    void api.gitAction(path, action, opts).then((result: GitActionResult) => {
      if (result.ok) {
        if (action === 'commit') setCommitMsg('')
        setGitTick(tick => tick + 1)
      } else {
        setGitError(result.error ?? 'Git 操作失败')
      }
    }).catch((caught: unknown) => {
      setGitError(caught instanceof Error ? caught.message : String(caught))
    }).finally(() => {
      setGitAction(null)
    })
  }

  // The commit button commits staged changes; when nothing is staged it
  // smart-commits everything (the node half stages all first), matching the
  // VS Code commit button's default smart-commit behavior.
  const commit = (): void => {
    const message = commitMsg.trim()
    if (message === '') return
    // The commit box renders only with a loaded status and a path, and the
    // controls disable while an op runs, so these guard arms cannot fire.
    /* v8 ignore next 2 -- no path or in-flight op: both unreachable from the box that gates this handler */
    if (path === undefined || gitAction !== null) return
    // groups derives from the non-null git above, so the optional chain's
    // undefined arm cannot run.
    /* v8 ignore next -- groups is defined whenever git is loaded */
    runGitAction('commit', { message, all: groups?.staged.length === 0 })
  }

  const toggleGroup = (kind: 'staged' | 'unstaged' | 'untracked'): void => {
    setCollapsedGroups(prev => ({ ...prev, [kind]: !prev[kind] }))
  }

  // Open the diff viewer for one changed file (a Codex-style "view the
  // modification" affordance); the pane replaces the list until 返回.
  const openDiff = (filePath: string, staged: boolean): void => {
    setDiffView({ path: filePath, staged })
  }

  const closeDiff = (): void => {
    setDiffView(null)
    setDiff(null)
  }

  const groups = git === null ? undefined : groupChanges(git.changes)
  const totalChanges = git?.changes.length ?? 0
  const hasChanges = totalChanges > 0

  return (
    <div className={css.rightPanel}>
      {/* The collapsed rail mirrors the left sidebar rail: a compact
          full-height strip whose two tabs stack vertically; clicking one
          expands the column already on that tab. The expanded panel body
          stays mounted (inline-hidden) while collapsed so the terminal keeps
          running, like a hidden VS Code panel. Inline display keeps the
          hidden state visible to jsdom/test queries, which never see
          stylesheet rules. */}
      <div
        className={css.rightRail}
        style={collapsed ? undefined : { display: 'none' }}
        aria-label="右侧工作区面板"
      >
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
      <div className={css.panelBody} style={collapsed ? { display: 'none' } : undefined}>
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
        {/* The terminal tab body stays mounted (inline-hidden) while the Git
            tab is active so the xterm surfaces (and their scrollback) survive
            tab switches. */}
        <div className={css.termTabBody} style={tab === 'terminal' ? undefined : { display: 'none' }}>
          <div className={css.termToolbar}>
            <button type="button" className={css.headBtn} onClick={clearActive} disabled={activePane === null}>清屏</button>
            <button type="button" className={css.headBtn} onClick={killActive} disabled={activePane === null}>终止</button>
            <button
              type="button"
              className={css.headBtn}
              onClick={startActive}
              disabled={busy || path === undefined}
            >
              启动
            </button>
            <span className={css.termToolbarSpacer} />
            <button
              type="button"
              className={css.headBtn}
              aria-label="新终端"
              title="新终端"
              onClick={() => { spawnSessionRef.current(null) }}
              disabled={busy || path === undefined}
            >
              +
            </button>
            <button
              type="button"
              className={css.headBtn}
              aria-label="分屏"
              title="分屏"
              onClick={() => { spawnSessionRef.current(activeKey) }}
              disabled={busy || path === undefined}
            >
              ⧉
            </button>
          </div>
          {/* The tab strip, like the VS Code terminal tabs: one tab per open
              session with a close button; the active tab drives the toolbar.
              Data-tab-renders every pane; the one labeled active is the
              focused member. Double-click a tab label to rename it. */}
          <div className={css.termTabs}>
            {panes.map(pane => (
              <TermTab
                key={pane.key}
                pane={pane}
                active={pane.key === activeKey}
                onSelect={() => { setActiveKey(pane.key) }}
                onClose={() => { closePane(pane) }}
                onRename={(label) => { renamePane(pane.key, label) }}
              />
            ))}
          </div>
          {error === null ? null : <div className={css.termError}>{error}</div>}
          {/* The panes stay mounted (inline-hidden) when not shown so their
              xterm scrollback and SSE streams survive tab switches; only the
              active pane's split group renders. */}
          <div className={css.termPanes}>
            {panes.length === 0 ? (
              <div className={css.termStatus}>
                终端未连接。{path === undefined ? '当前会话没有工作区。' : '点击「新终端」或「启动」打开终端。'}
              </div>
            ) : panes.map((pane) => {
              const shown = activeGroup !== undefined && pane.group === activeGroup
              return (
                <TerminalPane
                  key={pane.key}
                  pane={pane}
                  visible={!collapsed && tab === 'terminal' && shown}
                  active={pane.key === activeKey}
                  hidden={!shown}
                  onFocus={focusPane}
                  onExit={exitPane}
                  onTermReady={termReady}
                  onTermDispose={termDisposed}
                />
              )
            })}
          </div>
        </div>
        {tab === 'git' ? (
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
            ) : diffView !== null ? (
              <DiffPane
                path={diffView.path}
                staged={diffView.staged}
                result={diff}
                busy={diffBusy}
                onBack={closeDiff}
              />
            ) : (
              <>
                {/* Commit box, like the VS Code SCM input row: type a message,
                    press Enter or click 提交 to commit (smart-committing all
                    changes when nothing is staged). */}
                <div className={css.gitCommitBox}>
                  <input
                    className={css.gitCommitInput}
                    aria-label="提交消息"
                    placeholder="消息 (Ctrl+Enter 提交)"
                    value={commitMsg}
                    onChange={(event) => { setCommitMsg(event.currentTarget.value) }}
                    onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } }}
                    disabled={gitAction !== null}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className={css.gitCommitBtn}
                    onClick={commit}
                    disabled={gitAction !== null || commitMsg.trim() === '' || !hasChanges}
                  >
                    提交
                  </button>
                </div>
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
                  <GitGroupsBody
                    groups={groups}
                    collapsed={collapsedGroups}
                    busy={gitAction !== null}
                    onToggle={toggleGroup}
                    onAction={runGitAction}
                    onOpen={openDiff}
                  />
                )}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** One open terminal: a stacked pane (the split view) tied to a node session. */
interface TermPane {
  /** Stable React key and tab label source (`终端 N`). */
  key: string
  /** The node session id (`term-N`) all terminal routes address. */
  id: string
  /** Split-group id: panes sharing a group display stacked together whenever
   *  any of them is active, and 分屏 adds a new pane to the active pane's group. */
  group: string
  /** Tab label, e.g. `终端 1`; editable by double-clicking the tab. */
  label: string
  /** Whether the session's shell has exited. */
  exited: boolean
}

/**
 * One terminal tab in the strip: a select button and a close button, plus an
 * inline rename box that opens on double-clicking the label (Enter/blur
 * commit, Escape cancels). The editing state stays local to the tab.
 */
function TermTab({ pane, active, onSelect, onClose, onRename }: {
  pane: TermPane
  active: boolean
  onSelect: () => void
  onClose: () => void
  onRename: (label: string) => void
}): ReactNode {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(pane.label)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const commit = (): void => {
    const label = draft.trim()
    if (label !== '' && label !== pane.label) onRename(label)
    setDraft(pane.label)
    setEditing(false)
  }

  return (
    <span
      className={active ? `${css.termTab} ${css.termTabOn}` : css.termTab}
      data-session={pane.id}
    >
      {editing ? (
        <input
          ref={inputRef}
          className={css.termTabInput}
          aria-label={`重命名${pane.label}`}
          value={draft}
          autoFocus
          onFocus={(event) => { event.currentTarget.select() }}
          onChange={(event) => { setDraft(event.currentTarget.value) }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            else if (event.key === 'Escape') { setDraft(pane.label); setEditing(false) }
          }}
        />
      ) : (
        <button
          type="button"
          className={css.termTabBtn}
          title="双击重命名"
          onClick={onSelect}
          onDoubleClick={() => { setDraft(pane.label); setEditing(true) }}
        >
          {pane.exited ? null : <span className={css.termDot} aria-hidden />}
          {pane.label}
        </button>
      )}
      <button
        type="button"
        className={css.termTabClose}
        aria-label={`关闭${pane.label}`}
        onClick={onClose}
      >
        ×
      </button>
    </span>
  )
}

/**
 * One terminal pane: an xterm instance wired to one node session. Output
 * streams over SSE (near-instant echoes), keystrokes stream back to the PTY
 * (serialized so fast typing never reorders), and the surface fits its pane
 * and forwards live resizes — the VS Code terminal engine per pane.
 */
function TerminalPane({ pane, visible, active, hidden, onFocus, onExit, onTermReady, onTermDispose }: {
  pane: TermPane
  visible: boolean
  active: boolean
  /** Hidden panes stay mounted (xterm scrollback and the SSE stream survive)
   *  but are not shown, like inactive tabs in the VS Code terminal. */
  hidden: boolean
  onFocus: (key: string) => void
  onExit: (key: string) => void
  onTermReady: (id: string, term: Terminal, fit: FitAddon) => void
  onTermDispose: (id: string) => void
}): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const exitedRef = useRef(pane.exited)
  // Keystroke writes are serialized: parallel fetch POSTs can race onto
  // different connections and reach the PTY out of order, scrambling typed
  // commands. Each write waits for the previous one to settle.
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    exitedRef.current = pane.exited
  }, [pane.exited])

  // Materialize xterm once the host is mounted; dispose it with the pane.
  useEffect(() => {
    // The host element mounts in the same commit as this effect; a second run
    // only happens under StrictMode double effects after the first created it.
    /* v8 ignore next 2 -- StrictMode double-effect and always-mounted-host guards */
    if (hostRef.current === null || termRef.current !== null) return
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 2000,
      theme: {
        background: '#0f1115',
        foreground: '#d7dae0',
        cursor: '#4d97d4',
        cursorAccent: '#0f1115',
        selectionBackground: '#264f78',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    // The line being typed, so a literal `clear` command empties the viewport
    // client-side too: it works even before the node half spawns the shell
    // with a real TERM (where the dumb-type `clear` is a silent no-op).
    let line = ''
    term.onData((data) => {
      // A dead session (shell exited) ignores further keystrokes.
      if (exitedRef.current) return
      if (data === '\r' || data === '\n') {
        if (line.trim() === 'clear') termRef.current?.clear()
        line = ''
      } else if (data === '\u0003' || data === '\u001b') {
        line = ''
      } else {
        line += data
      }
      writeQueueRef.current = writeQueueRef.current
        .then(async () => { await api.termWrite(pane.id, data) })
        .catch(() => { /* transient write failure */ })
    })
    // Live resize: the PTY wraps at the pane's measured size, like VS Code.
    term.onResize(({ cols, rows }) => {
      void api.termResize(pane.id, cols, rows).catch(() => { /* transient resize failure */ })
    })
    termRef.current = term
    fitRef.current = fit
    onTermReady(pane.id, term, fit)
    return () => {
      termRef.current = null
      fitRef.current = null
      onTermDispose(pane.id)
      term.dispose()
    }
  }, [pane.id, onTermReady, onTermDispose])

  // Fit the pane and follow its size; hidden surfaces (collapsed panel, Git
  // tab) are skipped so xterm never resizes to a zero-sized container.
  useEffect(() => {
    if (!visible || hostRef.current === null) return undefined
    const fit = (): void => { fitRef.current?.fit() }
    fit()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(fit)
      observer.observe(hostRef.current)
      window.addEventListener('resize', fit)
      return () => {
        observer.disconnect()
        window.removeEventListener('resize', fit)
      }
    }
    window.addEventListener('resize', fit)
    return () => { window.removeEventListener('resize', fit) }
  }, [pane.id, visible])

  // The PTY output streams over SSE instead of being polled, so echoes and
  // cursor redraws arrive within a few milliseconds — typing feels like a
  // local terminal. EventSource reconnects on a dropped connection and the
  // node half replays anything buffered since the stream went away.
  useEffect(() => {
    // An exited session stops streaming; a respawn reopens the stream.
    if (pane.exited) return undefined
    const source = new EventSource(`/api/workspace-ext/term/stream?session=${encodeURIComponent(pane.id)}`)
    source.onmessage = (event) => {
      let payload: { out: string; exited: boolean }
      try {
        payload = JSON.parse(String(event.data)) as { out: string; exited: boolean }
      } catch {
        // A malformed frame is dropped; the next event resumes the stream.
        return
      }
      // xterm interprets the raw PTY stream itself (clear-screen sequences,
      // cursor motion, SGR colors), so no client-side ANSI parsing is left.
      if (payload.out !== '') termRef.current?.write(payload.out)
      if (payload.exited) onExit(pane.key)
    }
    return () => { source.close() }
  }, [pane.id, pane.key, pane.exited, onExit])

  // Selecting the tab focuses its terminal, like the VS Code active group.
  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  return (
    <div
      className={css.termPane}
      data-term-pane
      data-session={pane.id}
      data-term-hidden={hidden ? 'true' : undefined}
      style={hidden ? { display: 'none' } : undefined}
    >
      {pane.exited ? <div className={css.termStatus}>终端已退出。</div> : null}
      {/* One seamless dark surface, like the VS Code terminal: xterm renders
          the shell's PTY stream and owns the command line; clicking anywhere
          in the viewport activates and focuses the pane. */}
      <div
        className={css.termHost}
        ref={hostRef}
        data-term-host
        onClick={() => { onFocus(pane.key); termRef.current?.focus() }}
      />
    </div>
  )
}

/** One VS Code source-control group: a titled list with a change-count badge
 *  and per-file actions (stage/unstage/discard) plus group-level actions;
 *  clicking a file path opens its modification diff. */
function GitGroup({ title, changes, kind, collapsed, busy, onToggle, onAction, onOpen }: {
  title: string
  changes: GroupedChange[]
  kind: 'staged' | 'unstaged' | 'untracked'
  collapsed: boolean
  busy: boolean
  onToggle: () => void
  onAction: (action: 'stage' | 'unstage' | 'discard', opts?: { files?: string[]; staged?: boolean }) => void
  onOpen: (path: string, staged: boolean) => void
}): ReactNode | null {
  if (changes.length === 0) return null
  const isStaged = kind === 'staged'
  return (
    <section className={css.gitGroup} data-kind={kind}>
      <div className={css.gitGroupHead}>
        <button
          type="button"
          className={css.gitChevron}
          onClick={onToggle}
          aria-label={`${collapsed ? '展开' : '收起'}${title}`}
        >
          <IconChevronDownOutline14 size={14} className={collapsed ? css.gitChevronClosed : undefined} />
        </button>
        <span className={css.gitGroupTitle}>{title}</span>
        <span className={css.gitGroupCount}>{changes.length}</span>
        <span className={css.gitHeadActions}>
          {kind === 'staged' ? (
            <button type="button" className={css.gitActionBtn} disabled={busy} onClick={() => { onAction('unstage') }}>
              全部取消暂存
            </button>
          ) : (
            <button type="button" className={css.gitActionBtn} disabled={busy} onClick={() => { onAction('stage') }}>
              全部暂存
            </button>
          )}
          <button type="button" className={css.gitActionBtn} disabled={busy} onClick={() => { onAction('discard', isStaged ? { staged: true } : {}) }}>
            放弃全部更改
          </button>
        </span>
      </div>
      {!collapsed ? (
        <ul className={css.gitList}>
          {changes.map((change, index) => (
            <li className={css.gitRow} key={`${change.path}:${index}`}>
              <GitRowGlyph change={change} />
              <button
                type="button"
                className={css.gitPathBtn}
                title="查看修改"
                aria-label={`查看 ${change.path} 的修改`}
                onClick={() => { onOpen(change.path, isStaged) }}
              >
                <code className={css.gitPath}>{change.path}</code>
              </button>
              <span className={css.gitRowActions}>
                {kind === 'staged' ? (
                  <button type="button" className={css.gitActionBtn} disabled={busy} onClick={() => { onAction('unstage', { files: [change.path] }) }}>
                    取消暂存
                  </button>
                ) : (
                  <button type="button" className={css.gitActionBtn} disabled={busy} onClick={() => { onAction('stage', { files: [change.path] }) }}>
                    暂存
                  </button>
                )}
                <button
                  type="button"
                  className={css.gitActionBtn}
                  disabled={busy}
                  onClick={() => { onAction('discard', isStaged ? { files: [change.path], staged: true } : { files: [change.path] }) }}
                >
                  放弃
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
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
function GitGroupsBody({ groups, collapsed, busy, onToggle, onAction, onOpen }: {
  groups: ReturnType<typeof groupChanges> | undefined
  collapsed: { staged: boolean; unstaged: boolean; untracked: boolean }
  busy: boolean
  onToggle: (kind: 'staged' | 'unstaged' | 'untracked') => void
  onAction: (action: 'stage' | 'unstage' | 'discard', opts?: { files?: string[]; staged?: boolean }) => void
  onOpen: (path: string, staged: boolean) => void
}): ReactNode {
  /* v8 ignore next -- groups derives from the non-null git that guards this render, so the empty arm cannot run */
  if (groups === undefined) return null
  return (
    <div className={css.gitGroups}>
      <GitGroup title="暂存的更改" changes={groups.staged} kind="staged"
        collapsed={collapsed.staged} busy={busy} onToggle={() => { onToggle('staged') }} onAction={onAction} onOpen={onOpen} />
      <GitGroup title="更改" changes={groups.unstaged} kind="unstaged"
        collapsed={collapsed.unstaged} busy={busy} onToggle={() => { onToggle('unstaged') }} onAction={onAction} onOpen={onOpen} />
      <GitGroup title="未跟踪" changes={groups.untracked} kind="untracked"
        collapsed={collapsed.untracked} busy={busy} onToggle={() => { onToggle('untracked') }} onAction={onAction} onOpen={onOpen} />
    </div>
  )
}

/** One colorized diff line: the sign column plus the rest of the line. */
export interface DiffLine {
  text: string
  kind: 'add' | 'del' | 'hunk' | 'meta' | 'context'
}

/**
 * Split unified diff output into colorized lines. The `+++`/`---` headers
 * classify as metadata, `@@` hunks as hunk markers, `+`/`-` body lines as
 * additions/deletions, and everything else as context.
 */
export function diffLines(diff: string): DiffLine[] {
  return diff.split('\n').map((line): DiffLine => {
    if (line.startsWith('@@')) return { text: line, kind: 'hunk' }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')
      || line.startsWith('index ') || line.startsWith('new file mode') || line.startsWith('deleted file mode')) {
      return { text: line, kind: 'meta' }
    }
    if (line.startsWith('+')) return { text: line, kind: 'add' }
    if (line.startsWith('-')) return { text: line, kind: 'del' }
    return { text: line, kind: 'context' }
  })
}

/** The Git tab's modification viewer for one changed file (a Codex-style
 *  read: unified diff for tracked files, the raw text for untracked ones). */
function DiffPane({ path: filePath, staged, result, busy, onBack }: {
  path: string
  staged: boolean
  result: GitDiffResult | null
  busy: boolean
  onBack: () => void
}): ReactNode {
  const lang = langOfPath(filePath)
  return (
    <div className={css.diffView}>
      <div className={css.diffHead}>
        <button type="button" className={css.headBtn} onClick={onBack}>返回</button>
        <code className={css.diffPath}>{filePath}</code>
        {staged ? <span className={css.diffBadge}>已暂存</span> : null}
        {result?.untracked === true ? <span className={css.diffBadge}>未跟踪</span> : null}
      </div>
      {busy ? (
        <p className={css.gitStatus}>加载中…</p>
      ) : (
        // The fetch effect clears `diff` and sets `diffBusy` in the same
        // commit, so a settled pane always carries a non-null result.
        /* v8 ignore next 2 -- null result is impossible once the fetch settles */
        result === null ? (
          <p className={css.gitStatus}>无法读取修改内容。</p>
        ) : !result.ok ? (
          <p className={css.gitStatus}>{result.error ?? '读取修改内容失败。'}</p>
        ) : (
          <div className={css.diffBody}>
            {result.diff !== undefined
              ? diffLines(result.diff).map((line, index) => (
                <div key={index} className={`${css.diffLine} ${DIFF_KIND_CLASS[line.kind]}`} data-diff-kind={line.kind}>
                  {line.kind === 'add' || line.kind === 'del'
                    // The `+`/`-` sign stays a stable marker; the code after
                    // it renders through shiki token colors (plain text when
                    // the language is unknown or its grammar is still loading).
                    ? (
                      <>
                        <span className={css.diffSign}>{line.text[0]}</span>
                        <DiffLineRuns code={line.text.slice(1)} lang={lang} fallback={line.text.slice(1)} />
                      </>
                    )
                    : line.text}
                </div>
              ))
              : (result.content ?? '').split('\n').map((line, index) => (
                <div key={index} className={`${css.diffLine} ${css.diffAdd}`} data-diff-kind="add">
                  <DiffLineRuns code={line} lang={lang} fallback={line} />
                </div>
              ))}
          </div>
        )
      )}
    </div>
  )
}

/** Color class for each diff-line kind. */
const DIFF_KIND_CLASS = {
  add: css.diffAdd,
  del: css.diffDel,
  hunk: css.diffHunk,
  meta: css.diffMeta,
  context: css.diffContext,
} as const

/**
 * Common file-extension → language-id hints the shared highlighter accepts,
 * mirroring the read tool's `langFromPath` surface for the diff viewer. A path
 * whose extension is absent here falls back to plain monospace text, never an
 * error.
 */
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'typescript', jsx: 'typescript', mjs: 'typescript', cjs: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', kt: 'kotlin', swift: 'swift', php: 'php',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', json: 'json', jsonc: 'json',
  md: 'markdown', mdx: 'mdx', html: 'html', css: 'css', scss: 'scss', less: 'less', sql: 'sql',
}

/** The language-hint id for one file path, or `undefined` for an unknown extension. */
function langOfPath(filePath: string): string | undefined {
  const slash = filePath.lastIndexOf('/')
  const dot = filePath.lastIndexOf('.')
  if (dot === -1 || dot < slash) return undefined
  return EXT_LANG[filePath.slice(dot + 1).toLowerCase()]
}

/**
 * Render the code of one diff line (the text after its `+`/`-` sign) as
 * highlighted runs. Re-render via the hook when a lazy grammar loads; an
 * unknown or not-yet-loaded language renders plain text via `fallback`.
 */
function DiffLineRuns({ code, lang, fallback }: {
  code: string
  lang: string | undefined
  fallback: string
}): ReactNode {
  // Match ReadBlock's lazy-grammar re-render: the load-counter snapshot is
  // opaque; its change re-memoizes so a line that showed plain text gains
  // tokens once its language's grammar registers.
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)
  const lines = useMemo(() => {
    const highlighted = lang === undefined ? undefined : highlightLines(code, lang)
    return highlighted?.[0]
  }, [code, lang, loaded])
  if (lines === undefined) return <>{fallback}</>
  return lines.map((span, index) => <span key={index} style={span.style}>{span.text}</span>)
}
