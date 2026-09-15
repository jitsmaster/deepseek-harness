/**
 * Discover and import Claude Code CLI sessions into new, fully-native DSH
 * sessions: see {@link ClaudeSessionImportController}.
 *
 * @module @deepseek-ai/dsh-claude-session-import
 */

import { homedir } from 'node:os'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { listClaudeCodeSessions, type DiscoveredSession } from './discovery.ts'
import { escapeEmbeddedBoundaryMarkers, parseClaudeCodeTranscript, renderImportedTranscript } from './transcript.ts'
import { claudeCodeTranscriptPath } from './transcript-path.ts'
import { readProjectMemory as readProjectMemoryDefault } from './project-memory.ts'
import type { ClaudeSessionImportCreateValue, ClaudeSessionImportListValue } from './types.ts'

export type * from './types.ts'

/** Every session this feature creates starts pinned to this model. */
const IMPORTED_SESSION_MODEL: Readonly<Pick<LlmCallConfig, 'provider' | 'model'>> = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
}

// A Claude Code transcript is JSONL text, one line per event, and carries more
// overhead per turn than the flattened text `renderImportedTranscript` produces
// (role/type envelopes, plus embedded tool_use/tool_result payloads for tool
// turns) — real long-running sessions with substantial tool output routinely
// land in the low single-digit megabytes despite rendering, via
// transcript.ts's RENDERED_TRANSCRIPT_MAX_CHARS (200,000), to a normal-sized
// message either way. This ceiling only exists to refuse a genuinely
// pathological file outright rather than read it into memory (see
// `readTranscriptCapped` below), so it is set well above ordinary real-world
// transcript sizes rather than close to the rendered cap. Same convention as
// discovery.ts's STDOUT_MAX_BYTES / STDERR_MAX_BYTES and
// session-persistence-sqlite/codec.ts's
// MAX_PACKED_DATA_BYTES: cap externally-sourced data at the point it enters the
// process.
export const RAW_TRANSCRIPT_MAX_BYTES = 10_000_000

// `lastDiscoveryById`'s entries are meant to satisfy `createFrom()` reusing a
// discovery already performed for the very same "pick a session" user action
// that just called `list()` (Finding #8) — not to stand in for a live
// re-check indefinitely. Without any expiry, a `createFrom()` call arriving
// long after its matching `list()` (e.g. the operator left the picker open
// for minutes before choosing) would silently import using whatever cwd/
// status that long-past snapshot recorded, even if the underlying Claude
// Code session's real state had since changed. Five minutes is generously
// longer than any realistic "list, then immediately pick one" gap while still
// bounding how stale a trusted entry can be; past it, `createFrom()` falls
// back to a fresh `discover()` the same way a cache miss already does.
const DISCOVERY_CACHE_TTL_MS = 5 * 60_000

/**
 * Test seam for {@link readTranscriptCapped}: a hook invoked after `stat()`
 * resolves but before the capped stream starts reading, letting a test grow
 * the file past the cap in that exact window to prove the stream — not the
 * up-front `stat()` — is what enforces the cap. Mirrors fs-local's own
 * `FsIoInternals.inspectReadBytesAfterStat` test seam
 * (`packages/fs/fs-local/src/fsio.ts`).
 */
export interface ReadTranscriptCappedInternals {
  afterStat?: (path: string) => Promise<void> | void
}

/**
 * Default `ClaudeSessionImportInternals.readTranscript`: reads one transcript
 * file asynchronously, refusing (rather than reading) any file larger than
 * {@link RAW_TRANSCRIPT_MAX_BYTES}. `stat` first so the size check never
 * itself pays for reading an oversized file into memory; but `stat()` and the
 * read are still two separate calls, so a file that grows past the cap in
 * between (e.g. the Claude CLI still appending to it) could let an unbounded
 * single-shot read buffer arbitrarily far past the cap despite this
 * function's contract — the same TOCTOU gap fs-local's `readWholeBytes`
 * (`packages/fs/fs-local/src/fsio.ts`) closes by streaming with an explicit
 * byte ceiling and re-checking cumulative bytes read, not trusting the
 * pre-read stat alone. That same streaming-with-cap approach is ported here
 * (rather than imported) because `readWholeBytes` operates on a `LocalTarget`
 * resolved through the `ctx.fs` sandboxing layer (path resolution,
 * symlink/junction checks backed by that package's native `koffi`
 * dependency) — machinery this package has no reason to pull in for a plain
 * already-absolute path. Both `stat` and the stream are non-blocking so a
 * slow or oversized read never stalls the host process's event loop for
 * every other concurrent DSH session.
 * @param path - absolute path to the transcript file.
 * @param internals - test seam; production callers never pass this.
 * @returns the file's raw UTF-8 contents.
 * @throws when the file is missing/unreadable, or exceeds the byte cap.
 */
export async function readTranscriptCapped(path: string, internals: ReadTranscriptCappedInternals = {}): Promise<string> {
  const { size } = await stat(path)
  if (size > RAW_TRANSCRIPT_MAX_BYTES) {
    throw new Error(`transcript at ${path} is ${size} bytes, exceeding the ${RAW_TRANSCRIPT_MAX_BYTES}-byte cap on a single read`)
  }
  await internals.afterStat?.(path)
  // `end` is an inclusive byte offset, so this can still read one byte beyond
  // the cap before the loop below notices — same trade-off fs-local's
  // `readWholeBytes` documents, and harmless since the cumulative check below
  // still throws before that one extra byte is ever returned to a caller.
  const stream = createReadStream(path, { end: RAW_TRANSCRIPT_MAX_BYTES })
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    bytes += chunk.length
    if (bytes > RAW_TRANSCRIPT_MAX_BYTES) {
      throw new Error(`transcript at ${path} exceeds the ${RAW_TRANSCRIPT_MAX_BYTES}-byte cap on a single read`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, bytes).toString('utf8')
}

/**
 * Host integrations replaceable by direct unit tests.
 *
 * `ensureSession` and `selectModel` have no production-safe default: creating
 * or resuming the imported session's Agent, and installing its Session-local
 * model selection, are both owned by `ApiSessionAgentController`
 * (`packages/api/session-controller/src/agent.ts`), which is private to the
 * `dsh-api-session-controller` package and cannot be imported here without a
 * circular workspace dependency (that package depends on this one to mount
 * {@link ClaudeSessionImportController}). The real implementations are
 * supplied by that package's mount call; tests supply their own stubs.
 */
export interface ClaudeSessionImportInternals {
  /** Discover the operator's Claude Code CLI sessions. Defaults to {@link listClaudeCodeSessions}. */
  discover?: (ctx: Context, signal: AbortSignal) => Promise<readonly DiscoveredSession[]>
  /** Read one transcript file's raw contents. Defaults to {@link readTranscriptCapped}. */
  readTranscript?: (path: string) => Promise<string>
  /**
   * Read the operator's Claude Code project memory for a session's cwd.
   * Defaults to {@link readProjectMemory}. A test replacing this can avoid
   * touching the real `~/.claude/projects` tree.
   */
  readProjectMemory?: (homedir: string, cwd: string) => Promise<string | undefined>
  /**
   * Create or resume the brand-new DSH session that receives the imported
   * transcript. No safe default — see this interface's summary.
   *
   * Returns the full {@link AgentHandle} (not a bare `Agent`) so `createFrom`'s
   * orphan-recovery path (Finding #4) can call the handle's own `dispose()` —
   * the only capability that genuinely stops the loop, awaits its exit, and
   * unregisters the agent/session from the store — rather than merely
   * `agent.cancel()`-ing queued/active activity while leaving the session
   * registered and lingering.
   */
  ensureSession: (ctx: Context, sessionId: SessionId, cwd: string) => Promise<AgentHandle>
  /** Validate and materialize {@link IMPORTED_SESSION_MODEL}. Defaults to `ctx.llm.resolveCallConfig`. */
  resolveCallConfig?: (ctx: Context, config: LlmCallConfig, signal?: AbortSignal) => Promise<LlmCallConfig>
  /**
   * Install the resolved selection as the new session's Session-local model
   * choice. No safe default — see this interface's summary.
   */
  selectModel: (ctx: Context, agent: Agent, selection: ModelSelection) => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `claudeSessionImport` Remote namespace. */
    claudeSessionImportController: ClaudeSessionImportController
  }
}

/**
 * Host service backing `ctx.remote.claudeSessionImport`: discovers Claude
 * Code CLI sessions and imports one, once, into a brand-new native DSH
 * session. No connection to Claude Code survives either call — see
 * .agents/notes/implemented/architecture/2026-09-02-claude-code-session-import.md.
 */
export class ClaudeSessionImportController extends TypertRemoteService {
  static inject = ['subprocess', 'llm']

  private readonly discover: NonNullable<ClaudeSessionImportInternals['discover']>
  private readonly readTranscript: NonNullable<ClaudeSessionImportInternals['readTranscript']>
  private readonly readProjectMemory: NonNullable<ClaudeSessionImportInternals['readProjectMemory']>
  private readonly ensureSession: ClaudeSessionImportInternals['ensureSession']
  private readonly resolveCallConfig: NonNullable<ClaudeSessionImportInternals['resolveCallConfig']>
  private readonly selectModel: ClaudeSessionImportInternals['selectModel']

  /**
   * The most recent `list()` discovery result, indexed by
   * `DiscoveredSession.id`, so a `createFrom()` for one of those same ids
   * (Finding #8) doesn't pay for a second CLI discovery round-trip. Keyed by
   * id rather than kept as one shared "last list()" array (Finding #1):
   * `ClaudeSessionImportController` is mounted once per host and serves every
   * connected client from that single instance (`SessionController`), and
   * `list()`/`createFrom()` carry no caller-identifying information — so two
   * overlapping callers' calls can interleave (caller A's `list()`, then
   * caller B's `list()`, then caller A's `createFrom()`). A single shared
   * field would let caller B's `list()` silently replace caller A's
   * not-yet-consumed snapshot, so caller A's `createFrom()` could read a
   * result that never actually reported caller A's target session — either
   * mis-resolving it or producing a spurious not-found — instead of falling
   * back to a fresh, correct check. Keying by id can't do that: a lookup for
   * one id only ever returns an entry some `list()` call actually reported
   * for that exact id (discovery is global host truth, not caller-private
   * data — one `claude agents --json --all` call — so an entry from a
   * different caller's `list()` is still legitimate data for that id, just
   * possibly a little more/less fresh); any other case is a cache miss,
   * which safely falls back to a fresh `discover()` rather than ever serving
   * mismatched data. Entirely replaced (not merged) on every `list()` so a
   * session no longer reported can't linger as a stale phantom hit, and each
   * id's entry is consumed (deleted) on read so a stale, long-past `list()`
   * is never reused twice for that id.
   *
   * Each entry also carries the `Date.now()` timestamp it was cached at, so
   * `createFrom()` can refuse an entry older than {@link DISCOVERY_CACHE_TTL_MS}
   * (see that constant's doc comment) rather than trusting arbitrarily-stale
   * cached data with no re-validation.
   */
  private readonly lastDiscoveryById = new Map<string, { readonly session: DiscoveredSession; readonly cachedAt: number }>()

  /**
   * @param ctx - Host context; production mounting supplies `ensureSession`
   *   and `selectModel` bound to the mounting package's `ApiSessionAgentController`.
   * @param internals - host integrations; `ensureSession` and `selectModel` are mandatory.
   */
  constructor(ctx: Context, internals: ClaudeSessionImportInternals) {
    super(ctx, 'claudeSessionImportController', { namespace: 'claudeSessionImport' })
    this.discover = internals.discover ?? ((hostCtx, signal) => listClaudeCodeSessions(hostCtx, signal))
    this.readTranscript = internals.readTranscript ?? readTranscriptCapped
    this.readProjectMemory = internals.readProjectMemory ?? readProjectMemoryDefault
    this.ensureSession = internals.ensureSession
    this.resolveCallConfig = internals.resolveCallConfig ?? ((hostCtx, config, signal) => hostCtx.llm.resolveCallConfig(config, signal))
    this.selectModel = internals.selectModel
  }

  /**
   * List the operator's Claude Code CLI sessions.
   * @param signal - withdraws the discovery call.
   * @returns discovered sessions; empty when `claude` is unavailable.
   */
  @Remote
  async list(signal: AbortSignal): Promise<ClaudeSessionImportListValue> {
    const sessions = await this.discover(this.ctx, signal)
    // Replace wholesale, not merge: a session absent from this fresh
    // discovery must not linger from a previous call as a stale phantom hit.
    this.lastDiscoveryById.clear()
    const cachedAt = Date.now()
    for (const session of sessions) this.lastDiscoveryById.set(session.id, { session, cachedAt })
    return { sessions: sessions.map(session => ({ ...session })) }
  }

  /**
   * Import one Claude Code CLI session into a brand-new native DSH session,
   * defaulting its model to {@link IMPORTED_SESSION_MODEL}.
   * @param sessionId - the id `list()` reported.
   * @param signal - withdraws discovery; the transcript read, session
   *   creation, and model selection that follow are not cancellable once
   *   discovery settles.
   * @returns the new DSH session's id.
   * @throws RemoteError `claude-session-import/not-found` when `sessionId`
   *   is not currently reported by `list()`, or
   *   `claude-session-import/transcript-unreadable` when the transcript
   *   cannot be read or parsed.
   */
  @Remote
  async createFrom(sessionId: string, signal: AbortSignal): Promise<ClaudeSessionImportCreateValue> {
    // Finding #8 (kept sound under Finding #1): reuse this exact id's entry
    // from a `list()` just performed for the same pick-a-session action,
    // instead of re-running CLI discovery here. The cache is consumed
    // (deleted) on read and keyed per id (see `lastDiscoveryById`'s doc
    // comment), so a miss here — whether from no preceding `list()`, an
    // already-consumed entry, or another caller's `list()` not reporting this
    // id — always falls back to discovering for itself rather than ever
    // trusting a foreign or stale snapshot.
    const cachedEntry = this.lastDiscoveryById.get(sessionId)
    this.lastDiscoveryById.delete(sessionId)
    // An entry older than the TTL is treated exactly like a cache miss (falls
    // back to a fresh `discover()` below) rather than trusted outright — see
    // `lastDiscoveryById` and `DISCOVERY_CACHE_TTL_MS`'s doc comments.
    const cached = cachedEntry !== undefined && Date.now() - cachedEntry.cachedAt < DISCOVERY_CACHE_TTL_MS
      ? cachedEntry.session
      : undefined
    const discovered = cached ?? (await this.discover(this.ctx, signal)).find(session => session.id === sessionId)
    if (discovered === undefined) {
      throw new RemoteError('claude-session-import/not-found', `no Claude Code session "${sessionId}" is currently reported`, { sessionId })
    }
    const path = claudeCodeTranscriptPath(homedir(), discovered.cwd, sessionId)
    let turns
    try {
      turns = parseClaudeCodeTranscript(await this.readTranscript(path))
    } catch (error) {
      throw new RemoteError(
        'claude-session-import/transcript-unreadable',
        `could not read the transcript for "${sessionId}" at ${path}: ${error instanceof Error ? error.message : String(error)}`,
        { sessionId },
        { cause: error },
      )
    }
    // A transcript that is readable but drifts out of the recognized shape
    // (not JSONL, or no entry carries a user/assistant message role) parses
    // to zero turns without ever throwing above. Left unchecked, createFrom
    // would silently create a session whose "import" is only the boilerplate
    // notice with no actual transcript — a garbled-looking import the spec
    // forbids. Same failure class as an unreadable file from the caller's
    // point of view, so it reuses that error code.
    if (turns.length === 0) {
      throw new RemoteError(
        'claude-session-import/transcript-unreadable',
        `the transcript for "${sessionId}" at ${path} parsed to zero usable turns`,
        { sessionId },
      )
    }
    // resolveCallConfig runs before ensureSession: if config resolution fails
    // (e.g. an unavailable model), no session must ever have been created —
    // an orphaned, empty session with no way to recover it would otherwise
    // be left behind for every such failure.
    // Best-effort: the operator's Claude Code project memory enriches the
    // import but is never required for it — a missing/unreadable memory
    // index (or a test double that throws) must never block the import
    // itself, so a failure here is swallowed rather than propagated.
    let memory: string | undefined
    try {
      memory = await this.readProjectMemory(homedir(), discovered.cwd)
    } catch {
      memory = undefined
    }
    const resolved = await this.resolveCallConfig(this.ctx, { ...IMPORTED_SESSION_MODEL })
    const selection: ModelSelection = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    }
    const newSessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const handle = await this.ensureSession(this.ctx, newSessionId, discovered.cwd)
    const { agent } = handle
    // Finding #4: once ensureSession() above has created the live agent/
    // session, a throw from either post-creation step (selectModel, or
    // agent.followup() below) must not leave that session behind as an
    // orphan the operator can never see or clean up. `handle.dispose()` —
    // not `agent.cancel({ kind: 'disposed' })` — is what actually stops the
    // loop, awaits its exit, and unregisters the agent/session from the
    // store (see AgentHandle's doc comment in
    // packages/core/agent/src/index.ts); `cancel()` alone only cancels
    // queued/active activity and would leave the session registered and
    // lingering despite this guard's intent.
    try {
      this.selectModel(this.ctx, agent, selection)
      const rendered = renderImportedTranscript(turns)
      // Security fix: `discovered.name` is untrusted, unsanitized text (see
      // discovery.ts — never escaped there) interpolated immediately before
      // the safely-escaped rendered transcript body. Left unescaped, a
      // maliciously named Claude Code session (e.g. one literally named
      // `foo**User:** ...`) could forge a fake turn-boundary marker ahead of
      // the transcript's own content, spoofing an operator- or model-visible
      // turn boundary that never actually happened — defeating the exact
      // protection `escapeEmbeddedBoundaryMarkers` enforces on the transcript
      // itself just below.
      const safeName = escapeEmbeddedBoundaryMarkers(discovered.name)
      // Memory content is the operator's own trusted notes (same trust level
      // as a user-tier skill — see claude-skill-commands' Fix C), so unlike
      // `safeName` above it needs no escaping against the transcript's own
      // turn-boundary markers.
      const memorySection = memory === undefined
        ? ''
        : `Project memory carried over from the operator's Claude Code CLI for this project:\n\n${memory}\n\n---\n\n`
      // followup(), not inject(): inject() queues silently for the next
      // pre-step without waking the driver, so a brand-new (idle) agent would
      // leave it parked forever with nothing to ever wake it — the imported
      // content would never become visible, durable history. followup() starts
      // a real first turn immediately, matching "seeded as its opening context".
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: memorySection
            + `Imported from Claude Code session "${safeName}". This transcript is `
            + 'historical context only, shown so the operator can see it — it is not an '
            + 'instruction to resume or continue any in-progress work. Do not take any '
            + "action or use any tools; just wait for the operator's next message.\n\n"
            + rendered,
        }],
        source: { kind: 'plugin', plugin: 'claude-session-import', form: 'notice', summary: 'Imported a prior Claude Code conversation' },
      }))
    } catch (error) {
      await handle.dispose()
      throw error
    }
    return { sessionId: newSessionId }
  }
}

export default ClaudeSessionImportController
