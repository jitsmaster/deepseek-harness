/**
 * Scanning of one Claude skill or command root into registry candidates, and
 * loading of a candidate's body on demand.
 *
 * @module @deepseek-ai/dsh-skill-claude/scan
 */

import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { SkillCandidate, SkillDefinition } from '@deepseek-ai/dsh-skill'
import { isMissing } from './fs-error.ts'
import { describeCommand, invocationPolicy, parseClaudeDocument, textField } from './frontmatter.ts'
import { commandIdentifier, qualifiedIdentifier, toSkillName } from './names.ts'
import type { ClaudeLocator, SkillRoot, Warn } from './types.ts'

/** A file to read plus the identifier its path implies. */
interface SourceFile {
  readonly path: string
  readonly identifier: string
}

/**
 * Scan one root into candidates.
 * @param root - directory and layout to scan.
 * @param providerName - registry provider name every candidate must carry.
 * @param warn - warning sink for unreadable or invalid entries.
 * @returns candidates in directory order; invalid entries are skipped.
 */
export async function scanRoot(root: SkillRoot, providerName: string, warn: Warn): Promise<SkillCandidate[]> {
  const files = root.kind === 'skills'
    ? await skillFiles(root.dir, warn)
    : await commandFiles(root.dir, root.dir, warn)
  const candidates: SkillCandidate[] = []
  for (const file of files) {
    const candidate = await toCandidate(root, file, providerName, warn)
    if (candidate !== undefined) candidates.push(candidate)
  }
  return candidates
}

/**
 * Load a candidate's body.
 * @param candidate - candidate previously returned by {@link scanRoot}.
 * @param warn - warning sink for an unreadable file.
 * @returns the definition with the body after the frontmatter, or `undefined` when the file is gone.
 */
export async function loadDefinition(candidate: SkillCandidate, warn: Warn): Promise<SkillDefinition | undefined> {
  const locator = candidate.locator as ClaudeLocator
  const raw = await readSource(locator.path, warn)
  if (raw === undefined) return undefined
  return {
    name: candidate.name,
    description: candidate.description,
    ...candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse },
    invocation: candidate.invocation,
    source: candidate.source,
    provider: candidate.provider,
    path: locator.path,
    resourceBase: { kind: 'directory', path: dirname(locator.path) },
    content: parseClaudeDocument(raw).body.trim(),
  }
}

async function listDirectory(dir: string, warn: Warn): Promise<Dirent[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.sort((left, right) => left.name.localeCompare(right.name))
  } catch (error) {
    if (!isMissing(error)) warn(dir, `${dir} skipped: ${String(error)}`)
    return []
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    // A dangling symbolic link or a removed entry is not a skill directory.
    return false
  }
}

async function skillFiles(dir: string, warn: Warn): Promise<SourceFile[]> {
  const files: SourceFile[] = []
  for (const entry of await listDirectory(dir, warn)) {
    const directory = join(dir, entry.name)
    if (await isDirectory(directory)) files.push({ path: join(directory, 'SKILL.md'), identifier: entry.name })
  }
  return files
}

async function commandFiles(dir: string, root: string, warn: Warn): Promise<SourceFile[]> {
  const files: SourceFile[] = []
  for (const entry of await listDirectory(dir, warn)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await commandFiles(path, root, warn))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push({ path, identifier: commandIdentifier(relative(root, path)) })
    }
  }
  return files
}

async function readSource(path: string, warn: Warn): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (!isMissing(error)) warn(path, `${path} skipped: ${String(error)}`)
    return undefined
  }
}

async function toCandidate(
  root: SkillRoot,
  file: SourceFile,
  providerName: string,
  warn: Warn,
): Promise<SkillCandidate | undefined> {
  const raw = await readSource(file.path, warn)
  if (raw === undefined) return undefined
  const { data, body } = parseClaudeDocument(raw)
  const declared = root.kind === 'skills' ? textField(data, 'name') : undefined
  const identifier = qualifiedIdentifier(root.plugin, declared ?? file.identifier)
  const name = toSkillName(identifier)
  if (name === undefined) {
    warn(file.path, `${file.path} skipped: "${identifier}" has no letters or digits to form a skill name`)
    return undefined
  }
  const description = (root.kind === 'skills' ? textField(data, 'description') : describeCommand(data, body))?.trim()
  if (description === undefined || description === '') {
    warn(file.path, `${file.path} skipped: no description`)
    return undefined
  }
  const whenToUse = textField(data, 'when_to_use') ?? textField(data, 'whenToUse')
  const locator: ClaudeLocator = { path: file.path }
  return {
    name,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    invocation: invocationPolicy(data),
    source: root.source,
    provider: providerName,
    rank: root.rank,
    path: file.path,
    resourceBase: { kind: 'directory', path: dirname(file.path) },
    locator,
  }
}
