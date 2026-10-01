import { describe, expect, it } from 'vitest'
import { isMissing } from '../src/fs-error.ts'

describe('isMissing', () => {
  it('is true for ENOENT and ENOTDIR', () => {
    expect(isMissing({ code: 'ENOENT' })).toBe(true)
    expect(isMissing({ code: 'ENOTDIR' })).toBe(true)
  })

  it('is false for other errors and non-objects', () => {
    expect(isMissing({ code: 'EACCES' })).toBe(false)
    expect(isMissing(new Error('plain'))).toBe(false)
    expect(isMissing(null)).toBe(false)
    expect(isMissing('ENOENT')).toBe(false)
  })
})
