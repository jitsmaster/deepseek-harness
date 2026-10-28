/**
 * The Claude Code accounts card on the Models page: one radio choice per email
 * (which account DSH runs Claude Code as), each with its plan usage, a sign-in
 * button, a make-default button, and a remove button, plus a field to add emails.
 */

import { useEffect, useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClaudeAccountUsageView, ClaudeAccountWindowView } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import { formatPercent, spanOf } from './accounts-model.ts'
import type { Span } from './accounts-model.ts'
import type { AuthorizationOperations } from './authorization-operations.ts'
import type { AccountRow, ClaudeAccountsController, ClaudeAccountsState } from './controller.ts'
import { fill } from './locales.ts'
import type { ClaudeAccountsLocaleKey } from './locales.ts'
import { SignInDialog } from './SignInDialog.tsx'
import css from './ClaudeAccountsCard.module.css'

/** Registration-side dependencies of {@link ClaudeAccountsCard}. */
export interface ClaudeAccountsFace {
  hooks: {
    /** Everything the card renders. */
    claudeAccounts: SnapshotStore<ClaudeAccountsState>
  }
  /** The card's actions. */
  controller: ClaudeAccountsController
  /** The Host operations a sign-in dialog is driven through. */
  authOperations: AuthorizationOperations
}

/** Footer-slot owner props plus this card's injected face. */
export type ClaudeAccountsCardProps =
  PropsRuntime<'settings.models.footer'> & PropsLocale<'settings.claudeAccounts'> & InjectFace<ClaudeAccountsFace>

type T = (key: ClaudeAccountsLocaleKey) => string

function spanText(t: T, span: Span): string {
  const key = { seconds: 'unitSeconds', minutes: 'unitMinutes', hours: 'unitHours', days: 'unitDays' } as const
  return fill(t(key[span.unit]), { n: String(span.count) })
}

/** One usage window: its name, a bar, and how much is used and when it resets. */
function WindowView(props: { t: T; name: string; window: ClaudeAccountWindowView | undefined; now: number }): ReactNode {
  const { t, name, window, now } = props
  if (window === undefined) {
    return (
      <div className={css['window']}>
        <span className={css['windowName']}>{name}</span>
        <span className={css['windowEmpty']}>{t('usageNone')}</span>
      </div>
    )
  }
  const percent = formatPercent(window.utilization)
  const untilReset = window.resetsAt * 1000 - now
  const text = untilReset <= 0
    ? fill(t('usageLineReset'), { percent })
    : fill(t('usageLine'), { percent, time: spanText(t, spanOf(untilReset)) })
  const high = window.utilization >= 0.8
  return (
    <div className={css['window']}>
      <span className={css['windowName']}>{name}</span>
      <div className={css['bar']} aria-hidden="true">
        <div className={`${css['barFill']} ${high ? css['barFillHigh'] : ''}`} style={{ width: percent }} />
      </div>
      <span className={css['windowText']}>{text}</span>
    </div>
  )
}

/** The usage block of one signed-in account, or the empty state while no reading exists. */
function UsageView(props: { t: T; usage: ClaudeAccountUsageView | undefined; now: number }): ReactNode {
  const { t, usage, now } = props
  if (usage === undefined) {
    return (
      <div className={css['window']}>
        <span className={css['windowEmpty']}>{t('usageNone')}</span>
        <span className={css['hint']}>{t('usageHint')}</span>
      </div>
    )
  }
  const age = now - usage.updatedAt
  return (
    <>
      <div className={css['usage']}>
        <WindowView t={t} name={t('usageSession')} window={usage.fiveHour} now={now} />
        <WindowView t={t} name={t('usageWeekly')} window={usage.sevenDay} now={now} />
      </div>
      <p className={css['updated']}>
        {age < 45_000 ? t('updatedNow') : fill(t('updatedAgo'), { time: spanText(t, spanOf(age)) })}
      </p>
    </>
  )
}

/**
 * Render the Claude Code accounts card; nothing renders until the Host reports the Claude Code plugin's settings.
 * @param props - footer-slot owner props, the card's injected face, and the locale seat.
 * @returns the card, or null while the plugin is not configured.
 */
export function ClaudeAccountsCard(props: ClaudeAccountsCardProps): ReactNode {
  const { controller, authOperations, t } = props
  const state = props.useClaudeAccounts(snapshot => snapshot)
  const [signingIn, setSigningIn] = useState(false)
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [signingOut, setSigningOut] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [addError, setAddError] = useState<'addInvalid' | 'addDuplicate' | undefined>(undefined)
  const ids = useId()

  useEffect(() => controller.start(), [controller])

  if (state.status !== 'ready') return null

  const locked = state.busy || !state.writable
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void controller.add(draft).then((error) => {
      setAddError(error)
      if (error === undefined) setDraft('')
    })
  }
  const confirmed = confirming
  const noticeText = state.notice === undefined ? undefined : fill(t(state.notice.key), state.notice.values)

  const renderRow = (row: AccountRow): ReactNode => (
    <div key={row.email} className={`${css['row']} ${row.active ? css['rowActive'] : ''}`}>
      <div className={css['rowHead']}>
        <label className={css['choice']} htmlFor={`${ids}-${row.email}`}>
          <input
            id={`${ids}-${row.email}`}
            className={css['radio']}
            type="radio"
            name={`${ids}-active`}
            checked={row.active}
            disabled={locked || !row.signedIn}
            onChange={() => { void controller.select(row.email) }}
          />
          <span className={css['email']}>{row.email}</span>
        </label>
        <span className={css['badges']}>
          {row.active ? <span className={css['badge']}>{t('badgeActive')}</span> : null}
          {row.leastUsed ? <span className={`${css['badge']} ${css['badgeBest']}`}>{t('badgeLeastUsed')}</span> : null}
          {row.isDefault ? <span className={css['badge']}>{t('badgeDefault')}</span> : null}
          {row.signedIn ? null : <span className={`${css['badge']} ${css['badgeWarn']}`}>{t('badgeNotSignedIn')}</span>}
        </span>
      </div>
      {row.signedIn ? <UsageView t={t} usage={row.usage} now={state.now} /> : null}
      <div className={css['actions']}>
        <button
          type="button"
          className={css['secondaryButton']}
          aria-label={fill(t(row.signedIn ? 'signInAgainFor' : 'signInFor'), { email: row.email })}
          disabled={state.busy}
          onClick={() => { setSigningIn(true) }}
        >
          {t(row.signedIn ? 'signInAgain' : 'signIn')}
        </button>
        {row.signedIn && !row.isDefault
          ? (
            <button
              type="button"
              className={css['secondaryButton']}
              aria-label={fill(t('makeDefaultFor'), { email: row.email })}
              disabled={state.busy}
              onClick={() => { setConfirming(row.email) }}
            >
              {t('makeDefault')}
            </button>
          )
          : null}
        {row.signedIn
          ? (
            <button
              type="button"
              className={css['dangerButton']}
              aria-label={fill(t('signOutFor'), { email: row.email })}
              disabled={state.busy}
              onClick={() => { setSigningOut(row.email) }}
            >
              {t('signOut')}
            </button>
          )
          : null}
        {row.listed
          ? (
            <button
              type="button"
              className={css['dangerButton']}
              aria-label={fill(t('removeFor'), { email: row.email })}
              disabled={locked}
              onClick={() => { void controller.remove(row.email) }}
            >
              {t('remove')}
            </button>
          )
          : null}
      </div>
    </div>
  )

  return (
    <section className={css['card']} aria-labelledby={`${ids}-title`}>
      <h3 className={css['title']} id={`${ids}-title`}>{t('title')}</h3>
      <p className={css['intro']}>{t('intro')}</p>
      {state.writable ? null : <p className={css['warn']}>{t('readOnly')}</p>}
      {state.loadFailed ? <p className={css['error']} role="alert">{t('loadFailed')}</p> : null}
      {state.rows.length === 0
        ? <p className={css['hint']}>{t('empty')}</p>
        : (
          <div className={css['group']} role="radiogroup" aria-label={t('groupLabel')}>
            {state.rows.map(renderRow)}
          </div>
        )}
      <form className={css['addForm']} onSubmit={submit} noValidate>
        <label className={css['field']} htmlFor={`${ids}-add`}>
          <span className={css['fieldLabel']}>{t('addLabel')}</span>
          <input
            id={`${ids}-add`}
            className={css['input']}
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder={t('addPlaceholder')}
            value={draft}
            disabled={locked}
            aria-invalid={addError !== undefined}
            aria-describedby={addError === undefined ? undefined : `${ids}-add-error`}
            onChange={(event) => { setDraft(event.target.value); setAddError(undefined) }}
          />
        </label>
        <button type="submit" className={css['secondaryButton']} disabled={locked || draft.trim().length === 0}>{t('add')}</button>
      </form>
      {addError === undefined ? null : <p className={css['error']} id={`${ids}-add-error`} role="alert">{t(addError)}</p>}
      {noticeText === undefined
        ? null
        : <p className={state.notice?.kind === 'error' ? css['error'] : css['success']} role={state.notice?.kind === 'error' ? 'alert' : 'status'}>{noticeText}</p>}
      {signingIn
        ? (
          <SignInDialog
            operations={authOperations}
            t={t}
            onClose={() => { setSigningIn(false); void controller.afterSignIn() }}
          />
        )
        : null}
      {signingOut === undefined
        ? null
        : (
          <Modal
            open
            onClose={() => { setSigningOut(undefined) }}
            title={fill(t('signOutTitle'), { email: signingOut })}
            closeLabel={t('cancel')}
            footer={(
              <>
                <button type="button" className={`${css['secondaryButton']} ${css['dialogButton']}`} onClick={() => { setSigningOut(undefined) }}>
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  className={css['primaryButton']}
                  onClick={() => { setSigningOut(undefined); void controller.signOut(signingOut) }}
                >
                  {t('signOutAction')}
                </button>
              </>
            )}
          >
            <p className={css['dialogText']}>{fill(t('signOutBody'), { email: signingOut })}</p>
          </Modal>
        )}
      {confirmed === undefined
        ? null
        : (
          <Modal
            open
            onClose={() => { setConfirming(undefined) }}
            title={fill(t('confirmTitle'), { email: confirmed })}
            closeLabel={t('cancel')}
            footer={(
              <>
                <button type="button" className={`${css['secondaryButton']} ${css['dialogButton']}`} onClick={() => { setConfirming(undefined) }}>
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  className={css['primaryButton']}
                  onClick={() => { setConfirming(undefined); void controller.makeDefault(confirmed) }}
                >
                  {t('confirmAction')}
                </button>
              </>
            )}
          >
            <p className={css['dialogText']}>{fill(t('confirmBody'), { email: confirmed })}</p>
          </Modal>
        )}
    </section>
  )
}
