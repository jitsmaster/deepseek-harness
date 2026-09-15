import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'

/** One skill discovered on disk, ready to become a slash command. */
export interface ScannedSkill {
  /** Discriminant distinguishing a `SKILL.md` skill from a `.claude/commands/*.md` command file — see {@link ScannedCommandFile}. */
  readonly kind: 'skill'
  readonly name: string
  readonly description: string
  readonly body: string
  /**
   * Which directory this skill was found in: `'project'` for the session's
   * `<cwd>/.claude/skills` (repo-authored, untrusted-by-default — see Fix C's
   * first-use confirmation in `index.ts`), `'user'` for the operator's own
   * `~/.claude/skills` (trusted, steers immediately).
   */
  readonly tier: 'project' | 'user'
}

/**
 * One Claude Code custom slash-command `.md` file discovered on disk, ready
 * to become a slash command. Unlike a `SKILL.md` skill, its name comes from
 * the filename (not frontmatter), frontmatter is entirely optional, and its
 * body is a template containing a literal `$ARGUMENTS` placeholder rather
 * than steering typed arguments as a second message — see
 * `substituteArguments` in `index.ts`.
 */
export interface ScannedCommandFile {
  readonly kind: 'command'
  readonly name: string
  readonly description: string
  readonly body: string
  /** Same project/user trust-tier meaning as {@link ScannedSkill.tier}. */
  readonly tier: 'project' | 'user'
}

/** Either shape a Claude Code directory scan can hand back for registration. */
export type ScannedEntry = ScannedSkill | ScannedCommandFile

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

// A legitimate SKILL.md is prose plus frontmatter — a few KB at most, rarely
// beyond a few tens of KB. This cap is set generously above that (200,000
// bytes) so no real skill file is ever rejected, while still refusing a
// pathological or malicious file before it is read into memory. `statSync`
// runs first (see `parseSkillFile` below) so the common case never pays for
// reading an oversized file — but `stat` and the read are still two separate
// calls, so a file that grows past the cap in between (concurrent write, or
// attacker-controlled repo content) is NOT trusted on the stat's word alone:
// `readSkillFileCapped` re-checks cumulative bytes read during the read
// itself and aborts once they exceed this cap, closing that TOCTOU gap. Same
// convention as claude-session-import's `RAW_TRANSCRIPT_MAX_BYTES` /
// `readTranscriptCapped` (packages/session/claude-session-import/src/index.ts).
export const SKILL_FILE_MAX_BYTES = 200_000

/**
 * Reports one skip reason for a malformed or unreadable skill file. Pure
 * scanners here have no `ctx`, so warnings are handed out instead of logged
 * directly.
 */
export type SkillScanWarn = (message: string) => void

/**
 * Test seam threaded through {@link scanSkillDirectories} down to
 * {@link parseSkillFile}: `afterStat` runs after the up-front `statSync`
 * check but before the capped read begins, letting a test grow a file past
 * the cap in that exact window to prove the read itself — not the earlier
 * stat — is what enforces {@link SKILL_FILE_MAX_BYTES}. Mirrors
 * claude-session-import's `ReadTranscriptCappedInternals.afterStat`
 * (packages/session/claude-session-import/src/index.ts). Production callers
 * never pass this.
 */
export interface SkillScanInternals {
  afterStat?: (path: string) => void
}

/** Thrown internally by {@link readSkillFileCapped} when the read exceeds the cap; caught by `parseSkillFile`. */
class SkillFileTooLargeError extends Error {}

// Read chunk size for the capped read below — large enough to make the loop
// cheap for the overwhelming majority of skill files (a few KB), small
// enough that overshoot past the cap before the next bounds check stays
// negligible.
const READ_CHUNK_BYTES = 65_536

/**
 * Read a file's full UTF-8 contents via a byte-counted `readSync` loop,
 * aborting as soon as cumulative bytes read exceed {@link SKILL_FILE_MAX_BYTES}
 * — regardless of what an earlier `statSync` reported. Closes the TOCTOU gap
 * a `statSync` size check followed by a separate single-shot `readFileSync`
 * leaves open: a file that grows past the cap between the two calls (a
 * concurrent writer, or attacker-controlled repo content) would otherwise
 * still be read into memory in full. Same enforcement guarantee as
 * claude-session-import's `readTranscriptCapped`
 * (packages/session/claude-session-import/src/index.ts), ported to a
 * synchronous `readSync` loop rather than `createReadStream` because this
 * function's whole call chain (`parseSkillFile` -> `skillsIn` ->
 * `scanSkillDirectories`) is synchronous today.
 * @throws {SkillFileTooLargeError} once cumulative bytes read exceed the cap.
 * @throws whatever `openSync`/`readSync` throw for a missing/unreadable file.
 */
function readSkillFileCapped(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const chunks: Buffer[] = []
    let bytes = 0
    const buffer = Buffer.alloc(READ_CHUNK_BYTES)
    for (;;) {
      const read = readSync(fd, buffer, 0, READ_CHUNK_BYTES, null)
      if (read === 0) break
      bytes += read
      if (bytes > SKILL_FILE_MAX_BYTES) {
        throw new SkillFileTooLargeError(`${path} exceeds the ${SKILL_FILE_MAX_BYTES}-byte cap while reading`)
      }
      chunks.push(Buffer.from(buffer.subarray(0, read)))
    }
    return Buffer.concat(chunks, bytes).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

// A skill's frontmatter `name` becomes a slash-command name, so it must
// satisfy the command registry's own name format — replicated here rather
// than imported to avoid a cross-package dependency for one regex. Must stay
// in sync with `COMMAND_NAME` in
// `packages/interaction/commands/src/index.ts` — a dedicated test
// (`tests/skill-scanner.spec.ts`) asserts the two patterns stay equivalent.
export const SKILL_NAME_FORMAT = /^[a-z][a-z0-9_-]*$/u

/** Parse one `SKILL.md` file's frontmatter and body, or `undefined` when malformed. */
function parseSkillFile(
  path: string,
  tier: ScannedSkill['tier'],
  onWarn: SkillScanWarn | undefined,
  internals: SkillScanInternals,
): ScannedSkill | undefined {
  let raw: string
  try {
    const { size } = statSync(path)
    if (size > SKILL_FILE_MAX_BYTES) {
      onWarn?.(`Skipped SKILL.md that is too large (${size} bytes, exceeding the ${SKILL_FILE_MAX_BYTES}-byte cap) at ${path}`)
      return undefined
    }
    internals.afterStat?.(path)
    raw = readSkillFileCapped(path)
  } catch (err) {
    if (err instanceof SkillFileTooLargeError) {
      onWarn?.(`Skipped SKILL.md that is too large (exceeds the ${SKILL_FILE_MAX_BYTES}-byte cap while reading) at ${path}`)
    } else {
      onWarn?.(`Skipped unreadable SKILL.md: ${path}`)
    }
    return undefined
  }
  // Strip UTF-8 BOM if present (a Windows editor like Notepad can save UTF-8 text with a BOM)
  raw = raw.replace(/^﻿/, '')
  const match = FRONTMATTER.exec(raw)
  if (match === null) {
    onWarn?.(`Skipped SKILL.md with no frontmatter: ${path}`)
    return undefined
  }
  const [, frontmatterYaml, body] = match
  let frontmatter: unknown
  try {
    frontmatter = load(frontmatterYaml ?? '')
  } catch (_err) {
    onWarn?.(`Skipped SKILL.md with invalid YAML frontmatter at ${path}: ${_err instanceof Error ? _err.message : 'unknown error'}`)
    return undefined
  }
  if (typeof frontmatter !== 'object' || frontmatter === null) {
    onWarn?.(`Skipped SKILL.md with non-object frontmatter at ${path}`)
    return undefined
  }
  const { name, description } = frontmatter as { name?: unknown; description?: unknown }
  if (typeof name !== 'string' || name.trim().length === 0) {
    onWarn?.(`Skipped SKILL.md with missing or blank name at ${path}`)
    return undefined
  }
  if (!SKILL_NAME_FORMAT.test(name)) {
    onWarn?.(`Skipped SKILL.md with invalid name format "${name}" at ${path} (must match ${String(SKILL_NAME_FORMAT)})`)
    return undefined
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    onWarn?.(`Skipped SKILL.md with missing or blank description at ${path}`)
    return undefined
  }
  return { kind: 'skill', name, description, body: (body ?? '').trim(), tier }
}

/**
 * Parse one `.claude/commands/*.md` file. Unlike a `SKILL.md` skill, the
 * command name comes from the filename (not frontmatter) and frontmatter
 * itself is optional: a file with no `---` block registers using its
 * filename and a generic description, with the whole file as its body.
 */
function parseCommandFile(
  path: string,
  fileName: string,
  tier: ScannedCommandFile['tier'],
  onWarn: SkillScanWarn | undefined,
  internals: SkillScanInternals,
): ScannedCommandFile | undefined {
  const name = fileName.slice(0, -'.md'.length)
  if (!SKILL_NAME_FORMAT.test(name)) {
    onWarn?.(`Skipped command file with invalid name format "${name}" at ${path} (must match ${String(SKILL_NAME_FORMAT)})`)
    return undefined
  }
  let raw: string
  try {
    const { size } = statSync(path)
    if (size > SKILL_FILE_MAX_BYTES) {
      onWarn?.(`Skipped command file that is too large (${size} bytes, exceeding the ${SKILL_FILE_MAX_BYTES}-byte cap) at ${path}`)
      return undefined
    }
    internals.afterStat?.(path)
    raw = readSkillFileCapped(path)
  } catch (err) {
    if (err instanceof SkillFileTooLargeError) {
      onWarn?.(`Skipped command file that is too large (exceeds the ${SKILL_FILE_MAX_BYTES}-byte cap while reading) at ${path}`)
    } else {
      onWarn?.(`Skipped unreadable command file: ${path}`)
    }
    return undefined
  }
  raw = raw.replace(/^﻿/, '')
  const match = FRONTMATTER.exec(raw)
  if (match === null) {
    return { kind: 'command', name, description: `Custom command "/${name}" imported from Claude Code`, body: raw.trim(), tier }
  }
  const [, frontmatterYaml, body] = match
  let frontmatter: unknown
  try {
    frontmatter = load(frontmatterYaml ?? '')
  } catch (_err) {
    onWarn?.(`Skipped command file with invalid YAML frontmatter at ${path}: ${_err instanceof Error ? _err.message : 'unknown error'}`)
    return undefined
  }
  const { description } = (typeof frontmatter === 'object' && frontmatter !== null ? frontmatter : {}) as { description?: unknown }
  const resolvedDescription = typeof description === 'string' && description.trim().length > 0
    ? description
    : `Custom command "/${name}" imported from Claude Code`
  return { kind: 'command', name, description: resolvedDescription, body: (body ?? '').trim(), tier }
}

/** One directory's `.claude/commands/*.md` files, keyed by command name (the file's own basename). */
function commandFilesIn(
  commandsDir: string,
  tier: ScannedCommandFile['tier'],
  onWarn: SkillScanWarn | undefined,
  internals: SkillScanInternals,
): readonly ScannedCommandFile[] {
  let entries: string[]
  try {
    // Namespaced commands (a subdirectory such as `modes/sparc.md`, surfaced
    // by Claude Code as `/modes:sparc`) are not yet supported here — the
    // command registry's name grammar has no room for a colon — so only
    // direct `.md` files are scanned; subdirectories are silently skipped
    // rather than warned about, since they are not malformed, just a
    // not-yet-implemented source.
    entries = readdirSync(commandsDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => entry.name)
  } catch {
    return []
  }
  const commands: ScannedCommandFile[] = []
  const seenNames = new Set<string>()
  for (const fileName of entries) {
    const parsed = parseCommandFile(join(commandsDir, fileName), fileName, tier, onWarn, internals)
    if (parsed === undefined) continue
    if (seenNames.has(parsed.name)) {
      onWarn?.(`Skipped command file with duplicate name "${parsed.name}" (collision with another command file at ${commandsDir}): ${join(commandsDir, fileName)}`)
      continue
    }
    seenNames.add(parsed.name)
    commands.push(parsed)
  }
  return commands
}

/**
 * Scan project and user Claude Code `.claude/commands/*.md` files,
 * project-first — the sibling scan to {@link scanSkillDirectories} for
 * Claude Code's other slash-command source (plain command templates rather
 * than `SKILL.md` skills).
 * @param cwd - the session's working directory, or `undefined` when the
 *   session has never logged one. Project-level command files are skipped
 *   entirely in that case, exactly like {@link scanSkillDirectories}.
 * @param homedir - the operator's home directory.
 * @param onWarn - called with one message per skipped malformed or
 *   unreadable command file; omit to discard warnings.
 * @param internals - test seam (see {@link SkillScanInternals}); production
 *   callers never pass this.
 * @returns command files deduplicated by name; a project-level file shadows
 *   a user-level file of the same name.
 */
export function scanCommandFiles(
  cwd: string | undefined,
  homedir: string,
  onWarn?: SkillScanWarn,
  internals: SkillScanInternals = {},
): readonly ScannedCommandFile[] {
  const project = cwd === undefined ? [] : commandFilesIn(join(cwd, '.claude', 'commands'), 'project', onWarn, internals)
  const user = commandFilesIn(join(homedir, '.claude', 'commands'), 'user', onWarn, internals)
  const seen = new Set(project.map(entry => entry.name))
  return [...project, ...user.filter(entry => !seen.has(entry.name))]
}

/** One directory's skills, keyed by skill folder name (the SKILL.md's own directory). */
function skillsIn(
  skillsDir: string,
  tier: ScannedSkill['tier'],
  onWarn: SkillScanWarn | undefined,
  internals: SkillScanInternals,
): readonly ScannedSkill[] {
  let entries: string[]
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
  const skills: ScannedSkill[] = []
  const seenNames = new Set<string>()
  for (const entry of entries) {
    const parsed = parseSkillFile(join(skillsDir, entry, 'SKILL.md'), tier, onWarn, internals)
    if (parsed === undefined) continue
    // Two skill folders at the SAME tier (both project-level, or both
    // user-level) declaring the same name is a collision worth surfacing —
    // unlike project-shadows-user (by design, silent), there is no
    // precedence rule here to justify silently dropping one. First-found in
    // `readdirSync` order wins; later duplicates are warned about and dropped.
    if (seenNames.has(parsed.name)) {
      onWarn?.(`Skipped SKILL.md with duplicate name "${parsed.name}" (collision with another skill at ${skillsDir}): ${join(skillsDir, entry, 'SKILL.md')}`)
      continue
    }
    seenNames.add(parsed.name)
    skills.push(parsed)
  }
  return skills
}

/**
 * Scan project and user Claude Code skill directories, project-first.
 * @param cwd - the session's working directory, or `undefined` when the
 *   session has never logged one. Project-level skills are skipped entirely
 *   in that case rather than falling back to an arbitrary directory — only
 *   `homedir`'s user-level skills are scanned.
 * @param homedir - the operator's home directory.
 * @param onWarn - called with one message per skipped malformed or
 *   unreadable `SKILL.md`; omit to discard warnings (e.g. in tests that
 *   don't assert on them).
 * @param internals - test seam (see {@link SkillScanInternals}); production
 *   callers never pass this.
 * @returns skills deduplicated by name; a project-level skill shadows a
 *   user-level skill of the same name.
 */
export function scanSkillDirectories(
  cwd: string | undefined,
  homedir: string,
  onWarn?: SkillScanWarn,
  internals: SkillScanInternals = {},
): readonly ScannedSkill[] {
  const project = cwd === undefined ? [] : skillsIn(join(cwd, '.claude', 'skills'), 'project', onWarn, internals)
  const user = skillsIn(join(homedir, '.claude', 'skills'), 'user', onWarn, internals)
  const seen = new Set(project.map(skill => skill.name))
  return [...project, ...user.filter(skill => !seen.has(skill.name))]
}
