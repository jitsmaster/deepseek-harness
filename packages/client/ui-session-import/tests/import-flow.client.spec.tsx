// @vitest-environment jsdom
/** ImportFlow occupant: gates ImportDialog behind the owner's `open`. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ImportFlow } from '../src/client/ImportFlow.tsx'

afterEach(cleanup)

describe('ImportFlow', () => {
  it('renders nothing while the owner keeps the hole closed', () => {
    const { container } = render(
      <ImportFlow
        open={false}
        onImported={() => {}}
        onClose={() => {}}
        operations={{ list: vi.fn(), createFrom: vi.fn() }}
        t={key => key}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('mounts the import dialog once the owner opens the hole', async () => {
    render(
      <ImportFlow
        open
        onImported={() => {}}
        onClose={() => {}}
        operations={{ list: vi.fn().mockResolvedValue({ sessions: [] }), createFrom: vi.fn() }}
        t={key => key}
      />,
    )
    await waitFor(() => { expect(screen.getByText('dialog.empty')).toBeTruthy() })
  })
})
