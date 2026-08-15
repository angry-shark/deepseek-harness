/**
 * Embedding hooks a launcher may provide on the boot context for the TUI
 * front door. All are optional; the shipped `dsh` profile supplies none and
 * the TUI degrades to sensible defaults.
 * @module @deepseek-ai/dsh-tui/runtime
 */

/** Host-owned presentation tweaks the TUI reads off the boot context. */
export interface TuiRuntime {
  /**
   * Override the footer's working-directory label when the logical workspace
   * differs from the session's host directory. Presentation only — tools
   * keep using the session `cwd`.
   * @param cwd - the session working directory.
   * @returns the label shown in the footer.
   */
  formatCwd?(cwd: string): string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional host hooks for the TUI front door. */
    tuiRuntime?: TuiRuntime
  }
}
