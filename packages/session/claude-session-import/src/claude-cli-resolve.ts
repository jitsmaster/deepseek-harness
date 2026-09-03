/**
 * Resolve the real argv needed to run the operator's `claude` CLI without a
 * shell. A bare `claude` isn't found by a shell-less spawn on Windows
 * (`ENOENT` — no PATHEXT-style extension search), and once resolved to the
 * npm-generated `.cmd`/`.bat` shim, spawning that shim directly (even by
 * absolute path) fails with `EINVAL`: Node refuses to run a batch file
 * without `shell: true`. This resolves the shim's own declared target
 * instead and spawns that directly, so no shell is ever involved.
 * @module @deepseek-ai/dsh-claude-session-import/claude-cli-resolve
 */

import { readFile } from 'node:fs/promises'
import { dirname, extname, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** Extensions whose target must be run through Node rather than launched directly. */
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])

/** Matches an npm-generated cmd shim's final invocation line: `"%dp0%\<target>"   %*`. */
const CMD_SHIM_TARGET = /"%dp0%\\((?:[^"\\]|\\.)+)"/

/**
 * Extract the quoted target path from an npm-generated Windows `.cmd`/`.bat`
 * shim's invocation line, if the content matches that standard template.
 * @param shimContent - the shim file's raw text.
 * @returns the target, as a path relative to the shim's own directory, or
 *   undefined when the content doesn't match.
 */
export function parseCmdShimTarget(shimContent: string): string | undefined {
  return CMD_SHIM_TARGET.exec(shimContent)?.[1]
}

/**
 * Resolve the argv prefix needed to launch the operator's `claude` CLI
 * directly, working around Windows' shim indirection. Never throws: any
 * resolution or read failure falls back to the plain resolved path, leaving
 * the caller's own spawn to fail (and be handled there) as before.
 * @param ctx - Host context carrying `ctx.subprocess`.
 * @param signal - withdraws the resolution.
 * @returns one or two argv entries to prepend to the CLI's own arguments.
 */
export async function resolveClaudeCliArgv(ctx: Context, signal: AbortSignal): Promise<string[]> {
  const resolved = await ctx.subprocess.resolveExecutable('claude', undefined, signal)
  if (!/\.(?:cmd|bat)$/i.test(resolved)) return [resolved]
  let shimContent: string
  try {
    shimContent = await readFile(resolved, 'utf8')
  } catch {
    return [resolved]
  }
  const target = parseCmdShimTarget(shimContent)
  if (target === undefined) return [resolved]
  const targetPath = resolvePath(dirname(resolved), target)
  return SCRIPT_EXTENSIONS.has(extname(targetPath).toLowerCase())
    ? [process.execPath, targetPath]
    : [targetPath]
}
