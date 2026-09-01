/**
 * Host owner of the `authorization` Remote namespace: the browser-facing half
 * of `ctx.authorization`, letting a configuration surface list what can be
 * authorized and drive one sign-in conversation over a stateless RPC.
 * Modeled directly on `CredentialsController` in this same package.
 *
 * The `authorization/notice` and `authorization/prompt` events below relay a
 * running attempt's notices and prompts to whichever surface started it. They
 * are declared here rather than in `@deepseek-ai/dsh-authorization` because
 * their payloads are wire concepts the seam itself never needs: `promptId` is
 * a correlation id invented purely to answer one prompt back over a stateless
 * RPC, and the prompt payload has its `signal` stripped because an
 * `AbortSignal` cannot cross the wire. The seam owns the conversation, never
 * the protocol.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/authorization.ts
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError, AuthorizationError } from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationEntry, AuthorizationMethod, AuthorizationNotice, AuthorizationOutcome, AuthorizationPrompt,
} from '@deepseek-ai/dsh-authorization/types'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

/** Grammar for the joined `<scope>/<id>` wire form of a {@link CredentialKey}. */
const keySchema = z.string().regex(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/)

/** {@link AuthorizationPrompt} minus the field that cannot cross the wire. */
export type WireAuthorizationPrompt = Omit<AuthorizationPrompt, 'signal'>

/** The wire view of one registered flow: {@link AuthorizationEntry} projected field-by-field. */
export interface AuthorizationEntryView {
  readonly key: CredentialKey
  readonly label: string
  readonly methods: readonly AuthorizationMethod[]
  readonly inFlight: boolean
}

/** The wire view of one finished `begin()` attempt. {@link AuthorizationOutcome} is already wire-safe verbatim. */
export type AuthorizationOutcomeView = AuthorizationOutcome

/** One attempt's pending prompts, keyed by the correlation id handed to the wire. */
type PendingPrompts = Map<string, PromiseWithResolvers<string>>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `authorization` Remote namespace. */
    authorizationController: AuthorizationController
  }

  interface Events {
    /**
     * A running authorization attempt reported progress, or told the human
     * what to do next. Fire-and-forget, same as the seam's own `notify`.
     * @mode emit
     */
    'authorization/notice'(payload: { key: string; notice: AuthorizationNotice }): void
    /**
     * A running authorization attempt needs an answer before it can
     * continue. `promptId` correlates this prompt with the `respond()` or
     * `decline()` call that answers it; the prompt's own `signal` never
     * crosses the wire.
     * @mode emit
     */
    'authorization/prompt'(payload: { key: string; promptId: string; prompt: WireAuthorizationPrompt }): void
  }
}

/**
 * Copy exactly the fields {@link AuthorizationEntry} declares, methods
 * included. The Gateway returns a business result without decoding it, so a
 * flow object with unexpected enumerable properties would otherwise
 * serialize them to the caller.
 * @param entry - one flow's seam-side entry.
 * @returns the same facts with nothing else attached.
 */
function projectEntry(entry: AuthorizationEntry): AuthorizationEntryView {
  return {
    key: entry.key,
    label: entry.label,
    methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
    inFlight: entry.inFlight,
  }
}

/**
 * Drop the field an {@link AuthorizationPrompt} carries that cannot cross the
 * wire. The controller keeps the real signal server-side and reacts to it
 * itself, so the "withdraw just this prompt" contract survives the smaller
 * wire shape.
 * @param prompt - the seam's own prompt, signal included.
 * @returns the same prompt without its signal.
 */
function dropSignal(prompt: AuthorizationPrompt): WireAuthorizationPrompt {
  const { signal: _signal, ...rest } = prompt
  return rest
}

/**
 * Parse a wire key string or refuse the call as a bad request.
 * @param raw - candidate joined `<scope>/<id>` key.
 * @returns the branded key.
 * @throws RemoteError `gateway/bad-request` when `raw` does not match the grammar.
 */
function parseKeyOrThrow(raw: string): CredentialKey {
  const parsed = keySchema.safeParse(raw)
  if (!parsed.success) {
    throw new RemoteError('gateway/bad-request', `invalid authorization key "${raw}"`, { issues: parsed.error.issues })
  }
  return parseCredentialKey(parsed.data)
}

/**
 * Map a caught `ctx.authorization.begin()` failure onto its Remote error code.
 * @param key - the wire key string the attempt addressed.
 * @param method - the method the caller requested, when one was named.
 * @param error - whatever the seam (or an unrelated fault) threw.
 * @returns the failure to raise for that refusal.
 */
function mapAuthorizationError(key: string, method: string | undefined, error: unknown): RemoteError {
  if (error instanceof AuthorizationError) {
    switch (error.code) {
      case 'NO_FLOW':
        return new RemoteError('authorization/no-flow', error.message, { key }, { cause: error })
      case 'UNKNOWN_METHOD':
        return new RemoteError(
          'authorization/unknown-method', error.message, { key, method: method ?? '' }, { cause: error })
      case 'ALREADY_IN_FLIGHT':
        return new RemoteError('authorization/already-in-flight', error.message, { key }, { cause: error })
      case 'NOT_COMMITTED':
        return new RemoteError('authorization/not-committed', error.message, { key }, { cause: error })
      default:
        break
    }
  }
  return new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}, { cause: error })
}

/**
 * Host service backing the generated `ctx.remote.authorization` namespace.
 * Wraps `ctx.authorization` with the wire obligations the seam itself does
 * not carry: key branding, view projection, the prompt correlation-id
 * bridge, and the refusal mapping.
 */
export class AuthorizationController extends TypertRemoteService {
  /** The conversation this controller exposes is the authorization seam's own. */
  static inject = ['authorization']

  /** One entry per key with a `begin()` call currently running through this controller. */
  private readonly pendingByKey = new Map<CredentialKey, PendingPrompts>()

  /** @param ctx - Host context where the authorization seam is mounted. */
  constructor(ctx: Context) {
    super(ctx, 'authorizationController', { namespace: 'authorization' })
  }

  /**
   * Every registered flow, for a surface listing what can be authorized.
   * @returns one entry per flow, in registration order.
   */
  @Remote
  list(): AuthorizationEntryView[] {
    return this.ctx.authorization.list().map(projectEntry)
  }

  /**
   * One registered flow.
   * @param key - joined `<scope>/<id>` credential key.
   * @returns the entry, or undefined when no flow claims that key.
   * @throws RemoteError `gateway/bad-request` when `key` is malformed.
   */
  @Remote
  describe(key: string): AuthorizationEntryView | undefined {
    const branded = parseKeyOrThrow(key)
    const entry = this.ctx.authorization.describe(branded)
    return entry === undefined ? undefined : projectEntry(entry)
  }

  /**
   * Run one attempt to authorize a key, relaying its notices and prompts
   * over the `authorization/notice`/`authorization/prompt` events.
   * @param key - joined `<scope>/<id>` credential key.
   * @param method - method id to run; defaults to the flow's first.
   * @param signal - withdraws the attempt.
   * @returns how the attempt ended.
   * @throws RemoteError `gateway/bad-request` for a malformed key,
   *   `gateway/cancelled` when `signal` is already aborted,
   *   `authorization/no-flow`, `authorization/unknown-method`,
   *   `authorization/already-in-flight`, `authorization/not-committed`, or
   *   `gateway/internal` for anything else.
   */
  @Remote
  async begin(key: string, method: string | undefined, signal: AbortSignal): Promise<AuthorizationOutcomeView> {
    const branded = parseKeyOrThrow(key)
    if (signal.aborted) throw new RemoteError('gateway/cancelled', 'authorization begin() was aborted', {})
    // A second concurrent begin() for this key must never touch the first
    // caller's own pending-prompt map: refuse it here, before `pendingByKey`
    // could be overwritten with a second, empty map for the same key.
    if (this.pendingByKey.has(branded)) {
      throw new RemoteError(
        'authorization/already-in-flight', `an authorization attempt for "${key}" is already running`, { key })
    }
    const pending: PendingPrompts = new Map()
    this.pendingByKey.set(branded, pending)
    try {
      return await this.ctx.authorization.begin({
        key: branded,
        ...method === undefined ? {} : { method },
        signal,
        interaction: {
          notify: notice => this.ctx.emit('authorization/notice', { key, notice }),
          prompt: prompt => this.relayPrompt(key, pending, prompt),
        },
      })
    } catch (error) {
      throw mapAuthorizationError(key, method, error)
    } finally {
      // The attempt is over: dropping the key from `pendingByKey` alone makes
      // every prompt this call handed out unanswerable (respond()/decline()
      // resolve their map lookup through this key). A prompt still pending
      // here is never proactively rejected: the flow that asked it either
      // already stopped awaiting it (this same settlement raced its own
      // signal, the seam's own "orphaned run" tolerance) or never awaited it
      // at all, and rejecting it here for no live listener would only risk
      // an unhandled rejection with nothing left to observe it.
      this.pendingByKey.delete(branded)
    }
  }

  /**
   * Answer a pending prompt from a running `begin()` attempt.
   * @param key - joined `<scope>/<id>` credential key.
   * @param promptId - correlation id from the matching `authorization/prompt` event.
   * @param value - the human's typed answer, or the chosen option's id.
   * @throws RemoteError `gateway/bad-request` for a malformed key, or `authorization/unknown-prompt`.
   */
  @Remote
  async respond(key: string, promptId: string, value: string): Promise<void> {
    this.takePendingPrompt(key, promptId).resolve(value)
  }

  /**
   * Decline a pending prompt, settling its `begin()` attempt as cancelled.
   * @param key - joined `<scope>/<id>` credential key.
   * @param promptId - correlation id from the matching `authorization/prompt` event.
   * @throws RemoteError `gateway/bad-request` for a malformed key, or `authorization/unknown-prompt`.
   */
  @Remote
  async decline(key: string, promptId: string): Promise<void> {
    this.takePendingPrompt(key, promptId).reject(new AuthorizationDeclinedError())
  }

  /**
   * Withdraw the attempt running for a key, if any; a harmless no-op
   * otherwise. Separate from `begin()`'s own signal because a Cancel button
   * is a second call, with no handle on the first call's signal.
   * @param key - joined `<scope>/<id>` credential key.
   * @throws RemoteError `gateway/bad-request` when `key` is malformed.
   */
  @Remote
  cancel(key: string): void {
    this.ctx.authorization.cancel(parseKeyOrThrow(key))
  }

  /**
   * Emit one prompt over the wire and hand back its answer once `respond()`
   * or `decline()` settle it.
   * @param key - wire key string this attempt addresses.
   * @param pending - this attempt's own pending-prompt map.
   * @param prompt - the seam's prompt request.
   * @returns what the human typed, or the chosen option's id.
   */
  private relayPrompt(key: string, pending: PendingPrompts, prompt: AuthorizationPrompt): Promise<string> {
    const promptId = randomUUID()
    const resolvers = Promise.withResolvers<string>()
    pending.set(promptId, resolvers)
    this.ctx.emit('authorization/prompt', { key, promptId, prompt: dropSignal(prompt) })
    // The prompt's own signal withdraws just this question, leaving the
    // flow running: a race between a typed code and a browser callback
    // retires the losing prompt without cancelling the whole attempt.
    prompt.signal?.addEventListener('abort', () => {
      pending.delete(promptId)
      resolvers.reject(new AuthorizationDeclinedError())
    }, { once: true })
    return resolvers.promise
  }

  /**
   * Resolve the pending prompt for one `(key, promptId)` pair, consuming it
   * so a second call against the same id is refused.
   * @param key - joined `<scope>/<id>` credential key.
   * @param promptId - correlation id from the matching `authorization/prompt` event.
   * @returns the resolvers a running `begin()` attempt is waiting on.
   * @throws RemoteError `gateway/bad-request` for a malformed key, or `authorization/unknown-prompt`.
   */
  private takePendingPrompt(key: string, promptId: string): PromiseWithResolvers<string> {
    const branded = parseKeyOrThrow(key)
    const prompts = this.pendingByKey.get(branded)
    const resolvers = prompts?.get(promptId)
    if (prompts === undefined || resolvers === undefined) {
      throw new RemoteError(
        'authorization/unknown-prompt', `no pending prompt "${promptId}" for "${key}"`, { key, promptId })
    }
    prompts.delete(promptId)
    return resolvers
  }
}

export default AuthorizationController
