import { useEffect, useMemo, useRef, useState } from 'react'
import type { TrajectoryTranslate } from './locales.ts'
import {
  applyUsage, measureRequest, type ComposableRequestPayload, type ComposedCategoryId, type ComposedRequest,
  type ReportedUsage,
} from './request-composition.ts'
import css from './RequestBreakdown.module.css'

/** Reads one recorded request payload by sidecar blob name. */
export type ReadRequestPayload = (blob: string) => Promise<
  | { readonly ok: true; readonly value: ComposableRequestPayload | undefined }
  | { readonly ok: false }
>

export interface RequestBreakdownProps {
  /** Sidecar blob recorded for the request; absent means it was not captured. */
  readonly blob?: string
  /** Payload reader; absent hides the section. */
  readonly read?: ReadRequestPayload
  readonly usage?: ReportedUsage
  readonly t: TrajectoryTranslate
}

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ready'; readonly measured: ComposedRequest }

const LOADING: State = { kind: 'loading' }
/** Delay before a selected request's payload is read; a newer selection cancels it. */
const READ_DELAY_MS = 150

const CATEGORY_KEY = {
  preface: 'inspect.preface',
  system: 'inspect.system',
  tools: 'inspect.tools',
  transcript: 'inspect.transcript',
} as const satisfies Record<ComposedCategoryId, string>

function Categories({ measured, usage, t }: {
  measured: ComposedRequest
  usage: ReportedUsage | undefined
  t: TrajectoryTranslate
}) {
  // Memoize by value: callers build a fresh usage object on every render.
  const input = usage?.input
  const cacheRead = usage?.cacheRead
  const cacheWrite = usage?.cacheWrite
  const stableUsage = useMemo<ReportedUsage | undefined>(
    () => input === undefined ? undefined : { input, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 },
    [input, cacheRead, cacheWrite],
  )
  const composed = useMemo(() => applyUsage(measured, stableUsage), [measured, stableUsage])
  const size = (bytes: number, tokens: number | undefined): string => tokens === undefined
    ? t('inspect.bytes', { value: bytes })
    : t('inspect.tokens', { value: tokens })
  return (
    <>
      {composed.truncated === true && <p className={css.note}>{t('inspect.truncated')}</p>}
      <p className={css.total}>
        {t('inspect.total')}: {size(composed.totalBytes, composed.totalTokens)}
      </p>
      <dl className={css.list}>
        {composed.categories.filter(category => category.items.length > 0).map(category => (
          <div key={category.id} className={css.row}>
            <dt>{t(CATEGORY_KEY[category.id])}</dt>
            <dd>{size(category.bytes, category.tokens)}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

/**
 * Summary section showing how one request's input splits into transcript convention,
 * system prompt, tools and transcript. The payload is read when the section mounts.
 * @param props - recorded blob, payload reader, reported usage and translator.
 * @returns the section, or nothing when no reader is wired.
 */
export function RequestBreakdown({ blob, read, usage, t }: RequestBreakdownProps) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  // The reader's identity may change on every parent render; only the blob selects a read.
  const readRef = useRef(read)
  readRef.current = read
  const hasReader = read !== undefined
  useEffect(() => {
    const reader = readRef.current
    if (reader === undefined) return
    if (blob === undefined) {
      setState({ kind: 'missing' })
      return
    }
    let current = true
    setState(previous => previous.kind === 'loading' ? previous : LOADING)
    // Debounce so scrubbing through requests does not queue a read per selection.
    const timer = setTimeout(() => {
      reader(blob).then(
        (result) => {
          if (!current) return
          if (!result.ok || result.value === undefined) {
            setState({ kind: 'missing' })
            return
          }
          // Keep only the measured sizes so the multi-MB payload is released after this callback.
          try {
            setState({ kind: 'ready', measured: measureRequest(result.value) })
          } catch {
            setState({ kind: 'missing' })
          }
        },
        () => { if (current) setState({ kind: 'missing' }) },
      )
    }, READ_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [blob, hasReader])
  if (!hasReader) return null
  return (
    <section className={css.section}>
      <h4 className={css.heading}>{t('inspect.breakdown')}</h4>
      {state.kind === 'loading' && <p className={css.note}>{t('inspect.loading')}</p>}
      {state.kind === 'missing' && <p className={css.note}>{t('inspect.notCaptured')}</p>}
      {state.kind === 'ready' && <Categories measured={state.measured} usage={usage} t={t} />}
    </section>
  )
}
