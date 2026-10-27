/**
 * The file half of "make this account the default for every Claude Code": it
 * swaps one signed-in account's login into the user's default Claude Code
 * configuration, so every NEW Claude Code process (terminals, other tools) runs
 * as that account. Nothing is taken for granted about the files: the originals
 * are backed up first, the login Claude Code may have refreshed since DSH last
 * saw it is saved back into its account folder before anything is replaced, every
 * write is a temp file plus rename, and only the `oauthAccount` object of the
 * settings file is touched. No token is ever read into a return value or an error.
 * @module @deepseek-ai/dsh-llm-claude-code/default-login
 */

import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { CONFIG_DIR_ENV, CREDENTIALS_FILE, normalizeEmail } from './account.ts'

/** File Claude Code keeps its global settings and the signed-in profile (`oauthAccount`) in. */
export const SETTINGS_FILE = '.claude.json'

/** Folder, inside the default config directory, that receives the backups. */
export const BACKUPS_DIR = 'dsh-backups'

/** How many backups are kept. */
export const KEEP_BACKUPS = 5

/** Where the default Claude Code configuration lives. */
export interface DefaultConfigPaths {
  /** The login file (secret). */
  credentials: string
  /** The settings file holding `oauthAccount`. */
  settings: string
  /** Folder that receives `<timestamp>` backup folders. */
  backups: string
}

/** One account folder DSH knows about. */
export interface KnownAccount {
  email: string
  /** The account's config directory. */
  dir: string
}

/** What a swap needs. */
export interface MakeDefaultInput {
  paths: DefaultConfigPaths
  /** The account to make the default. */
  target: KnownAccount
  /** Every account folder DSH knows (the target included). */
  known: readonly KnownAccount[]
  /** Clock; defaults to the real one. */
  now?: () => Date
  /** Rename operation, replaceable by a test to simulate a failure. */
  rename?: (from: string, to: string) => Promise<void>
}

/** The outcome of a swap; failures carry a secret-free reason. */
export type MakeDefaultOutcome =
  | { ok: true; backupDir: string; unchanged: boolean }
  | { ok: false; reason: string }

/**
 * Locate the default Claude Code files.
 * @param options.dir - an explicit config directory (the plugin's `defaultConfigDir`); wins over the environment.
 * @param options.env - the process environment; `CLAUDE_CONFIG_DIR` there names the directory Claude Code itself uses.
 * @param options.home - the user's home directory.
 * @returns the three locations. Without a directory the settings file is `~/.claude.json` and the login
 *   `~/.claude/.credentials.json`; with one, both live inside it.
 */
export function defaultConfigPaths(options: {
  dir?: string | undefined
  env?: Readonly<Record<string, string | undefined>>
  home: string
}): DefaultConfigPaths {
  const configured = options.dir ?? options.env?.[CONFIG_DIR_ENV]
  if (configured !== undefined && configured.length > 0) {
    return {
      credentials: join(configured, CREDENTIALS_FILE),
      settings: join(configured, SETTINGS_FILE),
      backups: join(configured, BACKUPS_DIR),
    }
  }
  const dir = join(options.home, '.claude')
  return { credentials: join(dir, CREDENTIALS_FILE), settings: join(options.home, SETTINGS_FILE), backups: join(dir, BACKUPS_DIR) }
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'error'
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

/** Read a JSON object file: `undefined` when absent, `'invalid'` when it is not a JSON object. */
async function readObject(path: string): Promise<JsonObject | undefined | 'invalid'> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    return codeOf(error) === 'ENOENT' ? undefined : 'invalid'
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return isObject(parsed) ? parsed : 'invalid'
  } catch {
    return 'invalid'
  }
}

/**
 * The email Claude Code records for the account its default config signs in.
 * @param paths - the default config location.
 * @returns the lowercased `oauthAccount.emailAddress`, or `undefined` when the file or key is absent or unreadable.
 */
export async function readDefaultEmail(paths: DefaultConfigPaths): Promise<string | undefined> {
  const settings = await readObject(paths.settings)
  if (settings === undefined || settings === 'invalid') return undefined
  const account = settings.oauthAccount
  const email = isObject(account) ? account.emailAddress : undefined
  return typeof email === 'string' && email.trim().length > 0 ? normalizeEmail(email) : undefined
}

/** The `oauthAccount` object of an account folder's settings file. */
async function readProfile(dir: string): Promise<JsonObject | undefined> {
  const settings = await readObject(join(dir, SETTINGS_FILE))
  if (settings === undefined || settings === 'invalid') return undefined
  return isObject(settings.oauthAccount) ? settings.oauthAccount : undefined
}

let counter = 0

function tempName(path: string): string {
  return `${path}.${process.pid}.${++counter}.tmp`
}

/** Copy `from` over `to` atomically: a temp file beside `to`, then a rename. */
async function copyAtomic(from: string, to: string, move: (from: string, to: string) => Promise<void>): Promise<void> {
  const temp = tempName(to)
  try {
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, temp)
    await move(temp, to)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function stamp(date: Date): string {
  return date.toISOString().replaceAll(/[-:.]/gu, '')
}

const BACKUP_NAME = /^\d{8}T\d{9}Z(?:-\d+)?$/u

/** Keep only the newest {@link KEEP_BACKUPS} backup folders; the one just made always stays, whatever the clock says. */
async function pruneBackups(root: string, current: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const names = entries
    .filter(entry => entry.isDirectory() && entry.name !== current && BACKUP_NAME.test(entry.name))
    .map(entry => entry.name)
    .sort()
  for (const name of names.slice(0, Math.max(0, names.length - (KEEP_BACKUPS - 1)))) {
    await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Copy the default files into a fresh `<timestamp>` folder; returns it. */
async function backUp(paths: DefaultConfigPaths, now: Date): Promise<string> {
  await mkdir(paths.backups, { recursive: true })
  let dir = join(paths.backups, stamp(now))
  for (let attempt = 1; await exists(dir); attempt += 1) dir = join(paths.backups, `${stamp(now)}-${String(attempt)}`)
  await mkdir(dir)
  for (const file of [paths.credentials, paths.settings]) {
    if (await exists(file)) await copyFile(file, join(dir, file === paths.credentials ? CREDENTIALS_FILE : SETTINGS_FILE))
  }
  await pruneBackups(paths.backups, basename(dir))
  return dir
}

function fail(reason: string): MakeDefaultOutcome {
  return { ok: false, reason }
}

/**
 * Make one signed-in account the login of the default Claude Code configuration.
 * @param input - the default config location, the account to install, and the account folders DSH knows.
 * @returns the backup folder (and whether the default already was that account), or a reason nothing was changed
 *   or the originals were restored.
 */
export async function makeDefaultLogin(input: MakeDefaultInput): Promise<MakeDefaultOutcome> {
  const { paths, target } = input
  const move = input.rename ?? rename
  const targetCredentials = join(target.dir, CREDENTIALS_FILE)
  if (!await exists(targetCredentials)) return fail(`${target.email} has no saved Claude Code login; sign in again`)
  const profile = await readProfile(target.dir)
  if (profile === undefined) return fail(`${target.email} has no saved profile (${SETTINGS_FILE} with oauthAccount); sign in again`)
  const current = await readObject(paths.settings)
  if (current === 'invalid') return fail(`the default ${SETTINGS_FILE} is not valid JSON; nothing was changed`)

  let backupDir: string
  try {
    backupDir = await backUp(paths, (input.now ?? (() => new Date()))())
  } catch (error: unknown) {
    return fail(`could not back up the default login (${codeOf(error)}); nothing was changed`)
  }

  // The login Claude Code holds now may be newer than the copy DSH kept: save it back before replacing it.
  const defaultEmail = await readDefaultEmail(paths)
  const owner = defaultEmail === undefined ? undefined : input.known.find(account => normalizeEmail(account.email) === defaultEmail)
  if (owner !== undefined && await exists(paths.credentials) && await exists(owner.dir)) {
    try {
      await copyAtomic(paths.credentials, join(owner.dir, CREDENTIALS_FILE), move)
    } catch (error: unknown) {
      return fail(`could not save the current default login back to ${owner.email} (${codeOf(error)}); nothing was changed`)
    }
  }
  if (defaultEmail === normalizeEmail(target.email)) return { ok: true, backupDir, unchanged: true }

  const settingsTemp = tempName(paths.settings)
  const credentialsTemp = tempName(paths.credentials)
  try {
    await mkdir(dirname(paths.settings), { recursive: true })
    await mkdir(dirname(paths.credentials), { recursive: true })
    await writeFile(settingsTemp, `${JSON.stringify({ ...current, oauthAccount: profile }, null, 2)}\n`, { mode: 0o600 })
    await copyFile(targetCredentials, credentialsTemp)
  } catch (error: unknown) {
    await Promise.all([rm(settingsTemp, { force: true }), rm(credentialsTemp, { force: true })]).catch(() => undefined)
    return fail(`could not prepare the new default login (${codeOf(error)}); nothing was changed`)
  }
  try {
    await move(credentialsTemp, paths.credentials)
  } catch (error: unknown) {
    await Promise.all([rm(settingsTemp, { force: true }), rm(credentialsTemp, { force: true })]).catch(() => undefined)
    return fail(`could not replace the default login (${codeOf(error)}); it was left as it was`)
  }
  try {
    await move(settingsTemp, paths.settings)
  } catch (error: unknown) {
    await rm(settingsTemp, { force: true }).catch(() => undefined)
    // The login was replaced but its profile was not: put the original login back so the two files agree.
    const saved = join(backupDir, CREDENTIALS_FILE)
    // With no original login to restore, the one just installed must not stay behind.
    const restored = await exists(saved)
      ? await copyAtomic(saved, paths.credentials, move).then(() => true, () => false)
      : await rm(paths.credentials, { force: true }).then(() => true, () => false)
    return fail(`could not update the default ${SETTINGS_FILE} (${codeOf(error)}); ${restored ? 'the original login was restored' : `restore ${saved} by hand`}`)
  }
  return { ok: true, backupDir, unchanged: false }
}
