/**
 * "Import from Claude Code" dialog: discovers the operator's Claude Code CLI
 * sessions on mount and lets them pick one to import into a brand-new native
 * DSH session. Modeled on `AuthorizationDialog.tsx`
 * (`@deepseek-ai/dsh-client-ui-settings-models`): a `Modal`, an effect that
 * drives one Host operation for the mount's lifetime behind an
 * `unmountedRef` guard, and a footer action.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { en, type SessionImportKey } from './locales.ts'

/** Wire view of one discovered Claude Code CLI session (`list()`'s rows). */
export interface DiscoveredSessionView {
  readonly id: string
  readonly name: string
  readonly cwd: string
  readonly status: string
  readonly startedAt: string
}

/** The two Host Remote calls this dialog drives. */
export interface ImportOperations {
  /** Discover the operator's Claude Code CLI sessions. */
  list: (signal: AbortSignal) => Promise<{ sessions: readonly DiscoveredSessionView[] }>
  /** Import one discovered session into a brand-new native DSH session. */
  createFrom: (sessionId: string, signal: AbortSignal) => Promise<{ sessionId: string }>
}

/** Props of {@link ImportDialog}. */
export interface ImportDialogProps {
  /** The Host operations this dialog is driven through. */
  operations: ImportOperations
  /** Called with the new DSH session id once `createFrom` resolves. */
  onImported: (sessionId: string) => void
  /** The operator dismissed the dialog before importing anything. */
  onClose: () => void
  /** Localized dialog copy; defaults to the English dictionary. */
  t?: (key: SessionImportKey) => string
}

const defaultTranslate = (key: SessionImportKey): string => en[key]

/**
 * Drive one `list()` call on mount and one `createFrom()` call per Import click.
 * @param props - operations, close/import handlers, and optional copy.
 * @returns the import dialog.
 */
export function ImportDialog(props: ImportDialogProps): ReactNode {
  const { operations, onImported, onClose } = props
  const t = props.t ?? defaultTranslate
  const [sessions, setSessions] = useState<readonly DiscoveredSessionView[] | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  // Tracks unmount for the list()/createFrom() continuations below, whose
  // resolution can arrive after the dialog is gone (the same hazard
  // AuthorizationDialog.tsx's own unmountedRef guards for its continuations).
  const unmountedRef = useRef(false)
  useEffect(() => () => { unmountedRef.current = true }, [])

  useEffect(() => {
    const controller = new AbortController()
    operations.list(controller.signal).then(
      (result) => {
        if (unmountedRef.current) return
        setSessions(result.sessions)
      },
      (error: unknown) => {
        if (unmountedRef.current || controller.signal.aborted) return
        setFailure(error instanceof Error ? error.message : String(error))
      },
    )
    return () => { controller.abort() }
    // Deliberately runs once per mount: this dialog instance owns exactly one
    // discovery call for its lifetime.
  }, [])

  const importSelected = (): void => {
    if (selectedId === undefined || busy) return
    setBusy(true)
    setFailure(undefined)
    const controller = new AbortController()
    operations.createFrom(selectedId, controller.signal).then(
      (result) => {
        if (unmountedRef.current) return
        setBusy(false)
        onImported(result.sessionId)
      },
      (error: unknown) => {
        if (unmountedRef.current) return
        setBusy(false)
        setFailure(error instanceof Error ? error.message : String(error))
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('dialog.close')}
      title={t('dialog.title')}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t('dialog.cancel')}</Button>
          <Button variant="primary" disabled={busy || selectedId === undefined} onClick={importSelected}>
            {t('dialog.import')}
          </Button>
        </>
      )}
    >
      {sessions === undefined
        ? <p>{t('dialog.loading')}</p>
        : sessions.length === 0
          ? <p>{t('dialog.empty')}</p>
          : (
            <ul>
              {sessions.map(session => (
                <li key={session.id}>
                  <button
                    type="button"
                    aria-pressed={session.id === selectedId}
                    onClick={() => { setSelectedId(session.id) }}
                  >
                    <span>{session.name}</span>
                    <span>{session.cwd}</span>
                    <span>{session.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
      {failure !== undefined && <p role="alert">{failure}</p>}
    </Modal>
  )
}
