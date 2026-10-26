import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiSessionAgentController,
  ApiSessionCwdConflict,
  ApiSessionPresetConflict,
  ApiSessionPresetMismatch,
} from '../src/agent.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const roots: Context[] = []
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
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  await ctx.sessionProjections.register(agentPresetProjectionDefinition)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  const agents = new ApiSessionAgentController(ctx)
  agents.initialize()
  return { ctx, agents }
}

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ensure-handle-'))
  tempDirs.push(dir)
  return dir
}

function header(id: string, cwd: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false, cwd }
}

/** An Agent stand-in that records `cancel` calls; its session carries only the header. */
function stubAgent(ctx: Context, meta: SessionHeader): Agent {
  return {
    id: meta.id,
    session: { id: meta.id, header: meta, events: [] },
    status: 'idle',
    ctx,
    cancel: vi.fn(),
  } as unknown as Agent
}

describe('ApiSessionAgentController.ensureSessionHandle', () => {
  it('creates a missing Session and returns its real disposer', async () => {
    const { ctx, agents } = await harness()
    const cwd = tempCwd()
    const meta = header('fresh', cwd)
    const created = stubAgent(ctx, meta)
    const dispose = vi.fn(() => Promise.resolve())
    const create = vi.spyOn(ctx.agents, 'create').mockResolvedValue({ agent: created, dispose })

    const handle = await agents.ensureSessionHandle(meta.id, cwd, false)

    expect(handle.agent).toBe(created)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: meta.id }))
    await handle.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('disposes the Agent it activated when the published cwd differs from the requested one', async () => {
    const { ctx, agents } = await harness()
    const requested = tempCwd()
    const wrong = stubAgent(ctx, header('wrong-cwd', '/elsewhere'))
    const dispose = vi.fn(() => Promise.resolve())
    vi.spyOn(ctx.agents, 'create').mockResolvedValue({ agent: wrong, dispose })

    await expect(agents.ensureSessionHandle(wrong.id, requested, false))
      .rejects.toBeInstanceOf(ApiSessionCwdConflict)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('adopts an already-live Agent with a cancel-only handle instead of creating one', async () => {
    const { ctx, agents } = await harness()
    const cwd = tempCwd()
    const live = stubAgent(ctx, header('already-live', cwd))
    await ctx.agents.register(live)
    const create = vi.spyOn(ctx.agents, 'create')

    const handle = await agents.ensureSessionHandle(live.id, cwd, false)

    expect(handle.agent).toBe(live)
    expect(create).not.toHaveBeenCalled()
    await handle.dispose()
    expect(live.cancel).toHaveBeenCalledWith({ kind: 'disposed' })
  })

  it('never disposes an adopted live Agent when validation fails', async () => {
    const { ctx, agents } = await harness()
    const live = stubAgent(ctx, header('live-wrong-cwd', '/elsewhere'))
    await ctx.agents.register(live)

    await expect(agents.ensureSessionHandle(live.id, tempCwd(), false))
      .rejects.toBeInstanceOf(ApiSessionCwdConflict)
    expect(live.cancel).not.toHaveBeenCalled()
  })

  it('shares one activation between concurrent callers and gives joiners a no-op disposer', async () => {
    const { ctx, agents } = await harness()
    const cwd = tempCwd()
    const meta = header('shared', cwd)
    const created = stubAgent(ctx, meta)
    const dispose = vi.fn(() => Promise.resolve())
    const create = vi.spyOn(ctx.agents, 'create').mockResolvedValue({ agent: created, dispose })

    const [primary, joiner] = await Promise.all([
      agents.ensureSessionHandle(meta.id, cwd, false),
      agents.ensureSessionHandle(meta.id, cwd, false),
    ])

    expect(create).toHaveBeenCalledOnce()
    expect(joiner.agent).toBe(primary.agent)
    await joiner.dispose()
    expect(dispose).not.toHaveBeenCalled()
    await primary.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('refuses a persisted Session recorded under a different preset', async () => {
    const { ctx, agents } = await harness()
    const cwd = tempCwd()
    const meta = { ...header('stored', cwd), agentPreset: 'minimal' }
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([meta]),
      inspect: () => Promise.resolve({
        meta,
        events: [{ type: 'agent-preset/selected', seq: 0, time: 1, data: { agentPreset: 'minimal' } }] as never,
      }),
    }) as never)
    ctx.provide('agentPresets', {
      resolve: (id?: string) => Promise.resolve({ id: id ?? 'minimal' }),
      mount: () => Promise.resolve(),
    } as never)
    const resume = vi.spyOn(ctx.agents, 'resume')

    const failure = await agents.ensureSessionHandle(meta.id, cwd, true, 'other').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiSessionPresetConflict)
    expect(failure).toBeInstanceOf(ApiSessionPresetMismatch)
    expect((failure as ApiSessionPresetMismatch).existingPreset).toBe('minimal')
    expect(resume).not.toHaveBeenCalled()
  })
})
