import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseClaudeCodeTranscript, renderImportedTranscript } from '../src/transcript.ts'

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
}

describe('parseClaudeCodeTranscript', () => {
  it('extracts plain user/assistant text turns in order', () => {
    const turns = parseClaudeCodeTranscript(fixture('plain-turns.jsonl'))
    expect(turns).toEqual([
      { role: 'user', text: 'What does this repo do?' },
      { role: 'assistant', text: 'It is a Cordis-based agent harness.' },
    ])
  })

  it('renders turns as one readable text block', () => {
    const rendered = renderImportedTranscript([
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello' },
    ])
    expect(rendered).toBe('**User:** Hi\n\n**Claude:** Hello')
  })

  it('renders tool_use/tool_result blocks as readable summaries', () => {
    const turns = parseClaudeCodeTranscript(fixture('tool-call.jsonl'))
    expect(turns).toEqual([
      { role: 'assistant', text: '(ran `bash` with {"command":"ls -la"})\n\n(tool result: file1\nfile2)' },
    ])
  })

  it('skips malformed lines instead of failing the whole parse', () => {
    const turns = parseClaudeCodeTranscript(fixture('malformed-block.jsonl'))
    expect(turns).toEqual([{ role: 'user', text: 'still readable' }])
  })
})
