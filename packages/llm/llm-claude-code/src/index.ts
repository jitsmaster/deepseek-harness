/**
 * Claude Code-backed `LlmAdapter` plugin. It contributes the `claude-code`
 * provider route to the `ctx.llm` registry and serves each model call with one
 * headless `claude -p` process of the user's own executable under the shared
 * subprocess seam. DSH never stores an Anthropic credential: the run uses the
 * login the user's Claude Code already has.
 *
 * @module @deepseek-ai/dsh-llm-claude-code
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import { clampTimeout, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  CLAUDE_CODE_DEFAULT_CONTEXT_WINDOW,
  CLAUDE_CODE_LLM_DEFAULT_TIMEOUT_MS,
  CLAUDE_CODE_LLM_PROVIDER_ID,
  ClaudeCodeLlmAdapter,
} from './adapter.ts'
import { defaultExecutable } from './executable.ts'
import type { ClaudeModelEntry } from './models.ts'

export {
  CLAUDE_CODE_DEFAULT_CONTEXT_WINDOW,
  CLAUDE_CODE_LLM_DEFAULT_TIMEOUT_MS,
  CLAUDE_CODE_LLM_PROVIDER_ID,
  ClaudeCodeLlmAdapter,
  claudeArgv,
} from './adapter.ts'
export type { ClaudeCodeLlmAdapterOptions } from './adapter.ts'
export { DEFAULT_CLAUDE_EXECUTABLE, defaultExecutable, locateExecutable } from './executable.ts'
export { BUILTIN_MODELS, CLAUDE_EFFORTS } from './models.ts'
export type { ClaudeModelEntry } from './models.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-claude-code'

/** The seams this adapter needs: the LLM registry it joins and the process owner it spawns through. */
export const inject = ['llm', 'subprocess']

/** Plugin config (all optional — `apply` fills the defaults). */
export interface Config {
  /** Path or PATH-resolvable name of the user's own `claude` executable. Defaults to `claude` on PATH, else `~/.local/bin/claude`. */
  executable?: string
  /** Node binary that runs the tool-schema MCP stub. Defaults to the harness's own Node. */
  nodeExecutable?: string
  /** Whole-call deadline in milliseconds. Defaults to 1800000. */
  timeoutMs?: number
  /** Context window assumed for a model id the catalog does not list. Defaults to 200000. */
  defaultContextWindow?: number
  /** Models added to (or overriding entries of) the built-in Claude catalog. */
  models?: ClaudeModelEntry[]
}

export const Config: z<Config> = z.object({
  executable: z.string().min(1),
  nodeExecutable: z.string().min(1),
  timeoutMs: z.number().step(1).min(1),
  defaultContextWindow: z.number().step(1).min(1),
  models: z.array(z.object({
    id: z.string().min(1).required(),
    name: z.string().min(1).required(),
    contextWindow: z.number().step(1).min(1),
    description: z.string().min(1),
  })),
})

/** Register the Claude Code adapter's provider route with `ctx.llm`. */
export function apply(ctx: Context, config: Config): void {
  const adapter = new ClaudeCodeLlmAdapter({
    executable: config.executable ?? defaultExecutable(),
    ...config.nodeExecutable === undefined ? {} : { nodeExecutable: config.nodeExecutable },
    timeoutMs: clampTimeout(config.timeoutMs, CLAUDE_CODE_LLM_DEFAULT_TIMEOUT_MS, MAX_TIMER_DELAY_MS),
    defaultContextWindow: config.defaultContextWindow ?? CLAUDE_CODE_DEFAULT_CONTEXT_WINDOW,
    models: config.models ?? [],
    spawn: spec => ctx.subprocess.spawn(spec),
  })
  ctx.llm.registerAdapter([CLAUDE_CODE_LLM_PROVIDER_ID], adapter)
}
