/** Package-owned invariant companion. @module @deepseek-ai/dsh-host-plugin-market/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-plugin-market'

/** Cordis companion plugin name. */
export const name = 'host-plugin-market-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: every snapshot is projected directly from the plugin
 * store on disk and this service's own mount registry, and the store/mount
 * relationship is asserted by this package's store and lifecycle specs.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
