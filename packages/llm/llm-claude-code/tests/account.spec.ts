import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_KEY,
  accountEnv,
  accountId,
  accountsRecord,
  completeAuthCode,
  CONFIG_DIR_ENV,
  defaultAccountsDir,
  extractAuthorizeUrl,
  findAccount,
  isAccountId,
  isPlausibleEmail,
  mergeAccount,
  normalizeEmail,
  parseAccounts,
  parseAuthStatus,
  stripEscapes,
} from '../src/account.ts'
import type { AccountEntry } from '../src/account.ts'

const URL_TEXT = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=xyz'
const OSC = (url: string, text: string): string => `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`

describe('extractAuthorizeUrl', () => {
  it('reads a plain URL', () => {
    expect(extractAuthorizeUrl(`Opening browser to sign in…\nIf the browser didn't open, visit: ${URL_TEXT}\nPaste code here if prompted > `)).toBe(URL_TEXT)
  })

  it('reads a URL inside OSC 8 hyperlink sequences, printed twice', () => {
    const output = `Opening browser to sign in…\nIf the browser didn't open, visit: ${OSC(URL_TEXT, URL_TEXT)}\nPaste code here if prompted > `
    expect(extractAuthorizeUrl(output)).toBe(URL_TEXT)
  })

  it('reads a hyperlink terminated by BEL instead of ESC \\', () => {
    const output = `visit: \u001b]8;;${URL_TEXT}\u0007click here\u001b]8;;\u0007\n`
    expect(extractAuthorizeUrl(output)).toBe(URL_TEXT)
  })

  it('waits for a URL that is still being printed', () => {
    expect(extractAuthorizeUrl(`visit: ${OSC(URL_TEXT, URL_TEXT).slice(0, 60)}`)).toBeUndefined()
    expect(extractAuthorizeUrl(`visit: ${URL_TEXT}`)).toBeUndefined()
    expect(extractAuthorizeUrl(`visit: ${URL_TEXT}\n`)).toBe(URL_TEXT)
  })

  it('ignores other links and non-https pages', () => {
    expect(extractAuthorizeUrl('docs: https://docs.claude.com/en/docs/claude-code\nhttp://claude.com/cai/oauth/authorize?x=1\n')).toBeUndefined()
    expect(extractAuthorizeUrl(`see https://docs.claude.com/x then ${URL_TEXT}\n`)).toBe(URL_TEXT)
    expect(extractAuthorizeUrl('')).toBeUndefined()
  })
})

describe('stripEscapes', () => {
  it('removes hyperlink and colour sequences but keeps the text', () => {
    expect(stripEscapes(`\u001b[32mok\u001b[0m ${OSC('https://x.test/', 'link')}`)).toBe('ok link')
  })
})

describe('parseAuthStatus', () => {
  it('reads the account fields and never anything else', () => {
    const json = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.test', orgName: 'Org', subscriptionType: 'max', accessToken: 'SECRET' })
    expect(parseAuthStatus(json)).toEqual({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.test', plan: 'max', organization: 'Org' })
  })

  it('accepts JSON surrounded by other text and a logged-out answer', () => {
    expect(parseAuthStatus('warming up\n{"loggedIn": false}\n')).toEqual({ loggedIn: false })
  })

  it('rejects anything without a boolean loggedIn', () => {
    expect(parseAuthStatus('')).toBeUndefined()
    expect(parseAuthStatus('not json')).toBeUndefined()
    expect(parseAuthStatus('{"loggedIn": "yes"}')).toBeUndefined()
    expect(parseAuthStatus('{"email": "a@b.test"}')).toBeUndefined()
    expect(parseAuthStatus('{broken}')).toBeUndefined()
  })
})

describe('accountId', () => {
  it('is a stable, readable slug of the lowercased email with a short hash', () => {
    const id = accountId('Arnold.Wang@Ingeniux.com')
    expect(id).toMatch(/^arnold\.wang-at-ingeniux\.com-[0-9a-f]{8}$/u)
    expect(accountId('arnold.wang@ingeniux.com')).toBe(id)
    expect(accountId('  ARNOLD.WANG@INGENIUX.COM ')).toBe(id)
  })

  it('never lets two addresses share a directory', () => {
    expect(accountId('a.b@x.com')).not.toBe(accountId('a-b@x.com'))
    expect(accountId('a+b@x.com')).not.toBe(accountId('a-b@x.com'))
    expect(accountId('a@b-x.com')).not.toBe(accountId('a-b@x.com'))
  })

  it('keeps only safe characters and cannot climb out of the accounts root', () => {
    for (const hostile of ['..\\..\\evil@x.com', '../../etc/passwd@x.com', '/abs/path@x.com', 'a:b*c?"<>|@x.com', 'con@x.com', '...@x.com', '', '@', 'é@x.com']) {
      const id = accountId(hostile)
      expect(id).toMatch(/^[a-z0-9][a-z0-9._-]*$/u)
      expect(isAccountId(id)).toBe(true)
      expect(id).not.toContain('..')
      expect(join('root', id).split(/[\\/]/u)).toEqual(['root', id])
    }
  })

  it('caps the readable part', () => {
    const id = accountId(`${'a'.repeat(200)}@x.com`)
    expect(id.length).toBeLessThanOrEqual(64 + 1 + 8)
    expect(id).toMatch(/-[0-9a-f]{8}$/u)
  })
})

describe('email checks', () => {
  it('accepts plausible addresses and refuses the rest', () => {
    expect(isPlausibleEmail(' a@b.co ')).toBe(true)
    expect(isPlausibleEmail('a+tag@sub.example.com')).toBe(true)
    for (const bad of ['', 'a', 'a@b', '@b.co', 'a b@c.co', '-x@b.co', 'a@@b.co']) expect(isPlausibleEmail(bad)).toBe(false)
    expect(normalizeEmail(' A@B.Co ')).toBe('a@b.co')
  })
})

describe('accounts record', () => {
  const first: AccountEntry = { id: accountId('a@x.com'), email: 'a@x.com', signedInAt: '2026-10-27T10:00:00.000Z' }
  const second: AccountEntry = { id: accountId('b@x.com'), email: 'b@x.com', signedInAt: '2026-10-27T11:00:00.000Z' }

  it('lists accounts without a secret and reads them back', () => {
    const record = accountsRecord([first, second])
    expect(record).toEqual({ kind: 'grant', payload: { type: 'claude-code-accounts', accounts: [first, second] } })
    expect(parseAccounts(record)).toEqual([first, second])
    expect(findAccount(record, ' B@X.com ')).toEqual(second)
    expect(findAccount(record, 'c@x.com')).toBeUndefined()
  })

  it('merges a second account and replaces a repeated sign-in of the same one', () => {
    const renewed = { ...first, signedInAt: '2026-10-28T00:00:00.000Z' }
    expect(mergeAccount([first], second)).toEqual([first, second])
    expect(mergeAccount([first, second], renewed)).toEqual([renewed, second])
  })

  it('reads nothing from another shape and drops malformed or unsafe entries', () => {
    expect(parseAccounts(undefined)).toEqual([])
    expect(parseAccounts({ kind: 'api-key', key: 'sk-ant-secret' })).toEqual([])
    expect(parseAccounts({ kind: 'grant', payload: 'x' })).toEqual([])
    expect(parseAccounts({ kind: 'grant', payload: { type: 'oauth', accounts: [first] } })).toEqual([])
    const messy = { kind: 'grant', payload: { type: 'claude-code-accounts', accounts: [first, null, 3, { id: '../escape', email: 'x@y.co', signedInAt: 't' }, { id: 'ok', email: '', signedInAt: 't' }, { id: 'ok' }] } } as const
    expect(parseAccounts(messy)).toEqual([first])
  })
})

describe('accountEnv', () => {
  const root = join('x', 'accounts')
  const entry: AccountEntry = { id: accountId('a@x.com'), email: 'a@x.com', signedInAt: '2026-10-27T10:00:00.000Z' }
  const record = accountsRecord([entry])

  it('points the child at the active account directory, matching the email in any case', () => {
    expect(accountEnv(record, root, 'A@X.com', true)).toEqual({ env: { [CONFIG_DIR_ENV]: join(root, entry.id) } })
  })

  it('stays silent when no account is active', () => {
    expect(accountEnv(record, root, undefined, true)).toEqual({ env: {} })
    expect(accountEnv(undefined, root, '  ', false)).toEqual({ env: {} })
  })

  it('falls back with a secret-free reason when the active account cannot be used', () => {
    expect(accountEnv(undefined, root, 'a@x.com', false).warning).toContain('has not signed in')
    expect(accountEnv(record, root, 'other@x.com', true).warning).toContain('has not signed in')
    expect(accountEnv(record, root, 'a@x.com', false).warning).toContain('no Claude Code credentials')
    expect(accountEnv({ kind: 'api-key', key: 'sk-ant-secret' }, root, 'a@x.com', true).warning).not.toContain('sk-ant-secret')
  })
})

describe('keys and defaults', () => {
  it('uses the plugin scope and one record id', () => {
    expect(ACCOUNT_KEY).toBe('llm-claude-code/claude-account')
  })

  it('places the default accounts root under the DSH home', () => {
    expect(defaultAccountsDir(join('home', '.dsh'))).toBe(join('home', '.dsh', 'claude-code', 'accounts'))
  })
})

describe('completeAuthCode', () => {
  it('adds the state of the sign-in page when only the code half was pasted', () => {
    expect(completeAuthCode('abcDEF123', URL_TEXT)).toBe('abcDEF123#xyz')
    expect(completeAuthCode('  abc DEF\n', URL_TEXT)).toBe('abcDEF#xyz')
    expect(completeAuthCode('abcDEF123#', URL_TEXT)).toBe('abcDEF123#xyz')
  })

  it('leaves a code that already has its state alone, even when the state differs', () => {
    expect(completeAuthCode('abc#def', URL_TEXT)).toBe('abc#def')
    expect(completeAuthCode(' abc#def \n', URL_TEXT)).toBe('abc#def')
  })

  it('passes the code through when the page address has no state or is not an address', () => {
    expect(completeAuthCode('abc', 'https://claude.com/cai/oauth/authorize?code=true')).toBe('abc')
    expect(completeAuthCode('abc', 'not a url')).toBe('abc')
  })

  it('returns an empty string for blank input', () => {
    expect(completeAuthCode('  \n ', URL_TEXT)).toBe('')
  })
})
