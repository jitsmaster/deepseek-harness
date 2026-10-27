/**
 * The Claude account sign-in flow for `ctx.authorization`. The human picks (or
 * types) the account's email, then the REAL `claude auth login --email` runs
 * headless under a staging config directory: its sign-in page is handed to the
 * human, the code they paste is written to its stdin, and only a finished login
 * replaces the files of that one account under the accounts root. Tokens never
 * leave the account directory (Claude Code owns and refreshes them), so the
 * committed record only lists the accounts and holds no secret, and DSH calls no
 * Anthropic endpoint itself.
 * @module @deepseek-ai/dsh-llm-claude-code/login
 */

import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import type { AuthorizationFlow, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import {
  accountDir,
  accountId,
  ACCOUNT_KEY,
  accountsRecord,
  CONFIG_DIR_ENV,
  CREDENTIALS_FILE,
  extractAuthorizeUrl,
  isPlausibleEmail,
  mergeAccount,
  normalizeEmail,
  parseAccounts,
  parseAuthStatus,
  stripEscapes,
} from './account.ts'
import type { AuthStatus } from './account.ts'
import { writeLauncher } from './browser.ts'
import { locateExecutable } from './executable.ts'

/** Default whole-login budget: the human has to open a page and copy a code. */
export const LOGIN_DEFAULT_TIMEOUT_MS = 600_000

/** Code of a sign-in that exceeded its deadline. */
const LOGIN_TIMEOUT_CODE = 'LLM_CLAUDE_CODE_LOGIN_TIMEOUT'

/** Budget of the `claude auth status` check that reads the new account. */
const STATUS_TIMEOUT_MS = 30_000

/** Termination grace handed to the subprocess seam. */
const TERMINATION_GRACE_MS = 2_000

/** Output kept per stream for URL detection and failure diagnostics, in characters. */
const OUTPUT_TAIL_CHARS = 65_536

/** Characters of child output quoted in an error message. */
const DETAIL_CHARS = 300

/** Default tries and pause when the directory swap meets a file a running process holds open. */
const SWAP_ATTEMPTS = 20
const SWAP_DELAY_MS = 250

/** Errno codes of a rename blocked by an open handle (Windows reports several). */
const BUSY_CODES: ReadonlySet<string | undefined> = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

/** Ambient credentials that would make `claude auth` report some other identity than the config directory's. */
const AMBIENT_CREDENTIALS = {
  ANTHROPIC_API_KEY: undefined,
  ANTHROPIC_AUTH_TOKEN: undefined,
  CLAUDE_CODE_OAUTH_TOKEN: undefined,
} as const

/** Options of the sign-in flow. */
export interface AccountFlowOptions {
  /** Path or bare name of the user's `claude` executable. */
  executable: string
  /** Root of the account directories; each account signs into `<accountsDir>/<id>`. */
  accountsDir: string
  /** Emails offered up front (the `accounts` option), read at each sign-in. */
  knownAccounts: () => readonly string[]
  /** Reads the stored account list; `undefined` when nothing is stored. */
  readRecord: () => Promise<CredentialRecord | undefined>
  /** Open the sign-in page in a private browser window. Defaults to true. */
  privateBrowser?: boolean
  /** Platform, environment, and file test used to find the private browser; they default to this machine. */
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  exists?: (path: string) => boolean
  /** Subprocess seam spawn. */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
  /** Receives a secret-free diagnostic the flow could not act on. */
  warn?: (message: string) => void
  /** Whole-login deadline in milliseconds. Defaults to ten minutes. */
  loginTimeoutMs?: number
  /** How often the swap retries a directory a running process holds open. */
  swapAttempts?: number
  /** Pause between swap retries, in milliseconds. */
  swapDelayMs?: number
  /** Clock, for the sign-in time. */
  now?: () => number
}

/** How a child ended; a spawn failure arrives as `error`. */
interface Exit {
  kind: 'exit'
  exitCode: number | null
  error?: unknown
}

/** One running `claude auth` child with its captured output. */
interface Launched {
  child: SubprocessHandle
  stdout(): string
  stderr(): string
  /** Stdout and stderr in arrival order. */
  output(): string
  /** Settles when the process closes; a spawn failure arrives as `error`. */
  exited: Promise<Exit>
  /** Terminate the child and wait until its whole process range is gone. */
  dispose(): Promise<void>
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Resolve when the signal aborts (immediately when it already has). */
function stopped(signal: AbortSignal): Promise<{ kind: 'stop' }> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve({ kind: 'stop' })
    else signal.addEventListener('abort', () => { resolve({ kind: 'stop' }) }, { once: true })
  })
}

/** The failure a stopped login reports: a timeout names its budget, anything else is a cancellation. */
function stopError(signal: AbortSignal): Error {
  const timeout = timeoutOf(signal, LOGIN_TIMEOUT_CODE)
  return timeout === undefined
    ? new Error('Claude sign-in was cancelled', { cause: signal.reason })
    : new Error(`Claude sign-in timed out after ${timeout.timeoutMs}ms`, { cause: timeout })
}

/** The last readable characters of captured output, with escape sequences and any secret removed. */
function tail(output: string, secret?: string): string {
  const clean = stripEscapes(output).trim()
  const redacted = secret === undefined || secret.length === 0 ? clean : clean.replaceAll(secret, '[code]')
  return redacted.slice(-DETAIL_CHARS)
}

/** Whether a path exists, without following a final link. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** The first symlink or junction under a directory, if any. */
async function findLink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) return path
    if (entry.isDirectory()) {
      const nested = await findLink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Delete a directory tree this module created, unless it holds a link. A junction
 * or symlink could lead a recursive delete into somebody else's files, so a tree
 * with one is left untouched and reported.
 * @param root - the directory to delete; a missing one counts as deleted.
 * @param warn - receives the reason when the tree is kept.
 * @returns whether the tree is gone.
 */
export async function removeTree(root: string, warn?: (message: string) => void): Promise<boolean> {
  let info
  try {
    info = await lstat(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  const link = info.isSymbolicLink() ? root : info.isDirectory() ? await findLink(root) : undefined
  if (link !== undefined) {
    warn?.(`not deleting "${root}": it contains a link ("${link}")`)
    return false
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  return true
}

/** Start one `claude auth ...` child with piped streams and a bounded capture of its output. */
function launch(options: AccountFlowOptions, argv: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, piped: boolean): Launched {
  const child = options.spawn({
    argv,
    cwd: tmpdir(),
    stdio: { stdin: piped ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: TERMINATION_GRACE_MS,
    signal,
    env: { ...AMBIENT_CREDENTIALS, ...env },
  })
  // The child may be gone by the time the code is written.
  child.stdin?.on('error', () => undefined)
  const captured = { stdout: '', stderr: '', output: '' }
  const capture = (stream: Readable | undefined, name: 'stdout' | 'stderr'): void => {
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk: string) => {
      captured[name] = (captured[name] + chunk).slice(-OUTPUT_TAIL_CHARS)
      captured.output = (captured.output + chunk).slice(-OUTPUT_TAIL_CHARS)
    })
    stream?.on('error', () => undefined)
  }
  capture(child.stdout, 'stdout')
  capture(child.stderr, 'stderr')
  return {
    child,
    stdout: () => captured.stdout,
    stderr: () => captured.stderr,
    output: () => captured.output,
    exited: child.done.then(
      outcome => ({ kind: 'exit' as const, exitCode: outcome.exitCode }),
      (error: unknown) => ({ kind: 'exit' as const, exitCode: null, error }),
    ),
    async dispose() {
      child.terminate()
      await child.waitForExit().catch(() => false)
      await child.done.catch(() => undefined)
    },
  }
}

/** Resolve with the page's URL once the login prints it. */
function whenUrl(login: Launched): Promise<{ kind: 'url'; url: string }> {
  return new Promise((resolve) => {
    const look = (): boolean => {
      const url = extractAuthorizeUrl(login.output())
      if (url === undefined) return false
      resolve({ kind: 'url', url })
      return true
    }
    if (look()) return
    const watch = (stream: Readable | undefined): void => {
      const listener = (): void => { if (look()) stream?.off('data', listener) }
      stream?.on('data', listener)
    }
    watch(login.child.stdout)
    watch(login.child.stderr)
  })
}

/** Describe a login that ended without success. */
function failure(login: Launched, exit: Exit, secret?: string): Error {
  if (exit.error !== undefined) return new Error(`Claude Code could not start: ${errorText(exit.error)}`, { cause: exit.error })
  const how = exit.exitCode === null ? 'was terminated' : `exited with code ${exit.exitCode}`
  const detail = tail(login.output(), secret)
  return new Error(`Claude Code sign-in ${how}${detail.length > 0 ? `: ${detail}` : ''}`)
}

/** Read the new account's facts with `claude auth status`, which uses no quota. */
async function readStatus(options: AccountFlowOptions, executable: string, staging: string, signal: AbortSignal): Promise<AuthStatus> {
  using limit = deadline(signal, STATUS_TIMEOUT_MS, 'LLM_CLAUDE_CODE_STATUS_TIMEOUT')
  const status = launch(options, [executable, 'auth', 'status', '--json'], { [CONFIG_DIR_ENV]: staging }, limit.signal, false)
  try {
    const exit = await Promise.race([status.exited, stopped(limit.signal)])
    if (exit.kind === 'stop') {
      throw signal.aborted ? stopError(signal) : new Error(`claude auth status did not answer within ${STATUS_TIMEOUT_MS}ms`)
    }
    if (exit.error !== undefined) throw failure(status, exit)
    const parsed = parseAuthStatus(status.stdout())
    if (parsed === undefined) throw new Error(`claude auth status gave no account information (exit code ${exit.exitCode ?? 'none'})`)
    if (!parsed.loggedIn) throw new Error('Claude Code reports it is not signed in after the login finished')
    return parsed
  } finally {
    await status.dispose()
  }
}

/**
 * Put a finished login in place of that account's current files. The old directory is
 * renamed aside first and restored if the new one cannot take its place, so a
 * failure leaves the previous account as it was. A rename Windows refuses
 * because a running Claude Code holds a file open is retried briefly.
 * @param staging - the directory holding the finished login.
 * @param target - where the account must end up.
 * @param options - retry budget and diagnostics.
 */
async function replaceAccount(staging: string, target: string, options: AccountFlowOptions): Promise<void> {
  const attempts = options.swapAttempts ?? SWAP_ATTEMPTS
  const delay = options.swapDelayMs ?? SWAP_DELAY_MS
  const move = async (from: string, to: string): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(from, to)
        return
      } catch (error) {
        if (!BUSY_CODES.has((error as NodeJS.ErrnoException).code) || attempt >= attempts) throw error
        await sleep(delay)
      }
    }
  }
  let aside: string | undefined
  if (await exists(target)) {
    aside = `${target}.old-${Date.now()}`
    try {
      await move(target, aside)
    } catch (error) {
      throw new Error(`the current Claude account is in use by a running Claude Code process; try again when no request is running (${errorText(error)})`, { cause: error })
    }
  }
  try {
    await move(staging, target)
  } catch (error) {
    if (aside !== undefined) await move(aside, target).catch(() => undefined)
    throw new Error(`could not put the new Claude account in place: ${errorText(error)}`, { cause: error })
  }
  if (aside !== undefined) {
    await removeTree(aside, options.warn).catch((error: unknown) => {
      options.warn?.(`could not delete the previous account files "${aside}": ${errorText(error)}`)
    })
  }
}

/**
 * Carry the conversation with a running login: hand its page to the human, pass
 * the pasted code to its stdin, and wait for it to finish. The browser may
 * complete the login by itself, so the question is withdrawn when the child
 * exits first.
 */
async function converse(
  session: AuthorizationSession,
  login: Launched,
  signal: AbortSignal,
  message: string,
): Promise<{ exit: Exit; code?: string }> {
  const first = await Promise.race([whenUrl(login), login.exited, stopped(signal)])
  if (first.kind === 'stop') throw stopError(signal)
  if (first.kind === 'exit') return { exit: first }
  session.notify({ message, url: first.url })
  const asking = new AbortController()
  const answer = session.prompt({
    kind: 'text',
    message: 'Paste the code from the Claude page (sign-in also finishes by itself once the browser completes it).',
    placeholder: 'Paste code here',
    signal: asking.signal,
  }).then(value => ({ kind: 'code' as const, value }))
  answer.catch(() => undefined)
  const next = await Promise.race([answer, login.exited, stopped(signal)])
  if (next.kind === 'stop') throw stopError(signal)
  if (next.kind === 'exit') {
    asking.abort()
    return { exit: next }
  }
  const code = next.value.trim()
  if (code.length === 0) throw new Error('no sign-in code was entered')
  session.notify({ message: 'Finishing sign-in…' })
  login.child.stdin?.write(`${code}\n`)
  const exit = await Promise.race([login.exited, stopped(signal)])
  if (exit.kind === 'stop') throw stopError(signal)
  return { exit, code }
}

/** Entry of the select prompt that stands for an address that is not listed. */
const OTHER_ACCOUNT = '__other__'

/**
 * Ask which account to sign in: the known emails (the configured ones and the
 * ones already signed in) as options plus a free-text entry for another address.
 * With nothing known it goes straight to the text question.
 */
async function chooseEmail(session: AuthorizationSession, options: AccountFlowOptions): Promise<string> {
  const signedIn = new Set(parseAccounts(await options.readRecord()).map(entry => normalizeEmail(entry.email)))
  const known = [...new Set([...options.knownAccounts(), ...signedIn].map(normalizeEmail).filter(email => email.length > 0))]
  let email: string | undefined
  if (known.length > 0) {
    const choice = await session.prompt({
      kind: 'select',
      message: 'Which Claude account do you want to sign in?',
      options: [
        ...known.map(candidate => ({
          id: candidate,
          label: candidate,
          description: signedIn.has(candidate) ? 'signed in; signing in again replaces it' : 'not signed in yet',
        })),
        { id: OTHER_ACCOUNT, label: 'Another email address' },
      ],
    })
    if (choice !== OTHER_ACCOUNT) email = choice
  }
  email ??= await session.prompt({
    kind: 'text',
    message: 'Email address of the Claude account to sign in',
    placeholder: 'name@example.com',
  })
  if (!isPlausibleEmail(email)) throw new Error('that is not an email address')
  return normalizeEmail(email)
}

/**
 * Build the authorization flow that signs a Claude account in through Claude Code.
 * @param options - the executable, the accounts root, the stored list, and the subprocess seam.
 * @returns the flow to register with `ctx.authorization`.
 */
export function claudeAccountFlow(options: AccountFlowOptions): AuthorizationFlow {
  return {
    key: ACCOUNT_KEY,
    label: 'Claude (Claude Code)',
    methods: [{ id: 'oauth', label: 'Sign in with Claude' }],
    async run(session) {
      const executable = locateExecutable(options.executable)
      if (executable === undefined) throw new Error(`Claude Code executable "${options.executable}" was not found`)
      using limit = deadline(session.signal, options.loginTimeoutMs ?? LOGIN_DEFAULT_TIMEOUT_MS, LOGIN_TIMEOUT_CODE)
      const { signal } = limit
      const choosing = chooseEmail(session, options)
      choosing.catch(() => undefined)
      const picked = await Promise.race([choosing, stopped(signal)])
      if (typeof picked !== 'string') throw stopError(signal)
      await mkdir(options.accountsDir, { recursive: true })
      // A sibling of the account directories: the final swap is then a rename on one volume.
      const staging = await mkdtemp(join(options.accountsDir, `${accountId(picked)}.login-`))
      let login: Launched | undefined
      try {
        const env: NodeJS.ProcessEnv = { [CONFIG_DIR_ENV]: staging }
        let hint = ''
        let launcher: string | undefined
        if (options.privateBrowser !== false) {
          // The page opens in a private window, so a claude.ai session already open in the normal profile cannot pick the account.
          const written = await writeLauncher(
            staging,
            options.platform ?? process.platform,
            options.env ?? process.env,
            options.exists ?? existsSync,
          )
          launcher = written.path
          env.BROWSER = written.path
          if (written.browser !== undefined) hint = ` (a private ${written.browser.name} window opens for you)`
        }
        login = launch(options, [executable, 'auth', 'login', '--claudeai', `--email=${picked}`], env, signal, true)
        const started = login
        const message = `Open this page${hint}, sign in as ${picked}, and paste the code it shows.`
        const { exit, code } = await converse(session, started, signal, message)
        if (exit.exitCode !== 0) throw failure(started, exit, code)
        if (!await exists(join(staging, CREDENTIALS_FILE))) {
          throw new Error('Claude Code finished signing in but wrote no credentials file in the account directory (this platform may keep them in a keychain, which this sign-in does not support)')
        }
        const status = await readStatus(options, executable, staging, signal)
        // The login child is gone before its directory moves; the launcher is not part of the account.
        await started.dispose()
        if (launcher !== undefined) await rm(launcher, { force: true })
        signal.throwIfAborted()
        // The account that actually signed in wins over the one that was asked for.
        const email = normalizeEmail(status.email ?? picked)
        if (email !== picked) session.notify({ message: `Signed in as ${email} instead of ${picked}; that account is the one saved.` })
        const id = accountId(email)
        await replaceAccount(staging, accountDir(options.accountsDir, id), options)
        const signedInAt = new Date((options.now ?? Date.now)()).toISOString()
        const entries = mergeAccount(parseAccounts(await options.readRecord()), { id, email, signedInAt })
        await session.commit(accountsRecord(entries))
        session.notify({ message: `Signed in ${email}. Make it the activeAccount to run Claude Code as it.` })
      } finally {
        await login?.dispose()
        await removeTree(staging, options.warn)
      }
    },
  }
}
