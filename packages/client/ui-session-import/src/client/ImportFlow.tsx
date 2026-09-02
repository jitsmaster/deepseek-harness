/**
 * The import-flow occupant (package-internal; the `./client` surface exposes
 * only the Loader exports). Fills `sidebar.workspaces.importFlow`
 * (`@deepseek-ai/dsh-client-ui-workspace`): adapts the hole's owner
 * conversation onto {@link ImportDialog} — the owner's `open` gates mounting,
 * a successful import is `onImported`, and dismissal is `onClose`. Same-
 * package tests exercise it directly through this module.
 */
import type { ReactElement } from 'react'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the owner contract of the import-flow hole.
import type { ImportFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { ImportDialog, type ImportOperations } from './ImportDialog.tsx'
import type { SessionImportKey } from './locales.ts'

/** Injected face: the Host operations and copy this flow drives (bound in apply's closure). */
export interface ImportFlowInjected {
  /** The `claudeSessionImport` Remote operations this dialog drives. */
  operations: ImportOperations
  /** Localized dialog copy (this package's namespace). */
  t: (key: SessionImportKey) => string
}

/**
 * Flow occupant: renders nothing while the owner's `open` is false, otherwise
 * mounts {@link ImportDialog} bound to the injected operations and copy.
 * @param props - owner conversation plus the injected import face.
 * @returns the dialog element, or null while closed.
 */
export function ImportFlow(props: ImportFlowOwnerProps & ImportFlowInjected): ReactElement | null {
  if (!props.open) return null
  return (
    <ImportDialog
      operations={props.operations}
      onImported={(sessionId) => { props.onImported(brandString<SessionId>(sessionId)) }}
      onClose={props.onClose}
      t={props.t}
    />
  )
}
