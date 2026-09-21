// @vitest-environment jsdom
//
// Specifies `createActiveSessionStatsSource`, the root-scoped HostObservable
// that mirrors the current session's `sessionStats` and `tokenUsage`
// projection faces so a persistent status bar can read them without a
// session-scoped slot. Covers:
// - getSnapshot(): { sessionId: undefined, stats: undefined, usage: undefined } when no session is current
// - getSnapshot(): sessionId set, stats/usage undefined when the binding cannot resolve yet
// - getSnapshot(): reads the sessionStats/tokenUsage face snapshots once a binding exists
// - subscribe(): switching sessions unsubscribes the old faces and subscribes the new ones
// - subscribe(): either face notifying triggers the outer listener
// - getSnapshot(): reference-stable across repeated calls with no state change
// - getSnapshot(): re-checks a not-yet-resolvable binding on a later read, once it
//   resolves, without requiring another session-list change/notify event —
//   and does so as a pure read: it must not itself subscribe to the newly
//   resolvable session's faces (that stays a subscribe()/session-list-driven
//   side effect, never a getSnapshot() one — see the purity note below)
// - subscribe(): a single session-list change notifies each subscriber exactly
//   once, regardless of how many consumers have called subscribe() (no
//   per-consumer sessionList.subscribe() registration fan-out)
// - getSnapshot(): never subscribes/unsubscribes a projection face as a side
//   effect, even repeatedly, across a session switch — a store consumed via
//   useSyncExternalStore may be called speculatively during a discarded
//   render, and a subscription created there would never get torn down

import { describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createActiveSessionStatsSource } from '../src/client/chat/active-session-stats.ts'

const SID_A = 'session-a' as SessionId
const SID_B = 'session-b' as SessionId

/** A minimal fixture-like observable face with a spyable subscribe/unsubscribe. */
function makeFace<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  const subscribe = vi.fn((fn: () => void) => {
    listeners.add(fn)
    const off = vi.fn(() => { listeners.delete(fn) })
    return off
  })
  return {
    getSnapshot: () => value,
    subscribe,
    set(next: T) { value = next },
    notify() { for (const fn of [...listeners]) fn() },
    /** The unsubscribe function returned from the most recent subscribe() call. */
    lastOff(): ReturnType<typeof subscribe> {
      const result = subscribe.mock.results.at(-1)
      if (result === undefined) throw new Error('makeFace: subscribe was never called')
      return result.value as ReturnType<typeof subscribe>
    },
  }
}

/** A fake session binding exposing only what active-session-stats.ts reads. */
function makeBinding(sessionId: SessionId) {
  const statsFace = makeFace<unknown>(undefined)
  const usageFace = makeFace<unknown>(undefined)
  const faces: Record<string, ReturnType<typeof makeFace<unknown>>> = {
    sessionStats: statsFace,
    tokenUsage: usageFace,
  }
  const binding = {
    sessionId,
    session: {
      projections: {
        faceOf: (key: string) => faces[key] ?? makeFace(undefined),
      },
    },
  } as unknown as SessionBinding
  return { binding, statsFace, usageFace }
}

function makeSessionList(current: SessionId | undefined): {
  source: ObservableSnapshot<SessionId | undefined>
  set: (next: SessionId | undefined) => void
} {
  let state = current
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => state,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
    },
    set: (next) => {
      state = next
      for (const fn of [...listeners]) fn()
    },
  }
}

function makeSessions(bindings: Map<SessionId, SessionBinding>): ISessions {
  return {
    binding: (id: SessionId) => bindings.get(id),
  } as unknown as ISessions
}

describe('createActiveSessionStatsSource', () => {
  it('reports an empty snapshot when no session is current', () => {
    const { source: sessionList } = makeSessionList(undefined)
    const sessions = makeSessions(new Map())
    const active = createActiveSessionStatsSource(sessions, sessionList)

    expect(active.getSnapshot()).toEqual({ sessionId: undefined, stats: undefined, usage: undefined })
  })

  it('carries the current session id with undefined stats/usage when the binding is not yet resolvable', () => {
    const { source: sessionList } = makeSessionList(SID_A)
    const sessions = makeSessions(new Map())
    const active = createActiveSessionStatsSource(sessions, sessionList)

    expect(active.getSnapshot()).toEqual({ sessionId: SID_A, stats: undefined, usage: undefined })
  })

  it('reads the sessionStats and tokenUsage face snapshots once a binding exists', () => {
    const { source: sessionList } = makeSessionList(SID_A)
    const { binding, statsFace, usageFace } = makeBinding(SID_A)
    statsFace.set({ turns: 3, steps: 9 })
    usageFace.set({ outputTokens: 40 })
    const sessions = makeSessions(new Map([[SID_A, binding]]))
    const active = createActiveSessionStatsSource(sessions, sessionList)

    expect(active.getSnapshot()).toEqual({
      sessionId: SID_A,
      stats: { turns: 3, steps: 9 },
      usage: { outputTokens: 40 },
    })
  })

  it('tears down the previous session faces and subscribes the new ones on session switch', () => {
    const { source: sessionList, set: setCurrent } = makeSessionList(SID_A)
    const { binding: bindingA, statsFace: statsA, usageFace: usageA } = makeBinding(SID_A)
    const { binding: bindingB, statsFace: statsB, usageFace: usageB } = makeBinding(SID_B)
    const sessions = makeSessions(new Map([[SID_A, bindingA], [SID_B, bindingB]]))
    const active = createActiveSessionStatsSource(sessions, sessionList)

    const listener = vi.fn()
    const off = active.subscribe(listener)
    expect(statsA.subscribe).toHaveBeenCalledTimes(1)
    expect(usageA.subscribe).toHaveBeenCalledTimes(1)
    const offStatsA = statsA.lastOff()
    const offUsageA = usageA.lastOff()

    setCurrent(SID_B)

    expect(offStatsA).toHaveBeenCalledTimes(1)
    expect(offUsageA).toHaveBeenCalledTimes(1)
    expect(statsB.subscribe).toHaveBeenCalledTimes(1)
    expect(usageB.subscribe).toHaveBeenCalledTimes(1)

    off()
  })

  it('notifies the outer listener when either projection face notifies', () => {
    const { source: sessionList } = makeSessionList(SID_A)
    const { binding, statsFace, usageFace } = makeBinding(SID_A)
    const sessions = makeSessions(new Map([[SID_A, binding]]))
    const active = createActiveSessionStatsSource(sessions, sessionList)

    const listener = vi.fn()
    const off = active.subscribe(listener)

    statsFace.set({ turns: 1, steps: 1 })
    statsFace.notify()
    expect(listener).toHaveBeenCalledTimes(1)

    usageFace.set({ outputTokens: 5 })
    usageFace.notify()
    expect(listener).toHaveBeenCalledTimes(2)

    off()
  })

  it('returns a reference-stable snapshot across repeated calls with no state change', () => {
    const { source: sessionList } = makeSessionList(SID_A)
    const { binding, statsFace, usageFace } = makeBinding(SID_A)
    statsFace.set({ turns: 1, steps: 1 })
    usageFace.set({ outputTokens: 5 })
    const sessions = makeSessions(new Map([[SID_A, binding]]))
    const active = createActiveSessionStatsSource(sessions, sessionList)

    const first = active.getSnapshot()
    const second = active.getSnapshot()
    expect(first).toBe(second)
  })

  it('picks up a binding that becomes resolvable after the switch, on a later getSnapshot() call, without another session-list event', () => {
    const { source: sessionList, set: setCurrent } = makeSessionList(SID_A)
    const { binding: bindingA } = makeBinding(SID_A)
    const { binding: bindingB, statsFace: statsB, usageFace: usageB } = makeBinding(SID_B)
    statsB.set({ turns: 7, steps: 2 })
    usageB.set({ outputTokens: 99 })
    const bindings = new Map([[SID_A, bindingA]])
    const sessions = makeSessions(bindings)
    const active = createActiveSessionStatsSource(sessions, sessionList)

    const listener = vi.fn()
    const off = active.subscribe(listener)

    // Switch to SID_B while its binding is not yet resolvable: the session-list
    // event fires, but sessions.binding(SID_B) still returns undefined.
    setCurrent(SID_B)
    expect(active.getSnapshot()).toEqual({ sessionId: SID_B, stats: undefined, usage: undefined })
    expect(statsB.subscribe).not.toHaveBeenCalled()

    // The binding becomes resolvable later, with no further session-list event
    // (e.g. another consumer's own sessions.binding() call materialized it).
    bindings.set(SID_B, bindingB)

    // A later getSnapshot() call re-checks binding resolution and reports the
    // now-resolvable figures immediately — this is a pure read (fresh
    // sessions.binding()/face getSnapshot() lookups), so it does NOT itself
    // subscribe to the newly resolvable faces: a store read via
    // useSyncExternalStore can be called speculatively during a render that
    // never commits, and a subscription created there would never be torn
    // down. Subscription upkeep is deferred to the next legitimate
    // subscribe()/session-list-driven resync.
    expect(active.getSnapshot()).toEqual({
      sessionId: SID_B,
      stats: { turns: 7, steps: 2 },
      usage: { outputTokens: 99 },
    })
    expect(statsB.subscribe).not.toHaveBeenCalled()
    expect(usageB.subscribe).not.toHaveBeenCalled()

    // A subsequent session-list-driven resync (even a repeat of the same
    // current id) re-attempts the binding resolution that syncFaceSubscriptions
    // owns, and now succeeds — wiring up the faces for live notification.
    setCurrent(SID_B)
    expect(statsB.subscribe).toHaveBeenCalledTimes(1)
    expect(usageB.subscribe).toHaveBeenCalledTimes(1)

    // The newly wired subscription should also notify the outer listener.
    listener.mockClear()
    statsB.notify()
    expect(listener).toHaveBeenCalledTimes(1)

    off()
  })

  it('never subscribes to a projection face as a getSnapshot() side effect', () => {
    const { source: sessionList, set: setCurrent } = makeSessionList(SID_A)
    const { binding: bindingA, statsFace: statsA, usageFace: usageA } = makeBinding(SID_A)
    const { binding: bindingB, statsFace: statsB, usageFace: usageB } = makeBinding(SID_B)
    const sessions = makeSessions(new Map([[SID_A, bindingA], [SID_B, bindingB]]))
    const active = createActiveSessionStatsSource(sessions, sessionList)

    // No subscribe() call at all: only getSnapshot() reads, across a session
    // switch. Values must still be correct (pure re-resolution), but no face
    // subscription may be created — that side effect belongs to subscribe()
    // and the session-list-driven resync alone.
    expect(active.getSnapshot()).toEqual({ sessionId: SID_A, stats: undefined, usage: undefined })
    setCurrent(SID_B)
    expect(active.getSnapshot()).toEqual({ sessionId: SID_B, stats: undefined, usage: undefined })

    expect(statsA.subscribe).not.toHaveBeenCalled()
    expect(usageA.subscribe).not.toHaveBeenCalled()
    expect(statsB.subscribe).not.toHaveBeenCalled()
    expect(usageB.subscribe).not.toHaveBeenCalled()
  })

  it('notifies each subscriber exactly once for a single session-list change, with multiple subscribers', () => {
    const { source: sessionList, set: setCurrent } = makeSessionList(SID_A)
    const { binding: bindingA } = makeBinding(SID_A)
    const { binding: bindingB } = makeBinding(SID_B)
    const sessions = makeSessions(new Map([[SID_A, bindingA], [SID_B, bindingB]]))
    const active = createActiveSessionStatsSource(sessions, sessionList)

    const listener1 = vi.fn()
    const listener2 = vi.fn()
    const off1 = active.subscribe(listener1)
    const off2 = active.subscribe(listener2)

    setCurrent(SID_B)

    // One session-list change must produce exactly one notification per
    // subscriber, not one per (subscriber x registered sessionList listener)
    // pairing — a single shared sessionList.subscribe() registration should
    // back all consumers of this source, mirroring syncFaceSubscriptions'
    // dedupe-by-subscribedSessionId guard.
    expect(listener1).toHaveBeenCalledTimes(1)
    expect(listener2).toHaveBeenCalledTimes(1)

    off1()
    off2()
  })
})
