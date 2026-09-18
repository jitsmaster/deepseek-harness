/**
 * RED-phase specs for the architecture rewrite: `rescan()` stops hand-scanning
 * `.claude/skills` / `.claude/commands` files and instead lists commands via
 * the official Claude Agent SDK's `query.supportedCommands()` control call
 * (through `@deepseek-ai/dsh-subagent-claude-code`'s one-shot machinery), and
 * invoking a listed command delegates the whole thing to a fresh one-shot
 * Claude Code subagent instead of steering the SAME agent's own conversation.
 *
 * None of this exists yet — `index.ts` still calls `scanSkillDirectories`/
 * `scanCommandFiles` and steers `agent.steer()` directly, so every test here
 * is expected to fail against the CURRENT implementation: the mocked SDK
 * command list never reaches `ctx.commands.list()`, and invoking a command
 * still steers instead of calling through the mocked official SDK `query`.
 *
 * Mocking follows `packages/subagent/subagent-claude-code/tests/subagent-claude-code.spec.ts`
 * exactly: the official SDK's `query` export is replaced with a hoisted
 * `vi.fn()` returning a bare async generator carrying `close`/`supportedCommands`.
 *
 * Per the architecture decision, tier (project vs. user) no longer exists as
 * a concept once listing comes from the SDK's already-deduped, already-
 * precedenced command list — no test here asserts tier distinctions, only
 * that the SDK-reported command list reaches the palette and that invoking
 * one delegates to a one-shot subagent.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { Options, Query, SDKMessage, SDKResultMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
// Imported as a whole module (not just `{ apply }`) so its static `inject`
// export (now `['subprocess']`) reaches Cordis — matching how
// `packages/subagent/subagent-claude-code/tests/subagent-claude-code.spec.ts`
// mounts its own sibling plugin (`import * as claudeCode from '../src/index.ts'`).
import * as claudeSkillCommandsPlugin from '../src/index.ts'

/**
 * A real, near-instantly-exiting command handed to the mocked SDK's
 * `spawnClaudeCodeProcess` hook below, so it flows through the REAL shared
 * `ctx.subprocess` service (see `bootHost`) instead of a fake handle — this
 * is a genuine child process, not a raw `node:child_process.spawn` against a
 * nonexistent path. Uses the platform shell's own no-op rather than spawning
 * a nested Node runtime, so repeated rapid spawns across this file's tests
 * don't fight over the same process's crypto/entropy startup path.
 */
const stubClaudeCliCommand = process.platform === 'win32'
  ? { command: 'cmd.exe', args: ['/c', 'exit', '0'] }
  : { command: '/bin/sh', args: ['-c', 'exit 0'] }

type QueryFactory = (params: { prompt: string; options: Options }) => Query

const queryMock = vi.hoisted(() => vi.fn<QueryFactory>())

vi.mock('@anthropic-ai/claude-agent-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>(),
  query: queryMock,
}))

function fakeListingQuery(commands: SlashCommand[]): Query {
  async function* stream(): AsyncGenerator<SDKMessage, void> {
    yield { type: 'system', subtype: 'init' } as SDKMessage
  }
  return Object.assign(stream(), {
    close: vi.fn(),
    supportedCommands: vi.fn().mockResolvedValue(commands),
  }) as unknown as Query
}

function fakeInvocationQuery(resultText: string): Query {
  async function* stream(): AsyncGenerator<SDKMessage, void> {
    yield { type: 'result', subtype: 'success', is_error: false, result: resultText } as SDKResultMessage
  }
  return Object.assign(stream(), { close: vi.fn() }) as unknown as Query
}

/**
 * Mints a fake Agent with a real Session and a real scoped `agent.ctx`.
 * @param id - session/agent id, defaults to the single shared id every
 *   earlier test in this file relies on. Override to mint a second,
 *   independent agent in the same host (the listing-cache tests, which need
 *   two agents that do not shadow each other's registered commands).
 */
function agentWithProvider(ctx: Context, cwd: string, provider: string, id = 'agent-1'): Agent {
  const session = Session.create(SessionId(id))
  ;(session as { header: { cwd: string } }).header = { ...session.header, cwd }
  const agent = {
    id: SessionId(id),
    session: Object.assign(session, {
      requestHeader: () => ({ config: { provider, model: 'x' } }),
    }),
    steer: vi.fn(),
  } as unknown as Agent
  const scoped = createScope(ctx, agent).ctx
  ;(agent as { ctx?: Context }).ctx = scoped
  return agent
}

/**
 * Mints a fake Agent like {@link agentWithProvider}, but whose reported
 * provider can be changed after construction via the returned setter — used
 * to simulate a provider switch landing between a command's registration and
 * its invocation, before the next `agent/pre-step` tick has a chance to close
 * the gate (finding 1's re-check-at-invocation-time regression).
 */
function agentWithMutableProvider(
  ctx: Context,
  cwd: string,
  initialProvider: string,
): { agent: Agent; setProvider: (provider: string) => void } {
  const session = Session.create(SessionId('agent-1'))
  ;(session as { header: { cwd: string } }).header = { ...session.header, cwd }
  let provider = initialProvider
  const agent = {
    id: SessionId('agent-1'),
    session: Object.assign(session, {
      requestHeader: () => ({ config: { provider, model: 'x' } }),
    }),
    steer: vi.fn(),
  } as unknown as Agent
  const scoped = createScope(ctx, agent).ctx
  ;(agent as { ctx?: Context }).ctx = scoped
  return { agent, setProvider: (next: string) => { provider = next } }
}

async function bootHost(homedir: string): Promise<Context> {
  const ctx = new Context()
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek-official' }) } as never)
  // The plugin under test now injects `subprocess` (bug 4's fix routes every
  // spawn through the shared managed-process service instead of a bespoke
  // local helper) — mount the real local implementation so it resolves.
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(claudeSkillCommandsPlugin, { homedir })
  return ctx
}

/** Fires the real `agent/pre-step` waterfall the plugin listens on. */
async function tickPreStep(ctx: Context, agent: Agent): Promise<void> {
  await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

describe('claude-skill-commands — SDK-backed listing (bugs 1-3)', () => {
  it('registers a namespaced command name reported by the CLI\'s supportedCommands() list (bug 1: a nested command file like modes/sparc.md)', async () => {
    queryMock.mockImplementation((params) => {
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      return fakeListingQuery([
        { name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' },
      ])
    })
    const ctx = await bootHost('/home/operator')
    const agent = agentWithProvider(ctx, '/workspace', 'anthropic')
    ctx.emit('agent/created', { agent, source: 'startup' })

    await tickPreStep(ctx, agent)

    expect(ctx.commands.list(agent).some(c => c.name === 'modes:sparc')).toBe(true)
  })

  it('registers a marketplace plugin command name reported by the CLI (bug 2: plugin commands were never discovered before)', async () => {
    queryMock.mockImplementation((params) => {
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      return fakeListingQuery([
        { name: 'my-plugin:review', description: 'Marketplace plugin command', argumentHint: '' },
      ])
    })
    const ctx = await bootHost('/home/operator')
    const agent = agentWithProvider(ctx, '/workspace', 'anthropic')
    ctx.emit('agent/created', { agent, source: 'startup' })

    await tickPreStep(ctx, agent)

    const descriptor = ctx.commands.list(agent).find(c => c.name === 'my-plugin:review')
    expect(descriptor).toMatchObject({ name: 'my-plugin:review', description: 'Marketplace plugin command' })
  })

  it('invoking a listed command delegates to a fresh one-shot Claude Code subagent instead of steering the agent\'s own conversation (bug 3 palette/behavior change)', async () => {
    queryMock.mockImplementation((params) => {
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      if (params.prompt.startsWith('/modes:sparc')) return fakeInvocationQuery('delegated sparc answer')
      return fakeListingQuery([
        { name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' },
      ])
    })
    const ctx = await bootHost('/home/operator')
    const agent = agentWithProvider(ctx, '/workspace', 'anthropic')
    ctx.emit('agent/created', { agent, source: 'startup' })
    await tickPreStep(ctx, agent)

    const execution = await ctx.commands.execute(agent, '/modes:sparc build the thing', [], new AbortController().signal)

    expect(execution?.result).toEqual({ kind: 'success', text: 'delegated sparc answer' })
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock does not use `this`
    expect(agent.steer).not.toHaveBeenCalled()
    expect(queryMock).toHaveBeenCalledWith(expect.objectContaining({ prompt: '/modes:sparc build the thing' }))
  })

  it('skips a CLI-reported command whose name does not match DSH\'s command-name pattern (e.g. contains uppercase letters) instead of throwing, while still registering other valid commands from the same rescan', async () => {
    queryMock.mockImplementation((params) => {
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      return fakeListingQuery([
        { name: 'modes:sparc-graph-README', description: 'sparc-graph — How It Works', argumentHint: '' },
        { name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' },
      ])
    })
    const ctx = await bootHost('/home/operator')
    const agent = agentWithProvider(ctx, '/workspace', 'anthropic')

    // The whole gate-open rescan must complete without throwing, even though
    // one reported command's name is outside DSH's own `COMMAND_NAME` grammar.
    await expect((async () => {
      ctx.emit('agent/created', { agent, source: 'startup' })
      await tickPreStep(ctx, agent)
    })()).resolves.toBeUndefined()

    expect(ctx.commands.list(agent).some(c => c.name === 'modes:sparc-graph-README')).toBe(false)
    expect(ctx.commands.list(agent).some(c => c.name === 'modes:sparc')).toBe(true)
  })

  it('/refresh-skills re-lists via the SDK asynchronously and picks up a command that only appears on the second call', async () => {
    let call = 0
    queryMock.mockImplementation((params) => {
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      call += 1
      return call === 1
        ? fakeListingQuery([])
        : fakeListingQuery([{ name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' }])
    })
    const ctx = await bootHost('/home/operator')
    const agent = agentWithProvider(ctx, '/workspace', 'anthropic')
    ctx.emit('agent/created', { agent, source: 'startup' })
    await tickPreStep(ctx, agent)
    expect(ctx.commands.list(agent).some(c => c.name === 'modes:sparc')).toBe(false)

    const refresh = await ctx.commands.execute(agent, '/refresh-skills', [], new AbortController().signal)

    expect(refresh?.result.kind).toBe('success')
    expect(ctx.commands.list(agent).some(c => c.name === 'modes:sparc')).toBe(true)
  })

  it('registers commands eagerly on mount, before any agent/pre-step tick, when the default model is already anthropic', async () => {
    queryMock.mockImplementation((params) => {
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      return fakeListingQuery([
        { name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' },
      ])
    })
    const ctx = await bootHost('/home/operator')
    const agent = agentWithProvider(ctx, '/workspace', 'anthropic')

    ctx.emit('agent/created', { agent, source: 'startup' })
    // Give the eager mount-time gate sync's microtasks a chance to settle —
    // no `agent/pre-step` tick fires here, unlike other tests in this file.
    await vi.waitFor(() => {
      expect(ctx.commands.list(agent).some(c => c.name === 'modes:sparc')).toBe(true)
    })
  })

  it('still gates registration on the anthropic provider — no commands appear on a non-anthropic session even when the SDK reports some', async () => {
    queryMock.mockImplementation((params) => {
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      return fakeListingQuery([{ name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' }])
    })
    const ctx = await bootHost('/home/operator')
    const agent = agentWithProvider(ctx, '/workspace', 'deepseek-official')
    ctx.emit('agent/created', { agent, source: 'startup' })

    await tickPreStep(ctx, agent)

    expect(ctx.commands.list(agent).some(c => c.name === 'modes:sparc')).toBe(false)
  })

  it('re-checks the provider gate at invocation time and fails clean instead of spawning when the provider changed since registration (finding 1)', async () => {
    queryMock.mockImplementation((params) => {
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      return fakeListingQuery([
        { name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' },
      ])
    })
    const ctx = await bootHost('/home/operator')
    const { agent, setProvider } = agentWithMutableProvider(ctx, '/workspace', 'anthropic')
    ctx.emit('agent/created', { agent, source: 'startup' })
    await tickPreStep(ctx, agent)
    expect(ctx.commands.list(agent).some(c => c.name === 'modes:sparc')).toBe(true)

    // Simulate the provider switching away from Claude mid-step — before the
    // next `agent/pre-step` tick closes the gate and disposes this handler.
    setProvider('deepseek-official')
    queryMock.mockClear()

    const execution = await ctx.commands.execute(agent, '/modes:sparc build the thing', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('error')
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('catches a failed delegated invocation and returns a clean error result instead of throwing across the RPC boundary (finding 2)', async () => {
    queryMock.mockImplementation((params) => {
      if (params.prompt.startsWith('/modes:sparc')) throw new Error('subprocess exploded')
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      return fakeListingQuery([
        { name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' },
      ])
    })
    const ctx = await bootHost('/home/operator')
    const agent = agentWithProvider(ctx, '/workspace', 'anthropic')
    ctx.emit('agent/created', { agent, source: 'startup' })
    await tickPreStep(ctx, agent)

    const execution = await ctx.commands.execute(agent, '/modes:sparc build the thing', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('error')
    // `startClaudeCodeRun` wraps the thrown query failure in its own
    // `ClaudeCodeFailure` before it reaches this handler's catch — assert on
    // that wrapper (which the handler's error text embeds) rather than the
    // original message, which the wrapper intentionally does not surface.
    expect((execution?.result as { text: string }).text).toContain('ClaudeCodeFailure')
  })

  it('detects a metadata-only change (description/argument-hint) on rescan and re-registers instead of leaving the old copy stale (finding 3)', async () => {
    let call = 0
    queryMock.mockImplementation((params) => {
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      call += 1
      return call === 1
        ? fakeListingQuery([{ name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' }])
        : fakeListingQuery([{ name: 'modes:sparc', description: 'Updated description', argumentHint: '<new-goal>' }])
    })
    const ctx = await bootHost('/home/operator')
    const agent = agentWithProvider(ctx, '/workspace', 'anthropic')
    ctx.emit('agent/created', { agent, source: 'startup' })
    await tickPreStep(ctx, agent)
    expect(ctx.commands.list(agent).find(c => c.name === 'modes:sparc')?.description).toBe('Boomerang Commander Mode')

    const refresh = await ctx.commands.execute(agent, '/refresh-skills', [], new AbortController().signal)

    expect(refresh?.result).toEqual({ kind: 'success', text: 'Refreshed skills: +1, -1.' })
    const descriptor = ctx.commands.list(agent).find(c => c.name === 'modes:sparc')
    expect(descriptor?.description).toBe('Updated description')
    expect(descriptor?.input?.hint).toBe('<new-goal>')
  })

  it('serializes two overlapping /refresh-skills calls so the second joins the in-flight scan instead of clobbering it (race-condition fix)', async () => {
    let call = 0
    // Held open until the test explicitly releases it, so the first
    // `/refresh-skills` call's underlying listing is still in flight when the
    // second `/refresh-skills` call starts — reproducing the overlap window
    // described in the finding (two independent rescan triggers racing).
    let releaseFirstListing: () => void = () => {}
    const firstListingGate = new Promise<void>((resolve) => { releaseFirstListing = resolve })
    queryMock.mockImplementation((params) => {
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      call += 1
      const thisCall = call
      async function* stream(): AsyncGenerator<SDKMessage, void> {
        yield { type: 'system', subtype: 'init' } as SDKMessage
      }
      return Object.assign(stream(), {
        close: vi.fn(),
        supportedCommands: vi.fn().mockImplementation(async () => {
          if (thisCall === 1) return [{ name: 'cmd-a', description: 'A', argumentHint: '' }]
          if (thisCall === 2) {
            // The first `/refresh-skills` call's own listing — held open so
            // a second `/refresh-skills` fired before it resolves must not
            // start a third, independent listing call of its own.
            await firstListingGate
            return [{ name: 'cmd-a', description: 'A', argumentHint: '' }]
          }
          return [
            { name: 'cmd-a', description: 'A', argumentHint: '' },
            { name: 'cmd-b', description: 'B', argumentHint: '' },
          ]
        }),
      }) as unknown as Query
    })
    const ctx = await bootHost('/home/operator')
    const agent = agentWithProvider(ctx, '/workspace', 'anthropic')
    ctx.emit('agent/created', { agent, source: 'startup' })
    // Gate-open scan (call 1): registers `cmd-a`.
    await tickPreStep(ctx, agent)
    expect(ctx.commands.list(agent).some(c => c.name === 'cmd-a')).toBe(true)

    // Fire two `/refresh-skills` invocations back to back, without awaiting
    // the first — the second starts while the first's listing (call 2) is
    // still held open by `firstListingGate`.
    const firstRefresh = ctx.commands.execute(agent, '/refresh-skills', [], new AbortController().signal)
    const secondRefresh = ctx.commands.execute(agent, '/refresh-skills', [], new AbortController().signal)
    releaseFirstListing()
    const [firstResult, secondResult] = await Promise.all([firstRefresh, secondRefresh])

    // The second call must have joined the first's in-flight scan rather
    // than starting its own independent listing — only `call === 2` (the
    // first refresh's own listing) should ever have run beyond the initial
    // gate-open scan.
    expect(call).toBe(2)
    expect(firstResult?.result).toEqual(secondResult?.result)
    expect(ctx.commands.list(agent).some(c => c.name === 'cmd-a')).toBe(true)

    // Prove `cmd-a`'s registration was not orphaned by the overlap: a
    // follow-up rescan that reports no commands must be able to dispose it
    // cleanly and report it as removed, rather than leaving it stuck
    // registered with no reachable `dispose` closure.
    queryMock.mockImplementation((params) => {
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      return fakeListingQuery([])
    })
    const finalRefresh = await ctx.commands.execute(agent, '/refresh-skills', [], new AbortController().signal)

    expect(finalRefresh?.result).toEqual({ kind: 'success', text: 'Refreshed skills: +0, -1.' })
    expect(ctx.commands.list(agent).some(c => c.name === 'cmd-a')).toBe(false)
  })
})

describe('claude-skill-commands — cwd-keyed listing cache', () => {
  it('reuses one cwd\'s listing across two agents instead of spawning the CLI twice', async () => {
    let spawnCount = 0
    queryMock.mockImplementation((params) => {
      spawnCount += 1
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      return fakeListingQuery([
        { name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' },
      ])
    })
    const ctx = await bootHost('/home/operator')
    const agentA = agentWithProvider(ctx, '/workspace', 'anthropic', 'agent-a')
    const agentB = agentWithProvider(ctx, '/workspace', 'anthropic', 'agent-b')

    ctx.emit('agent/created', { agent: agentA, source: 'startup' })
    await tickPreStep(ctx, agentA)
    ctx.emit('agent/created', { agent: agentB, source: 'startup' })
    await tickPreStep(ctx, agentB)

    expect(spawnCount).toBe(1)
    expect(ctx.commands.list(agentA).some(c => c.name === 'modes:sparc')).toBe(true)
    expect(ctx.commands.list(agentB).some(c => c.name === 'modes:sparc')).toBe(true)
  })

  it('a different cwd spawns its own listing rather than reusing another cwd\'s cache entry', async () => {
    let spawnCount = 0
    queryMock.mockImplementation((params) => {
      spawnCount += 1
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      return fakeListingQuery([
        { name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' },
      ])
    })
    const ctx = await bootHost('/home/operator')
    const agentA = agentWithProvider(ctx, '/workspace-a', 'anthropic', 'agent-a')
    const agentB = agentWithProvider(ctx, '/workspace-b', 'anthropic', 'agent-b')

    ctx.emit('agent/created', { agent: agentA, source: 'startup' })
    await tickPreStep(ctx, agentA)
    ctx.emit('agent/created', { agent: agentB, source: 'startup' })
    await tickPreStep(ctx, agentB)

    expect(spawnCount).toBe(2)
  })

  it('/refresh-skills bypasses the cache and spawns a fresh listing even within the TTL', async () => {
    let spawnCount = 0
    queryMock.mockImplementation((params) => {
      spawnCount += 1
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      return fakeListingQuery([
        { name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' },
      ])
    })
    const ctx = await bootHost('/home/operator')
    const agent = agentWithProvider(ctx, '/workspace', 'anthropic')
    ctx.emit('agent/created', { agent, source: 'startup' })
    await tickPreStep(ctx, agent)
    expect(spawnCount).toBe(1)

    await ctx.commands.execute(agent, '/refresh-skills', [], new AbortController().signal)

    expect(spawnCount).toBe(2)
  })

  it('a failed listing does not poison the cache: the next rescan for the same cwd gets a fresh attempt', async () => {
    let spawnCount = 0
    queryMock.mockImplementation((params) => {
      spawnCount += 1
      if (spawnCount === 1) throw new Error('CLI spawn exploded')
      params.options.spawnClaudeCodeProcess!({
        ...stubClaudeCliCommand, cwd: process.cwd(), env: {}, signal: new AbortController().signal,
      } as never)
      return fakeListingQuery([
        { name: 'modes:sparc', description: 'Boomerang Commander Mode', argumentHint: '<goal>' },
      ])
    })
    const ctx = await bootHost('/home/operator')
    const agentA = agentWithProvider(ctx, '/workspace', 'anthropic', 'agent-a')
    ctx.emit('agent/created', { agent: agentA, source: 'startup' })
    await tickPreStep(ctx, agentA)
    expect(ctx.commands.list(agentA).some(c => c.name === 'modes:sparc')).toBe(false)

    const agentB = agentWithProvider(ctx, '/workspace', 'anthropic', 'agent-b')
    ctx.emit('agent/created', { agent: agentB, source: 'startup' })
    await tickPreStep(ctx, agentB)

    expect(spawnCount).toBe(2)
    expect(ctx.commands.list(agentB).some(c => c.name === 'modes:sparc')).toBe(true)
  })
})
