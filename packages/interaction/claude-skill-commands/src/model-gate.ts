import { resolveCurrentSelection } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: brings the `Context.sessionProjections` registry merge into scope.
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: brings the `modelSelection` key merge (ctx.sessionProjections'
// durable pending-switch state) into scope — see
// @deepseek-ai/dsh-api-session-controller/src/types.ts.
import type {} from '@deepseek-ai/dsh-api-session-controller/types'

/** Minimal shape this module needs from `ctx.agentDefaultModel`. */
export interface DefaultModelSource {
  currentSelection(): { provider: string }
}

/**
 * The provider this agent is currently running on, for gating decisions that
 * must not silently apply Claude-authored behavior to a non-Claude session.
 * A committed `/model` switch (or equivalent) updates the durable
 * `modelSelection` projection's `pending` field immediately, before any
 * subsequent turn logs a matching request header — reading the logged header
 * first would report the pre-switch provider for one extra request, so the
 * pending selection is checked first and wins whenever it is set.
 * @param agent - the agent to read.
 * @param defaultModel - `ctx.agentDefaultModel`, read only when no switch is
 *   pending and no turn has run yet.
 * @returns the pending model-selection's provider when a switch is pending,
 *   else the last logged request header's provider, else the deployment
 *   default when this session has never logged one.
 */
export function currentProviderOf(agent: Agent, defaultModel: DefaultModelSource): string {
  // `ctx.get` reads the service without cordis's inject requirement — this
  // plugin does not declare `sessionProjections` as a hard dependency, so a
  // direct `agent.ctx.sessionProjections` read would throw when the registry
  // is not in this agent's inject chain.
  const sessionProjections = agent.ctx.get('sessionProjections')
  const pending = sessionProjections?.stateOf(agent.session, 'modelSelection')?.pending ?? undefined
  // Shared with `session-controller`'s `ApiSessionAgentController.selectionFor()`
  // so the "pending wins, else logged, else default" precedence cannot drift
  // between the two independent readers of the same durable projection.
  const selection = resolveCurrentSelection<{ provider: string }>(
    pending,
    () => agent.session.requestHeader()?.config,
    () => defaultModel.currentSelection(),
  )
  return selection.provider
}
