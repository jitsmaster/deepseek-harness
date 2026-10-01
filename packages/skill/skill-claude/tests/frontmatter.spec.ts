import { describe, expect, it } from 'vitest'
import { describeCommand, invocationPolicy, parseClaudeDocument, textField } from '../src/frontmatter.ts'

describe('parseClaudeDocument', () => {
  it('parses strict YAML frontmatter and returns the body', () => {
    const document = parseClaudeDocument('---\nname: grill-me\ndescription: A relentless interview.\ndisable-model-invocation: true\n---\n\nBody text.\n')
    expect(document.data).toEqual({ name: 'grill-me', description: 'A relentless interview.', 'disable-model-invocation': true })
    expect(document.body).toBe('\nBody text.\n')
  })

  it('treats a file without frontmatter as all body', () => {
    expect(parseClaudeDocument('# Title\n\nText')).toEqual({ data: {}, body: '# Title\n\nText' })
  })

  it('ignores a leading byte order mark', () => {
    expect(parseClaudeDocument('﻿---\nname: a\n---\nB').data).toEqual({ name: 'a' })
  })

  it('falls back to line parsing when a value contains an unquoted colon', () => {
    const document = parseClaudeDocument('---\nname: ado-worktree-cleanup\ndescription: Remove worktrees: then empty the bin.\n---\nBody')
    expect(document.data).toEqual({ name: 'ado-worktree-cleanup', description: 'Remove worktrees: then empty the bin.' })
    expect(document.body).toBe('Body')
  })

  it('unquotes values in the fallback and ignores lines that are not fields', () => {
    const document = parseClaudeDocument([
      '---',
      'broken: a: b',
      'double: "quoted value"',
      "single: 'single value'",
      'open: "never closed',
      'lone: "',
      '  - not a field',
      '',
      '---',
      'Body',
    ].join('\n'))
    expect(document.data).toEqual({
      broken: 'a: b',
      double: 'quoted value',
      single: 'single value',
      open: '"never closed',
      lone: '"',
    })
  })

  it('treats a scalar or empty frontmatter block as no fields', () => {
    expect(parseClaudeDocument('---\njust a string\n---\nBody')).toEqual({ data: {}, body: 'Body' })
    expect(parseClaudeDocument('---\n---\nBody')).toEqual({ data: {}, body: 'Body' })
  })

  it('treats an unclosed frontmatter block as all body', () => {
    expect(parseClaudeDocument('---\nname: a\n').data).toEqual({})
  })
})

describe('textField', () => {
  it('returns trimmed non-empty strings only', () => {
    expect(textField({ k: '  x ' }, 'k')).toBe('x')
    expect(textField({ k: '   ' }, 'k')).toBeUndefined()
    expect(textField({ k: 3 }, 'k')).toBeUndefined()
    expect(textField({}, 'k')).toBeUndefined()
  })
})

describe('invocationPolicy', () => {
  it('permits both surfaces by default', () => {
    expect(invocationPolicy({})).toEqual({ modelInvocable: true, userInvocable: true })
  })

  it('honors boolean and string flags', () => {
    expect(invocationPolicy({ 'disable-model-invocation': true })).toEqual({ modelInvocable: false, userInvocable: true })
    expect(invocationPolicy({ 'user-invocable': false })).toEqual({ modelInvocable: true, userInvocable: false })
    expect(invocationPolicy({ 'disable-model-invocation': ' TRUE ', 'user-invocable': 'false' })).toEqual({ modelInvocable: false, userInvocable: false })
  })

  it('ignores unrecognized flag values', () => {
    expect(invocationPolicy({ 'disable-model-invocation': 'maybe', 'user-invocable': 1 })).toEqual({ modelInvocable: true, userInvocable: true })
  })
})

describe('describeCommand', () => {
  it('prefers the frontmatter description', () => {
    expect(describeCommand({ description: 'From frontmatter' }, '# Heading\nText')).toBe('From frontmatter')
  })

  it('falls back to the first Markdown heading at any level', () => {
    expect(describeCommand({}, 'Intro line\n\n### Boomerang Commander Mode: Orchestration  \nMore')).toBe('Boomerang Commander Mode: Orchestration')
  })

  it('falls back to the first non-empty line when there is no heading', () => {
    expect(describeCommand({ description: '   ' }, '\n\n  Do the thing.\nSecond')).toBe('Do the thing.')
  })

  it('returns undefined for an empty body', () => {
    expect(describeCommand({}, '\n  \n')).toBeUndefined()
  })
})
