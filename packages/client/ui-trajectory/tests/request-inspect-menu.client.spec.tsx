// @vitest-environment jsdom
/** Right-click "Inspect request" on an assistant row of the trajectory ledger. */
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TrajectoryTable } from '../src/client/TrajectoryTable.tsx'
import type { TrajectoryTurnModel } from '../src/client/layout.ts'
import { t } from './locale.client.ts'

afterEach(() => {
  cleanup()
})

const TURNS: readonly TrajectoryTurnModel[] = [{
  turn: 1,
  groups: [{
    title: 'Step 2',
    cells: [
      { index: 1, kind: 'user', sourceSeq: 3, text: 'hello', timeSeconds: 0 },
      { index: 2, kind: 'message', sourceSeq: 4, text: 'hi there', timeSeconds: 1 },
    ],
  }],
}]

const REQUESTS = [{ seq: 2, turn: 1, step: 2, group: 'Step 2', number: 1, payloadBlob: '2-2-1.json.gz' }]

function renderTable(onInspectRequest?: NonNullable<ComponentProps<typeof TrajectoryTable>['onInspectRequest']>) {
  return render(<TrajectoryTable
    turns={TURNS}
    requestNumbers={REQUESTS}
    renderSlot={() => null}
    loadImage={async () => 'blob:unused'}
    t={t}
    collapsedTurns={new Set()}
    onToggleTurn={() => {}}
    collapsedAssistants={new Set()}
    onToggleAssistant={() => {}}
    {...onInspectRequest === undefined ? {} : { onInspectRequest }}
  />)
}

describe('Inspect request row menu', () => {
  it('offers Inspect request on an assistant row and reports the request', () => {
    const onInspectRequest = vi.fn()
    renderTable(onInspectRequest)
    const row = screen.getByText('hi there').closest('tr') as HTMLElement
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Inspect request' }))
    expect(onInspectRequest).toHaveBeenCalledWith(expect.objectContaining({ turn: 1, step: 2, number: 1 }))
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('offers no menu on a user row', () => {
    renderTable(vi.fn())
    fireEvent.contextMenu(screen.getByText('hello').closest('tr') as HTMLElement)
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('offers no menu when no inspector is wired', () => {
    renderTable()
    fireEvent.contextMenu(screen.getByText('hi there').closest('tr') as HTMLElement)
    expect(screen.queryByRole('menuitem')).toBeNull()
  })
})
