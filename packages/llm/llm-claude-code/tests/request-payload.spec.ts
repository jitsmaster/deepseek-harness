import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestPayload, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { ClaudeCodeLlmAdapter, CLAUDE_CODE_LLM_PROVIDER_ID } from '../src/adapter.ts'
import { renderStdin, renderSystemText } from '../src/transcript.ts'
import { FakeClaudeSubprocess, readRuns, subprocessContext } from './harness.ts'

let ctx: Context
let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-claude-llm-payload-'))
  FakeClaudeSubprocess.logPath = join(scratch, 'runs.jsonl')
  FakeClaudeSubprocess.spawned = []
  ctx = await subprocessContext()
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function makeAdapter(overrides: Partial<ConstructorParameters<typeof ClaudeCodeLlmAdapter>[0]> = {}): ClaudeCodeLlmAdapter {
  return new ClaudeCodeLlmAdapter({
    executable: process.execPath,
    timeoutMs: 60_000,
    defaultContextWindow: 200_000,
    models: [],
    spawn: spec => ctx.subprocess.spawn(spec),
    ...overrides,
  })
}

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: CLAUDE_CODE_LLM_PROVIDER_ID,
    model: 'sonnet',
    messages: [
      createSystemMessage('You are DSH.'),
      createUserMessage({ content: [{ type: 'text', text: 'hello scenario:text' }], source: { kind: 'user' } }),
    ],
    ...extra,
  }
}

async function collect(adapter: ClaudeCodeLlmAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

const READ: ToolSchema = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }

describe('onRequest payload hook', () => {
  it('reports the exact payload with env key names only', async () => {
    const payloads: RequestPayload[] = []
    const options = request({ tools: [READ], onRequest: (payload) => { payloads.push(payload) } })
    await collect(makeAdapter({ resolveEnv: () => Promise.resolve({ SECRET: 'hunter2-value' }) }), options)

    expect(payloads).toHaveLength(1)
    const payload = payloads[0]!
    expect(payload.system).toBe(renderSystemText(options))
    expect(payload.stdin).toBe(renderStdin(options.messages))
    expect(payload.envKeys).toEqual(['SECRET'])
    expect(JSON.stringify(payload)).not.toContain('hunter2-value')
    const run = readRuns().find(entry => entry.argv !== undefined)!
    expect(payload.argv).toEqual(FakeClaudeSubprocess.spawned[0]!.argv)
    expect(payload.tools).toEqual(JSON.parse(run.files.tools!))
    expect(payload.tools).toHaveLength(1)
    expect(run.files.system).toBe(payload.system)
    expect(run.stdin).toBe(payload.stdin)
  })

  it('reports an empty tools list when there are none', async () => {
    const payloads: RequestPayload[] = []
    await collect(makeAdapter(), request({ onRequest: (payload) => { payloads.push(payload) } }))
    expect(payloads[0]!.tools).toEqual([])
    expect(payloads[0]!.envKeys).toEqual([])
  })

  it('does not fail the call when the hook throws', async () => {
    const chunks = await collect(makeAdapter(), request({ onRequest: () => { throw new Error('observer broke') } }))
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('behaves unchanged without a hook', async () => {
    const chunks = await collect(makeAdapter(), request())
    expect(chunks.length).toBeGreaterThan(0)
  })
})
