/**
 * Resolution of the Claude directories to scan: project and user skills and
 * commands, plus the skills and commands of enabled user-scope plugins.
 *
 * @module @deepseek-ai/dsh-skill-claude/sources
 */

import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isMissing } from './fs-error.ts'
import type { ResolvedSources, SkillRoot, Warn } from './types.ts'

/** Registry ranks; every workspace source outranks every global source. */
export const CLAUDE_RANK = {
  projectSkills: 210,
  projectCommands: 220,
  userSkills: 530,
  userCommands: 540,
  pluginSkills: 550,
  pluginCommands: 560,
} as const

/** Inputs for {@link resolveSources}. */
export interface ResolveOptions {
  /** Claude configuration directory. */
  readonly claudeHome: string
  /** Project root whose `.claude` directory is scanned, or `undefined` to skip project sources. */
  readonly projectRoot: string | undefined
  /** Whether enabled plugins are resolved. */
  readonly includePlugins: boolean
  /** Warning sink. */
  readonly warn: Warn
}

/**
 * Resolve the Claude configuration directory.
 * @param configured - explicit directory from provider configuration.
 * @param env - environment to read `CLAUDE_CONFIG_DIR` from.
 * @returns the configured directory, else a non-empty `CLAUDE_CONFIG_DIR`, else `~/.claude`.
 */
export function resolveClaudeHome(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (configured !== undefined) return configured
  const fromEnv = env.CLAUDE_CONFIG_DIR
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.claude')
}

/**
 * Find the project root of a working directory.
 * @param cwd - directory a session works in.
 * @returns the nearest ancestor containing `.git`, else `cwd`.
 */
export async function findProjectRoot(cwd: string): Promise<string> {
  let current = cwd
  while (true) {
    if (await exists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // A missing .git entry only means this ancestor is not the project root.
    return false
  }
}

/**
 * Resolve every directory to scan and every directory to watch.
 * @param options - Claude home, project root, plugin switch, and warning sink.
 * @returns scan roots (project, user, then plugin roots) and shallow watch directories.
 */
export async function resolveSources(options: ResolveOptions): Promise<ResolvedSources> {
  const { claudeHome, projectRoot, includePlugins, warn } = options
  const roots: SkillRoot[] = []
  const shallowDirs: string[] = [claudeHome]
  if (projectRoot !== undefined) {
    const projectClaude = join(projectRoot, '.claude')
    roots.push(
      { kind: 'skills', dir: join(projectClaude, 'skills'), rank: CLAUDE_RANK.projectSkills, source: 'claude-project' },
      { kind: 'commands', dir: join(projectClaude, 'commands'), rank: CLAUDE_RANK.projectCommands, source: 'claude-project' },
    )
  }
  roots.push(
    { kind: 'skills', dir: join(claudeHome, 'skills'), rank: CLAUDE_RANK.userSkills, source: 'claude-user' },
    { kind: 'commands', dir: join(claudeHome, 'commands'), rank: CLAUDE_RANK.userCommands, source: 'claude-user' },
  )
  if (includePlugins) {
    const pluginsDir = join(claudeHome, 'plugins')
    shallowDirs.push(pluginsDir)
    const settingsPaths = [join(claudeHome, 'settings.json')]
    if (projectRoot !== undefined) {
      settingsPaths.push(join(projectRoot, '.claude', 'settings.json'), join(projectRoot, '.claude', 'settings.local.json'))
    }
    const settings = await Promise.all(settingsPaths.map(path => readJson(path, warn)))
    const installed = await readJson(join(pluginsDir, 'installed_plugins.json'), warn)
    roots.push(...pluginRoots(installed, enabledPluginKeys(settings), warn))
  }
  if (projectRoot !== undefined) shallowDirs.push(join(projectRoot, '.claude'))
  return { roots, shallowDirs }
}

async function readJson(path: string, warn: Warn): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (!isMissing(error)) warn(path, `${path} ignored: ${String(error)}`)
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    warn(path, `${path} ignored: invalid JSON: ${String(error)}`)
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Later settings documents override earlier ones, matching Claude Code's user, project, local order. */
function enabledPluginKeys(settings: readonly unknown[]): Set<string> {
  const flags = new Map<string, boolean>()
  for (const document of settings) {
    if (!isRecord(document) || !isRecord(document.enabledPlugins)) continue
    for (const [key, value] of Object.entries(document.enabledPlugins)) {
      if (typeof value === 'boolean') flags.set(key, value)
    }
  }
  return new Set([...flags].filter(([, enabled]) => enabled).map(([key]) => key))
}

function pluginRoots(installed: unknown, enabled: ReadonlySet<string>, warn: Warn): SkillRoot[] {
  const registry = isRecord(installed) && isRecord(installed.plugins) ? installed.plugins : {}
  const roots: SkillRoot[] = []
  for (const key of [...enabled].sort()) {
    const entries = registry[key]
    if (!Array.isArray(entries)) {
      warn(key, `plugin ${key} is enabled but not installed`)
      continue
    }
    const installPath = userInstallPath(entries)
    if (installPath === undefined) {
      warn(key, `plugin ${key} skipped: only scope "user" entries are supported`)
      continue
    }
    const at = key.indexOf('@')
    const plugin = at === -1 ? key : key.slice(0, at)
    roots.push(
      { kind: 'skills', dir: join(installPath, 'skills'), rank: CLAUDE_RANK.pluginSkills, source: 'claude-plugin', plugin },
      { kind: 'commands', dir: join(installPath, 'commands'), rank: CLAUDE_RANK.pluginCommands, source: 'claude-plugin', plugin },
    )
  }
  return roots
}

function userInstallPath(entries: readonly unknown[]): string | undefined {
  for (const entry of entries) {
    if (isRecord(entry) && entry.scope === 'user' && typeof entry.installPath === 'string') return entry.installPath
  }
  return undefined
}
