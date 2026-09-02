/**
 * Discover and import Claude Code CLI sessions into new, fully-native DSH
 * sessions: see {@link ClaudeSessionImportController}.
 *
 * @module @deepseek-ai/dsh-claude-session-import
 */

import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { listClaudeCodeSessions, type DiscoveredSession } from './discovery.ts'
import { parseClaudeCodeTranscript, renderImportedTranscript } from './transcript.ts'
import { claudeCodeTranscriptPath } from './transcript-path.ts'
import type { ClaudeSessionImportCreateValue, ClaudeSessionImportListValue } from './types.ts'

export type * from './types.ts'

/** Every session this feature creates starts pinned to this model. */
const IMPORTED_SESSION_MODEL: Readonly<Pick<LlmCallConfig, 'provider' | 'model'>> = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
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
  /** Read one transcript file's raw contents. Defaults to `readFileSync(path, 'utf8')`. */
  readTranscript?: (path: string) => string
  /**
   * Create or resume the brand-new DSH session that receives the imported
   * transcript. No safe default — see this interface's summary.
   */
  ensureSession: (ctx: Context, sessionId: SessionId, cwd: string) => Promise<Agent>
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
 * .agents/notes/proposed/architecture/2026-09-02-claude-code-session-import.md.
 */
export class ClaudeSessionImportController extends TypertRemoteService {
  private readonly discover: NonNullable<ClaudeSessionImportInternals['discover']>
  private readonly readTranscript: NonNullable<ClaudeSessionImportInternals['readTranscript']>
  private readonly ensureSession: ClaudeSessionImportInternals['ensureSession']
  private readonly resolveCallConfig: NonNullable<ClaudeSessionImportInternals['resolveCallConfig']>
  private readonly selectModel: ClaudeSessionImportInternals['selectModel']

  /**
   * @param ctx - Host context; production mounting supplies `ensureSession`
   *   and `selectModel` bound to the mounting package's `ApiSessionAgentController`.
   * @param internals - host integrations; `ensureSession` and `selectModel` are mandatory.
   */
  constructor(ctx: Context, internals: ClaudeSessionImportInternals) {
    super(ctx, 'claudeSessionImportController', { namespace: 'claudeSessionImport' })
    this.discover = internals.discover ?? ((hostCtx, signal) => listClaudeCodeSessions(hostCtx, signal))
    this.readTranscript = internals.readTranscript ?? (path => readFileSync(path, 'utf8'))
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
    const sessions = await this.discover(this.ctx, signal)
    const discovered = sessions.find(session => session.id === sessionId)
    if (discovered === undefined) {
      throw new RemoteError('claude-session-import/not-found', `no Claude Code session "${sessionId}" is currently reported`, { sessionId })
    }
    const path = claudeCodeTranscriptPath(homedir(), discovered.cwd, sessionId)
    let turns
    try {
      turns = parseClaudeCodeTranscript(this.readTranscript(path))
    } catch (error) {
      throw new RemoteError(
        'claude-session-import/transcript-unreadable',
        `could not read the transcript for "${sessionId}" at ${path}: ${error instanceof Error ? error.message : String(error)}`,
        { sessionId },
        { cause: error },
      )
    }
    const newSessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const agent = await this.ensureSession(this.ctx, newSessionId, discovered.cwd)
    const resolved = await this.resolveCallConfig(this.ctx, { ...IMPORTED_SESSION_MODEL })
    const selection: ModelSelection = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    }
    this.selectModel(this.ctx, agent, selection)
    const rendered = renderImportedTranscript(turns)
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: `Imported from Claude Code session "${discovered.name}":\n\n${rendered}` }],
      source: { kind: 'plugin', plugin: 'claude-session-import', form: 'notice', summary: 'Imported a prior Claude Code conversation' },
    }))
    return { sessionId: newSessionId }
  }
}

export default ClaudeSessionImportController
