/**
 * Pure rules of the Claude accounts card: how an email is checked, which account
 * has used the least of its plan, and how usage and times read. No state, no
 * Remote, no React. The email rules mirror `normalizeEmail` and
 * `isPlausibleEmail` of the Claude Code LLM plugin, restated here because a
 * client package must not import Host code.
 */

import type { ClaudeAccountUsageView, ClaudeAccountView } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * The canonical form of an email, as the plugin compares and stores it.
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
 * How much of its plan an account has used: the larger of its session and weekly windows.
 * @param usage - the account's latest reading.
 * @returns the fraction 0 to 1, or `undefined` when the reading carries neither window.
 */
export function peakUtilization(usage: ClaudeAccountUsageView | undefined): number | undefined {
  if (usage === undefined) return undefined
  const windows = [usage.fiveHour, usage.sevenDay].filter(window => window !== undefined)
  return windows.length === 0 ? undefined : Math.max(...windows.map(window => window.utilization))
}

/**
 * The signed-in account that has used the least of its plan. Accounts are ranked by the larger of their
 * two windows, then by the weekly window. An account without a reading cannot be compared, so no account
 * is named unless at least two signed-in accounts have one.
 * @param accounts - the accounts as the Host lists them.
 * @returns the email of the least-used account, or `undefined` when there is nothing to compare.
 */
export function leastUsedEmail(accounts: readonly ClaudeAccountView[]): string | undefined {
  const ranked = accounts
    .filter(account => account.signedIn)
    .flatMap((account) => {
      const peak = peakUtilization(account.usage)
      return peak === undefined ? [] : [{ email: account.email, peak, weekly: account.usage?.sevenDay?.utilization ?? 0 }]
    })
  if (ranked.length < 2) return undefined
  ranked.sort((a, b) => a.peak - b.peak || a.weekly - b.weekly)
  return ranked[0]?.email
}

/**
 * A utilization fraction as a whole percent.
 * @param utilization - 0 to 1.
 * @returns for example `42%`, clamped to 0 to 100.
 */
export function formatPercent(utilization: number): string {
  return `${String(Math.min(100, Math.max(0, Math.round(utilization * 100))))}%`
}

/** A span of time as a quantity and unit the copy can phrase. */
export interface Span {
  readonly unit: 'seconds' | 'minutes' | 'hours' | 'days'
  readonly count: number
}

/**
 * Round a span of milliseconds to its largest whole unit.
 * @param ms - a non-negative duration.
 * @returns for example `{ unit: 'hours', count: 2 }`.
 */
export function spanOf(ms: number): Span {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return { unit: 'seconds', count: seconds }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return { unit: 'minutes', count: minutes }
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? { unit: 'hours', count: hours } : { unit: 'days', count: Math.floor(hours / 24) }
}
