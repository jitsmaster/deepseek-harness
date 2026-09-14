/**
 * "Import from Claude Code" dialog: discovers the operator's Claude Code CLI
 * sessions on mount and lets them pick one to import into a brand-new native
 * DSH session. Modeled on `AuthorizationDialog.tsx`
 * (`@deepseek-ai/dsh-client-ui-settings-models`): a `Modal`, an effect that
 * drives one Host operation for the mount's lifetime behind an
 * `unmountedRef` guard, and a footer action.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DiscoveredSessionView } from '@deepseek-ai/dsh-api-remotes/client'
import { en, type SessionImportKey } from './locales.ts'
import { groupAndSortSessions } from './session-grouping.ts'
import styles from './ImportDialog.module.css'

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

  // Synchronous re-entrancy guard for importSelected(): `busy` (useState)
  // only takes effect on React's next commit, so two Import clicks/Enter
  // presses dispatched before that commit would both read busy === false
  // and both call operations.createFrom() — which is not idempotent (each
  // call mints a brand-new DSH session). A ref is written synchronously, so
  // the second call sees it immediately.
  const importInFlightRef = useRef(false)

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
    if (selectedId === undefined || importInFlightRef.current) return
    importInFlightRef.current = true
    setBusy(true)
    setFailure(undefined)
    const controller = new AbortController()
    operations.createFrom(selectedId, controller.signal).then(
      (result) => {
        importInFlightRef.current = false
        if (unmountedRef.current) return
        setBusy(false)
        onImported(result.sessionId)
      },
      (error: unknown) => {
        importInFlightRef.current = false
        if (unmountedRef.current) return
        setBusy(false)
        setFailure(error instanceof Error ? error.message : String(error))
      },
    )
  }

  // Hoisted out of the render ternary below (rather than an inline IIFE) to
  // match this codebase's established pattern for derived render values (see
  // AuthorizationDialog.tsx, DirectoryBrowser.tsx). Cheap to compute even
  // when unused, so it's unconditional; `sessions` may still be `undefined`
  // while discovery is in flight.
  //
  // Memoized on `sessions` alone (not recomputed for `selectedId`/`busy`/
  // `failure` changes): the bucketing pass plus two O(n log n) sorts has no
  // reason to rerun on renders the session list itself is uninvolved in.
  const { running, done } = useMemo(() => groupAndSortSessions(sessions ?? []), [sessions])

  const selectRow = (id: string): void => { setSelectedId(id) }
  const onRowKeyDown = (id: string) => (event: KeyboardEvent<HTMLTableRowElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    selectRow(id)
  }

  // Shared row markup for both the running and done sections below —
  // only which group/order a session renders in differs.
  const sessionRow = (session: DiscoveredSessionView): ReactNode => (
    <tr
      key={session.id}
      className={styles['row']}
      tabIndex={0}
      aria-selected={session.id === selectedId}
      onClick={() => { selectRow(session.id) }}
      onKeyDown={onRowKeyDown(session.id)}
    >
      <td className={styles['cellName']}>{session.name}</td>
      <td className={styles['cellCwd']} title={session.cwd}>{session.cwd}</td>
      <td className={styles['cellStatus']}>{session.status}</td>
    </tr>
  )

  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('dialog.close')}
      title={t('dialog.title')}
      className={styles['dialog'] ?? ''}
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
            <div className={styles['tableScroll']}>
              <table className={styles['table']} role="grid">
                {running.length > 0 && (
                  <tbody>
                    {/* A synthetic group-divider row, not a data row: `role="rowheader"`
                        would misrepresent this as labeling sibling data cells in the same
                        row (it doesn't have any), and `role="columnheader"` would wrongly
                        imply it labels a column. `role="gridcell"` inside a `role="row"`
                        keeps it a distinguishable, announced cell in the grid's
                        accessibility tree (unlike `role="presentation"`, which would strip
                        it entirely), with `aria-label` naming the section for screen
                        readers while the visible text serves sighted users. */}
                    <tr role="row">
                      <td colSpan={3} role="gridcell" aria-label={t('sections.running')} className={styles['sectionHeader']}>
                        {t('sections.running')}
                      </td>
                    </tr>
                    {running.map(sessionRow)}
                  </tbody>
                )}
                {done.length > 0 && (
                  <tbody>
                    <tr role="row">
                      <td colSpan={3} role="gridcell" aria-label={t('sections.done')} className={styles['sectionHeader']}>
                        {t('sections.done')}
                      </td>
                    </tr>
                    {done.map(sessionRow)}
                  </tbody>
                )}
              </table>
            </div>
          )}
      {failure !== undefined && <p role="alert">{failure}</p>}
    </Modal>
  )
}
