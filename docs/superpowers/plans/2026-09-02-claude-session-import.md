# Claude Code Session Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user pick one of their Claude Code CLI sessions and land in a new, fully-native DSH session whose opening context reflects that conversation, running on `anthropic`/`claude-sonnet-5` from creation onward.

**Architecture:** A new package `packages/session/claude-session-import` provides a one-shot subprocess call (`claude agents --json --all`) for discovery and a one-shot JSONL parse for import — no live connection to Claude Code survives either call. A new RPC controller (`ClaudeSessionImportController`, modeled on `AuthorizationController`) exposes `list()` and `createFrom(id)`. `createFrom` reuses the existing session-creation primitive (`ApiSessionAgentController.ensureSession`) and the existing `selectModel` behavior, then seeds the new session's opening context via `agent.inject()`. A small client package adds an "Import from Claude Code" entry point to session creation.

**Tech Stack:** TypeScript, Cordis (`@deepseek-ai/cordis`), `@deepseek-ai/dsh-typert-protocol` (`TypertRemoteService`/`@Remote`/`RemoteError`), `@deepseek-ai/dsh-subprocess` (`ctx.subprocess.spawn`), `@deepseek-ai/dsh-llm` (`createUserMessage`), Vitest.

**Spec:** `.agents/notes/proposed/architecture/2026-09-02-claude-code-session-import.md`

## Global Constraints

- No live process, socket, or file-tail to Claude Code survives an import call — every contact with `claude` or the transcript file happens once, inside a single RPC call, per the spec's rejection of a live bridge.
- An unrecognized transcript block renders as a text summary; it never fails the whole import (spec: "Approach C").
- `claude` binary missing or a corrupt transcript fails loud with a specific `RemoteError`, never a silent partial result.
- New sessions from this feature default their model to `provider: 'anthropic', model: 'claude-sonnet-5'`.
- Every non-trivial change needs an Agent Note per this repo's `AGENTS.md`; this plan's own spec (already written) covers it — update it, don't duplicate, if the shipped shape drifts from the proposal.
- TDD is mandatory: write the failing test before the implementation in every task.

---

### Task 1: Transcript parser (`transcript.ts`)

**Files:**
- Create: `packages/session/claude-session-import/src/transcript.ts`
- Test: `packages/session/claude-session-import/tests/transcript.spec.ts`
- Create fixtures: `packages/session/claude-session-import/tests/fixtures/plain-turns.jsonl`, `packages/session/claude-session-import/tests/fixtures/tool-call.jsonl`, `packages/session/claude-session-import/tests/fixtures/malformed-block.jsonl`

**Interfaces:**
- Produces:
  ```ts
  export interface ImportedTurn {
    readonly role: 'user' | 'assistant'
    readonly text: string
  }
  export function parseClaudeCodeTranscript(jsonl: string): readonly ImportedTurn[]
  export function renderImportedTranscript(turns: readonly ImportedTurn[]): string
  ```
  `renderImportedTranscript` joins turns into one plain-text block (`"**User:** ...\n\n**Claude:** ..."`, blank line between turns) — this is the single string later tasks hand to `agent.inject()`.

- [ ] **Step 1: Write the failing test for plain text turns**

```ts
// packages/session/claude-session-import/tests/transcript.spec.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseClaudeCodeTranscript, renderImportedTranscript } from '../src/transcript.ts'

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
}

describe('parseClaudeCodeTranscript', () => {
  it('extracts plain user/assistant text turns in order', () => {
    const turns = parseClaudeCodeTranscript(fixture('plain-turns.jsonl'))
    expect(turns).toEqual([
      { role: 'user', text: 'What does this repo do?' },
      { role: 'assistant', text: 'It is a Cordis-based agent harness.' },
    ])
  })

  it('renders turns as one readable text block', () => {
    const rendered = renderImportedTranscript([
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello' },
    ])
    expect(rendered).toBe('**User:** Hi\n\n**Claude:** Hello')
  })
})
```

Create the fixture:
```jsonl
// packages/session/claude-session-import/tests/fixtures/plain-turns.jsonl
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"What does this repo do?"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"It is a Cordis-based agent harness."}]}}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/session/claude-session-import/tests/transcript.spec.ts`
Expected: FAIL — `../src/transcript.ts` does not exist.

- [ ] **Step 3: Write minimal implementation for plain text turns**

```ts
// packages/session/claude-session-import/src/transcript.ts
/**
 * One reconstructed turn from a Claude Code CLI transcript, text-only.
 * Tool calls and results are folded into readable text by
 * {@link parseClaudeCodeTranscript} rather than kept structured — see
 * .agents/notes/proposed/architecture/2026-09-02-claude-code-session-import.md.
 */
export interface ImportedTurn {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

interface RawTextBlock {
  type: 'text'
  text: string
}

interface RawToolUseBlock {
  type: 'tool_use'
  name: string
  input: unknown
}

interface RawToolResultBlock {
  type: 'tool_result'
  content: unknown
}

type RawBlock = RawTextBlock | RawToolUseBlock | RawToolResultBlock | { type: string }

interface RawEntry {
  type: string
  message?: { role: 'user' | 'assistant'; content: RawBlock[] | string }
}

/** Render one non-text content block as a readable summary line. */
function summarizeBlock(block: RawBlock): string | undefined {
  if (block.type === 'text') return (block as RawTextBlock).text
  if (block.type === 'tool_use') {
    const use = block as RawToolUseBlock
    return `(ran \`${use.name}\` with ${JSON.stringify(use.input)})`
  }
  if (block.type === 'tool_result') {
    const result = block as RawToolResultBlock
    const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
    return `(tool result: ${text})`
  }
  // Unrecognized block shape: degrade to a text summary instead of failing
  // the import, per the spec's Approach C.
  return `(unrecognized event: ${block.type})`
}

/** One entry's message content flattened to one text string, blocks joined by blank lines. */
function textOf(content: RawBlock[] | string): string {
  if (typeof content === 'string') return content
  return content.map(summarizeBlock).filter((line): line is string => line !== undefined).join('\n\n')
}

/**
 * Parse a Claude Code CLI session transcript into flattened text turns.
 * @param jsonl - the transcript file's raw contents, one JSON object per line.
 * @returns user/assistant turns in transcript order; malformed lines are skipped.
 */
export function parseClaudeCodeTranscript(jsonl: string): readonly ImportedTurn[] {
  const turns: ImportedTurn[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim().length === 0) continue
    let entry: RawEntry
    try {
      entry = JSON.parse(line) as RawEntry
    } catch {
      continue
    }
    if (entry.message === undefined) continue
    if (entry.message.role !== 'user' && entry.message.role !== 'assistant') continue
    const text = textOf(entry.message.content)
    if (text.trim().length === 0) continue
    turns.push({ role: entry.message.role, text })
  }
  return turns
}

/**
 * Render reconstructed turns as one plain-text block, suitable as the sole
 * content of a single injected {@link import('@deepseek-ai/dsh-llm').UserMessage}.
 * @param turns - turns in transcript order.
 * @returns the turns joined as `"**User:** ...\n\n**Claude:** ..."`.
 */
export function renderImportedTranscript(turns: readonly ImportedTurn[]): string {
  return turns
    .map(turn => `**${turn.role === 'user' ? 'User' : 'Claude'}:** ${turn.text}`)
    .join('\n\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/session/claude-session-import/tests/transcript.spec.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Write the failing test for tool-call summaries and malformed lines**

```ts
// append to packages/session/claude-session-import/tests/transcript.spec.ts
it('renders tool_use/tool_result blocks as readable summaries', () => {
  const turns = parseClaudeCodeTranscript(fixture('tool-call.jsonl'))
  expect(turns).toEqual([
    { role: 'assistant', text: '(ran `bash` with {"command":"ls -la"})\n\n(tool result: file1\\nfile2)' },
  ])
})

it('skips malformed lines instead of failing the whole parse', () => {
  const turns = parseClaudeCodeTranscript(fixture('malformed-block.jsonl'))
  expect(turns).toEqual([{ role: 'user', text: 'still readable' }])
})
```

Create the fixtures:
```jsonl
// packages/session/claude-session-import/tests/fixtures/tool-call.jsonl
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"bash","input":{"command":"ls -la"}},{"type":"tool_result","content":"file1\nfile2"}]}}
```
```jsonl
// packages/session/claude-session-import/tests/fixtures/malformed-block.jsonl
not even json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"still readable"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"some_future_block_shape","stuff":true}]}}
```

Note the third fixture line is deliberately included to prove an unrecognized block degrades to a summary rather than being dropped — but since the test above only asserts the user turn, add a fourth assertion inline instead of a separate fixture if you want to keep this task to two fixtures; the plan's minimal version above keeps `malformed-block.jsonl` focused on the truly-unparsable line.

- [ ] **Step 6: Run tests to verify they fail, then pass**

Run: `pnpm vitest run packages/session/claude-session-import/tests/transcript.spec.ts`
Expected: the two new tests FAIL first (fixtures don't exist yet — create them per Step 5), then PASS once the implementation from Step 3 already handles both cases (it does — no code change needed here, only fixtures and tests).

- [ ] **Step 7: Commit**

```powershell
git add packages/session/claude-session-import/src/transcript.ts packages/session/claude-session-import/tests/transcript.spec.ts packages/session/claude-session-import/tests/fixtures
git commit -m "feat(session/claude-session-import): parse Claude Code transcripts into flattened text turns"
```

---

### Task 2: `claude agents` discovery wrapper (`discovery.ts`)

**Files:**
- Create: `packages/session/claude-session-import/src/discovery.ts`
- Test: `packages/session/claude-session-import/tests/discovery.spec.ts`

**Interfaces:**
- Consumes: `ctx.subprocess.spawn(spec)` from `@deepseek-ai/dsh-subprocess` (`SubprocessSpawnSpec`, `SubprocessHandle`).
- Produces:
  ```ts
  export interface DiscoveredSession {
    readonly id: string
    readonly name: string
    readonly cwd: string
    readonly status: string
    readonly startedAt: string
  }
  export async function listClaudeCodeSessions(ctx: Context, signal: AbortSignal): Promise<readonly DiscoveredSession[]>
  ```
  Returns `[]` (never throws) when the `claude` binary is missing (spawn error) or its output is not valid JSON — per the spec's error-handling section, discovery degrades to an empty list rather than failing the RPC call.

- [ ] **Step 1: Write the failing test**

```ts
// packages/session/claude-session-import/tests/discovery.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { listClaudeCodeSessions } from '../src/discovery.ts'

function stubbedCtx(spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle): Context {
  const ctx = new Context()
  ctx.set('subprocess', { spawn } as unknown as Context['subprocess'])
  return ctx
}

function handleWithStdout(json: string, exitCode = 0): SubprocessHandle {
  const stdout = { readFrom: () => ({ text: json, nextOffset: json.length, lossy: false }) }
  return {
    pid: 123,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: () => {},
  } as unknown as SubprocessHandle
}

describe('listClaudeCodeSessions', () => {
  it('parses a well-formed session list', async () => {
    const raw = JSON.stringify({
      sessions: [{ id: 's1', name: 'my-task', cwd: 'D:/dev/DSH', status: 'working', startedAt: '2026-09-01T00:00:00Z' }],
    })
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([
      { id: 's1', name: 'my-task', cwd: 'D:/dev/DSH', status: 'working', startedAt: '2026-09-01T00:00:00Z' },
    ])
  })

  it('returns an empty list when the claude binary is missing', async () => {
    const ctx = stubbedCtx(() => { throw new Error('ENOENT: claude not found') })
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
  })

  it('returns an empty list when output is not valid JSON', async () => {
    const ctx = stubbedCtx(() => handleWithStdout('not json'))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
  })

  it('returns an empty list for an empty session array', async () => {
    const ctx = stubbedCtx(() => handleWithStdout(JSON.stringify({ sessions: [] })))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/session/claude-session-import/tests/discovery.spec.ts`
Expected: FAIL — `../src/discovery.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/session/claude-session-import/src/discovery.ts
import type { Context } from '@deepseek-ai/cordis'

/** One `claude agents --json --all` entry, as surfaced to the import picker. */
export interface DiscoveredSession {
  readonly id: string
  readonly name: string
  readonly cwd: string
  readonly status: string
  readonly startedAt: string
}

interface RawSessionList {
  sessions?: unknown
}

function isDiscoveredSession(value: unknown): value is DiscoveredSession {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<DiscoveredSession>
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.cwd === 'string'
    && typeof candidate.status === 'string'
    && typeof candidate.startedAt === 'string'
}

/**
 * List the operator's Claude Code CLI sessions via `claude agents --json --all`.
 * Never throws: a missing binary or unparsable output both degrade to an
 * empty list, per this feature's error-handling contract.
 * @param ctx - Host context carrying `ctx.subprocess`.
 * @param signal - withdraws the discovery call.
 * @returns discovered sessions, or an empty list on any failure.
 */
export async function listClaudeCodeSessions(
  ctx: Context,
  signal: AbortSignal,
): Promise<readonly DiscoveredSession[]> {
  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv: ['claude', 'agents', '--json', '--all'],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 5_000,
      signal,
    })
  } catch {
    return []
  }
  const outcome = await handle.done.catch(() => undefined)
  if (outcome === undefined || outcome.exitCode !== 0) return []
  const read = handle.collected.stdout?.readFrom(0)
  if (read === undefined) return []
  let parsed: RawSessionList
  try {
    parsed = JSON.parse(read.text) as RawSessionList
  } catch {
    return []
  }
  if (!Array.isArray(parsed.sessions)) return []
  return parsed.sessions.filter(isDiscoveredSession)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/session/claude-session-import/tests/discovery.spec.ts`
Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```powershell
git add packages/session/claude-session-import/src/discovery.ts packages/session/claude-session-import/tests/discovery.spec.ts
git commit -m "feat(session/claude-session-import): discover Claude Code CLI sessions via claude agents --json"
```

---

### Task 3: Map a discovered session to its transcript path (`transcript-path.ts`)

**Files:**
- Create: `packages/session/claude-session-import/src/transcript-path.ts`
- Test: `packages/session/claude-session-import/tests/transcript-path.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export function claudeCodeTranscriptPath(homedir: string, cwd: string, sessionId: string): string
  ```
  Claude Code's project directory name is the session's `cwd` with every `/` (and, on Windows, `\` and the drive-letter `:`) replaced by `-` — mirror this exactly since the transcript path is otherwise unaddressable; cover both a POSIX-style and a Windows-style `cwd` in the test.

- [ ] **Step 1: Write the failing test**

```ts
// packages/session/claude-session-import/tests/transcript-path.spec.ts
import { describe, expect, it } from 'vitest'
import { claudeCodeTranscriptPath } from '../src/transcript-path.ts'

describe('claudeCodeTranscriptPath', () => {
  it('builds the path for a POSIX cwd', () => {
    expect(claudeCodeTranscriptPath('/home/arnold', '/home/arnold/dev/DSH', 'abc123'))
      .toBe('/home/arnold/.claude/projects/-home-arnold-dev-DSH/abc123.jsonl')
  })

  it('builds the path for a Windows cwd', () => {
    expect(claudeCodeTranscriptPath('C:\\Users\\awang', 'D:\\dev\\DSH', 'abc123'))
      .toBe('C:\\Users\\awang\\.claude\\projects\\D--dev-DSH\\abc123.jsonl')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/session/claude-session-import/tests/transcript-path.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/session/claude-session-import/src/transcript-path.ts
import { join, sep } from 'node:path'

/**
 * Path to a Claude Code CLI session's transcript on disk. Claude Code slugs
 * a project's own working directory by replacing every path separator (and,
 * on Windows, the drive-letter colon) with `-`; this mirrors that slug so the
 * transcript is addressable without asking Claude Code for it directly.
 * @param homedir - the operator's home directory (`os.homedir()`).
 * @param cwd - the session's working directory, as reported by `claude agents --json`.
 * @param sessionId - the session id.
 * @returns absolute path to `<home>/.claude/projects/<slug>/<sessionId>.jsonl`.
 */
export function claudeCodeTranscriptPath(homedir: string, cwd: string, sessionId: string): string {
  const slug = cwd.replace(/:/g, '-').split(/[/\\]/).filter(part => part.length > 0).join('-')
  return join(homedir, '.claude', 'projects', sep === '\\' ? slug : `-${slug}`, `${sessionId}.jsonl`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/session/claude-session-import/tests/transcript-path.spec.ts`
Expected: PASS. If the Windows/POSIX leading-dash asymmetry above doesn't match real Claude Code output on your platform, fix the implementation (not the test) to match observed behavior — capture the discrepancy as a one-line comment citing what you observed, since this mapping is otherwise unverifiable from documentation alone.

- [ ] **Step 5: Commit**

```powershell
git add packages/session/claude-session-import/src/transcript-path.ts packages/session/claude-session-import/tests/transcript-path.spec.ts
git commit -m "feat(session/claude-session-import): map a discovered session to its transcript path"
```

---

### Task 4: `ClaudeSessionImportController` RPC surface

**Files:**
- Create: `packages/session/claude-session-import/src/index.ts`
- Create: `packages/session/claude-session-import/src/types.ts`
- Test: `packages/session/claude-session-import/tests/controller.host.spec.ts`
- Modify: `packages/api/session-controller/src/index.ts` — mount `ClaudeSessionImportController` beside the existing session controller (same pattern `SettingsController` uses for `AuthorizationController`: `ctx.plugin(ClaudeSessionImportController)` in its constructor).

**Interfaces:**
- Consumes:
  - `listClaudeCodeSessions(ctx, signal)` from Task 2.
  - `parseClaudeCodeTranscript`/`renderImportedTranscript` from Task 1.
  - `claudeCodeTranscriptPath(homedir, cwd, sessionId)` from Task 3.
  - `ApiSessionAgentController.ensureSession(sessionId, cwd, adopt, agentPreset)` from `packages/api/session-controller/src/agent.ts` (already exists; returns `Promise<Agent>`).
  - `agent.inject(message: UserMessage)` from `@deepseek-ai/dsh-agent`.
  - `createUserMessage({ content, source })` from `@deepseek-ai/dsh-llm`.
- Produces:
  ```ts
  export interface ClaudeSessionImportListValue { readonly sessions: readonly DiscoveredSessionView[] }
  export interface DiscoveredSessionView {
    readonly id: string; readonly name: string; readonly cwd: string
    readonly status: string; readonly startedAt: string
  }
  export interface ClaudeSessionImportCreateValue { readonly sessionId: string }
  export class ClaudeSessionImportController extends TypertRemoteService {
    list(signal: AbortSignal): Promise<ClaudeSessionImportListValue>
    createFrom(sessionId: string, signal: AbortSignal): Promise<ClaudeSessionImportCreateValue>
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/session/claude-session-import/tests/controller.host.spec.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { ClaudeSessionImportController } from '../src/index.ts'

// Does not exist yet: RED-phase anchor for this suite. See
// .agents/notes/proposed/architecture/2026-09-02-claude-code-session-import.md

const DISCOVERED = { id: 's1', name: 'my-task', cwd: '/home/arnold/proj', status: 'done', startedAt: '2026-09-01T00:00:00Z' }

function bootController(overrides: {
  discover?: () => Promise<readonly typeof DISCOVERED[]>
  readTranscript?: () => string
  ensureSession?: () => Promise<{ session: { header: { cwd: string } }; inject: (message: unknown) => void }>
} = {}): ClaudeSessionImportController {
  const ctx = new Context()
  return new ClaudeSessionImportController(ctx, {
    discover: overrides.discover ?? (async () => [DISCOVERED]),
    readTranscript: overrides.readTranscript ?? (() => JSON.stringify({
      type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    })),
    ensureSession: overrides.ensureSession ?? (async () => {
      const agent = { session: { header: { cwd: '/tmp' } }, inject: vi.fn() }
      return agent as unknown as Awaited<ReturnType<NonNullable<typeof overrides.ensureSession>>>
    }),
  })
}

describe('the claudeSessionImport Remote namespace', () => {
  it('publishes list and createFrom from its own service key', () => {
    const controller = bootController()
    expect(remoteMethods(controller)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'createFrom', invocation: { kind: 'direct' } },
    ])
  })

  it('lists discovered sessions', async () => {
    const controller = bootController()
    const result = await controller.list(new AbortController().signal)
    expect(result).toEqual({ sessions: [DISCOVERED] })
  })

  it('returns an empty list when discovery finds nothing', async () => {
    const controller = bootController({ discover: async () => [] })
    const result = await controller.list(new AbortController().signal)
    expect(result).toEqual({ sessions: [] })
  })

  it('creates a session and injects the parsed transcript as one message', async () => {
    const inject = vi.fn()
    const controller = bootController({
      ensureSession: async () => ({ session: { header: { cwd: '/tmp' } }, inject } as never),
    })
    const result = await controller.createFrom('s1', new AbortController().signal)
    expect(result.sessionId).toEqual(expect.any(String))
    expect(inject).toHaveBeenCalledTimes(1)
    const [message] = inject.mock.calls[0] as [{ content: { type: string; text: string }[] }]
    expect(message.content[0]?.text).toContain('**User:** hi')
  })

  it('rejects createFrom for an unknown session id', async () => {
    const controller = bootController({ discover: async () => [] })
    const failure = await controller.createFrom('missing', new AbortController().signal).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'claude-session-import/not-found' })
  })

  it('rejects createFrom when the transcript cannot be read', async () => {
    const controller = bootController({
      readTranscript: () => { throw new Error('ENOENT') },
    })
    const failure = await controller.createFrom('s1', new AbortController().signal).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'claude-session-import/transcript-unreadable' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/session/claude-session-import/tests/controller.host.spec.ts`
Expected: FAIL — `../src/index.ts` does not exist.

- [ ] **Step 3: Write `types.ts`**

```ts
// packages/session/claude-session-import/src/types.ts
/** Wire view of one `claude agents --json --all` entry. */
export interface DiscoveredSessionView {
  readonly id: string
  readonly name: string
  readonly cwd: string
  readonly status: string
  readonly startedAt: string
}

/** Result of `list()`. */
export interface ClaudeSessionImportListValue {
  readonly sessions: readonly DiscoveredSessionView[]
}

/** Result of `createFrom()`. */
export interface ClaudeSessionImportCreateValue {
  readonly sessionId: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** `createFrom()` named a session id `list()` does not currently report. */
    'claude-session-import/not-found': { readonly sessionId: string }
    /** The transcript file could not be read or parsed. */
    'claude-session-import/transcript-unreadable': { readonly sessionId: string }
  }
}
```

- [ ] **Step 4: Write minimal implementation**

```ts
// packages/session/claude-session-import/src/index.ts
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { listClaudeCodeSessions } from './discovery.ts'
import { parseClaudeCodeTranscript, renderImportedTranscript } from './transcript.ts'
import { claudeCodeTranscriptPath } from './transcript-path.ts'
import type { ClaudeSessionImportCreateValue, ClaudeSessionImportListValue } from './types.ts'

export type * from './types.ts'

/** Host integrations replaceable by direct unit tests. */
export interface ClaudeSessionImportInternals {
  discover?: (ctx: Context, signal: AbortSignal) => Promise<readonly Awaited<ReturnType<typeof listClaudeCodeSessions>>[number][]>
  readTranscript?: (path: string) => string
  ensureSession?: (ctx: Context, sessionId: SessionId, cwd: string) => Promise<Agent>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `claudeSessionImport` Remote namespace. */
    claudeSessionImportController: ClaudeSessionImportController
  }
}

/**
 * Host service backing `ctx.remote.claudeSessionImport`: discovers Claude
 * Code CLI sessions and imports one, once, into a brand-new native DSH
 * session. No connection to Claude Code survives either call — see
 * .agents/notes/proposed/architecture/2026-09-02-claude-code-session-import.md.
 */
export class ClaudeSessionImportController extends TypertRemoteService {
  private readonly discover: NonNullable<ClaudeSessionImportInternals['discover']>
  private readonly readTranscript: NonNullable<ClaudeSessionImportInternals['readTranscript']>
  private readonly ensureSession: NonNullable<ClaudeSessionImportInternals['ensureSession']>

  constructor(ctx: Context, internals: ClaudeSessionImportInternals = {}) {
    super(ctx, 'claudeSessionImportController', { namespace: 'claudeSessionImport' })
    this.discover = internals.discover ?? ((hostCtx, signal) => listClaudeCodeSessions(hostCtx, signal))
    this.readTranscript = internals.readTranscript ?? (path => readFileSync(path, 'utf8'))
    this.ensureSession = internals.ensureSession
      ?? (async (hostCtx, sessionId, cwd) => hostCtx.agents.ensureSession(sessionId, cwd, false))
  }

  /**
   * List the operator's Claude Code CLI sessions.
   * @param signal - withdraws the discovery call.
   * @returns discovered sessions; empty when `claude` is unavailable.
   */
  @Remote
  async list(signal: AbortSignal): Promise<ClaudeSessionImportListValue> {
    const sessions = await this.discover(this.ctx, signal)
    return { sessions: sessions.map(session => ({ ...session })) }
  }

  /**
   * Import one Claude Code CLI session into a brand-new native DSH session.
   * @param sessionId - the id `list()` reported.
   * @param signal - withdraws discovery; the transcript read and session
   *   creation that follow are not cancellable once discovery settles.
   * @returns the new DSH session's id.
   * @throws RemoteError `claude-session-import/not-found` when `sessionId`
   *   is not currently reported by `list()`, or
   *   `claude-session-import/transcript-unreadable` when the transcript
   *   cannot be read or parsed.
   */
  @Remote
  async createFrom(sessionId: string, signal: AbortSignal): Promise<ClaudeSessionImportCreateValue> {
    const sessions = await this.discover(this.ctx, signal)
    const discovered = sessions.find(session => session.id === sessionId)
    if (discovered === undefined) {
      throw new RemoteError('claude-session-import/not-found', `no Claude Code session "${sessionId}" is currently reported`, { sessionId })
    }
    const path = claudeCodeTranscriptPath(homedir(), discovered.cwd, sessionId)
    let turns
    try {
      turns = parseClaudeCodeTranscript(this.readTranscript(path))
    } catch (error) {
      throw new RemoteError(
        'claude-session-import/transcript-unreadable',
        `could not read the transcript for "${sessionId}" at ${path}: ${error instanceof Error ? error.message : String(error)}`,
        { sessionId },
        { cause: error },
      )
    }
    const newSessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const agent = await this.ensureSession(this.ctx, newSessionId, discovered.cwd)
    const rendered = renderImportedTranscript(turns)
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: `Imported from Claude Code session "${discovered.name}":\n\n${rendered}` }],
      source: { kind: 'plugin', plugin: 'claude-session-import', form: 'notice', summary: 'Imported a prior Claude Code conversation' },
    }))
    return { sessionId: newSessionId }
  }
}

export default ClaudeSessionImportController
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/session/claude-session-import/tests/controller.host.spec.ts`
Expected: PASS (all six tests). If `createUserMessage`'s `source` union rejects the `kind: 'plugin'` shape used above, check `@deepseek-ai/dsh-llm`'s `MessageSourceMap` for the exact accepted fields (the plan-mode precedent at `packages/plan/plan-mode/src/index.ts:456` uses this same shape) and adjust to match — do not weaken the type to `any`.

- [ ] **Step 6: Set the imported session's model to anthropic/claude-sonnet-5**

Add a step to `createFrom` after `ensureSession` resolves: call the same model-selection path `SessionCommandController.selectModel` uses (`this.ctx.llm.resolveCallConfig({ provider: 'anthropic', model: 'claude-sonnet-5' })` then install it as the Session-local selection — read `packages/api/session-controller/src/commands.ts`'s `selectModel` method, lines ~118-140, for the exact installation call, and mirror it here rather than duplicating divergent logic). Add a test asserting the created session's selection is `{ provider: 'anthropic', model: 'claude-sonnet-5' }` using the same `bootController` stub shape, extended with a `resolveCallConfig`/model-install stub.

- [ ] **Step 7: Mount the controller**

Modify `packages/api/session-controller/src/index.ts`: in whichever class currently owns Remote session methods (the file `commands.ts` implements business logic for), add `ctx.plugin(ClaudeSessionImportController)` beside its own construction, following exactly how `packages/api/settings-controller/src/index.ts:113-114` mounts `CredentialsController`/`AuthorizationController`. Add `packages/session/claude-session-import` as a `workspace:^` dependency of `packages/api/session-controller/package.json`.

- [ ] **Step 8: Run the full package test suite**

Run: `pnpm vitest run packages/session/claude-session-import packages/api/session-controller`
Expected: PASS, no regressions in `session-controller`'s existing tests.

- [ ] **Step 9: Commit**

```powershell
git add packages/session/claude-session-import packages/api/session-controller
git commit -m "feat(session/claude-session-import): add the discovery+import RPC surface"
```

---

### Task 5: Package scaffolding and gates

**Files:**
- Create: `packages/session/claude-session-import/package.json`, `tsconfig.json` (or the host/client split this repo's other server-only packages use — copy `packages/credentials/authorization/package.json`'s shape, since that package is server-only like this one, and adjust name/dependencies).
- Modify: `packages/bundle/base/package.json` — add `@deepseek-ai/dsh-session-claude-import` (or whatever the package's published name resolves to per this repo's naming convention `@deepseek-ai/dsh-<name>`) as a dependency, since `ClaudeSessionImportController` needs to be reachable from `dsh web`'s default composition. It does **not** need its own `cordis.patch.yml` row: it is mounted transitively by `packages/api/session-controller`, not composed standalone.

**Interfaces:** none new — this task is packaging only.

- [ ] **Step 1: Copy the package skeleton**

Copy `packages/credentials/authorization/package.json` to `packages/session/claude-session-import/package.json`, rename `name` to `@deepseek-ai/dsh-session-claude-import`, update `description`, and set `peerDependencies`/`devDependencies` to `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-brand`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-subprocess`, `@deepseek-ai/dsh-typert-protocol`, `@deepseek-ai/cordis` (matching whatever this package's `src/index.ts` actually imports from Tasks 1-4).

- [ ] **Step 2: Run the workspace install**

Run: `pnpm install`
Expected: the new package links into the workspace with no errors.

- [ ] **Step 3: Run the package build and typecheck**

Run: `pnpm exec tsc -b tsconfig.host.json`
Expected: clean, zero errors, for this package and `session-controller`.

- [ ] **Step 4: Run lint scoped to the new and modified packages**

Run: `pnpm exec tsx scripts/run-oxlint.ts packages/session/claude-session-import packages/api/session-controller`
Expected: zero errors, zero warnings.

- [ ] **Step 5: Add the bundle dependency**

Modify `packages/bundle/base/package.json` per the Files section above. Run `pnpm install` again.

- [ ] **Step 6: Verify the full test suite for touched packages one more time**

Run: `pnpm vitest run packages/session/claude-session-import packages/api/session-controller packages/bundle/base`
Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/session/claude-session-import/package.json pnpm-lock.yaml packages/bundle/base/package.json
git commit -m "chore(session/claude-session-import): package scaffolding and bundle wiring"
```

---

### Task 6: Client "Import from Claude Code" entry point

**Files:**
- Create: `packages/client/ui-session-import/src/client/ImportDialog.tsx` (new small client package — copy the shape of `packages/client/ui-settings-models/src/client/AuthorizationDialog.tsx` as a starting structural template: a `Modal` listing options and driving one Remote call).
- Test: `packages/client/ui-session-import/tests/import-dialog.client.spec.tsx`
- Modify: wherever the "New chat" / session-creation entry point currently lives client-side (locate it first — search the client packages for the existing session-creation button/command before writing this task's own file paths precisely; do not guess a path that hasn't been confirmed to exist).

**Interfaces:**
- Consumes: `ctx.remote.claudeSessionImport.list(signal)` / `.createFrom(sessionId, signal)` (generated Remote client bindings from Task 4's `@Remote` methods).
- Produces: a dialog component invoked from the session-creation entry point; on a successful `createFrom`, navigates to the returned `sessionId` the same way opening any other existing session already navigates (reuse that existing navigation call — do not invent a second one).

- [ ] **Step 1: Locate the existing session-creation entry point**

Before writing any code, grep the client packages for the current "new session"/"new chat" UI (e.g. `Grep -r "session.create\|sessions.create" packages/client`) and read that component in full. Record its exact file path and props here in the plan before continuing — this task cannot be completed with a placeholder path.

- [ ] **Step 2: Write the failing component test**

```tsx
// packages/client/ui-session-import/tests/import-dialog.client.spec.tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ImportDialog } from '../src/client/ImportDialog.tsx'

describe('ImportDialog', () => {
  it('lists discovered sessions and imports the selected one', async () => {
    const onImported = vi.fn()
    const operations = {
      list: vi.fn().mockResolvedValue({
        sessions: [{ id: 's1', name: 'my-task', cwd: '/tmp', status: 'done', startedAt: '2026-09-01T00:00:00Z' }],
      }),
      createFrom: vi.fn().mockResolvedValue({ sessionId: 'session-abc' }),
    }
    render(<ImportDialog operations={operations} onImported={onImported} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('my-task')).toBeInTheDocument())
    fireEvent.click(screen.getByText('my-task'))
    fireEvent.click(screen.getByRole('button', { name: /import/i }))
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('session-abc'))
  })

  it('shows an empty-state message when no sessions are discovered', async () => {
    const operations = { list: vi.fn().mockResolvedValue({ sessions: [] }), createFrom: vi.fn() }
    render(<ImportDialog operations={operations} onImported={() => {}} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/no Claude Code sessions found/i)).toBeInTheDocument())
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run packages/client/ui-session-import/tests/import-dialog.client.spec.tsx`
Expected: FAIL — `ImportDialog` does not exist.

- [ ] **Step 4: Write minimal implementation**

Model `ImportDialog.tsx` directly on `AuthorizationDialog.tsx`'s structure: a `Modal` with an effect that calls `operations.list(signal)` on mount, renders each session as a clickable row (`name`, `cwd`, `status`), a footer "Import" button that calls `operations.createFrom(selectedId, signal)` and calls `onImported(sessionId)` on success, and an empty-state message when `sessions.length === 0`. Follow this package's existing `unmountedRef` guard pattern from `AuthorizationDialog.tsx` for the async `list`/`createFrom` calls.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/client/ui-session-import/tests/import-dialog.client.spec.tsx`
Expected: PASS.

- [ ] **Step 6: Wire the entry point**

Using the exact file/props recorded in Step 1, add an "Import from Claude Code" action that opens `ImportDialog` and, on `onImported(sessionId)`, calls that same file's existing session-navigation function with the new id.

- [ ] **Step 7: Run the full client test suite for touched packages**

Run: `pnpm vitest run packages/client/ui-session-import` plus whichever package Step 6 modified.
Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```powershell
git add packages/client/ui-session-import
git commit -m "feat(client/ui-session-import): add the Import from Claude Code entry point"
```

---

## Global Verification (run once, after all tasks)

```powershell
pnpm exec tsc -b tsconfig.host.json
pnpm exec tsc -b tsconfig.client.json
pnpm exec tsx scripts/run-oxlint.ts packages/session/claude-session-import packages/api/session-controller packages/client/ui-session-import packages/bundle/base
pnpm vitest run packages/session/claude-session-import packages/api/session-controller packages/client/ui-session-import
pnpm run verify-cordis-api
pnpm run verify-cordis-catalog
```

Then run all five SPARC Phase 4 reviews (`modes:ai-pitfall-review`, `code-review`, `modes:security-review` + independent advisor, `modes:regressions-analyzer`, `modes:memory-and-performance-analyzer`) per this repo's own SPARC workflow before merging, and update `.agents/notes/proposed/architecture/2026-09-02-claude-code-session-import.md`'s `Status:` line from `proposed` to `implemented` (rewriting `## Proposal` to `## Decision` per this repo's Agent Note lifecycle rules) once shipped.
