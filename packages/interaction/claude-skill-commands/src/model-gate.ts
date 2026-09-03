import type { Agent } from '@deepseek-ai/dsh-agent'

/** Minimal shape this module needs from `ctx.agentDefaultModel`. */
export interface DefaultModelSource {
  currentSelection(): { provider: string }
}

/**
 * The provider this agent is currently running on, for gating decisions that
 * must not silently apply Claude-authored behavior to a non-Claude session.
 * @param agent - the agent to read.
 * @param defaultModel - `ctx.agentDefaultModel`, read only when no turn has run yet.
 * @returns the last logged request header's provider, or the deployment
 *   default when this session has never logged one.
 */
export function currentProviderOf(agent: Agent, defaultModel: DefaultModelSource): string {
  const logged = agent.session.requestHeader()
  return logged?.config.provider ?? defaultModel.currentSelection().provider
}
