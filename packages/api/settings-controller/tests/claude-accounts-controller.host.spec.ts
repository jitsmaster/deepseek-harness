import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ClaudeAccountsService, ClaudeAccountsStatus } from '@deepseek-ai/dsh-llm-claude-code/types'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import ClaudeAccountsController from '../src/claude-accounts.ts'

const STATUS: ClaudeAccountsStatus = {
  accounts: [
    {
      email: 'a@x.com',
      id: 'a-at-x.com-1',
      signedIn: true,
      active: true,
      signedInAt: 1_000,
      usage: {
        updatedAt: 2_000,
        fiveHour: { utilization: 0.2, resetsAt: 3_000 },
        sevenDay: { utilization: 0.4, resetsAt: 4_000 },
      },
    },
    { email: 'b@x.com', id: 'b-at-x.com-2', signedIn: false, active: false },
  ],
  defaultAccount: { email: 'a@x.com' },
  activeAccount: 'a@x.com',
}

async function boot(service?: ClaudeAccountsService): Promise<Context> {
  const ctx = new Context()
  if (service !== undefined) ctx.provide('claudeAccounts', service)
  await ctx.plugin(ClaudeAccountsController)
  return ctx
}

describe('the claudeAccounts Remote namespace a configuration surface calls', () => {
  it('publishes the namespace from its own service key with three direct methods', async () => {
    const ctx = await boot()
    const controller = ctx.claudeAccountsController
    expect(controller.typertRemote.serviceKey).toBe('claudeAccountsController')
    expect(controller.typertRemote.namespace).toBe('claudeAccounts')
    expect(remoteMethods(controller)).toEqual([
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'makeDefault', invocation: { kind: 'direct' } },
      { method: 'signOut', invocation: { kind: 'direct' } },
    ])
  })

  it('answers an empty status while the Claude Code plugin is not mounted', async () => {
    const ctx = await boot()
    expect(await ctx.claudeAccountsController.status()).toEqual({ accounts: [], defaultAccount: {} })
    const failure = await ctx.claudeAccountsController.makeDefault('a@x.com').catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/internal', details: {} })
  })

  it('projects the status field by field, so extra service fields never reach the wire', async () => {
    const leaky = {
      status: () => Promise.resolve({
        ...STATUS,
        token: 'sk-leak',
        accounts: STATUS.accounts.map(account => ({
          ...account,
          credentials: 'sk-leak',
          ...account.usage === undefined ? {} : { usage: { ...account.usage, raw: 'sk-leak', fiveHour: { utilization: 0.2, resetsAt: 3_000, secret: 'sk-leak' } } },
        })),
      }),
      makeDefault: () => Promise.resolve({ ok: true as const, backupDir: 'D:/b', unchanged: false, token: 'sk-leak' }),
      signOut: () => Promise.resolve({ ok: true as const }),
    } as ClaudeAccountsService
    const ctx = await boot(leaky)
    const status = await ctx.claudeAccountsController.status()
    expect(status).toEqual({
      ...STATUS,
      accounts: [
        { ...STATUS.accounts[0], usage: { ...STATUS.accounts[0]!.usage, sevenDay: { utilization: 0.4, resetsAt: 4_000 } } },
        STATUS.accounts[1],
      ],
    })
    expect(JSON.stringify(status)).not.toContain('sk-leak')
    expect(JSON.stringify(await ctx.claudeAccountsController.makeDefault('a@x.com'))).not.toContain('sk-leak')
  })

  it('omits an absent default email and active account', async () => {
    const ctx = await boot({ status: () => Promise.resolve({ accounts: [], defaultAccount: {} }), makeDefault: () => Promise.reject(new Error('unused')), signOut: () => Promise.reject(new Error('unused')) })
    expect(await ctx.claudeAccountsController.status()).toEqual({ accounts: [], defaultAccount: {} })
  })

  it('maps both makeDefault outcomes and passes the email through', async () => {
    const seen: string[] = []
    const ctx = await boot({
      status: () => Promise.resolve(STATUS),
      makeDefault: (email) => {
        seen.push(email)
        return Promise.resolve(email === 'a@x.com' ? { ok: true, backupDir: 'D:/backup', unchanged: false } : { ok: false, reason: 'not signed in' })
      },
      signOut: () => Promise.reject(new Error('unused')),
    })
    expect(await ctx.claudeAccountsController.makeDefault('a@x.com')).toEqual({ ok: true, backupDir: 'D:/backup', unchanged: false })
    expect(await ctx.claudeAccountsController.makeDefault('b@x.com')).toEqual({ ok: false, reason: 'not signed in' })
    expect(seen).toEqual(['a@x.com', 'b@x.com'])
  })

  it('maps both signOut outcomes without leaking extra service fields, and passes the email through', async () => {
    const seen: string[] = []
    const ctx = await boot({
      status: () => Promise.resolve(STATUS),
      makeDefault: () => Promise.reject(new Error('unused')),
      signOut: (email) => {
        seen.push(email)
        return Promise.resolve(email === 'a@x.com' ? { ok: true, token: 'sk-leak' } as { ok: true } : { ok: false, reason: 'not signed in' })
      },
    })
    const done = await ctx.claudeAccountsController.signOut('a@x.com')
    expect(done).toEqual({ ok: true })
    expect(JSON.stringify(done)).not.toContain('sk-leak')
    expect(await ctx.claudeAccountsController.signOut('b@x.com')).toEqual({ ok: false, reason: 'not signed in' })
    expect(seen).toEqual(['a@x.com', 'b@x.com'])
  })

  it('answers signOut with gateway/internal while the Claude Code plugin is not mounted', async () => {
    const ctx = await boot()
    const failure = await ctx.claudeAccountsController.signOut('a@x.com').catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/internal' })
  })

  it('rejects a value that is not an email as a bad request without calling the service', async () => {
    let calls = 0
    const ctx = await boot({ status: () => Promise.resolve(STATUS), makeDefault: () => { calls += 1; return Promise.reject(new Error('unused')) }, signOut: () => { calls += 1; return Promise.reject(new Error('unused')) } })
    for (const bad of ['', 'nobody', 'a b@x.com', '@x.com', `${'a'.repeat(400)}@x.com`]) {
      const failure = await ctx.claudeAccountsController.makeDefault(bad).catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
      const signOutFailure = await ctx.claudeAccountsController.signOut(bad).catch((error: unknown) => error)
      expect(remoteErrorOf(signOutFailure)).toMatchObject({ code: 'gateway/bad-request' })
    }
    expect(calls).toBe(0)
  })

  it('stops answering once the plugin withdraws its service', async () => {
    const ctx = new Context()
    const dispose = ctx.provide('claudeAccounts', { status: () => Promise.resolve(STATUS), makeDefault: () => Promise.reject(new Error('unused')), signOut: () => Promise.reject(new Error('unused')) })
    await ctx.plugin(ClaudeAccountsController)
    expect((await ctx.claudeAccountsController.status()).accounts).toHaveLength(2)
    dispose()
    expect(await ctx.claudeAccountsController.status()).toEqual({ accounts: [], defaultAccount: {} })
  })
})
