/**
 * The `claudeAccounts` service: reads the accounts DSH can run Claude Code as
 * (their sign-in state, usage readings and which one is active) and swaps one
 * account's login into the default Claude Code configuration. It owns no state
 * beyond a queue that runs one swap at a time.
 * @module @deepseek-ai/dsh-llm-claude-code/service
 */

import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { accountDir, accountId, CREDENTIALS_FILE, isPlausibleEmail, normalizeEmail, parseAccounts } from './account.ts'
import type { AccountEntry } from './account.ts'
import { makeDefaultLogin, readDefaultEmail } from './default-login.ts'
import type { DefaultConfigPaths, KnownAccount } from './default-login.ts'
import { readAccountUsage } from './rate-limit.ts'
import type {
  ClaudeAccountInfo, ClaudeAccountsService, ClaudeAccountsStatus, ClaudeAccountUsage, ClaudeAccountWindow, ClaudeMakeDefaultResult,
} from './types.ts'

/** What the service reads from its plugin. */
export interface ClaudeAccountsDeps {
  /** The accounts root. */
  accountsDir: string
  /** The configured emails (live). */
  accounts: () => readonly string[]
  /** The configured active email (live). */
  activeAccount: () => string | undefined
  /** The record of signed-in accounts, if a credentials service is mounted. */
  readRecord: () => Promise<CredentialRecord | undefined>
  /** The default Claude Code configuration to read and swap. */
  defaultPaths: () => DefaultConfigPaths
  /** Called with a secret-free line after a swap. */
  log: (message: string) => void
}

function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

function windowOf(window: ClaudeAccountWindow): ClaudeAccountWindow {
  return { utilization: window.utilization, resetsAt: window.resetsAt }
}

function usageOf(reading: Awaited<ReturnType<typeof readAccountUsage>>): ClaudeAccountUsage | undefined {
  if (reading === undefined) return undefined
  const updatedAt = Date.parse(reading.updatedAt)
  if (!Number.isFinite(updatedAt)) return undefined
  return {
    updatedAt,
    ...reading.fiveHour === undefined ? {} : { fiveHour: windowOf(reading.fiveHour) },
    ...reading.sevenDay === undefined ? {} : { sevenDay: windowOf(reading.sevenDay) },
  }
}

/**
 * Build the service.
 * @param deps - the plugin's live configuration and file locations.
 * @returns the `claudeAccounts` service; neither method rejects.
 */
export function createClaudeAccountsService(deps: ClaudeAccountsDeps): ClaudeAccountsService {
  let tail: Promise<unknown> = Promise.resolve()

  /** The configured emails (valid ones only, deduplicated) followed by signed-in accounts the list does not name. */
  async function listed(): Promise<{ email: string; entry: AccountEntry | undefined }[]> {
    const entries = parseAccounts(await deps.readRecord().catch(() => undefined))
    const byEmail = new Map(entries.map(entry => [normalizeEmail(entry.email), entry]))
    const emails: string[] = []
    for (const raw of [...deps.accounts(), ...entries.map(entry => entry.email)]) {
      const email = normalizeEmail(raw)
      if (isPlausibleEmail(email) && !emails.includes(email)) emails.push(email)
    }
    return emails.map(email => ({ email, entry: byEmail.get(email) }))
  }

  async function signedIn(entry: AccountEntry | undefined): Promise<boolean> {
    return entry !== undefined && exists(join(accountDir(deps.accountsDir, entry.id), CREDENTIALS_FILE))
  }

  async function status(): Promise<ClaudeAccountsStatus> {
    const active = deps.activeAccount()
    const activeEmail = active === undefined || active.trim().length === 0 ? undefined : normalizeEmail(active)
    const accounts: ClaudeAccountInfo[] = await Promise.all((await listed()).map(async ({ email, entry }) => {
      const id = entry?.id ?? accountId(email)
      const hasLogin = await signedIn(entry)
      const usage = hasLogin ? usageOf(await readAccountUsage(deps.accountsDir, id)) : undefined
      const signedInAt = entry === undefined ? Number.NaN : Date.parse(entry.signedInAt)
      return {
        email,
        id,
        signedIn: hasLogin,
        active: email === activeEmail,
        ...hasLogin && Number.isFinite(signedInAt) ? { signedInAt } : {},
        ...usage === undefined ? {} : { usage },
      }
    }))
    const defaultEmail = await readDefaultEmail(deps.defaultPaths()).catch(() => undefined)
    return {
      accounts,
      defaultAccount: defaultEmail === undefined ? {} : { email: defaultEmail },
      ...activeEmail === undefined ? {} : { activeAccount: activeEmail },
    }
  }

  async function swap(raw: string): Promise<ClaudeMakeDefaultResult> {
    const email = normalizeEmail(raw)
    const known: KnownAccount[] = []
    for (const { email: other, entry } of await listed()) {
      if (entry !== undefined && await signedIn(entry)) known.push({ email: other, dir: accountDir(deps.accountsDir, entry.id) })
    }
    const target = known.find(account => account.email === email)
    if (target === undefined) return { ok: false, reason: `${email} has not signed in; sign in first` }
    const outcome = await makeDefaultLogin({ paths: deps.defaultPaths(), target, known })
    if (outcome.ok) deps.log(`${email} is now the default Claude Code login (${outcome.unchanged ? 'it already was' : `backup ${outcome.backupDir}`})`)
    return outcome
  }

  return {
    status: () => status().catch(() => ({ accounts: [], defaultAccount: {} })),
    makeDefault(email) {
      const next = tail.then(() => swap(email)).catch((error: unknown): ClaudeMakeDefaultResult => ({
        ok: false,
        reason: `could not make ${normalizeEmail(email)} the default (${typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unexpected error'})`,
      }))
      tail = next
      return next
    },
  }
}
