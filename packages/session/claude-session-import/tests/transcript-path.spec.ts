import { describe, expect, it } from 'vitest'
import { claudeCodeProjectDir, claudeCodeTranscriptPath } from '../src/transcript-path.ts'

describe('claudeCodeProjectDir', () => {
  it('builds the project directory for a POSIX cwd', () => {
    expect(claudeCodeProjectDir('/home/arnold', '/home/arnold/dev/DSH'))
      .toBe('/home/arnold/.claude/projects/-home-arnold-dev-DSH')
  })

  it('builds the project directory for a Windows cwd', () => {
    expect(claudeCodeProjectDir('C:\\Users\\awang', 'D:\\dev\\DSH'))
      .toBe('C:\\Users\\awang\\.claude\\projects\\D--dev-DSH')
  })
})

describe('claudeCodeTranscriptPath', () => {
  it('builds the path for a POSIX cwd', () => {
    expect(claudeCodeTranscriptPath('/home/arnold', '/home/arnold/dev/DSH', 'abc123'))
      .toBe('/home/arnold/.claude/projects/-home-arnold-dev-DSH/abc123.jsonl')
  })

  it('builds the path for a Windows cwd', () => {
    expect(claudeCodeTranscriptPath('C:\\Users\\awang', 'D:\\dev\\DSH', 'abc123'))
      .toBe('C:\\Users\\awang\\.claude\\projects\\D--dev-DSH\\abc123.jsonl')
  })
})
