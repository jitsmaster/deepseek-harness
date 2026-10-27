/**
 * Headless one-shot Claude Code run: spawn the user's own, unmodified
 * `claude` executable as `claude -p` under the shared subprocess owner, read
 * its `stream-json` output, and map only a strict success result to
 * completion. No Agent SDK is involved, so the run uses the user's native
 * Claude Code login exactly as an interactive `claude -p` invocation would.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/headless
 */

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import {
  ClaudeCodeFailure,
  failureDiagnostic,
  sdkFailureCategory,
  textTask,
  thrown,
  type ClaudeCodeFailureFacts,
  type ClaudeCodeRunSpec,
} from './run.ts'

/** Inputs for one headless run: the shared run spec plus the executable to launch. */
export interface HeadlessRunSpec extends ClaudeCodeRunSpec {
  /** Absolute path (or PATH-resolvable name) of the official `claude` executable. */
  readonly executable: string
}

/**
 * Build the fixed `claude -p` argument vector. The task itself travels on
 * stdin, so it is never subject to command-line length limits or quoting.
 * @param spec - executable, model, and permission mode.
 * @returns argv including the executable as element zero.
 */
export function headlessArgv(spec: HeadlessRunSpec): string[] {
  return [
    spec.executable,
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--permission-mode',
    spec.permissionMode,
    '--disallowedTools',
    spec.permissionMode === 'plan' ? 'AskUserQuestion,ExitPlanMode' : 'AskUserQuestion',
    ...spec.model === undefined ? [] : ['--model', spec.model],
  ]
}

/** One decoded `result` line of the stream-json protocol. */
interface ResultLine {
  readonly type: 'result'
  readonly subtype?: string
  readonly is_error?: boolean
  readonly result?: string
  readonly errors?: readonly string[]
}

function parseResultLine(line: string): ResultLine | undefined {
  if (!line.startsWith('{')) return undefined
  try {
    const value = JSON.parse(line) as { type?: unknown }
    return value.type === 'result' ? value as ResultLine : undefined
  } catch {
    return undefined
  }
}

/**
 * Strictly derive the only result line that can complete a run.
 * @param message - the decoded `result` event.
 * @returns exact final text of a successful, non-error result.
 */
export function successfulHeadlessResult(message: ResultLine): string {
  if (message.subtype !== 'success') {
    const category = sdkFailureCategory(message.subtype ?? '')
    const detail = category === 'unknown' ? undefined : (message.errors ?? []).join('; ')
    throw new ClaudeCodeFailure(
      { stage: 'query-run', category },
      detail === undefined || detail.length === 0 ? undefined : new Error(detail),
    )
  }
  if (message.is_error === true || (message.result ?? '').trim().length === 0) {
    throw new ClaudeCodeFailure({ stage: 'query-run', category: 'invalid-result' })
  }
  return message.result as string
}

/**
 * Consume the complete stdout stream and require one strict success result.
 * @param lines - stdout lines of the child.
 * @param onResult - records that a terminal result line was seen.
 * @returns the completed shared result.
 */
export async function consumeHeadlessLines(
  lines: AsyncIterable<string>,
  onResult?: () => void,
): Promise<SubagentResult> {
  let answer: string | undefined
  for await (const line of lines) {
    const message = parseResultLine(line)
    if (message === undefined) continue
    onResult?.()
    answer = successfulHeadlessResult(message)
  }
  if (answer === undefined) {
    throw new ClaudeCodeFailure({ stage: 'query-run', category: 'invalid-result' })
  }
  return { output: [{ type: 'text', text: answer }], stopReason: 'completed' }
}

/**
 * Start one headless `claude -p` run and publish its one-shot handle.
 * @param request - resolved shared subagent request.
 * @param spec - executable, workspace, environment, process service, and diagnostic policy.
 * @returns the published run once the child process exists.
 */
export function startHeadlessRun(
  request: SubagentStartRequest,
  spec: HeadlessRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt, {
    ...spec.resolveImagePath === undefined ? {} : { resolveImagePath: spec.resolveImagePath },
    ...spec.resolveFilePath === undefined ? {} : { resolveFilePath: spec.resolveFilePath },
  })
  if (request.signal.aborted) {
    return Promise.reject(new Error('subagent-claude-code: request was aborted before startup'))
  }

  const controller = new AbortController()
  const requestCancel = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('subagent-claude-code: run cancelled locally'))
    }
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: headlessArgv(spec),
      cwd: spec.cwd,
      stdio: { stdin: { data: prompt }, stdout: 'pipe', stderr: 'inherit' },
      graceMs: spec.disposeGraceMs,
      signal: controller.signal,
      env: { ...spec.env },
    })
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const failure = new ClaudeCodeFailure({ stage: 'query-start', category: 'unknown' }, thrown(error))
    spec.onError?.(failure, 'error')
    return Promise.reject(failure)
  }

  let outcome: SubprocessOutcome | undefined
  let receivedResult = false
  let diagnostic: string | undefined
  const processFailure = child.done.then(
    (value) => {
      outcome = value
      return new Promise<never>(() => {})
    },
    (error: unknown) => { throw thrown(error) },
  )
  void processFailure.catch(() => {})

  const stdout = child.stdout
  const lines = stdout === undefined
    ? undefined
    : createInterface({ input: stdout, crlfDelay: Infinity })

  const result = settleRunResult({
    attempt: async () => {
      try {
        if (lines === undefined) {
          throw new ClaudeCodeFailure({ stage: 'query-start', category: 'unknown' })
        }
        const completed = await Promise.race([
          consumeHeadlessLines(lines, () => { receivedResult = true }),
          processFailure,
        ])
        await child.done.catch(() => undefined)
        return completed
      } catch (error: unknown) {
        let facts: ClaudeCodeFailureFacts
        if (error instanceof ClaudeCodeFailure) {
          facts = { ...error.facts, outcome }
        } else if (outcome !== undefined && !receivedResult) {
          facts = { stage: 'process', category: 'process', outcome }
        } else {
          facts = { stage: 'query-run', category: 'unknown', outcome }
        }
        diagnostic = failureDiagnostic(facts)
        throw error instanceof ClaudeCodeFailure ? error : new ClaudeCodeFailure(facts, thrown(error))
      }
    },
    collectOutput: () => [],
    collectDiagnostic: () => diagnostic,
    cancelled: () => controller.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return Promise.resolve(subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: async () => {
      lines?.close()
      child.terminate()
      try {
        await child.waitForExit()
      } catch (error: unknown) {
        const failure = new ClaudeCodeFailure({ stage: 'teardown', category: 'unknown', outcome }, thrown(error))
        spec.onError?.(failure, 'error')
        throw failure
      }
      await child.done.catch(() => undefined)
    },
  }))
}
