import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { resolveClaudeCliArgv } from './claude-cli-resolve.ts'

// `sessionId` is used verbatim as a transcript filename component (see
// `claudeCodeTranscriptPath`); requiring canonical UUID shape (defense in
// depth against a malformed or hostile `claude agents --json --all` output)
// rules out path-traversal-shaped values before they ever reach the
// filesystem layer.
//
// NOTE: this is a byte-for-byte duplicate of `UUID_PATTERN` in
// `packages/identity/anonymous-user-id/src/index.ts`. Not extracted into a
// shared utility (too large a refactor for this scope) — kept as a plain
// comment so the two definitions don't silently drift without a future
// maintainer noticing the duplication.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
 * is only an 8-char display prefix; `startedAt` is a Unix-epoch-ms number,
 * not an ISO string.
 *
 * The lifecycle label is carried differently depending on `kind`: a
 * `kind: 'background'` entry carries `state` (e.g. `done`/`stopped`/`failed`/
 * `blocked`), and sometimes also `status` if a live process happens to be
 * attached; a `kind: 'interactive'` entry carries only `status` (e.g.
 * `idle`/`busy`) and never `state`. Both fields are therefore optional here,
 * with at least one required by {@link isRawAgentEntry}.
 */
interface RawAgentEntry {
  sessionId: string
  name: string
  cwd: string
  state?: string
  status?: string
  startedAt: number
}

function isRawAgentEntry(value: unknown): value is RawAgentEntry {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RawAgentEntry>
  return typeof candidate.sessionId === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.cwd === 'string'
    && (typeof candidate.state === 'string' || typeof candidate.status === 'string')
    && typeof candidate.startedAt === 'number'
}

/**
 * Defense-in-depth shape validation beyond {@link isRawAgentEntry}'s basic
 * `typeof` checks: `sessionId` flows into a filesystem path
 * (`claudeCodeTranscriptPath`, which slugs it, but a non-UUID value is still
 * a signal of a malformed or hostile source), and `cwd` flows into a new
 * session's working-directory scope (`ensureSession` in `index.ts`) — an
 * unresolved relative `cwd` there would resolve unpredictably against the
 * host process's own working directory, so a malformed or hostile value
 * (e.g. a relative path shaped like `../../secrets`) must be rejected here
 * rather than trusted downstream. Each rejection is logged so an operator
 * debugging "why doesn't my session show up" has a signal, consistent with
 * this file's other failure-mode warnings.
 * @param raw - Entry that already passed {@link isRawAgentEntry}.
 * @param ctx - Host context carrying `ctx.logger`.
 * @returns whether the entry's `sessionId`/`cwd` are well-formed enough to trust.
 */
function isValidatedAgentEntry(raw: RawAgentEntry, ctx: Context): boolean {
  if (!UUID_PATTERN.test(raw.sessionId)) {
    ctx.logger.warn(`claude-session-import: skipping entry with non-UUID-shaped sessionId "${raw.sessionId}"`)
    return false
  }
  const cwd = raw.cwd.trim()
  if (cwd.length === 0 || !isAbsolute(cwd)) {
    ctx.logger.warn(`claude-session-import: skipping entry with a non-absolute or empty cwd "${raw.cwd}"`)
    return false
  }
  // `startedAt` flows straight into `new Date(...).toISOString()` in
  // `toDiscoveredSession`, which throws a RangeError for a value outside
  // Date's representable range (e.g. a bogus epoch-ms value from a malformed
  // `claude agents --json --all` entry) — validated here so one such entry
  // fails closed (skipped, with a warning) instead of crashing the whole
  // `listClaudeCodeSessions` call for every discovered session.
  if (Number.isNaN(new Date(raw.startedAt).getTime())) {
    ctx.logger.warn(`claude-session-import: skipping entry with an invalid startedAt (${raw.startedAt})`)
    return false
  }
  return true
}

function toDiscoveredSession(raw: RawAgentEntry): DiscoveredSession {
  return {
    id: raw.sessionId,
    name: raw.name,
    // Trimmed, matching what `isValidatedAgentEntry` actually validated: that
    // function checks `raw.cwd.trim()` for non-emptiness/absoluteness, so a
    // whitespace-padded cwd (e.g. "  D:/dev/DSH\t") passes validation against
    // the trimmed copy but the untrimmed original would otherwise flow
    // downstream into `claudeCodeTranscriptPath(...)` and `ensureSession`'s
    // cwd argument (see index.ts), producing a wrong transcript path/
    // directory scope despite having passed the absolute-path check.
    cwd: raw.cwd.trim(),
    // `state` (background entries) takes priority over `status` (interactive
    // entries, or a background entry with a live process attached) — a
    // background entry carrying both reflects the process's authoritative
    // lifecycle state in `state`, with `status` only a secondary liveness
    // signal that must not override it.
    // No `?? ''` fallback: `isRawAgentEntry`'s guard already requires at
    // least one of `state`/`status` to be a string, so one is always present.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    status: raw.state ?? raw.status!,
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
  return parsed
    .filter(isRawAgentEntry)
    .filter(raw => isValidatedAgentEntry(raw, ctx))
    .map(toDiscoveredSession)
}
