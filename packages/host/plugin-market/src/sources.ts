/**
 * Plugin-market source management: the configured git repositories that feed
 * the catalog, persisted under the market store, and the clone/pull fetch that
 * materializes each source into a content-addressed cache directory.
 * @module @deepseek-ai/dsh-host-plugin-market/sources
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

/** Persisted user source list filename, inside the market store root. */
export const SOURCES_FILENAME = 'sources.json'

/** One source's fetch outcome. */
export interface SourceFetchStatus {
  url: string
  ok: boolean
  message?: string
  pluginCount: number
}

/** How long one git operation may take before failing. */
const GIT_TIMEOUT_MS = 120_000

const execFileAsync = promisify(execFile)

async function runGit(args: readonly string[], cwd?: string): Promise<void> {
  await execFileAsync('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS })
}

/**
 * Read the effective source list: deployment defaults first, then the
 * user-persisted additions, de-duplicated by URL.
 * @param root - the market store root (holds `sources.json`).
 * @param configSources - deployment-configured defaults.
 * @returns the effective URL list in order.
 */
export function readEffectiveSources(root: string, configSources: readonly string[]): string[] {
  const persisted = readPersistedSources(root)
  const seen = new Set<string>()
  const merged: string[] = []
  for (const url of [...configSources, ...persisted]) {
    if (seen.has(url)) continue
    seen.add(url)
    merged.push(url)
  }
  return merged
}

/** Read the user-persisted source list; a missing file means none. */
export function readPersistedSources(root: string): string[] {
  const path = join(root, SOURCES_FILENAME)
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (Array.isArray(parsed) && parsed.every(value => typeof value === 'string')) {
      return parsed
    }
    return []
  } catch {
    return []
  }
}

/** Persist the user source list (an empty list writes an empty array). */
export function persistSources(root: string, urls: readonly string[]): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, SOURCES_FILENAME), JSON.stringify(urls, undefined, 2) + '\n')
}

/**
 * The stable content-addressed cache directory for one source URL, a sibling
 * of the store root so the store stays a single plugin directory.
 * @param root - the market store root.
 * @param url - the source git URL.
 * @returns the cache directory path (may not exist yet).
 */
export function sourceCacheDir(root: string, url: string): string {
  const digest = createHash('sha1').update(url).digest('hex').slice(0, 12)
  return join(dirname(root), 'plugin-sources', digest)
}

/**
 * Materialize one source into its cache directory: clone on first use, fast-
 * forward pull on later refreshes.
 * @param url - the source git URL.
 * @param cacheDir - the cache directory from {@link sourceCacheDir}.
 */
export async function fetchSource(url: string, cacheDir: string): Promise<void> {
  if (existsSync(join(cacheDir, '.git'))) {
    await runGit(['-C', cacheDir, 'pull', '--ff-only'])
    return
  }
  rmSync(cacheDir, { recursive: true, force: true })
  mkdirSync(dirname(cacheDir), { recursive: true })
  await runGit(['clone', '--depth', '1', url, cacheDir])
}
