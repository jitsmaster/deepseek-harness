import { describe, expect, it } from 'vitest'
import { commandIdentifier, qualifiedIdentifier, toSkillName } from '../src/names.ts'

describe('toSkillName', () => {
  it.each([
    ['obsidian-vault', 'obsidian-vault'],
    ['modes:sparc', 'modes-sparc'],
    ['superpowers:Brainstorming', 'superpowers-brainstorming'],
    ['Foo_Bar baz', 'foo-bar-baz'],
    ['--edge--', 'edge'],
    ['a:b-c', 'a-b-c'],
  ])('normalizes %s to %s', (identifier, expected) => {
    expect(toSkillName(identifier)).toBe(expected)
  })

  it('returns undefined when no letters or digits remain', () => {
    expect(toSkillName('::')).toBeUndefined()
    expect(toSkillName('')).toBeUndefined()
  })
})

describe('commandIdentifier', () => {
  it('joins path segments with a colon and drops the extension', () => {
    expect(commandIdentifier('modes/sparc.md')).toBe('modes:sparc')
    expect(commandIdentifier('a/b/c.md')).toBe('a:b:c')
    expect(commandIdentifier('plain.MD')).toBe('plain')
  })

  it('accepts Windows separators', () => {
    expect(commandIdentifier('modes\\sparc.md')).toBe('modes:sparc')
  })
})

describe('qualifiedIdentifier', () => {
  it('prefixes plugin identifiers with the plugin name', () => {
    expect(qualifiedIdentifier(undefined, 'grill-me')).toBe('grill-me')
    expect(qualifiedIdentifier('superpowers', 'brainstorming')).toBe('superpowers:brainstorming')
  })
})
