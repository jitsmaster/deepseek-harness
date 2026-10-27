import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BACKUPS_DIR,
  defaultConfigPaths,
  KEEP_BACKUPS,
  makeDefaultLogin,
  readDefaultEmail,
} from '../src/default-login.ts'
import type { DefaultConfigPaths, KnownAccount } from '../src/default-login.ts'

let scratch: string

beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'dsh-default-login-')) })
afterEach(() => { rmSync(scratch, { recursive: true, force: true }) })

/** Write one account folder with a fake login and a profile; the token text is a recognizable fake. */
function account(email: string, token = `token-of-${email}`): KnownAccount {
  const dir = join(scratch, 'accounts', email)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }))
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, displayName: email }, projects: { stray: true } }))
  return { email, dir }
}

/** The default config (as Claude Code leaves it) signed in as `email`, with unrelated settings that must survive. */
function defaults(email: string | undefined, token = `default-token-${String(email)}`): DefaultConfigPaths {
  const dir = join(scratch, 'home')
  mkdirSync(join(dir, '.claude'), { recursive: true })
  const paths = defaultConfigPaths({ home: dir })
  if (email !== undefined) {
    writeFileSync(paths.credentials, JSON.stringify({ claudeAiOauth: { accessToken: token } }))
    const settings = { numStartups: 7, oauthAccount: { emailAddress: email, old: true }, projects: { keep: 1 } }
    writeFileSync(paths.settings, JSON.stringify(settings))
  }
  return paths
}

/** The shape of the fake JSON files these tests write. */
interface Doc {
  claudeAiOauth: { accessToken: string }
  oauthAccount: { emailAddress: string }
  numStartups: number
  projects: unknown
}
const json = (path: string): Doc => JSON.parse(readFileSync(path, 'utf8')) as Doc
const stamps = (backups: string): string[] => readdirSync(backups).sort()

describe('defaultConfigPaths', () => {
  it('uses ~/.claude.json and ~/.claude/.credentials.json without a configured directory', () => {
    const paths = defaultConfigPaths({ home: join(scratch, 'h'), env: {} })
    expect(paths.settings).toBe(join(scratch, 'h', '.claude.json'))
    expect(paths.credentials).toBe(join(scratch, 'h', '.claude', '.credentials.json'))
    expect(paths.backups).toBe(join(scratch, 'h', '.claude', BACKUPS_DIR))
  })

  it('keeps both files inside CLAUDE_CONFIG_DIR, and lets an explicit directory win', () => {
    const fromEnv = defaultConfigPaths({ home: 'h', env: { CLAUDE_CONFIG_DIR: join(scratch, 'env') } })
    expect(fromEnv.settings).toBe(join(scratch, 'env', '.claude.json'))
    expect(fromEnv.credentials).toBe(join(scratch, 'env', '.credentials.json'))
    expect(fromEnv.backups).toBe(join(scratch, 'env', BACKUPS_DIR))
    const explicit = defaultConfigPaths({ dir: join(scratch, 'x'), home: 'h', env: { CLAUDE_CONFIG_DIR: join(scratch, 'env') } })
    expect(explicit.settings).toBe(join(scratch, 'x', '.claude.json'))
  })

  it('ignores an empty CLAUDE_CONFIG_DIR', () => {
    expect(defaultConfigPaths({ home: join(scratch, 'h'), env: { CLAUDE_CONFIG_DIR: '' } }).settings).toBe(join(scratch, 'h', '.claude.json'))
  })
})

describe('readDefaultEmail', () => {
  it('reads the lowercased oauthAccount email', async () => {
    const paths = defaults('Me@X.com')
    expect(await readDefaultEmail(paths)).toBe('me@x.com')
  })

  it('tolerates an absent file, bad JSON, and a missing key', async () => {
    const paths = defaults(undefined)
    expect(await readDefaultEmail(paths)).toBeUndefined()
    writeFileSync(paths.settings, '{ nope')
    expect(await readDefaultEmail(paths)).toBeUndefined()
    writeFileSync(paths.settings, JSON.stringify({ oauthAccount: { displayName: 'x' } }))
    expect(await readDefaultEmail(paths)).toBeUndefined()
    writeFileSync(paths.settings, '[]')
    expect(await readDefaultEmail(paths)).toBeUndefined()
  })
})

describe('makeDefaultLogin', () => {
  it('installs the target login and merges only its oauthAccount', async () => {
    const a = account('a@x.com')
    const b = account('b@x.com')
    const paths = defaults('a@x.com')
    const outcome = await makeDefaultLogin({ paths, target: b, known: [a, b], now: () => new Date('2026-10-27T10:00:00.123Z') })
    expect(outcome).toEqual({ ok: true, backupDir: join(paths.backups, '20261027T100000123Z'), unchanged: false })
    expect(json(paths.credentials)).toEqual({ claudeAiOauth: { accessToken: 'token-of-b@x.com' } })
    const settings = json(paths.settings)
    expect(settings.oauthAccount).toEqual({ emailAddress: 'b@x.com', displayName: 'b@x.com' })
    expect(settings.numStartups).toBe(7)
    expect(settings.projects).toEqual({ keep: 1 })
    expect(Object.keys(settings).sort()).toEqual(['numStartups', 'oauthAccount', 'projects'])
  })

  it('backs the originals up first, byte for byte', async () => {
    const a = account('a@x.com')
    const b = account('b@x.com')
    const paths = defaults('a@x.com')
    const beforeCredentials = readFileSync(paths.credentials, 'utf8')
    const beforeSettings = readFileSync(paths.settings, 'utf8')
    const outcome = await makeDefaultLogin({ paths, target: b, known: [a, b] })
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(readFileSync(join(outcome.backupDir, '.credentials.json'), 'utf8')).toBe(beforeCredentials)
    expect(readFileSync(join(outcome.backupDir, '.claude.json'), 'utf8')).toBe(beforeSettings)
  })

  it('saves a refreshed default login back into the account folder that owns it', async () => {
    const a = account('a@x.com', 'stale-a')
    const b = account('b@x.com')
    const paths = defaults('a@x.com', 'fresh-a')
    await makeDefaultLogin({ paths, target: b, known: [a, b] })
    expect(json(join(a.dir, '.credentials.json')).claudeAiOauth.accessToken).toBe('fresh-a')
  })

  it('round trip A to B to A keeps the latest credentials of each', async () => {
    const a = account('a@x.com', 'a-v1')
    const b = account('b@x.com', 'b-v1')
    const paths = defaults('a@x.com', 'a-v2')
    const known = [a, b]
    expect((await makeDefaultLogin({ paths, target: b, known })).ok).toBe(true)
    // Claude Code runs as B and refreshes its tokens in the default directory.
    writeFileSync(paths.credentials, JSON.stringify({ claudeAiOauth: { accessToken: 'b-v2' } }))
    expect((await makeDefaultLogin({ paths, target: a, known })).ok).toBe(true)
    expect(json(paths.credentials).claudeAiOauth.accessToken).toBe('a-v2')
    expect(json(paths.settings).oauthAccount.emailAddress).toBe('a@x.com')
    expect(json(join(b.dir, '.credentials.json')).claudeAiOauth.accessToken).toBe('b-v2')
    expect(json(paths.settings).numStartups).toBe(7)
  })

  it('leaves the default alone but keeps its refresh when it already is the target', async () => {
    const a = account('a@x.com', 'stale-a')
    const paths = defaults('A@x.com', 'fresh-a')
    const beforeSettings = readFileSync(paths.settings, 'utf8')
    const outcome = await makeDefaultLogin({ paths, target: a, known: [a] })
    expect(outcome).toMatchObject({ ok: true, unchanged: true })
    expect(readFileSync(paths.settings, 'utf8')).toBe(beforeSettings)
    expect(json(paths.credentials).claudeAiOauth.accessToken).toBe('fresh-a')
    expect(json(join(a.dir, '.credentials.json')).claudeAiOauth.accessToken).toBe('fresh-a')
  })

  it('does not copy the default login into a folder when the default is some unknown account', async () => {
    const a = account('a@x.com')
    const stranger = account('stranger@x.com', 'stranger-token')
    const paths = defaults('other@x.com', 'other-token')
    await makeDefaultLogin({ paths, target: a, known: [a] })
    expect(json(join(stranger.dir, '.credentials.json')).claudeAiOauth.accessToken).toBe('stranger-token')
    // The unknown login is still in the backup, so it is not lost.
    const [name] = stamps(paths.backups)
    expect(json(join(paths.backups, name!, '.credentials.json')).claudeAiOauth.accessToken).toBe('other-token')
  })

  it('works when there is no default config yet', async () => {
    const a = account('a@x.com')
    const paths = defaults(undefined)
    const outcome = await makeDefaultLogin({ paths, target: a, known: [a] })
    expect(outcome).toMatchObject({ ok: true, unchanged: false })
    expect(json(paths.settings)).toEqual({ oauthAccount: { emailAddress: 'a@x.com', displayName: 'a@x.com' } })
    expect(json(paths.credentials).claudeAiOauth.accessToken).toBe('token-of-a@x.com')
  })

  it('refuses a target without a saved login or profile, changing nothing', async () => {
    const paths = defaults('a@x.com')
    const before = readFileSync(paths.settings, 'utf8')
    const ghost: KnownAccount = { email: 'ghost@x.com', dir: join(scratch, 'accounts', 'ghost') }
    expect(await makeDefaultLogin({ paths, target: ghost, known: [ghost] })).toEqual({ ok: false, reason: expect.stringContaining('no saved Claude Code login') as string })
    const bare = account('bare@x.com')
    rmSync(join(bare.dir, '.claude.json'))
    expect(await makeDefaultLogin({ paths, target: bare, known: [bare] })).toEqual({ ok: false, reason: expect.stringContaining('no saved profile') as string })
    writeFileSync(join(bare.dir, '.claude.json'), JSON.stringify({ projects: {} }))
    expect((await makeDefaultLogin({ paths, target: bare, known: [bare] })).ok).toBe(false)
    expect(readFileSync(paths.settings, 'utf8')).toBe(before)
    expect(existsSync(paths.backups)).toBe(false)
  })

  it('refuses when the default settings file is not valid JSON, changing nothing', async () => {
    const a = account('a@x.com')
    const paths = defaults('b@x.com')
    writeFileSync(paths.settings, '{ "oauthAccount": ')
    const credentials = readFileSync(paths.credentials, 'utf8')
    const outcome = await makeDefaultLogin({ paths, target: a, known: [a] })
    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining('not valid JSON') as string })
    expect(readFileSync(paths.settings, 'utf8')).toBe('{ "oauthAccount": ')
    expect(readFileSync(paths.credentials, 'utf8')).toBe(credentials)
    expect(existsSync(paths.backups)).toBe(false)
  })

  it('leaves the originals intact when replacing the login fails', async () => {
    const a = account('a@x.com')
    const b = account('b@x.com')
    const paths = defaults('a@x.com', 'a-live')
    const settings = readFileSync(paths.settings, 'utf8')
    const failing = (_from: string, to: string): Promise<void> => to === paths.credentials ? Promise.reject(Object.assign(new Error('busy'), { code: 'EPERM' })) : Promise.resolve()
    const outcome = await makeDefaultLogin({ paths, target: b, known: [a, b], rename: failing })
    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining('EPERM') as string })
    expect(json(paths.credentials).claudeAiOauth.accessToken).toBe('a-live')
    expect(readFileSync(paths.settings, 'utf8')).toBe(settings)
    expect(readdirSync(join(scratch, 'home', '.claude')).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(readdirSync(scratch + '/home').filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('restores the original login when only the settings rename fails', async () => {
    const a = account('a@x.com')
    const b = account('b@x.com')
    const paths = defaults('a@x.com', 'a-live')
    const settings = readFileSync(paths.settings, 'utf8')
    const failing = (from: string, to: string): Promise<void> => to === paths.settings ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : rename(from, to)
    const outcome = await makeDefaultLogin({ paths, target: b, known: [a, b], rename: failing })
    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining('original login was restored') as string })
    expect(json(paths.credentials).claudeAiOauth.accessToken).toBe('a-live')
    expect(readFileSync(paths.settings, 'utf8')).toBe(settings)
  })

  it('removes a login it installed when there was no original to restore', async () => {
    const b = account('b@x.com')
    const paths = defaults(undefined)
    const failing = (from: string, to: string): Promise<void> => to === paths.settings ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : rename(from, to)
    const outcome = await makeDefaultLogin({ paths, target: b, known: [b], rename: failing })
    expect(outcome.ok).toBe(false)
    expect(existsSync(paths.credentials)).toBe(false)
  })

  it('refuses without touching the default when the login cannot be saved back', async () => {
    const a = account('a@x.com')
    const b = account('b@x.com')
    const paths = defaults('a@x.com', 'a-live')
    const failing = (_from: string, to: string): Promise<void> => to.startsWith(a.dir) ? Promise.reject(Object.assign(new Error('locked'), { code: 'EBUSY' })) : Promise.resolve()
    const outcome = await makeDefaultLogin({ paths, target: b, known: [a, b], rename: failing })
    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining('save the current default login back') as string })
    expect(json(paths.credentials).claudeAiOauth.accessToken).toBe('a-live')
    expect(readdirSync(a.dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps only the newest backups, and never reuses a stamp', async () => {
    const a = account('a@x.com')
    const b = account('b@x.com')
    const paths = defaults('a@x.com')
    const known = [a, b]
    const target = [b, a]
    const fixed = new Date('2026-10-27T10:00:00.000Z')
    for (let index = 0; index < KEEP_BACKUPS + 3; index += 1) {
      const now = (): Date => new Date(fixed.getTime() + index * 1000)
      const outcome = await makeDefaultLogin({ paths, target: target[index % 2]!, known, now })
      expect(outcome.ok).toBe(true)
    }
    const kept = stamps(paths.backups)
    expect(kept).toHaveLength(KEEP_BACKUPS)
    expect(kept.at(-1)).toBe('20261027T100007000Z')
    expect(kept[0]).toBe('20261027T100003000Z')
    mkdirSync(join(paths.backups, 'notes'))
    const sameInstant = await makeDefaultLogin({ paths, target: b, known, now: () => fixed })
    const again = await makeDefaultLogin({ paths, target: a, known, now: () => fixed })
    expect(sameInstant.ok && again.ok && sameInstant.backupDir !== again.backupDir).toBe(true)
    expect(existsSync(join(paths.backups, 'notes'))).toBe(true)
  })

  it('never puts a token in a reason', async () => {
    const a = account('a@x.com')
    const paths = defaults('b@x.com', 'SECRET-DEFAULT')
    writeFileSync(paths.settings, 'not json')
    const outcome = await makeDefaultLogin({ paths, target: a, known: [a] })
    expect(JSON.stringify(outcome)).not.toMatch(/SECRET|token-of/u)
  })
})
