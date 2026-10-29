// @vitest-environment jsdom
/** Plugin detail tabs contributed through `conversation.trajectory.detail.tabs`. */

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { useState, type ComponentProps, type ReactNode } from 'react'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { TrajectoryTable } from '../src/client/TrajectoryTable.tsx'
import { createDetailTabSource } from '../src/client/detail-tab-slot.ts'
import type { TrajectoryDetailTabOwnerProps } from '../src/client/trajectory-contract.ts'
import type { TrajectoryTurnModel } from '../src/client/layout.ts'
import { t } from './locale.client.ts'

type Keys = 'conversation.trajectory.images' | 'conversation.trajectory.detail.tabs'
type TableProps = ComponentProps<typeof TrajectoryTable>

const TURNS: readonly TrajectoryTurnModel[] = [{
  turn: 1,
  groups: [{
    title: 'Step 1',
    cells: [
      { index: 1, kind: 'message', text: 'Checking files', outputDetail: 'Checking files', timeSeconds: 1.5 },
      {
        index: 2, kind: 'tool', text: 'bash · {"command":"pwd"}',
        inputDetail: '{"command":"pwd"}', outputDetail: '/work', timeSeconds: 0.2,
      },
    ],
  }],
}]

const REQUESTS: NonNullable<TableProps['requestNumbers']> = [
  { turn: 1, step: 1, group: 'Step 1', number: 1, payloadBlob: 'request-1.json' },
]

const FOLD_PROPS = {
  collapsedTurns: new Set<number>(),
  onToggleTurn: () => {},
  collapsedAssistants: new Set<string>(),
  onToggleAssistant: () => {},
}

const PluginTab = ({ record, readRequestPayload }: TrajectoryDetailTabOwnerProps) => (
  <div
    data-testid="plugin-tab"
    data-kind={record.kind}
    data-index={record.index}
    data-turn={record.turn}
    data-blob={record.payloadBlob ?? ''}
    data-reader={readRequestPayload === undefined ? 'none' : 'present'}
  />
)

async function fixture() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  await runtime.sessions.add({ id: 'trajectory-detail-tabs' })
  const session = runtime.sessions.retainFor(runtime.ctx, SessionId('trajectory-detail-tabs'))
  const captured: { seats?: PropsRenderSlots<Keys>; setContent?: (content: ReactNode) => void } = {}
  await runtime.root.declare({
    'conversation.trajectory.images': { kind: 'single', scope: 'session' },
    'conversation.trajectory.detail.tabs': { kind: 'list', scope: 'session' },
  }, function TestRoot(props) {
    const [content, setContent] = useState<ReactNode>(null)
    captured.seats = props
    captured.setContent = setContent
    const { SessionProvider } = props
    return <SessionProvider session={session}>{content}</SessionProvider>
  })
  const view = runtime.renderRoot()
  const { seats, setContent } = captured
  if (seats === undefined || setContent === undefined) throw new Error('detail tab fixture root did not render')
  const source = createDetailTabSource(runtime.slots)
  return {
    runtime,
    show: (extra: Partial<TableProps> = {}) => {
      act(() => {
        setContent(
          <TrajectoryTable
            t={t}
            renderSlot={seats.renderSlot}
            loadImage={async () => 'blob:x'}
            turns={TURNS}
            requestNumbers={REQUESTS}
            pluginTabs={{ source, renderSlot: seats.renderSlot }}
            {...FOLD_PROPS}
            {...extra}
          />,
        )
      })
      return view
    },
  }
}

const tabLabels = () => screen.getAllByRole('tab').map(tab => tab.textContent)

afterEach(() => { cleanup() })

describe('trajectory detail tab slot', () => {
  it('leaves the assistant tab list and panel unchanged without a registration', async () => {
    const { show } = await fixture()
    show()
    fireEvent.click(screen.getByRole('row', { name: /ASSISTANT/ }))
    const before = tabLabels()
    expect(before).not.toContain('API Call')
    expect(before.at(0)).toBe('Summary')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('trajectory-detail-overview')
    expect(screen.queryByTestId('plugin-tab')).toBeNull()
  })

  it('appends a registered tab after the built-in tabs with its label', async () => {
    const { runtime, show } = await fixture()
    runtime.slots.register(
      { name: 'conversation.trajectory.detail.tabs', id: 'api-call', label: 'API Call', order: 5 },
      PluginTab,
    )
    show()
    fireEvent.click(screen.getByRole('row', { name: /ASSISTANT/ }))
    const labels = tabLabels()
    expect(labels.at(-1)).toBe('API Call')
    expect(labels.length).toBeGreaterThan(1)
    expect(screen.getByRole('tab', { name: 'API Call' }).id).toBe('trajectory-detail-slot:api-call')
  })

  it('renders the plugin component in the tabpanel with the record description and payload reader', async () => {
    const { runtime, show } = await fixture()
    const reader = vi.fn(async () => ({ ok: true as const, value: undefined }))
    runtime.slots.register(
      { name: 'conversation.trajectory.detail.tabs', id: 'api-call', label: () => 'API Call' },
      PluginTab,
    )
    show({ readRequestPayload: reader })
    fireEvent.click(screen.getByRole('row', { name: /ASSISTANT/ }))
    fireEvent.click(screen.getByRole('tab', { name: 'API Call' }))
    const panel = screen.getByRole('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe('trajectory-detail-slot:api-call')
    const body = within(panel).getByTestId('plugin-tab')
    expect(body.dataset).toMatchObject({
      kind: 'message', index: '1', turn: '1', blob: 'request-1.json', reader: 'present',
    })
  })

  it('hides the tab on records where the registration predicate returns false', async () => {
    const { runtime, show } = await fixture()
    runtime.slots.register({
      name: 'conversation.trajectory.detail.tabs', id: 'api-call', label: 'API Call',
      when: record => record.kind === 'message',
    }, PluginTab)
    show()
    fireEvent.click(screen.getByRole('row', { name: /TOOL/ }))
    expect(tabLabels()).not.toContain('API Call')
    fireEvent.click(screen.getByRole('row', { name: /ASSISTANT/ }))
    expect(tabLabels()).toContain('API Call')
  })

  it('falls back to a built-in tab on a record without the tab and remembers the plugin tab', async () => {
    const { runtime, show } = await fixture()
    runtime.slots.register({
      name: 'conversation.trajectory.detail.tabs', id: 'api-call', label: 'API Call',
      when: record => record.kind === 'message',
    }, PluginTab)
    show()
    fireEvent.click(screen.getByRole('row', { name: /ASSISTANT/ }))
    fireEvent.click(screen.getByRole('tab', { name: 'API Call' }))
    expect(screen.getByRole('tab', { name: 'API Call' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('row', { name: /TOOL/ }))
    expect(screen.queryByRole('tab', { name: 'API Call' })).toBeNull()
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('trajectory-detail-overview')
    fireEvent.click(screen.getByRole('row', { name: /ASSISTANT/ }))
    expect(screen.getByRole('tab', { name: 'API Call' }).getAttribute('aria-selected')).toBe('true')
  })

  it('orders several registrations ascending by order after the built-in tabs', async () => {
    const { runtime, show } = await fixture()
    runtime.slots.register({ name: 'conversation.trajectory.detail.tabs', id: 'late', label: 'Late', order: 20 }, PluginTab)
    runtime.slots.register({ name: 'conversation.trajectory.detail.tabs', id: 'early', label: 'Early', order: 10 }, PluginTab)
    show()
    fireEvent.click(screen.getByRole('row', { name: /ASSISTANT/ }))
    expect(tabLabels().slice(-2)).toEqual(['Early', 'Late'])
  })

  it('shows a tab registered after the table mounted', async () => {
    const { runtime, show } = await fixture()
    show()
    fireEvent.click(screen.getByRole('row', { name: /ASSISTANT/ }))
    expect(tabLabels()).not.toContain('Late bloomer')
    act(() => {
      runtime.slots.register({ name: 'conversation.trajectory.detail.tabs', id: 'late', label: 'Late bloomer' }, PluginTab)
    })
    await act(async () => { await Promise.resolve() })
    expect(tabLabels().at(-1)).toBe('Late bloomer')
  })

  it('forwards a custom when option through the production slot registry and stamps a registrant', async () => {
    const { runtime } = await fixture()
    const when = (record: { kind: string }) => record.kind === 'message'
    runtime.slots.register({ name: 'conversation.trajectory.detail.tabs', id: 'api-call', when }, PluginTab)
    const [entry] = runtime.slots.entries('conversation.trajectory.detail.tabs')
    expect(entry?.custom?.['when']).toBe(when)
  })

  it('treats a non-function when as absent so the tab stays visible', async () => {
    const { runtime, show } = await fixture()
    runtime.slots.register({
      name: 'conversation.trajectory.detail.tabs', id: 'api-call', label: 'API Call',
      when: true as never,
    }, PluginTab)
    show()
    fireEvent.click(screen.getByRole('row', { name: /TOOL/ }))
    expect(tabLabels()).toContain('API Call')
    fireEvent.click(screen.getByRole('row', { name: /ASSISTANT/ }))
    expect(tabLabels()).toContain('API Call')
  })

  it('keeps the current selection and active tab when a plugin registers late', async () => {
    const { runtime, show } = await fixture()
    const onRecordSelect = vi.fn()
    const recordSelection = { index: 1 }
    show({ recordSelection, onRecordSelect })
    expect(onRecordSelect).toHaveBeenCalledTimes(1)
    const other = screen.getAllByRole('tab')[1]
    if (other === undefined) throw new Error('expected a second built-in tab')
    fireEvent.click(other)
    const activeId = screen.getByRole('tabpanel').getAttribute('aria-labelledby')
    expect(activeId).not.toBe('trajectory-detail-overview')
    act(() => {
      runtime.slots.register({ name: 'conversation.trajectory.detail.tabs', id: 'late', label: 'Late bloomer' }, PluginTab)
    })
    await act(async () => { await Promise.resolve() })
    expect(tabLabels().at(-1)).toBe('Late bloomer')
    expect(onRecordSelect).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(activeId)
  })

  it('falls back to the first tab when the active plugin tab is unregistered', async () => {
    const { runtime, show } = await fixture()
    const dispose = runtime.slots.register({
      name: 'conversation.trajectory.detail.tabs', id: 'api-call', label: 'API Call',
    }, PluginTab)
    show()
    fireEvent.click(screen.getByRole('row', { name: /ASSISTANT/ }))
    fireEvent.click(screen.getByRole('tab', { name: 'API Call' }))
    expect(screen.getByTestId('plugin-tab')).toBeTruthy()
    act(() => { dispose() })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('tab', { name: 'API Call' })).toBeNull()
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('trajectory-detail-overview')
    expect(screen.getAllByRole('tab')[0]?.getAttribute('aria-selected')).toBe('true')
  })

  it('falls back to the registration id when a label thunk throws, keeping the built-in tabs', async () => {
    const { runtime, show } = await fixture()
    runtime.slots.register({
      name: 'conversation.trajectory.detail.tabs', id: 'broken',
      label: () => { throw new Error('label boom') },
    }, PluginTab)
    show()
    fireEvent.click(screen.getByRole('row', { name: /ASSISTANT/ }))
    expect(tabLabels()).toContain('broken')
    expect(screen.getAllByRole('tab').length).toBeGreaterThan(1)
  })
})
