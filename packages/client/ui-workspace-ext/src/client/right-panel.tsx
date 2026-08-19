/**
 * Bottom terminal panel: the `shell.bottom` track occupant (Git moved back to
 * the `shell.right` column in git-panel.tsx). Models the VS Code terminal:
 * the terminal panes fill the left/main area and split side-by-side
 * (horizontally), while a vertical tab column on the right lists every
 * terminal — a split appears as one tab with its sub-tabs beneath it. Only the
 * active pane's split group renders in the pane area; hidden panes stay
 * mounted so their xterm scrollback and SSE streams survive tab switches.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull the slot-declaration and standard-props merges into the type graph.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { api } from './api.ts'
import { workspacePathOf } from './workspace-path.ts'
import css from './styles.module.css'
import { XTERM_CSS } from './xterm-styles.ts'

// xterm's stylesheet ships as a string (the browser bundle cannot load it
// through the css pipeline); install it once, add-if-missing.
/* v8 ignore next -- module double-evaluation: the tag is added on first pass */
if (typeof document !== 'undefined' && document.querySelector('style[data-wse-xterm]') === null) {
  const tag = document.createElement('style')
  tag.dataset.wseXterm = ''
  tag.textContent = XTERM_CSS
  document.head.appendChild(tag)
}

/** Registration-side injected face: the bottom-panel toggle. */
export interface RightPanelInjected {
  /** Toggle the bottom workspace panel (closed ⟷ contract default height). */
  toggleBottom: () => void
}

/** Composed props of the `shell.bottom` entry. */
export type RightPanelProps =
  PropsRuntime<'shell.bottom'>
  & InjectFace<RightPanelInjected>

/** One open terminal pane tied to a node session id. */
interface TermPane {
  key: string
  id: string
  /** Split-group id: a split adds a pane to the active pane's group, so the
   *  group's panes render side-by-side and appear as one tab with sub-tabs. */
  group: string
  label: string
  exited: boolean
}

/**
 * The bottom terminal panel body.
 * @param props - slot props: layout owner state (collapsed/height), global
 * hooks, and the injected toggleBottom callback.
 */
export function RightPanel(props: RightPanelProps): ReactNode {
  const { collapsed, toggleBottom } = props
  const sessionId = props.useSessions(state => state.current)
  const path = workspacePathOf(props.useWorkspaces, sessionId)
  const [panes, setPanes] = useState<TermPane[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const termRefs = useRef(new Map<string, Terminal>())
  const fitAddonRefs = useRef(new Map<string, FitAddon>())
  const paneSeqRef = useRef(0)
  const groupSeqRef = useRef(0)
  const spawningRef = useRef(false)
  const stoppedRef = useRef(false)

  /* v8 ignore next -- the initial ref value is replaced before any render's effects run, so it never executes */
  const spawnSessionRef = useRef<(insertAfterKey: string | null) => void>(() => { /* replaced below */ })
  spawnSessionRef.current = (insertAfterKey: string | null) => {
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
        if (insertAfterKey === null) return [...prev, pane]
        const at = prev.findIndex(p => p.key === insertAfterKey)
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

  // Auto-connect a first session when the panel opens with a workspace path.
  useEffect(() => {
    if (collapsed || path === undefined || panes.length > 0 || spawningRef.current || stoppedRef.current) return
    spawnSessionRef.current(null)
  }, [collapsed, path, panes.length])

  const focusPane = useCallback((key: string) => { setActiveKey(key) }, [])
  const exitPane = useCallback((key: string) => {
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

  const activePane = panes.find(p => p.key === activeKey) ?? null
  const activeGroup = activePane?.group
  // Group the panes by split group, preserving first-appearance order; each
  // group is one tab in the vertical column (a split group has sub-tabs).
  const groups = groupPanes(panes)

  const closePane = (pane: TermPane): void => {
    stoppedRef.current = panes.length === 1
    void api.termKill(pane.id).then(() => {
      setPanes(prev => prev.filter(p => p.key !== pane.key))
      if (activeKey === pane.key) {
        const sibling = panes.find(p => p.key !== pane.key && p.group === pane.group)
        const next = sibling ?? panes.find(p => p.key !== pane.key)
        setActiveKey(next?.key ?? null)
      }
    }).catch(() => { /* ignore */ })
  }
  const clearActive = (): void => {
    /* v8 ignore next 2 -- buttons are disabled with no active pane */
    if (activePane !== null) termRefs.current.get(activePane.id)?.clear()
  }
  const killActive = (): void => {
    /* v8 ignore next 2 -- buttons are disabled with no active pane */
    if (activePane !== null) closePane(activePane)
  }
  const startActive = (): void => {
    if (activePane !== null) {
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

  return (
    <div className={css.termPanelBody}>
      {/* The main terminal area: toolbar over the side-by-side panes. */}
      <div className={css.termMain}>
        <div className={css.termToolbar}>
          <button type="button" className={css.headBtn} onClick={clearActive} disabled={activePane === null}>清屏</button>
          <button type="button" className={css.headBtn} onClick={killActive} disabled={activePane === null}>终止</button>
          <button type="button" className={css.headBtn} onClick={startActive} disabled={busy || path === undefined}>启动</button>
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
          <button
            type="button"
            className={css.collapseBtn}
            aria-label="收起底部面板"
            title="收起底部面板"
            onClick={() => { toggleBottom() }}
          >
            <span className={css.panelDownIcon} aria-hidden />
          </button>
        </div>
        {error === null ? null : <div className={css.termError}>{error}</div>}
        {/* The split panes sit side-by-side (horizontal): the active group's
            panes render as a row, so a split is left-right like VS Code. */}
        <div className={css.termPanesRow}>
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
                visible={!collapsed && shown}
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
      {/* The vertical tab column on the right: one tab per split group, with
          the group's split panes as sub-tabs; double-click to rename. */}
      <div className={css.termTabsCol}>
        {groups.map((group) => {
          // A group is never empty (groupPanes only emits non-empty lists), so
          // the optional-chain fallback string is defensive.
          const groupId = group[0]?.group ?? ''
          const isSplit = group.length > 1
          const activeInGroup = group.some(p => p.key === activeKey)
          return (
            <div key={groupId} className={css.termTabGroup} data-active={activeInGroup || undefined}>
              {group.map((pane, index) => (
                <TermTab
                  key={pane.key}
                  pane={pane}
                  nested={isSplit && index > 0}
                  group={groupId}
                  active={pane.key === activeKey}
                  onSelect={() => { setActiveKey(pane.key) }}
                  onClose={() => { closePane(pane) }}
                  onRename={(label) => { renamePane(pane.key, label) }}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Group `panes` by split group, preserving first-appearance order; a split
 *  group (multiple panes) becomes one tab with sub-tabs in the vertical column. */
function groupPanes(panes: TermPane[]): TermPane[][] {
  const byGroup = new Map<string, TermPane[]>()
  for (const pane of panes) {
    const list = byGroup.get(pane.group)
    if (list === undefined) byGroup.set(pane.group, [pane])
    else list.push(pane)
  }
  return [...byGroup.values()]
}

/** One terminal tab in the vertical column: a select/rename/close row. */
function TermTab({ pane, nested, group, active, onSelect, onClose, onRename }: {
  pane: TermPane
  nested: boolean
  group: string
  active: boolean
  onSelect: () => void
  onClose: () => void
  onRename: (label: string) => void
}): ReactNode {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(pane.label)

  const commit = (): void => {
    const label = draft.trim()
    if (label !== '' && label !== pane.label) onRename(label)
    setDraft(pane.label)
    setEditing(false)
  }

  return (
    <div
      className={`${css.termTabRow} ${active ? css.termTabRowOn : ''} ${nested ? css.termTabRowNested : ''}`}
      data-session={pane.id}
      data-tab-group={group}
      data-nested={nested || undefined}
    >
      {editing ? (
        <input
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
    </div>
  )
}

/** One terminal pane: an xterm instance wired to one node session. Output
 *  streams over SSE; keystrokes stream back to the PTY (serialized). Hidden
 *  panes stay mounted (scrollback + stream survive). */
function TerminalPane({ pane, visible, active, hidden, onFocus, onExit, onTermReady, onTermDispose }: {
  pane: TermPane
  visible: boolean
  active: boolean
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
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    exitedRef.current = pane.exited
  }, [pane.exited])

  useEffect(() => {
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
    let line = ''
    term.onData((data) => {
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

  useEffect(() => {
    if (pane.exited) return undefined
    const source = new EventSource(`/api/workspace-ext/term/stream?session=${encodeURIComponent(pane.id)}`)
    source.onmessage = (event) => {
      let payload: { out: string; exited: boolean }
      try {
        payload = JSON.parse(String(event.data)) as { out: string; exited: boolean }
      } catch {
        return
      }
      if (payload.out !== '') termRef.current?.write(payload.out)
      if (payload.exited) onExit(pane.key)
    }
    return () => { source.close() }
  }, [pane.id, pane.key, pane.exited, onExit])

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
      <div
        className={css.termHost}
        ref={hostRef}
        data-term-host
        onClick={() => { onFocus(pane.key); termRef.current?.focus() }}
      />
    </div>
  )
}
