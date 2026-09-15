// Root-scoped mirror of the current session's `sessionStats` and `tokenUsage`
// projection faces, so the persistent status bar (bottom-right, frame-wide)
// can read whole-log figures without a session-scoped slot — unlike
// StatsPills (composer-docked, session-scoped via useProjection), this source
// tracks whichever session is current and re-subscribes to its faces on every
// switch.

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: merges the `sessionStats` key into SessionProjectionMap and
// exposes SessionStatsProjection.
import type { SessionStatsProjection } from '@deepseek-ai/dsh-session-stats/client'
// Type-only: merges the `tokenUsage` key into SessionProjectionMap and
// exposes TokenUsageProjection.
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'

/** The current session's whole-log stats/usage figures, or their absence. */
export interface ActiveSessionStatsSnapshot {
  sessionId: SessionId | undefined
  stats: SessionStatsProjection | undefined
  usage: TokenUsageProjection | undefined
}

/** Memoization key/value pair: reused while none of its three refs changed. */
interface CachedSnapshot {
  sessionId: SessionId | undefined
  statsRef: SessionStatsProjection | undefined
  usageRef: TokenUsageProjection | undefined
  snapshot: ActiveSessionStatsSnapshot
}

/**
 * Read the current session id's `sessionStats`/`tokenUsage` face values.
 * A binding that cannot resolve yet (session listed but not yet scoped)
 * reports the id alone, with both figures undefined.
 * @param sessions - session service (binding resolution).
 * @param sessionId - the session list's current selection.
 * @returns the raw stats/usage pair for that session, unmemoized.
 */
function readCurrent(
  sessions: ISessions,
  sessionId: SessionId | undefined,
): Pick<ActiveSessionStatsSnapshot, 'stats' | 'usage'> {
  const binding = sessionId === undefined ? undefined : sessions.binding(sessionId)
  if (binding === undefined) return { stats: undefined, usage: undefined }
  // faceOf() is untyped at the projection-store boundary (key-addressed,
  // erased to `unknown`); the sessionStats/tokenUsage type merges above are
  // what makes this cast honest — the same contract StatsPills' useProjection
  // relies on for these two keys.
  const stats = binding.session.projections.faceOf('sessionStats')
    .getSnapshot() as SessionStatsProjection | undefined
  const usage = binding.session.projections.faceOf('tokenUsage')
    .getSnapshot() as TokenUsageProjection | undefined
  return { stats, usage }
}

/**
 * Root-scoped source mirroring the current session's `sessionStats` and
 * `tokenUsage` projection faces. Subscribing re-subscribes to the current
 * session's faces on every session-list change, tearing down the previous
 * session's face subscriptions first; getSnapshot() stays reference-stable
 * across calls while the (sessionId, statsRef, usageRef) triple is unchanged.
 * @param sessions - session service (binding resolution).
 * @param sessionList - root session-list source (current selection).
 * @returns memoized root observable consumed by the `activeSessionStats` root hook.
 */
export function createActiveSessionStatsSource(
  sessions: ISessions,
  sessionList: HostObservable<SessionListState>,
): HostObservable<ActiveSessionStatsSnapshot> {
  let cached: CachedSnapshot | undefined
  let faceDisposers: readonly (() => void)[] = []
  let subscribedSessionId: SessionId | undefined
  let offSessionList: (() => void) | undefined
  const listeners = new Set<() => void>()

  const getSnapshot = (): ActiveSessionStatsSnapshot => {
    // Pure read — no face-(un)subscription here. useSyncExternalStore may
    // call getSnapshot speculatively during a render that is later
    // interrupted/discarded (concurrent rendering); if that call subscribed
    // to a session's faces as a side effect, a discarded render that never
    // reaches subscribe() would leak that subscription forever (nothing else
    // ever tears it down). Re-checking binding resolution here is still
    // safe and desired — a binding that was unresolvable at switch time can
    // become resolvable later with no further session-list notify (another
    // consumer's `sessions.binding()` call can materialize it), so this
    // still re-resolves on every read to report current values — but it
    // must not itself subscribe/unsubscribe the projection faces. That
    // upkeep lives entirely in `syncFaceSubscriptions`, called only from
    // `subscribe()` and the shared session-list listener below, both of
    // which are commit-time hooks whose paired cleanup is guaranteed to run.
    const sessionId = sessionList.getSnapshot().current
    const { stats, usage } = readCurrent(sessions, sessionId)
    if (cached !== undefined
      && cached.sessionId === sessionId && cached.statsRef === stats && cached.usageRef === usage) {
      return cached.snapshot
    }
    const snapshot: ActiveSessionStatsSnapshot = { sessionId, stats, usage }
    cached = { sessionId, statsRef: stats, usageRef: usage, snapshot }
    return snapshot
  }

  const notify = (): void => { for (const listener of [...listeners]) listener() }

  const teardownFaces = (): void => {
    for (const dispose of faceDisposers) dispose()
    faceDisposers = []
    subscribedSessionId = undefined
  }

  /** (Re)subscribe to the current session's faces when the current id moved. */
  const syncFaceSubscriptions = (): void => {
    const sessionId = sessionList.getSnapshot().current
    if (sessionId === subscribedSessionId) return
    teardownFaces()
    if (sessionId === undefined) return
    const binding = sessions.binding(sessionId)
    if (binding === undefined) return
    subscribedSessionId = sessionId
    faceDisposers = [
      binding.session.projections.faceOf('sessionStats').subscribe(notify),
      binding.session.projections.faceOf('tokenUsage').subscribe(notify),
    ]
  }

  return {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      syncFaceSubscriptions()
      // One shared sessionList.subscribe() registration backs every consumer
      // of this source (set up once, on the first subscriber), rather than
      // one per subscribe() call: a per-consumer registration would fan a
      // single session-list change out to N callbacks, each broadcasting to
      // all N listeners via the shared notify() below — quadratic in
      // subscriber count. Mirrors syncFaceSubscriptions' dedupe-by-id guard.
      if (offSessionList === undefined) {
        offSessionList = sessionList.subscribe(() => {
          syncFaceSubscriptions()
          notify()
        })
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          teardownFaces()
          offSessionList?.()
          offSessionList = undefined
        }
      }
    },
  }
}
