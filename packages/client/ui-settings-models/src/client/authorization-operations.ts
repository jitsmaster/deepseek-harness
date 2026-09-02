/**
 * The Host reads and writes an `AuthorizationDialog` performs, mirroring
 * `operations.ts`'s shape: a card receives these instead of a context, so the
 * failure codes and Remote namespace stay in the apply world.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  AuthorizationEntry, AuthorizationNotice, AuthorizationOutcome, WireAuthorizationPrompt,
} from '@deepseek-ai/dsh-api-remotes/client'

/** The Host operations one authorization conversation is driven through. */
export interface AuthorizationOperations {
  /**
   * Read one flow's current state.
   * @param key - joined `<scope>/<id>` credential key.
   * @returns the entry, or undefined when no flow claims that key or the read was refused.
   */
  describeAuthorization(key: string): Promise<AuthorizationEntry | undefined>
  /**
   * Run one attempt to authorize a key, relaying its notices and prompts to `handlers`
   * for as long as the attempt runs.
   * @param key - joined `<scope>/<id>` credential key.
   * @param method - method id to run; undefined runs the flow's own default.
   * @param signal - withdraws the attempt.
   * @param handlers - callbacks for notices and prompts raised while this call is in flight.
   * @returns how the attempt ended.
   * @throws whatever the Remote call rejects with (surfaced to the caller unchanged).
   */
  beginAuthorization(
    key: string,
    method: string | undefined,
    signal: AbortSignal,
    handlers: {
      onNotice: (notice: AuthorizationNotice) => void
      onPrompt: (promptId: string, prompt: WireAuthorizationPrompt) => void
    },
  ): Promise<AuthorizationOutcome>
  /**
   * Answer a pending prompt from a running attempt.
   * @param key - joined `<scope>/<id>` credential key.
   * @param promptId - correlation id from the matching prompt.
   * @param value - the human's typed answer, or the chosen option's id.
   * @returns the refusal message, or undefined once answered.
   */
  respondAuthorization(key: string, promptId: string, value: string): Promise<string | undefined>
  /**
   * Decline a pending prompt, settling its attempt as cancelled.
   * @param key - joined `<scope>/<id>` credential key.
   * @param promptId - correlation id from the matching prompt.
   * @returns the refusal message, or undefined once declined.
   */
  declineAuthorization(key: string, promptId: string): Promise<string | undefined>
  /**
   * Withdraw the attempt running for a key, if any; a harmless no-op otherwise.
   * @param key - joined `<scope>/<id>` credential key.
   */
  cancelAuthorization(key: string): Promise<void>
}

/**
 * Bind one card's Host authorization operations to the plugin's own Remote namespace.
 * @param ctx - the page plugin's context, which declares `remote.authorization` in its own `inject`.
 * @returns the callbacks an authorization dialog is injected with.
 */
export function createAuthorizationOperations(ctx: ClientContext): AuthorizationOperations {
  return {
    describeAuthorization: async (key) => {
      const response = await ctx.remote.authorization.describe(key)
      return response.ok ? response.value : undefined
    },
    beginAuthorization: async (key, method, signal, handlers) => {
      const offNotice = ctx.remote.$on('authorization/notice', (payload) => {
        if (payload.key === key) handlers.onNotice(payload.notice)
      })
      const offPrompt = ctx.remote.$on('authorization/prompt', (payload) => {
        if (payload.key === key) handlers.onPrompt(payload.promptId, payload.prompt)
      })
      try {
        const response = await ctx.remote.authorization.begin(key, method, signal)
        if (!response.ok) throw response.error
        return response.value
      } finally {
        offNotice()
        offPrompt()
      }
    },
    respondAuthorization: async (key, promptId, value) => {
      const response = await ctx.remote.authorization.respond(key, promptId, value)
      return response.ok ? undefined : response.error.message
    },
    declineAuthorization: async (key, promptId) => {
      const response = await ctx.remote.authorization.decline(key, promptId)
      return response.ok ? undefined : response.error.message
    },
    cancelAuthorization: async (key) => {
      await ctx.remote.authorization.cancel(key)
    },
  }
}
