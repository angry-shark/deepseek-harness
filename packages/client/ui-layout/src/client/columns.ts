/**
 * Pure concession-chain column solver for the four-column AppFrame. Chain
 * order is fixed by contract: keep center >= CENTER_MIN by shrinking details,
 * then the right panel, then auto-closing details, then the right panel
 * (derived zero width — preferred width preferences are never rewritten, so
 * widening the window restores them). The sidebar never concedes: its
 * rendered width is always the drag preference (or the collapsed rail), and
 * center absorbs any remaining deficit as the last resort. Inputs are the
 * layout store's plain width preferences (0 = closed); a closed sidebar
 * resolves to the fixed SIDEBAR_COLLAPSED control rail while closed details
 * and right resolve to zero width. The SIDEBAR_AUTO_COLLAPSE breakpoint is
 * consumed by AppFrame, which decides the effective sidebar preference before
 * solving; the solver itself stays breakpoint-free.
 */

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface Columns { sidebar: number; center: number; details: number; right: number }

// Contract-frozen geometry: the four-column concession chain's fixed points.
/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 640
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Details drag clamp floor. */
export const DETAILS_MIN = 300
/** Details drag clamp ceiling. */
export const DETAILS_MAX = 520
/** Details width before any user drag. */
export const DETAILS_DEFAULT = 360
/** Right-panel drag clamp floor. */
export const RIGHT_MIN = 300
/** Right-panel drag clamp ceiling. */
export const RIGHT_MAX = 520
/** Right-panel width before any user drag. */
export const RIGHT_DEFAULT = 360
/** Closed right-panel rail: a 40px full-height edge strip (like the sidebar rail). */
export const RIGHT_COLLAPSED = 40

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the four column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary and callers may still supply stale ranges. The right column,
 * like the sidebar, always renders a compact rail when closed (never zero
 * width): the user asked for a right bar that behaves like the left one.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @param right - right-panel width preference in px (0 = closed).
 * @returns resolved widths; details 0 is visually closed (never unmounted); a
 * closed sidebar and the right column keep their compact rails.
 */
export function computeColumns(viewport: number, sidebar: number, details: number, right: number): Columns {
  // The sidebar is fixed at its preference (or the rail) — it never concedes.
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)
  const rightOpen = right !== 0
  // A closed right column renders the fixed edge rail, like the sidebar rail.
  const r0 = rightOpen ? clampWidth(right, RIGHT_MIN, RIGHT_MAX) : RIGHT_COLLAPSED

  // Step 1: everything fits at preferred widths.
  if (s + d0 + r0 + CENTER_MIN <= viewport) {
    return { sidebar: s, center: viewport - s - d0 - r0, details: d0, right: r0 }
  }

  // Step 2: shrink details toward its minimum.
  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - s - r0 - CENTER_MIN)
  if (s + d1 + r0 + CENTER_MIN <= viewport) {
    return { sidebar: s, center: CENTER_MIN, details: d1, right: r0 }
  }

  // Step 3: shrink the right panel toward its minimum (a closed right holds
  // its rail — only an open panel concedes).
  if (rightOpen) {
    const r1 = Math.max(RIGHT_MIN, viewport - s - d1 - CENTER_MIN)
    if (s + d1 + r1 + CENTER_MIN <= viewport) {
      return { sidebar: s, center: CENTER_MIN, details: d1, right: r1 }
    }
  }

  // Step 4: auto-close details (derived — preferences untouched); the right
  // panel keeps its width and center absorbs the deficit.
  if (s + r0 + CENTER_MIN <= viewport) {
    return { sidebar: s, center: viewport - s - r0, details: 0, right: r0 }
  }

  // Step 5: the right panel collapses to its rail; center absorbs any
  // remaining deficit (may drop below CENTER_MIN).
  return { sidebar: s, center: Math.max(0, viewport - s - RIGHT_COLLAPSED), details: 0, right: RIGHT_COLLAPSED }
}
