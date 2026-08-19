// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { LayoutState } from '../src/client/stores.ts'
import { TitleBar, type PanelToggleActions } from '../src/client/TitleBar.tsx'

/** A minimal snapshot-selector hook over a mutable state object. */
function hook(state: LayoutState): (selector: (s: LayoutState) => LayoutState) => LayoutState {
  return selector => selector(state)
}

function state(partial: Partial<LayoutState> = {}): LayoutState {
  return { sidebar: 280, details: 0, right: 0, bottom: 0, narrow: false, narrowExpanded: false, ...partial }
}

function panelActions(): PanelToggleActions {
  return {
    toggleSidebar: vi.fn(),
    toggleDetails: vi.fn(),
    toggleRight: vi.fn(),
    toggleBottom: vi.fn(),
  }
}

afterEach(() => { cleanup() })

/** Simulate the desktop WebView: expose the Tauri global and a platform user agent. */
function stubDesktop(mac: boolean): () => void {
  const fe = {
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    isMaximized: vi.fn(() => Promise.resolve(false)),
    close: vi.fn(() => Promise.resolve()),
  }
  ;(globalThis as Record<string, unknown>).__TAURI__ = { window: { getCurrentWindow: () => fe } }
  const original = navigator.userAgent
  Object.defineProperty(navigator, 'userAgent', {
    value: mac ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' : 'Mozilla/5.0 (Windows NT 10.0)',
    configurable: true,
  })
  return () => {
    delete (globalThis as Record<string, unknown>).__TAURI__
    Object.defineProperty(navigator, 'userAgent', { value: original, configurable: true })
  }
}

describe('TitleBar', () => {
  it('renders the product title and the four panel toggles', () => {
    render(<TitleBar useStore={hook(state())} actions={panelActions()} />)
    expect(screen.getByText('DeepSeek Harness')).toBeTruthy()
    expect(screen.getByRole('button', { name: '侧栏' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '详情' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '右侧' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '底部' })).toBeTruthy()
  })

  it('dispatches the matching toggle for each panel button', () => {
    const acts = panelActions()
    render(<TitleBar useStore={hook(state())} actions={acts} />)
    fireEvent.click(screen.getByRole('button', { name: '侧栏' }))
    fireEvent.click(screen.getByRole('button', { name: '详情' }))
    fireEvent.click(screen.getByRole('button', { name: '右侧' }))
    fireEvent.click(screen.getByRole('button', { name: '底部' }))
    expect(acts.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(acts.toggleDetails).toHaveBeenCalledTimes(1)
    expect(acts.toggleRight).toHaveBeenCalledTimes(1)
    expect(acts.toggleBottom).toHaveBeenCalledTimes(1)
  })

  it('omits the window controls when Tauri is absent (plain browser)', () => {
    render(<TitleBar useStore={hook(state())} actions={panelActions()} />)
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull()
    expect(screen.queryByRole('button', { name: '最小化' })).toBeNull()
    expect(screen.queryByRole('button', { name: '最大化' })).toBeNull()
  })

  it('renders square window controls at the top-right on Windows/Linux', () => {
    const restore = stubDesktop(false)
    render(<TitleBar useStore={hook(state())} actions={panelActions()} />)
    expect(screen.queryByLabelText('最小化')).toBeTruthy()
    expect(screen.queryByLabelText('最大化')).toBeTruthy()
    expect(screen.queryByLabelText('关闭')).toBeTruthy()
    expect(document.querySelector('[data-platform-window-controls="windows"]')).toBeTruthy()
    expect(document.querySelector('[data-platform-window-controls="mac"]')).toBeNull()
    restore()
  })

  it('renders macOS traffic-lights at the top-left', () => {
    const restore = stubDesktop(true)
    render(<TitleBar useStore={hook(state())} actions={panelActions()} />)
    expect(screen.queryByLabelText('关闭')).toBeTruthy()
    expect(screen.queryByLabelText('最小化')).toBeTruthy()
    expect(screen.queryByLabelText('最大化')).toBeTruthy()
    expect(document.querySelector('[data-platform-window-controls="mac"]')).toBeTruthy()
    expect(document.querySelector('[data-platform-window-controls="windows"]')).toBeNull()
    restore()
  })
})
