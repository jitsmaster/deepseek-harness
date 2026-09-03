import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { scanSkillDirectories } from '../src/skill-scanner.ts'

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

  it('does not throw or require onWarn when it is omitted', () => {
    expect(() => scanSkillDirectories(PROJECT_CWD, HOME)).not.toThrow()
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
