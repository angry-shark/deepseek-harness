/**
 * Pure TUI types shared across the front door and its embedding bundles.
 * @module @deepseek-ai/dsh/tui/types
 */

/** The front-door plugin config. */
export interface Config {
  /** Exact shared agent/session identity the front door drives. */
  sessionId: string
  /** Banner subtitle shown until the session has a logged title. */
  welcome: string
  /** Render reasoning blocks. */
  showReasoning: boolean
  /** Apply the built-in ANSI palette; `false` strips all styling. */
  color: boolean
  /** Product suffix for the terminal window title. */
  title: string
}
