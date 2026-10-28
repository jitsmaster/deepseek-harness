/** What the browser half registers, what its Host operations ask and map, and that it all leaves with the fiber. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject, NS } from '../src/client/index.ts'
import type { ClaudeAccountsFace } from '../src/client/index.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'
import { CLAUDE_CODE_SETTINGS_NS, createClaudeAccountsOperations } from '../src/client/operations.ts'
import { apply as hostApply } from '../src/index.ts'

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}
const fail = (code: string, message: string): { ok: false; error: RemoteError } => ({
  ok: false,
  error: new RemoteError(code as never, message, {} as never),
})

function namespaceView(value: unknown, revision = 2) {
  return { ns: CLAUDE_CODE_SETTINGS_NS, schema: {}, value, applies: 'live', secrets: [], revision }
}

interface Scripts {
  describe?: () => unknown
  mutate?: () => unknown
  status?: () => unknown
  makeDefault?: () => unknown
  signOut?: () => unknown
}

async function bench(scripts: Scripts = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const settings = {
    describe: vi.fn(scripts.describe ?? (() => Promise.resolve(ok({
      writable: true,
      hasDocument: true,
      namespaces: [namespaceView({ accounts: ['a@x.com', 7, 'b@x.com'], activeAccount: 'a@x.com' })],
    })))),
    mutate: vi.fn(scripts.mutate ?? (() => Promise.resolve(ok(namespaceView({ accounts: ['a@x.com'] }, 3))))),
  }
  const claudeAccounts = {
    status: vi.fn(scripts.status ?? (() => Promise.resolve(ok({ accounts: [], defaultAccount: {} })))),
    makeDefault: vi.fn(scripts.makeDefault ?? (() => Promise.resolve(ok({ ok: true, backupDir: 'D:/b', unchanged: false })))),
    signOut: vi.fn(scripts.signOut ?? (() => Promise.resolve(ok({ ok: true })))),
  }
  const remote = new TestRemote(ctx, { settings, authorization: {}, claudeAccounts })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, remote, settings, claudeAccounts }
}

/** The Models page's footer slot, as its owner declares it. */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.models.footer': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-claude-accounts apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.settings', 'remote.authorization', 'remote.claudeAccounts'])
  })

  it('registers one card into the Models footer slot with its face', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await vi.waitFor(() => { expect(slots.entries('settings.models.footer')).toHaveLength(1) })
    const entry = slots.entries('settings.models.footer')[0]!
    expect(entry.options).toMatchObject({ id: 'claude-accounts', order: 100 })
    expect(entry.locale).toBe(NS)
    const face = (entry.inject as unknown as () => ClaudeAccountsFace)()
    expect(Object.keys(face.hooks)).toEqual(['claudeAccounts'])
    expect(typeof face.controller.select).toBe('function')
    expect(typeof face.authOperations.beginAuthorization).toBe('function')
  })

  it('re-reads settings on a document change, a settled sign-in, and a reconnect, then stops on teardown', async () => {
    const { ctx, slots, remote, settings } = await bench()
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await vi.waitFor(() => { expect(slots.entries('settings.models.footer')).toHaveLength(1) })
    const face = (slots.entries('settings.models.footer')[0]!.inject as unknown as () => ClaudeAccountsFace)()
    await face.controller.refresh(true)
    const base = settings.describe.mock.calls.length

    remote.emit('settings/document-updated', [CLAUDE_CODE_SETTINGS_NS, 5])
    await vi.waitFor(() => { expect(settings.describe.mock.calls.length).toBe(base + 1) })
    remote.emit('authorization/settled', [])
    await vi.waitFor(() => { expect(settings.describe.mock.calls.length).toBe(base + 2) })
    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(settings.describe.mock.calls.length).toBe(base + 3) })

    await fiber.dispose()
    expect(slots.entries('settings.models.footer')).toHaveLength(0)
    remote.emit('settings/document-updated', [CLAUDE_CODE_SETTINGS_NS, 6])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settings.describe.mock.calls.length).toBe(base + 3)
  })
})

describe('Claude accounts operations over the Remote namespaces', () => {
  async function operations(scripts: Scripts = {}) {
    const b = await bench(scripts)
    return { ...b, ops: createClaudeAccountsOperations(b.ctx) }
  }

  it('reads the plugin entry out of the settings description', async () => {
    const { ops } = await operations()
    expect(await ops.readSettings()).toEqual({ configured: true, writable: true, revision: 2, accounts: ['a@x.com', 'b@x.com'], activeAccount: 'a@x.com' })
  })

  it('reports an entry the Host does not serve as not configured, and an unreadable or odd value as empty', async () => {
    const absent = await operations({ describe: () => Promise.resolve(ok({ writable: true, hasDocument: true, namespaces: [] })) })
    expect(await absent.ops.readSettings()).toMatchObject({ configured: false, accounts: [] })
    const odd = await operations({ describe: () => Promise.resolve(ok({ writable: false, hasDocument: true, namespaces: [namespaceView('text')] })) })
    expect(await odd.ops.readSettings()).toEqual({ configured: true, writable: false, revision: 2, accounts: [], activeAccount: undefined })
    const blank = await operations({ describe: () => Promise.resolve(ok({ writable: true, hasDocument: true, namespaces: [namespaceView({ accounts: 'x', activeAccount: '' })] })) })
    expect(await blank.ops.readSettings()).toMatchObject({ accounts: [], activeAccount: undefined })
    const refused = await operations({ describe: () => Promise.resolve(fail('gateway/internal', 'down')) })
    expect(await refused.ops.readSettings()).toBeUndefined()
  })

  it('writes path operations to the plugin namespace and maps the outcomes', async () => {
    const written = await operations()
    const ops = [{ op: 'set' as const, path: ['accounts'], value: ['a@x.com'] }]
    expect(await written.ops.writeSettings(ops, 2)).toMatchObject({ kind: 'written', snapshot: { revision: 3, accounts: ['a@x.com'] } })
    expect(written.settings.mutate).toHaveBeenCalledWith(CLAUDE_CODE_SETTINGS_NS, ops, 2)
    const stale = await operations({ mutate: () => Promise.resolve(fail('settings/conflict', 'moved')) })
    expect(await stale.ops.writeSettings(ops, 2)).toEqual({ kind: 'conflict' })
    const refused = await operations({ mutate: () => Promise.resolve(fail('settings/rejected', 'read-only')) })
    expect(await refused.ops.writeSettings(ops, undefined)).toEqual({ kind: 'refused', message: 'read-only' })
  })

  it('reads status, and swaps a default login through the claudeAccounts namespace', async () => {
    const view = { accounts: [], defaultAccount: { email: 'a@x.com' } }
    const good = await operations({ status: () => Promise.resolve(ok(view)) })
    expect(await good.ops.readStatus()).toEqual(view)
    expect(await good.ops.makeDefault('a@x.com')).toEqual({ kind: 'done', unchanged: false })
    expect(good.claudeAccounts.makeDefault).toHaveBeenCalledWith('a@x.com')
    const bad = await operations({
      status: () => Promise.resolve(fail('gateway/internal', 'down')),
      makeDefault: () => Promise.resolve(fail('gateway/bad-request', 'invalid email')),
    })
    expect(await bad.ops.readStatus()).toBeUndefined()
    expect(await bad.ops.makeDefault('x')).toEqual({ kind: 'refused', message: 'invalid email' })
    const declined = await operations({ makeDefault: () => Promise.resolve(ok({ ok: false, reason: 'not signed in' })) })
    expect(await declined.ops.makeDefault('a@x.com')).toEqual({ kind: 'refused', message: 'not signed in' })
  })

  it('maps a sign-out to done, to the reason a signed-in-less account gives, and to a refused call', async () => {
    const good = await operations()
    expect(await good.ops.signOut('a@x.com')).toEqual({ kind: 'done' })
    expect(good.claudeAccounts.signOut).toHaveBeenCalledWith('a@x.com')
    const declined = await operations({ signOut: () => Promise.resolve(ok({ ok: false, reason: 'a@x.com is not signed in' })) })
    expect(await declined.ops.signOut('a@x.com')).toEqual({ kind: 'refused', message: 'a@x.com is not signed in' })
    const bad = await operations({ signOut: () => Promise.resolve(fail('gateway/bad-request', 'invalid email')) })
    expect(await bad.ops.signOut('x')).toEqual({ kind: 'refused', message: 'invalid email' })
  })
})

describe('Claude accounts locales', () => {
  it('ships every language with the same keys and the same placeholders as English', () => {
    const keys = Object.keys(en).sort()
    const holes = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]!).sort()
    for (const [code, bundle] of Object.entries({ zh, ja, es, fr, de, ru, pt })) {
      expect(Object.keys(bundle).sort(), code).toEqual(keys)
      for (const key of keys) {
        expect(holes((bundle as Record<string, string>)[key]!), `${code}.${key}`).toEqual(holes((en as Record<string, string>)[key]!))
      }
    }
  })
})
