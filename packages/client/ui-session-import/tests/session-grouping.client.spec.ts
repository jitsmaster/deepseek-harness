import { describe, expect, it } from 'vitest'
import type { DiscoveredSessionView } from '@deepseek-ai/dsh-api-remotes/client'
import { groupAndSortSessions } from '../src/client/session-grouping.ts'

/** Minimal fixture: only `status` and `startedAt` matter to the function under test. */
function session(
  id: string,
  status: string,
  startedAt: string,
): DiscoveredSessionView {
  return { id, name: `name-${id}`, cwd: `/cwd/${id}`, status, startedAt }
}

describe('groupAndSortSessions', () => {
  it('returns empty running and done groups for empty input', () => {
    expect(groupAndSortSessions([])).toEqual({ running: [], done: [] })
  })

  it('puts every recognized terminal status into done, case-insensitively', () => {
    const sessions = [
      session('a', 'done', '2026-01-01T00:00:00Z'),
      session('b', 'CANCELLED', '2026-01-02T00:00:00Z'),
      session('c', 'Completed', '2026-01-03T00:00:00Z'),
      session('d', 'failed', '2026-01-04T00:00:00Z'),
      session('e', 'ERROR', '2026-01-05T00:00:00Z'),
      session('f', 'Stopped', '2026-01-06T00:00:00Z'),
    ]
    const result = groupAndSortSessions(sessions)
    expect(result.running).toEqual([])
    expect(result.done.map(s => s.id)).toEqual(['f', 'e', 'd', 'c', 'b', 'a'])
  })

  it('puts recognized and unrecognized non-terminal statuses into running', () => {
    const sessions = [
      session('a', 'working', '2026-01-01T00:00:00Z'),
      session('b', 'running', '2026-01-02T00:00:00Z'),
      session('c', 'idle', '2026-01-03T00:00:00Z'),
      session('d', 'some-future-status', '2026-01-04T00:00:00Z'),
    ]
    const result = groupAndSortSessions(sessions)
    expect(result.done).toEqual([])
    expect(result.running.map(s => s.id)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('splits a mixed list into running and done, each sorted by startedAt descending', () => {
    const sessions = [
      session('r-old', 'working', '2026-01-01T00:00:00Z'),
      session('f-old', 'done', '2026-01-02T00:00:00Z'),
      session('r-new', 'idle', '2026-01-05T00:00:00Z'),
      session('f-new', 'cancelled', '2026-01-06T00:00:00Z'),
      session('r-mid', 'running', '2026-01-03T00:00:00Z'),
      session('f-mid', 'error', '2026-01-04T00:00:00Z'),
    ]
    const result = groupAndSortSessions(sessions)
    expect(result.running.map(s => s.id)).toEqual(['r-new', 'r-mid', 'r-old'])
    expect(result.done.map(s => s.id)).toEqual(['f-new', 'f-mid', 'f-old'])
  })

  it('keeps the original relative order of sessions with an equal startedAt (stable sort)', () => {
    const sessions = [
      session('older', 'working', '2026-01-01T00:00:00Z'),
      session('tied-first', 'working', '2026-01-02T00:00:00Z'),
      session('tied-second', 'idle', '2026-01-02T00:00:00Z'),
    ]
    const result = groupAndSortSessions(sessions)
    expect(result.running.map(s => s.id)).toEqual(['tied-first', 'tied-second', 'older'])
  })

  it('does not mutate the input array', () => {
    const sessions = [
      session('a', 'done', '2026-01-01T00:00:00Z'),
      session('b', 'working', '2026-01-03T00:00:00Z'),
      session('c', 'cancelled', '2026-01-02T00:00:00Z'),
    ]
    const snapshot = JSON.parse(JSON.stringify(sessions)) as unknown
    groupAndSortSessions(sessions)
    expect(JSON.parse(JSON.stringify(sessions))).toEqual(snapshot)
  })
})
