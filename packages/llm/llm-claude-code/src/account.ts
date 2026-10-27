/**
 * The pure half of the Claude account sign-in: the record DSH keeps about the
 * accounts Claude Code itself owns, the environment that points a headless child
 * at the active one, and the parsers for what `claude auth login` and
 * `claude auth status` print. No tokens are ever read or stored here: they stay
 * in each account's config directory, and Claude Code refreshes them itself.
 * @module @deepseek-ai/dsh-llm-claude-code/account
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { CredentialEnv } from './credential.ts'

/** The credential record the sign-in flow writes (scope = this plugin, id = the accounts list). */
export const ACCOUNT_KEY: CredentialKey = credentialKey('llm-claude-code', 'claude-account')

/** `type` of the grant payload that lists the signed-in Claude Code accounts. */
export const ACCOUNTS_PAYLOAD_TYPE = 'claude-code-accounts'

/** Environment variable that points Claude Code at a config directory (credentials and global config). */
export const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR'

/** File `claude auth login` leaves its OAuth credentials in, where the platform has no keychain. */
export const CREDENTIALS_FILE = '.credentials.json'

/** Longest readable part of an account directory name. */
const SLUG_CHARS = 64

/** What an account id looks like; a stored id that does not match is never joined onto a path. */
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/u

/**
 * Whether a string is a safe account id.
 * @param id - a candidate from a stored record or a caller.
 * @returns whether it can be joined onto the accounts root.
 */
export function isAccountId(id: string): boolean {
  return SAFE_ID.test(id)
}

/** One signed-in account as the record lists it; carries no secret. */
export interface AccountEntry {
  /** Directory name under the accounts root, derived from the email. */
  id: string
  /** Lowercased account email. */
  email: string
  /** ISO timestamp of the sign-in. */
  signedInAt: string
}

/** The fields of `claude auth status --json` DSH reads. */
export interface AuthStatus {
  loggedIn: boolean
  authMethod?: string
  email?: string
  plan?: string
  organization?: string
}

/**
 * The default accounts root under a DSH home.
 * @param dshHome - the resolved DSH home.
 * @returns `<home>/claude-code/accounts`.
 */
export function defaultAccountsDir(dshHome: string): string {
  return join(dshHome, 'claude-code', 'accounts')
}

/**
 * The canonical form of an email, as compared and stored.
 * @param email - an address as typed.
 * @returns it trimmed and lowercased.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Whether a string can be an email address for a sign-in (one `@`, a dotted domain, no spaces, no leading dash).
 * @param email - a candidate, as typed.
 * @returns whether it is acceptable.
 */
export function isPlausibleEmail(email: string): boolean {
  return /^[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+$/u.test(email.trim())
}

/**
 * The directory name of an account: a readable slug of the lowercased email,
 * plus a short hash of the email whenever the slug is lossy (it always is for a
 * real address), so two addresses never share a directory. Only `a-z 0-9 . _ -`
 * survive, so the name can never hold a separator or climb out of the root.
 * @param email - the account email, in any case.
 * @returns a stable, filesystem-safe id.
 */
export function accountId(email: string): string {
  const lower = normalizeEmail(email)
  const slug = lower
    .replaceAll('@', '-at-')
    .replaceAll(/[^a-z0-9._-]+/gu, '-')
    .replaceAll(/-{2,}/gu, '-')
    .replaceAll(/^[-.]+|[-.]+$/gu, '')
    .slice(0, SLUG_CHARS)
    .replaceAll(/[-.]+$/gu, '')
  const hash = createHash('sha256').update(lower).digest('hex').slice(0, 8)
  return slug === lower && slug.length > 0 ? slug : `${slug.length > 0 ? `${slug}-` : ''}${hash}`
}

/**
 * The config directory of one account.
 * @param accountsDir - the accounts root.
 * @param id - an {@link accountId}.
 * @returns `<accountsDir>/<id>`.
 */
export function accountDir(accountsDir: string, id: string): string {
  return join(accountsDir, id)
}

/** Replace the terminators of an OSC 8 hyperlink so a URL inside one reads as a plain word. */
function flattenEscapes(text: string): string {
  return text.replaceAll('\u001b', ' ').replaceAll('\u0007', ' ').replaceAll('\u009c', ' ')
}

/**
 * Find the sign-in page in what `claude auth login` printed. The URL appears
 * twice, inside the escape sequences of a terminal hyperlink (OSC 8) and again
 * as its visible text, so the first complete occurrence is taken. A URL still
 * being printed (no terminator after it yet) is not returned.
 * @param output - everything the child printed so far, escape sequences included.
 * @returns the https authorize URL, or `undefined` while none is complete.
 */
export function extractAuthorizeUrl(output: string): string | undefined {
  for (const match of flattenEscapes(output).matchAll(/https:\/\/\S+(?=\s)/gu)) {
    try {
      const url = new URL(match[0])
      if (url.protocol === 'https:' && url.pathname.endsWith('/oauth/authorize')) return url.href
    } catch {
      // Not a URL: keep looking.
    }
  }
  return undefined
}

/** Remove terminal escape sequences (CSI, OSC) so a message reads as plain text. */
export function stripEscapes(text: string): string {
  return text
    .replaceAll(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu, '')
    .replaceAll(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read the account facts from `claude auth status --json`.
 * @param output - the child's stdout; JSON possibly surrounded by other text.
 * @returns the facts, or `undefined` when no JSON object with a boolean `loggedIn` is present.
 */
export function parseAuthStatus(output: string): AuthStatus | undefined {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(output.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const fields = parsed as Record<string, unknown>
  if (typeof fields.loggedIn !== 'boolean') return undefined
  const authMethod = text(fields.authMethod)
  const email = text(fields.email)
  const plan = text(fields.subscriptionType)
  const organization = text(fields.orgName)
  return {
    loggedIn: fields.loggedIn,
    ...authMethod === undefined ? {} : { authMethod },
    ...email === undefined ? {} : { email },
    ...plan === undefined ? {} : { plan },
    ...organization === undefined ? {} : { organization },
  }
}

/**
 * Read the signed-in accounts out of the stored record.
 * @param record - the record read from the credentials service, if any.
 * @returns the well-formed entries; none for an absent record or another shape.
 */
export function parseAccounts(record: CredentialRecord | undefined): AccountEntry[] {
  const payload = record?.kind === 'grant' ? record.payload : undefined
  if (typeof payload !== 'object' || payload === null) return []
  const { type, accounts } = payload as Record<string, unknown>
  if (type !== ACCOUNTS_PAYLOAD_TYPE || !Array.isArray(accounts)) return []
  const entries: AccountEntry[] = []
  for (const item of accounts as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const { id, email, signedInAt } = item as Record<string, unknown>
    if (typeof id === 'string' && isAccountId(id) && typeof email === 'string' && email.length > 0 && typeof signedInAt === 'string') {
      entries.push({ id, email, signedInAt })
    }
  }
  return entries
}

/**
 * Put one account into the list, replacing an earlier sign-in of the same account.
 * @param entries - the accounts already signed in.
 * @param entry - the account that just signed in.
 * @returns the merged list, in first-signed-in order.
 */
export function mergeAccount(entries: readonly AccountEntry[], entry: AccountEntry): AccountEntry[] {
  const index = entries.findIndex(existing => existing.id === entry.id)
  return index < 0 ? [...entries, entry] : entries.map((existing, position) => position === index ? entry : existing)
}

/**
 * Build the grant record that lists every signed-in account.
 * @param entries - the accounts to list.
 * @returns a record holding no secret.
 */
export function accountsRecord(entries: readonly AccountEntry[]): CredentialRecord {
  return { kind: 'grant', payload: { type: ACCOUNTS_PAYLOAD_TYPE, accounts: entries.map(entry => ({ ...entry })) } }
}

/**
 * Find an account in the stored list by email.
 * @param record - the record read from the credentials service, if any.
 * @param email - the email to look for, in any case.
 * @returns the entry, or `undefined` when that account has not signed in.
 */
export function findAccount(record: CredentialRecord | undefined, email: string): AccountEntry | undefined {
  const wanted = normalizeEmail(email)
  return parseAccounts(record).find(candidate => normalizeEmail(candidate.email) === wanted)
}

function fallback(warning: string): CredentialEnv {
  return { env: {}, warning }
}

/**
 * Map the stored account list and the active email to child environment values.
 * @param record - the record read from the credentials service, if any.
 * @param accountsDir - the accounts root.
 * @param active - the configured active account email, if any.
 * @param hasCredentials - whether the active account's directory holds the file `claude auth login` writes.
 * @returns `CLAUDE_CONFIG_DIR` for a usable active account; an empty env otherwise, with a secret-free reason unless no account is active.
 */
export function accountEnv(
  record: CredentialRecord | undefined,
  accountsDir: string,
  active: string | undefined,
  hasCredentials: boolean,
): CredentialEnv {
  if (active === undefined || active.trim().length === 0) return { env: {} }
  const email = normalizeEmail(active)
  const entry = findAccount(record, email)
  if (entry === undefined) return fallback(`active account ${email} has not signed in; sign in from the Claude account flow`)
  if (!hasCredentials) return fallback(`active account ${email} has no Claude Code credentials in its directory; sign in again`)
  return { env: { [CONFIG_DIR_ENV]: accountDir(accountsDir, entry.id) } }
}
