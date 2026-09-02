/**
 * One authorization attempt's dialog: drives `beginAuthorization()` for the
 * lifetime of the mount, relays its notices and prompts, and lets the human
 * answer, decline, or cancel. Unlike `OnboardingModal`'s first-run steps this
 * is dismissable mid-flow — closing it aborts the local attempt and issues a
 * second, explicit `cancelAuthorization()` call, since a request/response
 * transport has no other way to reach an already-in-flight `begin()`.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AuthorizationNotice, AuthorizationOutcome, WireAuthorizationPrompt,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { AuthorizationOperations } from './authorization-operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'
import dialogStyles from './AuthorizationDialog.module.css'

/** One prompt currently awaiting an answer, paired with its correlation id. */
interface PendingPrompt {
  promptId: string
  prompt: WireAuthorizationPrompt
}

/** One `answer()`/`decline()` call's outcome, kept scoped to the promptId it addressed. */
interface PromptFailure {
  promptId: string
  message: string
}

/**
 * A notice's `url` before it becomes a clickable link. The seam does not
 * constrain what a flow reports, so a non-http(s) scheme (or a value crafted
 * to look like one, e.g. `javascript:`) renders as plain text instead of an
 * anchor — the information is never dropped, only its clickability, since a
 * browser would otherwise navigate the tab on click.
 * @param url - candidate notice URL.
 * @returns whether it is safe to render as a clickable http(s) link.
 */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** Props of {@link AuthorizationDialog}. */
export interface AuthorizationDialogProps {
  /** Joined `<scope>/<id>` credential key this attempt authorizes. */
  authKey: string
  /** Method id to run. */
  method: string
  /** Human-facing name of what is being authorized. */
  label: string
  /** The Host operations this dialog is driven through. */
  operations: AuthorizationOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Called once the attempt settles, or `undefined` when dismissed before it does. */
  onClose: (outcome: AuthorizationOutcome | undefined) => void
}

/**
 * Drive one `beginAuthorization()` call for as long as this dialog is mounted.
 * @param props - the attempt's address, copy, and close handler.
 * @returns the sign-in dialog.
 */
export function AuthorizationDialog(props: AuthorizationDialogProps): ReactNode {
  const { authKey, method, label, operations, t, onClose } = props
  const [notice, setNotice] = useState<AuthorizationNotice | undefined>(undefined)
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | undefined>(undefined)
  const [answerDraft, setAnswerDraft] = useState('')
  // Keyed to the specific promptId each respond()/decline() call addressed,
  // never to "the dialog" as a whole: the seam's own documented race (a flow
  // racing a browser callback can abort the losing prompt, see
  // relayPrompt()'s own comment in authorization.ts) means a stale call can
  // resolve after the UI has already moved to a newer prompt. Applying its
  // busy/failure to whatever prompt happens to be showing then would land the
  // wrong prompt's result next to the wrong prompt.
  const [busyPromptId, setBusyPromptId] = useState<string | undefined>(undefined)
  const [promptFailure, setPromptFailure] = useState<PromptFailure | undefined>(undefined)
  // Attempt-level failure (the begin() call itself rejecting), unrelated to
  // any one prompt and so never promptId-scoped.
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const controllerRef = useRef<AbortController | undefined>(undefined)
  // Mirrors `pendingPrompt.promptId` for the async continuations in
  // answer()/decline() below, which close over the promptId their own call
  // addressed and must compare it against whatever prompt is current *at
  // resolution time* — a plain closure over `pendingPrompt` would only ever
  // see the value from when the call started.
  const pendingPromptIdRef = useRef<string | undefined>(undefined)
  useEffect(() => { pendingPromptIdRef.current = pendingPrompt?.promptId }, [pendingPrompt])
  // Tracks unmount for the answer()/decline() continuations below, whose
  // respondAuthorization()/declineAuthorization() calls can resolve after the
  // dialog is gone (Escape, backdrop, or the documented losing-race-against-a-
  // browser-callback scenario above) — the same hazard ProviderEditor.tsx's
  // own unmountedRef guards for its describeCredential/describeAuthorization
  // continuations.
  const unmountedRef = useRef(false)
  useEffect(() => () => { unmountedRef.current = true }, [])

  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    operations.beginAuthorization(authKey, method, controller.signal, {
      onNotice: setNotice,
      onPrompt: (promptId, prompt) => {
        setPendingPrompt({ promptId, prompt })
        setAnswerDraft('')
      },
    }).then(
      (outcome) => { onClose(outcome) },
      (error: unknown) => {
        // A local cancel() aborts the signal and lets onClose(undefined) speak
        // for the dismissal; this rejection is the resulting AbortError itself.
        if (controller.signal.aborted) return
        setFailure(error instanceof Error ? error.message : String(error))
      },
    )
    return () => { controller.abort() }
    // Deliberately runs once per mount: `authKey`/`method` address the one
    // attempt this dialog instance was opened for.
  }, [])

  const cancel = (): void => {
    controllerRef.current?.abort()
    void operations.cancelAuthorization(authKey)
    onClose(undefined)
  }

  const answer = (value: string): void => {
    if (pendingPrompt === undefined) return
    const { promptId } = pendingPrompt
    setBusyPromptId(promptId)
    setPromptFailure(undefined)
    void operations.respondAuthorization(authKey, promptId, value).then((message) => {
      // Stale-response guard: drop this result outright once a newer prompt
      // has superseded the one this call addressed, or once the dialog itself
      // has unmounted — otherwise these setters would fire on a gone component.
      if (unmountedRef.current || pendingPromptIdRef.current !== promptId) return
      setBusyPromptId(undefined)
      if (message !== undefined) { setPromptFailure({ promptId, message }); return }
      setPendingPrompt(undefined)
      setAnswerDraft('')
    })
  }

  const decline = (): void => {
    if (pendingPrompt === undefined) return
    const { promptId } = pendingPrompt
    setBusyPromptId(promptId)
    setPromptFailure(undefined)
    void operations.declineAuthorization(authKey, promptId).then((message) => {
      // Stale-response guard: drop this result outright once a newer prompt
      // has superseded the one this call addressed, or once the dialog itself
      // has unmounted — otherwise these setters would fire on a gone component.
      if (unmountedRef.current || pendingPromptIdRef.current !== promptId) return
      setBusyPromptId(undefined)
      if (message !== undefined) { setPromptFailure({ promptId, message }); return }
      setPendingPrompt(undefined)
    })
  }

  // Both busy state and this call's own failure are only ever shown next to
  // the prompt they addressed — a stale promptId's leftover state (from a
  // prompt this dialog has already moved past) never bleeds into the current one.
  const promptBusy = pendingPrompt !== undefined && busyPromptId === pendingPrompt.promptId
  const promptFailureMessage = pendingPrompt !== undefined && promptFailure?.promptId === pendingPrompt.promptId
    ? promptFailure.message
    : undefined
  const shownFailure = failure ?? promptFailureMessage

  return (
    <Modal
      open
      onClose={cancel}
      title={t('authDialogTitle').replace('{label}', label)}
      closeLabel={t('cancel')}
      footer={pendingPrompt === undefined
        ? (
          <button type="button" className={styles['secondaryButton']} onClick={cancel}>
            {t('cancel')}
          </button>
        )
        : (
          <>
            <button type="button" className={styles['secondaryButton']} disabled={promptBusy} onClick={decline}>
              {t('authDecline')}
            </button>
            {pendingPrompt.prompt.kind === 'select'
              ? null
              : (
                <button
                  type="button"
                  className={styles['primaryButton']}
                  disabled={promptBusy}
                  onClick={() => { answer(answerDraft) }}
                >
                  {t('authContinue')}
                </button>
              )}
          </>
        )}
    >
      <div className={dialogStyles['body']}>
        {notice === undefined
          ? <p className={styles['advancedHint']}>{t('authSigningIn')}</p>
          : (
            <div className={dialogStyles['notice']}>
              <p className={dialogStyles['noticeMessage']}>{notice.message}</p>
              {notice.url === undefined
                ? null
                // Security: a flow-reported URL is untrusted input. Only an
                // http(s) scheme becomes a clickable anchor — anything else
                // (e.g. `javascript:`) renders as inert text so the notice's
                // information still reaches the human without letting the
                // link itself execute or navigate somewhere unexpected.
                : isHttpUrl(notice.url)
                  ? (
                    <a className={dialogStyles['noticeLink']} href={notice.url} target="_blank" rel="noreferrer">
                      {notice.url}
                    </a>
                  )
                  : <span className={dialogStyles['noticeLink']}>{notice.url}</span>}
              {notice.code === undefined ? null : <code className={dialogStyles['noticeCode']}>{notice.code}</code>}
            </div>
          )}
        {pendingPrompt === undefined
          ? null
          : pendingPrompt.prompt.kind === 'select'
            ? (
              <div className={dialogStyles['options']}>
                {pendingPrompt.prompt.options.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    className={styles['secondaryButton']}
                    disabled={promptBusy}
                    onClick={() => { answer(option.id) }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )
            : (
              <div className={styles['field']}>
                <span className={styles['fieldLabel']}>{pendingPrompt.prompt.message}</span>
                <input
                  className={styles['input']}
                  type={pendingPrompt.prompt.kind === 'secret' ? 'password' : 'text'}
                  autoComplete="off"
                  value={answerDraft}
                  placeholder={pendingPrompt.prompt.placeholder}
                  disabled={promptBusy}
                  autoFocus
                  onChange={(event) => { setAnswerDraft(event.target.value) }}
                />
              </div>
            )}
        {shownFailure === undefined ? null : <p className={styles['error']}>{shownFailure}</p>}
      </div>
    </Modal>
  )
}
