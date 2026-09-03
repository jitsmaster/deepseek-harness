import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { scanSkillDirectories } from '../src/skill-scanner.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const PROJECT_CWD = `${FIXTURES}project-root`
const HOME = `${FIXTURES}home`

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
})
