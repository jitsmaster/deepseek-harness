/**
 * SDK-backed command discovery and one-shot slash-command invocation, built
 * on the same query/spawn/env/cwd plumbing as an ordinary Claude Code run.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code/list-commands
 */

import { query as officialQuery, type SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import {
  claudeQueryOptions,
  disposeClaudeCodeChild,
  startClaudeCodeRun,
  type ClaudeCodeRunSpec,
} from './run.ts'

/**
 * List the Claude Code CLI's supported slash commands via a short-lived
 * official SDK query started over the exact spawn/env/cwd plumbing an
 * ordinary run uses. No meaningful prompt turn is sent — only
 * `query.supportedCommands()` is read before the query and its managed
 * child are disposed, whether or not the read succeeds.
 * @param spec - Workspace, environment, process service, and disposal policy.
 * @returns the SDK-reported command list.
 */
export async function listClaudeCodeCommands(spec: ClaudeCodeRunSpec): Promise<SlashCommand[]> {
  const controller = new AbortController()
  let child: SubprocessHandle | undefined
  const captureChild = (captured: SubprocessHandle): void => {
    child = captured
  }
  const query = officialQuery({
    // No meaningful prompt turn is needed here — only the command listing matters.
    prompt: '',
    options: claudeQueryOptions(spec, controller, captureChild, () => {}),
  })
  try {
    return await query.supportedCommands()
  } finally {
    if (child === undefined) {
      query.close()
    } else {
      await disposeClaudeCodeChild(query, child)
    }
  }
}

/**
 * Run one Claude Code slash command as a one-shot prompt: `/name rawInput`
 * is just an ordinary prompt string to the real CLI. Reuses
 * {@link startClaudeCodeRun} unchanged (which in turn reuses its own
 * `textTask()` normalization over this content).
 * @param name - command name without the leading slash (may be namespaced, e.g. `modes:sparc`).
 * @param rawInput - exact text following the command name, including any separating whitespace.
 * @param spec - Workspace, environment, process service, and disposal policy.
 * @param signal - cancellation signal owned by the invoking UI request.
 * @returns the run's final assistant text.
 */
export async function runClaudeCodeSlashCommand(
  name: string,
  rawInput: string,
  spec: ClaudeCodeRunSpec,
  signal: AbortSignal,
): Promise<string> {
  const run = await startClaudeCodeRun({
    // `startClaudeCodeRun` runs its own `textTask()` over this content —
    // a slash-command line is just an ordinary one-shot prompt string.
    prompt: [{ type: 'text', text: `/${name}${rawInput}` }],
    // The parent agent is unused by startClaudeCodeRun itself (only a
    // deployment-level wrapper derives cwd from it) — this seam already
    // receives an explicit `spec.cwd`, so no real agent is needed here.
    parent: {} as unknown as Agent,
    signal,
  }, spec)
  const result = await run.result
  const text = result.output.find(
    (block): block is { type: 'text'; text: string } => block.type === 'text',
  )?.text
  return text ?? ''
}
