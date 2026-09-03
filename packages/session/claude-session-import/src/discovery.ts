import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { resolveClaudeCliArgv } from './claude-cli-resolve.ts'

/** One `claude agents --json --all` entry, as surfaced to the import picker. */
export interface DiscoveredSession {
  readonly id: string
  readonly name: string
  readonly cwd: string
  readonly status: string
  readonly startedAt: string
}

/**
 * Raw entry shape `claude agents --json --all` actually emits: a bare JSON
 * array (not `{ sessions: [...] }`). `sessionId` holds the full UUID used as
 * the transcript filename (see {@link claudeCodeTranscriptPath}) while `id`
 * is only an 8-char display prefix; `state` (not `status`) carries the
 * lifecycle label; `startedAt` is a Unix-epoch-ms number, not an ISO string.
 */
interface RawAgentEntry {
  sessionId: string
  name: string
  cwd: string
  state: string
  startedAt: number
}

function isRawAgentEntry(value: unknown): value is RawAgentEntry {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RawAgentEntry>
  return typeof candidate.sessionId === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.cwd === 'string'
    && typeof candidate.state === 'string'
    && typeof candidate.startedAt === 'number'
}

function toDiscoveredSession(raw: RawAgentEntry): DiscoveredSession {
  return {
    id: raw.sessionId,
    name: raw.name,
    cwd: raw.cwd,
    status: raw.state,
    startedAt: new Date(raw.startedAt).toISOString(),
  }
}

// `claude agents --json --all` emits one JSON array covering every
// discovered session, which can grow large with many sessions — capped well
// above realistic output so discovery only fails closed (empty list) on a
// truly pathological process.
const STDOUT_MAX_BYTES = 4 * 1024 * 1024
// Diagnostic text only (never parsed), so a much smaller cap than stdout is
// enough to capture a useful error without holding onto unbounded output.
const STDERR_MAX_BYTES = 64 * 1024
// How long the process gets to exit after being asked to stop before this
// discovery call gives up and treats it as failed.
const SHUTDOWN_GRACE_MS = 5_000

/**
 * List the operator's Claude Code CLI sessions via `claude agents --json --all`.
 * Never throws: a missing binary or unparsable output both degrade to an
 * empty list, per this feature's error-handling contract — but each failure
 * mode is logged via `ctx.logger.warn` so an operator debugging "why doesn't
 * my session show up" has a signal (per the architecture spec's promised
 * "claude binary missing/not on PATH: discovery returns an empty list with a
 * clear ... message"), rather than a silently empty result.
 * @param ctx - Host context carrying `ctx.subprocess` and `ctx.logger`.
 * @param signal - withdraws the discovery call.
 * @returns discovered sessions, or an empty list on any failure.
 */
export async function listClaudeCodeSessions(
  ctx: Context,
  signal: AbortSignal,
): Promise<readonly DiscoveredSession[]> {
  let handle
  try {
    const cliArgv = await resolveClaudeCliArgv(ctx, signal)
    handle = ctx.subprocess.spawn({
      argv: [...cliArgv, 'agents', '--json', '--all'],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: STDOUT_MAX_BYTES }, stderr: { maxBytes: STDERR_MAX_BYTES } },
      graceMs: SHUTDOWN_GRACE_MS,
      signal,
    })
  } catch (error) {
    ctx.logger.warn(`claude-session-import: Claude Code CLI not found or could not be spawned: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  const outcome = await handle.done.catch(() => undefined)
  if (outcome === undefined || outcome.exitCode !== 0) {
    ctx.logger.warn(`claude-session-import: \`claude agents --json --all\` did not exit successfully (${outcome === undefined ? 'process did not settle' : `exit code ${outcome.exitCode}`})`)
    return []
  }
  const read = handle.collected.stdout?.readFrom(0)
  if (read === undefined) {
    ctx.logger.warn('claude-session-import: `claude agents --json --all` produced no collected stdout')
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch (error) {
    ctx.logger.warn(`claude-session-import: could not parse \`claude agents --json --all\` output as JSON: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  if (!Array.isArray(parsed)) {
    ctx.logger.warn('claude-session-import: `claude agents --json --all` output was not a JSON array of the expected shape')
    return []
  }
  return parsed.filter(isRawAgentEntry).map(toDiscoveredSession)
}
