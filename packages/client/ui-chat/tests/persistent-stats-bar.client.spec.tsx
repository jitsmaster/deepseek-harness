// @vitest-environment jsdom
//
// Specifies `PersistentStatsBar` (and the `ActiveSessionStatsSnapshot` type
// it consumes from `../src/client/chat/active-session-stats.ts`), the
// root-scoped bottom-right status bar that mirrors turns/steps/tok-per-sec
// and total-tokens/cache-hit% for whatever session is current — it coexists
// with the composer-scoped StatsPills row and reuses StatsPills' exact
// formatting helpers (golden-string assertions against the real helper
// output). Covers:
// - renders null (no DOM output) when no session is open (sessionId undefined)
// - renders null when a session is open but neither stats nor usage carry anything to show
// - renders a time/steps readout (duration + tok/s) when stats.steps > 0
// - renders a token-usage readout (total tokens + cache hit) when usage has billed tokens
// - renders only the time readout when only stats is populated
// - renders only the usage readout when only usage is populated
// - carries a stable data-persistent-stats selector on its root when rendering non-null

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { billedInputTokens, cacheHitPercent, formatDuration } from '../src/client/chat/StatsPills.tsx'
import { formatTokensPerSecond } from '../src/client/chat/message-chrome.ts'
import { formatTokens } from '../src/client/chat/token-format.ts'
import { en } from '../src/client/locale.ts'
import {
  PersistentStatsBar, type PersistentStatsBarProps,
} from '../src/client/chat/PersistentStatsBar.tsx'
import type { ActiveSessionStatsSnapshot } from '../src/client/chat/active-session-stats.ts'

const t: PersistentStatsBarProps['t'] = makeTranslate(en, commonEn)

afterEach(() => { cleanup() })

const SID = 'session-1' as SessionId

/** A fixed WindowStats fixture: 3.8s LLM time and 20 tok/s over 60 decode tokens. */
const TIMED_STATS = {
  turns: 1, steps: 1, llmMs: 3_800, toolMs: 0, ttftMs: 800, ttftSteps: 1, decodeMs: 3_000, decodeTokens: 60,
}

/** A fixed TokenUsageProjection fixture: 105 total tokens, 90% cache hit. */
const USAGE = { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 90, cacheWriteTokens: 0 }

const EXPECTED_DURATION = formatDuration(TIMED_STATS.llmMs, t)
const EXPECTED_TPS = formatTokensPerSecond(TIMED_STATS.decodeTokens / (TIMED_STATS.decodeMs / 1_000))
const EXPECTED_TOTAL = formatTokens(billedInputTokens(USAGE) + USAGE.outputTokens, t)
const EXPECTED_CACHE_HIT = `${cacheHitPercent(USAGE)}%`

function makeSource(snapshot: ActiveSessionStatsSnapshot): HostObservable<ActiveSessionStatsSnapshot> {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  }
}

// Every fixture carries the rest of the global standard-kit seat this bar
// never reads, matching the stub convention other ui-chat test fixtures use.
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']
function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [], byId: {}, phase: 'ready', subagentsByParent: {}, jobsBySession: {},
  }))
}
function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }))
}
function noSessionStatus() {
  return bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map()))
}

function props(snapshot: ActiveSessionStatsSnapshot): PersistentStatsBarProps {
  return {
    useActiveSessionStats: bindSnapshotSelector(makeSource(snapshot)),
    usePanelInfo,
    useResource,
    useSessions: emptySessions(),
    useSessionStatus: noSessionStatus(),
    useSessionRetainInfo: () => undefined,
    useWorkspaces: emptyWorkspaces(),
    t,
  }
}

describe('PersistentStatsBar', () => {
  it('renders nothing when no session is open', () => {
    const view = render(<PersistentStatsBar {...props({ sessionId: undefined, stats: undefined, usage: undefined })} />)
    expect(view.container.textContent).toBe('')
    expect(view.container.querySelector('[data-persistent-stats]')).toBeNull()
  })

  it('renders nothing when the open session has no steps and no billed tokens', () => {
    const emptyUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const view = render(<PersistentStatsBar {...props({
      sessionId: SID,
      stats: { ...TIMED_STATS, steps: 0 },
      usage: emptyUsage,
    })} />)
    expect(view.container.textContent).toBe('')
    expect(view.container.querySelector('[data-persistent-stats]')).toBeNull()
  })

  it('renders nothing when stats is undefined and usage is undefined', () => {
    const view = render(<PersistentStatsBar {...props({ sessionId: SID, stats: undefined, usage: undefined })} />)
    expect(view.container.textContent).toBe('')
    expect(view.container.querySelector('[data-persistent-stats]')).toBeNull()
  })

  it('renders the time/steps readout and the token-usage readout together, carrying data-persistent-stats', () => {
    const view = render(<PersistentStatsBar {...props({ sessionId: SID, stats: TIMED_STATS, usage: USAGE })} />)
    const root = view.container.querySelector('[data-persistent-stats]')
    expect(root).toBeTruthy()
    expect(root!.textContent).toContain(EXPECTED_DURATION)
    expect(root!.textContent).toContain(EXPECTED_TPS)
    expect(root!.textContent).toContain(EXPECTED_TOTAL)
    expect(root!.textContent).toContain(EXPECTED_CACHE_HIT)
  })

  it('renders only the time readout when only stats is populated', () => {
    const view = render(<PersistentStatsBar {...props({ sessionId: SID, stats: TIMED_STATS, usage: undefined })} />)
    const root = view.container.querySelector('[data-persistent-stats]')
    expect(root).toBeTruthy()
    expect(root!.textContent).toContain(EXPECTED_DURATION)
    expect(root!.textContent).toContain(EXPECTED_TPS)
    // No usage readout: the token-total golden string must be absent.
    expect(root!.textContent).not.toContain(EXPECTED_TOTAL)
  })

  it('renders only the usage readout when only usage is populated', () => {
    const view = render(<PersistentStatsBar {...props({ sessionId: SID, stats: undefined, usage: USAGE })} />)
    const root = view.container.querySelector('[data-persistent-stats]')
    expect(root).toBeTruthy()
    expect(root!.textContent).toContain(EXPECTED_TOTAL)
    expect(root!.textContent).toContain(EXPECTED_CACHE_HIT)
    // No time readout: the duration golden string must be absent.
    expect(root!.textContent).not.toContain(EXPECTED_DURATION)
  })
})
