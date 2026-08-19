/**
 * Three-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * details), the drag handles (pointer capture + rAF throttle), the concession
 * chain (columns.ts), and the child-slot render decisions: the sidebar slot
 * renders HERE with live parameters from the concession solve, and the
 * session-aware occupants render in fixed column positions; strict entries
 * gate themselves on current-session availability while session-maybe
 * entries retain identity. Pure component: everything arrives
 * through the three framework shares — zero cordis or framework imports,
 * zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { computeColumns, RIGHT_COLLAPSED, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT } from './columns.ts'
import type { createLayoutStore } from './stores.ts'
import { TitleBar } from './TitleBar.tsx'
import css from './AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'shell.right' | 'shell.bottom' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function DetailsColumn(props: { children?: ReactNode }) {
  return <div className={css.detailsCol}>{props.children}</div>
}

/** Right workspace column grid item; width 0 keeps the subtree mounted. */
function RightColumn(props: { children?: ReactNode }) {
  return <div className={css.rightCol}>{props.children}</div>
}

/** The bottom panel row; hidden (inline) while closed so the occupant stays mounted. */
function BottomRow(props: { open: boolean; height: number; children?: ReactNode }) {
  return (
    <div className={css.bottomRow} style={props.open ? { height: props.height } : { display: 'none' }}>
      {props.children}
    </div>
  )
}

/** The column grid that holds the four panels under the titlebar and above the bottom row. */
function MainArea(props: { children?: ReactNode; style: Record<string, string | number> }) {
  return <div className={css.mainArea} data-frame-main style={props.style}>{props.children}</div>
}

/** One drag handle: pointer capture, rAF-throttled reports against the
 *  drag-start origin. A `left` handle drags horizontally (sidebar/details/
 *  right columns); a `bottom` handle drags vertically (the bottom track's
 *  height). `side` keys the hover-reveal CSS to the owning panel. */
function DragHandle(props: {
  side: 'sidebar' | 'details' | 'right' | 'bottom'
  left?: number
  bottom?: number
  onStart: () => void
  onDrag: (delta: number) => void
  onEnd: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const horizontal = props.bottom === undefined
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const delta = (event: React.PointerEvent<HTMLDivElement>): number => horizontal ? event.clientX : event.clientY
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = delta(e)
    latest.current = delta(e)
    callbacks.current.onStart()
    setDragging(true)
  }, [delta])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = delta(e)
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [delta])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [delta])

  return (
    <div
      className={css.handle}
      style={horizontal ? { left: props.left } : { bottom: props.bottom }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The three-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)

  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Narrow viewports auto-collapse the sidebar; the store mirror keeps
  // toggleSidebar's semantics right (narrow toggles flip the manual
  // re-expand override, stores.ts). Collapsed is decided here, so the
  // solver stays breakpoint-free: a narrow re-expand passes the preference
  // (or the default when the wide preference is closed) and the center
  // absorbs the squeeze.
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  const cols = computeColumns(viewport, sidebarPreference, detailsSession === undefined ? 0 : panels.details, panels.right)
  const colsRef = useRef(cols)
  colsRef.current = cols

  // Cmd/Ctrl+J toggles the bottom terminal panel (the VS Code shortcut). It
  // is skipped while the focus is in an editable field so typing isn't
  // hijacked; preventDefault also stops the browser's own Cmd/Ctrl+J (e.g.
  // downloads) in the WebView.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() !== 'j') return
      const target = event.target
      if (target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
        return
      }
      event.preventDefault()
      actions.toggleBottom()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [actions])

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = colsRef.current.details; setDragging(true) }, [])
  const rightBase = useRef(0)
  const onRightStart = useCallback(() => { rightBase.current = colsRef.current.right; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setDetails(detailsBase.current - dx)
  }, [actions])
  // Dragging the right handle left makes the panel narrower; dx is the
  // pointer's movement, so the width follows the left-edge drag of the strip.
  const onRightDrag = useCallback((dx: number) => {
    actions.setRight(rightBase.current - dx)
  }, [actions])
  // The bottom panel's height is dragged from the top edge of its row: a
  // handle strip spans its top, and dragging up (negative dy) grows the panel.
  const bottomBase = useRef(0)
  const onBottomStart = useCallback(() => { bottomBase.current = panels.bottom; setDragging(true) }, [panels.bottom])
  const onBottomDrag = useCallback((dy: number) => {
    actions.setBottom(bottomBase.current - dy)
  }, [actions])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={cols.details === 0 || undefined}
      data-right-collapsed={cols.right === RIGHT_COLLAPSED || undefined}
      data-dragging={dragging || undefined}
    >
      {/* The custom window titlebar: drag surface + close/maximize/minimize
          in the Tauri WebView, plus the layout menu that toggles each panel. */}
      <TitleBar useStore={useStore} actions={actions} />
      {/* The column grid (sidebar | center | details | right) holding the four
          panels; drag handles position against it. */}
      <MainArea style={{ gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px ${cols.right}px` }}>
        <div className={css.sidebarCol}>
          {/* Render-site slot call with live concession output: a closed
              sidebar keeps the mounted slot at the compact-rail width, and the
              component sees its rendered state as owner params decided here
              (collapsed follows the resolved rail, so a derived auto-collapse
              renders the rail UI too). */}
          {renderSlot('sidebar', {
            collapsed: sidebarCollapsed,
            width: cols.sidebar,
          })}
        </div>
        <>
          {/* Both column occupants stay at fixed tree positions from first
              paint — no loading gate: a bare status line reads worse than
              the shell's own pending rendering. The conversation
              is session-maybe; the strict details entry naturally renders
              empty while no session is current. */}
          <CenterColumn>{renderSlot('conversation', {})}</CenterColumn>
          <DetailsColumn>{renderSlot('details', {})}</DetailsColumn>
          {/* The right workspace column renders the workspace panel (it held
              terminal + Git; the terminal moved to the bottom panel below). It
              participates in the concession chain like the sidebar, so an open
              panel squeezes the center column. */}
          <RightColumn>
            {renderSlot('shell.right', {
              collapsed: cols.right === RIGHT_COLLAPSED,
              width: cols.right,
            })}
          </RightColumn>
        </>
        {/* The collapsed rail is fixed-width: no resize handle while closed. */}
        {!sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
        {cols.details > 0 && <DragHandle side="details" left={viewport - cols.details} onStart={onDetailsStart} onDrag={onDetailsDrag} onEnd={onDragEnd} />}
        {cols.right > RIGHT_COLLAPSED && <DragHandle side="right" left={viewport - cols.right} onStart={onRightStart} onDrag={onRightDrag} onEnd={onDragEnd} />}
      </MainArea>
      {/* The bottom panel hosts the terminal; it stays mounted (inline-hidden)
          while closed so its xterm surface survives panel toggles. */}
      <BottomRow open={panels.bottom > 0} height={panels.bottom}>
        {renderSlot('shell.bottom', {
          collapsed: panels.bottom === 0,
          height: panels.bottom,
        })}
      </BottomRow>
      {/* The bottom track's height drag handle rides its top edge (hidden
          while the panel is closed). */}
      {panels.bottom > 0 && <DragHandle side="bottom" bottom={panels.bottom} onStart={onBottomStart} onDrag={onBottomDrag} onEnd={onDragEnd} />}
      {/* Frame-wide floating layer, above every column and the bottom row. */}
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
    </div>
  )
}
