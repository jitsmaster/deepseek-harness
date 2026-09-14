import { describe, expect, it } from 'vitest'
import { currentProviderOf } from '../src/model-gate.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

function agentWithHeader(provider: string | undefined): Agent {
  return {
    session: {
      requestHeader: () => provider === undefined ? undefined : { config: { provider, model: 'x' } },
    },
    ctx: {
      // Mirrors cordis's `ctx.get` soft-read (no inject requirement). No
      // pending modelSelection switch: this models a session where the
      // projection is either unregistered or has never seen a `/model` commit.
      get: (key: string) => key === 'sessionProjections' ? { stateOf: () => undefined } : undefined,
    },
  } as unknown as Agent
}

/**
 * Builds an Agent whose `ctx.get('sessionProjections')?.stateOf(session, 'modelSelection')`
 * reports a durable `pending` model selection, alongside a possibly-stale (or
 * absent) logged request header. Mirrors the real
 * `ModelSelectionProjectionState` shape (`{ lastUsed, pending }`) that
 * `session-controller`'s `selectionFor()` already reads in preference to the
 * logged-header fallback — see `packages/api/session-controller/src/model-selection-projection.ts`
 * and `packages/api/session-controller/src/agent.ts`'s `selectionFor()`.
 * @param loggedProvider - the provider on the last logged request header, or
 *   `undefined` when no turn has produced one yet.
 * @param pendingProvider - the provider of the session's pending model
 *   selection, as it would be reported by `ctx.get('sessionProjections')?.stateOf`.
 */
function agentWithPendingSelection(loggedProvider: string | undefined, pendingProvider: string): Agent {
  return {
    session: {
      requestHeader: () => loggedProvider === undefined ? undefined : { config: { provider: loggedProvider, model: 'x' } },
    },
    ctx: {
      // Mirrors cordis's `ctx.get` soft-read (no inject requirement).
      get: (key: string) => key === 'sessionProjections'
        ? {
          stateOf: (_session: unknown, projectionKey: string) =>
            projectionKey === 'modelSelection'
              ? { lastUsed: null, pending: { provider: pendingProvider, model: 'x' } }
              : undefined,
        }
        : undefined,
    },
  } as unknown as Agent
}

describe('currentProviderOf', () => {
  it('reads the provider from the last logged request header', () => {
    const provider = currentProviderOf(agentWithHeader('anthropic'), { currentSelection: () => ({ provider: 'deepseek-official' }) })
    expect(provider).toBe('anthropic')
  })

  it('falls back to the default model when no header is logged yet', () => {
    const provider = currentProviderOf(agentWithHeader(undefined), { currentSelection: () => ({ provider: 'anthropic' }) })
    expect(provider).toBe('anthropic')
  })

  it('reflects a pending switch TO anthropic immediately, before any request header has logged it', () => {
    // No header logged yet, and the deployment default is some other
    // provider — only the pending `modelSelection` projection says anthropic.
    const agent = agentWithPendingSelection(undefined, 'anthropic')

    const provider = currentProviderOf(agent, { currentSelection: () => ({ provider: 'deepseek-official' }) })

    expect(provider).toBe('anthropic')
  })

  it('reflects a pending switch AWAY FROM anthropic immediately, even though the last logged header still says anthropic', () => {
    // The last logged request header is still anthropic (from before the
    // switch), but the pending `modelSelection` projection has already moved
    // to a different provider — gating must not lag one extra request.
    const agent = agentWithPendingSelection('anthropic', 'deepseek-official')

    const provider = currentProviderOf(agent, { currentSelection: () => ({ provider: 'anthropic' }) })

    expect(provider).toBe('deepseek-official')
  })
})
