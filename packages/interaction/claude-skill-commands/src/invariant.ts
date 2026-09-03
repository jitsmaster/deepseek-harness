/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-claude-skill-commands`.
 * @module @deepseek-ai/dsh-claude-skill-commands/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-claude-skill-commands'

/** Cordis companion plugin name. */
export const name = 'claude-skill-commands-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package registers ordinary per-agent commands
 * through the existing `@deepseek-ai/dsh-commands` registry and dispatches no
 * scoped events of its own — `dsh-scope` and `dsh-commands` own their own
 * invariants.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
