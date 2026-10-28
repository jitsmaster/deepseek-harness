import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestPayload } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const PAYLOAD: RequestPayload = {
  argv: ['claude', '-p'],
  envKeys: ['PATH'],
  system: 'be brief',
  tools: [],
  stdin: 'hello',
}

function reporting(text: string): (options: GenerateOptions) => ReturnType<typeof textResponse> {
  return (options) => {
    options.onRequest?.(PAYLOAD)
    return textResponse(text)
  }
}

async function run(script: ConstructorParameters<typeof MockAdapter>[0], tweak?: (ctx: Context, root: string) => void | Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-request-payload-'))
  dirs.push(root)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  await tweak?.(ctx, root)
  const id = SessionId('payload-loop')
  await ctx.plugin(AgentLoop, { agents: [{ id: 'main', sessionId: id, provider: 'mock', model: 'mock' }] })
  await expect.poll(() => ctx.agents.get(id), { timeout: 5_000 }).toBeDefined()
  const agent = ctx.agents.get(id)!
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const payloadEvents = events.filter(event => event.type === 'request/payload')
  const assistant = events.filter(event => event.type === 'assistant/message')
  return { ctx, root, payloadEvents, assistant, errors }
}

describe('request payload sidecar in the loop', () => {
  it('appends request/payload pointing at the written blob', async () => {
    const { ctx, root, payloadEvents, errors } = await run([reporting('ok')])
    expect(errors).toEqual([])
    expect(payloadEvents).toHaveLength(1)
    const data = payloadEvents[0]!.data
    expect(data.turn).toBe(1)
    expect(data.step).toBe(1)
    expect(data.blob).toMatch(/^[\w.-]+\.json\.gz$/)
    expect(data.truncated).toBeUndefined()
    const dir = ctx.sessionPersistence.sessionDirectory({ id: SessionId('payload-loop') })
    expect(dir?.startsWith(root)).toBe(true)
    const stored: unknown = JSON.parse(gunzipSync(await readFile(join(dir ?? '', 'payloads', data.blob))).toString())
    expect(stored).toEqual(PAYLOAD)
    expect(data.bytes).toBe(Buffer.byteLength(JSON.stringify(PAYLOAD)))
    await ctx.fiber.dispose()
  })

  it('never fails the turn when the sink cannot write, and appends no event', async () => {
    const { ctx, payloadEvents, assistant, errors } = await run([reporting('ok')], async (c, root) => {
      const blocker = join(root, 'blocker')
      await writeFile(blocker, 'x')
      vi.spyOn(c.sessionPersistence, 'sessionDirectory').mockImplementation(() => join(blocker, 'nested'))
    })
    expect(errors).toEqual([])
    expect(assistant).toHaveLength(1)
    expect(payloadEvents).toEqual([])
    await ctx.fiber.dispose()
  })

  it('never fails the turn when the session directory lookup throws', async () => {
    const { ctx, payloadEvents, assistant, errors } = await run([reporting('ok')], (c) => {
      vi.spyOn(c.sessionPersistence, 'sessionDirectory').mockImplementation(() => { throw new Error('boom') })
    })
    expect(errors).toEqual([])
    expect(assistant).toHaveLength(1)
    expect(payloadEvents).toEqual([])
    await ctx.fiber.dispose()
  })

  it('appends nothing when the adapter never reports a payload', async () => {
    const { ctx, payloadEvents, assistant, errors } = await run([textResponse('ok')])
    expect(errors).toEqual([])
    expect(assistant).toHaveLength(1)
    expect(payloadEvents).toEqual([])
    await ctx.fiber.dispose()
  })
})
