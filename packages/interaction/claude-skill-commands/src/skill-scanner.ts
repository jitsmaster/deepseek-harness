import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'

/** One skill discovered on disk, ready to become a slash command. */
export interface ScannedSkill {
  readonly name: string
  readonly description: string
  readonly body: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

/** Parse one `SKILL.md` file's frontmatter and body, or `undefined` when malformed. */
function parseSkillFile(path: string): ScannedSkill | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  // Strip UTF-8 BOM if present
  raw = raw.replace(/^﻿/, '')
  const match = FRONTMATTER.exec(raw)
  if (match === null) return undefined
  const [, frontmatterYaml, body] = match
  let frontmatter: unknown
  try {
    frontmatter = load(frontmatterYaml ?? '')
  } catch {
    return undefined
  }
  if (typeof frontmatter !== 'object' || frontmatter === null) return undefined
  const { name, description } = frontmatter as { name?: unknown; description?: unknown }
  if (typeof name !== 'string' || name.trim().length === 0) return undefined
  if (typeof description !== 'string' || description.trim().length === 0) return undefined
  return { name, description, body: (body ?? '').trim() }
}

/** One directory's skills, keyed by skill folder name (the SKILL.md's own directory). */
function skillsIn(skillsDir: string): readonly ScannedSkill[] {
  let entries: string[]
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
  const skills: ScannedSkill[] = []
  for (const entry of entries) {
    const parsed = parseSkillFile(join(skillsDir, entry, 'SKILL.md'))
    if (parsed !== undefined) skills.push(parsed)
  }
  return skills
}

/**
 * Scan project and user Claude Code skill directories, project-first.
 * @param cwd - the session's working directory.
 * @param homedir - the operator's home directory.
 * @returns skills deduplicated by name; a project-level skill shadows a
 *   user-level skill of the same name.
 */
export function scanSkillDirectories(cwd: string, homedir: string): readonly ScannedSkill[] {
  const project = skillsIn(join(cwd, '.claude', 'skills'))
  const user = skillsIn(join(homedir, '.claude', 'skills'))
  const seen = new Set(project.map(skill => skill.name))
  return [...project, ...user.filter(skill => !seen.has(skill.name))]
}
