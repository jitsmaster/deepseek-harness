/**
 * REAL composition: a test-only cordis.yml booted through the Loader mounts the
 * LLM runtime, the subprocess runtime, and this adapter. Only the external
 * `claude` binary is faked (see harness.ts); the model call runs through
 * `ctx.llm.stream` and the production subprocess code.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as ClaudeCodeLlm from '../src/index.ts'
import { FakeClaudeSubprocess, readRuns } from './harness.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  root = undefined
})

/** Boot the cordis.yml with the adapter's config lines. */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-llm-claude-loader-'))
  FakeClaudeSubprocess.logPath = join(root, 'runs.jsonl')
  FakeClaudeSubprocess.spawned = []
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'test-llm-service'",
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-llm-claude-code'",
    '  config:',
    ...configLines,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime],
    ['@deepseek-ai/dsh-subprocess-local', FakeClaudeSubprocess],
    ['@deepseek-ai/dsh-llm-claude-code', ClaudeCodeLlm],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

const executableLine = (): string => `    executable: ${JSON.stringify(process.execPath)}`

describe('llm-claude-code real Loader composition through cordis.yml', () => {
  it('registers the route, lists models, and prepares a call from the loaded config', async () => {
    const ctx = await boot([executableLine(), '    defaultContextWindow: 150000', '    models:', '      - id: my-claude', '        name: My Claude'])
    expect(ctx.llm.listProviders()).toContainEqual({ id: 'claude-code', name: 'Claude Code' })
    expect((await ctx.llm.listModels('claude-code')).map(model => model.id)).toEqual(expect.arrayContaining(['claude-sonnet-5-5', 'haiku', 'my-claude']))
    const prepared = await ctx.llm.prepareCall({ provider: 'claude-code', model: 'my-claude', reasoningEffort: 'high' as never })
    expect(prepared.context).toEqual({ contextWindow: 150_000 })
    expect(prepared.inputModalities).toEqual(['text', 'image'])
    expect(prepared.config.reasoningEffort).toBe('high')
  }, 30_000)

  it('serves one model call as one headless claude run', async () => {
    const ctx = await boot([executableLine(), '    timeoutMs: 60000'])
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'claude-code',
      model: 'claude-sonnet-5-5',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'say hello scenario:text' }], source: { kind: 'user' } })],
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    const runs = readRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.argv).toContain('claude-sonnet-5-5')
    expect(runs[0]?.stdin).toContain('say hello')
  }, 30_000)

  it('surfaces a failed run as a terminal error finish carrying the provider code', async () => {
    const ctx = await boot([executableLine()])
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'claude-code',
      model: 'sonnet',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'x scenario:loggedout' }], source: { kind: 'user' } })],
    })) chunks.push(chunk)
    const finish = chunks.at(-1)
    expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } })
  }, 30_000)

  it('reports a missing executable as a terminal error finish', async () => {
    const ctx = await boot(['    executable: dsh-no-such-claude-binary'])
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'claude-code',
      model: 'sonnet',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } })],
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'PROVIDER_UNAVAILABLE' } } })
    expect(readRuns()).toEqual([])
  }, 30_000)
})
