/**
 * Plugin-definition scanning for the market: one plugin folder under a source
 * repo or the store, resolved to a definition with compiled JS bodies. Body
 * resolution order: `dist/host.js`/`dist/client.js` (prebuilt by the repo's
 * own build) → `src/host.ts`/`src/client.ts` (compiled on demand) →
 * `plugin.json`'s inline `host`/`client` bodies (legacy plain-JS form).
 * @module @deepseek-ai/dsh-host-plugin-market/scan
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { compileTsBody } from './ts-compile.ts'
import type { MarketPluginDefinition, MarketPluginId } from './types.ts'

/** Metadata manifest filename inside each plugin folder. */
export const PLUGIN_MANIFEST = 'plugin.json'

/** Repository layout directory that holds every plugin folder. */
export const REPO_PLUGINS_DIR = 'plugins'

/** The relative path of one half's source or prebuilt artifact inside a plugin folder. */
const HALF_FILES = {
  host: { dist: join('dist', 'host.js'), src: join('src', 'host.ts') },
  client: { dist: join('dist', 'client.js'), src: join('src', 'client.ts') },
} as const

/** Metadata manifest parsed from `plugin.json`. */
interface PluginManifest {
  name: string
  purpose: string
  host?: string
  client?: string
}

/** Read one half's body: prebuilt dist first, then compiled TS source. */
async function readHalf(folder: string, half: 'host' | 'client'): Promise<string | undefined> {
  const paths = HALF_FILES[half]
  const distPath = join(folder, paths.dist)
  if (existsSync(distPath)) return readFileSync(distPath, 'utf8')
  const srcPath = join(folder, paths.src)
  if (existsSync(srcPath)) return compileTsBody(readFileSync(srcPath, 'utf8'))
  return undefined
}

/**
 * Scan one plugin folder into a definition, compiling TS halves on demand.
 * @param folder - the plugin directory.
 * @returns the definition, or `undefined` when the folder has no manifest.
 * @throws a teaching error for an invalid manifest or un-compilable half.
 */
export async function scanPluginFolder(folder: string): Promise<MarketPluginDefinition | undefined> {
  const manifestPath = join(folder, PLUGIN_MANIFEST)
  if (!existsSync(manifestPath)) return undefined
  let manifest: PluginManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PluginManifest
  } catch (error) {
    throw new Error(`invalid ${PLUGIN_MANIFEST}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0
    || typeof manifest.purpose !== 'string' || manifest.purpose.length === 0) {
    throw new Error(`${PLUGIN_MANIFEST} must declare string \`name\` and \`purpose\``)
  }
  const id = marketIdOf(folder)
  const host = await readHalf(folder, 'host') ?? manifest.host
  const client = await readHalf(folder, 'client') ?? manifest.client
  return {
    id,
    name: manifest.name,
    purpose: manifest.purpose,
    ...host === undefined ? {} : { host },
    ...client === undefined ? {} : { client },
  }
}

/**
 * Scan a source repo's `plugins/` layout: one definition per plugin folder,
 * keyed by folder name.
 * @param repoDir - the checked-out repository root.
 * @returns the definitions by plugin id, plus per-plugin scan errors.
 */
export async function scanSourceRepo(repoDir: string): Promise<{
  definitions: Map<MarketPluginId, MarketPluginDefinition>
  errors: Map<MarketPluginId, string>
}> {
  const definitions = new Map<MarketPluginId, MarketPluginDefinition>()
  const errors = new Map<MarketPluginId, string>()
  const pluginsDir = join(repoDir, REPO_PLUGINS_DIR)
  let entries: string[]
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return { definitions, errors }
  }
  for (const name of entries) {
    const id = marketIdOf(name)
    try {
      const definition = await scanPluginFolder(join(pluginsDir, name))
      if (definition !== undefined) definitions.set(id, definition)
    } catch (error) {
      errors.set(id, error instanceof Error ? error.message : String(error))
    }
  }
  return { definitions, errors }
}

/** Derive a plugin id from a folder name (the folder name IS the id). */
function marketIdOf(folder: string): MarketPluginId {
  return folder.split(/[\\/]/).pop() as MarketPluginId
}
