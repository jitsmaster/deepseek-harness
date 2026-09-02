import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'

/** One `claude agents --json --all` entry, as surfaced to the import picker. */
export interface DiscoveredSession {
  readonly id: string
  readonly name: string
  readonly cwd: string
  readonly status: string
  readonly startedAt: string
}

interface RawSessionList {
  sessions?: unknown
}

function isDiscoveredSession(value: unknown): value is DiscoveredSession {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<DiscoveredSession>
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.cwd === 'string'
    && typeof candidate.status === 'string'
    && typeof candidate.startedAt === 'string'
}

/**
 * List the operator's Claude Code CLI sessions via `claude agents --json --all`.
 * Never throws: a missing binary or unparsable output both degrade to an
 * empty list, per this feature's error-handling contract.
 * @param ctx - Host context carrying `ctx.subprocess`.
 * @param signal - withdraws the discovery call.
 * @returns discovered sessions, or an empty list on any failure.
 */
export async function listClaudeCodeSessions(
  ctx: Context,
  signal: AbortSignal,
): Promise<readonly DiscoveredSession[]> {
  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv: ['claude', 'agents', '--json', '--all'],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 5_000,
      signal,
    })
  } catch {
    return []
  }
  const outcome = await handle.done.catch(() => undefined)
  if (outcome === undefined || outcome.exitCode !== 0) return []
  const read = handle.collected.stdout?.readFrom(0)
  if (read === undefined) return []
  let parsed: RawSessionList
  try {
    parsed = JSON.parse(read.text) as RawSessionList
  } catch {
    return []
  }
  if (!Array.isArray(parsed.sessions)) return []
  return parsed.sessions.filter(isDiscoveredSession)
}
