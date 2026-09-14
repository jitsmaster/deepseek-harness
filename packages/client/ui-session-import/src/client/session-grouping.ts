/**
 * Splits and orders discovered Claude Code CLI sessions for
 * {@link ImportDialog}'s table: still-active sessions first, terminal ones
 * after, each newest-first.
 */

import type { DiscoveredSessionView } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Statuses (compared case-insensitively) treated as terminal.
 *
 * This is an explicit, intentional allowlist rather than a verified
 * enumeration: the exact status vocabulary emitted by
 * `claude agents --json --all` isn't documented anywhere in this codebase
 * (only `'done'`/`'working'` appear in real test fixtures), so any status not
 * in this set — including ones we haven't seen yet — falls back to
 * classifying the session as still running.
 */
const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'completed', 'failed', 'error', 'stopped'])

/** The two ordered session groups {@link groupAndSortSessions} produces. */
export interface GroupedSessions {
  /** Sessions whose status is not a recognized terminal status, newest first. */
  readonly running: readonly DiscoveredSessionView[]
  /** Sessions whose status is a recognized terminal status, newest first. */
  readonly done: readonly DiscoveredSessionView[]
}

/**
 * Groups discovered sessions into `running`/`done` by status, then sorts
 * each group by `startedAt` descending (most recent first). `startedAt` is
 * always a valid ISO-8601 UTC string, so lexicographic comparison suffices.
 * The input array is never mutated.
 * @param sessions - discovered sessions in any order.
 * @returns the two sorted groups.
 */
export function groupAndSortSessions(sessions: readonly DiscoveredSessionView[]): GroupedSessions {
  const running: DiscoveredSessionView[] = []
  const done: DiscoveredSessionView[] = []
  for (const session of sessions) {
    const bucket = TERMINAL_STATUSES.has(session.status.toLowerCase()) ? done : running
    bucket.push(session)
  }
  // Plain relational comparison rather than localeCompare: startedAt is
  // always a fixed-format ISO-8601 UTC string (see the doc comment above),
  // so locale-aware collation is unneeded overhead and ICU-dependent for no
  // benefit here.
  const byStartedAtDescending = (a: DiscoveredSessionView, b: DiscoveredSessionView): number =>
    a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0
  // .sort() mutates in place, which is safe here: `running`/`done` are
  // freshly-built local arrays never aliased elsewhere in this function, so
  // the caller's input array is untouched.
  running.sort(byStartedAtDescending)
  done.sort(byStartedAtDescending)
  return { running, done }
}
