/**
 * Best-effort import of the operator's Claude Code CLI project memory
 * (`~/.claude/projects/<slug>/memory/MEMORY.md` and the notes it indexes)
 * alongside an imported transcript — see `createFrom` in `index.ts`. Memory
 * is written by the operator's own Claude Code sessions to carry durable,
 * project-scoped context (preferences, decisions, corrections) across
 * conversations; importing only the transcript would silently drop that
 * context even though it is exactly the kind of background the operator was
 * relying on when the original conversation happened.
 *
 * @module @deepseek-ai/dsh-claude-session-import/project-memory
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { claudeCodeProjectDir } from './transcript-path.ts'

/** MEMORY.md is meant to stay a compact index; capped like any other externally-sourced read. */
export const PROJECT_MEMORY_INDEX_MAX_BYTES = 200_000
/** Cap on any single note MEMORY.md links to. */
export const PROJECT_MEMORY_FILE_MAX_BYTES = 200_000
/** Cap on the combined rendered memory content across the index and every linked note it pulls in. */
export const PROJECT_MEMORY_TOTAL_MAX_BYTES = 1_000_000

const MEMORY_LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g

/** Read a file's UTF-8 content, refusing (returning `undefined` instead of throwing) when missing, unreadable, or over `maxBytes`. */
async function readCapped(path: string, maxBytes: number): Promise<string | undefined> {
  let size: number
  try {
    ;({ size } = await stat(path))
  } catch {
    return undefined
  }
  if (!Number.isFinite(size) || size > maxBytes) return undefined
  try {
    const stream = createReadStream(path, { encoding: 'utf8', end: maxBytes })
    const parts: string[] = []
    let bytes = 0
    for await (const chunk of stream as AsyncIterable<string>) {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > maxBytes) return undefined
      parts.push(chunk)
    }
    return parts.join('')
  } catch {
    return undefined
  }
}

/**
 * Local `.md` notes a MEMORY.md index links to, in appearance order and
 * deduplicated. Only relative, in-directory links are followed — a URL
 * (`http:`, etc.) or a link that resolves outside `memoryDir` (e.g. `../../secrets.md`)
 * is skipped rather than read.
 */
function linkedMemoryFiles(indexContent: string, memoryDir: string): string[] {
  const seen = new Set<string>()
  const files: string[] = []
  for (const match of indexContent.matchAll(MEMORY_LINK_RE)) {
    const href = match[1]
    if (href === undefined || !href.toLowerCase().endsWith('.md')) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) continue
    const resolved = resolve(memoryDir, href)
    if (resolved !== memoryDir && relative(memoryDir, resolved).startsWith('..')) continue
    if (seen.has(resolved)) continue
    seen.add(resolved)
    files.push(resolved)
  }
  return files
}

/**
 * Read the operator's Claude Code project memory for `cwd` — the MEMORY.md
 * index plus every local note it links, rendered as one labeled block.
 * @param homedir - the operator's home directory (`os.homedir()`).
 * @param cwd - the imported session's original working directory.
 * @returns the rendered memory block, or `undefined` when the project has no
 *   MEMORY.md (nothing to carry over).
 */
export async function readProjectMemory(homedir: string, cwd: string): Promise<string | undefined> {
  const memoryDir = join(claudeCodeProjectDir(homedir, cwd), 'memory')
  const indexPath = join(memoryDir, 'MEMORY.md')
  const index = await readCapped(indexPath, PROJECT_MEMORY_INDEX_MAX_BYTES)
  if (index === undefined) return undefined
  const indexSection = `### ${relative(homedir, indexPath)}\n\n${index}`
  const sections = [indexSection]
  let bytes = Buffer.byteLength(indexSection, 'utf8')
  for (const path of linkedMemoryFiles(index, memoryDir)) {
    const content = await readCapped(path, PROJECT_MEMORY_FILE_MAX_BYTES)
    if (content === undefined) continue
    const section = `### ${relative(homedir, path)}\n\n${content}`
    const sectionBytes = Buffer.byteLength(section, 'utf8')
    if (bytes + sectionBytes > PROJECT_MEMORY_TOTAL_MAX_BYTES) break
    sections.push(section)
    bytes += sectionBytes
  }
  return sections.join('\n\n')
}
