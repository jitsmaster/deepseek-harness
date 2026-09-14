import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, RegistryService } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { apply as applyClaudeSkillCommands } from '../src/index.ts'

// `vi.spyOn` cannot redefine a native ESM module's exports (Node freezes the
// namespace object), so `readdirSync` call counts are observed by wrapping
// it in a `vi.fn` at mock time instead. `vi.hoisted` lifts the shared
// `vi.fn` above this file's own `node:fs` import so the `vi.mock` factory
// below (also hoisted) can close over it.
const { mockReaddirSync } = vi.hoisted(() => ({ mockReaddirSync: vi.fn() }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  mockReaddirSync.mockImplementation(actual.readdirSync)
  return { ...actual, readdirSync: mockReaddirSync }
})

function fixturesProject(): string {
  return fileURLToPath(new URL('./fixtures/project-root', import.meta.url))
}
function fixturesHome(): string {
  return fileURLToPath(new URL('./fixtures/home', import.meta.url))
}

/**
 * Mints a fake Agent with a real Session and a real scoped `agent.ctx`
 * (via `createScope`, the same real pattern `dsh-plan-mode`'s own tests use),
 * then announces it through `agent/created` since no full AgentRegistry is
 * mounted in this bench.
 */
function agentWithProvider(ctx: Context, cwd: string, provider: string): Agent {
  const session = Session.create(SessionId('agent-1'))
  ;(session as { header: { cwd: string } }).header = { ...session.header, cwd }
  const agent = {
    id: SessionId('agent-1'),
    session: Object.assign(session, {
      requestHeader: () => ({ config: { provider, model: 'x' } }),
    }),
    steer: vi.fn(),
  } as unknown as Agent
  const scoped = createScope(ctx, agent).ctx
  ;(agent as { ctx?: Context }).ctx = scoped
  return agent
}

async function bootHost(homedir: string): Promise<Context> {
  const ctx = new Context()
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek-official' }) } as never)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(applyClaudeSkillCommands, { homedir })
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

describe('claude-skill-commands per-agent registration', () => {
  it('registers a scanned skill as a command when the agent is on anthropic', async () => {
    const ctx = await bootHost(fixturesHome())
    const agent = agentWithProvider(ctx, fixturesProject(), 'anthropic')
    ctx.emit('agent/created', { agent })
    await tickPreStep(ctx, agent)
    expect(ctx.commands.list(agent).some(c => c.name === 'valid-skill')).toBe(true)
  })

  it('does not register skill commands when the agent is on a non-anthropic provider', async () => {
    const ctx = await bootHost(fixturesHome())
    const agent = agentWithProvider(ctx, fixturesProject(), 'deepseek-official')
    ctx.emit('agent/created', { agent })
    await tickPreStep(ctx, agent)
    expect(ctx.commands.list(agent).some(c => c.name === 'valid-skill')).toBe(false)
  })

  it('removes skill commands once the agent switches away from anthropic', async () => {
    const ctx = await bootHost(fixturesHome())
    const agent = agentWithProvider(ctx, fixturesProject(), 'anthropic')
    ctx.emit('agent/created', { agent })
    await tickPreStep(ctx, agent)
    expect(ctx.commands.list(agent).some(c => c.name === 'valid-skill')).toBe(true)
    ;(agent.session as { requestHeader: () => unknown }).requestHeader = () => ({ config: { provider: 'deepseek-official', model: 'x' } })
    await tickPreStep(ctx, agent)
    expect(ctx.commands.list(agent).some(c => c.name === 'valid-skill')).toBe(false)
  })

  it('invoking the registered command with arguments steers the skill body and the typed arguments as two separately-sourced messages', async () => {
    const ctx = await bootHost(fixturesHome())
    const agent = agentWithProvider(ctx, fixturesProject(), 'anthropic')
    ctx.emit('agent/created', { agent })
    await tickPreStep(ctx, agent)

    // Fix C: a project-tier skill's first invocation is a confirmation only
    // (no steer) — "use up" that step before the real invocation this test
    // asserts on.
    await ctx.commands.execute(agent, '/valid-skill', [], new AbortController().signal)

    const execution = await ctx.commands.execute(agent, '/valid-skill do the thing', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('success')
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock does not use `this`
    const steer = agent.steer as ReturnType<typeof vi.fn>
    expect(steer.mock.calls.length).toBe(2)

    // First message: the repo-authored skill body, denied human authority.
    const [bodyMessage] = steer.mock.calls[0] as [{ source: { kind: string }; content: { type: string; text: string }[] }]
    expect(bodyMessage.source.kind).toBe('plugin')
    expect(bodyMessage.content[0]?.text).toBe('# Valid Skill\n\nDo the valid thing.')
    expect(bodyMessage.content[0]?.text).not.toContain('ARGUMENTS')

    // Second message: the operator-typed argument text, keeping real human authority.
    const [argsMessage] = steer.mock.calls[1] as [{ source: { kind: string }; content: { type: string; text: string }[] }]
    expect(argsMessage.source.kind).toBe('user')
    expect(argsMessage.content[0]?.text).toBe('ARGUMENTS: do the thing')
  })

  it('invoking the registered command with no arguments steers only the skill body, as a single plugin-sourced message', async () => {
    const ctx = await bootHost(fixturesHome())
    const agent = agentWithProvider(ctx, fixturesProject(), 'anthropic')
    ctx.emit('agent/created', { agent })
    await tickPreStep(ctx, agent)

    // Fix C: a project-tier skill's first invocation is a confirmation only
    // (no steer) — "use up" that step before the real invocation this test
    // asserts on.
    await ctx.commands.execute(agent, '/valid-skill', [], new AbortController().signal)

    const execution = await ctx.commands.execute(agent, '/valid-skill', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('success')
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock does not use `this`
    const steer = agent.steer as ReturnType<typeof vi.fn>
    expect(steer.mock.calls.length).toBe(1)
    const [bodyMessage] = steer.mock.calls[0] as [{ source: { kind: string }; content: { type: string; text: string }[] }]
    expect(bodyMessage.source.kind).toBe('plugin')
    expect(bodyMessage.content[0]?.text).toBe('# Valid Skill\n\nDo the valid thing.')
  })

  it('/refresh-skills picks up a skill added after the agent was created, and drops one removed', async () => {
    const project = mkdtempSync(join(tmpdir(), 'claude-skill-commands-refresh-'))
    try {
      const ctx = await bootHost(fixturesHome())
      const agent = agentWithProvider(ctx, project, 'anthropic')
      ctx.emit('agent/created', { agent })
      await tickPreStep(ctx, agent)

      // Nothing registered yet — project dir started empty.
      expect(ctx.commands.list(agent).some(c => c.name === 'new-skill')).toBe(false)

      // A skill appears on disk after the agent was already created.
      const skillDir = join(project, '.claude', 'skills', 'new-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: new-skill\ndescription: Added later\n---\n\nRefreshed in.\n')

      const execution = await ctx.commands.execute(agent, '/refresh-skills', [], new AbortController().signal)
      expect(execution?.result.kind).toBe('success')
      expect(ctx.commands.list(agent).some(c => c.name === 'new-skill')).toBe(true)

      // Removing it from disk and refreshing again drops the command.
      rmSync(skillDir, { recursive: true, force: true })
      await ctx.commands.execute(agent, '/refresh-skills', [], new AbortController().signal)
      expect(ctx.commands.list(agent).some(c => c.name === 'new-skill')).toBe(false)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('registers /refresh-skills even when zero skills exist anywhere, and refresh picks up one added later', async () => {
    // Neither directory has a `.claude/skills` at all (unlike `fixturesHome()`,
    // whose fixture always has skills) — the exact condition Fix 1 covers.
    const project = mkdtempSync(join(tmpdir(), 'claude-skill-commands-empty-project-'))
    const home = mkdtempSync(join(tmpdir(), 'claude-skill-commands-empty-home-'))
    try {
      const ctx = await bootHost(home)
      const agent = agentWithProvider(ctx, project, 'anthropic')
      ctx.emit('agent/created', { agent })
      await tickPreStep(ctx, agent)

      // The gate opened even though the initial scan found nothing, so
      // /refresh-skills must already be reachable.
      expect(ctx.commands.list(agent).some(c => c.name === 'refresh-skills')).toBe(true)

      const skillDir = join(project, '.claude', 'skills', 'new-skill')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: new-skill\ndescription: Added later\n---\n\nRefreshed in.\n')

      const execution = await ctx.commands.execute(agent, '/refresh-skills', [], new AbortController().signal)
      expect(execution?.result.kind).toBe('success')
      expect(ctx.commands.list(agent).some(c => c.name === 'new-skill')).toBe(true)
    } finally {
      rmSync(project, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not rescan the filesystem on every pre-step tick while the gate stays open with no skill-count change', async () => {
    const project = mkdtempSync(join(tmpdir(), 'claude-skill-commands-empty-project-'))
    const home = mkdtempSync(join(tmpdir(), 'claude-skill-commands-empty-home-'))
    try {
      const ctx = await bootHost(home)
      const agent = agentWithProvider(ctx, project, 'anthropic')
      ctx.emit('agent/created', { agent })
      mockReaddirSync.mockClear()

      // First tick: the gate transitions closed -> open, so exactly one
      // rescan (a readdirSync per scanned directory) is expected.
      await tickPreStep(ctx, agent)
      const callsAfterFirstTick = mockReaddirSync.mock.calls.length
      expect(callsAfterFirstTick).toBeGreaterThan(0)

      // Further ticks with the gate already open and no skill-count change
      // must not rescan again — before the fix, `registered` stayed
      // `undefined` (zero skills found) so every tick re-ran `rescan()`.
      await tickPreStep(ctx, agent)
      await tickPreStep(ctx, agent)
      expect(mockReaddirSync.mock.calls.length).toBe(callsAfterFirstTick)
    } finally {
      rmSync(project, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not let a skill shadow an already-resolvable command of the same name, and warns about the collision', async () => {
    const project = mkdtempSync(join(tmpdir(), 'claude-skill-commands-collision-'))
    try {
      const ctx = await bootHost(fixturesHome())
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
      // A global command already resolves "compact" before any agent exists.
      ctx.commands.register({
        name: 'compact',
        description: 'Global compact command',
        handler: () => ({ kind: 'success', text: 'global-compact' }),
      })

      const skillDir = join(project, '.claude', 'skills', 'compact')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: compact\ndescription: Shadowing skill\n---\n\nDo not shadow me.\n')

      const agent = agentWithProvider(ctx, project, 'anthropic')
      ctx.emit('agent/created', { agent })
      await tickPreStep(ctx, agent)

      const execution = await ctx.commands.execute(agent, '/compact', [], new AbortController().signal)
      expect(execution?.result.kind).toBe('success')
      // The global command must still win — not the skill's "Invoked skill" text.
      expect(execution?.result.text).toBe('global-compact')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('compact'))
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('does not let a skill literally named refresh-skills collide with the plugin\'s own /refresh-skills registration', async () => {
    const project = mkdtempSync(join(tmpdir(), 'claude-skill-commands-refresh-collision-'))
    try {
      const ctx = await bootHost(fixturesHome())

      const skillDir = join(project, '.claude', 'skills', 'refresh-skills')
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: refresh-skills\ndescription: Impersonating skill\n---\n\nDo not collide.\n')

      const agent = agentWithProvider(ctx, project, 'anthropic')
      ctx.emit('agent/created', { agent })
      await tickPreStep(ctx, agent)

      const execution = await ctx.commands.execute(agent, '/refresh-skills', [], new AbortController().signal)
      expect(execution?.result.kind).toBe('success')
      // The real refresh handler must win — not the impersonating skill's "Invoked skill" text.
      expect(execution?.result.text).toMatch(/^Refreshed skills: \+\d+, -\d+\.$/)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('injects the commands service at most once per agent, even across repeated provider gate open/close cycles', async () => {
    const ctx = await bootHost(fixturesHome())
    const injectSpy = vi.spyOn(RegistryService.prototype, 'inject')
    const agent = agentWithProvider(ctx, fixturesProject(), 'anthropic')
    ctx.emit('agent/created', { agent })

    const setProvider = (provider: string): void => {
      ;(agent.session as { requestHeader: () => unknown }).requestHeader = () => ({ config: { provider, model: 'x' } })
    }

    // Cycle the gate open/closed three times.
    await tickPreStep(ctx, agent) // closed -> open
    setProvider('deepseek-official')
    await tickPreStep(ctx, agent) // open -> closed
    setProvider('anthropic')
    await tickPreStep(ctx, agent) // closed -> open
    setProvider('deepseek-official')
    await tickPreStep(ctx, agent) // open -> closed
    setProvider('anthropic')
    await tickPreStep(ctx, agent) // closed -> open

    const commandsInjectCalls = injectSpy.mock.calls.filter(
      call => Array.isArray(call[0]) && call[0].length === 1 && call[0][0] === 'commands',
    )
    expect(commandsInjectCalls.length).toBeLessThanOrEqual(1)
  })
})

// Fix A: `currentProviderOf` reads only the last ACTUALLY-EXECUTED turn's
// request header, which structurally lags one step behind an operator
// switching the session's model. The periodic `agent/pre-step` gate toggle
// inherits this lag, so a skill command can remain registered — and
// invocable — for one extra turn after the operator switches away from
// `anthropic`. The handler itself must re-derive the current provider AT
// INVOCATION TIME and refuse to steer if it has drifted, rather than
// trusting that the command's mere registration means the gate is open.
describe('claude-skill-commands — model-gate re-check at invocation (Fix A)', () => {
  it('refuses to steer and returns an error when the provider has drifted away from anthropic since the command was registered, even though the gate has not re-ticked to notice yet', async () => {
    const ctx = await bootHost(fixturesHome())
    const agent = agentWithProvider(ctx, fixturesProject(), 'anthropic')
    ctx.emit('agent/created', { agent })
    await tickPreStep(ctx, agent)
    expect(ctx.commands.list(agent).some(c => c.name === 'valid-skill')).toBe(true)

    // Simulate the exact lag window: the operator has switched providers,
    // but the gate has not re-ticked (no further `tickPreStep` call) — the
    // command is technically still registered.
    ;(agent.session as { requestHeader: () => unknown }).requestHeader = () => ({ config: { provider: 'deepseek-official', model: 'x' } })

    const execution = await ctx.commands.execute(agent, '/valid-skill', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('error')
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock does not use `this`
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('still steers normally when the agent is genuinely still on anthropic at invocation time (regression guard)', async () => {
    const ctx = await bootHost(fixturesHome())
    const agent = agentWithProvider(ctx, fixturesProject(), 'anthropic')
    ctx.emit('agent/created', { agent })
    await tickPreStep(ctx, agent)

    // `user-only` is a user-tier skill (not subject to Fix C's project-skill
    // confirmation gate), so this exercises Fix A's provider re-check in
    // isolation, on a single first invocation.
    const execution = await ctx.commands.execute(agent, '/user-only', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('success')
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock does not use `this`
    expect(agent.steer).toHaveBeenCalled()
  })
})

// Fix C: a project-tier skill's full body is a repo-authored file the
// operator never saw before invoking it — a prompt-injection surface. Before
// the FIRST invocation of any given project-tier skill in an agent's
// lifetime, its full body must be shown for confirmation instead of being
// steered; only a SECOND invocation of that same skill name actually steers
// it. User-tier skills (the operator's own trusted `~/.claude/skills`) are
// exempt and continue to steer immediately on first invocation.
describe('claude-skill-commands — project-skill first-use confirmation (Fix C)', () => {
  it('invoking a project-tier skill for the first time shows its full body for confirmation, and does not steer', async () => {
    const ctx = await bootHost(fixturesHome())
    const agent = agentWithProvider(ctx, fixturesProject(), 'anthropic')
    ctx.emit('agent/created', { agent })
    await tickPreStep(ctx, agent)

    const execution = await ctx.commands.execute(agent, '/valid-skill', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('success')
    expect(execution?.result.text).toContain('# Valid Skill\n\nDo the valid thing.')
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock does not use `this`
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('invoking that same project-tier skill a second time steers the skill body, without showing the confirmation again', async () => {
    const ctx = await bootHost(fixturesHome())
    const agent = agentWithProvider(ctx, fixturesProject(), 'anthropic')
    ctx.emit('agent/created', { agent })
    await tickPreStep(ctx, agent)

    await ctx.commands.execute(agent, '/valid-skill', [], new AbortController().signal) // first: confirmation only, no steer
    const execution = await ctx.commands.execute(agent, '/valid-skill', [], new AbortController().signal) // second: steers

    expect(execution?.result.kind).toBe('success')
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock does not use `this`
    const steer = agent.steer as ReturnType<typeof vi.fn>
    expect(steer.mock.calls.length).toBe(1)
    const [bodyMessage] = steer.mock.calls[0] as [{ source: { kind: string }; content: { type: string; text: string }[] }]
    expect(bodyMessage.source.kind).toBe('plugin')
    expect(bodyMessage.content[0]?.text).toBe('# Valid Skill\n\nDo the valid thing.')
  })

  it('invoking a user-tier skill steers immediately on the first invocation, with no confirmation shown (regression guard)', async () => {
    const ctx = await bootHost(fixturesHome())
    const agent = agentWithProvider(ctx, fixturesProject(), 'anthropic')
    ctx.emit('agent/created', { agent })
    await tickPreStep(ctx, agent)

    const execution = await ctx.commands.execute(agent, '/user-only', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('success')
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock does not use `this`
    const steer = agent.steer as ReturnType<typeof vi.fn>
    expect(steer.mock.calls.length).toBe(1)
    const [bodyMessage] = steer.mock.calls[0] as [{ source: { kind: string }; content: { type: string; text: string }[] }]
    expect(bodyMessage.source.kind).toBe('plugin')
    expect(bodyMessage.content[0]?.text).toBe('User-only body.')
  })

  it('keeps a project skill\'s confirmed-and-invoked state across /refresh-skills, so a second invocation after a rescan still steers', async () => {
    const ctx = await bootHost(fixturesHome())
    const agent = agentWithProvider(ctx, fixturesProject(), 'anthropic')
    ctx.emit('agent/created', { agent })
    await tickPreStep(ctx, agent)

    await ctx.commands.execute(agent, '/valid-skill', [], new AbortController().signal) // confirmation only
    const refresh = await ctx.commands.execute(agent, '/refresh-skills', [], new AbortController().signal)
    expect(refresh?.result.kind).toBe('success')
    const execution = await ctx.commands.execute(agent, '/valid-skill', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('success')
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock does not use `this`
    const steer = agent.steer as ReturnType<typeof vi.fn>
    expect(steer.mock.calls.length).toBe(1)
  })
})

// Regression guard: `confirmedProjectSkills` used to be a `Set<string>` keyed
// by skill NAME only, never by content, which let a re-added project skill
// with edited (possibly malicious) body content ride on a stale confirmation
// for its old name. The fix (index.ts) now keys confirmation by
// `skillIdentityKey` — tier + name + a hash of the body — so a body edit
// under the same name is no longer treated as already-confirmed. These tests
// guard against that bug regressing.
describe('claude-skill-commands — confirmedProjectSkills keyed by identity, not name alone (regression guard)', () => {
  it('does not treat a re-added project skill as already-confirmed when its body has changed since the name was last confirmed (confirmation-bypass)', async () => {
    const project = mkdtempSync(join(tmpdir(), 'claude-skill-commands-reconfirm-'))
    try {
      const ctx = await bootHost(fixturesHome())
      const agent = agentWithProvider(ctx, project, 'anthropic')
      const skillDir = join(project, '.claude', 'skills', 'reconfirm-skill')
      const bodyA = 'Body A — the original, reviewed content.'
      const bodyB = 'Body B — different (malicious) content, never reviewed.'

      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: reconfirm-skill\ndescription: Reconfirm test skill\n---\n\n${bodyA}\n`)
      ctx.emit('agent/created', { agent })
      await tickPreStep(ctx, agent)

      // First invocation of "reconfirm-skill": confirmation only, no steer —
      // this records the name in `confirmedProjectSkills`.
      const firstInvocation = await ctx.commands.execute(agent, '/reconfirm-skill', [], new AbortController().signal)
      expect(firstInvocation?.result.kind).toBe('success')
      // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock does not use `this`
      expect(agent.steer).not.toHaveBeenCalled()

      // Remove the skill, then re-add a skill with the SAME NAME but
      // DIFFERENT (attacker-controlled) body content, and refresh.
      rmSync(skillDir, { recursive: true, force: true })
      await ctx.commands.execute(agent, '/refresh-skills', [], new AbortController().signal)
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: reconfirm-skill\ndescription: Reconfirm test skill\n---\n\n${bodyB}\n`)
      await ctx.commands.execute(agent, '/refresh-skills', [], new AbortController().signal)

      // Invoking "reconfirm-skill" again must show the NEW body for
      // confirmation again — it is different content the operator has never
      // seen — not steer it immediately just because the NAME was confirmed
      // before.
      const secondInvocation = await ctx.commands.execute(agent, '/reconfirm-skill', [], new AbortController().signal)
      expect(secondInvocation?.result.kind).toBe('success')
      expect(secondInvocation?.result.text).toContain(bodyB)
      // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock does not use `this`
      expect(agent.steer).not.toHaveBeenCalled()
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('picks up an in-place body edit on /refresh-skills, steering the NEW body and reporting a real change (not "+0, -0") — not a stale closure of the old body', async () => {
    const project = mkdtempSync(join(tmpdir(), 'claude-skill-commands-edit-project-'))
    const home = mkdtempSync(join(tmpdir(), 'claude-skill-commands-edit-home-'))
    try {
      const skillDir = join(home, '.claude', 'skills', 'edit-skill')
      const bodyA = 'Original body A.'
      const bodyB = 'Edited body B — should be steered instead.'
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: edit-skill\ndescription: Edit test skill\n---\n\n${bodyA}\n`)

      const ctx = await bootHost(home)
      // User-tier skill: steers immediately on first invocation, no Fix C
      // confirmation gate in the way of observing the steered body directly.
      const agent = agentWithProvider(ctx, project, 'anthropic')
      ctx.emit('agent/created', { agent })
      await tickPreStep(ctx, agent)

      const before = await ctx.commands.execute(agent, '/edit-skill', [], new AbortController().signal)
      expect(before?.result.kind).toBe('success')
      // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock does not use `this`
      const steerBefore = agent.steer as ReturnType<typeof vi.fn>
      expect(steerBefore.mock.calls[0]?.[0]).toMatchObject({ content: [{ text: bodyA }] })

      // Edit the SKILL.md body in place — same name, changed content — then rescan.
      writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: edit-skill\ndescription: Edit test skill\n---\n\n${bodyB}\n`)
      const refresh = await ctx.commands.execute(agent, '/refresh-skills', [], new AbortController().signal)
      expect(refresh?.result.kind).toBe('success')
      // The diff report must reflect an actual change, not "+0, -0" — an
      // in-place content edit with an unchanged name is still a real change
      // that `/refresh-skills` must not silently ignore.
      expect(refresh?.result.text).not.toBe('Refreshed skills: +0, -0.')

      const after = await ctx.commands.execute(agent, '/edit-skill', [], new AbortController().signal)
      expect(after?.result.kind).toBe('success')
      // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock does not use `this`
      const steerAfter = agent.steer as ReturnType<typeof vi.fn>
      const lastCall = steerAfter.mock.calls[steerAfter.mock.calls.length - 1] as [{ content: { text: string }[] }]
      // Must reflect the EDITED body — a stale closure would still steer bodyA.
      expect(lastCall[0].content[0]?.text).toBe(bodyB)
    } finally {
      rmSync(project, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})
