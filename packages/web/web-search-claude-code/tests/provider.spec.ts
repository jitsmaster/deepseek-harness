import { existsSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  CLAUDE_CODE_PROVIDER_ID,
  ClaudeCodeSearchProvider,
  SEARCH_SYSTEM_PROMPT,
  searchArgv,
  searchPrompt,
  type ClaudeCodeSearchProviderOptions,
} from '../src/provider.ts'
import { FakeClaudeSubprocess, readRuns, subprocessContext } from './harness.ts'

let ctx: Context
let logDir: string

beforeEach(async () => {
  logDir = mkdtempSync(join(tmpdir(), 'dsh-ws-claude-log-'))
  FakeClaudeSubprocess.logPath = join(logDir, 'runs.jsonl')
  FakeClaudeSubprocess.spawned = []
  ctx = await subprocessContext()
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(logDir, { recursive: true, force: true })
})

function provider(overrides: Partial<ClaudeCodeSearchProviderOptions> = {}): ClaudeCodeSearchProvider {
  return new ClaudeCodeSearchProvider({
    executable: process.execPath,
    timeoutMs: 30_000,
    spawn: spec => ctx.subprocess.spawn(spec),
    ...overrides,
  })
}

async function failure(promise: Promise<unknown>): Promise<WebError> {
  const error = await promise.then(() => undefined, (thrown: unknown) => thrown)
  expect(error).toBeInstanceOf(WebError)
  return error as WebError
}

describe('provider identity and availability', () => {
  it('registers under the exported id', () => {
    expect(CLAUDE_CODE_PROVIDER_ID).toBe('claude-code')
    expect(provider().id).toBe('claude-code')
  })

  it('is available when the executable resolves, with no process started', () => {
    expect(provider().available()).toBe(true)
    expect(readRuns()).toEqual([])
    expect(FakeClaudeSubprocess.spawned).toEqual([])
  })

  it('is unavailable when the executable does not resolve', () => {
    expect(provider({ executable: join(logDir, 'no-such-claude') }).available()).toBe(false)
    expect(provider({ executable: 'dsh-no-such-claude-binary' }).available()).toBe(false)
  })

  it('declares no ready() because there is no credential to send', () => {
    expect('ready' in provider()).toBe(false)
  })
})

describe('headless invocation', () => {
  it('restricts the run to WebSearch and sends the prompt on stdin in a fresh empty directory', async () => {
    await provider().search({ query: 'node release schedule' })
    const [run, ...rest] = readRuns()
    expect(rest).toEqual([])
    expect(run?.argv).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--setting-sources', '', '--system-prompt-file', join(run?.cwd as string, 'system.txt'), '--disable-slash-commands',
      '--tools', 'WebSearch', '--allowedTools', 'WebSearch',
      '--strict-mcp-config', '--permission-mode', 'dontAsk',
      '--disallowedTools', 'AskUserQuestion',
    ])
    expect(run?.stdin).toBe(searchPrompt('node release schedule'))
    expect(run?.cwdEntries).toEqual(['system.txt'])
    expect(run?.cwd).not.toBe(process.cwd())
    expect(existsSync(run?.cwd as string)).toBe(false)
    const spec = FakeClaudeSubprocess.spawned[0]
    expect(spec?.stdio.stdin).toEqual({ data: searchPrompt('node release schedule') })
    expect(spec?.argv[0]).toBe(process.execPath)
  })

  it('passes --model only when configured', async () => {
    expect(searchArgv('claude', undefined, 'dir')).not.toContain('--model')
    expect(searchArgv('claude', 'sonnet', 'dir').slice(-2)).toEqual(['--model', 'sonnet'])
    await provider({ model: 'sonnet' }).search({ query: 'q' })
    expect(readRuns()[0]?.argv.slice(-2)).toEqual(['--model', 'sonnet'])
  })

  it('tells Claude Code to search once, cite sources, and avoid files', () => {
    const prompt = searchPrompt('a "quoted"\nquery')
    expect(prompt).toContain('WebSearch tool exactly once')
    expect(prompt).toContain('cite')
    expect(prompt).toMatch(/do not read or write files or notes/i)
    expect(prompt).toContain(JSON.stringify('a "quoted"\nquery'))
  })
})

describe('system prompt', () => {
  it('replaces Claude Code\'s own prompt with the small DSH one and keeps user settings out', () => {
    const argv = searchArgv('claude', undefined, 'dir')
    expect(argv.slice(argv.indexOf('--setting-sources'), argv.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', ''])
    expect(argv).toContain('--system-prompt-file')
    expect(argv).not.toContain('--append-system-prompt')
    expect(SEARCH_SYSTEM_PROMPT).toMatch(/^You are the web search helper of DSH/)
    expect(SEARCH_SYSTEM_PROMPT.length).toBeLessThan(500)
  })

  it('writes the prompt to the run directory before Claude starts', async () => {
    await provider().search({ query: 'q' })
    expect(readRuns()[0]?.systemPrompt).toBe(SEARCH_SYSTEM_PROMPT)
  })
})

describe('result mapping', () => {
  it('returns the Links sources in order and the final text as content', async () => {
    const result = await provider().search({ query: 'scenario:success' })
    expect(result).toEqual({
      content: 'Alpha says A. See https://a.example/.',
      sources: [
        { url: 'https://a.example/', title: 'Alpha' },
        { url: 'https://b.example/', title: 'Beta' },
        { url: 'https://c.example/', title: 'Gamma' },
      ],
      truncated: false,
    })
  })

  it('reads a tool_result delivered as content blocks', async () => {
    const result = await provider().search({ query: 'scenario:arraycontent' })
    expect(result.sources.map(source => source.url)).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/'])
    expect(result.content).toBe('Array content answer.')
  })

  it('truncates to maxResults and reports it', async () => {
    const result = await provider().search({ query: 'scenario:success', maxResults: 2 })
    expect(result.sources.map(source => source.url)).toEqual(['https://a.example/', 'https://b.example/'])
    expect(result.truncated).toBe(true)
    const exact = await provider().search({ query: 'scenario:success', maxResults: 3 })
    expect(exact.sources).toHaveLength(3)
    expect(exact.truncated).toBe(false)
  })

  it('skips malformed stream lines and malformed link entries', async () => {
    const result = await provider().search({ query: 'scenario:malformed' })
    expect(result.sources).toEqual([{ url: 'https://ok.example/', title: 'Ok' }])
    expect(result.content).toBe('Survived malformed lines.')
  })

  it.each(['badlinks', 'nolinks'])('returns the answer with no sources when Links is %s', async (scenario) => {
    const result = await provider().search({ query: `scenario:${scenario}` })
    expect(result.sources).toEqual([])
    expect(result.truncated).toBe(false)
    expect(result.content).toMatch(/^Answer without/)
  })

  it('merges repeated WebSearch results without duplicate urls', async () => {
    const result = await provider().search({ query: 'scenario:twice' })
    expect(result.sources.map(source => source.url)).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/'])
  })
})

describe('failures', () => {
  it('rejects a blank query without starting a process', async () => {
    const error = await failure(provider().search({ query: '   ' }))
    expect(error.code).toBe('WEB_INVALID_QUERY')
    expect(readRuns()).toEqual([])
  })

  it.each([
    ['resulterror', 'error_max_turns'],
    ['iserror', 'Credit balance is too low'],
  ])('maps a failed result line (%s) to WEB_PROVIDER_ERROR', async (scenario, detail) => {
    const error = await failure(provider().search({ query: `scenario:${scenario}` }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain(detail)
  })

  it('maps a run that never called WebSearch to WEB_PROVIDER_ERROR', async () => {
    const error = await failure(provider().search({ query: 'scenario:nosearch' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toMatch(/WebSearch/)
  })

  it('maps a WebSearch tool error to WEB_PROVIDER_ERROR', async () => {
    const error = await failure(provider().search({ query: 'scenario:toolerror' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('Web search is unavailable')
  })

  it('maps a stream with no result line to WEB_PROVIDER_ERROR', async () => {
    const error = await failure(provider().search({ query: 'scenario:noresult' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toMatch(/result/)
  })

  it('maps a non-zero exit to WEB_PROVIDER_ERROR carrying the stderr tail', async () => {
    const error = await failure(provider().search({ query: 'scenario:exit3' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('exited with code 3')
    expect(error.message).toContain('not logged in')
  })

  it('maps a spawn failure to WEB_PROVIDER_ERROR', async () => {
    const error = await failure(provider({
      spawn: () => { throw new Error('spawn denied') },
    }).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('spawn denied')
  })

  it('removes the temp directory after failures too', async () => {
    await failure(provider().search({ query: 'scenario:exit3' }))
    expect(existsSync(readRuns()[0]?.cwd as string)).toBe(false)
  })
})

describe('timeout and cancellation', () => {
  async function hangingPid(): Promise<number> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const pid = readRuns().find(run => run.hanging !== undefined)?.hanging
      if (pid !== undefined) return pid
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('the fake never started hanging')
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function waitDead(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 200 && alive(pid); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(alive(pid)).toBe(false)
  }

  it('maps a deadline to WEB_SEARCH_TIMEOUT and kills the child', async () => {
    const pending = provider({ timeoutMs: 1_500 }).search({ query: 'scenario:hang' })
    const error = await failure(pending)
    expect(error.code).toBe('WEB_SEARCH_TIMEOUT')
    await waitDead(await hangingPid())
    expect(existsSync(readRuns()[0]?.cwd as string)).toBe(false)
  }, 20_000)

  it('maps an abort to WEB_ABORTED and kills the child through the subprocess seam', async () => {
    const controller = new AbortController()
    const pending = provider().search({ query: 'scenario:hang' }, controller.signal)
    const pid = await hangingPid()
    expect(alive(pid)).toBe(true)
    controller.abort()
    const error = await failure(pending)
    expect(error.code).toBe('WEB_ABORTED')
    await waitDead(pid)
    expect(existsSync(readRuns()[0]?.cwd as string)).toBe(false)
  }, 20_000)

  it('rejects an already-aborted signal without starting a process', async () => {
    const error = await failure(provider().search({ query: 'q' }, AbortSignal.abort()))
    expect(error.code).toBe('WEB_ABORTED')
    expect(readRuns()).toEqual([])
  })
})
