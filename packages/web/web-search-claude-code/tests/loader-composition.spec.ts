/**
 * REAL composition: a test-only cordis.yml booted through the Loader mounts web, the
 * subprocess runtime, this provider (pinned by `web.searchProvider`), and tool-web.
 * Only the external `claude` binary is faked (see harness.ts); the model-facing
 * `web_search` tool runs through the tool registry and its formatted output is asserted.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as ClaudeCodeSearch from '../src/index.ts'
import { FakeClaudeSubprocess, readRuns } from './harness.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const agent = { id: SessionId('claude-code-search-composition') } as Agent

/** Boot the cordis.yml and bind a session scope so the conditional web_search tool is admitted. */
async function boot(searchProviderLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-ws-claude-loader-'))
  FakeClaudeSubprocess.logPath = join(root, 'runs.jsonl')
  FakeClaudeSubprocess.spawned = []
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-executor-native'",
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-web'",
    '  config:',
    '    searchProvider: claude-code',
    "- name: '@deepseek-ai/dsh-web-search-claude-code'",
    '  config:',
    ...searchProviderLines,
    "- name: '@deepseek-ai/dsh-tool-web'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-subprocess-local', FakeClaudeSubprocess],
    ['@deepseek-ai/dsh-web', WebRuntime],
    ['@deepseek-ai/dsh-web-search-claude-code', ClaudeCodeSearch],
    ['@deepseek-ai/dsh-tool-web', ToolWeb],
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
  await ctx.plugin(Object.assign((inner: Context) => { createScope(inner, agent) }, { inject: ['tools'] }))
  return ctx
}

let counter = 0
async function webSearch(ctx: Context, queries: string[]): Promise<ToolExecutionResult> {
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'test', model: 'test' }, signal })
  try {
    return await executeToolFixture(ctx, { agent, toolSet, signal, callId: ToolCallId(`call-${++counter}`), name: 'web_search', arguments: { queries } })
  } finally {
    toolSet.dispose()
  }
}

function text(result: ToolExecutionResult): string {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('')
}

const executableLine = (): string => `    executable: ${JSON.stringify(process.execPath)}`

describe('web-search-claude-code real Loader composition through cordis.yml', () => {
  it('serves the model-facing web_search tool from one headless claude run per query', async () => {
    const ctx = await boot([executableLine(), '    model: sonnet'])
    const result = await webSearch(ctx, ['scenario:success'])
    expect(result.isError).toBe(false)
    const output = text(result)
    expect(output).toContain('Alpha says A. See https://a.example/.')
    expect(output).toContain('Sources:')
    expect(output).toContain('- [Alpha](https://a.example/)')
    expect(output).toContain('- [Beta](https://b.example/)')
    expect(output).toContain('- [Gamma](https://c.example/)')
    expect(output).toContain('Cite the relevant URLs above as markdown links in your answer.')

    const runs = readRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]?.argv).toContain('WebSearch')
    expect(runs[0]?.argv.slice(-2)).toEqual(['--model', 'sonnet'])
    expect(runs[0]?.stdin).toContain('scenario:success')
  }, 30_000)

  it('runs several queries as concurrent processes and merges their sources', async () => {
    const ctx = await boot([executableLine()])
    const result = await webSearch(ctx, ['scenario:success', 'scenario:twice'])
    expect(result.isError).toBe(false)
    expect(readRuns()).toHaveLength(2)
    const output = text(result)
    expect(output).toContain('### scenario:success')
    expect(output).toContain('### scenario:twice')
    expect(output.match(/\(https:\/\/a\.example\/\)/g)).toHaveLength(1)
  }, 30_000)

  it('surfaces a failed run as a structured tool error carrying the provider code', async () => {
    const ctx = await boot([executableLine()])
    const result = await webSearch(ctx, ['scenario:exit3'])
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('WEB_PROVIDER_ERROR')
    expect(text(result)).toContain('exited with code 3')
  }, 30_000)

  it('has no usable provider when the configured executable is missing', async () => {
    const ctx = await boot(['    executable: dsh-no-such-claude-binary'])
    expect(await ctx.web.searchReady()).toBe(true)
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' })
    expect(readRuns()).toEqual([])
  }, 30_000)
})
