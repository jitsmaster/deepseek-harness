import { useMemo, useState } from 'react'
import type { TrajectoryTranslate } from './locales.ts'
import {
  composeRequest, type ComposableRequestPayload, type ComposedCategoryId, type ReportedUsage,
} from './request-composition.ts'
import css from './RequestInspectorPanel.module.css'

/** What the panel has for the selected call. */
export type RequestInspectorState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ready'; readonly payload: ComposableRequestPayload }

export interface RequestInspectorPanelProps {
  readonly state: RequestInspectorState
  readonly usage?: ReportedUsage
  readonly model?: string
  readonly t: TrajectoryTranslate
  readonly onClose: () => void
}

const CATEGORY_KEY = {
  preface: 'inspect.preface',
  system: 'inspect.system',
  tools: 'inspect.tools',
  transcript: 'inspect.transcript',
} as const satisfies Record<ComposedCategoryId, string>

function Body({ payload, usage, t }: {
  payload: ComposableRequestPayload
  usage: ReportedUsage | undefined
  t: TrajectoryTranslate
}) {
  const composed = useMemo(() => composeRequest(payload, usage), [payload, usage])
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string): void => {
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }
  const size = (bytes: number, tokens: number | undefined): string => tokens === undefined
    ? t('inspect.bytes', { value: bytes })
    : t('inspect.tokens', { value: tokens })
  return (
    <>
      {composed.truncated === true && <p className={css.note}>{t('inspect.truncated')}</p>}
      <p className={css.total}>
        {t('inspect.total')}: {size(composed.totalBytes, composed.totalTokens)}
      </p>
      <ul className={css.list}>
        {composed.categories.filter(category => category.items.length > 0).map(category => (
          <li key={category.id}>
            <button type="button" className={css.row} aria-expanded={open.has(category.id)}
              onClick={() => { toggle(category.id) }}>
              <span>{t(CATEGORY_KEY[category.id])}</span>
              <span>{size(category.bytes, category.tokens)}</span>
            </button>
            {open.has(category.id) && (
              <ul className={css.items}>
                {category.items.map((entry, index) => {
                  const id = `${category.id}:${index}`
                  return (
                    <li key={id}>
                      <button type="button" className={css.row} aria-expanded={open.has(id)}
                        onClick={() => { toggle(id) }}>
                        <span>{entry.label}</span>
                        <span>{size(entry.bytes, entry.tokens)}</span>
                      </button>
                      {open.has(id) && <pre className={css.text}>{entry.text}</pre>}
                    </li>
                  )
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * Docked panel showing the exact request payload of one LLM call, by category and item.
 * @param props - panel state, reported usage, translator, and close handler.
 * @returns the panel.
 */
export function RequestInspectorPanel({ state, usage, model, t, onClose }: RequestInspectorPanelProps) {
  const payload = state.kind === 'ready' ? state.payload : undefined
  return (
    <aside className={css.panel} aria-label={t('inspect.title')}>
      <header className={css.header}>
        <h3>{t('inspect.title')}{model === undefined ? '' : ` · ${model}`}</h3>
        {payload !== undefined && (
          <button type="button" onClick={() => {
            navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).catch(() => undefined)
          }}>{t('inspect.copyJson')}</button>
        )}
        <button type="button" onClick={onClose}>{t('inspect.close')}</button>
      </header>
      {state.kind === 'loading' && <p className={css.note}>{t('inspect.loading')}</p>}
      {state.kind === 'missing' && <p className={css.note}>{t('inspect.notCaptured')}</p>}
      {payload !== undefined && (
        <Body payload={payload} usage={usage} t={t} />
      )}
    </aside>
  )
}
