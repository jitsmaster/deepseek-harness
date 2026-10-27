import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { AuthorizationFlow } from '@deepseek-ai/dsh-authorization'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as claudeCodePlugin from '../src/index.ts'
import { readAccountUsage } from '../src/index.ts'
import { CLAUDE_CODE_LLM_PROVIDER_ID, DEFAULT_CLAUDE_EXECUTABLE, defaultExecutable } from '../src/index.ts'
import { ACCOUNT_KEY, accountId, accountsRecord } from '../src/account.ts'
import { FakeClaudeSubprocess, readRuns } from './harness.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** Stream one call whose prompt names the fake claude's scenario to completion. */
async function runScenario(root: Context, scenario: string): Promise<void> {
  for await (const chunk of root.llm.stream({
    provider: 'claude-code',
    model: 'sonnet',
    messages: [createUserMessage({ content: [{ type: 'text', text: `hi scenario:${scenario}` }], source: { kind: 'user' } })],
  })) void chunk
}

async function mount(config: claudeCodePlugin.Options = { executable: process.execPath }): Promise<Context> {
  const root = new Context()
  ctx = root
  await root.plugin(FakeClaudeSubprocess)
  await root.plugin(LlmRuntime)
  await root.plugin(claudeCodePlugin, config)
  return root
}

describe('llm-claude-code plugin shape', () => {
  it('has no default export and keeps name/inject/Config through the Loader unwrap', () => {
    expect('default' in claudeCodePlugin).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(claudeCodePlugin) as Record<string, unknown>
    expect(unwrapped).toBe(claudeCodePlugin)
    expect(unwrapped.name).toBe('llm-claude-code')
    expect(unwrapped.inject).toEqual(['llm', 'subprocess'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('defaults the executable to claude on PATH, else the standard install location', () => {
    expect(DEFAULT_CLAUDE_EXECUTABLE).toBe('claude')
    expect(defaultExecutable({ PATH: '' })).toBe(join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'))
  })

  it('accepts an empty config and validates the optional fields', () => {
    expect(() => claudeCodePlugin.Config({})).not.toThrow()
    expect(() => claudeCodePlugin.Config({ executable: 'claude', nodeExecutable: 'node', timeoutMs: 5000, defaultContextWindow: 100_000, models: [{ id: 'm', name: 'M', contextWindow: 1000, description: 'd' }] })).not.toThrow()
    expect(() => claudeCodePlugin.Config({ credential: 'llm-pi-ai/anthropic' })).not.toThrow()
    expect(() => claudeCodePlugin.Config({ credential: '' })).toThrow()
    expect(() => claudeCodePlugin.Config({ accountsDir: 'C:\\claude-accounts', accounts: ['a@x.com'], activeAccount: 'a@x.com', privateBrowser: false })).not.toThrow()
    expect(() => claudeCodePlugin.Config({ accountsDir: '' })).toThrow()
    expect(() => claudeCodePlugin.Config({ accounts: [''] })).toThrow()
    expect(() => claudeCodePlugin.Config({ activeAccount: '' })).toThrow()
    expect(() => claudeCodePlugin.Config({ privateBrowser: 'no' } as never)).toThrow()
    expect(() => claudeCodePlugin.Config({ timeoutMs: 0 })).toThrow()
    expect(() => claudeCodePlugin.Config({ models: [{ id: '', name: 'x' }] })).toThrow()
  })
})

describe('llm-claude-code registration', () => {
  it('registers the claude-code provider route', async () => {
    const root = await mount()
    expect(CLAUDE_CODE_LLM_PROVIDER_ID).toBe('claude-code')
    expect(root.llm.listProviders()).toContainEqual({ id: 'claude-code', name: 'Claude Code' })
  })

  it('lists the current Claude models and the aliases, including a Haiku', async () => {
    const root = await mount()
    const models = await root.llm.listModels('claude-code')
    const ids = models.map(model => model.id)
    expect(ids).toEqual(expect.arrayContaining(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'sonnet', 'opus', 'haiku']))
    expect(ids.find(id => id.includes('haiku'))).toBeDefined()
    expect(new Set(ids).size).toBe(ids.length)
    for (const model of models) {
      expect(model.provider).toBe('claude-code')
      expect(model.inputModalities).toEqual(['text'])
    }
  })

  it('resolves any model id with text input and every claude effort', async () => {
    const root = await mount()
    const known = await root.llm.resolveModelInfo('claude-code', 'claude-sonnet-5-5')
    expect(known).toMatchObject({ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', inputModalities: ['text'], context: { contextWindow: 1_000_000 } })
    expect(known.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(known.reasoning?.defaultEffort).toBeUndefined()
    const unknown = await root.llm.resolveModelInfo('claude-code', 'claude-future-9')
    expect(unknown).toMatchObject({ id: 'claude-future-9', name: 'claude-future-9', context: { contextWindow: 200_000 } })
    expect(unknown.reasoning?.efforts).toHaveLength(5)
    const alias = await root.llm.resolveModelInfo('claude-code', 'haiku')
    expect(alias.inputModalities).toEqual(['text'])
  })

  it('applies config overrides: extra models, a changed window, and the unlisted default', async () => {
    const root = await mount({
      executable: process.execPath,
      defaultContextWindow: 123_456,
      models: [
        { id: 'claude-sonnet-5-5', name: 'Sonnet (mine)', contextWindow: 500_000 },
        { id: 'my-model', name: 'My Model', description: 'custom' },
      ],
    })
    const sonnet = await root.llm.resolveModelInfo('claude-code', 'claude-sonnet-5-5')
    expect(sonnet).toMatchObject({ name: 'Sonnet (mine)', context: { contextWindow: 500_000 } })
    const mine = await root.llm.resolveModelInfo('claude-code', 'my-model')
    expect(mine).toMatchObject({ name: 'My Model', description: 'custom', context: { contextWindow: 123_456 } })
    expect((await root.llm.listModels('claude-code')).map(model => model.id)).toContain('my-model')
    expect((await root.llm.resolveModelInfo('claude-code', 'unlisted')).context?.contextWindow).toBe(123_456)
  })

  it('validates reasoning effort through prepareCall, accepting claude efforts and refusing others', async () => {
    const root = await mount()
    const prepared = await root.llm.prepareCall({ provider: 'claude-code', model: 'sonnet', reasoningEffort: 'xhigh' as never })
    expect(prepared.config.reasoningEffort).toBe('xhigh')
    expect(prepared.inputModalities).toEqual(['text'])
    expect(prepared.config.maxTokens).toBeUndefined()
    await expect(root.llm.prepareCall({ provider: 'claude-code', model: 'sonnet', reasoningEffort: 'minimal' as never })).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  })

  it('serves a stream through the runtime and the fake claude', async () => {
    FakeClaudeSubprocess.logPath = join(tmpdir(), `dsh-llm-claude-plugin-${process.pid}.jsonl`)
    const root = await mount()
    const chunks: StreamChunk[] = []
    for await (const chunk of root.llm.stream({
      provider: 'claude-code',
      model: 'sonnet',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi scenario:text' }], source: { kind: 'user' } })],
    })) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
    rmSync(FakeClaudeSubprocess.logPath, { force: true })
  }, 30_000)
})

describe('llm-claude-code rateLimitFile', () => {
  let scratch: string | undefined

  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
  })

  async function waitForFile(path: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      } catch {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    throw new Error('the rate-limit file never appeared')
  }

  function setup(): string {
    scratch = mkdtempSync(join(tmpdir(), 'dsh-llm-claude-rl-'))
    FakeClaudeSubprocess.logPath = join(scratch, 'runs.jsonl')
    return join(scratch, 'nested', 'usage.json')
  }

  it('validates the option', () => {
    expect(() => claudeCodePlugin.Config({ rateLimitFile: 'usage.json' })).not.toThrow()
    expect(() => claudeCodePlugin.Config({ rateLimitFile: '' })).toThrow()
  })

  it('writes the plan-usage reading after a call', async () => {
    const path = setup()
    const root = await mount({ executable: process.execPath, rateLimitFile: path })
    await runScenario(root, 'ratelimited')
    const body = await waitForFile(path)
    expect(body).toMatchObject({
      fiveHour: { utilization: 0.25, resetsAt: 1793134800 },
      sevenDay: { utilization: 0.5, resetsAt: 1793232000 },
    })
    expect(typeof body.updatedAt).toBe('string')
  }, 30_000)

  it('writes nothing when the option is unset or the stream has no reading', async () => {
    const path = setup()
    const unset = await mount()
    await runScenario(unset, 'ratelimited')
    await ctx?.fiber.dispose()
    const set = await mount({ executable: process.execPath, rateLimitFile: path })
    await runScenario(set, 'text')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(existsSync(path)).toBe(false)
  }, 30_000)

  it('warns once per reason for an unwritable path and still serves the call', async () => {
    const path = setup()
    writeFileSync(join(scratch as string, 'nested'), 'a file, not a directory')
    const root = new Context()
    ctx = root
    const warnings: string[] = []
    root.logger.warn = ((...args: unknown[]) => { warnings.push(args.join(' ')) }) as never
    await root.plugin(FakeClaudeSubprocess)
    await root.plugin(LlmRuntime)
    await root.plugin(claudeCodePlugin, { executable: process.execPath, rateLimitFile: path })
    await runScenario(root, 'ratelimited')
    await runScenario(root, 'ratelimited')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('could not write the plan-usage file')
  }, 30_000)
})

describe('llm-claude-code stored credential', () => {
  const KEY = 'llm-pi-ai/anthropic'
  const user = (): Parameters<Context['llm']['stream']>[0] => ({
    provider: 'claude-code',
    model: 'sonnet',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hi scenario:text' }], source: { kind: 'user' } })],
  })

  async function run(root: Context): Promise<void> {
    for await (const chunk of root.llm.stream(user())) void chunk
  }

  // The account record is a different key: nobody has signed in from DSH here.
  function fakeCredentials(read: (key: string) => Promise<unknown>): void {
    ctx?.provide('credentials', { readRecord: (key: string) => key === ACCOUNT_KEY ? Promise.resolve(undefined) : read(key) } as never)
  }

  async function mountWith(
    config: claudeCodePlugin.Options,
    read?: (key: string) => Promise<unknown>,
  ): Promise<{ root: Context; warnings: string[] }> {
    FakeClaudeSubprocess.logPath = join(tmpdir(), `dsh-llm-claude-cred-${process.pid}-${Date.now()}.jsonl`)
    const root = new Context()
    ctx = root
    const warnings: string[] = []
    root.logger.warn = ((...args: unknown[]) => { warnings.push(args.join(' ')) }) as never
    await root.plugin(FakeClaudeSubprocess)
    await root.plugin(LlmRuntime)
    if (read !== undefined) fakeCredentials(read)
    await root.plugin(claudeCodePlugin, config)
    return { root, warnings }
  }

  afterEach(() => { rmSync(FakeClaudeSubprocess.logPath, { force: true }) })

  it('loads and runs with no credentials service while credential is unset', async () => {
    const { root, warnings } = await mountWith({ executable: process.execPath })
    await run(root)
    expect(readRuns()[0]?.oauthToken).toBeUndefined()
    expect(warnings).toEqual([])
  }, 30_000)

  it('hands the access token of a fresh grant to the child, read per call', async () => {
    let n = 0
    const { root, warnings } = await mountWith({ executable: process.execPath, credential: KEY }, (key) => {
      expect(key).toBe(KEY)
      return Promise.resolve({ kind: 'grant', payload: { type: 'oauth', access: `sk-ant-oat-fake-${++n}`, refresh: 'refresh-fake', expires: Date.now() + 3_600_000 } })
    })
    await run(root)
    await run(root)
    expect(readRuns().map(r => r.oauthToken)).toEqual(['sk-ant-oat-fake-1', 'sk-ant-oat-fake-2'])
    expect(warnings).toEqual([])
  }, 30_000)

  it('falls back with one secret-free warning per reason when the grant is expired', async () => {
    const { root, warnings } = await mountWith({ executable: process.execPath, credential: KEY }, () => Promise.resolve({ kind: 'grant', payload: { type: 'oauth', access: 'sk-ant-oat-fake', expires: Date.now() - 1 } }))
    await run(root)
    await run(root)
    expect(readRuns().map(r => r.oauthToken)).toEqual([undefined, undefined])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('stored grant expired')
    expect(warnings[0]).not.toContain('sk-ant-oat-fake')
  }, 30_000)

  it('falls back when no credentials service is mounted or the read throws', async () => {
    const missing = await mountWith({ executable: process.execPath, credential: KEY })
    await run(missing.root)
    expect(missing.warnings).toHaveLength(1)
    await ctx?.fiber.dispose()
    const broken = await mountWith({ executable: process.execPath, credential: KEY }, () => Promise.reject(new Error('boom sk-ant-oat-fake')))
    await run(broken.root)
    await run(broken.root)
    expect(readRuns().map(r => r.oauthToken)).toEqual([undefined, undefined])
    expect(broken.warnings).toHaveLength(1)
    expect(broken.warnings[0]).not.toContain('sk-ant-oat-fake')
  }, 30_000)
})

describe('llm-claude-code signed-in accounts', () => {
  const CREDENTIAL_KEY = 'llm-pi-ai/anthropic'
  const grant = (): unknown => ({ kind: 'grant', payload: { type: 'oauth', access: 'sk-ant-oat-fake', expires: Date.now() + 3_600_000 } })
  const entry = (email: string): { id: string; email: string; signedInAt: string } => ({ id: accountId(email), email, signedInAt: '2026-10-27T10:00:00.000Z' })
  let scratch: string | undefined

  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
    scratch = undefined
    rmSync(FakeClaudeSubprocess.logPath, { force: true })
  })

  /** An accounts root; each given email gets its directory, signed in (credentials file present) unless listed in `bare`. */
  function accountsRoot(emails: string[], bare: string[] = []): string {
    scratch = mkdtempSync(join(tmpdir(), 'dsh-llm-claude-accts-'))
    const root = join(scratch, 'accounts')
    for (const email of emails) {
      mkdirSync(join(root, accountId(email)), { recursive: true })
      if (!bare.includes(email)) writeFileSync(join(root, accountId(email), '.credentials.json'), 'FAKE')
    }
    return root
  }

  async function mountWith(
    config: claudeCodePlugin.Options,
    read: (key: string) => Promise<unknown>,
  ): Promise<{ root: Context; warnings: string[] }> {
    FakeClaudeSubprocess.logPath = join(tmpdir(), `dsh-llm-claude-accts-${process.pid}-${Date.now()}.jsonl`)
    const root = new Context()
    ctx = root
    const warnings: string[] = []
    root.logger.warn = ((...args: unknown[]) => { warnings.push(args.join(' ')) }) as never
    await root.plugin(FakeClaudeSubprocess)
    await root.plugin(LlmRuntime)
    root.provide('credentials', { readRecord: read } as never)
    await root.plugin(claudeCodePlugin, config)
    return { root, warnings }
  }

  const run = (root: Context, scenario = 'text'): Promise<void> => runScenario(root, scenario)

  const twoAccounts = (key: string): Promise<unknown> => Promise.resolve(
    key === ACCOUNT_KEY ? accountsRecord([entry('a@x.com'), entry('b@x.com')]) : grant(),
  )

  it('points every call at the active account directory, ahead of a usable stored credential', async () => {
    const dir = accountsRoot(['a@x.com', 'b@x.com'])
    const keys: string[] = []
    const { root, warnings } = await mountWith({ executable: process.execPath, accountsDir: dir, activeAccount: 'A@x.com', credential: CREDENTIAL_KEY }, (key) => {
      keys.push(key)
      return twoAccounts(key)
    })
    await run(root)
    await run(root)
    expect(readRuns().map(r => [r.configDir, r.oauthToken])).toEqual([[join(dir, accountId('a@x.com')), undefined], [join(dir, accountId('a@x.com')), undefined]])
    expect(keys).not.toContain(CREDENTIAL_KEY)
    expect(warnings).toEqual([])
  }, 30_000)

  it('switches account between calls when the live activeAccount changes, without a remount', async () => {
    const dir = accountsRoot(['a@x.com', 'b@x.com'])
    FakeClaudeSubprocess.logPath = join(tmpdir(), `dsh-llm-claude-accts-${process.pid}-live.jsonl`)
    const root = new Context()
    ctx = root
    await root.plugin(FakeClaudeSubprocess)
    await root.plugin(LlmRuntime)
    root.provide('credentials', { readRecord: twoAccounts } as never)
    const config = claudeCodePlugin.Config({ executable: process.execPath, accountsDir: dir, activeAccount: 'a@x.com' }) as claudeCodePlugin.Config
    claudeCodePlugin.apply(root, config)
    await run(root)
    // The Loader commits a settings edit by updating the live reference in place.
    const edit = (options: claudeCodePlugin.Options): void => {
      updateVolatile(config.activeAccount, (claudeCodePlugin.Config(options) as claudeCodePlugin.Config).activeAccount)
    }
    edit({ activeAccount: 'B@x.com' })
    await run(root)
    edit({})
    await run(root)
    expect(readRuns().map(r => r.configDir)).toEqual([join(dir, accountId('a@x.com')), join(dir, accountId('b@x.com')), undefined])
  }, 30_000)

  it('falls back to the stored credential, then to Claude Code\'s own login, with one warning per reason', async () => {
    const dir = accountsRoot(['a@x.com'], ['a@x.com'])
    const withCredential = await mountWith({ executable: process.execPath, accountsDir: dir, activeAccount: 'a@x.com', credential: CREDENTIAL_KEY }, twoAccounts)
    await run(withCredential.root)
    await run(withCredential.root)
    expect(readRuns().map(r => [r.configDir, r.oauthToken])).toEqual([[undefined, 'sk-ant-oat-fake'], [undefined, 'sk-ant-oat-fake']])
    expect(withCredential.warnings).toHaveLength(1)
    expect(withCredential.warnings[0]).toContain('no Claude Code credentials')
    await ctx?.fiber.dispose()
    const alone = await mountWith({ executable: process.execPath, accountsDir: dir, activeAccount: 'a@x.com' }, twoAccounts)
    await run(alone.root)
    await run(alone.root)
    expect(readRuns().map(r => [r.configDir, r.oauthToken])).toEqual([[undefined, undefined], [undefined, undefined]])
    expect(alone.warnings).toHaveLength(1)
  }, 30_000)

  it('warns once when the active account never signed in, and never leaks another record shape', async () => {
    const dir = accountsRoot(['a@x.com'])
    const unknown = await mountWith({ executable: process.execPath, accountsDir: dir, activeAccount: 'nobody@x.com' }, twoAccounts)
    await run(unknown.root)
    await run(unknown.root)
    expect(readRuns().map(r => r.configDir)).toEqual([undefined, undefined])
    expect(unknown.warnings).toHaveLength(1)
    expect(unknown.warnings[0]).toContain('has not signed in')
    await ctx?.fiber.dispose()
    const wrong = await mountWith({ executable: process.execPath, accountsDir: dir, activeAccount: 'a@x.com' }, () => Promise.resolve({ kind: 'api-key', key: 'sk-ant-leak' }))
    await run(wrong.root)
    expect(wrong.warnings).toHaveLength(1)
    expect(wrong.warnings[0]).not.toContain('sk-ant-leak')
  }, 30_000)

  it('stays silent with no active account, and survives a failing read or a missing credentials service', async () => {
    const dir = accountsRoot(['a@x.com'])
    const silent = await mountWith({ executable: process.execPath, accountsDir: dir }, twoAccounts)
    await run(silent.root)
    expect(readRuns()[0]?.configDir).toBeUndefined()
    expect(silent.warnings).toEqual([])
    await ctx?.fiber.dispose()
    const broken = await mountWith({ executable: process.execPath, accountsDir: dir, activeAccount: 'a@x.com' }, () => Promise.reject(new Error('boom')))
    await run(broken.root)
    await run(broken.root)
    expect(readRuns().map(r => r.configDir)).toEqual([undefined, undefined])
    expect(broken.warnings).toHaveLength(1)
    await ctx?.fiber.dispose()
    const root = new Context()
    ctx = root
    const warnings: string[] = []
    root.logger.warn = ((...args: unknown[]) => { warnings.push(args.join(' ')) }) as never
    FakeClaudeSubprocess.logPath = join(tmpdir(), `dsh-llm-claude-accts-${process.pid}-nosvc.jsonl`)
    await root.plugin(FakeClaudeSubprocess)
    await root.plugin(LlmRuntime)
    await root.plugin(claudeCodePlugin, { executable: process.execPath, accountsDir: dir, activeAccount: 'a@x.com' })
    await run(root)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no credentials service')
  }, 30_000)

  it('keeps each account\'s own usage reading beside its files, and the shared file as before', async () => {
    const dir = accountsRoot(['a@x.com', 'b@x.com'])
    const shared = join(scratch as string, 'shared.json')
    const { root } = await mountWith({ executable: process.execPath, accountsDir: dir, activeAccount: 'a@x.com', rateLimitFile: shared }, twoAccounts)
    await run(root, 'ratelimited')
    const usage = await waitForUsage(join(dir, accountId('a@x.com'), 'usage.json'))
    expect(usage).toMatchObject({
      fiveHour: { utilization: 0.25, resetsAt: 1793134800 },
      sevenDay: { utilization: 0.5, resetsAt: 1793232000 },
    })
    expect(typeof usage.updatedAt).toBe('string')
    expect(JSON.stringify(usage)).not.toContain('FAKE')
    expect(existsSync(join(dir, accountId('b@x.com'), 'usage.json'))).toBe(false)
    expect(await readAccountUsage(dir, accountId('a@x.com'))).toMatchObject({ fiveHour: { utilization: 0.25 }, sevenDay: { utilization: 0.5 } })
    expect(await readAccountUsage(dir, accountId('b@x.com'))).toBeUndefined()
    expect(await readAccountUsage(dir, '../escape')).toBeUndefined()
    await waitForUsage(shared)
  }, 30_000)

  it('writes no per-account reading for a call that ran on Claude Code\'s own login', async () => {
    const dir = accountsRoot(['a@x.com'])
    const { root } = await mountWith({ executable: process.execPath, accountsDir: dir }, twoAccounts)
    await run(root, 'ratelimited')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(existsSync(join(dir, accountId('a@x.com'), 'usage.json'))).toBe(false)
  }, 30_000)

  it('registers the sign-in flow once the authorization seam appears, and loads without it', async () => {
    const root = await mount()
    const flows: AuthorizationFlow[] = []
    expect(flows).toEqual([])
    root.provide('authorization', { registerFlow: (flow: AuthorizationFlow) => { flows.push(flow); return () => undefined } } as never)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(flows).toHaveLength(1)
    expect(flows[0]).toMatchObject({ key: ACCOUNT_KEY, label: 'Claude (Claude Code)', methods: [{ id: 'oauth', label: 'Sign in with Claude' }] })
  })

  async function waitForUsage(path: string): Promise<Record<string, unknown>> {
    const limit = Date.now() + 10_000
    while (Date.now() < limit) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      } catch {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    throw new Error(`${path} never appeared`)
  }
})
