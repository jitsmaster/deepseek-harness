import { homedir as osHomedir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk'
// Real import: `COMMAND_NAME` is used at runtime below to filter out
// SDK-reported command names that do not conform to DSH's own command-name
// grammar before ever handing them to `commands.register()` (which would
// otherwise throw and fail the whole rescan). This also brings the
// `Context.commands` and `Context.agentDefaultModel` declaration merges into
// scope, same as the prior type-only import.
import { COMMAND_NAME, type CommandRuntime } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent-default-model'
// Type-only: brings the `Context.subprocess` declaration merge into scope
// so the shared managed-process service is reachable off any per-agent
// scoped context below, instead of this package spawning its own child
// processes through a bespoke local helper.
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
  type ClaudeCodeRunSpec,
} from '@deepseek-ai/dsh-subagent-claude-code/src/run.ts'
import {
  listClaudeCodeCommands,
  runClaudeCodeSlashCommand,
} from '@deepseek-ai/dsh-subagent-claude-code/src/list-commands.ts'
import { currentProviderOf } from './model-gate.ts'

export const name = 'claude-skill-commands'
// Require the shared managed-process service so every listing/invocation
// spawn goes through its SIGTERM->SIGKILL escalation ladder, disposeGraceMs
// handling, and whole-process-tree termination — see `buildRunSpec` below.
export const inject = ['subprocess']

/** Deployment-owned override of the home directory skills are read from. */
export interface ClaudeSkillCommandsConfig {
  /** Overrides `os.homedir()` — for tests only; production composition omits this. */
  homedir?: string
}

/** Which provider must be current for these commands to be registered. */
const GATED_PROVIDER = 'anthropic'

/** This plugin's own reserved command name — a listed command can never register over it. */
const REFRESH_COMMAND_NAME = 'refresh-skills'

/**
 * How long one `cwd`'s listing result is reused across sessions/agents
 * before the next rescan pays the CLI subprocess spawn again. `/refresh-skills`
 * evicts its own `cwd` immediately rather than waiting this out.
 */
const LISTING_CACHE_TTL_MS = 5 * 60 * 1000

/** One `cwd`'s in-flight or settled listing, plus when it was started. */
interface CachedListing {
  readonly promise: Promise<readonly SlashCommand[]>
  readonly startedAt: number
}

/**
 * Host-wide (not per-agent) cache of `listClaudeCodeCommands()` results, keyed by `cwd`.
 * @param cache - the host-shared cache, owned by `apply()`.
 * @param runSpec - this rescan's run spec; only `cwd` keys the cache.
 * @returns the cached or freshly spawned listing.
 */
function cachedListClaudeCodeCommands(
  cache: Map<string, CachedListing>,
  runSpec: ClaudeCodeRunSpec,
): Promise<readonly SlashCommand[]> {
  const cached = cache.get(runSpec.cwd)
  if (cached !== undefined && Date.now() - cached.startedAt < LISTING_CACHE_TTL_MS) return cached.promise
  const promise = listClaudeCodeCommands(runSpec)
  cache.set(runSpec.cwd, { promise, startedAt: Date.now() })
  // A failed listing must not poison the cache for the rest of the TTL —
  // the next caller (this one included, via `rescan()`'s own retry paths)
  // should get a fresh attempt instead of the same rejection replayed.
  promise.catch(() => {
    if (cache.get(runSpec.cwd)?.promise === promise) cache.delete(runSpec.cwd)
  })
  return promise
}

/**
 * Command names a listed CLI command can never register over, beyond
 * whatever DSH-side host command already resolves at scan time (checked
 * separately via `commands.find`). `'model'` specifically collides with
 * `packages/client/ui-model-selection`'s client-side contribution of the
 * same name (DSH's own native model-picker popup) — that contribution is
 * registered client-side and never shows up in `commands.find(agent, ...)`,
 * so without this explicit reservation the real Claude Code CLI's built-in
 * `/model` command (reported via `query.supportedCommands()`) would pass the
 * host-only collision guard and get registered here, only to collide with
 * the client contribution later in `ui-commands`'s `candidates()`.
 */
const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([REFRESH_COMMAND_NAME, 'model'])

/**
 * One listed command's registered command, tracked so a later rescan can
 * dispose it and detect a metadata-only change. Carries the exact
 * `description`/`argumentHint` this registration was built from (rather than
 * re-deriving them from the registered `CommandDescriptor`, which normalizes
 * an empty description to a placeholder — see `registerListedCommand`) so
 * `rescan()` can tell "unchanged" apart from "CLI reported new metadata for
 * the same name" without reintroducing the old tier/body-hash identity.
 */
interface RegisteredCommand {
  /** Disposes this command's registration. */
  readonly dispose: () => void
  /** The SDK-reported description this registration was built from. */
  readonly description: string
  /** The SDK-reported argument hint this registration was built from. */
  readonly argumentHint: string
}

/**
 * Whether the agent behind `agentCtx` is currently running on
 * {@link GATED_PROVIDER}. Shared by the `agent/pre-step` gate and by each
 * listed command's handler so an invocation can fail fast on a provider
 * switch the pre-step gate has not yet closed for (see `registerListedCommand`).
 * @param agentCtx - the agent's own scoped context, read for `agentDefaultModel`.
 * @param agent - the agent to read the current provider of.
 * @returns the current provider, or `undefined` when `agentDefaultModel` is
 *   not yet resolved on this context.
 */
function currentGatedProvider(agentCtx: Context, agent: Agent): string | undefined {
  const defaultModel = agentCtx.get('agentDefaultModel')
  return defaultModel === undefined ? undefined : currentProviderOf(agent, defaultModel)
}

/**
 * Register one SDK-reported slash command as a DSH command whose handler
 * delegates the whole invocation to a fresh one-shot Claude Code subagent
 * process (`runClaudeCodeSlashCommand()`) — never the receiving agent's own
 * conversation. The real CLI subprocess owns any "review untrusted content
 * before running it" trust boundary now; DSH no longer steers file content
 * into this agent's turn, so there is no DSH-side confirmation gate here.
 * @param agentCtx - the agent's own scoped context, re-read at invocation
 *   time for the provider gate check below — the `agent/pre-step` gate close
 *   can lag one step behind a provider switch, so a still-registered command
 *   invoked in that window must not unconditionally spawn the real CLI.
 * @param agent - the agent this command was registered for.
 * @param commands - the already-resolved commands service.
 * @param command - the SDK-reported command to register.
 * @param buildRunSpec - builds a fresh {@link ClaudeCodeRunSpec} at invocation time.
 * @returns the effect disposer that unregisters this command.
 */
function registerListedCommand(
  agentCtx: Context,
  agent: Agent,
  commands: CommandRuntime,
  command: SlashCommand,
  buildRunSpec: () => ClaudeCodeRunSpec,
): () => void {
  return commands.register({
    name: command.name,
    description: command.description.trim().length > 0 ? command.description : `Claude Code command "${command.name}"`,
    origin: 'claude-code',
    ...command.argumentHint.trim().length > 0 ? { input: { hint: command.argumentHint } } : {},
    handler: async ({ rawInput, signal }) => {
      // Re-check the provider gate at invocation time rather than trusting
      // that this handler being registered still implies the gate is open:
      // the `agent/pre-step` gate close only runs once per step, so a
      // provider switch mid-step can leave a stale handler reachable for one
      // more invocation. Fail clean instead of spawning the real CLI.
      const provider = currentGatedProvider(agentCtx, agent)
      if (provider !== GATED_PROVIDER) {
        return {
          kind: 'error',
          text: `Claude Code command "${command.name}" is unavailable: the model changed away from Claude.`,
        }
      }
      try {
        const text = await runClaudeCodeSlashCommand(command.name, rawInput, buildRunSpec(), signal)
        return { kind: 'success', text }
      } catch (error: unknown) {
        return {
          kind: 'error',
          text: `Claude Code command "${command.name}" failed: ${String(error)}`,
        }
      }
    },
  })
}

/**
 * Per-agent controller: toggles this agent's Claude Code slash commands on
 * or off before every step, tracking the agent's current model provider so
 * they are re-evaluated rather than decided once at mount. Also owns
 * `/refresh-skills`, registered under the same gate. The same gate sync also
 * runs once, eagerly, as soon as `commands` resolves — otherwise a session
 * created on an already-Anthropic default model would show none of this
 * until its first turn completes and closes the `agent/pre-step` waterfall,
 * which is one full round-trip later than a user opening the command palette
 * on a brand-new session would expect.
 *
 * The `commands` service is injected exactly once, up front — mirroring
 * `dsh-plan-mode`'s constructor-time single-injection pattern — rather than
 * re-entering `agentCtx.inject` per command or per gate-open cycle.
 * @param agentCtx - the agent's own scoped context.
 * @param agent - the agent this scoped context belongs to. Taken directly
 *   from the `agent/created` payload rather than re-derived from
 *   `agentCtx.agent` — that DX accessor is populated only once the full
 *   agent-loop machinery extends the scope with an own `agent` property, a
 *   step orthogonal to this plugin's own per-agent mount.
 * @param homedir - fallback workspace when the agent's session has not yet
 *   recorded a `cwd` (see `buildRunSpec`); also the deployment override
 *   surface tests already rely on.
 * @param subprocess - the shared managed-process service resolved on the
 *   plugin's own context (which declares `inject = ['subprocess']` above) —
 *   read from there rather than `agentCtx`, since a per-agent scoped context
 *   never itself goes through this plugin's own `inject` and cannot resolve
 *   an injected service directly.
 * @param listingCache - the host-wide, `cwd`-keyed listing cache owned by
 *   `apply()` and shared across every agent it mounts.
 */
function mountPerAgent(
  agentCtx: Context,
  agent: Agent,
  homedir: string,
  subprocess: Context['subprocess'],
  listingCache: Map<string, CachedListing>,
): void {
  // Resolved once the single injection below settles. Gate-open ticks that
  // land before then find `commands` still `undefined` and skip registering
  // anything — there is nothing to register against without it.
  let commands: CommandRuntime | undefined
  agentCtx.inject(['commands'], (commandCtx) => {
    commands = commandCtx.commands
    // Don't wait for the first step so commands appear immediately.
    void ensureGateSynced()
  })

  // The currently-registered commands, or `undefined` when none are
  // registered right now. This can be `undefined` either because the gate is
  // closed or because the gate is open but the SDK reported none — those are
  // different states, so gate-transition detection below does not use this
  // variable; see `gateOpen`.
  let registered: Map<string, RegisteredCommand> | undefined
  let refreshCommandDispose: (() => void) | undefined
  // Whether the provider gate was open as of the last sync.
  let gateOpen = false
  // Lets overlapping caller await in-progress gate-open instead of skipping it.
  let openTransition: Promise<void> | undefined
  // Race-condition fix: `rescan()` is reachable from two independent
  // triggers (the `agent/pre-step` gate-open transition and the
  // `/refresh-skills` handler) that can overlap. Without serialization, a
  // second call starting before the first finishes would build `current`
  // from the same stale `registered` snapshot and then clobber the first
  // call's assignment, orphaning the first call's newly-registered
  // `RegisteredCommand.dispose` closures. Track the in-flight scan so an
  // overlapping caller awaits and reuses it instead of running a second pass.
  let rescanInFlight: Promise<{ added: number; removed: number }> | undefined

  /**
   * Build a fresh run spec for one SDK query or one-shot invocation. Built
   * per-call (not cached) so a mid-session cwd change is always honored.
   */
  function buildRunSpec(): ClaudeCodeRunSpec {
    return {
      cwd: agent.session.header.cwd ?? homedir,
      permissionMode: DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
      env: {},
      disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
      // Route every spawn through the shared managed-process service (see
      // `packages/subagent/subagent-claude-code`'s own provider for the
      // identical pattern) instead of a bespoke child_process helper, so
      // termination gets the shared SIGTERM->SIGKILL ladder and whole-tree
      // kill instead of a single best-effort SIGTERM.
      spawn: spawnSpec => subprocess.spawn(spawnSpec),
    }
  }

  /**
   * Serialized entry point for a rescan: a caller that arrives while a scan
   * is already in flight awaits that same scan's result rather than starting
   * a second overlapping pass against a stale `registered` snapshot.
   */
  async function rescan(): Promise<{ added: number; removed: number }> {
    if (rescanInFlight !== undefined) return rescanInFlight
    rescanInFlight = performRescan()
    try {
      return await rescanInFlight
    } finally {
      rescanInFlight = undefined
    }
  }

  async function performRescan(): Promise<{ added: number; removed: number }> {
    if (commands === undefined) return { added: 0, removed: 0 }
    let reported: readonly SlashCommand[]
    try {
      reported = await cachedListClaudeCodeCommands(listingCache, buildRunSpec())
    } catch (error: unknown) {
      agentCtx.logger.warn(`claude-skill-commands: failed to list Claude Code commands: ${String(error)}`)
      return { added: 0, removed: 0 }
    }
    const found = new Map(reported.map(command => [command.name, command]))
    const current = registered ?? new Map<string, RegisteredCommand>()
    let added = 0
    let removed = 0
    for (const [commandName, entry] of [...current]) {
      const command = found.get(commandName)
      // Treat a still-listed command whose description or argument hint
      // changed the same as a removal followed by a re-add below: dispose
      // the stale registration here and let the second loop re-register it
      // with fresh metadata, rather than leaving the old description/hint
      // stale until the command briefly disappears from a later listing.
      const unchanged = command !== undefined
        && entry.description === command.description
        && entry.argumentHint === command.argumentHint
      if (unchanged) continue
      entry.dispose()
      current.delete(commandName)
      removed++
    }
    for (const [commandName, command] of found) {
      if (current.has(commandName)) continue
      // Bug fix: the real Claude Code CLI's naming convention allows
      // characters (e.g. uppercase letters) outside DSH's own stricter
      // `COMMAND_NAME` grammar that `commands.register()` enforces. Registering
      // a non-conforming name throws there, and — unlike the collision case
      // below — that throw was never caught, failing the whole rescan (and
      // the turn that triggered it) instead of skipping just this one
      // command. Validate here and skip before ever reaching `register()`.
      if (!COMMAND_NAME.test(commandName)) {
        agentCtx.logger.warn(`claude-skill-commands: skipping command "${commandName}" — name does not match the required command-name pattern`)
        continue
      }
      // Security fix: never let a listed command silently take over a
      // command name it does not own — neither this plugin's own reserved
      // `/refresh-skills` name, nor a name some other command (global or
      // scoped) already resolves. Skip and warn instead of registering.
      if (RESERVED_COMMAND_NAMES.has(commandName) || commands.find(agent, commandName) !== undefined) {
        agentCtx.logger.warn(`claude-skill-commands: skipping command "${commandName}" — a command named "${commandName}" already exists`)
        continue
      }
      current.set(commandName, {
        dispose: registerListedCommand(agentCtx, agent, commands, command, buildRunSpec),
        description: command.description,
        argumentHint: command.argumentHint,
      })
      added++
    }
    registered = current.size > 0 ? current : undefined
    return { added, removed }
  }

  /**
   * Re-check the provider gate and open/close command registration to
   * match. Called both eagerly (once `commands` resolves) and on every
   * `agent/pre-step` tick, so a session already on Claude gets its commands
   * without waiting for a step, while a later provider switch is still
   * caught.
   */
  async function ensureGateSynced(): Promise<void> {
    if (openTransition !== undefined) return openTransition
    const defaultModel = agentCtx.get('agentDefaultModel')
    if (defaultModel === undefined) return
    const provider = currentProviderOf(agent, defaultModel)
    const shouldBeRegistered = provider === GATED_PROVIDER
    if (shouldBeRegistered && !gateOpen) {
      openTransition = (async () => {
        gateOpen = true
        // List once on gate-open regardless of how many commands are found —
        // `/refresh-skills` must be reachable even when the initial list finds
        // none, so an operator can add a skill later and pick it up.
        await rescan()
        if (commands !== undefined) {
          refreshCommandDispose = commands.register({
            name: REFRESH_COMMAND_NAME,
            description: 'Re-list Claude Code commands and update registered commands',
            handler: async () => {
              // A manual refresh must see this cwd's real, current listing —
              // never a stale cache entry another session's rescan warmed.
              listingCache.delete(buildRunSpec().cwd)
              const { added, removed } = await rescan()
              return { kind: 'success', text: `Refreshed skills: +${added}, -${removed}.` }
            },
          })
        }
      })()
      try {
        await openTransition
      } finally {
        openTransition = undefined
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
  }

  agentCtx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    await ensureGateSynced()
    return decision
  })
  agentCtx.effect(() => () => {
    if (registered !== undefined) for (const entry of registered.values()) entry.dispose()
    refreshCommandDispose?.()
  }, 'claude-skill-commands: dispose on agent teardown')
}

/**
 * Mount Claude Code SDK-backed slash commands for every created agent.
 * @param ctx - Host context carrying `agent/created`.
 * @param config - optional homedir override, for tests.
 */
export function apply(ctx: Context, config: ClaudeSkillCommandsConfig = {}): void {
  const homedir = config.homedir ?? osHomedir()
  // Resolved once, synchronously, while this plugin's own `inject`
  // (declared above) guarantees the property is reachable — a later read
  // off a per-agent scoped context (e.g. `agentCtx.subprocess`) would not be,
  // since that context never itself goes through this plugin's `inject`.
  const subprocess = ctx.subprocess
  // Host-wide, shared across every agent this plugin mounts — see `cachedListClaudeCodeCommands`.
  const listingCache = new Map<string, CachedListing>()
  ctx.on('agent/created', ({ agent }) => {
    mountPerAgent(agent.ctx, agent, homedir, subprocess, listingCache)
  })
}
