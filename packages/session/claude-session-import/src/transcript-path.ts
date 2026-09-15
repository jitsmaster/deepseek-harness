/**
 * Directory Claude Code slugs a project's own working directory into. Claude
 * Code replaces every path separator (and, on Windows, the drive-letter
 * colon) with `-`; this mirrors that slug so both a session's transcript
 * ({@link claudeCodeTranscriptPath}) and its project memory (see
 * `project-memory.ts`'s `readProjectMemory`) are addressable without asking
 * Claude Code for them directly.
 * @param homedir - the operator's home directory (`os.homedir()`).
 * @param cwd - the session's working directory, as reported by `claude agents --json`.
 * @returns absolute path to `<home>/.claude/projects/<slug>`.
 */
export function claudeCodeProjectDir(homedir: string, cwd: string): string {
  const isWindowsStyle = homedir.includes('\\')
  const pathSep = isWindowsStyle ? '\\' : '/'
  const slug = cwd.replace(/:/g, '-').split(/[/\\]/).filter(part => part.length > 0).join('-')
  // Windows-style paths don't have leading dash; POSIX-style do (from leading `/`)
  const leadingDash = isWindowsStyle ? '' : '-'
  return [homedir, '.claude', 'projects', `${leadingDash}${slug}`].join(pathSep)
}

/**
 * Path to a Claude Code CLI session's transcript on disk.
 * @param homedir - the operator's home directory (`os.homedir()`).
 * @param cwd - the session's working directory, as reported by `claude agents --json`.
 * @param sessionId - the session id.
 * @returns absolute path to `<home>/.claude/projects/<slug>/<sessionId>.jsonl`.
 */
export function claudeCodeTranscriptPath(homedir: string, cwd: string, sessionId: string): string {
  const isWindowsStyle = homedir.includes('\\')
  const pathSep = isWindowsStyle ? '\\' : '/'
  return [claudeCodeProjectDir(homedir, cwd), `${sessionId}.jsonl`].join(pathSep)
}
