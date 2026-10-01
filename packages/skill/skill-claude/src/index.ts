/**
 * Claude Code skills, command files, and enabled-plugin skills as DSH skills.
 * The provider reads Claude's files directly and registers them with the skill
 * registry; no Claude process runs.
 *
 * @module @deepseek-ai/dsh-skill-claude
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderObservation,
  SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
import { loadDefinition, scanRoot } from './scan.ts'
import { findProjectRoot, resolveClaudeHome, resolveSources } from './sources.ts'
import type { Warn } from './types.ts'
import { RootWatcher, type WatchTarget } from './watch.ts'

export const name = 'skill-claude'
export const inject = ['skills']

const DEFAULT_PROVIDER_NAME = 'claude'
const DEFAULT_WATCH_STABILITY_THRESHOLD_MS = 200
const DEFAULT_WATCH_POLL_INTERVAL_MS = 100

/** Claude skill provider configuration. */
export interface Config {
  /** Unique provider name. Defaults to `claude`. */
  providerName?: string
  /** Claude configuration root. Defaults to `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claudeHome?: string
  /** Whether the project's `.claude/skills` and `.claude/commands` are scanned. */
  includeProject?: boolean
  /** Whether skills and commands of enabled user-scope plugins are scanned. */
  includePlugins?: boolean
  /** Whether scanned roots and configuration files are watched for catalog changes. */
  watch?: boolean
  /** Whether Chokidar uses polling instead of native filesystem events. */
  watchUsePolling?: boolean
  /** Milliseconds a changed file must remain stable before it is observed. */
  watchStabilityThresholdMs?: number
  /** Milliseconds between Chokidar stability or polling probes. */
  watchPollIntervalMs?: number
}

export const Config: Schema<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  claudeHome: z.string(),
  includeProject: z.boolean().default(true),
  includePlugins: z.boolean().default(true),
  watch: z.boolean().default(true),
  watchUsePolling: z.boolean().default(false),
  watchStabilityThresholdMs: z.number().default(DEFAULT_WATCH_STABILITY_THRESHOLD_MS),
  watchPollIntervalMs: z.number().default(DEFAULT_WATCH_POLL_INTERVAL_MS),
})

/**
 * Register the Claude skill provider on `ctx.skills`.
 * @param ctx - plugin context that injects the skill registry.
 * @param config - provider configuration; omitted fields use the documented defaults.
 */
export function apply(ctx: Context, config: Config = {}): void {
  let provider!: ClaudeSkillProvider
  ctx.skills.registerProvider((control) => {
    provider = new ClaudeSkillProvider(config, control, (message) => { ctx.logger.warn(message) })
    return provider
  })
  ctx.effect(function* () {
    yield async () => { await provider.dispose() }
  }, 'skill-claude watcher')
}

/** Provider that maps Claude skill and command files into `ctx.skills`. */
export class ClaudeSkillProvider implements SkillProvider {
  readonly name: string
  private readonly claudeHome: string
  private readonly includeProject: boolean
  private readonly includePlugins: boolean
  private readonly warned = new Set<string>()
  private readonly warn: Warn
  private readonly watcher: RootWatcher | undefined

  /**
   * @param config - provider configuration; omitted fields use the documented defaults.
   * @param control - registration control; `invalidate()` runs when a watched path changes.
   * @param log - sink for provider warnings.
   */
  constructor(config: Config, control: SkillProviderControl, log: (message: string) => void) {
    this.name = config.providerName ?? DEFAULT_PROVIDER_NAME
    this.claudeHome = resolveClaudeHome(config.claudeHome)
    this.includeProject = config.includeProject ?? true
    this.includePlugins = config.includePlugins ?? true
    this.warn = (key, message) => {
      const id = `${key}\u0000${message}`
      if (this.warned.has(id)) return
      this.warned.add(id)
      log(`skill-claude: ${message}`)
    }
    this.watcher = (config.watch ?? true)
      ? new RootWatcher({
        usePolling: config.watchUsePolling ?? false,
        stabilityThresholdMs: config.watchStabilityThresholdMs ?? DEFAULT_WATCH_STABILITY_THRESHOLD_MS,
        pollIntervalMs: config.watchPollIntervalMs ?? DEFAULT_WATCH_POLL_INTERVAL_MS,
      }, () => { control.invalidate() }, this.warn)
      : undefined
  }

  /**
   * List every Claude skill and command visible from a working directory.
   * @param options - lookup options; `cwd` selects the project, `signal` cancels work.
   * @returns candidates from the project, user, and plugin roots; a watcher failure
   *   returns them as an incomplete observation so the registry does not cache them.
   */
  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    const projectRoot = this.includeProject && options.cwd !== undefined
      ? await findProjectRoot(resolve(options.cwd))
      : undefined
    const sources = await resolveSources({
      claudeHome: this.claudeHome,
      projectRoot,
      includePlugins: this.includePlugins,
      warn: this.warn,
    })
    const targets: WatchTarget[] = [
      ...sources.roots.map(root => ({ path: root.dir, shallow: false as const })),
      ...sources.shallowDirs.map(dir => ({ path: dir.path, shallow: true as const, names: dir.names })),
    ]
    let complete = true
    try {
      await this.watcher?.sync(targets)
    } catch (error) {
      // A watcher failure only costs live updates; the scan below still serves the catalog,
      // but without a working watcher nothing would ever invalidate a cached copy of it.
      complete = false
      this.warn('watch', `watching for changes failed: ${String(error)}`)
    }
    options.signal?.throwIfAborted()
    const scanned = await Promise.all(sources.roots.map(root => scanRoot(root, this.name, this.warn)))
    const candidates = scanned.flat()
    return complete ? candidates : { candidates, complete }
  }

  /**
   * Load a candidate's body.
   * @param candidate - candidate returned by {@link ClaudeSkillProvider.list}.
   * @returns the definition, or `undefined` when the file no longer exists.
   */
  async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
    return await loadDefinition(candidate, this.warn)
  }

  /** Close every watcher. */
  async dispose(): Promise<void> {
    await this.watcher?.dispose()
  }
}
