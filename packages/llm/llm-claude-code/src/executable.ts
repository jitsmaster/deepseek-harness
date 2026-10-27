/**
 * Synchronous, network-free lookup of the user's `claude` executable, so the
 * adapter can fail a call before it starts a process.
 * @module @deepseek-ai/dsh-llm-claude-code/executable
 */

import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** Command looked up on `PATH` when no `executable` is configured. */
export const DEFAULT_CLAUDE_EXECUTABLE = 'claude'

/** Windows launchable extensions: the child is spawned without a shell, so batch shims cannot run. */
const WINDOWS_NATIVE_EXTENSIONS = ['.exe', '.com']

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a configured command to an executable file.
 * @param command - absolute path or bare command name; a relative path with a separator never resolves.
 * @param env - environment whose `PATH` bare names are searched on.
 * @returns the executable's path, or `undefined` when none is found.
 */
export function locateExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (command.length === 0) return undefined
  if (isAbsolute(command)) return isExecutableFile(command) ? command : undefined
  if (command.includes('/') || command.includes('\\')) return undefined
  const windows = process.platform === 'win32'
  const path = windows
    ? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1]
    : env.PATH
  const hasExtension = windows && /\.[^./\\]+$/u.test(command)
  const names = windows && !hasExtension
    ? WINDOWS_NATIVE_EXTENSIONS.map(extension => command + extension)
    : [command]
  for (const directory of (path ?? '').split(delimiter)) {
    if (directory.length === 0) continue
    for (const name of names) {
      const candidate = join(directory, name)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Pick the executable when none is configured: `claude` on `PATH`, else the native
 * installer's per-user location (which is often not on `PATH`).
 * @param env - environment whose `PATH` is searched.
 * @returns the found path, or the installer location (unavailable until Claude Code is installed there).
 */
export function defaultExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return locateExecutable(DEFAULT_CLAUDE_EXECUTABLE, env)
    ?? join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
}
