/**
 * RED-phase specs for the SDK-backed command listing and one-shot slash
 * command invocation seam. Neither `listClaudeCodeCommands` nor
 * `runClaudeCodeSlashCommand` exist yet in `../src/list-commands.ts` — this
 * whole file fails to import until a later implementation pass adds them.
 *
 * Mocking follows `tests/subagent-claude-code.spec.ts` exactly: the official
 * SDK's `query` export is replaced with a hoisted `vi.fn()`, and a fake
 * `Query` is a bare async generator assigned a `close` (and here also a
 * `supportedCommands`) method — never a real class instance.
 */
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type {
  Options,
  Query,
  SDKMessage,
  SDKResultMessage,
  SlashCommand,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
  type ClaudeCodeRunSpec,
} from '../src/run.ts'
// This module does not exist yet — the whole file is expected to fail to
// resolve until a later implementation pass adds it (see module docstring).
import {
  listClaudeCodeCommands,
  runClaudeCodeSlashCommand,
} from '../src/list-commands.ts'

type QueryFactory = (params: {
  prompt: string
  options: Options
}) => Query

const queryMock = vi.hoisted(() => vi.fn<QueryFactory>())

vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query: queryMock,
}))

function fakeChild(): { handle: SubprocessHandle; terminate: ReturnType<typeof vi.fn> } {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let resolveDone!: (outcome: SubprocessOutcome) => void
  const done = new Promise<SubprocessOutcome>((resolve) => { resolveDone = resolve })
  void done.catch(() => {})
  const terminate = vi.fn(() => { resolveDone({ exitCode: 0, signal: null }) })
  const waitForExit = vi.fn(async () => { await done.catch(() => {}); return true })
  return {
    handle: {
      control: undefined,
      stdin,
      stdout,
      stderr: undefined,
      collected: {},
      done,
      terminate,
      waitForExit,
    },
    terminate,
  }
}

function sdkSpawnOptions(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    command: '/sdk/claude',
    args: ['--output-format', 'stream-json'],
    cwd: '/workspace',
    env: { PATH: '/bin' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

function baseSpec(spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle): ClaudeCodeRunSpec {
  return {
    cwd: '/workspace',
    permissionMode: DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    env: { ANTHROPIC_API_KEY: 'fake-key' },
    disposeGraceMs: 5,
    spawn,
  }
}

function fakeListingQuery(commands: SlashCommand[], close = vi.fn()): Query {
  async function* stream(): AsyncGenerator<SDKMessage, void> {
    yield { type: 'system', subtype: 'init' } as SDKMessage
  }
  return Object.assign(stream(), {
    close,
    supportedCommands: vi.fn().mockResolvedValue(commands),
  }) as unknown as Query
}

function fakeInvocationQuery(resultText: string, close = vi.fn()): Query {
  async function* stream(): AsyncGenerator<SDKMessage, void> {
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: resultText,
    } as SDKResultMessage
  }
  return Object.assign(stream(), { close }) as unknown as Query
}

describe('listClaudeCodeCommands()', () => {
  it('starts a query over the same spawn/env/cwd plumbing as a run, and returns the SDK-reported command list', async () => {
    const child = fakeChild()
    const close = vi.fn()
    const seenOptions: Options[] = []
    queryMock.mockImplementation((params) => {
      seenOptions.push(params.options)
      params.options.spawnClaudeCodeProcess!(sdkSpawnOptions({
        cwd: params.options.cwd!,
        env: params.options.env!,
      }))
      return fakeListingQuery([
        { name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' },
        { name: 'plugin-name:cmd', description: 'A plugin command', argumentHint: '' },
      ], close)
    })
    const spawnSpecs: SubprocessSpawnSpec[] = []
    const spec = baseSpec((spawnSpec) => {
      spawnSpecs.push(spawnSpec)
      return child.handle
    })

    const commands = await listClaudeCodeCommands(spec)

    expect(commands).toEqual([
      { name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' },
      { name: 'plugin-name:cmd', description: 'A plugin command', argumentHint: '' },
    ])
    expect(seenOptions[0]).toMatchObject({ cwd: '/workspace', permissionMode: DEFAULT_CLAUDE_CODE_PERMISSION_MODE })
    expect(spawnSpecs).toHaveLength(1)
    expect(spawnSpecs[0]).toMatchObject({ cwd: '/workspace' })
    // The query is closed and the managed child disposed after listing.
    expect(close).toHaveBeenCalledOnce()
    expect(child.terminate).toHaveBeenCalledOnce()
  })

  it('closes the query and disposes the child even when supportedCommands() rejects', async () => {
    const child = fakeChild()
    const close = vi.fn()
    queryMock.mockImplementation((params) => {
      params.options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      async function* stream(): AsyncGenerator<SDKMessage, void> {
        yield { type: 'system', subtype: 'init' } as SDKMessage
      }
      return Object.assign(stream(), {
        close,
        supportedCommands: vi.fn().mockRejectedValue(new Error('control channel closed')),
      }) as unknown as Query
    })
    const spec = baseSpec(() => child.handle)

    await expect(listClaudeCodeCommands(spec)).rejects.toThrow()
    expect(close).toHaveBeenCalledOnce()
    expect(child.terminate).toHaveBeenCalledOnce()
  })
})

describe('runClaudeCodeSlashCommand()', () => {
  it('sends "/name rawInput" as the one-shot prompt and returns the final result text', async () => {
    const child = fakeChild()
    let seenPrompt: string | undefined
    queryMock.mockImplementation((params) => {
      seenPrompt = params.prompt
      params.options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      return fakeInvocationQuery('delegated answer')
    })
    const spec = baseSpec(() => child.handle)

    const result = await runClaudeCodeSlashCommand('modes:sparc', ' build the thing', spec, new AbortController().signal)

    expect(seenPrompt).toBe('/modes:sparc build the thing')
    expect(result).toBe('delegated answer')
  })

  it('trims a leading-space rawInput into a single separating space before the argument text', async () => {
    const child = fakeChild()
    let seenPrompt: string | undefined
    queryMock.mockImplementation((params) => {
      seenPrompt = params.prompt
      params.options.spawnClaudeCodeProcess!(sdkSpawnOptions())
      return fakeInvocationQuery('ok')
    })
    const spec = baseSpec(() => child.handle)

    await runClaudeCodeSlashCommand('grill-me', '', spec, new AbortController().signal)

    expect(seenPrompt).toBe('/grill-me')
  })
})
