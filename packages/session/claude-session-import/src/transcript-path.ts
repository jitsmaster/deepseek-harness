/**
 * Directory Claude Code slugs a project's own working directory into. Claude
 * Code replaces every non-alphanumeric character — path separators, the
 * Windows drive-letter colon, and dots in a segment like `.claude` alike —
 * with `-`; this mirrors that slug so both a session's transcript
 * ({@link claudeCodeTranscriptPath}) and its project memory (see
 * `project-memory.ts`'s `readProjectMemory`) are addressable without asking
 * Claude Code for them directly. Replacing only separators and the colon
 * left a dot-directory in the cwd (e.g. a `.claude/worktrees/…` git
 * worktree) untouched, producing `…-.claude-worktrees-…` instead of Claude
 * Code's own `…--claude-worktrees-…` and missing the transcript entirely.
 * @param homedir - the operator's home directory (`os.homedir()`).
 * @param cwd - the session's working directory, as reported by `claude agents --json`.
 * @returns absolute path to `<home>/.claude/projects/<slug>`.
 */
export function claudeCodeProjectDir(homedir: string, cwd: string): string {
  const isWindowsStyle = homedir.includes('\\')
  const pathSep = isWindowsStyle ? '\\' : '/'
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return [homedir, '.claude', 'projects', slug].join(pathSep)
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
