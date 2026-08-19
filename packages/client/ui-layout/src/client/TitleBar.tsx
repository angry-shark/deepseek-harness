/**
 * Custom window titlebar for the undecorated Tauri desktop shell. Renders as a
 * slim top bar on every platform; inside the desktop WebView it becomes the
 * window's drag surface (`data-tauri-drag-region`) and gains the close /
 * maximize / minimize controls, which call the Tauri window API exposed on
 * `window.__TAURI__` (available only there, scoped by the window-controls
 * capability). In a plain browser those controls are omitted and the bar is not
 * a drag surface. It also carries the layout menu (布局): one button that
 * toggles each side's panel (sidebar / details / right / bottom), so the header
 * doubles as the "自定义布局设置" surface. The owner supplies the layout store
 * read/action pair; the component is layout-internal (not a slot occupant), so
 * it takes plain props rather than the four framework shares.
 */

import { useCallback, useState, type ReactNode } from 'react'
import type { LayoutState } from './stores.ts'
import css from './AppFrame.module.css'

/** The Tauri v2 global and its window control surface, present only in the WebView. */
interface TauriWindowLike {
  window: {
    getCurrentWindow(): {
      minimize: () => Promise<void>
      toggleMaximize: () => Promise<void>
      close: () => Promise<void>
      isMaximized: () => Promise<boolean>
    }
  }
}

/** One toggleable panel, keyed to a `LayoutState` width/height field. */
type PanelKey = 'sidebar' | 'details' | 'right' | 'bottom'

/** The four panels' label. The baked store actions (bound, no draft arg) live on `actions`. */
const PANELS: ReadonlyArray<{ key: PanelKey; label: string }> = [
  { key: 'sidebar', label: '侧栏' },
  { key: 'details', label: '详情' },
  { key: 'right', label: '右侧' },
  { key: 'bottom', label: '底部' },
]

/** The subset of baked layout actions the titlebar menu dispatches. */
export interface PanelToggleActions {
  toggleSidebar: () => void
  toggleDetails: () => void
  toggleRight: () => void
  toggleBottom: () => void
}

interface TitleBarProps {
  /** Layout store selector hook (reads the current panel open/closed state). */
  useStore: (selector: (s: LayoutState) => LayoutState) => LayoutState
  /** The store's baked actions; panel toggles dispatch through these (bound). */
  actions: PanelToggleActions
}

/**
 * Resolve the window-control surface from the Tauri global if present. Injected
 * only inside the desktop WebView (withGlobalTauri + the window-controls
 * capability's remote scope); a plain browser has no `window.__TAURI__`.
 */
function tauriWindowApi(): TauriWindowLike['window'] | undefined {
  return (globalThis as { __TAURI__?: TauriWindowLike }).__TAURI__?.window
}

/**
 * True on macOS, where the native titlebar's window controls are traffic-light
 * buttons at the top-left (`navigator.userAgent` reports "Mac"). Windows and
 * Linux carry square close/maximize/minimize buttons at the top-right instead,
 * matching each packaged platform's standard chrome and position.
 */
function isMac(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

/**
 * The custom titlebar row: drag surface + platform-native window controls when
 * Tauri is present, plus the four-panel layout toggles that drive the custom
 * layout. On macOS the controls are the left-aligned traffic lights; on
 * Windows/Linux they are the right-aligned square buttons.
 * @param props - see {@link TitleBarProps}.
 * @returns the titlebar element.
 */
export function TitleBar({ useStore, actions }: TitleBarProps): ReactNode {
  const windowApi = tauriWindowApi()?.getCurrentWindow()
  const mac = isMac()
  const layout = useStore(s => s)
  const [maximized, setMaximized] = useState(false)

  const onMinimize = useCallback(() => { const api = windowApi; if (api === undefined) return; void api.minimize() }, [windowApi])
  const onToggleMax = useCallback(() => {
    const api = windowApi
    if (api === undefined) return
    void api.toggleMaximize().then(() => { void api.isMaximized().then(setMaximized) })
  }, [windowApi])
  const onClose = useCallback(() => { const api = windowApi; if (api === undefined) return; void api.close() }, [windowApi])

  return (
    <div className={css.titleBar} data-tauri-drag-region>
      {/* macOS: traffic-light controls (red close, yellow minimize, green
          maximize) at the top-left, matching the native position and style. */}
      {windowApi !== undefined && mac ? (
        <div className={css.trafficLights} data-platform-window-controls="mac">
          <button type="button" className={`${css.trafficLight} ${css.trafficClose}`} aria-label="关闭" title="关闭" onClick={onClose}>×</button>
          <button type="button" className={`${css.trafficLight} ${css.trafficMin}`} aria-label="最小化" title="最小化" onClick={onMinimize}>−</button>
          <button
            type="button"
            className={`${css.trafficLight} ${css.trafficMax}`}
            aria-label={maximized ? '还原' : '最大化'}
            title={maximized ? '还原' : '最大化'}
            onClick={onToggleMax}
          >
            {maximized ? '⧉' : '▢'}
          </button>
        </div>
      ) : null}
      <span className={css.titleBarTitle}>DeepSeek Harness</span>
      <div className={css.titleBarSpacer} data-tauri-drag-region />
      <div className={css.titleBarGroup} data-tauri-drag-region>
        {PANELS.map(({ key, label }) => {
          const open = layout[key] !== 0
          return (
            <button
              key={key}
              type="button"
              className={open ? `${css.titleBarBtn} ${css.titleBarBtnOn}` : css.titleBarBtn}
              data-panel={key}
              title={`切换${label}`}
              onClick={() => { togglePanel(actions, key) }}
            >
              {label}
            </button>
          )
        })}
      </div>
      {/* Windows/Linux: square close/maximize/minimize at the top-right. */}
      {windowApi !== undefined && !mac ? (
        <div className={css.windowControls} data-platform-window-controls="windows">
          <button type="button" className={css.winBtn} aria-label="最小化" title="最小化" onClick={onMinimize}>—</button>
          <button
            type="button"
            className={css.winBtn}
            aria-label={maximized ? '还原' : '最大化'}
            title={maximized ? '还原' : '最大化'}
            onClick={onToggleMax}
          >
            ▢
          </button>
          <button type="button" className={`${css.winBtn} ${css.winClose}`} aria-label="关闭" title="关闭" onClick={onClose}>✕</button>
        </div>
      ) : null}
    </div>
  )
}

/** Dispatch the baked toggle action for one panel key (a one-click layout switch). */
function togglePanel(actions: PanelToggleActions, key: PanelKey): void {
  switch (key) {
    case 'sidebar': actions.toggleSidebar(); break
    case 'details': actions.toggleDetails(); break
    case 'right': actions.toggleRight(); break
    case 'bottom': actions.toggleBottom(); break
  }
}
