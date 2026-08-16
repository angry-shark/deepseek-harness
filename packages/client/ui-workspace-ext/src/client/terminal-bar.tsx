/**
 * Right terminal sidebar: a full-height rail on the right edge that expands
 * into a 360px terminal panel running bash in the current session's workspace
 * directory. Output is polled incrementally while the panel is open; the
 * node half buffers and serves the raw bytes, and this component strips ANSI
 * escape sequences before rendering.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pull the slot-declaration and standard-props merges into the type graph.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { api } from './api.ts'
import css from './styles.module.css'
import { workspacePathOf } from './workspace-path.ts'

/** Composed props of the `shell.overlay` entry. */
export type TerminalBarProps = PropsRuntime<'shell.overlay'>

/** Client-side output cap: the oldest lines are dropped past this length. */
const OUTPUT_CAP = 8000

/** Poll interval while the terminal runs. */
const POLL_MS = 500

/** Strip ANSI/OSC escape sequences so terminal output renders as plain text. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_][0-9]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/**
 * Render the terminal rail when collapsed or the terminal panel when expanded.
 * @param props - slot props with the global session/workspace hooks.
 */
export function TerminalBar(props: TerminalBarProps): ReactNode {
  const sessionId = props.useSessions(state => state.current)
  const path = workspacePathOf(props.useWorkspaces, sessionId)
  const [expanded, setExpanded] = useState(false)
  const [spawned, setSpawned] = useState(false)
  const [exited, setExited] = useState(true)
  const [out, setOut] = useState('')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const spawningRef = useRef(false)

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

  if (!expanded) {
    return (
      <div
        className={css.termRail}
        title="展开终端侧栏"
        onClick={() => { setExpanded(true) }}
      >
        终端
      </div>
    )
  }

  const running = spawned && !exited

  const spawn = (): void => {
    /* v8 ignore next -- both guard arms are unreachable from the UI: the 启动 button is disabled while busy or without a workspace path */
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
    <div className={css.termPanel}>
      <div className={css.termHead}>
        <span className={css.termTitle}>终端</span>
        <span className={css.termCwd} title={path}>{path?.split('/').filter(Boolean).pop() ?? ''}</span>
        <button type="button" className={css.termBtn} onClick={spawn} disabled={busy || running || path === undefined}>启动</button>
        <button type="button" className={css.termBtn} onClick={kill} disabled={!spawned}>终止</button>
        <button type="button" className={css.termBtn} onClick={() => { setOut('') }}>清屏</button>
        <button type="button" className={css.termBtn} onClick={() => { setExpanded(false) }}>收起</button>
      </div>
      {error === null ? null : <div className={css.termError}>{error}</div>}
      <div className={css.termOut} ref={boxRef}>
        <pre>
          {out !== '' ? out
            : !spawned ? `终端未启动。点击「启动」在 ${path ?? '当前工作区'} 打开 bash。`
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
    </div>
  )
}
