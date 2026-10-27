/**
 * State and actions of the Claude accounts card. It joins two Host answers: the
 * plugin's settings entry (which emails are listed, which one is active, and
 * whether the profile is writable) and the `claudeAccounts` status (sign-in
 * state, plan usage, the default Claude Code account). Status is polled while
 * the card is mounted and re-read after every action; settings are re-read
 * after a write and when the document changes elsewhere. Nothing here switches
 * an account on its own: the person always chooses.
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClaudeAccountView } from '@deepseek-ai/dsh-api-remotes/client'
import { isPlausibleEmail, leastUsedEmail, normalizeEmail } from './accounts-model.ts'
import type { ClaudeAccountsLocaleKey } from './locales.ts'
import type { ClaudeAccountsOperations, ClaudeSettingsSnapshot } from './operations.ts'

/** How often status is re-read while the card is mounted. */
export const POLL_INTERVAL_MS = 15_000

/** A line the card shows after an action; kept as copy key plus values so a locale change re-renders it. */
export interface CardNotice {
  readonly kind: 'success' | 'error'
  readonly key: ClaudeAccountsLocaleKey
  readonly values: Readonly<Record<string, string>>
}

/** One row of the card. */
export interface AccountRow extends ClaudeAccountView {
  /** Whether the email is in the settings list, and so can be removed from it. */
  readonly listed: boolean
  /** Whether this signed-in account has the lowest usage of those with a reading. */
  readonly leastUsed: boolean
  /** Whether the default Claude Code config is signed in as this account. */
  readonly isDefault: boolean
}

/** What the card renders from. */
export interface ClaudeAccountsState {
  /** `idle` before the first answer; `unavailable` when the plugin's settings entry is not served (the card hides). */
  readonly status: 'idle' | 'ready' | 'unavailable'
  readonly writable: boolean
  readonly rows: readonly AccountRow[]
  /** The status read failed and no earlier answer is shown. */
  readonly loadFailed: boolean
  /** A write or swap is in flight. */
  readonly busy: boolean
  readonly notice: CardNotice | undefined
  /** Wall-clock time of the latest status read, in epoch milliseconds; relative times are measured from it. */
  readonly now: number
}

const INITIAL: ClaudeAccountsState = {
  status: 'idle', writable: false, rows: [], loadFailed: false, busy: false, notice: undefined, now: 0,
}

/** Owns the card's state. */
export class ClaudeAccountsController {
  /** uSES-safe state source the card subscribes to. */
  readonly store: SnapshotStore<ClaudeAccountsState> = createSnapshotStore<ClaudeAccountsState>({ ...INITIAL })

  private settings: ClaudeSettingsSnapshot | undefined
  private statusView: Awaited<ReturnType<ClaudeAccountsOperations['readStatus']>>
  private running: Promise<void> | undefined
  private again: { settings: boolean } | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  private isClosed(): boolean { return this.disposed }

  /**
   * @param operations - the Host reads and writes.
   * @param clock - the time source, replaceable by a test.
   */
  constructor(private readonly operations: ClaudeAccountsOperations, private readonly clock: () => number = Date.now) {}

  /**
   * Read now, then keep reading status on an interval until the returned function runs.
   * @returns the stop function.
   */
  start(): () => void {
    void this.refresh(true)
    this.timer ??= setInterval(() => { void this.refresh(false) }, POLL_INTERVAL_MS)
    return () => { this.stop() }
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** Stop polling and ignore any answer still in flight. */
  dispose(): void {
    this.disposed = true
    this.stop()
  }

  /**
   * Re-read the Host. A request made while a read is running is folded into one follow-up read.
   * @param withSettings - also re-read the plugin's settings entry.
   * @returns settlement once the answers are published.
   */
  refresh(withSettings: boolean): Promise<void> {
    if (this.running !== undefined) {
      this.again = { settings: withSettings || this.again?.settings === true }
      return this.running
    }
    const run = this.read(withSettings).finally(() => {
      this.running = undefined
      const next = this.again
      this.again = undefined
      if (next !== undefined && !this.isClosed()) void this.refresh(next.settings)
    })
    this.running = run
    return run
  }

  /**
   * Make one signed-in account the one DSH runs Claude Code as.
   * @param email - the account's email.
   * @returns settlement once the write and the re-read finish.
   */
  select(email: string): Promise<void> {
    return this.write([{ op: 'set', path: ['activeAccount'], value: normalizeEmail(email) }])
  }

  /**
   * Add an email to the list.
   * @param raw - the address as typed.
   * @returns the copy key of the validation error, or `undefined` once added.
   */
  async add(raw: string): Promise<'addInvalid' | 'addDuplicate' | undefined> {
    const email = normalizeEmail(raw)
    if (!isPlausibleEmail(email)) return 'addInvalid'
    if (this.known().has(email)) return 'addDuplicate'
    const listed = this.settings?.accounts.map(normalizeEmail) ?? []
    await this.write([{ op: 'set', path: ['accounts'], value: [...listed, email] }])
    return undefined
  }

  /**
   * Take an email out of the list. Login folders stay on disk; an active account that is removed stops being active.
   * @param email - the account's email.
   * @returns settlement once the write and the re-read finish.
   */
  remove(email: string): Promise<void> {
    const target = normalizeEmail(email)
    const kept = (this.settings?.accounts ?? []).map(normalizeEmail).filter(listed => listed !== target)
    const ops: Parameters<ClaudeAccountsOperations['writeSettings']>[0] = [{ op: 'set', path: ['accounts'], value: kept }]
    if (this.settings?.activeAccount !== undefined && normalizeEmail(this.settings.activeAccount) === target) {
      ops.push({ op: 'unset', path: ['activeAccount'] })
    }
    return this.write(ops)
  }

  /**
   * Swap one signed-in account's login into the default Claude Code configuration.
   * @param email - the account's email.
   * @returns settlement once the swap and the re-read finish.
   */
  async makeDefault(email: string): Promise<void> {
    this.patch({ busy: true, notice: undefined })
    const outcome = await this.operations.makeDefault(email)
    if (this.isClosed()) return
    this.patch({
      busy: false,
      notice: outcome.kind === 'done'
        ? { kind: 'success', key: outcome.unchanged ? 'makeDefaultUnchanged' : 'makeDefaultDone', values: { email } }
        : { kind: 'error', key: 'makeDefaultFailed', values: { reason: outcome.message } },
    })
    await this.refresh(false)
  }

  /** Re-read everything after a sign-in attempt settled. */
  afterSignIn(): Promise<void> {
    return this.refresh(true)
  }

  private known(): Set<string> {
    return new Set([
      ...(this.settings?.accounts ?? []).map(normalizeEmail),
      ...this.store.getSnapshot().rows.map(row => normalizeEmail(row.email)),
    ])
  }

  private async write(ops: Parameters<ClaudeAccountsOperations['writeSettings']>[0]): Promise<void> {
    this.patch({ busy: true, notice: undefined })
    const outcome = await this.operations.writeSettings(ops, this.settings?.revision)
    if (this.isClosed()) return
    if (outcome.kind === 'written') {
      this.settings = outcome.snapshot
      this.patch({ busy: false })
    } else {
      this.patch({
        busy: false,
        notice: outcome.kind === 'conflict'
          ? { kind: 'error', key: 'conflict', values: {} }
          : { kind: 'error', key: 'saveFailed', values: { message: outcome.message } },
      })
    }
    await this.refresh(outcome.kind !== 'written')
  }

  private async read(withSettings: boolean): Promise<void> {
    const settings = withSettings || this.settings === undefined ? await this.operations.readSettings() : this.settings
    if (this.isClosed()) return
    if (settings !== undefined) this.settings = settings
    // A profile without the plugin has nothing to ask the status of.
    if (settings?.configured === false) {
      this.publish(false)
      return
    }
    const status = await this.operations.readStatus()
    if (this.isClosed()) return
    this.statusView = status ?? this.statusView
    this.publish(status === undefined)
  }

  private publish(statusFailed: boolean): void {
    const { settings, statusView } = this
    if (settings === undefined) {
      this.patch({ loadFailed: true })
      return
    }
    if (!settings.configured) {
      this.patch({ status: 'unavailable', rows: [], loadFailed: false, writable: false })
      return
    }
    const listed = new Set(settings.accounts.map(normalizeEmail))
    const accounts = statusView?.accounts ?? []
    const least = leastUsedEmail(accounts)
    const defaultEmail = statusView?.defaultAccount.email === undefined ? undefined : normalizeEmail(statusView.defaultAccount.email)
    this.patch({
      status: 'ready',
      writable: settings.writable,
      loadFailed: statusFailed && statusView === undefined,
      now: this.clock(),
      rows: accounts.map(account => ({
        ...account,
        listed: listed.has(normalizeEmail(account.email)),
        leastUsed: account.email === least,
        isDefault: defaultEmail !== undefined && normalizeEmail(account.email) === defaultEmail,
      })),
    })
  }

  private patch(change: Partial<ClaudeAccountsState>): void {
    this.store.update((state) => { Object.assign(state, change) })
  }
}
