/** Agent activation, composition, and model-selection policy owned by API Session. */

import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, resolveCurrentSelection } from '@deepseek-ai/dsh-agent'
import type {
  Agent, AgentHandle, AgentOptions, AgentSetup, ModelSelection as AgentModelSelection, ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type { ModelSelection } from './types.ts'

/** Cold Session identity absent from persistence. */
export class ApiSessionNotFound extends Error {}

/** Session identity whose lifecycle belongs to subagent routing. */
export class ApiSessionSubagentOwnership extends Error {
  /** @param sessionId - identity reserved to subagent routing. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is a subagent session; use subagent delivery`)
  }
}

/** Explicit-id creation attempted to adopt a Session under another cwd. */
export class ApiSessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      existingCwd === undefined
        ? `session "${sessionId}" records no cwd and cannot be adopted for "${requestedCwd}"`
        : `session "${sessionId}" belongs to "${existingCwd}", not "${requestedCwd}"`,
    )
  }
}

/** Explicit-id creation attempted to adopt a Session under another preset. */
export class ApiSessionPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
    readonly existingPreset: string | undefined,
  ) {
    super(
      existingPreset === undefined
        ? `session "${sessionId}" records no agent preset and cannot be adopted under "${requestedPreset}"`
        : `session "${sessionId}" runs agent preset "${existingPreset}", not "${requestedPreset}"`,
    )
  }
}

/** Failures produced while resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentError = RemoteError<'session/not-found' | 'session/agent-busy' | 'session/writer-held' | 'gateway/internal'>

/** Result of resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentResult =
  | { readonly agent: Agent }
  | { readonly error: ApiSessionAgentError }

type InstalledSelection = ModelSelectionRef & {
  current: AgentModelSelection
  consume(provider: string, model: string, reasoningEffort: string | undefined): boolean
}

/**
 * Test whether generic Session routing must leave an identity to subagent routing.
 * @param ctx - Host context carrying the Agent ownership registry.
 * @param session - attached or live Session whose ownership is tested.
 * @param agent - live Agent when one exists for the Session.
 * @returns whether subagent routing owns the Session identity.
 */
export function hasApiSessionSubagentOwner(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/**
 * Build the stable caller-facing subagent ownership rejection.
 * @param sessionId - Session identity owned by subagent routing.
 * @returns a stable Session-domain failure.
 */
export function apiSessionSubagentOwnershipError(sessionId: SessionId): ApiSessionAgentError {
  return new RemoteError(
    'session/agent-busy',
    `session "${sessionId}" is owned by subagent routing`,
    { reason: 'use subagent delivery for this child session' },
  )
}

/**
 * Inspect one cold Session without repairing, resuming, or publishing it.
 * @param ctx - Host context carrying Session persistence.
 * @param sessionId - durable Session identity.
 * @param signal - optional cancellation for persistence reads.
 * @returns the persisted header and complete event prefix.
 */
export async function inspectApiSession(
  ctx: Context,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<SessionInspection> {
  try {
    using observation = await ctx.sessionQuery.observeSession(sessionId, {
      ...(signal === undefined ? {} : { signal }),
      projectionMode: 'none',
    })
    if (observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    return {
      meta: observation.header,
      inheritedEventCount: observation.inheritedEventCount,
      events: [...observation.events],
    }
  } catch (error: unknown) {
    if (error instanceof SessionQueryError
      && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    throw error
  }
}

/** Owns every operation that may create, resume, or configure a Web Agent. */
export class ApiSessionAgentController {
  private readonly resumes = new Map<SessionId, Promise<Agent>>()
  private readonly creations = new Map<SessionId, Promise<AgentHandle>>()
  // Handles this controller itself activated (created or resumed) this call, as
  // opposed to `adoptedHandle(...)` wrapping an Agent that was already live
  // beforehand. Only the former may be safely disposed on a post-activation
  // validation failure — disposing an already-live Agent would tear down a
  // Session this call did not bring up.
  private readonly freshlyActivatedHandles = new WeakSet<AgentHandle>()
  private readonly selections = new WeakMap<Agent, InstalledSelection>()
  private readonly imageAdmissionChains = new WeakMap<Agent, Promise<void>>()

  /** @param ctx - Host context carrying Agent, model, persistence, and Typert services. */
  constructor(private readonly ctx: Context) {
    ctx.typert.lookups.configure('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent
    })
    ctx.typert.lookups.configure('session', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.session
    })
    ctx.typert.contexts.configureHost('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.ctx
    })
  }

  /**
   * Resolve or resume one ordinary Session, deduplicating concurrent resumes.
   * @param sessionId - ordinary Session identity.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.resolve(sessionId)
  }

  /**
   * Resolve one ordinary Session from an already-retained exact observation.
   * @param observation - Host-owned observation whose preparation stays pinned through setup.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveObservedAgent(observation: SessionObservation): Promise<ApiSessionAgentResult> {
    return this.resolve(observation.header.id, observation)
  }

  private async resolve(
    sessionId: SessionId,
    observation?: SessionObservation,
  ): Promise<ApiSessionAgentResult> {
    const live = this.liveAgent(sessionId)
    if (live !== undefined) return live
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
      return { error: apiSessionSubagentOwnershipError(sessionId) }
    }

    let resume = this.resumes.get(sessionId)
    if (resume === undefined) {
      resume = this.resume(sessionId, observation).finally(() => { this.resumes.delete(sessionId) })
      this.resumes.set(sessionId, resume)
    }
    try {
      const agent = await resume
      // A shared resume can publish an identity that subagent routing adopts
      // before every waiter observes it; apply the live ownership policy again.
      const published = this.liveAgent(sessionId)
      return published ?? { agent }
    } catch (error: unknown) {
      if (error instanceof ApiSessionNotFound) {
        return { error: new RemoteError('session/not-found', error.message, { sessionId }) }
      }
      if (error instanceof ApiSessionSubagentOwnership) {
        return { error: apiSessionSubagentOwnershipError(error.sessionId) }
      }
      const raced = this.liveAgent(sessionId)
      if (raced !== undefined) return raced
      const racedSession = this.ctx.sessions.get(sessionId)
      if (racedSession !== undefined && hasApiSessionSubagentOwner(this.ctx, racedSession, undefined)) {
        return { error: apiSessionSubagentOwnershipError(sessionId) }
      }
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        return { error: new RemoteError('session/writer-held', error.message, { sessionId }) }
      }
      return {
        error: new RemoteError(
          'gateway/internal',
          `resume failed for session "${sessionId}": ${String(error)}`,
          {},
        ),
      }
    }
  }

  /**
   * Resolve one requested identity, creating or resuming it once.
   * @param sessionId - requested Session identity.
   * @param cwd - directory the Session must own.
   * @param checkPersistedIdentity - whether to inspect a cold identity before creation.
   * @param presetId - optional Agent preset the Session must own.
   * @returns the matching live ordinary Agent.
   */
  async ensureSession(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    presetId?: string,
  ): Promise<Agent> {
    return (await this.ensureSessionHandle(sessionId, cwd, checkPersistedIdentity, presetId)).agent
  }

  /**
   * Resolve one requested identity, creating or resuming it once, returning the
   * full disposable {@link AgentHandle}. Use this instead of {@link ensureSession}
   * when the caller must be able to tear down exactly the Agent it activated
   * here (e.g. rolling back a partially-seeded Session) rather than the weaker
   * `agent.cancel(...)`, which cancels queued/active activity but leaves the
   * Session registered and lingering.
   *
   * Exception: if this call's own creation/resume attempt rejects, but a live
   * Agent for the identity is already found (some other, concurrent path
   * created or resumed it — not this call), the returned handle falls back to
   * the weaker cancel()-only {@link adoptedHandle}, even though this caller is
   * the primary. There is no way to recover a real disposer for an Agent this
   * call did not itself activate, so the strong-disposer guarantee above does
   * not hold in that specific race.
   *
   * The in-flight lock tracked in `this.creations` spans creation *through*
   * the primary's own post-creation validation and any resulting dispose —
   * not just creation. That entry is only removed once that whole sequence
   * has settled, so neither a joiner nor a new caller arriving after the
   * entry is gone can ever observe a handle the primary is still deciding
   * whether to tear down.
   * @param sessionId - requested Session identity.
   * @param cwd - directory the Session must own.
   * @param checkPersistedIdentity - whether to inspect a cold identity before creation.
   * @param presetId - optional Agent preset the Session must own.
   * @returns the matching live ordinary Agent's handle.
   */
  async ensureSessionHandle(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    presetId?: string,
  ): Promise<AgentHandle> {
    let creation = this.creations.get(sessionId)
    // Whichever call finds no in-flight entry is the primary: it alone owns the
    // real handle's disposer. Every other concurrent call for this sessionId is
    // a joiner sharing the same resolved handle, and must not be able to tear
    // down the session out from under the primary (or other joiners).
    const isPrimary = creation === undefined
    if (creation === undefined) {
      // The whole creation-through-validation-through-possible-dispose
      // sequence for the PRIMARY's own (cwd, presetId) runs inside this one
      // shared promise, and the map entry is only removed once it fully
      // settles (see `.finally` below). This closes the window where a
      // joiner, or a new caller arriving after the entry would otherwise
      // already be gone, could observe a handle the primary is still
      // deciding whether to tear down.
      creation = this.createOrAdopt(sessionId, cwd, checkPersistedIdentity, presetId)
        .catch((error: unknown) => {
          const live = this.ctx.agents.get(sessionId)
          if (live !== undefined) {
            if (hasApiSessionSubagentOwner(this.ctx, live.session, live)) {
              throw new ApiSessionSubagentOwnership(sessionId)
            }
            // This call's own creation/resume failed, but a concurrently-activated
            // Agent already exists for this id. Per the doc-comment exception on
            // `ensureSessionHandle`, the primary caller gets this weaker,
            // cancel()-only handle rather than the promised strong disposer.
            return adoptedHandle(live)
          }
          const attached = this.ctx.sessions.get(sessionId)
          if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
            throw new ApiSessionSubagentOwnership(sessionId)
          }
          throw error
        })
        .then(async (handle) => {
          try {
            this.validateResolvedHandle(sessionId, handle.agent, cwd, presetId)
          } catch (error: unknown) {
            // A genuinely fresh handle that fails the primary's own
            // post-creation validation is an orphan unless torn down here.
            // Only a handle this call itself activated (not one already live
            // beforehand, wrapped by `adoptedHandle`) is safe to dispose.
            if (this.freshlyActivatedHandles.has(handle)) {
              // Best-effort teardown of a now-orphaned, freshly-activated
              // handle after validation already failed. A disposer failure
              // here is deliberately swallowed rather than thrown: surfacing
              // it would replace or mask the original validation error
              // rethrown right below, which is the failure callers actually
              // need to see.
              await handle.dispose().catch(() => {})
            }
            throw error
          }
          return handle
        })
        .finally(() => { this.creations.delete(sessionId) })
      this.creations.set(sessionId, creation)
    }
    const handle = await creation
    if (isPrimary) return handle
    // Joiner: the shared promise above already ran the PRIMARY's own
    // (cwd, presetId) validation — if that failed, this line is unreachable
    // because the shared promise rejected and `await creation` above already
    // threw. A joiner's own (cwd, presetId) can still legitimately differ
    // from the primary's, so re-validate independently against this joiner's
    // own args — but a joiner must never dispose on failure; only the
    // primary owns that, and it already ran (and already disposed, if
    // needed) above.
    this.validateResolvedHandle(sessionId, handle.agent, cwd, presetId)
    return { agent: handle.agent, dispose: () => Promise.resolve() }
  }

  /**
   * Validate a resolved handle's Agent against the caller's requested identity.
   * @param sessionId - requested Session identity.
   * @param agent - live Agent resolved for the identity.
   * @param cwd - directory the Session must own.
   * @param presetId - optional Agent preset the Session must own.
   */
  private validateResolvedHandle(
    sessionId: SessionId,
    agent: Agent,
    cwd: string,
    presetId: string | undefined,
  ): void {
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (presetId !== undefined) {
      this.assertPresetUnchanged(sessionId, presetId, this.presetForSession(agent.session))
    }
    if (agent.session.header.cwd !== cwd) {
      throw new ApiSessionCwdConflict(sessionId, cwd, agent.session.header.cwd)
    }
  }

  /**
   * Install or return the Session-local model selection used by prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @returns the installed mutable selection reference.
   */
  selectionFor(agent: Agent): InstalledSelection {
    const installed = this.selections.get(agent)
    if (installed !== undefined) return installed
    const projectionState = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
    if (projectionState === undefined) {
      throw new Error('api-session: required modelSelection projection is not registered')
    }
    let picked = projectionState.pending === null
      ? undefined
      : agentModelSelection(projectionState.pending)
    const defaultModel = this.ctx.agentDefaultModel
    const selection: InstalledSelection = {
      get current(): AgentModelSelection {
        return resolveCurrentSelection<AgentModelSelection>(
          picked,
          () => {
            const loggedHeader = agent.session.requestHeader()
            if (loggedHeader === undefined) return undefined
            const logged = loggedHeader.config
            return {
              provider: logged.provider,
              model: logged.model,
              // An effort the adapter defaulted is not a conversation choice: restoring
              // it as one would make an unchanged default read as a request change.
              ...(logged.reasoningEffort === undefined
                || loggedHeader.adapterDefaults?.reasoningEffort === true
                ? {}
                : { reasoningEffort: logged.reasoningEffort }),
            }
          },
          () => defaultModel.currentSelection(),
        )
      },
      set current(next: AgentModelSelection) {
        picked = next
      },
      consume(provider: string, model: string, reasoningEffort: string | undefined): boolean {
        if (picked?.provider !== provider
          || picked.model !== model
          || picked.reasoningEffort !== reasoningEffort) return false
        picked = undefined
        return true
      },
      assembled: undefined,
    }
    installModelSelection(agent.ctx, selection)
    this.selections.set(agent, selection)
    return selection
  }

  /**
   * Commit and cache one validated selection for the next prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @param selection - validated selection to record and apply.
   */
  selectForNextRequest(agent: Agent, selection: AgentModelSelection): void {
    agent.session.append('model/selection', selection)
    this.selectionFor(agent).current = selection
  }

  /**
   * Let a matching durable request header retire the execution cache.
   * @param agent - live Agent whose request was recorded.
   * @param provider - provider route used by the request.
   * @param model - provider-owned model used by the request.
   * @param reasoningEffort - adapter-owned effort used by the request.
   * @returns whether the pending selection was consumed.
   */
  consumeSelection(
    agent: Agent,
    provider: string,
    model: string,
    reasoningEffort: string | undefined,
  ): boolean {
    return this.selections.get(agent)?.consume(provider, model, reasoningEffort) ?? false
  }

  /**
   * Read the current Agent preset from the Session projection.
   * @param session - live Session whose projection state is available.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForSession(session: Session): string | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'agentPreset') ?? undefined
  }

  /**
   * Serialize image admission and model selection for one Agent.
   * @param agent - live Agent that owns the serialization chain.
   * @param operation - asynchronous operation admitted after prior work settles.
   * @returns the operation result or rejection.
   */
  serializeImageAdmission<Value>(agent: Agent, operation: () => Promise<Value>): Promise<Value> {
    const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation)
    this.imageAdmissionChains.set(agent, result.then(() => undefined, () => undefined))
    return result
  }

  /**
   * Resolve the preset id and pre-publication Agent setup for a create or resume.
   * @param presetId - requested preset or the configured default when omitted.
   * @returns the resolved preset identity and Agent setup callback.
   */
  async composeAgent(presetId: string | undefined): Promise<{
    readonly agentPreset?: string
    readonly setup: AgentSetup
  }> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      return { setup: (_agentCtx, agent) => { this.installSelection(agent) } }
    }
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx, agent) => {
        this.installSelection(agent)
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }

  private liveAgent(sessionId: SessionId): ApiSessionAgentResult | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return undefined
    return hasApiSessionSubagentOwner(this.ctx, agent.session, agent)
      ? { error: apiSessionSubagentOwnershipError(sessionId) }
      : { agent }
  }

  private async resume(sessionId: SessionId, supplied?: SessionObservation): Promise<Agent> {
    if (supplied !== undefined) return (await this.resumeObserved(sessionId, supplied)).agent
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      return (await this.resumeObserved(sessionId, observation)).agent
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new ApiSessionNotFound(`session "${sessionId}" not found`)
      }
      throw error
    }
  }

  private async resumeObserved(
    sessionId: SessionId,
    observation: SessionObservation,
  ): Promise<AgentHandle> {
    if (observation.header.id !== sessionId || observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    const composition = await this.composeAgent(this.presetForObservation(observation))
    const published = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (published !== undefined && hasApiSessionSubagentOwner(this.ctx, published, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    return this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    })
  }

  private async createOrAdopt(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    presetId: string | undefined,
  ): Promise<AgentHandle> {
    const attached = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (live !== undefined) return adoptedHandle(live)

    if (checkPersistedIdentity) {
      try {
        using observation = await this.ctx.sessionQuery.observeSession(sessionId)
        if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
          throw new ApiSessionSubagentOwnership(sessionId)
        }
        if (observation.header.cwd !== cwd) {
          throw new ApiSessionCwdConflict(sessionId, cwd, observation.header.cwd)
        }
        const storedPreset = this.presetForObservation(observation)
        this.assertPresetUnchanged(sessionId, presetId, storedPreset)
        const composition = await this.composeAgent(storedPreset)
        // Reached only when `live === undefined` above: this resume brings the
        // Agent into memory for the FIRST time (no pre-existing live loop to
        // protect), exactly parallel to the sibling `create()` path below --
        // so, like `create()`, it must be tracked in `freshlyActivatedHandles`
        // so a post-resume validation failure (cwd/preset drift) disposes this
        // orphaned Agent instead of leaking it.
        const resumed = await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: this.agentOptions(),
          setup: composition.setup,
        })
        this.freshlyActivatedHandles.add(resumed)
        return resumed
      } catch (error: unknown) {
        if (!(error instanceof SessionQueryError)
          || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      }
    }

    try {
      await mkdir(cwd, { recursive: true })
    } catch (error: unknown) {
      throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error })
    }
    const composition = await this.composeAgent(presetId)
    const created = await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions(),
      meta: {
        cwd,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      setup: composition.setup,
    })
    this.freshlyActivatedHandles.add(created)
    return created
  }

  private agentOptions(): AgentOptions {
    const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
    return { provider, model }
  }

  private installSelection(agent: Agent): void {
    this.selectionFor(agent)
  }

  /**
   * Read the current Agent preset from an all-projections observation.
   * @param observation - exact Session observation carrying its projection snapshot.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForObservation(observation: SessionObservation): string | undefined {
    if (observation.projections === undefined) {
      throw new Error('api-session: Agent activation requires a projected Session observation')
    }
    return observation.projections.values.agentPreset ?? undefined
  }

  private assertPresetUnchanged(
    sessionId: SessionId,
    requested: string | undefined,
    existing: string | undefined,
  ): void {
    if (requested === undefined || requested === existing) return
    throw new ApiSessionPresetConflict(sessionId, requested, existing)
  }
}

/**
 * Synthesize an {@link AgentHandle} for an Agent this controller did not itself
 * create or resume via `ctx.agents.create()`/`resume()` (e.g. one already live
 * before this call, or recovered from a concurrent creation race). There is no
 * way to recover the real disposer for such an Agent, so `dispose()` falls
 * back to the weaker `cancel(...)`: it stops queued/active activity but,
 * unlike a genuine handle's disposer, does not unregister the Agent or remove
 * the Session from the store. Callers that need the strong guarantee must
 * only rely on it for a handle this controller actually created.
 * @param agent - already-live Agent adopted instead of freshly created/resumed.
 * @returns a best-effort handle wrapping the adopted Agent.
 */
function adoptedHandle(agent: Agent): AgentHandle {
  return {
    agent,
    dispose: () => {
      agent.cancel({ kind: 'disposed' })
      return Promise.resolve()
    },
  }
}

function agentModelSelection(selection: ModelSelection): AgentModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
  }
}
