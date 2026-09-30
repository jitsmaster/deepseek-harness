/**
 * Claude Code's own slash commands — the ones that drive the CLI's interactive
 * session, configuration, or account UI rather than a user-authored skill. The
 * CLI reports them from `query.supportedCommands()` right beside real skills
 * (same `SlashCommand` shape, no flag telling them apart), but each invocation
 * runs in a throwaway one-shot subprocess, so `/compact`, `/clear`, `/config`
 * and the like can only ever act on that discarded session, never on the DSH
 * session the user typed them into.
 *
 * Bundled skills that do real work on the workspace (`simplify`, `loop`,
 * `claude-api`, `code-review`, ...) are deliberately absent: they are skills,
 * and stay registered.
 *
 * Observed from `claude-agent-sdk` 0.3.263 against the real CLI; a newer CLI
 * that adds another built-in is listed here by one more name.
 */
const CLAUDE_CODE_BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'advisor',
  'agents',
  'auto-mode-setup',
  'autocompact',
  'clear',
  'color',
  'compact',
  'config',
  'context',
  'debug',
  'design',
  'design-consent',
  'design-revoke',
  'doctor',
  'effort',
  'fast',
  'goal',
  'heapdump',
  'import',
  'init',
  'insights',
  'list-agents',
  'mcp',
  'model',
  'recap',
  'reload-plugins',
  'reload-skills',
  'rename',
  'skill-doctor',
  'team-onboarding',
  'usage',
  'workflow-launch-exec',
])

/**
 * Whether a CLI-reported command is one of Claude Code's own system commands
 * rather than a skill.
 * @param name - SDK-reported command name, without the leading slash.
 * @returns `true` for a built-in (or an internal `__`-prefixed) command.
 */
export function isClaudeCodeBuiltinCommand(name: string): boolean {
  return name.startsWith('__') || CLAUDE_CODE_BUILTIN_COMMAND_NAMES.has(name)
}
