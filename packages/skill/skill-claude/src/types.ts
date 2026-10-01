/**
 * Shared types for the Claude skill provider.
 *
 * @module @deepseek-ai/dsh-skill-claude/types
 */

/** Reports a warning at most once per key; the key is usually the file or directory path. */
export type Warn = (key: string, message: string) => void

/** Whether a root holds `<dir>/SKILL.md` bundles or flat `*.md` command files. */
export type SourceKind = 'skills' | 'commands'

/** One directory scanned for Claude skills or command files. */
export interface SkillRoot {
  /** Layout of the directory. */
  readonly kind: SourceKind
  /** Absolute directory path. */
  readonly dir: string
  /** Registry rank; lower wins a duplicate name inside one layer. */
  readonly rank: number
  /** Prompt-visible origin label. */
  readonly source: string
  /** Plugin name that prefixes every skill name from this root; absent for project and user roots. */
  readonly plugin?: string
}

/** Directories to scan plus directories whose direct children signal a configuration change. */
export interface ResolvedSources {
  /** Skill and command roots, best rank first. */
  readonly roots: readonly SkillRoot[]
  /** Directories watched non-recursively so new roots and configuration files are noticed. */
  readonly shallowDirs: readonly string[]
}

/** Opaque handle the provider stores in each candidate and receives back in `get()`. */
export interface ClaudeLocator {
  /** Absolute path of the `SKILL.md` or command file. */
  readonly path: string
}
