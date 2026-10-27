/**
 * One sign-in attempt's dialog: drives `beginAuthorization()` for the lifetime of
 * the mount, relays its notices and prompts, and lets the human answer, decline,
 * or cancel. Closing it aborts the local attempt and issues a second, explicit
 * `cancelAuthorization()` call, since a request/response transport has no other
 * way to reach an already-running `begin()`. This is the Claude card's own copy
 * of the Models page dialog: a client package cannot import another plugin's UI.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AuthorizationNotice, AuthorizationOutcome, WireAuthorizationPrompt } from '@deepseek-ai/dsh-api-remotes/client'
import type { AuthorizationOperations } from './authorization-operations.ts'
import type { ClaudeAccountsLocaleKey } from './locales.ts'
import css from './ClaudeAccountsCard.module.css'

/** Credential key of the sign-in flow the Claude Code LLM plugin registers. */
export const CLAUDE_ACCOUNT_AUTH_KEY = 'llm-claude-code/claude-account'

/** One prompt currently awaiting an answer, paired with its correlation id. */
interface PendingPrompt {
  promptId: string
  prompt: WireAuthorizationPrompt
}

/** One answer or decline's failure, scoped to the prompt it addressed. */
interface PromptFailure {
  promptId: string
  message: string
}

/** Whether a flow-reported URL may become a link: only http(s), so a `javascript:` value stays inert text. */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//iu.test(url)
}

/** Props of {@link SignInDialog}. */
export interface SignInDialogProps {
  operations: AuthorizationOperations
  t: (key: ClaudeAccountsLocaleKey) => string
  /** Called once the attempt settles, or with `undefined` when dismissed before it does. */
  onClose: (outcome: AuthorizationOutcome | undefined) => void
}

/**
 * Drive one sign-in attempt for as long as this dialog is mounted.
 * @param props - the Host operations, copy, and close handler.
 * @returns the sign-in dialog.
 */
export function SignInDialog(props: SignInDialogProps): ReactNode {
  const { operations, t, onClose } = props
  const [notice, setNotice] = useState<AuthorizationNotice | undefined>(undefined)
  const [pending, setPending] = useState<PendingPrompt | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [busyPromptId, setBusyPromptId] = useState<string | undefined>(undefined)
  const [promptFailure, setPromptFailure] = useState<PromptFailure | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const controllerRef = useRef<AbortController | undefined>(undefined)
  // Mirrors the current prompt id for the async continuations below, which must compare against the prompt
  // current at resolution time, not at call time.
  const pendingIdRef = useRef<string | undefined>(undefined)
  useEffect(() => { pendingIdRef.current = pending?.promptId }, [pending])
  const unmountedRef = useRef(false)
  useEffect(() => () => { unmountedRef.current = true }, [])

  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    operations.beginAuthorization(CLAUDE_ACCOUNT_AUTH_KEY, undefined, controller.signal, {
      onNotice: setNotice,
      onPrompt: (promptId, prompt) => {
        setPending({ promptId, prompt })
        setDraft('')
      },
    }).then(
      (outcome) => { onClose(outcome) },
      (error: unknown) => {
        // A local cancel aborts the signal and lets onClose(undefined) speak for the dismissal.
        if (controller.signal.aborted) return
        setFailure(error instanceof Error ? error.message : String(error))
      },
    )
    return () => { controller.abort() }
    // Once per mount: the key addresses the one attempt this dialog was opened for.
  }, [])

  const cancel = (): void => {
    controllerRef.current?.abort()
    void operations.cancelAuthorization(CLAUDE_ACCOUNT_AUTH_KEY)
    onClose(undefined)
  }

  const settle = (send: (promptId: string) => Promise<string | undefined>, clearDraft: boolean): void => {
    if (pending === undefined) return
    const { promptId } = pending
    setBusyPromptId(promptId)
    setPromptFailure(undefined)
    void send(promptId).then((message) => {
      if (unmountedRef.current || pendingIdRef.current !== promptId) return
      setBusyPromptId(undefined)
      if (message !== undefined) { setPromptFailure({ promptId, message }); return }
      setPending(undefined)
      if (clearDraft) setDraft('')
    })
  }
  const answer = (value: string): void => {
    settle(promptId => operations.respondAuthorization(CLAUDE_ACCOUNT_AUTH_KEY, promptId, value), true)
  }
  const decline = (): void => {
    settle(promptId => operations.declineAuthorization(CLAUDE_ACCOUNT_AUTH_KEY, promptId), false)
  }

  const busy = pending !== undefined && busyPromptId === pending.promptId
  const promptMessage = pending !== undefined && promptFailure?.promptId === pending.promptId ? promptFailure.message : undefined
  const shownFailure = failure ?? promptMessage

  return (
    <Modal
      open
      onClose={cancel}
      title={t('authDialogTitle')}
      closeLabel={t('cancel')}
      footer={pending === undefined
        ? <button type="button" className={`${css['secondaryButton']} ${css['dialogButton']}`} onClick={cancel}>{t('cancel')}</button>
        : (
          <>
            <button type="button" className={`${css['secondaryButton']} ${css['dialogButton']}`} disabled={busy} onClick={decline}>
              {t('authDecline')}
            </button>
            {pending.prompt.kind === 'select'
              ? null
              : (
                <button type="button" className={css['primaryButton']} disabled={busy} onClick={() => { answer(draft) }}>
                  {t('authContinue')}
                </button>
              )}
          </>
        )}
    >
      <div className={css['dialogBody']}>
        {notice === undefined
          ? <p className={css['hint']}>{t('authSigningIn')}</p>
          : (
            <div className={css['options']}>
              <p className={css['dialogText']}>{notice.message}</p>
              {notice.url === undefined
                ? null
                : isHttpUrl(notice.url)
                  ? <a className={css['noticeLink']} href={notice.url} target="_blank" rel="noreferrer">{notice.url}</a>
                  : <span className={css['noticeLink']}>{notice.url}</span>}
              {notice.code === undefined ? null : <code className={css['noticeCode']}>{notice.code}</code>}
            </div>
          )}
        {pending === undefined
          ? null
          : pending.prompt.kind === 'select'
            ? (
              <div className={css['options']} role="group" aria-label={pending.prompt.message}>
                <p className={css['dialogText']}>{pending.prompt.message}</p>
                {pending.prompt.options.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    className={`${css['secondaryButton']} ${css['dialogButton']}`}
                    disabled={busy}
                    onClick={() => { answer(option.id) }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )
            : (
              <label className={css['field']}>
                <span className={css['fieldLabel']}>{pending.prompt.message}</span>
                <input
                  className={css['input']}
                  type={pending.prompt.kind === 'secret' ? 'password' : 'text'}
                  autoComplete="off"
                  value={draft}
                  placeholder={pending.prompt.placeholder}
                  disabled={busy}
                  autoFocus
                  onChange={(event) => { setDraft(event.target.value) }}
                />
              </label>
            )}
        {shownFailure === undefined ? null : <p className={css['error']} role="alert">{shownFailure}</p>}
      </div>
    </Modal>
  )
}
