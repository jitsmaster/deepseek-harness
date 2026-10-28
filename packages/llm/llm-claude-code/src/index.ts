/**
 * Claude Code-backed `LlmAdapter` plugin. It contributes the `claude-code`
 * provider route to the `ctx.llm` registry and serves each model call with one
 * headless `claude -p` process of the user's own executable under the shared
 * subprocess seam. By default the run uses the login the user's Claude Code
 * already has. Claude accounts signed in from DSH (one flow this plugin
 * registers with the authorization seam, run by the real `claude auth login`)
 * each live in their own config directory under `accountsDir`, and the child of
 * a call runs as the live-configurable `activeAccount`; that wins over the
 * optional `credential` option, which hands the child the access token (or API
 * key) of a stored DSH credential record. The optional `rateLimitFile` option
 * shares the latest plan-usage reading as a JSON file, and each account keeps
 * its own reading beside its files.
 *
 * @module @deepseek-ai/dsh-llm-claude-code
 */

import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import { clampTimeout, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  CLAUDE_CODE_DEFAULT_CONTEXT_WINDOW,
  CLAUDE_CODE_LLM_DEFAULT_TIMEOUT_MS,
  CLAUDE_CODE_LLM_PROVIDER_ID,
  ClaudeCodeLlmAdapter,
} from './adapter.ts'
import {
  ACCOUNT_KEY,
  accountEnv,
  accountsRecord,
  CONFIG_DIR_ENV,
  CREDENTIALS_FILE,
  defaultAccountsDir,
  findAccount,
  isAccountId,
  parseAccounts,
} from './account.ts'
import { credentialEnv } from './credential.ts'
import { defaultConfigPaths } from './default-login.ts'
import type { RateLimitReading } from './decoder.ts'
import { defaultExecutable } from './executable.ts'
import { claudeAccountFlow } from './login.ts'
import type { ClaudeModelEntry } from './models.ts'
import { RateLimitFile, USAGE_FILE } from './rate-limit.ts'
import { createClaudeAccountsService } from './service.ts'
import './types.ts'

export {
  CLAUDE_CODE_DEFAULT_CONTEXT_WINDOW,
  CLAUDE_CODE_LLM_DEFAULT_TIMEOUT_MS,
  CLAUDE_CODE_LLM_PROVIDER_ID,
  ClaudeCodeLlmAdapter,
  claudeArgv,
} from './adapter.ts'
export type { ClaudeCodeLlmAdapterOptions } from './adapter.ts'
export {
  ACCOUNT_KEY,
  accountEnv,
  accountId,
  defaultAccountsDir,
  extractAuthorizeUrl,
  isPlausibleEmail,
  normalizeEmail,
  parseAccounts,
  parseAuthStatus,
} from './account.ts'
export type { AccountEntry, AuthStatus } from './account.ts'
export { defaultConfigPaths, makeDefaultLogin, readDefaultEmail } from './default-login.ts'
export type { DefaultConfigPaths, KnownAccount, MakeDefaultOutcome } from './default-login.ts'
export { createClaudeAccountsService } from './service.ts'
export type {
  ClaudeAccountInfo, ClaudeAccountsService, ClaudeAccountsStatus, ClaudeAccountUsage, ClaudeAccountWindow, ClaudeMakeDefaultResult,
  ClaudeSignOutResult,
} from './types.ts'
export { readAccountUsage } from './rate-limit.ts'
export type { AccountUsage } from './rate-limit.ts'
export type { RateLimitReading, RateLimitWindow } from './decoder.ts'
export { DEFAULT_CLAUDE_EXECUTABLE, defaultExecutable, locateExecutable } from './executable.ts'
export { BUILTIN_MODELS, CLAUDE_EFFORTS } from './models.ts'
export type { ClaudeModelEntry } from './models.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-claude-code'

/**
 * The seams this adapter needs: the LLM registry it joins and the process owner it spawns through.
 * The optional credentials service is read lazily per call.
 */
export const inject = ['llm', 'subprocess']

/** Plugin config (all optional — `apply` fills the defaults). */
export interface Config {
  /** Path or PATH-resolvable name of the user's own `claude` executable. Defaults to `claude` on PATH, else `~/.local/bin/claude`. */
  executable?: string
  /** Node binary that runs the tool-schema MCP stub. Defaults to the harness's own Node. */
  nodeExecutable?: string
  /** Whole-call deadline in milliseconds. Defaults to 1800000. */
  timeoutMs?: number
  /** Context window assumed for a model id the catalog does not list. Defaults to 200000. */
  defaultContextWindow?: number
  /** Root of the Claude Code config directories of the accounts signed in from DSH. Defaults to `<DSH home>/claude-code/accounts`. */
  accountsDir?: string
  /** Emails of the Claude accounts offered at sign-in; an edit applies to the next sign-in without a remount. */
  accounts: Volatile<string[]>
  /** Email of the account every call runs as, when it has signed in; an edit applies to the next call without a remount. */
  activeAccount: Volatile<string | undefined>
  /**
   * Directory of the default Claude Code configuration that `claudeAccounts.makeDefault` swaps a login into
   * (its `.credentials.json` and `.claude.json`). Defaults to `CLAUDE_CONFIG_DIR` when set, else `~/.claude`
   * for the login and `~/.claude.json` for the settings.
   */
  defaultConfigDir?: string
  /**
   * Extra provider ids this plugin also serves with the same adapter (for example `anthropic`), so a session whose
   * saved route names a provider that is no longer registered keeps working through headless Claude Code. An id
   * another plugin already registered is skipped with a warning. Defaults to none.
   */
  providerAliases?: string[]
  /** Open the sign-in page in a private browser window (Chrome, Edge, or Firefox, when installed). Defaults to true. */
  privateBrowser?: boolean
  /**
   * Credential record key (e.g. `llm-pi-ai/anthropic`) whose token or key authenticates the child
   * when no signed-in account is active and usable; unset uses Claude Code's own login.
   */
  credential?: string
  /** JSON file that receives the latest plan-usage reading (five-hour and seven-day windows) after each call; unset writes nothing. */
  rateLimitFile?: string
  /** Models added to (or overriding entries of) the built-in Claude catalog. */
  models?: ClaudeModelEntry[]
}

/** Plain options accepted by the config schema; a live field takes its plain value. */
export type Options = { [K in keyof Config]?: Config[K] extends Volatile<infer T> ? Exclude<T, undefined> : Exclude<Config[K], undefined> }

export const Config = z.object({
  executable: z.string().min(1),
  nodeExecutable: z.string().min(1),
  timeoutMs: z.number().step(1).min(1),
  defaultContextWindow: z.number().step(1).min(1),
  accountsDir: z.string().min(1),
  accounts: z.array(z.string().min(1)).default([]).volatile(),
  activeAccount: z.string().min(1).volatile(),
  defaultConfigDir: z.string().min(1),
  providerAliases: z.array(z.string().min(1)),
  privateBrowser: z.boolean(),
  credential: z.string().min(1),
  rateLimitFile: z.string().min(1),
  models: z.array(z.object({
    id: z.string().min(1).required(),
    name: z.string().min(1).required(),
    contextWindow: z.number().step(1).min(1),
    description: z.string().min(1),
  })),
})

/** Build a function that warns through the logger once per distinct reason. */
function warnOnce(ctx: Context, subject: string): (reason: string) => void {
  const warned = new Set<string>()
  return (reason) => {
    if (warned.has(reason)) return
    warned.add(reason)
    ctx.logger.warn(`llm-claude-code: ${subject}: ${reason}`)
  }
}

/** Build a per-call resolver that reads the record and warns once per distinct reason; it never throws. */
function credentialResolver(ctx: Context, key: string): () => Promise<Record<string, string>> {
  const warn = warnOnce(ctx, `credential "${key}"`)
  return async () => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      warn('no credentials service is mounted; falling back to Claude Code\'s own login')
      return {}
    }
    try {
      const result = credentialEnv(await credentials.readRecord(parseCredentialKey(key)), Date.now())
      if (result.warning !== undefined) warn(result.warning)
      return result.env
    } catch {
      warn('reading the credential record failed; falling back to Claude Code\'s own login')
      return {}
    }
  }
}

/**
 * Build a per-call resolver for the active account. No active account is the
 * ordinary case and stays silent; an active account that cannot be used (never
 * signed in, files gone, no credentials service) warns once per distinct reason.
 * The active email is read through its live reference on every call. It never throws.
 */
function accountResolver(
  ctx: Context,
  accountsDir: string,
  active: Volatile<string | undefined>,
): () => Promise<Record<string, string>> {
  const warn = warnOnce(ctx, `accounts "${accountsDir}"`)
  const fallBack = '; falling back to the credential option or Claude Code\'s own login'
  return async () => {
    const email = active.get()
    if (email === undefined) return {}
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      warn(`active account ${email}: no credentials service is mounted${fallBack}`)
      return {}
    }
    try {
      const record = await credentials.readRecord(ACCOUNT_KEY)
      const entry = findAccount(record, email)
      const signedIn = entry !== undefined && await access(join(accountsDir, entry.id, CREDENTIALS_FILE)).then(() => true, () => false)
      const result = accountEnv(record, accountsDir, email, signedIn)
      if (result.warning !== undefined) warn(`${result.warning}${fallBack}`)
      return result.env
    } catch {
      warn(`reading the account record failed${fallBack}`)
      return {}
    }
  }
}

/** Build the observer that writes each run's plan-usage reading to `path`, warning once per distinct reason. */
function rateLimitWriter(ctx: Context, path: string): (reading: RateLimitReading) => void {
  const warn = warnOnce(ctx, `rateLimitFile "${path}"`)
  const file = new RateLimitFile(path, warn)
  return (reading) => { void file.write(reading) }
}

/**
 * Build the observer that keeps each account's own reading in `<account>/usage.json`. The account is the one the
 * run started as, taken from the environment the run was given, so an account switch between calls cannot misfile it.
 */
function accountUsageWriter(
  ctx: Context,
  accountsDir: string,
): (reading: RateLimitReading, env: Readonly<Record<string, string>>) => void {
  const warn = warnOnce(ctx, `accounts "${accountsDir}"`)
  const files = new Map<string, RateLimitFile>()
  return (reading, env) => {
    const directory = env[CONFIG_DIR_ENV]
    if (directory === undefined) return
    const id = relative(accountsDir, directory)
    if (id.includes(sep) || !isAccountId(id)) return
    const path = join(directory, USAGE_FILE)
    let file = files.get(path)
    if (file === undefined) {
      file = new RateLimitFile(path, (reason) => { warn(`account ${id}: ${reason}`) })
      files.set(path, file)
    }
    void file.write(reading)
  }
}

/**
 * Check the extra provider ids of the config.
 * @param aliases - the configured `providerAliases`.
 * @returns the ids, in order.
 * @throws Error naming the offending id when one is blank or padded, repeated, or the primary route id.
 */
export function checkProviderAliases(aliases: readonly string[]): string[] {
  const seen = new Set<string>([CLAUDE_CODE_LLM_PROVIDER_ID])
  for (const alias of aliases) {
    if (alias.length === 0 || alias.trim() !== alias) throw new Error(`llm-claude-code: providerAliases entry "${alias}" must be a non-empty id without surrounding spaces`)
    if (alias === CLAUDE_CODE_LLM_PROVIDER_ID) throw new Error(`llm-claude-code: providerAliases must not repeat the primary route "${alias}"`)
    if (seen.has(alias)) throw new Error(`llm-claude-code: providerAliases lists "${alias}" twice`)
    seen.add(alias)
  }
  return [...aliases]
}

/** Register the Claude Code adapter's provider route with `ctx.llm`. */
export function apply(ctx: Context, config: Config): void {
  const aliases = checkProviderAliases(config.providerAliases ?? [])
  const executable = config.executable ?? defaultExecutable()
  const accountsDir = config.accountsDir ?? defaultAccountsDir(resolveDshHome())
  const account = accountResolver(ctx, accountsDir, config.activeAccount)
  const stored = config.credential === undefined ? undefined : credentialResolver(ctx, config.credential)
  const global = config.rateLimitFile === undefined ? undefined : rateLimitWriter(ctx, config.rateLimitFile)
  const perAccount = accountUsageWriter(ctx, accountsDir)
  const adapter = new ClaudeCodeLlmAdapter({
    executable,
    ...config.nodeExecutable === undefined ? {} : { nodeExecutable: config.nodeExecutable },
    timeoutMs: clampTimeout(config.timeoutMs, CLAUDE_CODE_LLM_DEFAULT_TIMEOUT_MS, MAX_TIMER_DELAY_MS),
    defaultContextWindow: config.defaultContextWindow ?? CLAUDE_CODE_DEFAULT_CONTEXT_WINDOW,
    models: config.models ?? [],
    // Pasted images live in the durable attachment service; it is read lazily so a late mount still counts.
    resolveAttachments: () => ctx.get('attachments'),
    // The active DSH-signed-in account wins; the stored credential is read only when it is not usable.
    async resolveEnv() {
      const env = await account()
      return Object.keys(env).length > 0 || stored === undefined ? env : stored()
    },
    onRateLimit(reading, env) {
      global?.(reading)
      perAccount(reading, env)
    },
    spawn: spec => ctx.subprocess.spawn(spec),
  })
  ctx.llm.registerAdapter([CLAUDE_CODE_LLM_PROVIDER_ID], adapter)
  // One registration each: an id another plugin already serves must cost only that alias, never the primary route.
  for (const alias of aliases) {
    try {
      ctx.llm.registerAdapter([alias], adapter)
    } catch (error: unknown) {
      ctx.logger.warn(`llm-claude-code: provider alias "${alias}" was not registered (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  // Provided only while this plugin is mounted, so a surface that finds no `claudeAccounts` knows Claude Code is not the model route.
  ctx.provide('claudeAccounts', createClaudeAccountsService({
    accountsDir,
    accounts: () => config.accounts.get(),
    activeAccount: () => config.activeAccount.get(),
    readRecord: async () => ctx.get('credentials')?.readRecord(ACCOUNT_KEY),
    forgetAccount: async (id) => {
      await ctx.get('credentials')?.modifyRecord(ACCOUNT_KEY, record => Promise.resolve(
        accountsRecord(parseAccounts(record).filter(entry => entry.id !== id)),
      ))
    },
    defaultPaths: () => defaultConfigPaths({ dir: config.defaultConfigDir, env: process.env, home: homedir() }),
    log: (message) => { ctx.logger.info(`llm-claude-code: ${message}`) },
  }))
  // Scoped to the authorization seam: a composition without it has no surface to sign in from, and the rest of the plugin still works.
  ctx.inject(['authorization'], (authorized) => {
    authorized.authorization.registerFlow(claudeAccountFlow({
      executable,
      accountsDir,
      knownAccounts: () => config.accounts.get(),
      readRecord: async () => ctx.get('credentials')?.readRecord(ACCOUNT_KEY),
      privateBrowser: config.privateBrowser ?? true,
      spawn: spec => ctx.subprocess.spawn(spec),
      warn: (message) => { ctx.logger.warn(`llm-claude-code: accounts "${accountsDir}": ${message}`) },
    }))
  })
}
