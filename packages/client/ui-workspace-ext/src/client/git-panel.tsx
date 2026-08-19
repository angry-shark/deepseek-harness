/**
 * Git workspace panel: the `shell.right` column occupant. Reads `git status`
 * through the node half's /api/workspace-ext routes and renders the VS Code
 * source-control surface — commit box, branch/change summary, the three change
 * groups with per-file actions, and a syntax-highlighted diff viewer. Extracted
 * from the former right-panel when the terminal moved to the bottom track.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  grammarLoadCount,
  highlightLines,
  subscribeGrammarLoaded,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull the slot-declaration and standard-props merges into the type graph.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { workspacePathOf } from './workspace-path.ts'
import { api, type GitActionResult, type GitDiffResult, type GitStatusInfo } from './api.ts'
import { IconBranchOutline16, IconChevronDownOutline14 } from './icons.tsx'
import css from './styles.module.css'

/** Composed props of the `shell.right` content (forwarded by the tab shell). */
export type GitPanelProps =
  PropsRuntime<'shell.right'>

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
 * The Git source-control panel body. The column is hidden by the frame at
 * zero width; there is no edge rail (the titlebar's 右侧 toggle reopens it).
 * @param props - slot props: layout owner state (collapsed/width), global
 * hooks.
 */
export function GitPanel(props: GitPanelProps): ReactNode {
  const { collapsed } = props
  const sessionId = props.useSessions(state => state.current)
  const path = workspacePathOf(props.useWorkspaces, sessionId)
  const [git, setGit] = useState<GitStatusInfo | null>(null)
  const [gitBusy, setGitBusy] = useState(false)
  const [gitError, setGitError] = useState<string | null>(null)
  const [gitTick, setGitTick] = useState(0)
  const [commitMsg, setCommitMsg] = useState('')
  const [gitAction, setGitAction] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<{ staged: boolean; unstaged: boolean; untracked: boolean }>({
    staged: false, unstaged: false, untracked: false,
  })
  const [diffView, setDiffView] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState<GitDiffResult | null>(null)
  const [diffBusy, setDiffBusy] = useState(false)

  // Fetch the diff for the file the user opened (a Codex-style viewer).
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

  // Fetch the working-tree status whenever the panel is visible.
  useEffect(() => {
    if (collapsed || path === undefined) return
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
  }, [collapsed, path, gitTick])

  // One git mutation: guard double clicks and concurrent ops, then refresh.
  const runGitAction = (action: 'stage' | 'unstage' | 'discard' | 'commit', opts: {
    files?: string[]
    message?: string
    all?: boolean
    staged?: boolean
  } = {}): void => {
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

  // The commit button smart-commits all when nothing is staged.
  const commit = (): void => {
    const message = commitMsg.trim()
    if (message === '') return
    /* v8 ignore next 2 -- no path or in-flight op: both unreachable from the box that gates this handler */
    if (path === undefined || gitAction !== null) return
    /* v8 ignore next -- groups is defined whenever git is loaded */
    runGitAction('commit', { message, all: groups?.staged.length === 0 })
  }

  const toggleGroup = (kind: 'staged' | 'unstaged' | 'untracked'): void => {
    setCollapsedGroups(prev => ({ ...prev, [kind]: !prev[kind] }))
  }

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

  // Re-render when a lazy grammar loads so a diff that showed plain text gains
  // syntax highlighting (the same pattern ReadBlock uses).
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)
  void loaded

  return (
    <div className={css.gitPanelBody}>
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
  )
}

/** One VS Code source-control group: a titled list with a change-count badge. */
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

/** Split unified diff output into colorized lines. */
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

/** The Git tab's modification viewer for one changed file. */
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

/** File-extension → language-id hints the shared highlighter accepts. */
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

/** Render one diff line's code as highlighted runs (plain text when unknown). */
function DiffLineRuns({ code, lang, fallback }: {
  code: string
  lang: string | undefined
  fallback: string
}): ReactNode {
  const loaded = useSyncExternalStore(subscribeGrammarLoaded, grammarLoadCount, grammarLoadCount)
  const lines = useMemo(() => {
    const highlighted = lang === undefined ? undefined : highlightLines(code, lang)
    return highlighted?.[0]
  }, [code, lang, loaded])
  if (lines === undefined) return <>{fallback}</>
  return lines.map((span, index) => <span key={index} style={span.style}>{span.text}</span>)
}
