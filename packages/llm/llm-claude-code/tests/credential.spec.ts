import { describe, expect, it } from 'vitest'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { credentialEnv } from '../src/credential.ts'

const NOW = 1_000_000
const SECRET = 'sk-ant-oat-fake'
const grant = (payload: unknown): CredentialRecord => ({ kind: 'grant', payload })

describe('credentialEnv', () => {
  it('maps a valid oauth grant to the access token only', () => {
    const result = credentialEnv(grant({ type: 'oauth', access: SECRET, refresh: 'refresh-fake', expires: NOW + 3_600_000 }), NOW)
    expect(result).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET } })
    expect(JSON.stringify(result)).not.toContain('refresh-fake')
  })

  it('requires more than 60 s of remaining life', () => {
    expect(credentialEnv(grant({ type: 'oauth', access: SECRET, expires: NOW + 60_001 }), NOW).env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRET })
    const edge = credentialEnv(grant({ type: 'oauth', access: SECRET, expires: NOW + 60_000 }), NOW)
    expect(edge.env).toEqual({})
    expect(edge.warning).toBe('stored grant expired; pi-ai route must refresh it, falling back to Claude Code\'s own login')
  })

  it('falls back on an expired grant', () => {
    expect(credentialEnv(grant({ type: 'oauth', access: SECRET, expires: NOW - 1 }), NOW).env).toEqual({})
  })

  it('maps an api-key record', () => {
    expect(credentialEnv({ kind: 'api-key', key: SECRET }, NOW)).toEqual({ env: { ANTHROPIC_API_KEY: SECRET } })
  })

  it('falls back on an empty or absent key', () => {
    expect(credentialEnv({ kind: 'api-key', key: '' }, NOW).env).toEqual({})
    expect(credentialEnv({ kind: 'api-key' }, NOW).warning).toBeDefined()
  })

  it.each([
    ['null', null],
    ['string', SECRET],
    ['wrong type', { type: 'api', access: SECRET, expires: NOW + 1e6 }],
    ['empty access', { type: 'oauth', access: '', expires: NOW + 1e6 }],
    ['non-string access', { type: 'oauth', access: 5, expires: NOW + 1e6 }],
    ['string expires', { type: 'oauth', access: SECRET, expires: String(NOW + 1e6) }],
    ['NaN expires', { type: 'oauth', access: SECRET, expires: Number.NaN }],
  ])('falls back on a malformed payload (%s)', (_label, payload) => {
    const result = credentialEnv(grant(payload), NOW)
    expect(result.env).toEqual({})
    expect(result.warning).toBeDefined()
  })

  it('falls back when the record is missing', () => {
    const result = credentialEnv(undefined, NOW)
    expect(result.env).toEqual({})
    expect(result.warning).toBeDefined()
  })

  it('never puts the secret into a warning', () => {
    const cases: (CredentialRecord | undefined)[] = [
      grant({ type: 'oauth', access: SECRET, expires: NOW - 1 }),
      grant({ type: 'oauth', access: SECRET }),
      grant({ type: 'nope', access: SECRET, expires: NOW + 1e6 }),
      { kind: 'api-key', key: '' },
      undefined,
    ]
    for (const record of cases) expect(credentialEnv(record, NOW).warning).not.toContain(SECRET)
  })
})
