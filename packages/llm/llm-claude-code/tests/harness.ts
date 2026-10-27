/**
 * Shared test harness: a real local subprocess runtime whose spawn of the
 * configured `claude` executable is redirected to the fake script. Only the
 * external binary is faked; stdio, process range, signalling, and teardown stay
 * the production subprocess code.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const FAKE_CLAUDE = fileURLToPath(new URL('./fake-claude.cjs', import.meta.url))

/** One run the fake recorded. */
export interface FakeRun {
  argv: string[]
  cwd: string
  cwdEntries: string[]
  files: { system?: string; tools?: string; mcp?: string }
  stdin: string
  maxOutputTokens?: string
  hanging?: number
}

/** Local runtime that runs `node fake-claude.cjs <claude argv>` instead of the real binary. */
export class FakeClaudeSubprocess extends LocalSubprocessRuntime {
  /** Run log the fake appends to; tests point it at a fresh file per test. */
  static logPath = ''
  /** Specs seen by `spawn`, so tests can assert what reached the seam. */
  static spawned: SubprocessSpawnSpec[] = []

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    FakeClaudeSubprocess.spawned.push(spec)
    return super.spawn({
      ...spec,
      argv: [process.execPath, FAKE_CLAUDE, ...spec.argv.slice(1)],
      env: { ...spec.env, FAKE_CLAUDE_LOG: FakeClaudeSubprocess.logPath },
    })
  }
}

/** Read every record the fake logged so far. */
export function readRuns(): FakeRun[] {
  let text: string
  try {
    text = readFileSync(FakeClaudeSubprocess.logPath, 'utf8')
  } catch {
    return []
  }
  return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as FakeRun)
}

/** Whether a process id is still alive. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Mount the fake-backed subprocess runtime on a fresh context. */
export async function subprocessContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(FakeClaudeSubprocess)
  return ctx
}
