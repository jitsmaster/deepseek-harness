import { describe, expect, it } from 'vitest'
import { humanPromptHistory, recallPrompt, type PromptRecallState } from '../src/client/input/prompt-history.ts'

const userEntry = (kind: string, ...blocks: unknown[]) => ({
  type: 'event', event: { type: 'user/message', data: { source: { kind }, content: blocks } },
}) as never
const otherEntry = { type: 'event', event: { type: 'turn/start', data: {} } } as never

describe('humanPromptHistory', () => {
  it('keeps only direct human text prompts, oldest first', () => {
    const entries = [
      userEntry('user', { type: 'text', text: 'one' }),
      userEntry('runtime-context', { type: 'text', text: 'ctx' }),
      otherEntry,
      userEntry('user', { type: 'text', text: 'two' }, { type: 'image' }, { type: 'text', text: 'more' }),
      userEntry('user', { type: 'image' }),
    ]
    expect(humanPromptHistory(entries)).toEqual(['one', 'two\nmore'])
  })
})

const HISTORY = ['first', 'second', 'third'] as const
const idle: PromptRecallState = { index: null, draft: '' }

describe('recallPrompt', () => {
  it('ArrowUp on an empty composer loads the most recent prompt', () => {
    expect(recallPrompt(HISTORY, idle, 'up', '')).toEqual({ state: { index: 2, draft: '' }, text: 'third' })
  })

  it('each further ArrowUp steps to an older prompt and stops at the oldest', () => {
    let result = recallPrompt(HISTORY, idle, 'up', '')
    result = recallPrompt(HISTORY, result.state, 'up', 'third')
    expect(result.text).toBe('second')
    result = recallPrompt(HISTORY, result.state, 'up', 'second')
    expect(result.text).toBe('first')
    result = recallPrompt(HISTORY, result.state, 'up', 'first')
    expect(result.text).toBe('first')
    expect(result.state.index).toBe(0)
  })

  it('ArrowDown steps newer and the last step restores the draft', () => {
    const browsing: PromptRecallState = { index: 1, draft: 'my draft' }
    let result = recallPrompt(HISTORY, browsing, 'down', 'second')
    expect(result).toEqual({ state: { index: 2, draft: 'my draft' }, text: 'third' })
    result = recallPrompt(HISTORY, result.state, 'down', 'third')
    expect(result).toEqual({ state: { index: null, draft: '' }, text: 'my draft' })
  })

  it('does nothing when not browsing and the composer has text', () => {
    expect(recallPrompt(HISTORY, idle, 'up', 'typing')).toEqual({ state: idle, text: undefined })
  })

  it('does nothing for ArrowDown when not browsing, or with no history', () => {
    expect(recallPrompt(HISTORY, idle, 'down', '')).toEqual({ state: idle, text: undefined })
    expect(recallPrompt([], idle, 'up', '')).toEqual({ state: idle, text: undefined })
  })
})
