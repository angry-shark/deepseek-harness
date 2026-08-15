/**
 * The tui-app bundle's substance is its patch file: it must declare a
 * parseable patch list, insert the TUI front door row, and keep the shared
 * base rows mode-neutral (the bundle owns only surface-specific values).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('dsh-tui-app bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    const patches = parsed as { id?: string; insert?: { id?: string; name?: string }[] }[]
    const rows = patches.flatMap(patch => patch.insert ?? [])
    expect(rows.find(row => row.id === 'tui')).toMatchObject({ name: '@deepseek-ai/dsh-tui' })
  })

  it('overrides the persona without mounting a Host or HTTP layer', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    const patches = parsed as { id?: string; config?: Record<string, unknown>; insert?: { id?: string }[] }[]
    expect(patches.find(patch => patch.id === 'system-prompt')?.config?.['persona']).toBeTypeOf('string')
    const inserted = patches.flatMap(patch => patch.insert ?? [])
    expect(inserted.some(row => row.id === 'host' || row.id === 'webserver')).toBe(false)
  })
})
