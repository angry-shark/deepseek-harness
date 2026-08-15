#!/usr/bin/env node
/**
 * Optional local build: compiles every plugin's TS halves into `dist/*.js`
 * bodies so the repository ships prebuilt artifacts. The market can also
 * compile on demand from `src/*.ts`; running this before pushing keeps the
 * checkout deterministic for consumers without a build step.
 */

import { transform } from 'esbuild'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const STRIP_TYPE_IMPORTS = /^\s*import\s+type\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm
const BODY_START = '/*!__dsh_ts_body_start__*/'
const BODY_END = '/*!__dsh_ts_body_end__*/'

async function compileTsBody(source) {
  const cleaned = source.replace(STRIP_TYPE_IMPORTS, '')
  for (const line of cleaned.split('\n')) {
    if (/^\s*(import|export)\b/.test(line)) {
      throw new Error(`value imports/exports are not allowed in plugin halves: ${line.trim()}`)
    }
  }
  const wrapped = `async function __dsh_body() {\n${BODY_START}\n${cleaned}\n${BODY_END}\n}`
  const { code } = await transform(wrapped, {
    loader: 'ts',
    target: 'es2020',
    legalComments: 'inline',
  })
  const start = code.indexOf(BODY_START) + BODY_START.length
  const end = code.indexOf(BODY_END)
  if (start < BODY_START.length || end < 0 || end < start) {
    throw new Error(`failed to extract compiled body from ${JSON.stringify(code.slice(0, 120))}`)
  }
  return code.slice(start, end).trim()
}

const pluginsDir = join(process.cwd(), 'plugins')
for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)) {
  for (const half of ['host', 'client']) {
    const source = join(pluginsDir, plugin, 'src', `${half}.ts`)
    if (!existsSync(source)) continue
    const body = await compileTsBody(readFileSync(source, 'utf8'))
    const dist = join(pluginsDir, plugin, 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, `${half}.js`), `${body}\n`)
    console.log(`built ${plugin} ${half} half → dist/${half}.js`)
  }
}
