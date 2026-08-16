/**
 * Terminal styling for the TUI front door: one ANSI palette plus the pi-tui
 * Markdown and Editor themes derived from it. Every SGR code the TUI emits
 * lives in {@link paletteSpec}; components never write an escape of their own.
 *
 * Colors use only the standard 16-color ANSI foregrounds and SGR attributes,
 * which every terminal remaps to its active color scheme, so the interface
 * stays readable on light and dark backgrounds alike.
 * @module @deepseek-ai/dsh/tui/theme
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui'

/** One ANSI SGR attribute or foreground color, applied as a wrapper. */
interface PaletteStyle {
  /** The SGR code (30–37 / 90–97 for colors, 1/2/3/4/9 for attributes). */
  code: number
  /** Whether the code opens a color slot (the last color wins when nested). */
  isColor: boolean
}

/** The complete color/attribute table; every role the TUI uses is one entry. */
const paletteSpec = {
  dim: { code: 2, isColor: false },
  bold: { code: 1, isColor: false },
  underline: { code: 4, isColor: false },
  italic: { code: 3, isColor: false },
  // Standard-ANSI foregrounds, each a separate color slot.
  brand: { code: 94, isColor: true },
  accent: { code: 96, isColor: true },
  success: { code: 32, isColor: true },
  error: { code: 31, isColor: true },
  warning: { code: 33, isColor: true },
} as const satisfies Record<string, PaletteStyle>

/** The palette instance: one wrapper function per role, attributes and colors separately typed. */
export interface Palette {
  dim(text: string): string
  bold(text: string): string
  underline(text: string): string
  italic(text: string): string
  brand(text: string): string
  accent(text: string): string
  success(text: string): string
  error(text: string): string
  warning(text: string): string
}

function sgr(code: number, open: boolean): string {
  return `\x1b[${open ? code : (code >= 30 && code <= 37 || code >= 90 && code <= 97) ? 39 : 0}m`
}

function wrap(style: PaletteStyle, text: string): string {
  return `${sgr(style.code, true)}${text}${sgr(style.code, false)}`
}

/**
 * Build the palette instance. Disabled when `color: false`, so the wrappers
 * become identities.
 * @param color - whether to apply ANSI styling.
 * @returns the palette.
 */
export function createPalette(color: boolean): Palette {
  if (!color) return {
    dim: text => text,
    bold: text => text,
    underline: text => text,
    italic: text => text,
    brand: text => text,
    accent: text => text,
    success: text => text,
    error: text => text,
    warning: text => text,
  }
  return {
    dim: text => wrap(paletteSpec.dim, text),
    bold: text => wrap(paletteSpec.bold, text),
    underline: text => wrap(paletteSpec.underline, text),
    italic: text => wrap(paletteSpec.italic, text),
    brand: text => wrap(paletteSpec.brand, text),
    accent: text => wrap(paletteSpec.accent, text),
    success: text => wrap(paletteSpec.success, text),
    error: text => wrap(paletteSpec.error, text),
    warning: text => wrap(paletteSpec.warning, text),
  }
}

/**
 * The pi-tui Markdown theme, derived from the palette. Code stays in a dim
 * tone with an accent language/heading treatment; body text keeps the
 * terminal default foreground.
 * @param p - the active palette.
 * @returns the Markdown theme.
 */
export function markdownTheme(p: Palette): MarkdownTheme {
  return {
    heading: text => p.bold(p.accent(text)),
    link: text => p.accent(text),
    linkUrl: text => p.dim(text),
    code: text => p.accent(text),
    codeBlock: text => p.dim(text),
    codeBlockBorder: text => p.dim(text),
    quote: text => p.dim(text),
    quoteBorder: text => p.dim(text),
    hr: text => p.dim(text),
    listBullet: text => p.dim(text),
    bold: text => p.bold(text),
    italic: text => p.italic(text),
    strikethrough: text => p.dim(text),
    underline: text => p.underline(text),
    codeBlockIndent: '',
  }
}

/**
 * The pi-tui SelectList theme: accent selection, default text otherwise.
 * @param p - the active palette.
 * @returns the SelectList theme.
 */
export function selectListTheme(p: Palette): SelectListTheme {
  return {
    selectedPrefix: () => p.accent('› '),
    selectedText: text => p.bold(p.accent(text)),
    description: text => p.dim(text),
    scrollInfo: text => p.dim(text),
    noMatch: text => p.dim(text),
  }
}

/**
 * The pi-tui Editor theme: a dim border so the input row reads as recessed.
 * @param p - the active palette.
 * @returns the Editor theme.
 */
export function editorTheme(p: Palette): EditorTheme {
  return {
    borderColor: text => p.dim(text),
    selectList: selectListTheme(p),
  }
}
