import { homedir as osHomedir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: brings the `Context.commands` and `Context.agentDefaultModel`
// declaration merges into scope.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { currentProviderOf } from './model-gate.ts'
import { scanSkillDirectories } from './skill-scanner.ts'
import type { ScannedSkill } from './skill-scanner.ts'

export const name = 'claude-skill-commands'

/** Deployment-owned override of the home directory skills are read from. */
export interface ClaudeSkillCommandsConfig {
  /** Overrides `os.homedir()` — for tests only; production composition omits this. */
  homedir?: string
}

/** Which provider must be current for these commands to be registered. */
const GATED_PROVIDER = 'anthropic'

/**
 * Register one skill as a command whose handler steers its body (plus any
 * typed arguments) into the agent's next turn — the same mechanism
 * `dsh-plan-mode`'s `/plan` command uses.
 * @param agentCtx - the agent's own scoped context (`agent.ctx`).
 * @param agent - the agent this registration belongs to.
 * @param skill - the scanned skill to register.
 * @returns the effect disposer that unregisters this command.
 */
function registerSkillCommand(agentCtx: Context, agent: Agent, skill: ScannedSkill): () => void {
  let dispose: () => void = () => {}
  agentCtx.inject(['commands'], (commandCtx) => {
    dispose = commandCtx.commands.register({
      name: skill.name,
      description: skill.description,
      input: { hint: '[args]' },
      handler: ({ rawInput }) => {
        const args = rawInput.trim()
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: args === '' ? skill.body : `${skill.body}\n\nARGUMENTS: ${args}` }],
          source: { kind: 'user' },
        }))
        return { kind: 'success', text: `Invoked skill "${skill.name}".` }
      },
    })
  })
  return () => { dispose() }
}

/**
 * Per-agent controller: toggles this agent's Claude Code skill commands on
 * or off before every step, tracking the agent's current model provider so
 * they are re-evaluated rather than decided once at mount. Also owns
 * `/refresh-skills`, registered under the same gate.
 * @param agentCtx - the agent's own scoped context.
 * @param agent - the agent this scoped context belongs to. Taken directly
 *   from the `agent/created` payload rather than re-derived from
 *   `agentCtx.agent` — that DX accessor is populated only once the full
 *   agent-loop machinery extends the scope with an own `agent` property, a
 *   step orthogonal to this plugin's own per-agent mount.
 * @param homedir - the directory `~/.claude/skills` is read from.
 */
function mountPerAgent(agentCtx: Context, agent: Agent, homedir: string): void {
  // The currently-registered skill commands, or `undefined` when none are
  // registered right now. This can be `undefined` either because the gate is
  // closed or because the gate is open but zero skills exist on disk — those
  // are different states, so gate-transition detection below does not use
  // this variable; see `gateOpen`.
  let registered: Map<string, () => void> | undefined
  let refreshCommandDispose: (() => void) | undefined
  // Whether the provider gate was open as of the last `agent/pre-step` tick.
  // Tracked independently of `registered`/`refreshCommandDispose` so a
  // zero-skill directory (which leaves `registered` `undefined`) is not
  // mistaken for a gate that just opened — that conflation used to make
  // `rescan()` (a filesystem walk) run on every single step, forever, and
  // left `/refresh-skills` unregistered whenever zero skills existed at gate-open time.
  let gateOpen = false

  function rescan(): { added: number; removed: number } {
    const skills = scanSkillDirectories(agent.session.header.cwd, homedir, (message) => { agentCtx.logger.warn(message) })
    const found = new Map(skills.map(skill => [skill.name, skill]))
    const current = registered ?? new Map<string, () => void>()
    let added = 0
    let removed = 0
    for (const [name, dispose] of [...current]) {
      if (!found.has(name)) { dispose(); current.delete(name); removed++ }
    }
    for (const [name, skill] of found) {
      if (!current.has(name)) { current.set(name, registerSkillCommand(agentCtx, agent, skill)); added++ }
    }
    registered = current.size > 0 ? current : undefined
    return { added, removed }
  }

  agentCtx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    const defaultModel = agentCtx.get('agentDefaultModel')
    if (defaultModel === undefined) return decision
    const provider = currentProviderOf(agent, defaultModel)
    const shouldBeRegistered = provider === GATED_PROVIDER
    if (shouldBeRegistered && !gateOpen) {
      gateOpen = true
      // Scan once on gate-open regardless of how many skills are found —
      // `/refresh-skills` must be reachable even when the initial scan finds
      // none, so an operator can add a skill later and pick it up.
      rescan()
      agentCtx.inject(['commands'], (commandCtx) => {
        refreshCommandDispose = commandCtx.commands.register({
          name: 'refresh-skills',
          description: 'Re-scan Claude Code skill directories and update registered commands',
          handler: () => {
            const { added, removed } = rescan()
            return { kind: 'success', text: `Refreshed skills: +${added}, -${removed}.` }
          },
        })
      })
    } else if (!shouldBeRegistered && gateOpen) {
      gateOpen = false
      if (registered !== undefined) {
        for (const dispose of registered.values()) dispose()
        registered = undefined
      }
      refreshCommandDispose?.()
      refreshCommandDispose = undefined
    }
    return decision
  })
  agentCtx.effect(() => () => {
    if (registered !== undefined) for (const dispose of registered.values()) dispose()
    refreshCommandDispose?.()
  }, 'claude-skill-commands: dispose on agent teardown')
}

/**
 * Mount Claude Code skill-derived slash commands for every created agent.
 * @param ctx - Host context carrying `agent/created`.
 * @param config - optional homedir override, for tests.
 */
export function apply(ctx: Context, config: ClaudeSkillCommandsConfig = {}): void {
  const homedir = config.homedir ?? osHomedir()
  ctx.on('agent/created', ({ agent }) => {
    mountPerAgent(agent.ctx, agent, homedir)
  })
}

export default apply
