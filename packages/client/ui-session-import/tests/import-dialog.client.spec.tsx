// @vitest-environment jsdom
/**
 * `toBeInTheDocument()` needs jest-dom, which is not wired into this repo's
 * Vitest setup (no other `packages/client/*` spec uses it) — presence checks
 * below use the repo's own convention instead: `getByText`/`getByRole` throw
 * until the element exists, so wrapping them in `waitFor` and asserting
 * `toBeTruthy()` waits for the same condition the plan's snippet intended.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ImportDialog } from '../src/client/ImportDialog.tsx'

afterEach(cleanup)

describe('ImportDialog', () => {
  it('lists discovered sessions and imports the selected one', async () => {
    const onImported = vi.fn()
    const operations = {
      list: vi.fn().mockResolvedValue({
        sessions: [{ id: 's1', name: 'my-task', cwd: '/tmp', status: 'done', startedAt: '2026-09-01T00:00:00Z' }],
      }),
      createFrom: vi.fn().mockResolvedValue({ sessionId: 'session-abc' }),
    }
    render(<ImportDialog operations={operations} onImported={onImported} onClose={() => {}} />)
    await waitFor(() => { expect(screen.getByText('my-task')).toBeTruthy() })
    fireEvent.click(screen.getByText('my-task'))
    fireEvent.click(screen.getByRole('button', { name: /import/i }))
    await waitFor(() => { expect(onImported).toHaveBeenCalledWith('session-abc') })
  })

  it('shows an empty-state message when no sessions are discovered', async () => {
    const operations = { list: vi.fn().mockResolvedValue({ sessions: [] }), createFrom: vi.fn() }
    render(<ImportDialog operations={operations} onImported={() => {}} onClose={() => {}} />)
    await waitFor(() => { expect(screen.getByText(/no Claude Code sessions found/i)).toBeTruthy() })
  })
})
