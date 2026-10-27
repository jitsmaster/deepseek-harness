/**
 * Claude Code-backed `WebSearchProvider` plugin. It contributes to the
 * `ctx.web` registry without owning the service, and runs each search as one
 * headless `claude -p` process under the shared subprocess seam.
 *
 * @module @deepseek-ai/dsh-web-search-claude-code
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subprocess'
import { clampTimeout, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-web'
import { defaultExecutable } from './executable.ts'
import { CLAUDE_CODE_SEARCH_DEFAULT_TIMEOUT_MS, ClaudeCodeSearchProvider } from './provider.ts'

export {
  CLAUDE_CODE_PROVIDER_ID,
  CLAUDE_CODE_SEARCH_DEFAULT_TIMEOUT_MS,
  ClaudeCodeSearchProvider,
} from './provider.ts'
export type { ClaudeCodeSearchProviderOptions } from './provider.ts'
export { DEFAULT_CLAUDE_EXECUTABLE, defaultExecutable, locateExecutable } from './executable.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-claude-code'

/** The seams this provider needs: the web registry it joins and the process owner it spawns through. */
export const inject = ['web', 'subprocess']

/** Plugin config (all optional — `apply` fills the defaults). */
export interface Config {
  /** Path or PATH-resolvable name of the user's own `claude` executable. Defaults to `claude` on PATH, else `~/.local/bin/claude`. */
  executable?: string
  /** Model passed as `--model`. Omitted = the Claude Code default. */
  model?: string
  /** Whole-run deadline in milliseconds. Defaults to 120000. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  executable: z.string().min(1),
  model: z.string().min(1),
  timeoutMs: z.number().step(1).min(1),
})

/** Register the Claude Code search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new ClaudeCodeSearchProvider({
    executable: config.executable ?? defaultExecutable(),
    ...config.model !== undefined ? { model: config.model } : {},
    timeoutMs: clampTimeout(config.timeoutMs, CLAUDE_CODE_SEARCH_DEFAULT_TIMEOUT_MS, MAX_TIMER_DELAY_MS),
    spawn: spec => ctx.subprocess.spawn(spec),
  }))
}
