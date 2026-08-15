/**
 * Persistent plugin market: a user plugin store under the Harness home, a
 * built-in curated catalog, configurable git plugin sources, and
 * install/uninstall/status Remotes. Each installed plugin is a directory under
 * the store root holding `plugin.json` (name, purpose, and the optional
 * Host/Client halves as async function bodies — the same dialect
 * `cordis_define` accepts); halves may also be authored as TypeScript under
 * `src/` and are compiled on demand. Git sources are cloned into a content-
 * addressed cache and their `plugins/` layouts scanned into the catalog. The
 * service mounts every store plugin's Host half at boot and on install, so an
 * installed plugin survives a restart by construction: the files are read
 * again next boot.
 * @module @deepseek-ai/dsh-host-plugin-market
 */

import {
  existsSync, mkdirSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import {
  createSandbox, evaluateHostCode, isPlugin, normalizeHandler, startHostHalf,
} from '@deepseek-ai/dsh-cordis-host-runner'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { BUILTIN_CATALOG } from './catalog.ts'
import { scanPluginFolder, scanSourceRepo } from './scan.ts'
import {
  fetchSource, persistSources, readEffectiveSources, readPersistedSources, sourceCacheDir,
} from './sources.ts'
import type {
  MarketCatalogEntry, MarketCatalogSnapshot, MarketClientSource, MarketInstallResult,
  MarketInstalledEntry, MarketInstalledSnapshot, MarketInvokeResult, MarketPluginDefinition,
  MarketPluginId, MarketPluginStatus, MarketRunId, MarketSourceStatus, MarketSourceUpdateResult,
  MarketSourcesSnapshot, MarketUninstallResult,
} from './types.ts'

export type * from './types.ts'
export { BUILTIN_CATALOG } from './catalog.ts'

/** One stored plugin manifest. */
interface StoreManifest {
  name: string
  purpose: string
  host?: string
  client?: string
}

/** One live Host-half activation of an installed plugin. */
interface MarketRun {
  pluginId: MarketPluginId
  runId: MarketRunId
  fiber?: Fiber
  handlers: Map<string, (args: unknown) => Promise<unknown>>
  handlerDisposers: (() => void)[]
}

/** Market service configuration. */
export interface Config {
  /** Store root; defaults to `$DSH_HOME/plugins`. */
  root?: string
  /** Deployment-configured git plugin source URLs (users add more in the UI). */
  sources?: string[]
  /** Maximum synchronous Host-half evaluation time in milliseconds. */
  vmTimeoutMs?: number
}

/** Plugin-store manifest filename inside each plugin directory. */
export const STORE_MANIFEST = 'plugin.json'

/** Brand one store directory name at the owning boundary. */
function marketId(id: string): MarketPluginId {
  return id as MarketPluginId
}

/** Brand one activation identity at the owning boundary. */
function runId(value: string): MarketRunId {
  return value as MarketRunId
}

/** The plugin market service: persistent store, catalog, sources, and Remote verbs. */
export class PluginMarketGateway extends TypertRemoteService {
  static inject = []

  static Config: z<Config> = z.object({
    root: z.string().default(''),
    sources: z.array(String).default([]),
    vmTimeoutMs: z.natural().default(5000),
  })

  private readonly root: string
  private readonly vmTimeoutMs: number
  private readonly configSources: readonly string[]
  private readonly runs = new Map<MarketPluginId, MarketRun>()
  private readonly mountErrors = new Map<MarketPluginId, string>()
  /** Store folders whose manifest/compile scan failed; surfaced as failed entries. */
  private readonly storeScanErrors = new Map<MarketPluginId, string>()
  private readonly mounting = new Map<MarketPluginId, Promise<void>>()
  /** Compiled store definitions (disk is durable; this is the runtime view). */
  private readonly storeDefinitions = new Map<MarketPluginId, MarketPluginDefinition>()
  /** Definitions fetched from configured git sources. */
  private readonly remoteDefinitions = new Map<MarketPluginId, MarketPluginDefinition>()
  /** Which configured source URL each fetched definition came from. */
  private readonly remoteSources = new Map<MarketPluginId, string>()
  /** Last fetch outcome per source URL. */
  private readonly sourceStatus = new Map<string, MarketSourceStatus>()
  private readonly refreshing = new Map<string, Promise<void>>()
  private nextRun = 1
  private group: Fiber | undefined

  /** Create the market service under the Host composition. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'pluginMarket')
    this.root = config.root || dshHomePath('plugins')
    this.vmTimeoutMs = (config as Required<Config>).vmTimeoutMs
    this.configSources = (config as Required<Config>).sources
    ctx.effect(() => {
      void this.loadStore()
      void this.refreshAllSources()
      return () => { void this.unmountAll() }
    }, 'plugin-market: store and sources lifecycle')
  }

  /**
   * The catalog: every built-in plugin, every store plugin, and every plugin
   * fetched from a configured git source, each with its install/mount state.
   * @returns the merged catalog snapshot.
   */
  @Remote('catalog')
  catalog(): MarketCatalogSnapshot {
    const entries: MarketCatalogEntry[] = []
    for (const definition of BUILTIN_CATALOG) {
      entries.push(this.catalogEntry(definition, 'builtin', this.storeDefinitions.get(definition.id)))
    }
    for (const [id, definition] of this.storeDefinitions) {
      if (BUILTIN_CATALOG.some(catalogued => catalogued.id === id)) continue
      // A store-only plugin is installed by presence: its manifest IS the store.
      entries.push(this.catalogEntry(definition, 'store', definition))
    }
    for (const [id, message] of this.storeScanErrors) {
      if (this.storeDefinitions.has(id) || this.remoteDefinitions.has(id)) continue
      entries.push({
        id,
        name: id,
        purpose: '',
        source: 'store',
        installed: true,
        status: 'failed',
        error: message,
      })
    }
    for (const [id, definition] of this.remoteDefinitions) {
      if (this.storeDefinitions.has(id)) continue
      entries.push(this.catalogEntry(definition, 'remote', this.storeDefinitions.get(id)))
    }
    return { entries }
  }

  /**
   * The installed store: every plugin with a persisted manifest plus its live
   * mount state, in directory order.
   * @returns the installed snapshot.
   */
  @Remote('installed')
  installed(): MarketInstalledSnapshot {
    const entries: MarketInstalledEntry[] = [...this.storeDefinitions.values()].map((definition) => {
      const state = this.mountState(definition.id)
      return {
        id: definition.id,
        name: definition.name,
        purpose: definition.purpose,
        hasHost: definition.host !== undefined,
        hasClient: definition.client !== undefined,
        ...state.status === undefined ? {} : { status: state.status },
        ...state.runId === undefined ? {} : { runId: state.runId },
        ...state.error === undefined ? {} : { error: state.error },
      }
    })
    for (const [id, message] of this.storeScanErrors) {
      if (this.storeDefinitions.has(id)) continue
      entries.push({ id, name: id, purpose: '', hasHost: false, hasClient: false, status: 'failed', error: message })
    }
    return { entries }
  }

  /**
   * Install one catalog plugin (built-in or from a configured source) into the
   * persistent store and mount it.
   * @param id - catalog plugin identity.
   * @returns success, or the reason the install could not complete.
   */
  @Remote('installPlugin')
  async installPlugin(id: MarketPluginId): Promise<MarketInstallResult> {
    const definition = BUILTIN_CATALOG.find(candidate => candidate.id === id)
      ?? this.remoteDefinitions.get(id)
    if (definition === undefined) {
      return { ok: false, message: `"${id}" is not in the built-in catalog or any configured source` }
    }
    if (this.runs.has(id) || this.storeDefinitions.has(id) || existsSync(join(this.root, id))) {
      return { ok: false, message: `plugin "${id}" is already installed` }
    }
    this.persist(definition)
    this.storeDefinitions.set(id, definition)
    this.emitChange(id, 'installed')
    try {
      await this.mount(definition)
      const run = this.runs.get(id)
      return { ok: true, ...run === undefined ? {} : { runId: run.runId } }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  /**
   * Uninstall one installed plugin: unmount its Host half and delete its store directory.
   * @param id - installed plugin identity.
   * @returns success, or the reason the uninstall could not complete.
   */
  @Remote('uninstall')
  async uninstall(id: MarketPluginId): Promise<MarketUninstallResult> {
    const run = this.runs.get(id)
    if (run !== undefined) await this.retract(id, run)
    rmSync(join(this.root, id), { recursive: true, force: true })
    this.storeDefinitions.delete(id)
    this.mountErrors.delete(id)
    this.storeScanErrors.delete(id)
    this.emitChange(id, 'uninstalled')
    return { ok: true }
  }

  /**
   * Fetch the Client-half source for one mounted activation, for the browser
   * to evaluate and mount on this page.
   * @param id - installed plugin identity.
   * @param runId - exact Host-half activation identity.
   * @returns the Client source.
   * @throws when the activation or Client half does not exist.
   */
  @Remote('getClientCode')
  getClientCode(id: MarketPluginId, runId: MarketRunId): MarketClientSource {
    const run = this.runs.get(id)
    if (run === undefined || run.runId !== runId) {
      throw new Error(`plugin "${id}" is not running activation "${runId}"`)
    }
    const definition = this.findDefinition(id)
    if (definition?.client === undefined) {
      throw new Error(`plugin "${id}" has no Client half`)
    }
    return { pluginId: id, runId, name: definition.name, code: definition.client }
  }

  /**
   * Route one `host.call` to a mounted plugin's Host half.
   * @param id - installed plugin identity.
   * @param runId - exact activation identity authorizing the call.
   * @param method - registered handler name.
   * @param args - JSON argument delivered to the handler.
   * @returns the JSON result or a typed invocation failure.
   */
  @Remote('invoke')
  async invoke(
    id: MarketPluginId, runId: MarketRunId, method: string, args: JsonValue,
  ): Promise<MarketInvokeResult> {
    const run = this.runs.get(id)
    if (run === undefined) {
      return { ok: false, code: 'plugin-not-running', message: `plugin "${id}" is not running` }
    }
    if (run.runId !== runId) {
      return { ok: false, code: 'stale-run', message: `activation "${runId}" is no longer active` }
    }
    const handler = run.handlers.get(method)
    if (handler === undefined) {
      return { ok: false, code: 'method-not-found', message: `plugin "${id}" registered no Host method "${method}"` }
    }
    try {
      return { ok: true, value: await handler(args) as JsonValue }
    } catch (error) {
      return { ok: false, code: 'handler-error', message: errorMessage(error) }
    }
  }

  /**
   * The configured git sources with their last fetch state.
   * @returns one status row per effective source, in order.
   */
  @Remote('sources')
  sources(): MarketSourcesSnapshot {
    return {
      sources: readEffectiveSources(this.root, this.configSources)
        .map(url => this.sourceStatus.get(url) ?? { url, ok: false, message: 'not fetched yet', pluginCount: 0 }),
    }
  }

  /**
   * Add one git source URL, persist it, and fetch it immediately.
   * @param url - the git repository URL.
   * @returns success, or the reason the source could not be added.
   */
  @Remote('addSource')
  async addSource(url: string): Promise<MarketSourceUpdateResult> {
    const trimmed = url.trim()
    if (trimmed.length === 0) return { ok: false, message: 'a source URL is required' }
    const existing = readEffectiveSources(this.root, this.configSources)
    if (existing.includes(trimmed)) return { ok: false, message: `source "${trimmed}" is already configured` }
    persistSources(this.root, [...readPersistedSources(this.root), trimmed])
    this.emitSourcesChange()
    await this.refreshSource(trimmed)
    const status = this.sourceStatus.get(trimmed)
    return {
      ok: status?.ok ?? false,
      ...status === undefined || status.message === undefined ? {} : { message: status.message },
    }
  }

  /**
   * Remove one git source URL: drop it from the persisted list and its cache,
   * and retract its catalog entries.
   * @param url - the git repository URL.
   * @returns success, or the reason the source could not be removed.
   */
  @Remote('removeSource')
  removeSource(url: string): MarketSourceUpdateResult {
    const persisted = readPersistedSources(this.root)
    if (!persisted.includes(url)) {
      return { ok: false, message: `source "${url}" is not user-configured (deployment defaults cannot be removed)` }
    }
    persistSources(this.root, persisted.filter(candidate => candidate !== url))
    this.sourceStatus.delete(url)
    for (const [id, sourceUrl] of this.remoteSources) {
      if (sourceUrl !== url) continue
      this.remoteDefinitions.delete(id)
      this.remoteSources.delete(id)
      if (!this.storeDefinitions.has(id)) this.mountErrors.delete(id)
    }
    this.emitSourcesChange()
    return { ok: true }
  }

  /**
   * Re-fetch every configured git source and update the catalog.
   * @returns the refreshed source snapshot.
   */
  @Remote('refreshSources')
  async refreshSources(): Promise<MarketSourcesSnapshot> {
    await this.refreshAllSources()
    return this.sources()
  }

  private catalogEntry(
    definition: MarketPluginDefinition,
    source: 'builtin' | 'store' | 'remote',
    installedDefinition?: MarketPluginDefinition,
  ): MarketCatalogEntry {
    const state = installedDefinition === undefined ? undefined : this.mountState(installedDefinition.id)
    return {
      id: definition.id,
      name: definition.name,
      purpose: definition.purpose,
      source,
      installed: state !== undefined,
      ...state?.status === undefined ? {} : { status: state.status },
      ...state?.runId === undefined ? {} : { runId: state.runId },
      ...state?.error === undefined ? {} : { error: state.error },
    }
  }

  private mountState(id: MarketPluginId): {
    status?: MarketPluginStatus
    runId?: MarketRunId
    error?: string
  } {
    const run = this.runs.get(id)
    if (run !== undefined) return { status: 'mounted', runId: run.runId }
    const error = this.mountErrors.get(id)
    if (error !== undefined) return { status: 'failed', error }
    return {}
  }

  /** Load the store: scan and compile every plugin folder, then mount Host halves. */
  private async loadStore(): Promise<void> {
    mkdirSync(this.root, { recursive: true })
    let entries: string[]
    try {
      entries = readdirSync(this.root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      return
    }
    for (const name of entries) {
      const id = marketId(name)
      this.storeScanErrors.delete(id)
      try {
        const definition = await scanPluginFolder(join(this.root, name))
        if (definition === undefined) continue
        this.storeDefinitions.set(id, definition)
        this.mount(definition).catch((error: unknown) => {
          this.mountErrors.set(id, errorMessage(error))
          this.emitChange(id, 'failed')
        })
      } catch (error) {
        this.storeScanErrors.set(id, errorMessage(error))
      }
    }
  }

  /** Fetch and scan every configured git source, then notify the client. */
  private async refreshAllSources(): Promise<void> {
    for (const url of readEffectiveSources(this.root, this.configSources)) {
      await this.refreshSource(url)
    }
    this.emitSourcesChange()
  }

  private async refreshSource(url: string): Promise<void> {
    const inFlight = this.refreshing.get(url)
    if (inFlight !== undefined) return inFlight
    const starting = this.fetchAndScanSource(url)
    this.refreshing.set(url, starting)
    try {
      await starting
    } finally {
      this.refreshing.delete(url)
    }
  }

  private async fetchAndScanSource(url: string): Promise<void> {
    const cacheDir = sourceCacheDir(this.root, url)
    try {
      await fetchSource(url, cacheDir)
      const { definitions, errors } = await scanSourceRepo(cacheDir)
      for (const [id, definition] of definitions) {
        this.remoteDefinitions.set(id, definition)
        this.remoteSources.set(id, url)
      }
      for (const [id] of errors) {
        this.remoteDefinitions.delete(id)
        this.remoteSources.delete(id)
      }
      const message = errors.size === 0 ? undefined : [...errors.values()][0]
      this.sourceStatus.set(url, {
        url,
        ok: true,
        pluginCount: definitions.size,
        ...message === undefined ? {} : { message },
      })
    } catch (error) {
      this.sourceStatus.set(url, { url, ok: false, message: errorMessage(error), pluginCount: 0 })
    }
  }

  /** Evaluate and mount one plugin's Host half under the market group. */
  private async mount(definition: MarketPluginDefinition): Promise<void> {
    const inFlight = this.mounting.get(definition.id)
    if (inFlight !== undefined) return inFlight
    const starting = this.startHost(definition)
    this.mounting.set(definition.id, starting)
    try {
      await starting
    } finally {
      this.mounting.delete(definition.id)
    }
  }

  private async startHost(definition: MarketPluginDefinition): Promise<void> {
    const run: MarketRun = {
      pluginId: definition.id,
      runId: runId(`market-${this.nextRun++}`),
      handlers: new Map(),
      handlerDisposers: [],
    }
    if (definition.host !== undefined) {
      const handle = (method: unknown, fn: unknown): (() => void) => {
        const normalized = normalizeHandler(method, fn)
        run.handlers.set(normalized.method, normalized.handler)
        const dispose = (): void => {
          if (run.handlers.get(normalized.method) === normalized.handler) run.handlers.delete(normalized.method)
        }
        run.handlerDisposers.push(dispose)
        return dispose
      }
      const sandbox = createSandbox(definition.id, { handle })
      const evaluated = await evaluateHostCode(sandbox, definition.host, definition.id, this.vmTimeoutMs)
      if (!isPlugin(evaluated)) {
        throw new Error(evaluated === undefined
          ? 'the Host half returned `undefined` — did you forget `return`?'
          : 'the Host half must return a Plugin function or an object with apply(ctx)')
      }
      run.fiber = await startHostHalf(
        this.requireGroup(),
        evaluated,
        (error) => { this.mountErrors.set(definition.id, error.message) },
      )
    }
    this.runs.set(definition.id, run)
    this.mountErrors.delete(definition.id)
    this.emitChange(definition.id, 'mounted')
  }

  private async retract(id: MarketPluginId, run: MarketRun): Promise<void> {
    this.runs.delete(id)
    for (const dispose of run.handlerDisposers.splice(0)) dispose()
    if (run.fiber !== undefined) await run.fiber.dispose()
  }

  private async unmountAll(): Promise<void> {
    for (const [id, run] of [...this.runs]) await this.retract(id, run)
  }

  private requireGroup(): Fiber {
    this.group ??= this.ctx.plugin({ name: 'market-plugins', apply: () => {} })
    return this.group
  }

  private persist(definition: MarketPluginDefinition): void {
    const manifest: StoreManifest = {
      name: definition.name,
      purpose: definition.purpose,
      ...definition.host === undefined ? {} : { host: definition.host },
      ...definition.client === undefined ? {} : { client: definition.client },
    }
    mkdirSync(join(this.root, definition.id), { recursive: true })
    writeFileSync(
      join(this.root, definition.id, STORE_MANIFEST),
      JSON.stringify(manifest, undefined, 2) + '\n',
    )
  }

  private findDefinition(id: MarketPluginId): MarketPluginDefinition | undefined {
    return BUILTIN_CATALOG.find(definition => definition.id === id)
      ?? this.storeDefinitions.get(id)
      ?? this.remoteDefinitions.get(id)
  }

  private emitChange(pluginId: string, action: 'installed' | 'uninstalled' | 'mounted' | 'failed'): void {
    this.ctx.emit('market/installed-change', { pluginId, action })
  }

  private emitSourcesChange(): void {
    this.ctx.emit('market/sources-change')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default PluginMarketGateway
