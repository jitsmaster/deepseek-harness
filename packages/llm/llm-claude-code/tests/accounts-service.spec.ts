import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as claudeCodePlugin from '../src/index.ts'
import { ACCOUNT_KEY, accountId, accountsRecord } from '../src/account.ts'
import { defaultConfigPaths } from '../src/default-login.ts'
import { createClaudeAccountsService } from '../src/service.ts'
import type { ClaudeAccountsDeps } from '../src/service.ts'
import { FakeClaudeSubprocess } from './harness.ts'

let scratch: string
let accountsDir: string
let defaultDir: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-claude-accounts-svc-'))
  accountsDir = join(scratch, 'accounts')
  defaultDir = join(scratch, 'default')
  mkdirSync(defaultDir, { recursive: true })
})
afterEach(() => { rmSync(scratch, { recursive: true, force: true }) })

/** The shape of the fake settings file these tests read back. */
const oauthEmail = (path: string): string => (JSON.parse(readFileSync(path, 'utf8')) as { oauthAccount: { emailAddress: string } }).oauthAccount.emailAddress

const entry = (email: string): { id: string; email: string; signedInAt: string } => ({ id: accountId(email), email, signedInAt: '2026-10-27T10:00:00.000Z' })

/** An account folder with a fake login and profile; `usage` writes a usage.json beside it. */
function signIn(email: string, usage?: object): void {
  const dir = join(accountsDir, accountId(email))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `secret-${email}` } }))
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email } }))
  if (usage !== undefined) writeFileSync(join(dir, 'usage.json'), JSON.stringify(usage))
}

function deps(overrides: Partial<ClaudeAccountsDeps> & { listed?: string[]; signed?: string[] } = {}): ClaudeAccountsDeps {
  const { listed = [], signed = [], ...rest } = overrides
  return {
    accountsDir,
    accounts: () => listed,
    activeAccount: () => undefined,
    readRecord: () => Promise.resolve(signed.length === 0 ? undefined : accountsRecord(signed.map(entry))),
    defaultPaths: () => defaultConfigPaths({ dir: defaultDir, home: scratch }),
    log: () => undefined,
    ...rest,
  }
}

describe('claudeAccounts.status', () => {
  it('lists configured emails first, then other signed-in accounts, with sign-in state', async () => {
    signIn('a@x.com')
    signIn('c@x.com')
    const status = await createClaudeAccountsService(deps({ listed: ['B@x.com', ' a@X.com ', 'a@x.com', 'not-an-email'], signed: ['a@x.com', 'c@x.com'] })).status()
    expect(status.accounts.map(a => [a.email, a.signedIn])).toEqual([['b@x.com', false], ['a@x.com', true], ['c@x.com', true]])
    expect(status.accounts[0]).toEqual({ email: 'b@x.com', id: accountId('b@x.com'), signedIn: false, active: false })
    expect(status.accounts[1]).toMatchObject({ id: accountId('a@x.com'), signedInAt: Date.parse('2026-10-27T10:00:00.000Z') })
    expect(status.defaultAccount).toEqual({})
    expect(status.activeAccount).toBeUndefined()
  })

  it('marks the active account and reports it', async () => {
    signIn('a@x.com')
    signIn('b@x.com')
    const status = await createClaudeAccountsService(deps({ listed: ['a@x.com', 'b@x.com'], signed: ['a@x.com', 'b@x.com'], activeAccount: () => 'B@x.com' })).status()
    expect(status.accounts.map(a => [a.email, a.active])).toEqual([['a@x.com', false], ['b@x.com', true]])
    expect(status.activeAccount).toBe('b@x.com')
  })

  it('treats a recorded account whose login file is gone as not signed in', async () => {
    const status = await createClaudeAccountsService(deps({ listed: ['a@x.com'], signed: ['a@x.com'] })).status()
    expect(status.accounts).toEqual([{ email: 'a@x.com', id: accountId('a@x.com'), signedIn: false, active: false }])
  })

  it('reports each account usage with epoch-millisecond updatedAt and no extra fields', async () => {
    signIn('a@x.com', { updatedAt: '2026-10-27T12:00:00.000Z', fiveHour: { utilization: 0.25, resetsAt: 1793134800 }, sevenDay: { utilization: 0.5, resetsAt: 1793232000 }, extra: 'leak' })
    signIn('b@x.com', { updatedAt: '2026-10-27T11:00:00.000Z', sevenDay: { utilization: 0.1, resetsAt: 1793232000 } })
    signIn('c@x.com')
    const status = await createClaudeAccountsService(deps({ listed: ['a@x.com', 'b@x.com', 'c@x.com'], signed: ['a@x.com', 'b@x.com', 'c@x.com'] })).status()
    expect(status.accounts[0]!.usage).toEqual({
      updatedAt: Date.parse('2026-10-27T12:00:00.000Z'),
      fiveHour: { utilization: 0.25, resetsAt: 1793134800 },
      sevenDay: { utilization: 0.5, resetsAt: 1793232000 },
    })
    expect(status.accounts[1]!.usage).toEqual({ updatedAt: Date.parse('2026-10-27T11:00:00.000Z'), sevenDay: { utilization: 0.1, resetsAt: 1793232000 } })
    expect(status.accounts[2]).not.toHaveProperty('usage')
  })

  it('reads the default config email, and tolerates an absent or broken file', async () => {
    const service = createClaudeAccountsService(deps())
    expect((await service.status()).defaultAccount).toEqual({})
    writeFileSync(join(defaultDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'Me@X.com' } }))
    expect((await service.status()).defaultAccount).toEqual({ email: 'me@x.com' })
    writeFileSync(join(defaultDir, '.claude.json'), 'garbage')
    expect((await service.status()).defaultAccount).toEqual({})
  })

  it('degrades to an empty status when the record read fails', async () => {
    const status = await createClaudeAccountsService(deps({ listed: ['a@x.com'], readRecord: () => Promise.reject(new Error('boom')) })).status()
    expect(status.accounts.map(a => a.signedIn)).toEqual([false])
  })

  it('never carries a token', async () => {
    signIn('a@x.com', { updatedAt: '2026-10-27T12:00:00.000Z' })
    const status = await createClaudeAccountsService(deps({ listed: ['a@x.com'], signed: ['a@x.com'] })).status()
    expect(JSON.stringify(status)).not.toContain('secret-')
  })
})

describe('claudeAccounts.makeDefault', () => {
  it('swaps a signed-in account into the default config', async () => {
    signIn('a@x.com')
    const logs: string[] = []
    const service = createClaudeAccountsService(deps({ listed: ['a@x.com'], signed: ['a@x.com'], log: message => logs.push(message) }))
    const outcome = await service.makeDefault('A@x.com')
    expect(outcome).toMatchObject({ ok: true, unchanged: false })
    expect(oauthEmail(join(defaultDir, '.claude.json'))).toBe('a@x.com')
    expect(readFileSync(join(defaultDir, '.credentials.json'), 'utf8')).toContain('secret-a@x.com')
    expect((await service.status()).defaultAccount).toEqual({ email: 'a@x.com' })
    expect(logs).toHaveLength(1)
    expect(logs[0]).not.toContain('secret-')
  })

  it('refuses an account that has not signed in, and one that is not known', async () => {
    const service = createClaudeAccountsService(deps({ listed: ['a@x.com', 'b@x.com'], signed: ['a@x.com'] }))
    expect(await service.makeDefault('a@x.com')).toEqual({ ok: false, reason: expect.stringContaining('has not signed in') as string })
    expect(await service.makeDefault('nobody@x.com')).toEqual({ ok: false, reason: expect.stringContaining('has not signed in') as string })
    expect(() => readFileSync(join(defaultDir, '.credentials.json'))).toThrow()
  })

  it('saves the default login back into the account that owns it when swapping away', async () => {
    signIn('a@x.com')
    signIn('b@x.com')
    const service = createClaudeAccountsService(deps({ listed: ['a@x.com', 'b@x.com'], signed: ['a@x.com', 'b@x.com'] }))
    await service.makeDefault('a@x.com')
    writeFileSync(join(defaultDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'secret-a-refreshed' } }))
    expect((await service.makeDefault('b@x.com')).ok).toBe(true)
    expect(readFileSync(join(accountsDir, accountId('a@x.com'), '.credentials.json'), 'utf8')).toContain('secret-a-refreshed')
  })

  it('serializes concurrent swaps and never rejects', async () => {
    signIn('a@x.com')
    signIn('b@x.com')
    const service = createClaudeAccountsService(deps({ listed: ['a@x.com', 'b@x.com'], signed: ['a@x.com', 'b@x.com'] }))
    const outcomes = await Promise.all([service.makeDefault('a@x.com'), service.makeDefault('b@x.com'), service.makeDefault('a@x.com')])
    expect(outcomes.every(outcome => outcome.ok)).toBe(true)
    expect((await service.status()).defaultAccount).toEqual({ email: 'a@x.com' })
    const broken = createClaudeAccountsService(deps({ listed: ['a@x.com'], signed: ['a@x.com'], defaultPaths: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }) } }))
    expect(await broken.makeDefault('a@x.com')).toEqual({ ok: false, reason: expect.stringContaining('EACCES') as string })
    expect(await broken.status()).toEqual({ accounts: [], defaultAccount: {} })
  })
})

describe('the claudeAccounts service of the mounted plugin', () => {
  it('is provided only while the plugin is mounted, and honours defaultConfigDir', async () => {
    signIn('a@x.com')
    const root = new Context()
    await root.plugin(FakeClaudeSubprocess)
    await root.plugin(LlmRuntime)
    root.provide('credentials', { readRecord: (key: string) => Promise.resolve(key === ACCOUNT_KEY ? accountsRecord([entry('a@x.com')]) : undefined) } as never)
    expect(root.get('claudeAccounts')).toBeUndefined()
    const fiber = await root.plugin(claudeCodePlugin, { executable: process.execPath, accountsDir, accounts: ['a@x.com'], activeAccount: 'a@x.com', defaultConfigDir: defaultDir })
    const service = root.get('claudeAccounts')
    expect(service).toBeDefined()
    const status = await service!.status()
    expect(status.accounts.map(a => [a.email, a.signedIn, a.active])).toEqual([['a@x.com', true, true]])
    expect((await service!.makeDefault('a@x.com')).ok).toBe(true)
    expect(oauthEmail(join(defaultDir, '.claude.json'))).toBe('a@x.com')
    await fiber.dispose()
    expect(root.get('claudeAccounts')).toBeUndefined()
    await root.fiber.dispose()
  }, 30_000)

  it('accepts defaultConfigDir in the config schema', () => {
    expect(() => claudeCodePlugin.Config({ defaultConfigDir: 'C:\\claude-default' })).not.toThrow()
    expect(() => claudeCodePlugin.Config({ defaultConfigDir: '' })).toThrow()
  })
})
