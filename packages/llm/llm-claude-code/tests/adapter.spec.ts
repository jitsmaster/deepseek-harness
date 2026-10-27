import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createSystemMessage, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { ClaudeCodeLlmAdapter, CLAUDE_CODE_LLM_PROVIDER_ID } from '../src/adapter.ts'
import { STUB_SOURCE } from '../src/stub.ts'
import { alive, FakeClaudeSubprocess, readRuns, subprocessContext } from './harness.ts'
import type { FakeRun } from './harness.ts'

let ctx: Context
let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-claude-llm-spec-'))
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

function request(scenario: string, extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: CLAUDE_CODE_LLM_PROVIDER_ID,
    model: 'sonnet',
    messages: [
      createSystemMessage('You are DSH.'),
      createUserMessage({ content: [{ type: 'text', text: `hello scenario:${scenario}` }], source: { kind: 'user' } }),
    ],
    ...extra,
  }
}

async function collect(adapter: ClaudeCodeLlmAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

async function failure(adapter: ClaudeCodeLlmAdapter, options: GenerateOptions): Promise<LlmError> {
  try {
    await collect(adapter, options)
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(LlmError)
    return error as LlmError
  }
  throw new Error('expected the stream to throw')
}

const READ: ToolSchema = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
const BASH: ToolSchema = { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }

async function waitForHang(): Promise<FakeRun> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const run = readRuns().find(entry => entry.hanging !== undefined)
    if (run !== undefined) return run
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the fake never hung')
}

function firstRun(): FakeRun {
  const run = readRuns().find(entry => entry.argv !== undefined)
  if (run === undefined) throw new Error('no run was logged')
  return run
}

describe('ClaudeCodeLlmAdapter text answer', () => {
  it('streams a plain answer, then usage, then one stop finish', async () => {
    const chunks = await collect(makeAdapter(), request('text'))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hello ' },
      { type: 'text-delta', index: 0, text: 'world' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } },
      { type: 'usage', usage: { inputTokens: 3, cacheReadTokens: 20, cacheWriteTokens: 10, outputTokens: 7, reasoningTokens: 2, totalTokens: 40 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  }, 30_000)

  it('runs claude with exactly the headless, tool-free, settings-free flags and the prompt on stdin', async () => {
    await collect(makeAdapter(), request('text'))
    const spec = FakeClaudeSubprocess.spawned[0]
    expect(spec?.argv[0]).toBe(process.execPath)
    const run = firstRun()
    expect(run.argv).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--no-session-persistence',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--tools', '',
      '--permission-mode', 'dontAsk',
      '--system-prompt-file', join(run.cwd, 'system.txt'),
      '--model', 'sonnet',
    ])
    expect(run.argv).not.toContain('--mcp-config')
    expect(run.argv).not.toContain('--safe-mode')
    expect(run.argv).not.toContain('--bare')
    expect(run.argv).not.toContain('--effort')
    expect(run.stdin).toContain('<conversation>')
    expect(run.stdin).toContain('<user>\nhello scenario:text\n</user>')
    expect(run.stdin.endsWith('Continue as the assistant.')).toBe(true)
    expect(run.cwdEntries).toEqual(['system.txt'])
    expect(run.files.system).toContain('You are DSH.')
    expect(run.files.system).toContain('The conversation so far is given to you as a transcript inside <conversation>')
    expect(spec?.stdio.stdin).toEqual({ data: run.stdin })
  }, 30_000)

  it('passes the model verbatim and the reasoning effort as --effort', async () => {
    await collect(makeAdapter(), request('text', { model: 'claude-sonnet-5-5', reasoningEffort: 'xhigh' as GenerateOptions['reasoningEffort'] }))
    const argv = firstRun().argv
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 4)).toEqual(['--model', 'claude-sonnet-5-5', '--effort', 'xhigh'])
  }, 30_000)

  it('maps maxTokens to the output-token env var and ignores temperature and stop', async () => {
    await collect(makeAdapter(), request('text', { maxTokens: 4096, temperature: 0.3, stop: ['END'] }))
    const run = firstRun()
    expect(run.maxOutputTokens).toBe('4096')
    expect(run.argv.join(' ')).not.toMatch(/temperature|stop|END/u)
    expect(FakeClaudeSubprocess.spawned[0]?.env).toMatchObject({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096' })

    await collect(makeAdapter(), request('text'))
    expect(readRuns().at(-1)?.maxOutputTokens).toBeUndefined()
  }, 30_000)

  it('passes nothing extra when no env resolver is configured', async () => {
    await collect(makeAdapter(), request('text'))
    const run = firstRun()
    expect(run.oauthToken).toBeUndefined()
    expect(run.apiKey).toBeUndefined()
    expect(FakeClaudeSubprocess.spawned[0]?.env).toBeUndefined()
  }, 30_000)

  it('merges the resolved env into the child env beside the output-token cap, resolving per call', async () => {
    let calls = 0
    const adapter = makeAdapter({
      resolveEnv: () => Promise.resolve({ CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat-fake-${++calls}` }),
    })
    await collect(adapter, request('text', { maxTokens: 512 }))
    await collect(adapter, request('text'))
    const [first, second] = readRuns()
    expect(first).toMatchObject({ oauthToken: 'sk-ant-oat-fake-1', maxOutputTokens: '512' })
    expect(second).toMatchObject({ oauthToken: 'sk-ant-oat-fake-2' })
    expect(second?.maxOutputTokens).toBeUndefined()
    expect(FakeClaudeSubprocess.spawned[0]?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-fake-1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '512' })
  }, 30_000)

  it('passes an api key through ANTHROPIC_API_KEY', async () => {
    await collect(makeAdapter({ resolveEnv: () => Promise.resolve({ ANTHROPIC_API_KEY: 'sk-ant-fake' }) }), request('text'))
    expect(firstRun().apiKey).toBe('sk-ant-fake')
  }, 30_000)

  it('uses the same tool-free path for compaction and title requests', async () => {
    await collect(makeAdapter(), request('text', { purpose: 'compaction' }))
    await collect(makeAdapter(), request('text', { purpose: 'session-title' }))
    for (const run of readRuns()) expect(run.argv).not.toContain('--mcp-config')
  }, 30_000)

  it('removes the temp directory once the run is over', async () => {
    await collect(makeAdapter(), request('text'))
    const run = firstRun()
    expect(run.cwd.startsWith(tmpdir())).toBe(true)
    expect(existsSync(run.cwd)).toBe(false)
  }, 30_000)

  it('drops a thinking block that stayed empty', async () => {
    const chunks = await collect(makeAdapter(), request('thinking'))
    expect(chunks.map(chunk => chunk.type)).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
  }, 30_000)

  it('maps max_tokens to a max-tokens finish', async () => {
    const chunks = await collect(makeAdapter(), request('maxtokens'))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  }, 30_000)
})

describe('ClaudeCodeLlmAdapter plan-usage reading', () => {
  const READING = {
    fiveHour: { utilization: 0.25, resetsAt: 1793134800 },
    sevenDay: { utilization: 0.5, resetsAt: 1793232000 },
  }

  it('reports the reading once when a run finishes', async () => {
    const readings: unknown[] = []
    const chunks = await collect(makeAdapter({ onRateLimit: (reading) => { readings.push(reading) } }), request('ratelimited'))
    expect(readings).toEqual([READING])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  }, 30_000)

  it('reports nothing when the stream carried no rate_limit_event', async () => {
    const readings: unknown[] = []
    await collect(makeAdapter({ onRateLimit: (reading) => { readings.push(reading) } }), request('text'))
    expect(readings).toEqual([])
  }, 30_000)

  it('reports a reading already seen on the tool-call early-termination path', async () => {
    const readings: unknown[] = []
    const chunks = await collect(makeAdapter({ onRateLimit: (reading) => { readings.push(reading) } }), request('ratelimitedtool', { tools: [READ] }))
    expect(readings).toEqual([READING])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  }, 30_000)

  it('reports a reading that arrives just after the tool-call stop (the real Claude order)', async () => {
    const readings: unknown[] = []
    const chunks = await collect(makeAdapter({ onRateLimit: (reading) => { readings.push(reading) } }), request('ratelimitedtoollate', { tools: [READ] }))
    expect(readings).toEqual([READING])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  }, 30_000)

  it('does not wait for a reading that has not arrived on the tool-call path', async () => {
    const readings: unknown[] = []
    await collect(makeAdapter({ onRateLimit: (reading) => { readings.push(reading) } }), request('tool', { tools: [READ] }))
    expect(readings).toEqual([])
  }, 30_000)

  it('reports the reading of a failed run too, and still throws the run failure', async () => {
    const readings: unknown[] = []
    const error = await failure(makeAdapter({ onRateLimit: (reading) => { readings.push(reading) } }), request('ratelimitedfail'))
    expect(error.code).toBe('SERVER')
    expect(readings).toEqual([READING])
  }, 30_000)

  it('swallows an observer that throws', async () => {
    const chunks = await collect(makeAdapter({ onRateLimit: () => { throw new Error('observer broke') } }), request('ratelimited'))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  }, 30_000)
})

describe('ClaudeCodeLlmAdapter tools', () => {
  it('exposes the tools through a never-answering MCP stub', async () => {
    await collect(makeAdapter(), request('text', { tools: [READ, BASH, { ...READ, name: 'edit', deferLoading: true, parameters: { properties: {} } }] }))
    const run = firstRun()
    expect(run.argv.slice(-4)).toEqual(['--mcp-config', join(run.cwd, 'mcp.json'), '--allowedTools', 'mcp__dsh'])
    expect(run.argv).toContain('--strict-mcp-config')
    expect(run.cwdEntries).toEqual(['mcp.json', 'system.txt', 'tools.json'])
    expect(JSON.parse(run.files.mcp ?? '')).toEqual({
      mcpServers: { dsh: { command: process.execPath, args: ['-e', STUB_SOURCE, join(run.cwd, 'tools.json')], env: { ELECTRON_RUN_AS_NODE: '1' } } },
    })
    expect(JSON.parse(run.files.tools ?? '')).toEqual([
      { name: 'read', description: 'Read a file', inputSchema: READ.parameters },
      { name: 'bash', description: 'Run a command', inputSchema: BASH.parameters },
      { name: 'edit', description: 'Read a file', inputSchema: { type: 'object', properties: {} } },
    ])
  }, 30_000)

  it('uses the configured node executable for the stub', async () => {
    await collect(makeAdapter({ nodeExecutable: 'C:\\custom\\node.exe' }), request('text', { tools: [READ] }))
    expect((JSON.parse(firstRun().files.mcp ?? '') as { mcpServers: { dsh: { command: string } } }).mcpServers.dsh.command).toBe('C:\\custom\\node.exe')
  }, 30_000)

  it('finishes with tool-calls and kills claude without waiting for its next turn', async () => {
    const started = Date.now()
    const chunks = await collect(makeAdapter(), request('tool', { tools: [READ] }))
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'toolu_1', name: 'read', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 0, id: 'toolu_1', argumentsDelta: '{"path":' },
      { type: 'tool-call-delta', index: 0, id: 'toolu_1', argumentsDelta: '"a.txt"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'toolu_1', name: 'read', arguments: '{"path":"a.txt"}' } },
      { type: 'usage', usage: { inputTokens: 3, cacheReadTokens: 20, cacheWriteTokens: 10, outputTokens: 7, reasoningTokens: 2, totalTokens: 40 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    const hang = await waitForHang()
    expect(alive(hang.hanging as number)).toBe(false)
    expect(existsSync(firstRun().cwd)).toBe(false)
  }, 30_000)

  it('keeps several tool calls of one message in order after the visible text', async () => {
    const chunks = await collect(makeAdapter(), request('multitool', { tools: [READ, BASH] }))
    const ends = chunks.filter(chunk => chunk.type === 'block-end')
    expect(ends.map(chunk => chunk.type === 'block-end' ? [chunk.index, chunk.block.type, 'name' in chunk.block ? chunk.block.name : ''] : [])).toEqual([
      [0, 'text', ''],
      [1, 'tool-call', 'read'],
      [2, 'tool-call', 'bash'],
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  }, 30_000)

  it('maps an aliased tool name back to the DSH tool name', async () => {
    const odd: ToolSchema = { name: 'web.search', description: 'Search', parameters: { type: 'object', properties: {} } }
    const chunks = await collect(makeAdapter(), request('firsttool', { tools: [odd] }))
    expect(chunks.find(chunk => chunk.type === 'block-end')).toMatchObject({ block: { type: 'tool-call', name: 'web.search' } })
    const tools = JSON.parse(firstRun().files.tools ?? '') as { name: string }[]
    expect(tools[0]?.name).not.toBe('web.search')
    expect(tools[0]?.name).toMatch(/^[A-Za-z0-9_-]{1,54}$/u)
  }, 30_000)
})

describe('ClaudeCodeLlmAdapter failures', () => {
  const cases: [string, string, string][] = [
    ['loggedout', 'AUTH', 'Not logged in'],
    ['limited', 'QUOTA', 'usage limit reached'],
    ['overloaded', 'SERVER', 'Overloaded'],
    ['toolong', 'CONTEXT_WINDOW_EXCEEDED', 'Prompt is too long'],
    ['maxturns', 'PROVIDER_ERROR', 'too many turns'],
  ]
  for (const [scenario, code, detail] of cases) {
    it(`throws ${code} for a ${scenario} result`, async () => {
      const error = await failure(makeAdapter(), request(scenario))
      expect(error.code).toBe(code)
      expect(error.message).toContain(detail)
      expect(error.message).not.toContain('scenario:')
      expect(existsSync(firstRun().cwd)).toBe(false)
    }, 30_000)
  }

  it('reports a non-zero exit with the stderr tail but never the prompt', async () => {
    const error = await failure(makeAdapter(), request('exit3'))
    expect(error.code).toBe('PROVIDER_ERROR')
    expect(error.message).toContain('exited with code 3')
    expect(error.message).toContain('something broke badly')
    expect(error.message).not.toContain('hello')
  }, 30_000)

  it('throws when the run ends without a result line', async () => {
    const error = await failure(makeAdapter(), request('noresult'))
    expect(error.code).toBe('PROVIDER_ERROR')
    expect(error.message).toContain('without a result')
  }, 30_000)

  it('treats a completion with no content at all as an empty response', async () => {
    const error = await failure(makeAdapter(), request('empty'))
    expect(error.code).toBe('EMPTY_RESPONSE')
  }, 30_000)

  it('throws before spawning when the executable is not found', async () => {
    const error = await failure(makeAdapter({ executable: 'dsh-no-such-claude-binary' }), request('text'))
    expect(error.code).toBe('PROVIDER_UNAVAILABLE')
    expect(error.message).toContain('dsh-no-such-claude-binary')
    expect(readRuns()).toEqual([])
  })

  it('wraps a spawn failure', async () => {
    const adapter = makeAdapter({ spawn: () => { throw new Error('EACCES nope') } })
    const error = await failure(adapter, request('text'))
    expect(error.code).toBe('PROVIDER_UNAVAILABLE')
    expect(error.message).toContain('EACCES nope')
  })

  it('aborts promptly, terminates claude, and removes the temp directory', async () => {
    const controller = new AbortController()
    const adapter = makeAdapter()
    const pending = failure(adapter, request('slowhang', { signal: controller.signal }))
    const hang = await waitForHang()
    const started = Date.now()
    controller.abort(new Error('user cancelled'))
    const error = await pending
    expect(error.code).toBe('ABORTED')
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(alive(hang.hanging as number)).toBe(false)
    expect(existsSync(firstRun().cwd)).toBe(false)
  }, 30_000)

  it('refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await failure(makeAdapter(), request('text', { signal: controller.signal }))
    expect(error.code).toBe('ABORTED')
    expect(readRuns()).toEqual([])
  })

  it('times out a run that never finishes', async () => {
    const error = await failure(makeAdapter({ timeoutMs: 1_500 }), request('hang'))
    expect(error.code).toBe('TIMEOUT')
    expect(error.message).toContain('1500')
    const hang = await waitForHang()
    expect(alive(hang.hanging as number)).toBe(false)
  }, 30_000)
})
