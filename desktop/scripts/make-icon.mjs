#!/usr/bin/env node
/**
 * Generate the placeholder app icon (desktop/build/icon.png, 1024x1024) with
 * zero dependencies: a DeepSeek-blue rounded square with a white double
 * chevron, encoded as a PNG by hand. Replace it with a designed icon at any
 * time; electron-builder converts this PNG to .icns and .ico per platform.
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const CORNER_RADIUS = 200
const iconDir = resolve(fileURLToPath(new URL('../build', import.meta.url)))
const iconPath = join(iconDir, 'icon.png')

/** Top color of the vertical gradient background. */
const TOP = [0x4d, 0x6b, 0xfe]
/** Bottom color of the vertical gradient background. */
const BOTTOM = [0x1a, 0x2f, 0x9b]
const FOREGROUND = [0xff, 0xff, 0xff]

function roundedRectContains(x, y) {
  const px = x < CORNER_RADIUS ? CORNER_RADIUS : x > SIZE - CORNER_RADIUS ? SIZE - CORNER_RADIUS : x
  const py = y < CORNER_RADIUS ? CORNER_RADIUS : y > SIZE - CORNER_RADIUS ? SIZE - CORNER_RADIUS : y
  const dx = x - px
  const dy = y - py
  return dx * dx + dy * dy <= CORNER_RADIUS * CORNER_RADIUS
}

/** Whether the pixel lies inside the double-chevron mark. */
function chevronContains(x, y) {
  // Two right-pointing chevrons defined by their polygon vertices.
  const chevrons = [
    [[0.30, 0.28], [0.55, 0.28], [0.70, 0.50], [0.55, 0.72], [0.30, 0.72], [0.47, 0.50]],
    [[0.55, 0.28], [0.80, 0.28], [0.95, 0.50], [0.80, 0.72], [0.55, 0.72], [0.72, 0.50]],
  ]
  const point = [x / SIZE, y / SIZE]
  return chevrons.some(vertices => pointInPolygon(point, vertices))
}

/** Ray-casting point-in-polygon test over normalized coordinates. */
function pointInPolygon([px, py], vertices) {
  let inside = false
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const [xi, yi] = vertices[i]
    const [xj, yj] = vertices[j]
    if ((yi > py) !== (yj > py)
      && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  const t = y / (SIZE - 1)
  const bg = TOP.map((channel, index) => Math.round(channel + (BOTTOM[index] - channel) * t))
  for (let x = 0; x < SIZE; x++) {
    const offset = y * (SIZE * 4 + 1) + 1 + x * 4
    if (!roundedRectContains(x, y)) {
      raw.writeUInt32BE(0, offset) // fully transparent
      continue
    }
    const color = chevronContains(x, y) ? FOREGROUND : bg
    raw[offset] = color[0]
    raw[offset + 1] = color[1]
    raw[offset + 2] = color[2]
    raw[offset + 3] = 0xff
  }
}

/** CRC-32 (IEEE 802.3) over a buffer, as required by the PNG spec. */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuffer, data])
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(iconDir, { recursive: true })
writeFileSync(iconPath, png)
console.log(`make-icon: wrote ${iconPath}`)
