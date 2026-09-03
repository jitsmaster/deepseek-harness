import { describe, expect, it } from 'vitest'
import { currentProviderOf } from '../src/model-gate.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

function agentWithHeader(provider: string | undefined): Agent {
  return {
    session: {
      requestHeader: () => provider === undefined ? undefined : { config: { provider, model: 'x' } },
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
})
