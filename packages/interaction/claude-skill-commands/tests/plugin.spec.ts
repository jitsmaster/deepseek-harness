import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
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

  it('invoking the registered command steers the skill body and arguments into the next turn', async () => {
    const ctx = await bootHost(fixturesHome())
    const agent = agentWithProvider(ctx, fixturesProject(), 'anthropic')
    ctx.emit('agent/created', { agent })
    await tickPreStep(ctx, agent)

    const execution = await ctx.commands.execute(agent, '/valid-skill do the thing', [], new AbortController().signal)

    expect(execution?.result.kind).toBe('success')
    expect((agent.steer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    const [message] = (agent.steer as ReturnType<typeof vi.fn>).mock.calls[0] as [{ content: { type: string; text: string }[] }]
    expect(message.content[0]?.text).toContain('# Valid Skill')
    expect(message.content[0]?.text).toContain('ARGUMENTS: do the thing')
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
})
