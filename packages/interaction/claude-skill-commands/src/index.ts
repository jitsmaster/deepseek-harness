import { createHash } from 'node:crypto'
import { homedir as osHomedir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: brings the `Context.commands` and `Context.agentDefaultModel`
// declaration merges into scope.
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
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

/** This plugin's own reserved command name — a skill can never register over it. */
const REFRESH_COMMAND_NAME = 'refresh-skills'

/**
 * Deterministic identity for one skill's exact registered content, combining
 * tier, name, and a hash of its body. Used both to key Fix C's confirmation
 * state and to detect (in `rescan()`) whether a still-present skill name now
 * points at different content.
 *
 * Keying on name alone let a project skill be removed and re-added under the
 * SAME name but a DIFFERENT (attacker-controlled) body silently inherit the
 * old body's "already confirmed" status — the operator never saw the new
 * content. Folding the body hash into the key closes that bypass: a changed
 * body is a different identity, so it starts unconfirmed again.
 * @param skill - the scanned skill to derive an identity for.
 * @returns a stable string key unique to this tier+name+body combination.
 */
function skillIdentityKey(skill: ScannedSkill): string {
  const bodyHash = createHash('sha256').update(skill.body).digest('hex')
  return `${skill.tier}:${skill.name}:${bodyHash}`
}

/** One skill's registered command, tracked alongside the exact content it was registered for. */
interface RegisteredSkill {
  /** Disposes this skill's registered command. */
  readonly dispose: () => void
  /** The `skillIdentityKey` this registration was made under — compared against a fresh scan to detect a body edit under the same name. */
  readonly identityKey: string
}

/**
 * Register one skill as a command whose handler steers its body (plus any
 * typed arguments) into the agent's next turn — the same mechanism
 * `dsh-plan-mode`'s `/plan` command uses.
 * @param commands - the already-resolved commands service (see
 *   `mountPerAgent` — injected exactly once per agent, not per skill).
 * @param agent - the agent this registration belongs to.
 * @param skill - the scanned skill to register.
 * @param agentCtx - the agent's own scoped context, re-read at invocation
 *   time (Fix A) rather than trusted from registration time — see the
 *   handler body below.
 * @param confirmedProjectSkills - identity keys (`skillIdentityKey`) of
 *   project-tier skills this agent has already confirmed at least once (Fix
 *   C), keyed by tier+name+body-hash rather than name alone so a body edit
 *   under the same name is never mistaken for already-confirmed content.
 *   Lives in `mountPerAgent`'s outer closure so it survives across
 *   `rescan()`/`/refresh-skills` calls.
 * @returns the effect disposer that unregisters this command.
 */
function registerSkillCommand(
  commands: CommandRuntime,
  agent: Agent,
  skill: ScannedSkill,
  agentCtx: Context,
  confirmedProjectSkills: Set<string>,
): () => void {
  return commands.register({
    name: skill.name,
    description: skill.description,
    input: { hint: '[args]' },
    handler: ({ rawInput }) => {
      // Fix A: the periodic `agent/pre-step` gate toggle lags one step
      // behind an operator switching providers, so a command can remain
      // registered — and invocable — for one extra turn after the session
      // has actually left `anthropic`. Re-derive the CURRENT provider here,
      // at invocation time, rather than trusting that mere registration
      // still means the gate is open.
      const defaultModel = agentCtx.get('agentDefaultModel')
      if (defaultModel !== undefined && currentProviderOf(agent, defaultModel) !== GATED_PROVIDER) {
        return { kind: 'error', text: `Skill "${skill.name}" is unavailable — the session's model has changed since this command was registered.` }
      }
      // Fix C: a project-tier skill's body is repo-authored content the
      // operator never saw before invoking it — a prompt-injection surface.
      // Show it for confirmation (without steering) on the first invocation
      // per skill IDENTITY (tier+name+body-hash), per agent lifetime; only a
      // second invocation of that same identity steers. A body edit under
      // the same name is a different identity, so it is unconfirmed again.
      // User-tier skills (the operator's own `~/.claude/skills`) are trusted
      // and steer immediately, as before.
      const identityKey = skillIdentityKey(skill)
      if (skill.tier === 'project' && !confirmedProjectSkills.has(identityKey)) {
        confirmedProjectSkills.add(identityKey)
        return {
          kind: 'success',
          text: `${skill.body}\n\nThis is a project-level skill from the repository, not your own ~/.claude/skills — review it before proceeding. Invoking "/${skill.name}" again will actually run it.`,
        }
      }
      const args = rawInput.trim()
      // Security fix: the skill body is repo-authored file content, not
      // human-typed input, so it must not be steered under `source: { kind:
      // 'user' }` — that kind is host-attested human authority, read by
      // downstream checks such as `dsh-tool-goal`'s `hasDirectHumanInput()`.
      // Steer it under `kind: 'plugin'` instead, as its own message.
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: skill.body }],
        source: { kind: 'plugin', plugin: name, form: 'instructions' },
      }))
      // The operator's own typed text keeps real human authority: steer it
      // as a second, separately-sourced `kind: 'user'` message, only when
      // they actually typed something.
      if (args !== '') {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: `ARGUMENTS: ${args}` }],
          source: { kind: 'user' },
        }))
      }
      return { kind: 'success', text: `Invoked skill "${skill.name}".` }
    },
  })
}

/**
 * Per-agent controller: toggles this agent's Claude Code skill commands on
 * or off before every step, tracking the agent's current model provider so
 * they are re-evaluated rather than decided once at mount. Also owns
 * `/refresh-skills`, registered under the same gate.
 *
 * The `commands` service is injected exactly once, up front — mirroring
 * `dsh-plan-mode`'s constructor-time single-injection pattern — rather than
 * re-entering `agentCtx.inject` per skill or per gate-open cycle. Injecting
 * repeatedly used to leak one Cordis Fiber per skill per gate-open cycle on
 * a long-lived agent, and exposed a same-tick race on the old lazy
 * `dispose`/`refreshCommandDispose` closures while a nested `inject`
 * callback was still pending. The `agent/pre-step` listener and teardown
 * effect stay registered synchronously at the top of this function (not
 * nested inside the injection) — `inject`'s callback runs at least one
 * microtask later even when the service already exists, so nesting the
 * listener registration itself inside it would leave the very first
 * `agent/pre-step` tick with no listener to dispatch to.
 * @param agentCtx - the agent's own scoped context.
 * @param agent - the agent this scoped context belongs to. Taken directly
 *   from the `agent/created` payload rather than re-derived from
 *   `agentCtx.agent` — that DX accessor is populated only once the full
 *   agent-loop machinery extends the scope with an own `agent` property, a
 *   step orthogonal to this plugin's own per-agent mount.
 * @param homedir - the directory `~/.claude/skills` is read from.
 */
function mountPerAgent(agentCtx: Context, agent: Agent, homedir: string): void {
  // Resolved once the single injection below settles. Gate-open ticks that
  // land before then find `commands` still `undefined` and skip registering
  // anything — there is nothing to register against without it.
  let commands: CommandRuntime | undefined
  agentCtx.inject(['commands'], (commandCtx) => {
    commands = commandCtx.commands
  })

  // The currently-registered skill commands, or `undefined` when none are
  // registered right now. This can be `undefined` either because the gate is
  // closed or because the gate is open but zero skills exist on disk — those
  // are different states, so gate-transition detection below does not use
  // this variable; see `gateOpen`.
  let registered: Map<string, RegisteredSkill> | undefined
  let refreshCommandDispose: (() => void) | undefined
  // Fix C: project-tier skill IDENTITIES (`skillIdentityKey` — tier+name+body
  // hash, not name alone) this agent has confirmed at least once. Declared in
  // this OUTER closure (not inside `rescan()`) so it persists across
  // `rescan()`/`/refresh-skills` calls for the agent's whole lifetime — a
  // skill re-registered by a later rescan with UNCHANGED content must not
  // lose its already-confirmed state, but one re-registered with a CHANGED
  // body (a different identity key) must start unconfirmed again.
  const confirmedProjectSkills = new Set<string>()
  // Whether the provider gate was open as of the last `agent/pre-step` tick.
  // Tracked independently of `registered`/`refreshCommandDispose` so a
  // zero-skill directory (which leaves `registered` `undefined`) is not
  // mistaken for a gate that just opened — that conflation used to make
  // `rescan()` (a filesystem walk) run on every single step, forever, and
  // left `/refresh-skills` unregistered whenever zero skills existed at gate-open time.
  let gateOpen = false

  function rescan(): { added: number; removed: number } {
    if (commands === undefined) return { added: 0, removed: 0 }
    const skills = scanSkillDirectories(agent.session.header.cwd, homedir, (message) => { agentCtx.logger.warn(message) })
    const found = new Map(skills.map(skill => [skill.name, skill]))
    const current = registered ?? new Map<string, RegisteredSkill>()
    let added = 0
    let removed = 0
    for (const [skillName, entry] of [...current]) {
      const skill = found.get(skillName)
      // A registered skill is dropped — its command disposed — both when it
      // disappears from disk AND when its body has changed since it was
      // registered under this name (an in-place SKILL.md edit, or a
      // remove-then-re-add cycle with different content). The re-register
      // pass below then closes a fresh handler over the NEW skill object, so
      // no stale closure of the old body survives, and (via
      // `confirmedProjectSkills` being keyed on the OLD identity) the new
      // content starts unconfirmed again rather than inheriting Fix C's
      // already-confirmed status.
      if (skill === undefined || skillIdentityKey(skill) !== entry.identityKey) {
        entry.dispose()
        current.delete(skillName)
        removed++
      }
    }
    for (const [skillName, skill] of found) {
      if (current.has(skillName)) continue
      // Security fix: never let a skill silently take over a command name
      // it does not own — neither this plugin's own reserved
      // `/refresh-skills` name, nor a name some other command (global or
      // scoped) already resolves, e.g. a skill named "compact" hijacking
      // the built-in `/compact`. Skip and warn instead of registering.
      if (skillName === REFRESH_COMMAND_NAME || commands.find(agent, skillName) !== undefined) {
        agentCtx.logger.warn(`claude-skill-commands: skipping skill "${skillName}" — a command named "${skillName}" already exists`)
        continue
      }
      current.set(skillName, {
        dispose: registerSkillCommand(commands, agent, skill, agentCtx, confirmedProjectSkills),
        identityKey: skillIdentityKey(skill),
      })
      added++
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
      if (commands !== undefined) {
        refreshCommandDispose = commands.register({
          name: REFRESH_COMMAND_NAME,
          description: 'Re-scan Claude Code skill directories and update registered commands',
          handler: () => {
            const { added, removed } = rescan()
            return { kind: 'success', text: `Refreshed skills: +${added}, -${removed}.` }
          },
        })
      }
    } else if (!shouldBeRegistered && gateOpen) {
      gateOpen = false
      if (registered !== undefined) {
        for (const entry of registered.values()) entry.dispose()
        registered = undefined
      }
      refreshCommandDispose?.()
      refreshCommandDispose = undefined
    }
    return decision
  })
  agentCtx.effect(() => () => {
    if (registered !== undefined) for (const entry of registered.values()) entry.dispose()
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
