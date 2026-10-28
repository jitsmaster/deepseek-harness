// @vitest-environment jsdom
/** Inspect request panel: composition table, row expansion, copy, and fallbacks. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { RequestInspectorPanel } from '../src/client/RequestInspectorPanel.tsx'
import type { ComposableRequestPayload } from '../src/client/request-composition.ts'
import { composeRequest } from '../src/client/request-composition.ts'
import { t } from './locale.client.ts'

vi.mock('../src/client/request-composition.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/request-composition.ts')>()
  return { ...actual, composeRequest: vi.fn(actual.composeRequest) }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const LT = String.fromCharCode(60)
const PAYLOAD: ComposableRequestPayload = {
  argv: ['claude', '-p'],
  envKeys: ['PATH'],
  system: 'You are DSH.',
  tools: [{ name: 'mcp__dsh__read', description: 'Read a file', inputSchema: {} }],
  stdin: `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: `${LT}user>\nhello\n${LT}/user>` }] },
  })}\n`,
}
const USAGE = { input: 10, cacheRead: 90, cacheWrite: 0 }

function renderPanel(state: Parameters<typeof RequestInspectorPanel>[0]['state'], onClose = () => {}) {
  return render(<RequestInspectorPanel state={state} usage={USAGE} model="m" t={t} onClose={onClose} />)
}

describe('RequestInspectorPanel', () => {
  it('shows a category table with token totals and expands an item to its text', () => {
    const view = renderPanel({ kind: 'ready', payload: PAYLOAD })
    const ui = within(view.container)
    expect(ui.getByText('System prompt')).toBeTruthy()
    expect(ui.getByText('Tools')).toBeTruthy()
    expect(ui.getByText('Transcript')).toBeTruthy()
    expect(ui.queryByText('You are DSH.')).toBeNull()
    fireEvent.click(ui.getByRole('button', { name: /System prompt/ }))
    const [, item] = ui.getAllByRole('button', { name: /System prompt/ })
    fireEvent.click(item as HTMLElement)
    expect(ui.getByText('You are DSH.')).toBeTruthy()
  })

  it('copies the payload as JSON', () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const view = renderPanel({ kind: 'ready', payload: PAYLOAD })
    fireEvent.click(within(view.container).getByRole('button', { name: 'Copy as JSON' }))
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(PAYLOAD, null, 2))
  })

  it('says the payload was not captured', () => {
    const view = renderPanel({ kind: 'missing' })
    expect(within(view.container).getByText('Payload not captured')).toBeTruthy()
  })

  it('flags a truncated payload', () => {
    const view = renderPanel({ kind: 'ready', payload: { ...PAYLOAD, truncated: true, stdinBytes: 9000 } })
    expect(within(view.container).getByText('Payload truncated to fit its size limit')).toBeTruthy()
  })

  it('previews only the start of a very large item until Show all is chosen', () => {
    const huge = 'z'.repeat(300_000)
    const view = renderPanel({ kind: 'ready', payload: { ...PAYLOAD, system: huge } })
    const ui = within(view.container)
    fireEvent.click(ui.getByRole('button', { name: /System prompt/ }))
    const [, item] = ui.getAllByRole('button', { name: /System prompt/ })
    fireEvent.click(item as HTMLElement)
    const shown = view.container.querySelector('pre')?.textContent ?? ''
    expect(shown.length).toBeLessThan(100_000)
    fireEvent.click(ui.getByRole('button', { name: 'Show all' }))
    expect(view.container.querySelector('pre')?.textContent).toBe(huge)
    expect(ui.queryByRole('button', { name: 'Show all' })).toBeNull()
  })

  it('does not recompute the breakdown when re-rendered with an equal usage object', () => {
    vi.mocked(composeRequest).mockClear()
    const view = render(<RequestInspectorPanel state={{ kind: 'ready', payload: PAYLOAD }}
      usage={{ ...USAGE }} model="m" t={t} onClose={() => {}} />)
    view.rerender(<RequestInspectorPanel state={{ kind: 'ready', payload: PAYLOAD }}
      usage={{ ...USAGE }} model="m" t={t} onClose={() => {}} />)
    expect(composeRequest).toHaveBeenCalledTimes(1)
  })

  it('shows loading and closes', () => {
    const onClose = vi.fn()
    const view = renderPanel({ kind: 'loading' }, onClose)
    const ui = within(view.container)
    expect(ui.getByText('Loading request…')).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
