#!/usr/bin/env node
/**
 * Generate the app icon (desktop/build/icon.png, 1024x1024) with zero
 * dependencies: a DeepSeek-blue gradient rounded square with a terminal-window
 * motif — a dark window with macOS traffic-light dots, a `❯` prompt and a
 * cursor block — encoded as a PNG by hand. `tauri icon` converts this PNG to
 * .icns and .ico per platform.
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const iconDir = resolve(fileURLToPath(new URL('../build', import.meta.url)))
const iconPath = join(iconDir, 'icon.png')

/** Top color of the vertical gradient background. */
const TOP = [0x4d, 0x6b, 0xfe]
/** Bottom color of the vertical gradient background. */
const BOTTOM = [0x16, 0x27, 0x7f]
/** The dark terminal-window fill. */
const WINDOW = [0x0e, 0x14, 0x24]
/** The prompt chevron color. */
const CHEVRON = [0x7c, 0x9c, 0xff]
/** The prompt cursor color. */
const CURSOR = [0xd9, 0xe4, 0xff]
/** The traffic-light dots (macOS close/min/max). */
const DOT_CLOSE = [0xff, 0x5f, 0x57]
const DOT_MIN = [0xfe, 0xbc, 0x2e]
const DOT_MAX = [0x28, 0xc8, 0x40]

/** True when (x, y) lies inside the rounded rect with the given bounds/radius. */
function roundedRectContains(x, y, rx, ry, rw, rh, r) {
  const px = x < rx + r ? rx + r : x > rx + rw - r ? rx + rw - r : x
  const py = y < ry + r ? ry + r : y > ry + rh - r ? ry + rh - r : y
  const dx = x - px
  const dy = y - py
  return dx * dx + dy * dy <= r * r
}

/** True when (x, y) lies inside the filled circle centered at (cx, cy). */
function circleContains(x, y, cx, cy, r) {
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/** Squared distance from (x, y) to the segment (x1, y1)-(x2, y2). */
function distSqToSegment(x, y, x1, y1, x2, y2) {
  const vx = x2 - x1
  const vy = y2 - y1
  const wx = x - x1
  const wy = y - y1
  const lenSq = vx * vx + vy * vy
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq))
  const px = x1 + t * vx
  const py = y1 + t * vy
  const dx = x - px
  const dy = y - py
  return dx * dx + dy * dy
}

/** The `❯` prompt chevron: two segments, stroke width 40 (radius 20). */
function chevronContains(x, y) {
  const r = 20
  return distSqToSegment(x, y, 308, 460, 372, 512) <= r * r
    || distSqToSegment(x, y, 372, 512, 308, 564) <= r * r
}

// Geometry constants for the terminal window and its chrome.
const OUTER = { rx: 0, ry: 0, rw: SIZE, rh: SIZE, r: 224 }
const WINDOW_RECT = { rx: 232, ry: 288, rw: 560, rh: 448, r: 56 }
const CURSOR_RECT = { rx: 436, ry: 432, rw: 44, rh: 160, r: 14 }

/** The pixel color for (x, y), or null for fully transparent. */
function pixelColor(x, y) {
  if (!roundedRectContains(x, y, OUTER.rx, OUTER.ry, OUTER.rw, OUTER.rh, OUTER.r)) return null
  const t = y / (SIZE - 1)
  const bg = TOP.map((channel, index) => Math.round(channel + (BOTTOM[index] - channel) * t))
  // A subtle inner ring hugs the outer rounded rect.
  if (roundedRectContains(x, y, OUTER.rx, OUTER.ry, OUTER.rw, OUTER.rh, OUTER.r - 3) === false) {
    return bg.map(channel => Math.round(channel + (255 - channel) * 0.16))
  }
  if (roundedRectContains(x, y, WINDOW_RECT.rx, WINDOW_RECT.ry, WINDOW_RECT.rw, WINDOW_RECT.rh, WINDOW_RECT.r)) {
    // The window's own subtle border (a 4px lighter band at its edge).
    if (roundedRectContains(x, y, WINDOW_RECT.rx, WINDOW_RECT.ry, WINDOW_RECT.rw, WINDOW_RECT.rh, WINDOW_RECT.r - 2) === false) {
      return WINDOW.map(channel => Math.round(channel + (255 - channel) * 0.08))
    }
    if (circleContains(x, y, 304, 348, 16)) return DOT_CLOSE
    if (circleContains(x, y, 356, 348, 16)) return DOT_MIN
    if (circleContains(x, y, 408, 348, 16)) return DOT_MAX
    if (roundedRectContains(x, y, CURSOR_RECT.rx, CURSOR_RECT.ry, CURSOR_RECT.rw, CURSOR_RECT.rh, CURSOR_RECT.r)) return CURSOR
    if (chevronContains(x, y)) return CHEVRON
    return WINDOW
  }
  return bg
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  for (let x = 0; x < SIZE; x++) {
    const offset = y * (SIZE * 4 + 1) + 1 + x * 4
    const color = pixelColor(x, y)
    if (color === null) {
      raw.writeUInt32BE(0, offset) // fully transparent
      continue
    }
    raw[offset] = color[0]
    raw[offset + 1] = color[1]
    raw[offset + 2] = color[2]
    raw[offset + 3] = 0xff
  }
}

/** CRC-32 (IEEE 802.3) over a buffer, as required by the PNG spec. */
function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i]
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** One PNG chunk: length, type, data, crc. */
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([length, typeBuf, data, crc])
}

// IHDR: 8-bit RGBA, 1024x1024.
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8
ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(iconDir, { recursive: true })
writeFileSync(iconPath, png)
console.log(`wrote ${iconPath} (${png.length} bytes)`)
