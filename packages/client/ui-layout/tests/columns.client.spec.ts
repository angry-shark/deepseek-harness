import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN, clampWidth, computeColumns,
  DETAILS_DEFAULT, DETAILS_MIN, RIGHT_COLLAPSED, RIGHT_DEFAULT, RIGHT_MIN,
  SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

// Numeric preference form (0 = closed); helpers keep the scenario names readable.
const open = (width: number) => width
const closed = (_width: number) => 0

describe('clampWidth', () => {
  it('clamps into the range and rounds', () => {
    expect(clampWidth(250.4, 240, 420)).toBe(250)
    expect(clampWidth(100, 240, 420)).toBe(240)
    expect(clampWidth(9999, 240, 420)).toBe(420)
  })
})

describe('computeColumns', () => {
  it('step 1: everything fits at preferred widths', () => {
    const cols = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(RIGHT_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: 1920 - 280 - 360 - 360, details: 360, right: 360 })
  })

  it('closed panels keep their compact rails: sidebar 56px, right 40px, details zero', () => {
    expect(computeColumns(1920, closed(300), closed(360), closed(360)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1920 - SIDEBAR_COLLAPSED - RIGHT_COLLAPSED, details: 0, right: RIGHT_COLLAPSED })
  })

  it('preferences beyond the clamp range are clamped before solving', () => {
    const cols = computeColumns(1920, open(9999), open(1), open(1))
    expect(cols.sidebar).toBe(420)
    expect(cols.details).toBe(300)
    expect(cols.right).toBe(RIGHT_MIN)
    expect(computeColumns(1920, open(1), open(DETAILS_DEFAULT), closed(360)).sidebar).toBe(SIDEBAR_MIN)
  })

  it('step 2: details shrinks first, center pinned at min', () => {
    // 280 + 360 + 360 + 640 = 1640 > 1600; details concedes to 1600-280-360-640 = 320.
    const cols = computeColumns(1600, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(RIGHT_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: CENTER_MIN, details: 320, right: 360 })
  })

  it('boundary: exactly at the step-1/step-2 seam', () => {
    const seam = 300 + 360 + 360 + CENTER_MIN
    const cols = computeColumns(seam, open(300), open(360), open(360))
    expect(cols).toEqual({ sidebar: 300, center: CENTER_MIN, details: 360, right: 360 })
    const one = computeColumns(seam - 1, open(300), open(360), open(360))
    expect(one).toEqual({ sidebar: 300, center: CENTER_MIN, details: 359, right: 360 })
  })

  it('step 3: right shrinks after details hits its min', () => {
    // 280 + 300 + 360 + 640 = 1580 > 1550; details at min, right concedes to 1550-280-300-640 = 330.
    const cols = computeColumns(1550, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(RIGHT_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: CENTER_MIN, details: 300, right: 330 })
  })

  it('step 4: details auto-closes when its min still starves center — sidebar and right hold', () => {
    // 280 + 300 + 360 + 640 = 1580 > 1560... use a width where details closes but right keeps its min.
    // 280 + 300 + 300 + 640 = 1520 > 1500 → details 0, right 300, center = 1500-280-300 = 920.
    const cols = computeColumns(1500, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(300))
    expect(cols).toEqual({ sidebar: 280, center: 920, details: 0, right: 300 })
  })

  it('step 5: right collapses to its rail; center absorbs the remaining deficit', () => {
    // 700 < 280+640+40: sidebar keeps 280, right collapses to its 40px rail, center takes the rest.
    const cols = computeColumns(700, open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT), open(RIGHT_DEFAULT))
    expect(cols).toEqual({ sidebar: SIDEBAR_DEFAULT, center: 700 - SIDEBAR_DEFAULT - RIGHT_COLLAPSED, details: 0, right: RIGHT_COLLAPSED })
  })

  it('sidebar-closed narrow window: details concedes then auto-closes; right rail holds', () => {
    const fits = computeColumns(
      SIDEBAR_COLLAPSED + DETAILS_MIN + RIGHT_COLLAPSED + CENTER_MIN,
      closed(300), open(DETAILS_DEFAULT), closed(360))
    expect(fits).toEqual({ sidebar: SIDEBAR_COLLAPSED, center: CENTER_MIN, details: DETAILS_MIN, right: RIGHT_COLLAPSED })
    // One px below the step-2 seam: details auto-closes (right already closed), center absorbs.
    const starved = computeColumns(
      SIDEBAR_COLLAPSED + DETAILS_MIN + RIGHT_COLLAPSED + CENTER_MIN - 1,
      closed(300), open(DETAILS_DEFAULT), closed(360))
    expect(starved).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: SIDEBAR_COLLAPSED + DETAILS_MIN + RIGHT_COLLAPSED + CENTER_MIN - 1 - SIDEBAR_COLLAPSED - RIGHT_COLLAPSED,
      details: 0,
      right: RIGHT_COLLAPSED,
    })
  })

  it('tiny viewport: details closes, sidebar holds, right rail stays, center takes the remainder', () => {
    const cols = computeColumns(400, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(RIGHT_DEFAULT))
    expect(cols.details).toBe(0)
    expect(cols.right).toBe(RIGHT_COLLAPSED)
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
    expect(cols.center).toBe(Math.max(0, 400 - SIDEBAR_DEFAULT - RIGHT_COLLAPSED))
  })

  it('recovery is pure: re-widening restores preferred widths untouched', () => {
    const squeezed = computeColumns(1100, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(RIGHT_DEFAULT))
    expect(squeezed.details).toBe(0)
    expect(squeezed.right).toBe(RIGHT_COLLAPSED)
    const restored = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(RIGHT_DEFAULT))
    expect(restored.details).toBe(DETAILS_DEFAULT)
    expect(restored.right).toBe(RIGHT_DEFAULT)
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT)
  })
})

describe('computeColumns — degenerate viewports', () => {
  it('sidebar closed and viewport below CENTER_MIN: details auto-closes, right rail holds, center takes the rest', () => {
    // Reaches step 5's auto-close with the compact rail sidebar and the right rail.
    expect(computeColumns(500, closed(300), open(DETAILS_DEFAULT), open(RIGHT_DEFAULT)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 500 - SIDEBAR_COLLAPSED - RIGHT_COLLAPSED, details: 0, right: RIGHT_COLLAPSED })
  })
})
