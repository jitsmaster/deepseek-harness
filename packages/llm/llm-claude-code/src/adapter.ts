/**
 * `ClaudeCodeLlmAdapter`: an `LlmAdapter` that serves every model call with one
 * stateless headless `claude -p` run of the user's own executable, so DSH never
 * holds an Anthropic credential and nothing impersonates Claude Code. The run
 * happens in a fresh temp directory with no settings, no built-in tools, and
 * the request's tools exposed through a stub MCP server that never answers a
 * call: Claude can only emit a tool call, and DSH's own loop executes it.
 * @module @deepseek-ai/dsh-llm-claude-code/adapter
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { ClaudeStreamDecoder } from './decoder.ts'
import type { RateLimitReading, ResultLine } from './decoder.ts'
import { locateExecutable } from './executable.ts'
import { CLAUDE_EFFORTS, mergeModels } from './models.ts'
import type { ClaudeModelEntry } from './models.ts'
import { buildToolAliases, MCP_SERVER_NAME } from './names.ts'
import { STUB_SOURCE } from './stub.ts'
import { renderSystemText, renderTranscript } from './transcript.ts'

/** Stable provider route id this adapter registers under. */
export const CLAUDE_CODE_LLM_PROVIDER_ID = 'claude-code'

/** Default whole-call budget (30 minutes: a long agentic turn can think for a while). */
export const CLAUDE_CODE_LLM_DEFAULT_TIMEOUT_MS = 1_800_000

/** Default context window of a model id the catalog does not list. */
export const CLAUDE_CODE_DEFAULT_CONTEXT_WINDOW = 200_000

/** Code of a call that exceeded its deadline. */
const TIMEOUT_CODE = 'LLM_CLAUDE_CODE_TIMEOUT'

/** Failure code for any other fault of the claude process or its result. */
const PROVIDER_ERROR_CODE = 'PROVIDER_ERROR'

/** Failure code when the executable is missing or cannot be started. */
const PROVIDER_UNAVAILABLE_CODE = 'PROVIDER_UNAVAILABLE'

/** Termination grace handed to the subprocess seam. */
const TERMINATION_GRACE_MS = 2_000

/** How long a finished run may take to exit before the final cleanup terminates it. */
const EXIT_GRACE_MS = 2_000

/** How long a tool-call stop waits for the trailing plan-usage line, in milliseconds. */
const RATE_LIMIT_GRACE_MS = 800

/** Stderr tail kept for failure diagnostics, in bytes. */
const STDERR_TAIL_BYTES = 8_192

/** Characters of stderr or result text quoted in an error message. */
const DETAIL_CHARS = 500

/** Environment variable that caps the model's output tokens per response. */
const MAX_OUTPUT_TOKENS_ENV = 'CLAUDE_CODE_MAX_OUTPUT_TOKENS'

/** Resolved adapter options (the plugin's `apply` supplies defaults). */
export interface ClaudeCodeLlmAdapterOptions {
  /** Path or bare name of the user's `claude` executable. */
  executable: string
  /** Node binary that runs the stub MCP server; defaults to the harness's own `process.execPath`. */
  nodeExecutable?: string
  /** Whole-call deadline in milliseconds. */
  timeoutMs: number
  /** Context window of a model id the catalog does not list. */
  defaultContextWindow: number
  /** Configured models layered over the built-in catalog. */
  models: readonly ClaudeModelEntry[]
  /** Extra child environment resolved per call (e.g. a stored credential); must not throw. */
  resolveEnv?(): Promise<Record<string, string>>
  /**
   * Receives the run's plan-usage reading and the extra environment the run started with
   * (at most once per run, when Claude reported one); errors are swallowed.
   */
  onRateLimit?(reading: RateLimitReading, env: Readonly<Record<string, string>>): void
  /** Subprocess seam spawn. */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

/** Inputs of the fixed argument vector. */
interface ArgvInput {
  executable: string
  directory: string
  model: string
  effort: string | undefined
  withTools: boolean
}

/**
 * Build the argument vector. The prompt travels on stdin, so it is never subject
 * to quoting or command-line length limits. `--setting-sources ""` keeps the
 * user's global CLAUDE.md out, `--tools ""` disables every built-in tool, and
 * `--allowedTools` is variadic so it stays the last flag.
 * @param input - the resolved executable, temp directory, model, effort, and tool presence.
 * @returns argv with the executable first.
 */
export function claudeArgv(input: ArgvInput): string[] {
  return [
    input.executable,
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--tools', '',
    '--permission-mode', 'dontAsk',
    '--system-prompt-file', join(input.directory, 'system.txt'),
    '--model', input.model,
    ...input.effort === undefined ? [] : ['--effort', input.effort],
    ...input.withTools ? ['--mcp-config', join(input.directory, 'mcp.json'), '--allowedTools', `mcp__${MCP_SERVER_NAME}`] : [],
  ]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Re-read signal.aborted through a call: an abort can land during any await, which flow analysis cannot see. */
function cancelled(signal: AbortSignal): boolean {
  return signal.aborted
}

function objectSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  return { ...parameters, type: 'object' }
}

/** The text a failed `result` line carries. */
function resultDetail(result: ResultLine): string {
  const detail = (result.errors ?? []).join('; ') || result.result || ''
  const subtype = result.subtype ?? 'unknown'
  return detail.length === 0 ? subtype : `${subtype}: ${detail.slice(0, DETAIL_CHARS)}`
}

/**
 * Pick the shared failure code for a Claude error text.
 * @param detail - the error text of the `result` line.
 * @returns a retryable or terminal provider-neutral code, generic when nothing matches.
 */
function classify(detail: string): string {
  if (isContextWindowExceededError(detail) || /\bprompt is too long\b/iu.test(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (/not logged in|\/login|invalid api key|authentication|unauthori[sz]ed|\b40[13]\b|oauth token/iu.test(detail)) return 'AUTH'
  if (/rate.?limit|\b429\b|too many requests/iu.test(detail)) return 'RATE_LIMIT'
  if (/overloaded|\b5\d\d\b|internal server error|server error/iu.test(detail)) return 'SERVER'
  return PROVIDER_ERROR_CODE
}

/** Wait for a promise at most `ms` milliseconds; the timer never keeps the process alive. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => { resolve(undefined) }, ms)
        timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** The Claude Code-backed LLM adapter. */
export class ClaudeCodeLlmAdapter extends LlmAdapter {
  private readonly models: ReadonlyMap<string, ClaudeModelEntry>
  private readonly catalog: readonly ClaudeModelEntry[]

  constructor(private readonly options: ClaudeCodeLlmAdapterOptions) {
    super()
    this.catalog = mergeModels(options.models)
    this.models = new Map(this.catalog.map(model => [model.id, model]))
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Claude Code' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.catalog.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      ...model.description === undefined ? {} : { description: model.description },
      inputModalities: ['text'] as const,
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.models.get(model)
    return Promise.resolve({
      provider,
      id: model,
      name: entry?.name ?? model,
      ...entry?.description === undefined ? {} : { description: entry.description },
      context: { contextWindow: entry?.contextWindow ?? this.options.defaultContextWindow },
      inputModalities: ['text'],
      reasoning: { efforts: CLAUDE_EFFORTS },
    })
  }

  override async * stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (options.signal?.aborted === true) {
      throw new LlmError('Claude Code request aborted', 'ABORTED', { cause: options.signal.reason })
    }
    const executable = locateExecutable(this.options.executable)
    if (executable === undefined) {
      throw new LlmError(`Claude Code executable "${this.options.executable}" was not found`, PROVIDER_UNAVAILABLE_CODE)
    }
    const directory = await mkdtemp(join(tmpdir(), 'dsh-claude-llm-'))
    try {
      using limit = deadline(options.signal, this.options.timeoutMs, TIMEOUT_CODE)
      yield * this.run(executable, directory, options, limit.signal)
    } finally {
      // The process tree is gone by now (`run` waits for it), so the directory can go.
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }

  /** Write the run's files, spawn claude, and decode its output into chunks. */
  private async * run(
    executable: string,
    directory: string,
    options: GenerateOptions,
    signal: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const tools: readonly ToolSchema[] = options.tools ?? []
    const aliases = buildToolAliases(tools.map(tool => tool.name))
    await writeFile(join(directory, 'system.txt'), renderSystemText(options))
    if (tools.length > 0) {
      await writeFile(join(directory, 'tools.json'), JSON.stringify(tools.map(tool => ({
        name: aliases.aliasOf(tool.name),
        description: tool.description,
        inputSchema: objectSchema(tool.parameters),
      }))))
      await writeFile(join(directory, 'mcp.json'), JSON.stringify({
        mcpServers: {
          [MCP_SERVER_NAME]: {
            command: this.options.nodeExecutable ?? process.execPath,
            args: ['-e', STUB_SOURCE, join(directory, 'tools.json')],
            env: { ELECTRON_RUN_AS_NODE: '1' },
          },
        },
      }))
    }

    const extraEnv = await this.options.resolveEnv?.() ?? {}
    const env = { ...extraEnv, ...options.maxTokens === undefined ? {} : { [MAX_OUTPUT_TOKENS_ENV]: String(options.maxTokens) } }
    let child: SubprocessHandle
    try {
      child = this.options.spawn({
        argv: claudeArgv({ executable, directory, model: options.model, effort: options.reasoningEffort, withTools: tools.length > 0 }),
        cwd: directory,
        stdio: { stdin: { data: renderTranscript(options.messages) }, stdout: 'pipe', stderr: { maxBytes: STDERR_TAIL_BYTES } },
        graceMs: TERMINATION_GRACE_MS,
        signal,
        ...Object.keys(env).length === 0 ? {} : { env },
      })
    } catch (error: unknown) {
      throw new LlmError(`Claude Code could not start: ${errorText(error)}`, PROVIDER_UNAVAILABLE_CODE, { cause: error })
    }

    const decoder = new ClaudeStreamDecoder(aliases)
    const lines = child.stdout === undefined ? undefined : createInterface({ input: child.stdout, crlfDelay: Infinity })
    const stopped = new Promise<'stopped'>((resolve) => {
      signal.addEventListener('abort', () => { resolve('stopped') }, { once: true })
    })
    let reported = false
    const report = (): void => {
      if (reported || decoder.rateLimit === undefined) return
      reported = true
      try {
        this.options.onRateLimit?.(decoder.rateLimit, extraEnv)
      } catch {
        // A usage observer must never fail the call.
      }
    }
    try {
      const iterator = lines?.[Symbol.asyncIterator]()
      let toolCalls = false
      while (iterator !== undefined) {
        const next = await Promise.race([iterator.next(), stopped])
        if (next === 'stopped' || cancelled(signal)) throw this.cancellation(signal)
        if (next.done === true) break
        yield * decoder.push(next.value)
        // The run now waits on the never-answered MCP call: stop it instead of waiting for its next turn.
        if (decoder.messageComplete && decoder.stopReason === 'tool_use') {
          toolCalls = true
          break
        }
        if (decoder.result !== undefined) break
      }
      if (toolCalls && decoder.rateLimit === undefined && iterator !== undefined) {
        // Claude prints the plan-usage line right AFTER the message stops, so give it a short bounded read.
        const late = await within(iterator.next(), RATE_LIMIT_GRACE_MS)
        if (late?.done === false) decoder.push(late.value)
      }
      report()
      if (toolCalls) {
        child.terminate()
        yield * decoder.terminalChunks()
        return
      }
      yield * await this.finish(child, decoder, signal)
    } finally {
      report()
      lines?.close()
      child.terminate()
      // The directory is removed next: wait until the whole managed range is gone.
      await child.waitForExit().catch(() => false)
      await child.done.catch(() => undefined)
    }
  }

  /** Check a finished run and produce its closing chunks, or throw the matching LlmError. */
  private async finish(child: SubprocessHandle, decoder: ClaudeStreamDecoder, signal: AbortSignal): Promise<StreamChunk[]> {
    if (cancelled(signal)) throw this.cancellation(signal)
    const result = decoder.result
    if (result === undefined) {
      let outcome: Awaited<SubprocessHandle['done']>
      try {
        outcome = await child.done
      } catch (error: unknown) {
        throw new LlmError(`Claude Code failed: ${errorText(error)}`, PROVIDER_ERROR_CODE, { cause: error })
      }
      if (cancelled(signal)) throw this.cancellation(signal)
      const stderr = child.collected.stderr?.readFrom(0).text.trim() ?? ''
      const tail = stderr.length > 0 ? `: ${stderr.slice(-DETAIL_CHARS)}` : ''
      if (outcome.exitCode !== 0) {
        const how = outcome.exitCode === null ? `was terminated by ${outcome.signal ?? 'a signal'}` : `exited with code ${outcome.exitCode}`
        throw new LlmError(`Claude Code ${how}${tail}`, PROVIDER_ERROR_CODE)
      }
      throw new LlmError(`Claude Code ended without a result line${tail}`, PROVIDER_ERROR_CODE)
    }
    if (result.is_error === true || result.subtype !== 'success') {
      const detail = resultDetail(result)
      throw new LlmError(`Claude Code failed (${detail})`, classify(detail))
    }
    // A clean result: give the process a moment to exit by itself; the final cleanup terminates a lingerer.
    await within(child.done.catch(() => undefined), EXIT_GRACE_MS)
    const chunks = decoder.fallbackChunks()
    if (!decoder.hasContent) throw new LlmError('Claude Code returned an empty response', EMPTY_RESPONSE_CODE)
    return [...chunks, ...decoder.terminalChunks()]
  }

  private cancellation(signal: AbortSignal): LlmError {
    const timeout = timeoutOf(signal, TIMEOUT_CODE)
    return timeout === undefined
      ? new LlmError('Claude Code request aborted', 'ABORTED', { cause: signal.reason })
      : new LlmError(`Claude Code timed out after ${timeout.timeoutMs}ms`, 'TIMEOUT', { cause: timeout })
  }
}
