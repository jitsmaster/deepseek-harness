import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDefinition, scanRoot } from '../src/scan.ts'
import type { SkillRoot, Warn } from '../src/types.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-skill-claude-${name}-`))
  tempDirs.push(dir)
  return await realpath(dir)
}

function collector(): { warn: Warn; messages: string[] } {
  const messages: string[] = []
  return { warn: (_key, message) => { messages.push(message) }, messages }
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

function skillsRoot(dir: string, extra: Partial<SkillRoot> = {}): SkillRoot {
  return { kind: 'skills', dir, rank: 530, source: 'claude-user', ...extra }
}

function commandsRoot(dir: string, extra: Partial<SkillRoot> = {}): SkillRoot {
  return { kind: 'commands', dir, rank: 540, source: 'claude-user', ...extra }
}

describe('scanRoot skills', () => {
  it('builds candidates from SKILL.md bundles', async () => {
    const root = await tempDir('skills')
    await writeText(join(root, 'grill-me', 'SKILL.md'), '---\nname: grill-me\ndescription: A relentless interview.\nwhen_to_use: Before building.\ndisable-model-invocation: true\n---\n\nAsk questions.\n')
    const { warn, messages } = collector()

    const candidates = await scanRoot(skillsRoot(root), 'claude', warn)

    expect(candidates).toEqual([{
      name: 'grill-me',
      description: 'A relentless interview.',
      whenToUse: 'Before building.',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'claude-user',
      provider: 'claude',
      rank: 530,
      path: join(root, 'grill-me', 'SKILL.md'),
      resourceBase: { kind: 'directory', path: join(root, 'grill-me') },
      locator: { path: join(root, 'grill-me', 'SKILL.md') },
    }])
    expect(messages).toEqual([])
  })

  it('prefers the frontmatter name over the directory name and normalizes it', async () => {
    const root = await tempDir('skills-name')
    await writeText(join(root, 'Some_Dir', 'SKILL.md'), '---\nname: Real Name\ndescription: d\n---\nB')
    await writeText(join(root, 'Dir_Only', 'SKILL.md'), '---\ndescription: d\n---\nB')
    const { warn } = collector()

    const names = (await scanRoot(skillsRoot(root), 'claude', warn)).map(candidate => candidate.name)

    expect(names).toEqual(['dir-only', 'real-name'])
  })

  it('prefixes plugin skills with the plugin name', async () => {
    const root = await tempDir('plugin-skills')
    await writeText(join(root, 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\ndescription: d\n---\nB')
    const { warn } = collector()

    const candidates = await scanRoot(skillsRoot(root, { plugin: 'superpowers', rank: 550, source: 'claude-plugin' }), 'claude', warn)

    expect(candidates.map(candidate => candidate.name)).toEqual(['superpowers-brainstorming'])
  })

  it('skips directories without SKILL.md and plain files silently', async () => {
    const root = await tempDir('skills-quiet')
    await mkdir(join(root, 'synced'), { recursive: true })
    await writeText(join(root, 'note.txt'), 'x')
    const { warn, messages } = collector()

    expect(await scanRoot(skillsRoot(root), 'claude', warn)).toEqual([])
    expect(messages).toEqual([])
  })

  it('follows a symlinked skill directory and skips a dangling one', async () => {
    const root = await tempDir('skills-links')
    const target = await tempDir('skills-link-target')
    await writeText(join(target, 'SKILL.md'), '---\nname: linked\ndescription: d\n---\nB')
    await symlink(target, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(join(root, 'missing-target'), join(root, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
    const { warn } = collector()

    const names = (await scanRoot(skillsRoot(root), 'claude', warn)).map(candidate => candidate.name)

    expect(names).toEqual(['linked'])
  })

  it('skips a skill without a description or without a usable name, with a warning', async () => {
    const root = await tempDir('skills-invalid')
    await writeText(join(root, 'no-description', 'SKILL.md'), '---\nname: no-description\n---\nB')
    await writeText(join(root, 'punctuation', 'SKILL.md'), '---\nname: "!!!"\ndescription: d\n---\nB')
    const { warn, messages } = collector()

    expect(await scanRoot(skillsRoot(root), 'claude', warn)).toEqual([])
    expect(messages).toHaveLength(2)
    expect(messages.some(message => message.includes('no description'))).toBe(true)
    expect(messages.some(message => message.includes('has no letters or digits'))).toBe(true)
  })

  it('warns and skips a SKILL.md that cannot be read as a file', async () => {
    const root = await tempDir('skills-unreadable')
    await mkdir(join(root, 'broken', 'SKILL.md'), { recursive: true })
    const { warn, messages } = collector()

    expect(await scanRoot(skillsRoot(root), 'claude', warn)).toEqual([])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(join(root, 'broken', 'SKILL.md'))
  })

  it('keeps scanning the sibling skills after one entry is broken', async () => {
    const root = await tempDir('skills-mixed')
    await mkdir(join(root, 'a-broken', 'SKILL.md'), { recursive: true })
    await writeText(join(root, 'b-good', 'SKILL.md'), '---\nname: b-good\ndescription: d\n---\nB')
    const { warn, messages } = collector()

    const names = (await scanRoot(skillsRoot(root), 'claude', warn)).map(candidate => candidate.name)

    expect(names).toEqual(['b-good'])
    expect(messages).toHaveLength(1)
  })

  it('returns nothing, silently, for a missing root or a root that is a file', async () => {
    const root = await tempDir('skills-missing')
    await writeText(join(root, 'file-root'), 'x')
    const { warn, messages } = collector()

    expect(await scanRoot(skillsRoot(join(root, 'absent')), 'claude', warn)).toEqual([])
    expect(await scanRoot(skillsRoot(join(root, 'file-root')), 'claude', warn)).toEqual([])
    expect(messages).toEqual([])
  })
})

describe('scanRoot commands', () => {
  it('namespaces nested command files and describes them from their heading', async () => {
    const root = await tempDir('commands')
    await writeText(join(root, 'modes', 'sparc.md'), '# Boomerang Commander Mode\n\nYou are the commander.\n')
    await writeText(join(root, 'dream.md'), '---\ndescription: Force-invoke the dream skill.\n---\nInvoke it.\n')
    await writeText(join(root, 'modes', 'notes.txt'), 'ignored')
    const { warn } = collector()

    const candidates = await scanRoot(commandsRoot(root), 'claude', warn)

    expect(candidates.map(candidate => [candidate.name, candidate.description])).toEqual([
      ['dream', 'Force-invoke the dream skill.'],
      ['modes-sparc', 'Boomerang Commander Mode'],
    ])
    expect(candidates[1]?.resourceBase).toEqual({ kind: 'directory', path: join(root, 'modes') })
  })

  it('prefixes plugin commands and skips empty files with a warning', async () => {
    const root = await tempDir('plugin-commands')
    await writeText(join(root, 'review.md'), 'Review the diff.\n')
    await writeText(join(root, 'empty.md'), '\n\n')
    const { warn, messages } = collector()

    const candidates = await scanRoot(commandsRoot(root, { plugin: 'superpowers', rank: 560, source: 'claude-plugin' }), 'claude', warn)

    expect(candidates.map(candidate => candidate.name)).toEqual(['superpowers-review'])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('no description')
  })

  it('treats a whitespace-only heading as a missing description', async () => {
    const root = await tempDir('commands-blank-heading')
    await writeText(join(root, 'blank.md'), '#   \n')
    await writeText(join(root, 'real.md'), 'Do the real thing.\n')
    const { warn, messages } = collector()

    const candidates = await scanRoot(commandsRoot(root), 'claude', warn)

    expect(candidates.map(candidate => candidate.name)).toEqual(['real'])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(join(root, 'blank.md'))
    expect(messages[0]).toContain('no description')
  })

  it('trims the description taken from a heading or first line', async () => {
    const root = await tempDir('commands-trim')
    await writeText(join(root, 'padded.md'), '#  Padded Title  \n')
    const { warn } = collector()

    const candidates = await scanRoot(commandsRoot(root), 'claude', warn)

    expect(candidates.map(candidate => candidate.description)).toEqual(['Padded Title'])
  })

  it('does not descend into symlinked directories', async () => {
    const root = await tempDir('commands-loop')
    await writeText(join(root, 'a.md'), 'Command a.\n')
    await symlink(root, join(root, 'loop'), process.platform === 'win32' ? 'junction' : 'dir')
    const { warn } = collector()

    expect((await scanRoot(commandsRoot(root), 'claude', warn)).map(candidate => candidate.name)).toEqual(['a'])
  })

  it('scans a deep command tree without losing the sibling files', async () => {
    const root = await tempDir('commands-deep')
    const levels = Array.from({ length: 24 }, (_, index) => `d${index}`)
    await writeText(join(root, ...levels, 'leaf.md'), 'Deep leaf.\n')
    await writeText(join(root, 'top.md'), 'Top.\n')
    const { warn, messages } = collector()

    const names = (await scanRoot(commandsRoot(root), 'claude', warn)).map(candidate => candidate.name)

    expect(names).toEqual([[...levels, 'leaf'].join('-'), 'top'])
    expect(messages).toEqual([])
  })
})

describe('loadDefinition', () => {
  it('returns the trimmed body without frontmatter and the candidate metadata', async () => {
    const root = await tempDir('load')
    await writeText(join(root, 'grill-me', 'SKILL.md'), '---\nname: grill-me\ndescription: d\nwhen_to_use: now\n---\n\n  Body line.  \n\n')
    const { warn } = collector()
    const [candidate] = await scanRoot(skillsRoot(root), 'claude', warn)

    const definition = await loadDefinition(candidate as NonNullable<typeof candidate>, warn)

    expect(definition).toEqual({
      name: 'grill-me',
      description: 'd',
      whenToUse: 'now',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'claude-user',
      provider: 'claude',
      path: join(root, 'grill-me', 'SKILL.md'),
      resourceBase: { kind: 'directory', path: join(root, 'grill-me') },
      content: 'Body line.',
    })
  })

  it('omits whenToUse when the candidate has none and returns undefined when the file vanished', async () => {
    const root = await tempDir('load-gone')
    await writeText(join(root, 'a', 'SKILL.md'), '---\nname: a\ndescription: d\n---\nB')
    const { warn } = collector()
    const [candidate] = await scanRoot(skillsRoot(root), 'claude', warn)
    const live = await loadDefinition(candidate as NonNullable<typeof candidate>, warn)
    expect(live && 'whenToUse' in live).toBe(false)

    await rm(join(root, 'a'), { recursive: true, force: true })
    expect(await loadDefinition(candidate as NonNullable<typeof candidate>, warn)).toBeUndefined()
  })

  it('warns and returns undefined when the file is no longer readable as a file', async () => {
    const root = await tempDir('load-broken')
    await writeText(join(root, 'a', 'SKILL.md'), '---\nname: a\ndescription: d\n---\nB')
    const { warn, messages } = collector()
    const [candidate] = await scanRoot(skillsRoot(root), 'claude', warn)
    await rm(join(root, 'a', 'SKILL.md'))
    await mkdir(join(root, 'a', 'SKILL.md'))

    expect(await loadDefinition(candidate as NonNullable<typeof candidate>, warn)).toBeUndefined()
    expect(messages).toHaveLength(1)
  })
})
