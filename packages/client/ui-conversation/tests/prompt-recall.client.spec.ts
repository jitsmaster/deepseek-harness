/** ArrowUp / ArrowDown prompt recall through the session input shell. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { SessionInputShell } from '../src/client/input/facade.ts'

function shell(history: readonly string[] | undefined): SessionInputShell {
  return new SessionInputShell({
    actx: new Context(),
    defaultSink: vi.fn(),
    ...history === undefined ? {} : { promptHistory: () => history },
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' },
  })
}

const draftOf = (input: SessionInputShell): string => input.state.getSnapshot().draft

it('walks older prompts on ArrowUp and back to the empty draft on ArrowDown', () => {
  const input = shell(['first', 'second'])
  try {
    expect(input.recall('up')).toBe(true)
    expect(draftOf(input)).toBe('second')
    expect(input.recall('up')).toBe(true)
    expect(draftOf(input)).toBe('first')
    expect(input.recall('down')).toBe(true)
    expect(draftOf(input)).toBe('second')
    expect(input.recall('down')).toBe(true)
    expect(draftOf(input)).toBe('')
    expect(input.recall('down')).toBe(false)
  } finally { input.dispose() }
})

it('declines when the draft has user text and recall is not already browsing', () => {
  const input = shell(['old'])
  try {
    input.setDraft('typing')
    expect(input.recall('up')).toBe(false)
    expect(draftOf(input)).toBe('typing')
  } finally { input.dispose() }
})

it('stops browsing once the user edits the recalled text', () => {
  const input = shell(['old'])
  try {
    expect(input.recall('up')).toBe(true)
    input.setDraft('old edited')
    expect(input.recall('up')).toBe(false)
    expect(draftOf(input)).toBe('old edited')
  } finally { input.dispose() }
})

it('leaves ArrowUp to the caret while it is below the first line of a recalled prompt', () => {
  const input = shell(['line one\nline two'])
  try {
    expect(input.recall('up')).toBe(true)
    expect(input.recall('up')).toBe(false)
    expect(draftOf(input)).toBe('line one\nline two')
    expect(input.recall('down')).toBe(true)
    expect(draftOf(input)).toBe('')
  } finally { input.dispose() }
})

it('keeps browsing when the recalled prompt contains a character the draft strips', () => {
  const input = shell(['a\uFFFCb', 'plain'])
  try {
    expect(input.recall('up')).toBe(true)
    expect(input.recall('up')).toBe(true)
    expect(draftOf(input)).toBe('ab')
    expect(input.recall('down')).toBe(true)
    expect(draftOf(input)).toBe('plain')
  } finally { input.dispose() }
})

it('restarts browsing when the history changes underneath it', () => {
  const history = ['one']
  const input = new SessionInputShell({
    actx: new Context(), defaultSink: vi.fn(), promptHistory: () => history,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' },
  })
  try {
    expect(input.recall('up')).toBe(true)
    history.push('two')
    expect(input.recall('down')).toBe(false)
    expect(draftOf(input)).toBe('one')
  } finally { input.dispose() }
})

it('declines without history or without a history source', () => {
  const empty = shell([])
  const none = shell(undefined)
  try {
    expect(empty.recall('up')).toBe(false)
    expect(none.recall('up')).toBe(false)
  } finally { empty.dispose(); none.dispose() }
})
