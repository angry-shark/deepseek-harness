/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-workspace-ext`.
 * @module @deepseek-ai/dsh-client-ui-workspace-ext/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-workspace-ext'

/** Cordis companion plugin name. */
export const name = 'client-ui-workspace-ext-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the node half registers stateless HTTP routes over
 * host services and the browser half registers presentational components into
 * two host-declared slots; neither emits cordis events nor owns cross-plugin
 * mutable state that an invariant could observe.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
