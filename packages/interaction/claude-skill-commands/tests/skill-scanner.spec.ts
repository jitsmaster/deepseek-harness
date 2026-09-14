import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMMAND_NAME } from '@deepseek-ai/dsh-commands'
import { SKILL_NAME_FORMAT, scanSkillDirectories } from '../src/skill-scanner.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const PROJECT_CWD = `${FIXTURES}project-root`
const HOME = `${FIXTURES}home`

/** Collects warnings passed to `scanSkillDirectories`'s `onWarn` callback. */
function collectWarnings(): { onWarn: (message: string) => void; messages: string[] } {
  const messages: string[] = []
  return { onWarn: message => messages.push(message), messages }
}

describe('scanSkillDirectories', () => {
  it('reads name/description from valid frontmatter', () => {
    const skills = scanSkillDirectories(PROJECT_CWD, HOME)
    const valid = skills.find(skill => skill.name === 'valid-skill')
    expect(valid).toMatchObject({ name: 'valid-skill', description: 'A valid test skill' })
    expect(valid?.body).toContain('# Valid Skill')
  })

  it('skips a SKILL.md with no frontmatter', () => {
    const skills = scanSkillDirectories(PROJECT_CWD, HOME)
    expect(skills.some(skill => skill.body.includes('no-frontmatter-marker'))).toBe(false)
  })

  it('reports a warning via onWarn when skipping SKILL.md with no frontmatter', () => {
    const { onWarn, messages } = collectWarnings()
    scanSkillDirectories(PROJECT_CWD, HOME, onWarn)
    expect(messages.some(msg => msg.includes('no frontmatter'))).toBe(true)
  })

  it('does not throw or require onWarn when it is omitted, and still returns the expected skills', () => {
    let skills: readonly ReturnType<typeof scanSkillDirectories>[number][] = []
    expect(() => { skills = scanSkillDirectories(PROJECT_CWD, HOME) }).not.toThrow()
    expect(skills.map(skill => skill.name).sort()).toEqual(
      ['shared-name', 'user-only', 'valid-skill', 'valid-skill-with-bom'].sort(),
    )
    expect(skills.find(skill => skill.name === 'valid-skill')).toMatchObject({
      name: 'valid-skill',
      description: 'A valid test skill',
      tier: 'project',
    })
  })

  it('lets a project-level skill shadow a user-level skill of the same name', () => {
    const skills = scanSkillDirectories(PROJECT_CWD, HOME)
    const shared = skills.filter(skill => skill.name === 'shared-name')
    expect(shared).toHaveLength(1)
    expect(shared[0]?.description).toBe('project version')
  })

  it('includes a user-only skill', () => {
    const skills = scanSkillDirectories(PROJECT_CWD, HOME)
    expect(skills.some(skill => skill.name === 'user-only')).toBe(true)
  })

  it('returns an empty list when neither directory exists', () => {
    expect(scanSkillDirectories(`${FIXTURES}nowhere`, `${FIXTURES}nowhere-either`)).toEqual([])
  })

  it('parses skill files with UTF-8 BOM prefix', () => {
    const skills = scanSkillDirectories(PROJECT_CWD, HOME)
    const bommed = skills.find(skill => skill.name === 'valid-skill-with-bom')
    expect(bommed).toMatchObject({ name: 'valid-skill-with-bom', description: 'Valid skill with BOM' })
    expect(bommed?.body).toContain('# Valid Skill with BOM')
  })

  it('skips project-level scanning entirely when cwd is undefined, but still surfaces user-level skills', () => {
    const skills = scanSkillDirectories(undefined, HOME)
    expect(skills.some(skill => skill.name === 'valid-skill')).toBe(false)
    expect(skills.some(skill => skill.name === 'user-only')).toBe(true)
    const shared = skills.filter(skill => skill.name === 'shared-name')
    expect(shared).toHaveLength(1)
    expect(shared[0]?.description).toBe('user version')
  })

  it('does not fall back to process.cwd() for project-level scanning when cwd is undefined', () => {
    // Point process.cwd() at a fixture directory that DOES have project
    // skills, so a `cwd ?? process.cwd()`-style fallback would surface them.
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(PROJECT_CWD)
    try {
      const skills = scanSkillDirectories(undefined, `${FIXTURES}nowhere-either`)
      expect(skills.some(skill => skill.name === 'valid-skill')).toBe(false)
    } finally {
      cwdSpy.mockRestore()
    }
  })
})

/** Writes one skill folder's SKILL.md under `<skillsRoot>/.claude/skills/<folderName>/SKILL.md`. */
function writeSkillFile(skillsRoot: string, folderName: string, content: string): void {
  const skillDir = join(skillsRoot, '.claude', 'skills', folderName)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), content)
}

const NO_USER_SKILLS = `${FIXTURES}nowhere-either`

describe('scanSkillDirectories — oversized SKILL.md files', () => {
  it('skips a SKILL.md file that exceeds the size cap and reports why via onWarn, without reading it fully into memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-scanner-oversized-'))
    try {
      // Several megabytes — unambiguously beyond any plausible legitimate
      // skill file, and far past any reasonable cap the implementation picks.
      writeSkillFile(dir, 'huge-skill', 'x'.repeat(5_000_000))
      const { onWarn, messages } = collectWarnings()

      const skills = scanSkillDirectories(dir, NO_USER_SKILLS, onWarn)

      expect(skills.some(skill => skill.name === 'huge-skill')).toBe(false)
      expect(messages.some(msg => /too large/i.test(msg) || /\d[\d,_]*\s*bytes?/i.test(msg))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still enforces the size cap during the read itself when the file grows past the cap AFTER statSync but BEFORE the read completes (closes the TOCTOU gap)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-scanner-toctou-'))
    try {
      // Start under the cap so the up-front `statSync` check passes...
      writeSkillFile(dir, 'grown-skill', '---\nname: grown-skill\ndescription: starts small\n---\n\nBody.\n')
      const skillPath = join(dir, '.claude', 'skills', 'grown-skill', 'SKILL.md')
      const { onWarn, messages } = collectWarnings()

      // ...then grow it past the cap in the exact window between the stat
      // check and the read, simulating a concurrent writer (or an
      // attacker-controlled repo file appended to after the check). The old
      // stat-then-`readFileSync` implementation trusts the earlier stat and
      // reads the full oversized file into memory anyway; a real
      // capped-streaming read must notice the overflow WHILE reading and
      // abort, regardless of what the up-front stat reported.
      const skills = scanSkillDirectories(dir, NO_USER_SKILLS, onWarn, {
        afterStat: (path) => {
          if (path === skillPath) writeFileSync(path, 'x'.repeat(5_000_000))
        },
      })

      expect(skills.some(skill => skill.name === 'grown-skill')).toBe(false)
      expect(messages.some(msg => /too large|exceed/i.test(msg))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still parses a normal-sized SKILL.md well under the cap (regression guard)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-scanner-normal-'))
    try {
      writeSkillFile(
        dir,
        'normal-skill',
        '---\nname: normal-skill\ndescription: A normal sized skill\n---\n\nBody text.\n',
      )

      const skills = scanSkillDirectories(dir, NO_USER_SKILLS)

      const found = skills.find(skill => skill.name === 'normal-skill')
      expect(found).toMatchObject({ name: 'normal-skill', description: 'A normal sized skill' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('scanSkillDirectories — same-tier name collisions', () => {
  it('warns and keeps exactly one entry when two project-level skills declare the same name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-scanner-collision-'))
    try {
      writeSkillFile(dir, 'skill-a', '---\nname: dupe-name\ndescription: from skill-a\n---\n\nBody A.\n')
      writeSkillFile(dir, 'skill-b', '---\nname: dupe-name\ndescription: from skill-b\n---\n\nBody B.\n')
      const { onWarn, messages } = collectWarnings()

      const skills = scanSkillDirectories(dir, NO_USER_SKILLS, onWarn)

      const dupes = skills.filter(skill => skill.name === 'dupe-name')
      expect(dupes).toHaveLength(1)
      expect(messages.some(msg => msg.includes('dupe-name') && /(duplicate|collision|same name)/i.test(msg))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the first-found (readdirSync order) entry and warns with the literal "duplicate name" reason for the later one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-scanner-collision-order-'))
    try {
      writeSkillFile(dir, 'skill-a', '---\nname: dupe-name\ndescription: from skill-a\n---\n\nBody A.\n')
      writeSkillFile(dir, 'skill-b', '---\nname: dupe-name\ndescription: from skill-b\n---\n\nBody B.\n')
      const { onWarn, messages } = collectWarnings()

      const skills = scanSkillDirectories(dir, NO_USER_SKILLS, onWarn)

      const dupes = skills.filter(skill => skill.name === 'dupe-name')
      expect(dupes).toHaveLength(1)
      // readdirSync returns entries in a deterministic (typically alphabetical
      // on the platforms this repo targets) order, so 'skill-a' is found
      // before 'skill-b' and wins.
      expect(dupes[0]?.description).toBe('from skill-a')
      expect(messages.some(msg => msg.includes('duplicate name'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Fix B: a SKILL.md's frontmatter `name` must be validated against the
// command registry's required name format (`packages/interaction/commands`'s
// `COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u`) BEFORE it is ever handed back for
// registration — otherwise a human-readable name like "My Skill" (spaces,
// uppercase) reaches `commands.register()` and throws an uncaught
// `TypeError` inside `rescan()`'s synchronous call, deep in the
// `agent/pre-step` async waterfall handler.
describe('scanSkillDirectories — invalid skill name format', () => {
  it('skips a SKILL.md whose frontmatter name does not match the command-name format, and warns why', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-scanner-badname-'))
    try {
      writeSkillFile(dir, 'my-skill', '---\nname: My Skill\ndescription: Has a bad name\n---\n\nBody.\n')
      const { onWarn, messages } = collectWarnings()

      const skills = scanSkillDirectories(dir, NO_USER_SKILLS, onWarn)

      expect(skills.some(skill => skill.name === 'My Skill')).toBe(false)
      expect(messages.some(msg => /name/i.test(msg) && /(invalid|format|pattern)/i.test(msg))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still parses a normally-named skill (lowercase, hyphens) matching the command-name format (regression guard)', () => {
    const skills = scanSkillDirectories(PROJECT_CWD, HOME)
    const valid = skills.find(skill => skill.name === 'valid-skill')
    expect(valid).toMatchObject({ name: 'valid-skill', description: 'A valid test skill' })
  })

  it('skips a SKILL.md whose frontmatter name starts with a digit, and warns with the literal "invalid name format" reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-scanner-badname-digit-'))
    try {
      writeSkillFile(dir, 'digit-skill', '---\nname: 1skill\ndescription: Starts with a digit\n---\n\nBody.\n')
      const { onWarn, messages } = collectWarnings()

      const skills = scanSkillDirectories(dir, NO_USER_SKILLS, onWarn)

      expect(skills.some(skill => skill.name === '1skill')).toBe(false)
      expect(messages.some(msg => msg.includes('invalid name format'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Fix C: `ScannedSkill` gains a `tier` field so `registerSkillCommand` can
// tell a repo-authored (project) skill — whose body must be shown for
// confirmation before its first invocation — from an operator-trusted (user)
// one, which steers immediately as today.
// Fix 1: `SKILL_NAME_FORMAT` here is a deliberate copy of `COMMAND_NAME` from
// `packages/interaction/commands/src/index.ts` (to avoid a cross-package
// dependency for one regex), but nothing previously enforced that the two
// stay identical. This test fails the moment either pattern drifts from the
// other, instead of the drift silently reaching production (e.g. a skill
// name the scanner accepts that the command registry would then reject with
// an uncaught `TypeError` at registration time, or vice versa).
describe('SKILL_NAME_FORMAT stays in sync with the command registry\'s COMMAND_NAME', () => {
  it('has the exact same source and flags as COMMAND_NAME', () => {
    expect(SKILL_NAME_FORMAT.source).toBe(COMMAND_NAME.source)
    expect(SKILL_NAME_FORMAT.flags).toBe(COMMAND_NAME.flags)
  })

  it('accepts and rejects the same set of sample names as COMMAND_NAME', () => {
    const samples = [
      'valid-skill',
      'valid_skill',
      'a',
      'a1',
      '1skill',
      'My Skill',
      'UPPER',
      '',
      'has space',
      'trailing-',
      '-leading',
      'dots.not.allowed',
    ]
    for (const sample of samples) {
      expect(SKILL_NAME_FORMAT.test(sample)).toBe(COMMAND_NAME.test(sample))
    }
  })
})

describe('scanSkillDirectories — skill tier', () => {
  it('stamps tier "project" on a skill found in the project (cwd) directory', () => {
    const skills = scanSkillDirectories(PROJECT_CWD, HOME)
    const valid = skills.find(skill => skill.name === 'valid-skill')
    expect(valid).toMatchObject({ tier: 'project' })
  })

  it('stamps tier "user" on a skill found only in the home directory', () => {
    const skills = scanSkillDirectories(PROJECT_CWD, HOME)
    const userOnly = skills.find(skill => skill.name === 'user-only')
    expect(userOnly).toMatchObject({ tier: 'user' })
  })
})
