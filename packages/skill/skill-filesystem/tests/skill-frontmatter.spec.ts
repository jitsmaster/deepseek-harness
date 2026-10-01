import { describe, expect, it } from 'vitest'
import { splitSkillFrontmatter } from '../src/index.ts'

describe('splitSkillFrontmatter', () => {
  it('returns the unparsed YAML text and the body', () => {
    expect(splitSkillFrontmatter('---\nname: a\ndescription: b: c\n---\n\nBody.\n')).toEqual({
      yaml: 'name: a\ndescription: b: c\n',
      body: '\nBody.\n',
    })
  })

  it('accepts CRLF delimiters', () => {
    expect(splitSkillFrontmatter('---\r\nname: a\r\n---\r\nBody.\r\n')).toEqual({
      yaml: 'name: a\r\n',
      body: 'Body.\r\n',
    })
  })

  it('returns undefined when the first line is not a delimiter', () => {
    expect(splitSkillFrontmatter('# Title\n---\nx\n---\n')).toBeUndefined()
  })

  it('returns undefined for text without a newline', () => {
    expect(splitSkillFrontmatter('---')).toBeUndefined()
  })

  it('returns undefined when the closing delimiter is missing', () => {
    expect(splitSkillFrontmatter('---\nname: a\n')).toBeUndefined()
  })
})
