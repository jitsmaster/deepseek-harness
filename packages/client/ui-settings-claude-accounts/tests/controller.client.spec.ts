import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeAccountsStatusView, ClaudeAccountView } from '@deepseek-ai/dsh-api-remotes/client'
import { ClaudeAccountsController, POLL_INTERVAL_MS } from '../src/client/controller.ts'
import type { ClaudeAccountsOperations, ClaudeSettingsSnapshot } from '../src/client/operations.ts'

const NOW = 1_800_000_000_000

function row(email: string, overrides: Partial<ClaudeAccountView> = {}): ClaudeAccountView {
  return { email, id: email.replace('@', '-at-'), signedIn: true, active: false, ...overrides }
}

function snapshot(overrides: Partial<ClaudeSettingsSnapshot> = {}): ClaudeSettingsSnapshot {
  return { configured: true, writable: true, revision: 3, accounts: ['a@x.com', 'b@x.com'], activeAccount: 'a@x.com', ...overrides }
}

/** Fake Host: mutable status and settings, call logs, and per-test overrides. */
function host(initial: { status?: ClaudeAccountsStatusView; settings?: ClaudeSettingsSnapshot } = {}) {
  const state = {
    status: ('status' in initial ? initial.status : {
      accounts: [row('a@x.com', { active: true }), row('b@x.com')],
      defaultAccount: { email: 'B@x.com' },
      activeAccount: 'a@x.com',
    }) as ClaudeAccountsStatusView | undefined,
    settings: ('settings' in initial ? initial.settings : snapshot()) as ClaudeSettingsSnapshot | undefined,
  }
  const operations = {
    readStatus: vi.fn(() => Promise.resolve(state.status)),
    readSettings: vi.fn(() => Promise.resolve(state.settings)),
    writeSettings: vi.fn((): ReturnType<ClaudeAccountsOperations['writeSettings']> => Promise.resolve({ kind: 'written', snapshot: snapshot({ revision: 4 }) })),
    makeDefault: vi.fn((): ReturnType<ClaudeAccountsOperations['makeDefault']> => Promise.resolve({ kind: 'done', unchanged: false })),
  } satisfies ClaudeAccountsOperations
  return { state, operations }
}

async function ready(h = host()) {
  const controller = new ClaudeAccountsController(h.operations, () => NOW)
  await controller.refresh(true)
  return { controller, h }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('ClaudeAccountsController reads', () => {
  it('joins settings and status into rows with listed, default, and least-used marks', async () => {
    const h = host({
      status: {
        accounts: [
          row('a@x.com', { active: true, usage: { updatedAt: 1, fiveHour: { utilization: 0.6, resetsAt: 9 }, sevenDay: { utilization: 0.7, resetsAt: 9 } } }),
          row('b@x.com', { usage: { updatedAt: 1, sevenDay: { utilization: 0.2, resetsAt: 9 } } }),
          row('c@x.com', { signedIn: false }),
        ],
        defaultAccount: { email: 'B@X.com' },
        activeAccount: 'a@x.com',
      },
    })
    const { controller } = await ready(h)
    const state = controller.store.getSnapshot()
    expect(state).toMatchObject({ status: 'ready', writable: true, loadFailed: false, busy: false, now: NOW })
    expect(state.rows.map(r => [r.email, r.listed, r.leastUsed, r.isDefault])).toEqual([
      ['a@x.com', true, false, false],
      ['b@x.com', true, true, true],
      ['c@x.com', false, false, false],
    ])
  })

  it('is unavailable, and asks no status, while the profile has no Claude Code plugin', async () => {
    const h = host({ settings: snapshot({ configured: false, writable: false, accounts: [] }) })
    const { controller } = await ready(h)
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'unavailable', rows: [] })
    expect(h.operations.readStatus).not.toHaveBeenCalled()
  })

  it('reports a failed first read, and keeps the last good rows through a later failure', async () => {
    const h = host({})
    h.state.settings = undefined
    h.state.status = undefined
    const controller = new ClaudeAccountsController(h.operations, () => NOW)
    await controller.refresh(true)
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'idle', loadFailed: true })

    h.state.settings = snapshot()
    await controller.refresh(true)
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', loadFailed: true, rows: [] })

    h.state.status = { accounts: [row('a@x.com')], defaultAccount: {} }
    await controller.refresh(false)
    expect(controller.store.getSnapshot()).toMatchObject({ loadFailed: false })
    h.state.status = undefined
    await controller.refresh(false)
    expect(controller.store.getSnapshot()).toMatchObject({ loadFailed: false })
    expect(controller.store.getSnapshot().rows).toHaveLength(1)
  })

  it('reads settings once and status on every later refresh unless settings are asked for', async () => {
    const { controller, h } = await ready()
    await controller.refresh(false)
    await controller.refresh(false)
    expect(h.operations.readSettings).toHaveBeenCalledTimes(1)
    expect(h.operations.readStatus).toHaveBeenCalledTimes(3)
    await controller.refresh(true)
    expect(h.operations.readSettings).toHaveBeenCalledTimes(2)
  })

  it('folds a refresh requested during a read into one follow-up read', async () => {
    const h = host()
    let release: () => void = () => undefined
    h.operations.readStatus.mockImplementationOnce(() => new Promise((resolve) => { release = () => { resolve(h.state.status) } }))
    const controller = new ClaudeAccountsController(h.operations, () => NOW)
    const first = controller.refresh(true)
    await vi.advanceTimersByTimeAsync(0)
    void controller.refresh(false)
    void controller.refresh(true)
    release()
    await first
    await vi.advanceTimersByTimeAsync(0)
    expect(h.operations.readStatus).toHaveBeenCalledTimes(2)
    expect(h.operations.readSettings).toHaveBeenCalledTimes(2)
  })
})

describe('ClaudeAccountsController polling', () => {
  it('reads at once, then every 15 seconds until stopped', async () => {
    const h = host()
    const controller = new ClaudeAccountsController(h.operations, () => NOW)
    const stop = controller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.operations.readStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(h.operations.readStatus).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    expect(h.operations.readStatus).toHaveBeenCalledTimes(4)
    stop()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    expect(h.operations.readStatus).toHaveBeenCalledTimes(4)
  })

  it('does not start a second timer, and ignores answers after dispose', async () => {
    const h = host()
    const controller = new ClaudeAccountsController(h.operations, () => NOW)
    controller.start()
    controller.start()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(h.operations.readStatus).toHaveBeenCalledTimes(3)
    controller.dispose()
    const before = controller.store.getSnapshot()
    await controller.refresh(true)
    expect(controller.store.getSnapshot()).toEqual(before)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    expect(h.operations.readStatus.mock.calls.length).toBeLessThanOrEqual(4)
  })
})

describe('ClaudeAccountsController actions', () => {
  it('selects an account by writing activeAccount at the revision it read, then re-reads', async () => {
    const { controller, h } = await ready()
    await controller.select('B@x.com')
    expect(h.operations.writeSettings).toHaveBeenCalledWith([{ op: 'set', path: ['activeAccount'], value: 'b@x.com' }], 3)
    expect(h.operations.readStatus).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot()).toMatchObject({ busy: false, notice: undefined })
  })

  it('adds a normalized email to the configured list', async () => {
    const { controller, h } = await ready()
    expect(await controller.add('  New@X.com ')).toBeUndefined()
    expect(h.operations.writeSettings).toHaveBeenCalledWith([{ op: 'set', path: ['accounts'], value: ['a@x.com', 'b@x.com', 'new@x.com'] }], 3)
  })

  it('refuses an invalid or duplicate email without writing', async () => {
    const { controller, h } = await ready()
    expect(await controller.add('nope')).toBe('addInvalid')
    expect(await controller.add('A@x.com')).toBe('addDuplicate')
    h.state.status = { accounts: [row('only-signed-in@x.com')], defaultAccount: {} }
    await controller.refresh(false)
    expect(await controller.add('only-signed-in@x.com')).toBe('addDuplicate')
    expect(h.operations.writeSettings).not.toHaveBeenCalled()
  })

  it('removes an email, and stops its being active', async () => {
    const { controller, h } = await ready()
    await controller.remove('A@x.com')
    expect(h.operations.writeSettings).toHaveBeenCalledWith([
      { op: 'set', path: ['accounts'], value: ['b@x.com'] },
      { op: 'unset', path: ['activeAccount'] },
    ], 3)
    h.operations.writeSettings.mockClear()
    await controller.remove('b@x.com')
    expect(h.operations.writeSettings).toHaveBeenCalledWith([{ op: 'set', path: ['accounts'], value: ['a@x.com'] }], 4)
  })

  it('reports a stale revision as a conflict and re-reads settings', async () => {
    const { controller, h } = await ready()
    h.operations.writeSettings.mockResolvedValueOnce({ kind: 'conflict' })
    await controller.select('b@x.com')
    expect(controller.store.getSnapshot().notice).toEqual({ kind: 'error', key: 'conflict', values: {} })
    expect(h.operations.readSettings).toHaveBeenCalledTimes(2)
  })

  it('reports a refused write with the Host message', async () => {
    const { controller, h } = await ready()
    h.operations.writeSettings.mockResolvedValueOnce({ kind: 'refused', message: 'read-only' })
    await controller.select('b@x.com')
    expect(controller.store.getSnapshot().notice).toEqual({ kind: 'error', key: 'saveFailed', values: { message: 'read-only' } })
  })

  it('makes an account the default and says how it went', async () => {
    const { controller, h } = await ready()
    await controller.makeDefault('a@x.com')
    expect(h.operations.makeDefault).toHaveBeenCalledWith('a@x.com')
    expect(controller.store.getSnapshot().notice).toEqual({ kind: 'success', key: 'makeDefaultDone', values: { email: 'a@x.com' } })
    expect(h.operations.readStatus).toHaveBeenCalledTimes(2)

    h.operations.makeDefault.mockResolvedValueOnce({ kind: 'done', unchanged: true })
    await controller.makeDefault('a@x.com')
    expect(controller.store.getSnapshot().notice).toMatchObject({ key: 'makeDefaultUnchanged' })

    h.operations.makeDefault.mockResolvedValueOnce({ kind: 'refused', message: 'nope' })
    await controller.makeDefault('a@x.com')
    expect(controller.store.getSnapshot().notice).toEqual({ kind: 'error', key: 'makeDefaultFailed', values: { reason: 'nope' } })
    expect(controller.store.getSnapshot().busy).toBe(false)
  })

  it('marks the card busy while a write is in flight', async () => {
    const { controller, h } = await ready()
    let release: () => void = () => undefined
    h.operations.writeSettings.mockImplementationOnce(() => new Promise((resolve) => { release = () => { resolve({ kind: 'written', snapshot: snapshot() }) } }))
    const pending = controller.select('b@x.com')
    expect(controller.store.getSnapshot().busy).toBe(true)
    release()
    await pending
    expect(controller.store.getSnapshot().busy).toBe(false)
  })

  it('re-reads everything after a sign-in settles', async () => {
    const { controller, h } = await ready()
    await controller.afterSignIn()
    expect(h.operations.readSettings).toHaveBeenCalledTimes(2)
    expect(h.operations.readStatus).toHaveBeenCalledTimes(2)
  })

  it('drops an answer that arrives after dispose', async () => {
    const { controller, h } = await ready()
    let release: () => void = () => undefined
    h.operations.makeDefault.mockImplementationOnce(() => new Promise((resolve) => { release = () => { resolve({ kind: 'done', unchanged: false }) } }))
    const pending = controller.makeDefault('a@x.com')
    controller.dispose()
    release()
    await pending
    expect(controller.store.getSnapshot().notice).toBeUndefined()
    h.operations.writeSettings.mockImplementationOnce(() => new Promise((resolve) => { release = () => { resolve({ kind: 'conflict' }) } }))
    const write = controller.select('b@x.com')
    release()
    await write
    expect(controller.store.getSnapshot().notice).toBeUndefined()
  })
})
