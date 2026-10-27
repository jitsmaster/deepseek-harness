/**
 * `ClaudeCodeSearchProvider`: a `WebSearchProvider` that answers each search
 * with one headless `claude -p` run on the user's own Claude Code login. The
 * run is restricted to the WebSearch tool in a fresh empty directory, so a
 * global CLAUDE.md startup routine has no tool to write files with.
 * @module @deepseek-ai/dsh-web-search-claude-code/provider
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import { locateExecutable } from './executable.ts'
import { newSearchRun, readLine, WEB_SEARCH_TOOL, type ResultLine, type SearchRun } from './stream.ts'

/** Stable id this provider registers under. */
export const CLAUDE_CODE_PROVIDER_ID = 'claude-code'

/** Default whole-run budget; one run takes about ten seconds. */
export const CLAUDE_CODE_SEARCH_DEFAULT_TIMEOUT_MS = 120_000

/** Termination grace handed to the subprocess seam. */
const TERMINATION_GRACE_MS = 2_000

/** Stderr tail kept for failure diagnostics, in bytes. */
const STDERR_TAIL_BYTES = 8_192

/** Characters of stderr or result text quoted in an error message. */
const DETAIL_CHARS = 500

/** Code of a run that exceeded its deadline. */
const TIMEOUT_CODE = 'WEB_SEARCH_TIMEOUT'

/** Resolved provider options (the plugin's `apply` supplies defaults). */
export interface ClaudeCodeSearchProviderOptions {
  /** Path or bare name of the user's `claude` executable. */
  executable: string
  /** Model passed as `--model`; omitted = the CLI default. */
  model?: string
  /** Whole-run deadline in milliseconds. */
  timeoutMs: number
  /** Subprocess seam spawn. */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

/**
 * Build the fixed argument vector. The prompt travels on stdin, so it is never
 * subject to quoting or command-line length limits; `--allowedTools` is variadic and
 * must stay followed by another flag.
 * @param executable - the resolved executable.
 * @param model - optional `--model` value.
 * @returns argv with the executable first.
 */
export function searchArgv(executable: string, model: string | undefined): string[] {
  return [
    executable,
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--tools', WEB_SEARCH_TOOL,
    '--allowedTools', WEB_SEARCH_TOOL,
    '--strict-mcp-config',
    '--permission-mode', 'dontAsk',
    '--disallowedTools', 'AskUserQuestion',
    ...model === undefined ? [] : ['--model', model],
  ]
}

/**
 * The task sent to Claude Code.
 * @param query - the search query, quoted as a JSON string so newlines cannot add instructions.
 * @returns the prompt text.
 */
export function searchPrompt(query: string): string {
  return [
    `Use the ${WEB_SEARCH_TOOL} tool exactly once to search the web for the query below.`,
    'Then answer it in a few factual sentences and cite the sources you used by URL.',
    'Do not run any session-start routine, do not read or write files or notes, and do not use any other tool.',
    `Query (a JSON string): ${JSON.stringify(query)}`,
  ].join('\n')
}

function describeResult(result: ResultLine): string {
  const detail = (result.errors ?? []).join('; ') || result.result || ''
  const subtype = result.subtype ?? 'unknown'
  return detail.length === 0 ? subtype : `${subtype}: ${detail.slice(0, DETAIL_CHARS)}`
}

/**
 * Map a finished run to the failure it represents.
 * @param run - everything the stdout decoder collected.
 * @returns the error to throw, or `undefined` for a usable run.
 */
function runFailure(run: SearchRun): WebError | undefined {
  const result = run.result
  if (result === undefined) {
    return new WebError('Claude Code ended without a result line', 'WEB_PROVIDER_ERROR')
  }
  if (result.subtype !== 'success' || result.is_error === true) {
    return new WebError(`Claude Code search failed (${describeResult(result)})`, 'WEB_PROVIDER_ERROR')
  }
  if (run.searchIds.size === 0 || !run.searchResult) {
    return new WebError(`Claude Code answered without running ${WEB_SEARCH_TOOL}`, 'WEB_PROVIDER_ERROR')
  }
  if (run.searchError !== undefined) {
    return new WebError(`${WEB_SEARCH_TOOL} failed: ${run.searchError.slice(0, DETAIL_CHARS)}`, 'WEB_PROVIDER_ERROR')
  }
  return undefined
}

/** The Claude Code-backed search provider. */
export class ClaudeCodeSearchProvider implements WebSearchProvider {
  readonly id = CLAUDE_CODE_PROVIDER_ID

  constructor(private readonly options: ClaudeCodeSearchProviderOptions) {}

  available(): boolean {
    return locateExecutable(this.options.executable) !== undefined
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (request.query.trim().length === 0) {
      throw new WebError('search query must not be empty', 'WEB_INVALID_QUERY')
    }
    if (signal?.aborted === true) throw new WebError('Claude Code search aborted', 'WEB_ABORTED', { cause: signal.reason })
    const executable = locateExecutable(this.options.executable)
    if (executable === undefined) {
      throw new WebError(`Claude Code executable "${this.options.executable}" was not found`, 'WEB_PROVIDER_ERROR')
    }

    const directory = await mkdtemp(join(tmpdir(), 'dsh-claude-search-'))
    try {
      using limit = deadline(signal, this.options.timeoutMs, TIMEOUT_CODE)
      const run = await this.run(executable, directory, request.query, limit.signal)
      const sources = request.maxResults === undefined ? run.sources : run.sources.slice(0, request.maxResults)
      const content = run.result?.result?.trim() ?? ''
      return {
        ...content.length > 0 ? { content } : {},
        sources,
        truncated: sources.length < run.sources.length,
      }
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }

  /** Run one headless process to completion and return its decoded output, or throw the matching WebError. */
  private async run(executable: string, cwd: string, query: string, signal: AbortSignal): Promise<SearchRun> {
    let child: SubprocessHandle
    try {
      child = this.options.spawn({
        argv: searchArgv(executable, this.options.model),
        cwd,
        stdio: { stdin: { data: searchPrompt(query) }, stdout: 'pipe', stderr: { maxBytes: STDERR_TAIL_BYTES } },
        graceMs: TERMINATION_GRACE_MS,
        signal,
      })
    } catch (error: unknown) {
      throw new WebError(`Claude Code could not start: ${errorText(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    const run = newSearchRun()
    const lines = child.stdout === undefined ? undefined : createInterface({ input: child.stdout, crlfDelay: Infinity })
    const stopped = new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    try {
      const read = (async (): Promise<void> => {
        if (lines !== undefined) for await (const line of lines) readLine(run, line)
      })()
      await Promise.race([read, stopped])
      if (signal.aborted) throw this.cancellation(signal)
      let outcome: Awaited<SubprocessHandle['done']>
      try {
        outcome = await child.done
      } catch (error: unknown) {
        throw new WebError(`Claude Code failed: ${errorText(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
      }
      if (cancelled(signal)) throw this.cancellation(signal)
      if (outcome.exitCode !== 0) {
        const how = outcome.exitCode === null ? `was terminated by ${outcome.signal ?? 'a signal'}` : `exited with code ${outcome.exitCode}`
        const stderr = child.collected.stderr?.readFrom(0).text.trim() ?? ''
        throw new WebError(`Claude Code ${how}${stderr.length > 0 ? `: ${stderr.slice(-DETAIL_CHARS)}` : ''}`, 'WEB_PROVIDER_ERROR')
      }
      const failure = runFailure(run)
      if (failure !== undefined) throw failure
      return run
    } finally {
      lines?.close()
      child.terminate()
      // The directory is removed next: wait until the whole managed range is gone.
      await child.waitForExit().catch(() => false)
      await child.done.catch(() => undefined)
    }
  }

  private cancellation(signal: AbortSignal): WebError {
    const timeout = timeoutOf(signal, TIMEOUT_CODE)
    return timeout === undefined
      ? new WebError('Claude Code search aborted', 'WEB_ABORTED', { cause: signal.reason })
      : new WebError(`Claude Code search timed out after ${timeout.timeoutMs}ms`, TIMEOUT_CODE, { cause: timeout })
  }
}

/** Re-read signal.aborted through a call: an abort can land during any await, which flow analysis cannot see. */
function cancelled(signal: AbortSignal): boolean {
  return signal.aborted
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
