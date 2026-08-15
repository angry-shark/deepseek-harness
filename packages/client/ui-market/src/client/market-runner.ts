/**
 * Page-side loader for installed market plugins' Client halves. Collaborates
 * with the dynamic-package runner through its `dynamicCordisRunner` service
 * face (the sanctioned service route — no cross-plugin value imports): each
 * mounted Client half evaluates in its closure, seats a factory in the module
 * table, and mounts as a loader entry whose fiber effects own cleanup. The
 * market has no owning session — install is its own consent — so the
 * standalone verbs carry no orchestration and the host ignores render/guard
 * reports for halves no session owns.
 */

import type {
  CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId, DynamicCordisClientHalf,
} from '@deepseek-ai/dsh-cordis-client-runner/client'
import type { CordisRunnerFace } from '@deepseek-ai/dsh-cordis-client-runner/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  MarketInstalledEntry, MarketPluginId, MarketRunId, SessionId,
} from '@deepseek-ai/dsh-api-remotes/client'

/** Loads installed Client halves and keeps this page converged with the store. */
export class MarketClientRunner {
  private readonly runner: CordisRunnerFace
  private readonly live = new Map<MarketPluginId, MarketRunId>()

  /**
   * @param ctx - client root context carrying the dynamic-package runner service
   * and the pluginMarket Remote.
   */
  constructor(private readonly ctx: ClientContext) {
    const runner: CordisRunnerFace | undefined = ctx.get('dynamicCordisRunner')
    if (runner === undefined) {
      throw new Error('ui-market: the dynamic-package runner service is not mounted')
    }
    this.runner = runner
  }

  /**
   * Converge the page with the installed store: load Client halves that are
   * mounted (or changed run), and retract halves whose plugin was uninstalled
   * or replaced.
   * @param entries - the current installed snapshot.
   */
  async sync(entries: readonly MarketInstalledEntry[]): Promise<void> {
    const wanted = new Map<MarketPluginId, MarketRunId>()
    for (const entry of entries) {
      if (entry.hasClient && entry.status === 'mounted' && entry.runId !== undefined) {
        wanted.set(entry.id, entry.runId)
      }
    }
    for (const [pluginId, runId] of wanted) {
      if (this.live.get(pluginId) === runId) continue
      await this.load(pluginId, runId)
    }
    for (const [pluginId, runId] of this.live) {
      if (wanted.get(pluginId) !== runId) this.retract(pluginId, runId)
    }
  }

  /** Unload everything (plugin disposal path). */
  dispose(): void {
    for (const [pluginId, runId] of this.live) this.retract(pluginId, runId)
  }

  private async load(pluginId: MarketPluginId, runId: MarketRunId): Promise<void> {
    const answered = await this.ctx.remote.pluginMarket.getClientCode(pluginId, runId)
    if (!answered.ok) {
      console.error(`[ui-market] fetching the client half of ${pluginId} failed: ${answered.error.code}: ${answered.error.message}`)
      return
    }
    const source = answered.value
    const half: DynamicCordisClientHalf = {
      pluginId: pluginId as unknown as CordisDynamicPluginId,
      // The market has no package versions; the activation identity stands in.
      packageId: runId as unknown as CordisDynamicPackageId,
      pluginRunId: runId as unknown as CordisDynamicPluginRunId,
      agentId: pluginId as unknown as SessionId,
      name: source.name,
      code: source.code,
    }
    const result = await this.runner.loadStandalone(half)
    if (result.ok) {
      this.live.set(pluginId, runId)
    } else {
      console.error(`[ui-market] loading the client half of ${pluginId} failed: ${result.message}`)
    }
  }

  private retract(pluginId: MarketPluginId, runId: MarketRunId): void {
    if (this.live.get(pluginId) !== runId) return
    this.live.delete(pluginId)
    this.runner.retractStandalone(
      pluginId as unknown as CordisDynamicPluginId,
      runId as unknown as CordisDynamicPluginRunId,
    )
  }
}
