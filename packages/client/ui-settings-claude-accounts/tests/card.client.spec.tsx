// @vitest-environment jsdom
/** The Claude accounts card as the Models page footer renders it: choose, read usage, sign in, add, remove, make default. */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { AuthorizationOutcome, ClaudeAccountsStatusView, ClaudeAccountView } from '@deepseek-ai/dsh-api-remotes/client'
import { ClaudeAccountsCard } from '../src/client/ClaudeAccountsCard.tsx'
import type { ClaudeAccountsCardProps } from '../src/client/ClaudeAccountsCard.tsx'
import type { AuthorizationOperations } from '../src/client/authorization-operations.ts'
import { ClaudeAccountsController } from '../src/client/controller.ts'
import { en, fill } from '../src/client/locales.ts'
import type { ClaudeAccountsOperations, ClaudeSettingsSnapshot } from '../src/client/operations.ts'

afterEach(cleanup)

const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const t = (key: keyof typeof en): string => en[key]

function row(email: string, overrides: Partial<ClaudeAccountView> = {}): ClaudeAccountView {
  return { email, id: email, signedIn: true, active: false, ...overrides }
}

const settings = (overrides: Partial<ClaudeSettingsSnapshot> = {}): ClaudeSettingsSnapshot => (
  { configured: true, writable: true, revision: 1, accounts: ['a@x.com', 'b@x.com'], activeAccount: 'a@x.com', ...overrides }
)

const THREE: ClaudeAccountsStatusView = {
  accounts: [
    row('a@x.com', {
      active: true,
      usage: {
        updatedAt: NOW - 5 * 60_000,
        fiveHour: { utilization: 0.62, resetsAt: (NOW + 2 * 3_600_000 + 60_000) / 1000 },
        sevenDay: { utilization: 0.41, resetsAt: (NOW + 3 * 86_400_000) / 1000 },
      },
    }),
    row('b@x.com', {
      usage: {
        updatedAt: NOW - 10_000,
        fiveHour: { utilization: 0.05, resetsAt: (NOW - 1000) / 1000 },
        sevenDay: { utilization: 0.1, resetsAt: (NOW + 86_400_000) / 1000 },
      },
    }),
    row('c@x.com', { signedIn: false }),
  ],
  defaultAccount: { email: 'a@x.com' },
  activeAccount: 'a@x.com',
}

function fakeOperations(status: ClaudeAccountsStatusView | undefined, snapshot: ClaudeSettingsSnapshot) {
  return {
    readStatus: vi.fn(() => Promise.resolve(status)),
    readSettings: vi.fn(() => Promise.resolve(snapshot)),
    writeSettings: vi.fn((): ReturnType<ClaudeAccountsOperations['writeSettings']> => Promise.resolve({ kind: 'written', snapshot })),
    makeDefault: vi.fn((): ReturnType<ClaudeAccountsOperations['makeDefault']> => Promise.resolve({ kind: 'done', unchanged: false })),
    signOut: vi.fn((): ReturnType<ClaudeAccountsOperations['signOut']> => Promise.resolve({ kind: 'done' })),
  }
}

type BeginArgs = Parameters<AuthorizationOperations['beginAuthorization']>

function fakeAuthorization() {
  const parts = {
    begin: vi.fn((..._args: BeginArgs) => new Promise<AuthorizationOutcome>(() => undefined)),
    respond: vi.fn(() => Promise.resolve(undefined)),
    decline: vi.fn(() => Promise.resolve(undefined)),
    cancel: vi.fn(() => Promise.resolve()),
  }
  const operations: AuthorizationOperations = {
    describeAuthorization: () => Promise.resolve(undefined),
    beginAuthorization: parts.begin,
    respondAuthorization: parts.respond,
    declineAuthorization: parts.decline,
    cancelAuthorization: parts.cancel,
  }
  return { parts, operations }
}

async function mount(status: ClaudeAccountsStatusView | undefined, snapshot: ClaudeSettingsSnapshot = settings()) {
  const operations = fakeOperations(status, snapshot)
  const controller = new ClaudeAccountsController(operations, () => NOW)
  const auth = fakeAuthorization()
  const props = {
    t,
    controller,
    authOperations: auth.operations,
    useClaudeAccounts: bindSnapshotSelector(controller.store),
  } as unknown as ClaudeAccountsCardProps
  render(<ClaudeAccountsCard {...props} />)
  await waitFor(() => { expect(operations.readSettings).toHaveBeenCalled() })
  await act(async () => { await Promise.resolve() })
  return { controller, operations, auth: auth.parts }
}
describe('ClaudeAccountsCard', () => {
  it('renders nothing before the Host answers and while the plugin is not configured', async () => {
    await mount(THREE, settings({ configured: false, writable: false, accounts: [] }))
    expect(screen.queryByText(en.title)).toBeNull()
    expect(document.body.textContent).toBe('')
  })

  it('lists each email as a radio of one labelled group, checking the active account', async () => {
    await mount(THREE)
    const group = await screen.findByRole('radiogroup', { name: en.groupLabel })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map(radio => (radio as HTMLInputElement).checked)).toEqual([true, false, false])
    expect(radios.map(radio => (radio as HTMLInputElement).disabled)).toEqual([false, false, true])
    expect(within(group).getByRole('radio', { name: 'a@x.com' })).toBeTruthy()
  })

  it('shows percent used, reset time, and when each reading was updated', async () => {
    await mount(THREE)
    expect(await screen.findByText(fill(en.usageLine, { percent: '62%', time: '2 h' }))).toBeTruthy()
    expect(screen.getByText(fill(en.usageLine, { percent: '41%', time: '3 d' }))).toBeTruthy()
    expect(screen.getByText(fill(en.usageLineReset, { percent: '5%' }))).toBeTruthy()
    expect(screen.getByText(fill(en.updatedAgo, { time: '5 min' }))).toBeTruthy()
    expect(screen.getByText(en.updatedNow)).toBeTruthy()
    expect(screen.getAllByText(en.usageSession).length).toBe(2)
    expect(screen.getAllByText(en.usageWeekly).length).toBe(2)
  })

  it('marks the least-used account, the active one, the Claude Code default, and the one not signed in', async () => {
    await mount(THREE)
    expect(await screen.findAllByText(en.badgeLeastUsed)).toHaveLength(1)
    const rowOf = (email: string): HTMLElement => screen.getByRole('radio', { name: email }).closest('div[class*="row"]')!.parentElement!
    expect(within(screen.getByRole('radio', { name: 'b@x.com' }).closest('div')!.parentElement!).getByText(en.badgeLeastUsed)).toBeTruthy()
    expect(within(rowOf('a@x.com')).getByText(en.badgeActive)).toBeTruthy()
    expect(within(rowOf('a@x.com')).getByText(en.badgeDefault)).toBeTruthy()
    expect(within(rowOf('c@x.com')).getByText(en.badgeNotSignedIn)).toBeTruthy()
  })

  it('shows an empty state when an account has no reading yet', async () => {
    await mount({ accounts: [row('a@x.com', { active: true })], defaultAccount: {} })
    expect(await screen.findByText(en.usageNone)).toBeTruthy()
    expect(screen.getByText(en.usageHint)).toBeTruthy()
    expect(screen.queryByText(en.badgeLeastUsed)).toBeNull()
  })

  it('shows a missing window as no reading while the other window reads', async () => {
    await mount({
      accounts: [row('a@x.com', { usage: { updatedAt: NOW, sevenDay: { utilization: 0.3, resetsAt: (NOW + 3_600_000) / 1000 } } })],
      defaultAccount: {},
    })
    expect(await screen.findByText(fill(en.usageLine, { percent: '30%', time: '1 h' }))).toBeTruthy()
    expect(screen.getByText(en.usageNone)).toBeTruthy()
  })

  it('lists no accounts with a prompt to add one', async () => {
    await mount({ accounts: [], defaultAccount: {} }, settings({ accounts: [], activeAccount: undefined }))
    expect(await screen.findByText(en.empty)).toBeTruthy()
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('makes an email active with one click on its radio', async () => {
    const { operations } = await mount(THREE)
    fireEvent.click(await screen.findByRole('radio', { name: 'b@x.com' }))
    await waitFor(() => { expect(operations.writeSettings).toHaveBeenCalledWith([{ op: 'set', path: ['activeAccount'], value: 'b@x.com' }], 1) })
  })

  it('adds an email through the form, and rejects an invalid or repeated one', async () => {
    const { operations } = await mount(THREE)
    const input = await screen.findByLabelText(en.addLabel)
    const add = screen.getByRole('button', { name: en.add })
    expect((add as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.click(add)
    expect((await screen.findByRole('alert')).textContent).toBe(en.addInvalid)
    expect(input.getAttribute('aria-invalid')).toBe('true')

    fireEvent.change(input, { target: { value: 'A@x.com' } })
    expect(screen.queryByText(en.addInvalid)).toBeNull()
    fireEvent.click(add)
    expect((await screen.findByRole('alert')).textContent).toBe(en.addDuplicate)
    expect(operations.writeSettings).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'new@x.com' } })
    fireEvent.click(add)
    await waitFor(() => { expect(operations.writeSettings).toHaveBeenCalledWith([{ op: 'set', path: ['accounts'], value: ['a@x.com', 'b@x.com', 'new@x.com'] }], 1) })
    await waitFor(() => { expect((input as HTMLInputElement).value).toBe('') })
  })

  it('removes a listed email from the list through a labelled button', async () => {
    const { operations } = await mount(THREE)
    fireEvent.click(await screen.findByRole('button', { name: fill(en.removeFor, { email: 'b@x.com' }) }))
    await waitFor(() => { expect(operations.writeSettings).toHaveBeenCalledWith([{ op: 'set', path: ['accounts'], value: ['a@x.com'] }], 1) })
    expect(screen.queryByRole('button', { name: fill(en.removeFor, { email: 'c@x.com' }) })).toBeNull()
  })

  it('offers Sign in for an account that has not signed in and Sign in again for one that has', async () => {
    await mount(THREE)
    expect(await screen.findByRole('button', { name: fill(en.signInFor, { email: 'c@x.com' }) })).toBeTruthy()
    expect(screen.getByRole('button', { name: fill(en.signInAgainFor, { email: 'a@x.com' }) })).toBeTruthy()
  })

  it('opens the sign-in dialog, relays its prompt, and re-reads the Host once it settles', async () => {
    const bench = await mount(THREE)
    let settle: (outcome: AuthorizationOutcome) => void = () => undefined
    bench.auth.begin.mockImplementationOnce((_key, _method, _signal, handlers) => {
      handlers.onNotice({ message: 'Open the page', url: 'https://claude.ai/oauth/authorize?x=1' })
      handlers.onPrompt('p1', { kind: 'select', message: 'Which account?', options: [{ id: 'a@x.com', label: 'a@x.com' }] })
      return new Promise((resolve) => { settle = resolve })
    })
    fireEvent.click(await screen.findByRole('button', { name: fill(en.signInFor, { email: 'c@x.com' }) }))
    expect(await screen.findByText('Open the page')).toBeTruthy()
    expect(bench.auth.begin).toHaveBeenCalledWith('llm-claude-code/claude-account', undefined, expect.any(AbortSignal), expect.any(Object))
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://claude.ai/oauth/authorize?x=1')
    fireEvent.click(screen.getByRole('button', { name: 'a@x.com' }))
    await waitFor(() => { expect(bench.auth.respond).toHaveBeenCalledWith('llm-claude-code/claude-account', 'p1', 'a@x.com') })
    const reads = bench.operations.readStatus.mock.calls.length
    await act(async () => { settle({ status: 'authorized' }) })
    await waitFor(() => { expect(screen.queryByText('Open the page')).toBeNull() })
    await waitFor(() => { expect(bench.operations.readStatus.mock.calls.length).toBeGreaterThan(reads) })
  })

  it('cancels a sign-in from the dialog', async () => {
    const bench = await mount(THREE)
    fireEvent.click(await screen.findByRole('button', { name: fill(en.signInFor, { email: 'c@x.com' }) }))
    fireEvent.click((await screen.findAllByRole('button', { name: en.cancel })).at(-1)!)
    await waitFor(() => { expect(bench.auth.cancel).toHaveBeenCalledWith('llm-claude-code/claude-account') })
    expect(screen.queryByText(en.authSigningIn)).toBeNull()
  })

  it('asks before making an account the default, warning that running sessions keep the old one', async () => {
    const { operations } = await mount(THREE)
    fireEvent.click(await screen.findByRole('button', { name: fill(en.makeDefaultFor, { email: 'b@x.com' }) }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(fill(en.confirmBody, { email: 'b@x.com' }))).toBeTruthy()
    expect(fill(en.confirmBody, { email: 'b@x.com' })).toMatch(/already running.*restart.*backed up/su)
    expect(operations.makeDefault).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getAllByRole('button', { name: en.cancel }).at(-1)!)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(operations.makeDefault).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: fill(en.makeDefaultFor, { email: 'b@x.com' }) }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.confirmAction }))
    await waitFor(() => { expect(operations.makeDefault).toHaveBeenCalledWith('b@x.com') })
    expect((await screen.findByRole('status')).textContent).toBe(fill(en.makeDefaultDone, { email: 'b@x.com' }))
  })

  it('offers no make-default button for the account that already is the default, or one not signed in', async () => {
    await mount(THREE)
    await screen.findByRole('radiogroup')
    expect(screen.queryByRole('button', { name: fill(en.makeDefaultFor, { email: 'a@x.com' }) })).toBeNull()
    expect(screen.queryByRole('button', { name: fill(en.makeDefaultFor, { email: 'c@x.com' }) })).toBeNull()
  })

  it('shows a refused swap as an alert', async () => {
    const { operations } = await mount(THREE)
    operations.makeDefault.mockResolvedValueOnce({ kind: 'refused', message: 'disk full' })
    fireEvent.click(await screen.findByRole('button', { name: fill(en.makeDefaultFor, { email: 'b@x.com' }) }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.confirmAction }))
    expect((await screen.findByRole('alert')).textContent).toBe(fill(en.makeDefaultFailed, { reason: 'disk full' }))
  })

  it('asks before signing a signed-in account out, and does nothing on cancel', async () => {
    const { operations } = await mount(THREE)
    fireEvent.click(await screen.findByRole('button', { name: fill(en.signOutFor, { email: 'b@x.com' }) }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(fill(en.signOutBody, { email: 'b@x.com' }))).toBeTruthy()
    expect(operations.signOut).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getAllByRole('button', { name: en.cancel }).at(-1)!)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(operations.signOut).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: fill(en.signOutFor, { email: 'b@x.com' }) }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.signOutAction }))
    await waitFor(() => { expect(operations.signOut).toHaveBeenCalledWith('b@x.com') })
    expect((await screen.findByRole('status')).textContent).toBe(fill(en.signOutDone, { email: 'b@x.com' }))
  })

  it('offers no sign-out for an account that is not signed in, and shows a refused sign-out as an alert', async () => {
    const { operations } = await mount(THREE)
    await screen.findByRole('radiogroup')
    expect(screen.queryByRole('button', { name: fill(en.signOutFor, { email: 'c@x.com' }) })).toBeNull()
    operations.signOut.mockResolvedValueOnce({ kind: 'refused', message: 'in use' })
    fireEvent.click(screen.getByRole('button', { name: fill(en.signOutFor, { email: 'b@x.com' }) }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.signOutAction }))
    expect((await screen.findByRole('alert')).textContent).toBe(fill(en.signOutFailed, { reason: 'in use' }))
  })

  it('disables every write control and says why when settings are read-only', async () => {
    await mount(THREE, settings({ writable: false }))
    expect(await screen.findByText(en.readOnly)).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'b@x.com' })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.addLabel)).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: fill(en.removeFor, { email: 'b@x.com' }) })).toHaveProperty('disabled', true)
  })

  it('reports a status read that failed', async () => {
    await mount(undefined)
    expect((await screen.findByText(en.loadFailed)).getAttribute('role')).toBe('alert')
  })

  it('stops polling when it unmounts', async () => {
    const { controller } = await mount(THREE)
    const stop = vi.spyOn(controller, 'stop')
    cleanup()
    expect(stop).toHaveBeenCalled()
  })
})
