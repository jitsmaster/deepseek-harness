// @vitest-environment jsdom
/** Request breakdown in the summary of a selected request: categories, tokens, and fallbacks. */
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RequestBreakdown } from '../src/client/RequestBreakdown.tsx'
import { TrajectoryTable } from '../src/client/TrajectoryTable.tsx'
import type { ComposableRequestPayload } from '../src/client/request-composition.ts'
import { measureRequest } from '../src/client/request-composition.ts'
import type { TrajectoryTurnModel } from '../src/client/layout.ts'
import { t } from './locale.client.ts'

vi.mock('../src/client/request-composition.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/request-composition.ts')>()
  return { ...actual, measureRequest: vi.fn(actual.measureRequest) }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
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
type Read = NonNullable<ComponentProps<typeof RequestBreakdown>['read']>
const ready = (payload: ComposableRequestPayload = PAYLOAD): Read =>
  () => Promise.resolve({ ok: true as const, value: payload })

describe('RequestBreakdown', () => {
  it('shows each category with its token share and the reported total', async () => {
    const view = render(<RequestBreakdown blob="1.json.gz" read={ready()} usage={USAGE} t={t} />)
    const ui = within(view.container)
    await waitFor(() => { expect(ui.getByText('System prompt')).toBeTruthy() })
    expect(ui.getByText('Request breakdown')).toBeTruthy()
    expect(ui.getByText('Tools')).toBeTruthy()
    expect(ui.getByText('Transcript')).toBeTruthy()
    expect(ui.getByText(/Total/).textContent).toContain('~100 tokens')
  })

  it('falls back to byte sizes when no usage was reported', async () => {
    const view = render(<RequestBreakdown blob="1.json.gz" read={ready()} t={t} />)
    await waitFor(() => { expect(within(view.container).getByText('System prompt')).toBeTruthy() })
    expect(within(view.container).getByText(/Total/).textContent).toMatch(/bytes/)
  })

  it('shows loading until the payload arrives', async () => {
    let resolve: (value: Awaited<ReturnType<Read>>) => void = () => {}
    const read = vi.fn<Read>(() => new Promise((done) => { resolve = done }))
    const view = render(<RequestBreakdown blob="1.json.gz" read={read} usage={USAGE} t={t} />)
    expect(within(view.container).getByText('Loading request…')).toBeTruthy()
    await waitFor(() => { expect(read).toHaveBeenCalled() })
    expect(within(view.container).getByText('Loading request…')).toBeTruthy()
    resolve({ ok: true, value: PAYLOAD })
    await waitFor(() => { expect(within(view.container).getByText('System prompt')).toBeTruthy() })
  })

  it.each([
    ['no recorded blob', undefined, ready()],
    ['an unreadable blob', '1.json.gz', () => Promise.resolve({ ok: false as const })],
    ['a purged blob', '1.json.gz', () => Promise.resolve({ ok: true as const, value: undefined })],
    ['a rejected read', '1.json.gz', () => Promise.reject(new Error('gone'))],
  ] as const)('says the payload was not captured for %s', async (_name, blob, read) => {
    const view = render(<RequestBreakdown {...blob === undefined ? {} : { blob }} read={read} t={t} />)
    await waitFor(() => { expect(within(view.container).getByText('Payload not captured')).toBeTruthy() })
  })

  it('renders nothing without a payload reader', () => {
    const view = render(<RequestBreakdown blob="1.json.gz" t={t} />)
    expect(view.container.textContent).toBe('')
  })

  it('flags a truncated payload', async () => {
    const view = render(<RequestBreakdown blob="1.json.gz"
      read={ready({ ...PAYLOAD, truncated: true, stdinBytes: 9000 })} t={t} />)
    await waitFor(() => {
      expect(within(view.container).getByText('Payload truncated to fit its size limit')).toBeTruthy()
    })
  })

  it('ignores a slow read for an earlier blob after the selection changed', async () => {
    vi.useFakeTimers()
    try {
      let resolveFirst: (value: Awaited<ReturnType<Read>>) => void = () => {}
      const read = vi.fn<Read>(blob => blob === 'a.json.gz'
        ? new Promise((done) => { resolveFirst = done })
        : Promise.resolve({ ok: true, value: PAYLOAD }))
      const view = render(<RequestBreakdown blob="a.json.gz" read={read} usage={USAGE} t={t} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      expect(read).toHaveBeenCalledWith('a.json.gz')
      view.rerender(<RequestBreakdown blob="b.json.gz" read={read} usage={USAGE} t={t} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      expect(within(view.container).getByText('Tools')).toBeTruthy()
      // The earlier read resolves late with an empty payload: it must not replace the current breakdown.
      resolveFirst({ ok: true, value: { ...PAYLOAD, tools: [], system: '', stdin: '' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(within(view.container).getByText('System prompt')).toBeTruthy()
      expect(within(view.container).getByText('Tools')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('measures the payload once on load and not again when re-rendered with new usage', async () => {
    const read = ready()
    const view = render(<RequestBreakdown blob="1.json.gz" read={read} usage={{ ...USAGE }} t={t} />)
    await waitFor(() => { expect(within(view.container).getByText('System prompt')).toBeTruthy() })
    expect(measureRequest).toHaveBeenCalledTimes(1)
    view.rerender(<RequestBreakdown blob="1.json.gz" read={read} usage={{ ...USAGE }} t={t} />)
    view.rerender(<RequestBreakdown blob="1.json.gz" read={read} usage={{ input: 50, cacheRead: 0, cacheWrite: 0 }} t={t} />)
    expect(measureRequest).toHaveBeenCalledTimes(1)
    expect(within(view.container).getByText(/Total/).textContent).toContain('~50 tokens')
  })

  it('reads only the last blob when the selection changes rapidly', async () => {
    vi.useFakeTimers()
    try {
      const read = vi.fn<Read>(() => Promise.resolve({ ok: true, value: PAYLOAD }))
      const view = render(<RequestBreakdown blob="a.json.gz" read={read} t={t} />)
      view.rerender(<RequestBreakdown blob="b.json.gz" read={read} t={t} />)
      view.rerender(<RequestBreakdown blob="c.json.gz" read={read} t={t} />)
      expect(read).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(300)
      expect(read).toHaveBeenCalledTimes(1)
      expect(read).toHaveBeenCalledWith('c.json.gz')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not read when unmounted before the read delay elapses', async () => {
    vi.useFakeTimers()
    try {
      const read = vi.fn<Read>(() => Promise.resolve({ ok: true, value: PAYLOAD }))
      const view = render(<RequestBreakdown blob="a.json.gz" read={read} t={t} />)
      view.unmount()
      await vi.advanceTimersByTimeAsync(300)
      expect(read).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('says the payload was not captured when the stored payload cannot be measured', async () => {
    const broken = { ...PAYLOAD, tools: undefined } as unknown as ComposableRequestPayload
    const view = render(<RequestBreakdown blob="1.json.gz" read={ready(broken)} t={t} />)
    await waitFor(() => { expect(within(view.container).getByText('Payload not captured')).toBeTruthy() })
  })
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
const REQUESTS = [{
  seq: 2, turn: 1, step: 2, group: 'Step 2', number: 1,
  payloadBlob: '2-2-1.json.gz', usage: { input: 10, cacheRead: 90 },
}]

function renderTable(readRequestPayload?: Read) {
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
    {...readRequestPayload === undefined ? {} : { readRequestPayload }}
  />)
}

describe('TrajectoryTable request summary', () => {
  it('shows the breakdown once a request is selected, and reads nothing before', async () => {
    const read = vi.fn<Read>(ready())
    renderTable(read)
    expect(read).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Request #1' }))
    await waitFor(() => { expect(read).toHaveBeenCalledWith('2-2-1.json.gz') })
    await waitFor(() => { expect(screen.getByText('System prompt')).toBeTruthy() })
  })

  it('shows no breakdown without a payload reader', () => {
    renderTable()
    fireEvent.click(screen.getByRole('button', { name: 'Request #1' }))
    expect(screen.queryByText('Request breakdown')).toBeNull()
  })

  it('offers no context menu on an assistant row', () => {
    renderTable(ready())
    fireEvent.contextMenu(screen.getByText('hi there').closest('tr') as HTMLElement)
    expect(screen.queryByRole('menuitem')).toBeNull()
  })
})
