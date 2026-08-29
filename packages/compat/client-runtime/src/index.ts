/**
 * Host loader entry for the browser runtime exported from `./client`.
 * No host-side behavior: the compat runtime is client-only and registers no
 * services (the new harness owns sessions/workspaces via the api controllers).
 * @module @deepseek-ai/dsh-client-runtime
 */

import type { Context } from '@deepseek-ai/cordis'

/** Host plugin body — no host-side behavior for the runtime plugin. */
export function apply(_ctx: Context): void {}
