/**
 * The Host reads and writes the Claude accounts card performs, as callbacks built
 * in the plugin body. The card and its controller receive these instead of a
 * context, so the Remote namespaces and failure codes stay in the apply world.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ClaudeAccountsStatusView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

/** Settings namespace of the Claude Code LLM plugin: its plugin entry id in the profile. */
export const CLAUDE_CODE_SETTINGS_NS = 'llm-claude-code'

/** What the plugin's settings entry holds, as far as this card cares. */
export interface ClaudeSettingsSnapshot {
  /** Whether the Host serves the plugin's settings entry at all (the plugin is in the profile). */
  readonly configured: boolean
  /** Whether the profile accepts writes. */
  readonly writable: boolean
  /** Revision of the entry the values were read at. */
  readonly revision: number
  /** The configured `accounts` emails. */
  readonly accounts: readonly string[]
  /** The configured `activeAccount`, when set. */
  readonly activeAccount: string | undefined
}

/** What one settings write answered. */
export type ClaudeSettingsWrite =
  | { readonly kind: 'written'; readonly snapshot: ClaudeSettingsSnapshot }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'refused'; readonly message: string }

/** What a make-default request answered. */
export type ClaudeMakeDefaultOutcome =
  | { readonly kind: 'done'; readonly unchanged: boolean }
  | { readonly kind: 'refused'; readonly message: string }

/** What a sign-out request answered. */
export type ClaudeSignOutOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'refused'; readonly message: string }

/** The Host operations the card is driven through. */
export interface ClaudeAccountsOperations {
  /** Read accounts, usage, and the default config's account; `undefined` when the read failed. */
  readStatus(): Promise<ClaudeAccountsStatusView | undefined>
  /** Read the plugin's settings entry; `undefined` when the read failed. */
  readSettings(): Promise<ClaudeSettingsSnapshot | undefined>
  /** Apply path operations to the plugin's settings entry. */
  writeSettings(ops: SettingsPathOpView[], expectedRevision: number | undefined): Promise<ClaudeSettingsWrite>
  /** Swap one account's login into the default Claude Code configuration. */
  makeDefault(email: string): Promise<ClaudeMakeDefaultOutcome>
  /** Delete one account's saved login on the Host and take it off the signed-in list. */
  signOut(email: string): Promise<ClaudeSignOutOutcome>
}

/** Read the card's fields out of one namespace view's resolved value. */
function snapshotOf(view: { value: unknown; revision: number }, writable: boolean): ClaudeSettingsSnapshot {
  const value = typeof view.value === 'object' && view.value !== null ? view.value as Record<string, unknown> : {}
  const accounts = Array.isArray(value['accounts'])
    ? value['accounts'].filter((item): item is string => typeof item === 'string')
    : []
  const active = value['activeAccount']
  return {
    configured: true,
    writable,
    revision: view.revision,
    accounts,
    activeAccount: typeof active === 'string' && active.length > 0 ? active : undefined,
  }
}

/**
 * Bind the card's Host operations to the plugin's own Remote namespaces.
 * @param ctx - the plugin's context, which declares `remote.settings` and `remote.claudeAccounts` in its own `inject`.
 * @returns the callbacks the controller is built with.
 */
export function createClaudeAccountsOperations(ctx: ClientContext): ClaudeAccountsOperations {
  return {
    readStatus: async () => {
      const response = await ctx.remote.claudeAccounts.status()
      return response.ok ? response.value : undefined
    },
    readSettings: async () => {
      const response = await ctx.remote.settings.describe()
      if (!response.ok) return undefined
      const view = response.value.namespaces.find(candidate => candidate.ns === CLAUDE_CODE_SETTINGS_NS)
      return view === undefined
        ? { configured: false, writable: false, revision: 0, accounts: [], activeAccount: undefined }
        : snapshotOf(view, response.value.writable)
    },
    writeSettings: async (ops, expectedRevision) => {
      const response = await ctx.remote.settings.mutate(CLAUDE_CODE_SETTINGS_NS, ops, expectedRevision)
      if (response.ok) return { kind: 'written', snapshot: snapshotOf(response.value, true) }
      const { code, message } = response.error
      return code === 'settings/conflict' ? { kind: 'conflict' } : { kind: 'refused', message }
    },
    makeDefault: async (email) => {
      const response = await ctx.remote.claudeAccounts.makeDefault(email)
      if (!response.ok) return { kind: 'refused', message: response.error.message }
      return response.value.ok
        ? { kind: 'done', unchanged: response.value.unchanged }
        : { kind: 'refused', message: response.value.reason }
    },
    signOut: async (email) => {
      const response = await ctx.remote.claudeAccounts.signOut(email)
      if (!response.ok) return { kind: 'refused', message: response.error.message }
      return response.value.ok ? { kind: 'done' } : { kind: 'refused', message: response.value.reason }
    },
  }
}
