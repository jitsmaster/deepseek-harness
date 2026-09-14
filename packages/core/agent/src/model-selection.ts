/**
 * Agent-scoped model selection shared by runtime entry points.
 * @module @deepseek-ai/dsh-agent/model-selection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** Complete provider, model, and optional reasoning effort selected for one live Agent. */
export interface ModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: ReasoningEffortId
}

/** Mutable model selection plus the value captured for the current step. */
export interface ModelSelectionRef {
  /** Model selected for the next step that enters prompt assembly. */
  current: ModelSelection | undefined
  /** Selection captured when the current step entered prompt assembly. */
  assembled: ModelSelection | undefined
}

/**
 * Resolve which of three prioritized sources currently applies for a live
 * Agent's model selection: an explicit `pending` value (e.g. a `/model`
 * switch already committed to durable state) always wins; else a value
 * observed on the last logged request; else a deployment default. Both are
 * computed lazily, and only as far as needed, so a caller that already has a
 * `pending` value never pays for reading the logged request or the default.
 *
 * Centralizing this precedence rule keeps `session-controller`'s
 * `ApiSessionAgentController.selectionFor()` and
 * `claude-skill-commands`'s `currentProviderOf()` from drifting apart —
 * both read the same "pending wins, else logged, else default" rule off a
 * durable `modelSelection` projection, one to install a full
 * {@link ModelSelection} and the other to report just its `provider`.
 * @param pending - explicit pending value, when a switch is already decided.
 * @param computeLogged - lazily produces the value observed on the last
 *   logged request, or `undefined` when none has logged yet. Not called when
 *   `pending` is already set.
 * @param computeFallback - lazily produces the deployment default. Not
 *   called when `pending` or `computeLogged()` already supplies a value.
 * @returns the resolved value.
 */
export function resolveCurrentSelection<T>(
  pending: T | undefined,
  computeLogged: () => T | undefined,
  computeFallback: () => T,
): T {
  if (pending !== undefined) return pending
  return computeLogged() ?? computeFallback()
}

/**
 * Couple one mutable selection to Agent-scoped prompt assembly and request routing.
 * Prompt assembly snapshots the selected model before delegating, then applies
 * its provider/model pair and effort to request config so a
 * concurrent switch takes effect on a later step instead of splitting the two
 * surfaces. An absent selected effort clears any inherited effort, restoring
 * the selected model's provider/default behavior.
 *
 * @param agentCtx - The selected Agent's scoped context.
 * @param selection - Mutable selection owned by the calling entry point.
 * @returns Disposer for both scoped waterfall listeners.
 */
export function installModelSelection(agentCtx: Context, selection: ModelSelectionRef): () => void {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  const disposeRequest = agentCtx.on(
    'agent/request',
    async (_payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      const selected = selection.assembled
      if (selected === undefined) return resolved
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
      return {
        ...withoutInheritedEffort,
        provider: selected.provider,
        model: selected.model,
        ...selected.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selected.reasoningEffort },
      }
    },
  )
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}
