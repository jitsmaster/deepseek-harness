/**
 * Real end-to-end coverage for SDK-backed command discovery
 * (`listClaudeCodeCommands()`) and one-shot slash-command invocation
 * (`runClaudeCodeSlashCommand()`): a REAL `claude` CLI binary is spawned
 * against a fully hermetic fixture home + fixture project (its own
 * `CLAUDE_CONFIG_DIR`; the real `~/.claude` and the real repo working
 * directory are never touched), backed by the package-private loopback
 * Anthropic Messages fixture (`./messages-fixture.ts`) instead of real
 * network/credentials — the same "genuine CLI process, fake Messages
 * endpoint" convention `./real-product.spec.ts` already establishes in this
 * package. That convention is why this file is an ordinary `*.spec.ts`
 * (not `*.e2e.ts`): it needs no real Anthropic auth, so it runs in the
 * default `pnpm test` suite rather than the opt-in `*.e2e.ts` lane.
 *
 * Ground truth for the command listing is a second, fully independent
 * `officialQuery()` call (raw `node:child_process.spawn`, no DSH plumbing
 * at all — see `spawnDirectChild`/`directSupportedCommands` below) against
 * the identical fixture cwd/env. `listClaudeCodeCommands()`'s result is
 * compared against it by name, as a set, since the real CLI does not
 * guarantee listing order and also reports its own bundled default
 * commands/plugins (e.g. "clear", "compact", "mcp", "design", "loop") that
 * ship with every install regardless of `CLAUDE_CONFIG_DIR` — those are not
 * asserted individually, only that both listings agree and that our fixture
 * commands/skill are present in both.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  Options,
  SlashCommand,
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'
import { query as officialQuery } from '@anthropic-ai/claude-agent-sdk'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import {
  listClaudeCodeCommands,
  runClaudeCodeSlashCommand,
} from '../src/list-commands.ts'
import { DEFAULT_CLAUDE_CODE_PERMISSION_MODE, type ClaudeCodeRunSpec } from '../src/run.ts'
import { startMessagesFixture, type MessagesFixture } from './messages-fixture.ts'

const fakeKey = 'dsh-fake-anthropic-key-command-listing'

const roots: string[] = []
const contexts: Context[] = []
const fixtures: MessagesFixture[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
  for (const root of roots.splice(0)) {
    try {
      // A just-exited real CLI child (and Windows Defender scanning its
      // fixture files right after) can hold a file lock briefly past the
      // process's own reported exit — retry generously rather than leak the
      // temp directory; this is cleanup, not something assertions depend on.
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 })
    } catch {
      // Best-effort even after retries exhaust.
    }
  }
})

/**
 * Minimal `SpawnedProcess` over a genuinely independent
 * `node:child_process.spawn` — no DSH subprocess service, no DSH run/process
 * plumbing. Used only to establish ground truth for the real CLI's own
 * command listing, entirely outside `listClaudeCodeCommands()`.
 */
function spawnDirectChild(
  options: SpawnOptions,
  capture: (child: ReturnType<typeof nodeSpawn>, exited: Promise<void>) => void,
): SpawnedProcess {
  const child = nodeSpawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const events = new EventEmitter()
  events.on('error', () => {})
  let exitCode: number | null = null
  let signalCode: NodeJS.Signals | null = null
  const exited = new Promise<void>((resolve) => {
    child.on('exit', (code, signal) => {
      exitCode = code
      signalCode = signal
      events.emit('exit', code, signal)
      resolve()
    })
  })
  capture(child, exited)
  child.on('error', (error: Error) => events.emit('error', error))
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() { return child.killed },
    get exitCode() { return exitCode },
    get signalCode() { return signalCode },
    kill: (signal: NodeJS.Signals) => child.kill(signal),
    on: (event, listener) => { events.on(event, listener as (...args: unknown[]) => void) },
    once: (event, listener) => { events.once(event, listener as (...args: unknown[]) => void) },
    off: (event, listener) => { events.off(event, listener as (...args: unknown[]) => void) },
  }
}

/**
 * Calls the real CLI's own `supportedCommands()` directly — bypasses
 * `listClaudeCodeCommands()` entirely. Explicitly kills and awaits the real
 * child's exit before returning (rather than just calling `query.close()`),
 * so the fixture directories this process opened are fully released before
 * the caller removes them.
 */
async function directSupportedCommands(cwd: string, env: Record<string, string>): Promise<SlashCommand[]> {
  const controller = new AbortController()
  let child: ReturnType<typeof nodeSpawn> | undefined
  let exited: Promise<void> = Promise.resolve()
  const options: Options = {
    abortController: controller,
    cwd,
    env,
    persistSession: false,
    permissionMode: DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    spawnClaudeCodeProcess: options_ => spawnDirectChild(options_, (capturedChild, capturedExited) => {
      child = capturedChild
      exited = capturedExited
    }),
  }
  const q = officialQuery({ prompt: '', options })
  try {
    return await q.supportedCommands()
  } finally {
    q.close()
    child?.kill()
    await exited
  }
}

interface Fixture {
  readonly spec: ClaudeCodeRunSpec
  readonly project: string
  readonly env: Record<string, string>
  readonly messages: MessagesFixture
}

/**
 * Builds a fully hermetic fixture home (its own `CLAUDE_CONFIG_DIR`, flat
 * `commands/`/`skills/` — confirmed against the real installed CLI to be the
 * layout `CLAUDE_CONFIG_DIR` actually reads, not a nested `.claude/`) and a
 * separate fixture project (its own `.git`, its own nested `.claude/skills`)
 * plus a real subprocess-backed `ClaudeCodeRunSpec` and a loopback Messages
 * fixture standing in for the real Anthropic API.
 */
async function buildFixture(messagesText: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-claude-command-listing-'))
  roots.push(root)
  const claudeConfig = join(root, 'claude-config')
  const xdgConfig = join(root, 'xdg')
  mkdirSync(claudeConfig)
  mkdirSync(xdgConfig)

  // Flat layout directly under CLAUDE_CONFIG_DIR — verified against the real
  // installed CLI binary: it does NOT look for a nested `.claude/` under the
  // directory CLAUDE_CONFIG_DIR points at; CLAUDE_CONFIG_DIR itself IS the
  // config home.
  mkdirSync(join(claudeConfig, 'commands', 'modes'), { recursive: true })
  writeFileSync(
    join(claudeConfig, 'commands', 'plain.md'),
    '---\ndescription: A flat fixture command\n---\nEcho the input back.',
  )
  writeFileSync(
    join(claudeConfig, 'commands', 'modes', 'sparc.md'),
    '---\ndescription: A nested fixture command, namespaced as modes:sparc\n---\nBody.',
  )
  mkdirSync(join(claudeConfig, 'skills', 'my-skill'), { recursive: true })
  writeFileSync(
    join(claudeConfig, 'skills', 'my-skill', 'SKILL.md'),
    '---\nname: my-skill\ndescription: A fixture user-level skill for hermetic e2e testing\n---\nBody.',
  )

  const project = join(root, 'project')
  mkdirSync(project)
  mkdirSync(join(project, '.git'))
  mkdirSync(join(project, '.claude', 'skills', 'project-only'), { recursive: true })
  writeFileSync(
    join(project, '.claude', 'skills', 'project-only', 'SKILL.md'),
    '---\nname: project-only\ndescription: A fixture project-level skill\n---\nBody.',
  )

  const messages = await startMessagesFixture({ kind: 'complete', text: messagesText })
  fixtures.push(messages)

  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: fakeKey,
    ANTHROPIC_BASE_URL: messages.baseUrl,
    CLAUDE_CONFIG_DIR: claudeConfig,
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'AppData', 'Local'),
    XDG_CONFIG_HOME: xdgConfig,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
  }

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)

  const spec: ClaudeCodeRunSpec = {
    cwd: project,
    permissionMode: DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    env,
    disposeGraceMs: 3_000,
    spawn: ctx.subprocess.spawn.bind(ctx.subprocess),
  }

  return { spec, project, env, messages }
}

describe('listClaudeCodeCommands() against a real Claude Code CLI process', { timeout: 60_000 }, () => {
  it('reports the exact same command set as calling the real CLI\'s own supportedCommands() directly', async () => {
    const { spec, project, env } = await buildFixture('unused')

    const [direct, wrapped] = await Promise.all([
      directSupportedCommands(project, env),
      listClaudeCodeCommands(spec),
    ])

    const directNames = new Set(direct.map(c => c.name))
    const wrappedNames = new Set(wrapped.map(c => c.name))
    expect(wrappedNames).toEqual(directNames)

    // Fixture-specific commands/skill must actually have been discovered —
    // not merely that both listings agree (they'd trivially agree if both
    // found nothing).
    for (const expectedName of ['plain', 'modes:sparc', 'my-skill', 'project-only']) {
      expect(directNames.has(expectedName), `direct listing should include "${expectedName}"`).toBe(true)
      expect(wrappedNames.has(expectedName), `wrapped listing should include "${expectedName}"`).toBe(true)
    }
  })

  it('runClaudeCodeSlashCommand() runs the flat fixture command as a real one-shot CLI round trip', async () => {
    const sentinel = 'DSH_REAL_CLI_ROUND_TRIP_SENTINEL'
    const { spec, messages } = await buildFixture(sentinel)

    const text = await runClaudeCodeSlashCommand(
      'plain',
      ' say the sentinel',
      spec,
      new AbortController().signal,
    )

    expect(text.trim()).toBe(sentinel)
    expect(messages.requests.length).toBeGreaterThan(0)
    expect(messages.requests[0]?.headers['x-api-key']).toBe(fakeKey)
  })
})
