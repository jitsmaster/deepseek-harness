import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanCommandFiles } from '../src/skill-scanner.ts'

/** Collects warnings passed to `scanCommandFiles`'s `onWarn` callback. */
function collectWarnings(): { onWarn: (message: string) => void; messages: string[] } {
  const messages: string[] = []
  return { onWarn: message => messages.push(message), messages }
}

/** Writes one `.claude/commands/<fileName>` file under `<root>`. */
function writeCommandFile(root: string, fileName: string, content: string): void {
  const dir = join(root, '.claude', 'commands')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), content)
}

describe('scanCommandFiles', () => {
  it('derives the command name from the filename and reads description from optional frontmatter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'command-file-scanner-'))
    try {
      writeCommandFile(dir, 'grill-me.md', '---\ndescription: "Sharpen a plan."\n---\n\nInvoke the Skill tool. $ARGUMENTS\n')
      const commands = scanCommandFiles(dir, join(dir, 'nowhere-home'))
      const found = commands.find(command => command.name === 'grill-me')
      expect(found).toMatchObject({ kind: 'command', name: 'grill-me', description: 'Sharpen a plan.', tier: 'project' })
      expect(found?.body).toContain('$ARGUMENTS')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to a generic description and the whole file as body when frontmatter is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'command-file-scanner-nofm-'))
    try {
      writeCommandFile(dir, 'plain.md', 'Just do the thing. $ARGUMENTS\n')
      const commands = scanCommandFiles(dir, join(dir, 'nowhere-home'))
      const found = commands.find(command => command.name === 'plain')
      expect(found?.description).toContain('plain')
      expect(found?.body).toBe('Just do the thing. $ARGUMENTS')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips a file whose derived name does not match the command-name format, and warns why', () => {
    const dir = mkdtempSync(join(tmpdir(), 'command-file-scanner-badname-'))
    try {
      writeCommandFile(dir, 'My Command.md', 'Body.\n')
      const { onWarn, messages } = collectWarnings()
      const commands = scanCommandFiles(dir, join(dir, 'nowhere-home'), onWarn)
      expect(commands.some(command => command.name === 'My Command')).toBe(false)
      expect(messages.some(msg => /invalid name format/i.test(msg))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores a subdirectory under .claude/commands (namespaced commands are not yet supported)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'command-file-scanner-namespaced-'))
    try {
      mkdirSync(join(dir, '.claude', 'commands', 'modes'), { recursive: true })
      writeFileSync(join(dir, '.claude', 'commands', 'modes', 'sparc.md'), 'Body.\n')
      const commands = scanCommandFiles(dir, join(dir, 'nowhere-home'))
      expect(commands).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lets a project-level command file shadow a user-level one of the same name', () => {
    const project = mkdtempSync(join(tmpdir(), 'command-file-scanner-project-'))
    const home = mkdtempSync(join(tmpdir(), 'command-file-scanner-home-'))
    try {
      writeCommandFile(project, 'shared.md', '---\ndescription: "project version"\n---\n\nProject body.\n')
      writeCommandFile(home, 'shared.md', '---\ndescription: "user version"\n---\n\nUser body.\n')
      const commands = scanCommandFiles(project, home)
      const shared = commands.filter(command => command.name === 'shared')
      expect(shared).toHaveLength(1)
      expect(shared[0]?.description).toBe('project version')
    } finally {
      rmSync(project, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('skips project-level scanning entirely when cwd is undefined, but still surfaces user-level command files', () => {
    const home = mkdtempSync(join(tmpdir(), 'command-file-scanner-undefined-cwd-'))
    try {
      writeCommandFile(home, 'user-only.md', '---\ndescription: "user only"\n---\n\nBody.\n')
      const commands = scanCommandFiles(undefined, home)
      expect(commands.some(command => command.name === 'user-only')).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
