/**
 * Host owner of the `claudeAccounts` Remote namespace: lets a configuration
 * surface list the Claude Code accounts with their plan usage and make one the
 * default login of every Claude Code on the machine. It is a thin projection of
 * the `ctx.claudeAccounts` service that `@deepseek-ai/dsh-llm-claude-code`
 * provides while it is mounted; without that plugin the namespace stays
 * registered and `status()` answers an empty list, so a page can render
 * "not set up" instead of an error.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/claude-accounts.ts
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm-claude-code/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type {
  ClaudeAccountView, ClaudeAccountsStatusView, ClaudeAccountUsageView, ClaudeAccountWindowView, ClaudeMakeDefaultView,
  ClaudeSignOutView,
} from './types.ts'

/** An email as the plugin normalizes it: one `@`, no spaces, bounded length. */
const emailSchema = z.string().min(3).max(320).regex(/^[^\s@]+@[^\s@]+$/)

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `claudeAccounts` Remote namespace. */
    claudeAccountsController: ClaudeAccountsController
  }
}

/** Copy one plan-usage window field by field. */
function projectWindow(window: ClaudeAccountWindowView): ClaudeAccountWindowView {
  return { utilization: window.utilization, resetsAt: window.resetsAt }
}

/** Copy one plan-usage reading field by field. */
function projectUsage(usage: ClaudeAccountUsageView): ClaudeAccountUsageView {
  return {
    ...usage.fiveHour === undefined ? {} : { fiveHour: projectWindow(usage.fiveHour) },
    ...usage.sevenDay === undefined ? {} : { sevenDay: projectWindow(usage.sevenDay) },
    updatedAt: usage.updatedAt,
  }
}

/** Copy one account field by field; the Gateway returns a business result without decoding it. */
function projectAccount(account: ClaudeAccountView): ClaudeAccountView {
  return {
    email: account.email,
    id: account.id,
    signedIn: account.signedIn,
    active: account.active,
    ...account.signedInAt === undefined ? {} : { signedInAt: account.signedInAt },
    ...account.usage === undefined ? {} : { usage: projectUsage(account.usage) },
  }
}

/** The answer when no Claude Code plugin is mounted. */
const EMPTY_STATUS: ClaudeAccountsStatusView = { accounts: [], defaultAccount: {} }

/**
 * Host service backing the generated `ctx.remote.claudeAccounts` namespace.
 * Every answer is copied field by field, so whatever else the service object
 * carries cannot reach the wire; no method here returns a token.
 */
export class ClaudeAccountsController extends TypertRemoteService {
  /** @param ctx - Host context where the Claude Code plugin may be mounted. */
  constructor(ctx: Context) {
    super(ctx, 'claudeAccountsController', { namespace: 'claudeAccounts' })
  }

  /**
   * The Claude Code accounts a person can pick from.
   * @returns each account with its sign-in state and latest plan usage, the account the default Claude Code
   *   config is signed in as, and the active account; an empty list while the Claude Code plugin is not mounted.
   */
  @Remote
  async status(): Promise<ClaudeAccountsStatusView> {
    const service = this.ctx.get('claudeAccounts')
    if (service === undefined) return EMPTY_STATUS
    const status = await service.status()
    const email = status.defaultAccount.email
    return {
      accounts: status.accounts.map(projectAccount),
      defaultAccount: email === undefined ? {} : { email },
      ...status.activeAccount === undefined ? {} : { activeAccount: status.activeAccount },
    }
  }

  /**
   * Make one signed-in account the login of every new Claude Code process on this machine.
   * @param email - the account's email.
   * @returns the backup folder of the replaced login, or the reason nothing changed.
   * @throws RemoteError `gateway/bad-request` when `email` is not an address, or `gateway/internal` while
   *   the Claude Code plugin is not mounted.
   */
  @Remote
  async makeDefault(email: string): Promise<ClaudeMakeDefaultView> {
    const parsed = emailSchema.safeParse(email)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'invalid email for claudeAccounts.makeDefault', { issues: parsed.error.issues })
    const service = this.ctx.get('claudeAccounts')
    if (service === undefined) {
      throw new RemoteError('gateway/internal', 'claudeAccounts is absent: this deployment does not mount the Claude Code LLM plugin', {})
    }
    const outcome = await service.makeDefault(parsed.data)
    return outcome.ok
      ? { ok: true, backupDir: outcome.backupDir, unchanged: outcome.unchanged }
      : { ok: false, reason: outcome.reason }
  }

  /**
   * Sign one account out of DSH: delete its saved Claude login and take it off the signed-in list.
   * The email stays in the configured list, and the default Claude Code login is not touched.
   * @param email - the account's email.
   * @returns ok, or the reason nothing was removed.
   * @throws RemoteError `gateway/bad-request` when `email` is not an address, or `gateway/internal` while
   *   the Claude Code plugin is not mounted.
   */
  @Remote
  async signOut(email: string): Promise<ClaudeSignOutView> {
    const parsed = emailSchema.safeParse(email)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'invalid email for claudeAccounts.signOut', { issues: parsed.error.issues })
    const service = this.ctx.get('claudeAccounts')
    if (service === undefined) {
      throw new RemoteError('gateway/internal', 'claudeAccounts is absent: this deployment does not mount the Claude Code LLM plugin', {})
    }
    const outcome = await service.signOut(parsed.data)
    return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason }
  }
}

export default ClaudeAccountsController
