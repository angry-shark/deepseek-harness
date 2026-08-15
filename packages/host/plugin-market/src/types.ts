import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** One installed plugin's store or mount state changed. */
    'market/installed-change'(payload: {
      pluginId: string
      action: 'installed' | 'uninstalled' | 'mounted' | 'failed'
    }): void
    /** The configured git sources changed or were refreshed. */
    'market/sources-change'(): void
  }
}

/** Stable identity of one market plugin; also its store directory name. */
export type MarketPluginId = Branded<'MarketPluginId'>

/** Exact identity of one Host-half activation in this process. */
export type MarketRunId = Branded<'MarketRunId'>

/** Where a market plugin definition comes from. */
export type MarketPluginSource = 'builtin' | 'store' | 'remote'

/** One configured git source's fetch state. */
export interface MarketSourceStatus {
  /** The git repository URL. */
  readonly url: string
  /** Whether the last fetch succeeded. */
  readonly ok: boolean
  /** Fetch failure message when `ok` is false. */
  readonly message?: string
  /** How many plugins the last successful fetch found. */
  readonly pluginCount: number
}

/** Point-in-time snapshot of every configured source. */
export interface MarketSourcesSnapshot {
  readonly sources: readonly MarketSourceStatus[]
}

/** Outcome of adding or removing a source. */
export interface MarketSourceUpdateResult {
  readonly ok: boolean
  /** Failure message when the update could not complete. */
  readonly message?: string
}

/** Live mount state of one installed plugin's Host half. */
export type MarketPluginStatus = 'mounted' | 'failed'

/** A plugin the market offers or has installed. */
export interface MarketPluginDefinition {
  /** Stable identity; the store directory name once installed. */
  readonly id: MarketPluginId
  /** Display label. */
  readonly name: string
  /** One-line user-facing purpose. */
  readonly purpose: string
  /** Host-half source: an async function body returning a plugin. */
  readonly host?: string
  /** Client-half source: an async function body returning a plugin. */
  readonly client?: string
}

/** One catalog row: the definition plus its install and mount state. */
export interface MarketCatalogEntry extends MarketPluginDefinition {
  /** Whether the definition ships with the product or lives in the user store. */
  readonly source: MarketPluginSource
  /** Whether the plugin is installed in the persistent store. */
  readonly installed: boolean
  /** Host-half mount state when installed; absent when not installed. */
  readonly status?: MarketPluginStatus
  /** Exact Host-half activation identity when mounted. */
  readonly runId?: MarketRunId
  /** Mount failure message when the Host half failed to activate. */
  readonly error?: string
}

/** Point-in-time catalog returned by the plugin market Remote. */
export interface MarketCatalogSnapshot {
  readonly entries: readonly MarketCatalogEntry[]
}

/** One installed plugin's live state, as the browser loads Client halves from it. */
export interface MarketInstalledEntry {
  readonly id: MarketPluginId
  readonly name: string
  readonly purpose: string
  readonly hasHost: boolean
  readonly hasClient: boolean
  /** Host-half mount state; absent while activation is still in flight. */
  readonly status?: MarketPluginStatus
  readonly runId?: MarketRunId
  readonly error?: string
}

/** Point-in-time installed-store snapshot returned by the plugin market Remote. */
export interface MarketInstalledSnapshot {
  readonly entries: readonly MarketInstalledEntry[]
}

/** Outcome of one install gesture. */
export interface MarketInstallResult {
  readonly ok: boolean
  /** Failure message when the install could not complete. */
  readonly message?: string
  /** Exact Host-half activation identity when the Host half mounted. */
  readonly runId?: MarketRunId
}

/** Outcome of one uninstall gesture. */
export interface MarketUninstallResult {
  readonly ok: boolean
  /** Failure message when the uninstall could not complete. */
  readonly message?: string
}

/** Client-half source for one mounted plugin activation. */
export interface MarketClientSource {
  readonly pluginId: MarketPluginId
  readonly runId: MarketRunId
  readonly name: string
  readonly code: string
}

/** One `host.call` invocation routed to a mounted Host half. */
export interface MarketInvokeResult {
  readonly ok: boolean
  readonly code?: 'plugin-not-running' | 'stale-run' | 'method-not-found' | 'handler-error'
  readonly message?: string
  readonly value?: JsonValue
}
