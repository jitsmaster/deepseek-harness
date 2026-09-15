// Root-scoped, frame-wide status bar mirroring turns/steps/tok-per-sec and
// total-tokens/cache-hit% for whatever session is current. Coexists with the
// composer-scoped StatsPills row (which reads the CURRENT view's projection
// through useProjection): this bar instead reads the root `activeSessionStats`
// hook, so it stays visible while the composer scrolls out of view or another
// panel occupies 'main'. Fixed bottom-right via shell.overlay (see
// PersistentStatsBar.module.css); pointer-events opt back in per the overlay
// layer's click-through contract.

import { memo } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActiveSessionStatsSnapshot } from './active-session-stats.ts'
import { billedInputTokens, cacheHitPercent, formatDuration } from './StatsPills.tsx'
import { formatTokensPerSecond } from './message-chrome.ts'
import { formatTokens } from './token-format.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './PersistentStatsBar.module.css'

/**
 * Props: the framework-derived `shell.overlay` runtime share (which carries
 * the global `useActiveSessionStats` hook) composed with this bar's locale
 * seat — never hand-declared, per packages/client/AGENTS.md's slot/props rule.
 */
export type PersistentStatsBarProps = PropsRuntime<'shell.overlay'> & PropsLocale<'chat'>

/**
 * Time/steps readout: turn+step counts plus LLM duration and decode speed.
 * Absent (null) while the current window carries no steps.
 */
function TimeReadout({ stats, t }: {
  stats: NonNullable<ActiveSessionStatsSnapshot['stats']>
  t: ChatViewSlotProps['t']
}) {
  return (
    <span className={css.group}>
      <span>{t('stats.counts', { turns: stats.turns, steps: stats.steps })}</span>
      {stats.llmMs > 0 && (
        <>
          <span className={css.sep} aria-hidden>·</span>
          <span>{formatDuration(stats.llmMs, t)}</span>
        </>
      )}
      {stats.decodeMs > 0 && (
        <>
          <span className={css.sep} aria-hidden>·</span>
          <span>{t('message.tokensPerSecond', {
            tps: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
          })}</span>
        </>
      )}
    </span>
  )
}

/** Token-usage readout: billed total plus cache-hit share, when there is any. */
function UsageReadout({ usage, t }: {
  usage: NonNullable<ActiveSessionStatsSnapshot['usage']>
  t: ChatViewSlotProps['t']
}) {
  const total = billedInputTokens(usage) + usage.outputTokens
  const cacheHit = cacheHitPercent(usage)
  return (
    <span className={css.group}>
      <span>{t('message.turnUsage.count', { count: formatTokens(total, t) })}</span>
      {cacheHit !== null && (
        <>
          <span className={css.sep} aria-hidden>·</span>
          <span>{t('stats.cacheHit', { percent: cacheHit })}</span>
        </>
      )}
    </span>
  )
}

/**
 * Frame-wide bottom-right status bar. Renders null while no session is open,
 * or while the current `sessionStats`/`tokenUsage` projection faces report
 * neither steps nor billed tokens. Unlike StatsPills, this gate has no
 * `deriveStats(settledNodes)` fallback: root scope (where this bar runs) has
 * no `useChat` node-window access to fold, so on an assembly without
 * `sessionStats` wired up this bar stays empty even once steps exist,
 * whereas StatsPills would still show them via its fallback.
 */
export const PersistentStatsBar = memo(function PersistentStatsBar(
  { useActiveSessionStats, t }: PersistentStatsBarProps,
) {
  const { sessionId, stats, usage } = useActiveSessionStats(s => s)
  if (sessionId === undefined) return null
  const hasSteps = stats !== undefined && stats.steps > 0
  const hasTokens = usage !== undefined
    && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)
  if (!hasSteps && !hasTokens) return null
  return (
    <div className={css.root} data-persistent-stats>
      {hasSteps && <TimeReadout stats={stats} t={t} />}
      {hasTokens && <UsageReadout usage={usage} t={t} />}
    </div>
  )
})
