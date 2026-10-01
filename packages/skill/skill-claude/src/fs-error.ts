/**
 * Filesystem error classification shared by the Claude skill scanners.
 *
 * @module @deepseek-ai/dsh-skill-claude/fs-error
 */

/**
 * Return whether a Node filesystem error means the path does not exist.
 * @param error - value caught from a `node:fs` call.
 * @returns whether the code is `ENOENT` or `ENOTDIR`.
 */
export function isMissing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
