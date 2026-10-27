/**
 * Maps one stored DSH credential record to the environment that authenticates
 * a headless Claude Code child. Only the access token of an OAuth grant is
 * shared, never its refresh token: a refresh by Claude Code would rotate the
 * token and invalidate DSH's stored copy.
 * @module @deepseek-ai/dsh-llm-claude-code/credential
 */

import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'

/** Environment variable Claude Code reads an OAuth access token from. */
export const OAUTH_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN'

/** Environment variable Claude Code reads an API key from. */
export const API_KEY_ENV = 'ANTHROPIC_API_KEY'

/** A grant must stay valid at least this long (milliseconds) to be handed to a child. */
export const GRANT_EXPIRY_MARGIN_MS = 60_000

/** The outcome of mapping one record. */
export interface CredentialEnv {
  /** Extra child environment; empty when Claude Code should use its own login. */
  env: Record<string, string>
  /** Why the record was not usable, never containing a secret; absent on success. */
  warning?: string
}

function fallback(warning: string): CredentialEnv {
  return { env: {}, warning }
}

/**
 * Map a stored record to child environment values.
 * @param record - the record read from the credentials service, if any.
 * @param now - the current time in epoch milliseconds.
 * @returns the env to add, or an empty env with a secret-free reason to fall back.
 */
export function credentialEnv(record: CredentialRecord | undefined, now: number): CredentialEnv {
  if (record === undefined) return fallback('no stored credential record; falling back to Claude Code\'s own login')
  if (record.kind === 'api-key') {
    if (typeof record.key === 'string' && record.key.length > 0) return { env: { [API_KEY_ENV]: record.key } }
    return fallback('stored api-key record has no key; falling back to Claude Code\'s own login')
  }
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null) {
    return fallback('stored grant is not an OAuth credential; falling back to Claude Code\'s own login')
  }
  const { type, access, expires } = payload as Record<string, unknown>
  if (type !== 'oauth' || typeof access !== 'string' || access.length === 0 || typeof expires !== 'number' || !Number.isFinite(expires)) {
    return fallback('stored grant is not an OAuth credential; falling back to Claude Code\'s own login')
  }
  if (expires - now <= GRANT_EXPIRY_MARGIN_MS) {
    return fallback('stored grant expired; pi-ai route must refresh it, falling back to Claude Code\'s own login')
  }
  return { env: { [OAUTH_TOKEN_ENV]: access } }
}
