import { describe, expect, it } from 'vitest'
import { RpcId, transportError } from '../src/api/rpc.js'
import { serverRequestSchema } from '../src/api/rpc.schema.js'
import { muxFrameSchema } from '../src/api/events.schema.js'
import { apply } from '../src/compat-provider.ts'

describe('dsh-host-apiproxy compat contract', () => {
  it('brands rpc ids through the identity function', () => {
    expect(RpcId('abc')).toBe('abc')
  })

  it('folds transport exceptions into the error branch', () => {
    expect(transportError(new Error('boom'))).toEqual({
      ok: false,
      error: { code: 'internal', message: 'boom', details: {} },
    })
  })

  it('validates server-request frames', () => {
    const result = serverRequestSchema.safeParse({
      type: 'server-request',
      rpcId: 'r-1',
      method: 'session.list',
      payload: {},
    })
    expect(result.success).toBe(true)
  })

  it('rejects frames outside the mux discriminator union', () => {
    const result = muxFrameSchema.safeParse({ rpcId: 'r-1', type: 'not-a-frame', data: {} })
    expect(result.success).toBe(false)
  })

  it('provides a stub apiProxy whose methods throw unavailable', () => {
    const provided: Record<string, unknown> = {}
    const ctx = { provide: (name: string, value: unknown) => { provided[name] = value } } as never
    apply(ctx as never)
    const apiProxy = provided.apiProxy
    expect(apiProxy).toBeDefined()
    const callable = (apiProxy as Record<string, unknown>).sessions as (args: unknown) => unknown
    expect(() => callable({})).toThrow(/unavailable/)
  })
})
