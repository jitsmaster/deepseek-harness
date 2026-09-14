// @vitest-environment jsdom
/**
 * `toBeInTheDocument()` needs jest-dom, which is not wired into this repo's
 * Vitest setup (no other `packages/client/*` spec uses it) — presence checks
 * below use the repo's own convention instead: `getByText`/`getByRole` throw
 * until the element exists, so wrapping them in `waitFor` and asserting
 * `toBeTruthy()` waits for the same condition the plan's snippet intended.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
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

  it('does not start a second import when Import is double-clicked before the busy state commits', async () => {
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
    const importButton = screen.getByRole('button', { name: /import/i })
    // Both clicks dispatched inside one `act()` batch, so the second handler
    // invocation runs before React commits the first `setBusy(true)` — this
    // is what a genuine fast real-world double-click/double-Enter can look
    // like. Neither must reach operations.createFrom twice, since each call
    // mints a brand-new DSH session server-side (not idempotent).
    act(() => {
      fireEvent.click(importButton)
      fireEvent.click(importButton)
    })
    await waitFor(() => { expect(onImported).toHaveBeenCalledWith('session-abc') })
    expect(operations.createFrom).toHaveBeenCalledTimes(1)
  })

  it('shows an empty-state message when no sessions are discovered', async () => {
    const operations = { list: vi.fn().mockResolvedValue({ sessions: [] }), createFrom: vi.fn() }
    render(<ImportDialog operations={operations} onImported={() => {}} onClose={() => {}} />)
    await waitFor(() => { expect(screen.getByText(/no Claude Code sessions found/i)).toBeTruthy() })
  })

  it('splits sessions into Running and Done sections by status', async () => {
    const operations = {
      list: vi.fn().mockResolvedValue({
        sessions: [
          { id: 's1', name: 'still-going', cwd: '/tmp', status: 'working', startedAt: '2026-09-01T00:00:00Z' },
          { id: 's2', name: 'wrapped-up', cwd: '/tmp', status: 'done', startedAt: '2026-09-02T00:00:00Z' },
        ],
      }),
      createFrom: vi.fn(),
    }
    render(<ImportDialog operations={operations} onImported={() => {}} onClose={() => {}} />)
    await waitFor(() => { expect(screen.getByText('still-going')).toBeTruthy() })
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByText('Finished')).toBeTruthy()
    expect(screen.getByText('wrapped-up')).toBeTruthy()

    // Presence alone would still pass if every session landed in the same
    // section (e.g. an inverted terminal-status check), so also confirm each
    // row sits under its own section's header — both by document order (the
    // "Running" header and its row must precede "Finished" and its
    // row) and by which <tbody> each row's cell actually belongs to. Modal
    // renders via a portal (see Modal.tsx's createPortal), so this walks
    // `document.body` rather than the `render()` container, which the
    // portaled content lands outside of.
    const text = document.body.textContent ?? ''
    const runningHeaderIndex = text.indexOf('Running')
    const stillGoingIndex = text.indexOf('still-going')
    const doneHeaderIndex = text.indexOf('Finished')
    const wrappedUpIndex = text.indexOf('wrapped-up')
    expect(runningHeaderIndex).toBeGreaterThanOrEqual(0)
    expect(runningHeaderIndex).toBeLessThan(stillGoingIndex)
    expect(stillGoingIndex).toBeLessThan(doneHeaderIndex)
    expect(doneHeaderIndex).toBeLessThan(wrappedUpIndex)

    // Walk each row up to its containing <tbody> and confirm it holds that
    // section's header, not the other one's.
    const runningRowBody = screen.getByText('still-going').closest('tbody')
    const doneRowBody = screen.getByText('wrapped-up').closest('tbody')
    expect(runningRowBody).not.toBeNull()
    expect(doneRowBody).not.toBeNull()
    expect(runningRowBody).not.toBe(doneRowBody)
    expect(runningRowBody?.textContent).toContain('Running')
    expect(runningRowBody?.textContent).not.toContain('Finished')
    expect(doneRowBody?.textContent).toContain('Finished')
    expect(doneRowBody?.textContent).not.toContain('Running')
  })

  it('omits the Done/Finished section when every session is still running', async () => {
    const operations = {
      list: vi.fn().mockResolvedValue({
        sessions: [
          { id: 's1', name: 'still-going', cwd: '/tmp', status: 'working', startedAt: '2026-09-01T00:00:00Z' },
          { id: 's2', name: 'also-running', cwd: '/tmp', status: 'working', startedAt: '2026-09-02T00:00:00Z' },
        ],
      }),
      createFrom: vi.fn(),
    }
    render(<ImportDialog operations={operations} onImported={() => {}} onClose={() => {}} />)
    await waitFor(() => { expect(screen.getByText('still-going')).toBeTruthy() })

    // The Running section (and both of its rows) is present...
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByText('still-going')).toBeTruthy()
    expect(screen.getByText('also-running')).toBeTruthy()

    // ...but with no done/terminal-status session in the list, the
    // Done/Finished section header must not render at all (exercises the
    // `done.length > 0` false branch). Modal renders via a portal, so this
    // walks `document.body` rather than the render() container.
    expect(screen.queryByText('Finished')).toBeNull()
    expect(document.body.textContent ?? '').not.toContain('Finished')
  })
})
