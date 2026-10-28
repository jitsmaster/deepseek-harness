import { spawn as spawnProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationFlow, AuthorizationNotice, AuthorizationPrompt, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { accountId, accountsRecord, ACCOUNT_KEY, parseAccounts } from '../src/account.ts'
import { claudeAccountFlow, removeTree } from '../src/login.ts'
import type { AccountFlowOptions } from '../src/login.ts'
import { alive, FakeClaudeSubprocess, readRuns, subprocessContext } from './harness.ts'

const PAGE = 'https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=abc123'
const SECRET = 'FAKE-SECRET-TOKEN-do-not-store'
const EMAIL = 'user@example.com'

let ctx: Context | undefined
let scratch = ''
let accountsDir = ''
/** The record the fake credentials service holds; the session's `commit` replaces it, as the seam does. */
let stored: CredentialRecord | undefined

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-claude-login-'))
  accountsDir = join(scratch, 'accounts')
  stored = undefined
  FakeClaudeSubprocess.logPath = join(scratch, 'runs.jsonl')
  FakeClaudeSubprocess.spawned = []
  FakeClaudeSubprocess.authScenario = 'ok'
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  rmSync(scratch, { recursive: true, force: true })
})

/** What the human is told and asked, and what the flow committed. */
interface Conversation {
  session: AuthorizationSession
  notices: AuthorizationNotice[]
  prompts: AuthorizationPrompt[]
  commits: CredentialRecord[]
  abort: AbortController
}

/** What the human answers: a choice from the account list, a typed email, and the pasted code (or `'wait'` for never). */
interface Answers {
  choice?: string
  email?: string
  code?: string
}

function converse(answers: Answers = {}): Conversation {
  const { choice, email = EMAIL, code = 'PASTE-CODE-123' } = answers
  const abort = new AbortController()
  const conversation: Conversation = { notices: [], prompts: [], commits: [], abort, session: undefined as never }
  conversation.session = {
    method: 'oauth',
    signal: abort.signal,
    commit: (record) => {
      conversation.commits.push(record)
      stored = record
      return Promise.resolve()
    },
    notify: (notice) => { conversation.notices.push(notice) },
    prompt: (prompt) => {
      conversation.prompts.push(prompt)
      if (prompt.kind === 'select') return Promise.resolve(choice ?? '__other__')
      if (prompt.message.startsWith('Email address')) return Promise.resolve(email)
      if (code !== 'wait') return Promise.resolve(code)
      return new Promise((_resolve, reject) => {
        prompt.signal?.addEventListener('abort', () => { reject(new Error('the prompt was withdrawn')) }, { once: true })
      })
    },
  }
  return conversation
}

async function flow(overrides: Partial<AccountFlowOptions> = {}): Promise<AuthorizationFlow> {
  const root = await subprocessContext()
  ctx = root
  return claudeAccountFlow({
    executable: process.execPath,
    accountsDir,
    knownAccounts: () => [],
    readRecord: () => Promise.resolve(stored),
    privateBrowser: false,
    spawn: spec => root.subprocess.spawn(spec),
    loginTimeoutMs: 30_000,
    swapDelayMs: 20,
    swapAttempts: 5,
    ...overrides,
  })
}

const dirFor = (email: string): string => join(accountsDir, accountId(email))

function seedAccount(email = EMAIL): void {
  mkdirSync(dirFor(email), { recursive: true })
  writeFileSync(join(dirFor(email), '.credentials.json'), `OLD-ACCOUNT-${email}`)
  writeFileSync(join(dirFor(email), 'stale.txt'), 'left over from the old account')
}

const oldCredentials = (email = EMAIL): string => readFileSync(join(dirFor(email), '.credentials.json'), 'utf8')

function leftovers(): string[] {
  return existsSync(accountsDir) ? readdirSync(accountsDir).filter(name => name.includes('.login-') || name.includes('.old-')) : []
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const limit = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > limit) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

const loginPid = (): number => readRuns().find(run => run.pid !== undefined)?.pid as number

describe('claude account sign-in flow', () => {
  it('declares one oauth method under the account key', async () => {
    const declared = await flow()
    expect(declared.key).toBe(ACCOUNT_KEY)
    expect(declared.label).toBe('Claude (Claude Code)')
    expect(declared.methods).toEqual([{ id: 'oauth', label: 'Sign in with Claude' }])
  })

  it('asks for the email, hands the page to the human, writes the pasted code, and lists the account without a secret', async () => {
    const talk = converse({ email: ' User@Example.com ' })
    await (await flow()).run(talk.session)
    expect(talk.prompts.map(prompt => prompt.kind)).toEqual(['text', 'text'])
    expect(FakeClaudeSubprocess.spawned[0]?.argv.slice(1)).toEqual(['auth', 'login', '--claudeai', `--email=${EMAIL}`])
    const env = FakeClaudeSubprocess.spawned[0]?.env ?? {}
    expect(env.CLAUDE_CONFIG_DIR?.startsWith(`${join(accountsDir, accountId(EMAIL))}.login-`)).toBe(true)
    expect(env).toHaveProperty('ANTHROPIC_API_KEY', undefined)
    expect(env.BROWSER).toBeUndefined()
    expect(talk.notices.filter(notice => notice.url !== undefined)).toEqual([{ message: expect.stringContaining(`sign in as ${EMAIL}`) as string, url: PAGE }])
    expect(readRuns().find(run => run.code !== undefined)?.code).toBe('PASTE-CODE-123#abc123')
    expect(readFileSync(join(dirFor(EMAIL), '.credentials.json'), 'utf8')).toContain(SECRET)
    expect(talk.commits).toHaveLength(1)
    const [record] = talk.commits
    expect(record).toMatchObject({ kind: 'grant', payload: { type: 'claude-code-accounts' } })
    expect(parseAccounts(record)).toEqual([{ id: accountId(EMAIL), email: EMAIL, signedInAt: expect.any(String) as string }])
    expect(Number.isNaN(Date.parse(parseAccounts(record)[0]?.signedInAt as string))).toBe(false)
    expect(JSON.stringify(record)).not.toContain(SECRET)
    expect(JSON.stringify(record)).not.toContain('PASTE-CODE-123')
    expect(leftovers()).toEqual([])
    expect(readRuns().find(run => run.authStatus !== undefined)?.authStatus).toEqual(['status', '--json'])
  }, 30_000)

  it('offers the known and signed-in emails plus another address, and keeps the other accounts in the record', async () => {
    seedAccount('first@example.com')
    stored = accountsRecord([{ id: accountId('first@example.com'), email: 'first@example.com', signedInAt: '2026-10-01T00:00:00.000Z' }])
    const talk = converse({ choice: 'second@example.com' })
    await (await flow({ knownAccounts: () => ['Second@Example.com', 'first@example.com'] })).run(talk.session)
    const select = talk.prompts[0]
    expect(select).toMatchObject({ kind: 'select' })
    expect(select?.kind === 'select' ? select.options.map(option => option.id) : []).toEqual(['second@example.com', 'first@example.com', '__other__'])
    expect(select?.kind === 'select' ? select.options.map(option => option.description) : []).toEqual(['not signed in yet', 'signed in; signing in again replaces it', undefined])
    expect(talk.prompts).toHaveLength(2)
    expect(FakeClaudeSubprocess.spawned[0]?.argv).toContain('--email=second@example.com')
    expect(parseAccounts(talk.commits[0]).map(entry => entry.email)).toEqual(['first@example.com', 'second@example.com'])
    expect(parseAccounts(talk.commits[0])[0]?.signedInAt).toBe('2026-10-01T00:00:00.000Z')
    expect(oldCredentials('first@example.com')).toBe('OLD-ACCOUNT-first@example.com')
    expect(readFileSync(join(dirFor('second@example.com'), '.credentials.json'), 'utf8')).toContain(SECRET)
    expect(leftovers()).toEqual([])
  }, 30_000)

  it('takes a typed address after the "another email" entry', async () => {
    const talk = converse({ email: 'new@example.com' })
    await (await flow({ knownAccounts: () => ['first@example.com'] })).run(talk.session)
    expect(talk.prompts.map(prompt => prompt.kind)).toEqual(['select', 'text', 'text'])
    expect(parseAccounts(talk.commits[0]).map(entry => entry.email)).toEqual(['new@example.com'])
  }, 30_000)

  it('replaces the previous files of the same account completely and leaves other accounts alone', async () => {
    seedAccount()
    seedAccount('other@example.com')
    await (await flow()).run(converse().session)
    expect(readFileSync(join(dirFor(EMAIL), '.credentials.json'), 'utf8')).toContain(SECRET)
    expect(existsSync(join(dirFor(EMAIL), 'stale.txt'))).toBe(false)
    expect(oldCredentials('other@example.com')).toBe('OLD-ACCOUNT-other@example.com')
    expect(leftovers()).toEqual([])
  }, 30_000)

  it('saves the account that actually signed in when it differs from the one asked for', async () => {
    FakeClaudeSubprocess.authScenario = 'otheremail'
    const talk = converse()
    await (await flow()).run(talk.session)
    expect(parseAccounts(talk.commits[0]).map(entry => entry.email)).toEqual(['someone-else@example.com'])
    expect(existsSync(dirFor('someone-else@example.com'))).toBe(true)
    expect(existsSync(dirFor(EMAIL))).toBe(false)
    expect(talk.notices.some(notice => notice.message.includes('instead of'))).toBe(true)
    expect(leftovers()).toEqual([])
  }, 30_000)

  it('rejects something that is not an email address before starting anything', async () => {
    const talk = converse({ email: 'not-an-email' })
    await expect((await flow()).run(talk.session)).rejects.toThrow(/not an email address/u)
    expect(FakeClaudeSubprocess.spawned).toEqual([])
    expect(existsSync(accountsDir)).toBe(false)
  })

  it('opens the page in a private browser through a launcher in the staging directory that is not kept', async () => {
    const chrome = win32.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')
    const talk = converse()
    await (await flow({
      privateBrowser: true,
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: path => path === chrome,
    })).run(talk.session)
    const { env } = FakeClaudeSubprocess.spawned[0] ?? {}
    expect(env?.BROWSER?.startsWith(`${dirFor(EMAIL)}.login-`)).toBe(true)
    expect(env?.BROWSER?.endsWith('open-private.cmd')).toBe(true)
    expect(readRuns().find(run => run.browser !== undefined)?.browser).toBe(env?.BROWSER)
    expect(talk.notices.find(notice => notice.url !== undefined)?.message).toContain('a private Chrome window opens for you')
    expect(talk.notices.find(notice => notice.url !== undefined)?.url).toBe(PAGE)
    expect(existsSync(join(dirFor(EMAIL), 'open-private.cmd'))).toBe(false)
    expect(readFileSync(join(dirFor(EMAIL), '.credentials.json'), 'utf8')).toContain(SECRET)
    expect(leftovers()).toEqual([])
  }, 30_000)

  it('falls back to the default browser when no private browser is installed', async () => {
    const talk = converse()
    await (await flow({ privateBrowser: true, platform: 'win32', env: {}, exists: () => false })).run(talk.session)
    expect(FakeClaudeSubprocess.spawned[0]?.env?.BROWSER).toBeDefined()
    expect(talk.notices.find(notice => notice.url !== undefined)?.message).not.toContain('private')
  }, 30_000)

  it('accepts a login the browser completes by itself and withdraws the question', async () => {
    FakeClaudeSubprocess.authScenario = 'self'
    const talk = converse({ code: 'wait' })
    await (await flow()).run(talk.session)
    expect(talk.prompts).toHaveLength(2)
    expect(talk.prompts[1]?.signal?.aborted).toBe(true)
    expect(talk.commits).toHaveLength(1)
    expect(readFileSync(join(dirFor(EMAIL), '.credentials.json'), 'utf8')).toContain(SECRET)
    expect(leftovers()).toEqual([])
  }, 30_000)

  it('keeps the previous account when the code is refused', async () => {
    seedAccount()
    FakeClaudeSubprocess.authScenario = 'fail'
    const talk = converse()
    const error = await (await flow()).run(talk.session).catch((caught: unknown) => caught as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('exited with code 1')
    expect((error as Error).message).toContain('Invalid code')
    expect((error as Error).message).not.toContain('PASTE-CODE-123')
    expect(oldCredentials()).toBe(`OLD-ACCOUNT-${EMAIL}`)
    expect(talk.commits).toEqual([])
    expect(leftovers()).toEqual([])
  }, 30_000)

  it('fails with the child output when no page is ever printed', async () => {
    FakeClaudeSubprocess.authScenario = 'nourl'
    const talk = converse()
    await expect((await flow()).run(talk.session)).rejects.toThrow(/exited with code 1: Login failed: network unreachable/u)
    expect(talk.notices).toEqual([])
    expect(talk.prompts).toHaveLength(1)
    expect(leftovers()).toEqual([])
  }, 30_000)

  it('refuses a login that wrote no credentials, keeping the previous account', async () => {
    seedAccount()
    FakeClaudeSubprocess.authScenario = 'nocreds'
    const talk = converse()
    await expect((await flow()).run(talk.session)).rejects.toThrow(/wrote no credentials file/u)
    expect(oldCredentials()).toBe(`OLD-ACCOUNT-${EMAIL}`)
    expect(talk.commits).toEqual([])
    expect(leftovers()).toEqual([])
  }, 30_000)

  it.each([
    ['loggedout', /not signed in after the login finished/u],
    ['garbage', /gave no account information/u],
  ])('refuses an account whose status check says %s, keeping the previous account', async (scenario, message) => {
    seedAccount()
    // The fake login still writes its account under these scenarios; only the status check differs.
    FakeClaudeSubprocess.authScenario = scenario
    const talk = converse()
    await expect((await flow()).run(talk.session)).rejects.toThrow(message)
    expect(oldCredentials()).toBe(`OLD-ACCOUNT-${EMAIL}`)
    expect(talk.commits).toEqual([])
    expect(leftovers()).toEqual([])
  }, 30_000)

  it('rejects an empty code', async () => {
    const talk = converse({ code: '   ' })
    await expect((await flow()).run(talk.session)).rejects.toThrow(/no sign-in code was entered/u)
    expect(talk.commits).toEqual([])
    expect(leftovers()).toEqual([])
  }, 30_000)

  it('propagates a declined prompt and stops the child', async () => {
    FakeClaudeSubprocess.authScenario = 'never'
    const talk = converse()
    const answer = talk.session.prompt.bind(talk.session)
    talk.session.prompt = async (prompt) => {
      if (prompt.kind !== 'text' || prompt.message.startsWith('Email')) return answer(prompt)
      await until(() => readRuns().some(run => run.pid !== undefined), 'the login child to log its pid')
      throw new Error('declined')
    }
    await expect((await flow()).run(talk.session)).rejects.toThrow('declined')
    await until(() => !alive(loginPid()), 'the login child to be killed')
    expect(leftovers()).toEqual([])
  }, 30_000)

  it('kills the child and keeps the previous account when the attempt is cancelled', async () => {
    seedAccount()
    FakeClaudeSubprocess.authScenario = 'never'
    const talk = converse({ code: 'wait' })
    const running = (await flow()).run(talk.session).catch((caught: unknown) => caught as Error)
    await until(() => talk.prompts.length > 1, 'the code prompt')
    await until(() => readRuns().some(run => run.pid !== undefined), 'the login child to log its pid')
    const pid = loginPid()
    expect(alive(pid)).toBe(true)
    talk.abort.abort()
    expect(await running).toMatchObject({ message: expect.stringContaining('cancelled') as string })
    await until(() => !alive(pid), 'the login child to be killed')
    expect(oldCredentials()).toBe(`OLD-ACCOUNT-${EMAIL}`)
    expect(talk.commits).toEqual([])
    expect(leftovers()).toEqual([])
  }, 30_000)

  it('gives up after the login deadline and kills the child', async () => {
    seedAccount()
    FakeClaudeSubprocess.authScenario = 'never'
    const talk = converse({ code: 'wait' })
    await expect((await flow({ loginTimeoutMs: 1500 })).run(talk.session)).rejects.toThrow(/timed out after 1500ms/u)
    await until(() => readRuns().some(run => run.pid !== undefined), 'the login child to log its pid')
    await until(() => !alive(loginPid()), 'the login child to be killed')
    expect(oldCredentials()).toBe(`OLD-ACCOUNT-${EMAIL}`)
    expect(leftovers()).toEqual([])
  }, 30_000)

  it('reports a rejected code without the page address and says how to retry', async () => {
    FakeClaudeSubprocess.authScenario = 'rejected'
    const error = await (await flow()).run(converse({ code: 'OLD#CODE' }).session).catch((caught: unknown) => caught as Error)
    const message = (error as Error).message
    expect(message).toContain('exited with code 1: Login failed: Request failed with status code 400')
    expect(message).toContain('only for the link shown in this dialog')
    expect(message).not.toContain('https://')
    expect(message).not.toContain('OLD#CODE')
  }, 30_000)

  it('adds the missing #state of a pasted code from the sign-in page, and leaves a complete code alone', async () => {
    // The Claude page shows `code#state`; selecting only the first half used to hang the login for good.
    await (await flow()).run(converse({ code: '  CODE-ONLY \n' }).session)
    expect(readRuns().find(run => run.code !== undefined)?.code).toBe('CODE-ONLY#abc123')
    await (await flow()).run(converse({ code: 'MINE#THEIRS' }).session)
    expect(readRuns().filter(run => run.code !== undefined).at(-1)?.code).toBe('MINE#THEIRS')
    await (await flow()).run(converse({ code: 'TRAILING#' }).session)
    expect(readRuns().filter(run => run.code !== undefined).at(-1)?.code).toBe('TRAILING#abc123')
  }, 30_000)

  it('fails in seconds, not at the login deadline, when the login stays silent after the code', async () => {
    seedAccount()
    FakeClaudeSubprocess.authScenario = 'silent'
    const talk = converse({ code: 'SOME#CODE' })
    const started = Date.now()
    await expect((await flow({ codeReplyTimeoutMs: 700 })).run(talk.session)).rejects.toThrow(/did not answer the code within 1 seconds/u)
    expect(Date.now() - started).toBeLessThan(10_000)
    await until(() => readRuns().some(run => run.pid !== undefined), 'the login child to log its pid')
    await until(() => !alive(loginPid()), 'the login child to be killed')
    expect(oldCredentials()).toBe(`OLD-ACCOUNT-${EMAIL}`)
    expect(talk.commits).toEqual([])
    expect(leftovers()).toEqual([])
  }, 30_000)

  it('fails clearly when the executable is missing', async () => {
    await expect((await flow({ executable: join(scratch, 'no-such-claude') })).run(converse().session)).rejects.toThrow(/was not found/u)
    expect(leftovers()).toEqual([])
  })

  it.skipIf(process.platform !== 'win32')('fails clearly, keeping the previous account, while a process holds the account directory', async () => {
    seedAccount()
    const holder = spawnProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dirFor(EMAIL), stdio: 'ignore' })
    try {
      await new Promise(resolve => setTimeout(resolve, 300))
      const talk = converse()
      await expect((await flow()).run(talk.session)).rejects.toThrow(/in use by a running Claude Code process/u)
      expect(oldCredentials()).toBe(`OLD-ACCOUNT-${EMAIL}`)
      expect(talk.commits).toEqual([])
      expect(leftovers()).toEqual([])
    } finally {
      holder.kill()
    }
  }, 30_000)
})

describe('removeTree', () => {
  it('deletes a tree of plain files and treats a missing one as gone', async () => {
    const tree = join(scratch, 'tree')
    mkdirSync(join(tree, 'a', 'b'), { recursive: true })
    writeFileSync(join(tree, 'a', 'b', 'file.txt'), 'x')
    expect(await removeTree(tree)).toBe(true)
    expect(existsSync(tree)).toBe(false)
    expect(await removeTree(tree)).toBe(true)
  })

  it('leaves a tree holding a link untouched and says why, never following the link', async () => {
    const outside = join(scratch, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious.txt'), 'keep me')
    const tree = join(scratch, 'tree')
    mkdirSync(join(tree, 'a'), { recursive: true })
    symlinkSync(outside, join(tree, 'a', 'link'), 'junction')
    const warnings: string[] = []
    expect(await removeTree(tree, message => warnings.push(message))).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('contains a link')
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep me')
    expect(existsSync(join(tree, 'a', 'link'))).toBe(true)
  })

  it('does not delete through a link given as the root itself', async () => {
    const outside = join(scratch, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious.txt'), 'keep me')
    const root = join(scratch, 'rootlink')
    symlinkSync(outside, root, 'junction')
    expect(await removeTree(root)).toBe(false)
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep me')
  })
})
