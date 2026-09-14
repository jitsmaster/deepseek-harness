import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import SessionStore, { SESSION_FORMAT_VERSION, SessionLogOffset, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionNotFound,
  ApiSessionPresetConflict,
  ApiSessionSubagentOwnership,
  inspectApiSession,
} from '../src/agent.ts'
import { installModelSelectionProjection } from '../src/model-selection-projection.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const roots: Context[] = []

/** Session cwd roots created per test, removed after their context settles. */
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function harness(): Promise<{ ctx: Context; agents: ApiSessionAgentController }> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.sessionProjections.register(agentPresetProjectionDefinition)
  installModelSelectionProjection(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  return { ctx, agents: new ApiSessionAgentController(ctx) }
}

function header(id: string, cwd: string | null = '/workspace'): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    isSeeded: false,
    ...(cwd === null ? {} : { cwd }),
  }
}

function providePersistence(ctx: Context, persistence: Record<string, unknown>): () => void {
  return ctx.provide('sessionPersistence', testSessionPersistence(ctx, persistence) as never)
}

function agent(ctx: Context, meta: SessionHeader): Agent {
  const session = ctx.sessions.create(meta.id, { meta })
  return { id: meta.id, session, status: 'idle', ctx } as Agent
}

function unpublishedAgent(ctx: Context, meta: SessionHeader): Agent {
  return {
    id: meta.id,
    session: { id: meta.id, header: meta, events: [] },
    status: 'idle',
    ctx,
  } as unknown as Agent
}

describe('ApiSession identity failures', () => {
  it('describes cwd conflicts with and without a recorded cwd', () => {
    expect(new ApiSessionCwdConflict(SessionId('missing-cwd'), '/wanted', undefined).message)
      .toContain('records no cwd')
    expect(new ApiSessionCwdConflict(SessionId('wrong-cwd'), '/wanted', '/existing').message)
      .toContain('belongs to "/existing"')
  })

  it('maps absent and cwd-less point observations to not found', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    await expect(inspectApiSession(ctx, SessionId('missing')))
      .rejects.toBeInstanceOf(ApiSessionNotFound)

    const inspect = vi.fn(() => Promise.resolve(undefined))
    const stat = vi.fn(() => Promise.resolve(undefined))
    const disposeMissing = providePersistence(ctx, {
      list: () => Promise.resolve([]),
      stat,
      inspect,
    })
    await expect(inspectApiSession(ctx, SessionId('missing'))).rejects.toBeInstanceOf(ApiSessionNotFound)
    // Absence is decided by the stat preflight; the log itself is never opened.
    expect(stat).toHaveBeenCalledOnce()
    expect(inspect).not.toHaveBeenCalled()
    disposeMissing()

    const listed = header('cwd-less-catalog', null)
    const disposeListed = providePersistence(ctx, {
      list: () => Promise.resolve([listed]),
      inspect: () => Promise.resolve({ meta: listed, events: [] }),
    })
    await expect(inspectApiSession(ctx, listed.id)).rejects.toBeInstanceOf(ApiSessionNotFound)
    disposeListed()

    const catalog = header('cwd-less-inspect')
    const inspected = header('cwd-less-inspect', null)
    providePersistence(ctx, {
      list: () => Promise.resolve([catalog]),
      inspect: () => Promise.resolve({ meta: inspected, events: [] }),
    })
    await expect(inspectApiSession(ctx, catalog.id)).rejects.toBeInstanceOf(ApiSessionNotFound)
  })

  it('forwards an explicit inspection signal', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    const meta = header('signalled-inspection')
    const inspect = vi.fn(() => Promise.resolve({ meta, inheritedEventCount: SessionLogOffset(0), events: [] }))
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect,
    })
    const signal = new AbortController().signal

    await expect(inspectApiSession(ctx, meta.id, signal)).resolves.toEqual({ meta, inheritedEventCount: SessionLogOffset(0), events: [] })
    expect(inspect).toHaveBeenCalledWith(meta.id, signal)
  })
})

describe('ApiSession Agent lookup and recovery', () => {
  it('resumes directly from a retained observation and rejects an invalid observed header', async () => {
    const { ctx, agents } = await harness()
    const meta = header('observed-resume')
    const resumed = unpublishedAgent(ctx, meta)
    const resume = vi.spyOn(ctx.agents, 'resume').mockResolvedValue({
      agent: resumed,
      dispose: () => Promise.resolve(),
    })
    const observed = {
      source: 'prepared',
      header: meta,
      events: [],
      cursor: -1,
      projections: { asOfSeq: -1, values: {} },
      retain: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    } as unknown as SessionObservation

    await expect(agents.resolveObservedAgent(observed)).resolves.toEqual({ agent: resumed })
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: meta.id }))

    const invalid = {
      ...observed,
      header: header('observed-without-cwd', null),
    } as SessionObservation
    await expect(agents.resolveObservedAgent(invalid)).resolves.toMatchObject({
      error: { code: 'session/not-found' },
    })
  })

  it('projects live Agent contexts and maps missing cold identities through Typert lookup failures', async () => {
    const { ctx } = await harness()
    const live = agent(ctx, header('live'))
    ctx.agents.register(live)
    providePersistence(ctx, {
      list: () => Promise.resolve([]),
      inspect: vi.fn(),
    })
    const host = ctx.typert.contexts.getHost('agent')
    if (host === undefined) throw new Error('Agent Context resolver was not registered')

    await expect(host.resolve(live.id)).resolves.toBe(live.ctx)
    await expect(host.resolve(SessionId('missing'))).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('returns raced ordinary Agents and ownership failures after resume throws', async () => {
    const ordinary = await harness()
    const ordinaryMeta = header('ordinary-race')
    providePersistence(ordinary.ctx, {
      list: () => Promise.resolve([ordinaryMeta]),
      inspect: () => Promise.resolve({ meta: ordinaryMeta, events: [] }),
    })
    const winner = agent(ordinary.ctx, ordinaryMeta)
    vi.spyOn(ordinary.ctx.agents, 'resume').mockImplementation(async () => {
      ordinary.ctx.agents.register(winner)
      throw new Error('raced publication')
    })
    await expect(ordinary.agents.resolveAgent(ordinaryMeta.id)).resolves.toEqual({ agent: winner })

    const child = await harness()
    const childMeta = header('child-race')
    providePersistence(child.ctx, {
      list: () => Promise.resolve([childMeta]),
      inspect: () => Promise.resolve({ meta: childMeta, events: [] }),
    })
    vi.spyOn(child.ctx.agents, 'resume').mockImplementation(async () => {
      child.ctx.sessions.create(childMeta.id, {
        meta: { ...childMeta, parentSession: SessionId('parent'), origin: 'subagent' },
      })
      throw new Error('raced child publication')
    })
    await expect(child.agents.resolveAgent(childMeta.id)).resolves.toMatchObject({
      error: { code: 'session/agent-busy' },
    })
  })

  it('reports not-found and ordinary resume failures without fabricating an Agent', async () => {
    const missing = await harness()
    providePersistence(missing.ctx, {
      list: () => Promise.resolve([]),
      inspect: vi.fn(),
    })
    await expect(missing.agents.resolveAgent(SessionId('missing'))).resolves.toMatchObject({
      error: { code: 'session/not-found' },
    })

    const failed = await harness()
    const meta = header('failed')
    providePersistence(failed.ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: [] }),
    })
    vi.spyOn(failed.ctx.agents, 'resume').mockRejectedValue(new Error('factory unavailable'))
    await expect(failed.agents.resolveAgent(meta.id)).resolves.toMatchObject({
      error: { code: 'gateway/internal', message: expect.stringContaining('factory unavailable') as string },
    })
  })

  it('requires projected observations before activation', async () => {
    const { agents } = await harness()
    const meta = header('unprojected-observation')
    const observed = {
      source: 'prepared',
      header: meta,
      events: [],
      cursor: -1,
      retain: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    } as unknown as SessionObservation

    expect(() => agents.presetForObservation(observed)).toThrow(
      'Agent activation requires a projected Session observation',
    )
  })
})

describe('ApiSession model selection', () => {
  it('requires the model-selection projection', async () => {
    const { ctx, agents } = await harness()
    const live = agent(ctx, header('missing-model-projection'))
    vi.spyOn(ctx.sessionProjections, 'stateOf').mockReturnValue(undefined)

    expect(() => agents.selectionFor(live)).toThrow('required modelSelection projection')
  })

  it('reads a reasoning-free request and consumes only the exact pending selection', async () => {
    const { ctx, agents } = await harness()
    const logged = agent(ctx, header('logged-model'))
    logged.session.append('request/header', {
      header: { config: { provider: 'logged-provider', model: 'logged-model' } },
      reason: 'initial',
    })
    expect(agents.selectionFor(logged).current).toEqual({
      provider: 'logged-provider',
      model: 'logged-model',
    })

    const pending = agent(ctx, header('pending-model'))
    const selection = agents.selectionFor(pending)
    agents.selectForNextRequest(pending, {
      provider: 'selected-provider',
      model: 'selected-model',
      reasoningEffort: 'high' as never,
    })
    expect(selection.current).toMatchObject({
      provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'high',
    })
    expect(agents.consumeSelection(pending, 'other-provider', 'selected-model', 'high')).toBe(false)
    expect(agents.consumeSelection(pending, 'selected-provider', 'other-model', 'high')).toBe(false)
    expect(agents.consumeSelection(pending, 'selected-provider', 'selected-model', 'low')).toBe(false)
    expect(agents.consumeSelection(pending, 'selected-provider', 'selected-model', 'high')).toBe(true)
    expect(selection.current).toEqual({ provider: 'fixture', model: 'fixture-model' })

    const untouched = agent(ctx, header('uninstalled-model'))
    expect(agents.consumeSelection(untouched, 'fixture', 'fixture-model', undefined)).toBe(false)
  })
})

describe('ApiSession create or adoption', () => {
  it('shares one in-flight creation between concurrent callers', async () => {
    const { ctx, agents } = await harness()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-concurrent-'))
    tempDirs.push(cwd)
    const meta = header('concurrent-create', cwd)
    const created = unpublishedAgent(ctx, meta)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const create = vi.spyOn(ctx.agents, 'create').mockImplementation(async () => {
      await gate
      return { agent: created, dispose: () => Promise.resolve() }
    })

    const first = agents.ensureSession(meta.id, cwd, false)
    const second = agents.ensureSession(meta.id, cwd, false)
    release()

    await expect(Promise.all([first, second])).resolves.toEqual([created, created])
    expect(create).toHaveBeenCalledOnce()
  })

  it('accepts a raced ordinary creation and rejects a raced attached child', async () => {
    const ordinary = await harness()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-create-'))
    tempDirs.push(cwd)
    const ordinaryMeta = header('create-race', cwd)
    const winner = agent(ordinary.ctx, ordinaryMeta)
    vi.spyOn(ordinary.ctx.agents, 'create').mockImplementation(async () => {
      ordinary.ctx.agents.register(winner)
      throw new Error('raced creation')
    })
    await expect(ordinary.agents.ensureSession(ordinaryMeta.id, cwd, false))
      .resolves.toBe(winner)

    const child = await harness()
    const childCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-child-'))
    tempDirs.push(childCwd)
    const childId = SessionId('create-child-race')
    vi.spyOn(child.ctx.agents, 'create').mockImplementation(async () => {
      child.ctx.sessions.create(childId, {
        meta: { cwd: childCwd, parentSession: SessionId('parent'), origin: 'subagent' },
      })
      throw new Error('raced child creation')
    })
    await expect(child.agents.ensureSession(childId, childCwd, false))
      .rejects.toBeInstanceOf(ApiSessionSubagentOwnership)
  })

  it('validates ownership and cwd on the Agent returned by creation', async () => {
    const child = await harness()
    const childCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-returned-child-'))
    tempDirs.push(childCwd)
    const childMeta = {
      ...header('returned-child', childCwd),
      parentSession: SessionId('parent'),
      origin: 'subagent' as const,
    }
    const childAgent = unpublishedAgent(child.ctx, childMeta)
    vi.spyOn(child.ctx.agents, 'create').mockResolvedValue({
      agent: childAgent,
      dispose: () => Promise.resolve(),
    })
    await expect(child.agents.ensureSession(childMeta.id, childCwd, false))
      .rejects.toBeInstanceOf(ApiSessionSubagentOwnership)

    const wrong = await harness()
    const requestedCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-wrong-cwd-'))
    tempDirs.push(requestedCwd)
    const wrongAgent = unpublishedAgent(wrong.ctx, header('wrong-returned-cwd', '/other'))
    vi.spyOn(wrong.ctx.agents, 'create').mockResolvedValue({
      agent: wrongAgent,
      dispose: () => Promise.resolve(),
    })
    await expect(wrong.agents.ensureSession(wrongAgent.id, requestedCwd, false))
      .rejects.toBeInstanceOf(ApiSessionCwdConflict)
  })

  it('resumes a matching persisted identity and preserves its selected preset', async () => {
    const { ctx, agents } = await harness()
    const meta = { ...header('stored'), agentPreset: 'minimal' }
    const events = [{
      type: 'agent-preset/selected',
      seq: 0,
      time: 1,
      data: { agentPreset: 'minimal' },
    }] as SessionEvent[]
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events }),
    })
    ctx.provide('agentPresets', {
      resolve: (id?: string) => Promise.resolve({ id: id ?? 'minimal' }),
      mount: () => Promise.resolve(),
    } as never)
    const resumed = {
      id: meta.id,
      session: {
        id: meta.id,
        header: meta,
        snapshotEvents: () => events,
        eventAt: (seq: number) => events[seq],
        seq: events.length,
      },
      status: 'idle',
      ctx,
    } as unknown as Agent
    const resume = vi.spyOn(ctx.agents, 'resume').mockResolvedValue({
      agent: resumed,
      dispose: () => Promise.resolve(),
    })

    await expect(agents.ensureSession(meta.id, '/workspace', true, 'minimal')).resolves.toBe(resumed)
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: meta.id }))
  })

  it('disposes a persisted-identity resume brought newly into memory when post-resume preset validation fails', async () => {
    const { ctx, agents } = await harness()
    const meta = { ...header('resume-preset-drift'), agentPreset: 'minimal' }
    const storedEvents = [{
      type: 'agent-preset/selected',
      seq: 0,
      time: 1,
      data: { agentPreset: 'minimal' },
    }] as SessionEvent[]
    providePersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({ meta, events: storedEvents }),
    })
    ctx.provide('agentPresets', {
      resolve: (id?: string) => Promise.resolve({ id: id ?? 'minimal' }),
      mount: () => Promise.resolve(),
    } as never)

    // No Agent is registered live beforehand, so `createOrAdopt` takes the
    // `checkPersistedIdentity` resume branch (`live === undefined`), which
    // brings this Agent into memory for the FIRST time via
    // `ctx.agents.resume(...)` -- exactly parallel to `create()`. The
    // pre-resume persisted-identity check (against the observation's
    // projected preset) passes, but the resumed Agent's own live session
    // reflects a DIFFERENT preset, so the post-resume validation in
    // ensureSessionHandle's `.then()` must still reject the call. Because
    // this Agent was newly activated by this very call (not one already
    // live beforehand), it must be disposed as an orphan, matching
    // `create()`'s existing orphan-disposal behavior.
    const driftedEvents = [{
      type: 'agent-preset/selected',
      seq: 0,
      time: 1,
      data: { agentPreset: 'drifted' },
    }] as SessionEvent[]
    const resumed = {
      id: meta.id,
      session: { id: meta.id, header: meta, events: driftedEvents },
      status: 'idle',
      ctx,
    } as unknown as Agent
    const dispose = vi.fn(() => Promise.resolve())
    vi.spyOn(ctx.agents, 'resume').mockResolvedValue({ agent: resumed, dispose })

    await expect(agents.ensureSessionHandle(meta.id, '/workspace', true, 'minimal'))
      .rejects.toBeInstanceOf(ApiSessionPresetConflict)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('never disposes an already-live Agent when post-resume preset validation fails', async () => {
    const { ctx, agents } = await harness()
    // Register the Agent as live *before* calling ensureSessionHandle, so
    // createOrAdopt takes the `adoptedHandle(live)` branch (`live !==
    // undefined`) instead of resuming -- this Agent was not freshly
    // activated by this call, and must never be torn down as a side effect
    // of a later validation failure.
    const meta = { ...header('already-live-preset-drift'), agentPreset: 'minimal' }
    const live = agent(ctx, meta)
    live.session.append('agent-preset/selected', { agentPreset: 'minimal' })
    const cancel = vi.fn()
    Object.assign(live, { cancel })
    ctx.agents.register(live)

    await expect(agents.ensureSessionHandle(meta.id, '/workspace', true, 'drifted'))
      .rejects.toBeInstanceOf(ApiSessionPresetConflict)
    // adoptedHandle(live).dispose() would call agent.cancel(...); since this
    // Agent was already live (not freshly activated), it must never be torn
    // down on a post-adoption validation failure.
    expect(cancel).not.toHaveBeenCalled()
  })

  it('rejects an ownership race before resume and a persisted cwd conflict', async () => {
    const child = await harness()
    const childMeta = header('resume-child-race')
    providePersistence(child.ctx, {
      list: () => Promise.resolve([childMeta]),
      inspect: () => Promise.resolve({ meta: childMeta, events: [] }),
    })
    child.ctx.provide('agentPresets', {
      resolve: () => {
        child.ctx.sessions.create(childMeta.id, {
          meta: { ...childMeta, parentSession: SessionId('parent'), origin: 'subagent' },
        })
        return Promise.resolve({ id: 'standard' })
      },
      mount: () => Promise.resolve(),
    } as never)
    await expect(child.agents.resolveAgent(childMeta.id)).resolves.toMatchObject({
      error: { code: 'session/agent-busy' },
    })

    const conflict = await harness()
    const stored = header('stored-cwd-conflict', '/stored')
    providePersistence(conflict.ctx, {
      list: () => Promise.resolve([stored]),
      inspect: () => Promise.resolve({ meta: stored, events: [] }),
    })
    await expect(conflict.agents.ensureSession(stored.id, '/requested', true))
      .rejects.toBeInstanceOf(ApiSessionCwdConflict)
  })

  it('surfaces directory creation failure', async () => {
    const { agents } = await harness()
    const parent = mkdtempSync(join(tmpdir(), 'dsh-session-controller-file-'))
    tempDirs.push(parent)
    const file = join(parent, 'file')
    writeFileSync(file, 'not a directory')
    await expect(agents.ensureSession(SessionId('mkdir-failure'), join(file, 'child'), false))
      .rejects.toThrow('failed to ensure project directory')
  })

  it('disposes a freshly created handle when post-creation cwd validation rejects it', async () => {
    const { ctx, agents } = await harness()
    const requestedCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-orphan-cwd-'))
    const meta = header('orphan-on-cwd-conflict', '/mismatched-cwd')
    const created = unpublishedAgent(ctx, meta)
    const dispose = vi.fn(() => Promise.resolve())
    vi.spyOn(ctx.agents, 'create').mockResolvedValue({ agent: created, dispose })

    await expect(agents.ensureSessionHandle(meta.id, requestedCwd, false))
      .rejects.toBeInstanceOf(ApiSessionCwdConflict)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('gives a joiner a no-op dispose while the primary keeps the real disposer', async () => {
    const { ctx, agents } = await harness()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-joiner-'))
    const meta = header('concurrent-handle-aliasing', cwd)
    const created = unpublishedAgent(ctx, meta)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const dispose = vi.fn(() => Promise.resolve())
    vi.spyOn(ctx.agents, 'create').mockImplementation(async () => {
      await gate
      return { agent: created, dispose }
    })

    const first = agents.ensureSessionHandle(meta.id, cwd, false)
    const second = agents.ensureSessionHandle(meta.id, cwd, false)
    release()

    const [primaryHandle, joinerHandle] = await Promise.all([first, second])
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock does not use `this`
    expect(primaryHandle.dispose).not.toBe(joinerHandle.dispose)

    await joinerHandle.dispose()
    expect(dispose).not.toHaveBeenCalled()

    await primaryHandle.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('never disposes an already-live Agent when post-adoption validation rejects it', async () => {
    const { ctx, agents } = await harness()
    // Register the Agent as live *before* calling ensureSessionHandle, so
    // createOrAdopt takes the `adoptedHandle(live)` branch instead of creating
    // or resuming — this Agent was not freshly activated by this call.
    const meta = header('already-live-cwd-conflict', '/mismatched-cwd')
    const live = agent(ctx, meta)
    const cancel = vi.fn()
    Object.assign(live, { cancel })
    ctx.agents.register(live)

    await expect(agents.ensureSessionHandle(meta.id, '/requested-cwd', false))
      .rejects.toBeInstanceOf(ApiSessionCwdConflict)
    // adoptedHandle(live).dispose() would call agent.cancel(...); since this
    // Agent was already live (not freshly activated), it must never be torn
    // down on a post-adoption validation failure.
    expect(cancel).not.toHaveBeenCalled()
  })

  it('disposes a freshly created handle when post-creation ownership validation rejects it', async () => {
    const { ctx, agents } = await harness()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-orphan-ownership-'))
    const meta = {
      ...header('orphan-on-ownership-conflict', cwd),
      parentSession: SessionId('parent'),
      origin: 'subagent' as const,
    }
    const created = unpublishedAgent(ctx, meta)
    const dispose = vi.fn(() => Promise.resolve())
    vi.spyOn(ctx.agents, 'create').mockResolvedValue({ agent: created, dispose })

    await expect(agents.ensureSessionHandle(meta.id, cwd, false))
      .rejects.toBeInstanceOf(ApiSessionSubagentOwnership)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('disposes a freshly created handle when post-creation preset validation rejects it', async () => {
    const { ctx, agents } = await harness()
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-orphan-preset-'))
    const meta = header('orphan-on-preset-conflict', cwd)
    const events = [{
      type: 'agent-preset/selected',
      seq: 0,
      time: 1,
      data: { agentPreset: 'existing-preset' },
    }] as SessionEvent[]
    const created = {
      id: meta.id,
      session: { id: meta.id, header: meta, events },
      status: 'idle',
      ctx,
    } as unknown as Agent
    const dispose = vi.fn(() => Promise.resolve())
    vi.spyOn(ctx.agents, 'create').mockResolvedValue({ agent: created, dispose })

    await expect(agents.ensureSessionHandle(meta.id, cwd, false, 'requested-preset'))
      .rejects.toBeInstanceOf(ApiSessionPresetConflict)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('recovers a raced concurrently-created live Agent as a weak adopted handle', async () => {
    const { ctx, agents } = await harness()
    // The primary's own creation attempt rejects below, but by then some other
    // concurrent path has already registered a live Agent for this sessionId
    // — the race carved out by ensureSessionHandle's doc comment. There is no
    // way to recover a real disposer for an Agent this call did not itself
    // activate, so the primary must fall back to the weak, cancel()-only
    // adoptedHandle rather than the strong disposer it otherwise promises.
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-raced-adoption-'))
    const meta = header('raced-adoption-recovery', cwd)
    const live = agent(ctx, meta)
    const cancel = vi.fn()
    Object.assign(live, { cancel })
    vi.spyOn(ctx.agents, 'create').mockImplementation(async () => {
      ctx.agents.register(live)
      throw new Error('raced creation')
    })

    const handle = await agents.ensureSessionHandle(meta.id, cwd, false)
    expect(handle.agent).toBe(live)

    await handle.dispose()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not hand a joiner a usable handle while the primary is still disposing an invalid Agent', async () => {
    const { ctx, agents } = await harness()
    const actualCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-race1-actual-'))
    const primaryCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-race1-primary-'))
    const meta = header('race1-joiner-during-dispose', actualCwd)
    const created = unpublishedAgent(ctx, meta)

    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
    let releaseDispose!: () => void
    const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve })
    const dispose = vi.fn(() => disposeGate)
    vi.spyOn(ctx.agents, 'create').mockImplementation(async () => {
      await createGate
      return { agent: created, dispose }
    })

    // The primary requests a cwd that will not match the created Agent's
    // actual cwd, so its post-creation validation fails and it must dispose
    // the freshly-created handle.
    const primary = agents.ensureSessionHandle(meta.id, primaryCwd, false)
    // The joiner requests the Agent's ACTUAL cwd, so its own validation would
    // independently succeed -- it must still not receive a usable handle
    // while the primary's dispose of that same Agent is still in flight.
    const joiner = agents.ensureSessionHandle(meta.id, actualCwd, false)

    let joinerSettled = false
    joiner.then(() => { joinerSettled = true }, () => { joinerSettled = true })

    releaseCreate()
    // Wait for the shared creation to settle, the primary's post-creation cwd
    // validation to run and throw, and dispose() (now blocked on disposeGate)
    // to have been invoked. A single setTimeout(0) tick only flushes
    // already-queued microtasks and can miss this under system load if any
    // step along the way yields a real macrotask; poll instead.
    await vi.waitFor(() => {
      expect(dispose).toHaveBeenCalledOnce()
    })

    // This is the race: a correct implementation must not let the joiner
    // settle before the primary's dispose of the same Agent completes.
    expect(joinerSettled).toBe(false)

    releaseDispose()
    await expect(primary).rejects.toBeInstanceOf(ApiSessionCwdConflict)
    // The joiner must never silently succeed with a handle to an Agent that
    // was mid-teardown -- it must reach a definitive failure instead.
    await expect(joiner).rejects.toBeInstanceOf(Error)
  })

  it('does not let a later, independent caller observe a live handle before the primary\'s teardown settles', async () => {
    const { ctx, agents } = await harness()
    const actualCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-race2-actual-'))
    const primaryCwd = mkdtempSync(join(tmpdir(), 'dsh-session-controller-race2-primary-'))
    const meta = header('race2-intruder-during-dispose', actualCwd)

    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
    let releaseDispose!: () => void
    const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve })

    let unregisterAgent: (() => void) | undefined
    let intruder: Promise<AgentHandle> | undefined
    let intruderSettled = false
    let disposeReleased = false

    vi.spyOn(ctx.agents, 'create').mockImplementation(async () => {
      await createGate
      const created = agent(ctx, meta)
      unregisterAgent = ctx.agents.register(created)
      return {
        agent: created,
        dispose: vi.fn(async () => {
          // By the time dispose() is invoked, the primary's post-creation cwd
          // validation has already thrown, which only happens after the
          // shared `creations` map entry for this sessionId was already
          // deleted (it is deleted as soon as createOrAdopt settles, before
          // validation runs). The Agent is still registered live at this
          // exact instant -- this is the window a genuinely new, independent
          // caller can arrive in. Start it here, before this dispose() call
          // resolves, so it is a fresh call rather than one already awaiting
          // the primary's `creation` promise.
          intruder = agents.ensureSessionHandle(meta.id, actualCwd, false)
          intruder.then(() => { intruderSettled = true }, () => { intruderSettled = true })
          await disposeGate
          disposeReleased = true
          unregisterAgent?.()
        }),
      }
    })

    const primary = agents.ensureSessionHandle(meta.id, primaryCwd, false)
    releaseCreate()

    // Wait for the primary's creation to settle (deleting the `creations`
    // map entry), its post-creation cwd validation to fail, and dispose() --
    // which starts the intruder call above -- to have been invoked and be
    // blocked on disposeGate. A single setTimeout(0) tick only flushes
    // already-queued microtasks and can miss this under system load if any
    // step along the way yields a real macrotask; poll instead.
    await vi.waitFor(() => {
      expect(intruder).toBeDefined()
    })

    // This is the race: a correct implementation must make the later,
    // independent caller wait for the primary's full settle (creation +
    // validation + dispose), not observe a live handle while the Agent is
    // still being torn down.
    expect(intruderSettled).toBe(false)

    releaseDispose()
    await expect(primary).rejects.toBeInstanceOf(ApiSessionCwdConflict)
    // Because the widened lock keeps the `creations` entry populated across
    // creation + validation + dispose, the intruder finds it still present
    // and joins the primary's own shared promise rather than starting an
    // independent attempt. It therefore shares the primary's fate and also
    // rejects, instead of going on to independently validate against its own
    // (matching) actualCwd -- which is the safe outcome, since the
    // underlying Agent was already slated for disposal either way.
    await expect(intruder).rejects.toBeInstanceOf(ApiSessionCwdConflict)
    expect(disposeReleased).toBe(true)
    expect(intruderSettled).toBe(true)
  })
})
