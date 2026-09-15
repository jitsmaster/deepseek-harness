import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROJECT_MEMORY_FILE_MAX_BYTES,
  PROJECT_MEMORY_INDEX_MAX_BYTES,
  readProjectMemory,
} from '../src/project-memory.ts'
import { claudeCodeProjectDir } from '../src/transcript-path.ts'

const CWD = '/home/arnold/proj'

function memoryDirFor(homedir: string): string {
  return join(claudeCodeProjectDir(homedir, CWD), 'memory')
}

describe('readProjectMemory', () => {
  it('returns undefined when the project has no MEMORY.md at all', async () => {
    const homedir = mkdtempSync(join(tmpdir(), 'claude-session-import-memory-'))
    try {
      await expect(readProjectMemory(homedir, CWD)).resolves.toBeUndefined()
    } finally {
      rmSync(homedir, { recursive: true, force: true })
    }
  })

  it('renders MEMORY.md plus every local note it links, in appearance order', async () => {
    const homedir = mkdtempSync(join(tmpdir(), 'claude-session-import-memory-'))
    try {
      const memoryDir = memoryDirFor(homedir)
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(join(memoryDir, 'MEMORY.md'), [
        '# Memory Index',
        '- [First](first.md) — hook one',
        '- [Second](second.md) — hook two',
      ].join('\n'))
      writeFileSync(join(memoryDir, 'first.md'), 'first note content')
      writeFileSync(join(memoryDir, 'second.md'), 'second note content')

      const result = await readProjectMemory(homedir, CWD)
      expect(result).toBeDefined()
      const rendered = result ?? ''
      expect(rendered).toContain('Memory Index')
      expect(rendered).toContain('first note content')
      expect(rendered).toContain('second note content')
      expect(rendered.indexOf('first note content')).toBeLessThan(rendered.indexOf('second note content'))
    } finally {
      rmSync(homedir, { recursive: true, force: true })
    }
  })

  it('skips a linked note that does not exist on disk, without failing the whole read', async () => {
    const homedir = mkdtempSync(join(tmpdir(), 'claude-session-import-memory-'))
    try {
      const memoryDir = memoryDirFor(homedir)
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(join(memoryDir, 'MEMORY.md'), '- [Missing](missing.md) — never written')

      const result = await readProjectMemory(homedir, CWD)
      expect(result).toContain('Missing')
      expect(result).not.toContain('missing.md content')
    } finally {
      rmSync(homedir, { recursive: true, force: true })
    }
  })

  it('never follows a link that escapes the memory directory (path traversal)', async () => {
    const homedir = mkdtempSync(join(tmpdir(), 'claude-session-import-memory-'))
    try {
      const memoryDir = memoryDirFor(homedir)
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(join(homedir, 'secret.md'), 'top secret outside the memory dir')
      writeFileSync(join(memoryDir, 'MEMORY.md'), '- [Escape](../../secret.md) — should never be read')

      const result = await readProjectMemory(homedir, CWD)
      expect(result).not.toContain('top secret')
    } finally {
      rmSync(homedir, { recursive: true, force: true })
    }
  })

  it('never follows a URL-shaped link', async () => {
    const homedir = mkdtempSync(join(tmpdir(), 'claude-session-import-memory-'))
    try {
      const memoryDir = memoryDirFor(homedir)
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(join(memoryDir, 'MEMORY.md'), '- [External](https://example.com/notes.md) — not local')

      const result = await readProjectMemory(homedir, CWD) ?? ''
      expect(result).toContain('External')
      // The URL text is part of MEMORY.md's own rendered content (expected),
      // but the link must never be FOLLOWED — no second "### " section for it.
      expect(result.split('### ')).toHaveLength(2)
    } finally {
      rmSync(homedir, { recursive: true, force: true })
    }
  })

  it('refuses (returns undefined) a MEMORY.md over the index byte cap', async () => {
    const homedir = mkdtempSync(join(tmpdir(), 'claude-session-import-memory-'))
    try {
      const memoryDir = memoryDirFor(homedir)
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(join(memoryDir, 'MEMORY.md'), 'x'.repeat(PROJECT_MEMORY_INDEX_MAX_BYTES + 1))

      await expect(readProjectMemory(homedir, CWD)).resolves.toBeUndefined()
    } finally {
      rmSync(homedir, { recursive: true, force: true })
    }
  })

  it('skips (rather than truncates) a linked note over the per-file byte cap', async () => {
    const homedir = mkdtempSync(join(tmpdir(), 'claude-session-import-memory-'))
    try {
      const memoryDir = memoryDirFor(homedir)
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(join(memoryDir, 'MEMORY.md'), '- [Big](big.md) — oversized note')
      writeFileSync(join(memoryDir, 'big.md'), 'y'.repeat(PROJECT_MEMORY_FILE_MAX_BYTES + 1))

      const result = await readProjectMemory(homedir, CWD)
      expect(result).toContain('Big')
      expect(result).not.toContain('y'.repeat(100))
    } finally {
      rmSync(homedir, { recursive: true, force: true })
    }
  })

  it('stops adding further linked notes once the combined render would exceed the total byte cap', async () => {
    const homedir = mkdtempSync(join(tmpdir(), 'claude-session-import-memory-'))
    try {
      const memoryDir = memoryDirFor(homedir)
      mkdirSync(memoryDir, { recursive: true })
      // Each note sits right at the per-file cap (allowed on its own); enough
      // of them together comfortably exceed the total render budget, so the
      // last one must be dropped even though it never violates its own cap.
      const noteNames = ['note1.md', 'note2.md', 'note3.md', 'note4.md', 'note5.md', 'note6.md']
      writeFileSync(
        join(memoryDir, 'MEMORY.md'),
        noteNames.map((name, i) => `- [Note ${i}](${name}) — note ${i}`).join('\n'),
      )
      noteNames.forEach((name, i) => {
        writeFileSync(join(memoryDir, name), String.fromCharCode(97 + i).repeat(PROJECT_MEMORY_FILE_MAX_BYTES))
      })

      const result = await readProjectMemory(homedir, CWD) ?? ''
      expect(result).toContain('a'.repeat(100))
      expect(result).not.toContain('f'.repeat(100))
    } finally {
      rmSync(homedir, { recursive: true, force: true })
    }
  })
})
