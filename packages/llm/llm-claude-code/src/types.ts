/**
 * Browser-safe vocabulary of the `claudeAccounts` service this plugin provides
 * while it is mounted: what a surface shows to let a person pick one of their
 * Claude accounts, and the outcome of making one the default for every Claude
 * Code. Nothing here holds a secret; the service reports emails, ids, times,
 * usage fractions and paths only.
 * @module @deepseek-ai/dsh-llm-claude-code/types
 */

/** One plan-usage window. */
export interface ClaudeAccountWindow {
  /** Fraction of the window's allowance used, from 0 to 1. */
  readonly utilization: number
  /** When the window resets, in epoch seconds. */
  readonly resetsAt: number
}

/** The latest plan-usage reading of one account. */
export interface ClaudeAccountUsage {
  /** The five-hour (session) window, when the reading carried one. */
  readonly fiveHour?: ClaudeAccountWindow
  /** The seven-day (weekly) window, when the reading carried one. */
  readonly sevenDay?: ClaudeAccountWindow
  /** When the reading was written, in epoch milliseconds. */
  readonly updatedAt: number
}

/** One account the person can pick. */
export interface ClaudeAccountInfo {
  /** Lowercased email. */
  readonly email: string
  /** Name of the account's login folder. */
  readonly id: string
  /** Whether the account's login folder holds a saved login. */
  readonly signedIn: boolean
  /** Whether DSH's own headless calls run as this account. */
  readonly active: boolean
  /** When the account last signed in, in epoch milliseconds. */
  readonly signedInAt?: number
  /** The latest plan-usage reading; absent until the account has served a call. */
  readonly usage?: ClaudeAccountUsage
}

/** Everything the account picker shows. */
export interface ClaudeAccountsStatus {
  /** The configured emails first, then any other signed-in account. */
  readonly accounts: readonly ClaudeAccountInfo[]
  /** The account the default Claude Code configuration is signed in as; `email` is absent when it cannot be read. */
  readonly defaultAccount: { readonly email?: string }
  /** The configured active account, lowercased, when one is set. */
  readonly activeAccount?: string
}

/** How a make-default request ended. A failure names its reason and carries no secret. */
export type ClaudeMakeDefaultResult =
  | { readonly ok: true; readonly backupDir: string; readonly unchanged: boolean }
  | { readonly ok: false; readonly reason: string }

/** How a sign-out request ended. A failure names its reason and carries no secret. */
export type ClaudeSignOutResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** The service surface (`ctx.claudeAccounts`). */
export interface ClaudeAccountsService {
  /**
   * Read the accounts, their usage, and the default config's account.
   * @returns each account with its sign-in state and latest usage, the default config's account, and the active account; never rejects.
   */
  status(): Promise<ClaudeAccountsStatus>
  /**
   * Swap one signed-in account's login into the default Claude Code configuration.
   * @param email - the account's email, in any case.
   * @returns the backup folder of the replaced login, or the reason nothing changed; never rejects.
   */
  makeDefault(email: string): Promise<ClaudeMakeDefaultResult>
  /**
   * Sign one account out of DSH: delete its saved login folder and take it off the list of signed-in accounts.
   * The email stays in the configured list so it can sign in again; the default Claude Code login is not touched.
   * @param email - the account's email, in any case.
   * @returns `ok`, or the reason nothing was removed; never rejects.
   */
  signOut(email: string): Promise<ClaudeSignOutResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Claude Code accounts: usage readings and the default-login swap; provided while `llm-claude-code` is mounted. */
    claudeAccounts: ClaudeAccountsService
  }
}
