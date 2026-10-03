# Claude Code Skill-Derived Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a DSH session's active model is `anthropic`, surface that session's Claude Code Skills (from its `cwd` and the user's home skills directory) as DSH slash commands; when the session's model is anything else, those commands are not registered at all. A skill added, edited, or removed on disk after the agent was created is picked up on demand via `/refresh-skills`, not just at agent creation — there is no live Claude Code process or API to ask for a skill list (confirmed: the `claude` CLI has no skill-listing subcommand, unlike `claude agents --json --all`), so re-scanning the same on-disk directories is the only source of truth, and re-scanning on every step was rejected as an unnecessary per-turn filesystem cost for something that changes rarely.

**Architecture:** A new package `packages/interaction/claude-skill-commands` scans `<cwd>/.claude/skills/*/SKILL.md` and `~/.claude/skills/*/SKILL.md` for frontmatter, and mounts per-agent (via `ctx.on('agent/created', ...)` → `agent.ctx.plugin(...)`, the same shape `dsh-tool-subagent`'s scoped-mount fixture uses). Registration is dynamic, not decided once at mount: an `agent/pre-step` listener (the same hook `dsh-plan-mode` uses to react to session state every step) checks the agent's current model provider and registers or disposes the skill commands to match. Each command's handler reads its skill's body and calls `agent.steer()` with it plus any typed arguments — the same mechanism `dsh-plan-mode`'s `/plan [message]` already uses to submit content into a turn. Alongside the discovered skill commands, a `/refresh-skills` command (registered under the same provider gate) re-runs the scan on demand, diffs it against the currently-registered set by name, registers newly-found skills, disposes ones no longer found, and reports a one-line summary of what changed.

**Tech Stack:** TypeScript, Cordis (`@deepseek-ai/cordis`), `@deepseek-ai/dsh-commands` (`ctx.commands.register()`), `@deepseek-ai/dsh-llm` (`createUserMessage`), `js-yaml` (frontmatter), Vitest.

**Spec:** `.agents/notes/proposed/architecture/2026-09-02-claude-code-session-import.md`

## Global Constraints

- Skill commands are registered only while the agent's current model provider is `anthropic`; they must be un-registered (not merely refuse when invoked) the moment the provider changes away from it, and re-registered if it changes back — re-evaluated on every step, never decided once at mount.
- A malformed or frontmatter-less `SKILL.md` is skipped with a logged warning; it never fails the rest of the scan.
- Project-level skills (`<cwd>/.claude/skills/`) shadow user-level ones (`~/.claude/skills/`) of the same name.
- No new command infrastructure: registration goes through the existing `ctx.commands.register()` from `@deepseek-ai/dsh-commands`.
- `/refresh-skills` only re-scans the filesystem; it never calls out to a live Claude Code process or any external API to enumerate skills — none exists. It is registered/disposed under the exact same provider gate as the discovered skill commands themselves (present only while `shouldBeRegistered` is true), so invoking it while the agent isn't on `anthropic` isn't possible in the first place.
- TDD is mandatory: write the failing test before the implementation in every task.

---

### Task 1: Skill scanner (`skill-scanner.ts`)

**Files:**
- Create: `packages/interaction/claude-skill-commands/src/skill-scanner.ts`
- Test: `packages/interaction/claude-skill-commands/tests/skill-scanner.spec.ts`
- Create fixtures under `packages/interaction/claude-skill-commands/tests/fixtures/`:
  - `project-skills/valid-skill/SKILL.md`
  - `project-skills/no-frontmatter/SKILL.md`
  - `project-skills/shared-name/SKILL.md`
  - `user-skills/shared-name/SKILL.md`
  - `user-skills/user-only/SKILL.md`

**Interfaces:**
- Produces:
  ```ts
  export interface ScannedSkill {
    readonly name: string
    readonly description: string
    readonly body: string
  }
  export function scanSkillDirectories(cwd: string, homedir: string): readonly ScannedSkill[]
  ```
  Project-level entries shadow user-level entries of the same `name`; returned list is deduplicated by name, project-first.

- [ ] **Step 1: Write the failing test**

```ts
// packages/interaction/claude-skill-commands/tests/skill-scanner.spec.ts
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { scanSkillDirectories } from '../src/skill-scanner.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const PROJECT_CWD = `${FIXTURES}project-root`
const HOME = `${FIXTURES}home`

describe('scanSkillDirectories', () => {
  it('reads name/description from valid frontmatter', () => {
    const skills = scanSkillDirectories(PROJECT_CWD, HOME)
    const valid = skills.find(skill => skill.name === 'valid-skill')
    expect(valid).toMatchObject({ name: 'valid-skill', description: 'A valid test skill' })
    expect(valid?.body).toContain('# Valid Skill')
  })

  it('skips a SKILL.md with no frontmatter', () => {
    const skills = scanSkillDirectories(PROJECT_CWD, HOME)
    expect(skills.some(skill => skill.body.includes('no-frontmatter-marker'))).toBe(false)
  })

  it('lets a project-level skill shadow a user-level skill of the same name', () => {
    const skills = scanSkillDirectories(PROJECT_CWD, HOME)
    const shared = skills.filter(skill => skill.name === 'shared-name')
    expect(shared).toHaveLength(1)
    expect(shared[0]?.description).toBe('project version')
  })

  it('includes a user-only skill', () => {
    const skills = scanSkillDirectories(PROJECT_CWD, HOME)
    expect(skills.some(skill => skill.name === 'user-only')).toBe(true)
  })

  it('returns an empty list when neither directory exists', () => {
    expect(scanSkillDirectories(`${FIXTURES}nowhere`, `${FIXTURES}nowhere-either`)).toEqual([])
  })
})
```

Fixture layout — note the test's `PROJECT_CWD` is `.../project-root`, so its skills live at `.../project-root/.claude/skills/...`:

```markdown
<!-- packages/interaction/claude-skill-commands/tests/fixtures/project-root/.claude/skills/valid-skill/SKILL.md -->
---
name: valid-skill
description: A valid test skill
---

# Valid Skill

Do the valid thing.
```

```markdown
<!-- packages/interaction/claude-skill-commands/tests/fixtures/project-root/.claude/skills/no-frontmatter/SKILL.md -->
# No Frontmatter

no-frontmatter-marker
```

```markdown
<!-- packages/interaction/claude-skill-commands/tests/fixtures/project-root/.claude/skills/shared-name/SKILL.md -->
---
name: shared-name
description: project version
---

Project body.
```

```markdown
<!-- packages/interaction/claude-skill-commands/tests/fixtures/home/.claude/skills/shared-name/SKILL.md -->
---
name: shared-name
description: user version
---

User body.
```

```markdown
<!-- packages/interaction/claude-skill-commands/tests/fixtures/home/.claude/skills/user-only/SKILL.md -->
---
name: user-only
description: only in the user's home
---

User-only body.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/interaction/claude-skill-commands/tests/skill-scanner.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/interaction/claude-skill-commands/src/skill-scanner.ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'

/** One skill discovered on disk, ready to become a slash command. */
export interface ScannedSkill {
  readonly name: string
  readonly description: string
  readonly body: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

/** Parse one `SKILL.md` file's frontmatter and body, or `undefined` when malformed. */
function parseSkillFile(path: string): ScannedSkill | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const match = FRONTMATTER.exec(raw)
  if (match === null) return undefined
  const [, frontmatterYaml, body] = match
  let frontmatter: unknown
  try {
    frontmatter = load(frontmatterYaml ?? '')
  } catch {
    return undefined
  }
  if (typeof frontmatter !== 'object' || frontmatter === null) return undefined
  const { name, description } = frontmatter as { name?: unknown; description?: unknown }
  if (typeof name !== 'string' || name.trim().length === 0) return undefined
  if (typeof description !== 'string' || description.trim().length === 0) return undefined
  return { name, description, body: (body ?? '').trim() }
}

/** One directory's skills, keyed by skill folder name (the SKILL.md's own directory). */
function skillsIn(skillsDir: string): readonly ScannedSkill[] {
  let entries: string[]
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
  const skills: ScannedSkill[] = []
  for (const entry of entries) {
    const parsed = parseSkillFile(join(skillsDir, entry, 'SKILL.md'))
    if (parsed !== undefined) skills.push(parsed)
  }
  return skills
}

/**
 * Scan project and user Claude Code skill directories, project-first.
 * @param cwd - the session's working directory.
 * @param homedir - the operator's home directory.
 * @returns skills deduplicated by name; a project-level skill shadows a
 *   user-level skill of the same name.
 */
export function scanSkillDirectories(cwd: string, homedir: string): readonly ScannedSkill[] {
  const project = skillsIn(join(cwd, '.claude', 'skills'))
  const user = skillsIn(join(homedir, '.claude', 'skills'))
  const seen = new Set(project.map(skill => skill.name))
  return [...project, ...user.filter(skill => !seen.has(skill.name))]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/interaction/claude-skill-commands/tests/skill-scanner.spec.ts`
Expected: PASS (all five tests).

- [ ] **Step 5: Commit**

```powershell
git add packages/interaction/claude-skill-commands/src/skill-scanner.ts packages/interaction/claude-skill-commands/tests/skill-scanner.spec.ts packages/interaction/claude-skill-commands/tests/fixtures
git commit -m "feat(interaction/claude-skill-commands): scan Claude Code skill directories"
```

---

### Task 2: Model gate (`model-gate.ts`)

**Files:**
- Create: `packages/interaction/claude-skill-commands/src/model-gate.ts`
- Test: `packages/interaction/claude-skill-commands/tests/model-gate.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export function currentProviderOf(agent: Agent, defaultModel: { currentSelection(): { provider: string } }): string
  ```
  Mirrors `packages/api/session-controller/src/agent.ts`'s `selectionFor().current` getter: if the session has a logged request header, its `provider` wins; otherwise fall back to `defaultModel.currentSelection().provider`. This does **not** read a session-local "picked" override (that lives in `session-controller`'s own private `selections` map, not reachable from here) — for the gate's purpose, the logged header (what the model actually last ran on) is the correct signal, and a session with neither a header nor a picked override is, by definition, still on the default.

- [ ] **Step 1: Write the failing test**

```ts
// packages/interaction/claude-skill-commands/tests/model-gate.spec.ts
import { describe, expect, it } from 'vitest'
import { currentProviderOf } from '../src/model-gate.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

function agentWithHeader(provider: string | undefined): Agent {
  return {
    session: {
      requestHeader: () => provider === undefined ? undefined : { config: { provider, model: 'x' } },
    },
  } as unknown as Agent
}

describe('currentProviderOf', () => {
  it('reads the provider from the last logged request header', () => {
    const provider = currentProviderOf(agentWithHeader('anthropic'), { currentSelection: () => ({ provider: 'deepseek-official' }) })
    expect(provider).toBe('anthropic')
  })

  it('falls back to the default model when no header is logged yet', () => {
    const provider = currentProviderOf(agentWithHeader(undefined), { currentSelection: () => ({ provider: 'anthropic' }) })
    expect(provider).toBe('anthropic')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/interaction/claude-skill-commands/tests/model-gate.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/interaction/claude-skill-commands/src/model-gate.ts
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Minimal shape this module needs from `ctx.agentDefaultModel`. */
export interface DefaultModelSource {
  currentSelection(): { provider: string }
}

/**
 * The provider this agent is currently running on, for gating decisions that
 * must not silently apply Claude-authored behavior to a non-Claude session.
 * @param agent - the agent to read.
 * @param defaultModel - `ctx.agentDefaultModel`, read only when no turn has run yet.
 * @returns the last logged request header's provider, or the deployment
 *   default when this session has never logged one.
 */
export function currentProviderOf(agent: Agent, defaultModel: DefaultModelSource): string {
  const logged = agent.session.requestHeader()
  return logged?.config.provider ?? defaultModel.currentSelection().provider
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/interaction/claude-skill-commands/tests/model-gate.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/interaction/claude-skill-commands/src/model-gate.ts packages/interaction/claude-skill-commands/tests/model-gate.spec.ts
git commit -m "feat(interaction/claude-skill-commands): read an agent's current model provider"
```

---

### Task 3: Per-agent dynamic command registration (`index.ts`)

**Files:**
- Create: `packages/interaction/claude-skill-commands/src/index.ts`
- Test: `packages/interaction/claude-skill-commands/tests/plugin.spec.ts`

**Interfaces:**
- Consumes: `scanSkillDirectories(cwd, homedir)` (Task 1), `currentProviderOf(agent, defaultModel)` (Task 2), `ctx.commands.register(definition)` from `@deepseek-ai/dsh-commands`, `agent.steer(message)` + `createUserMessage` from `@deepseek-ai/dsh-llm`.
- Produces: `export function apply(ctx: Context, config?: ClaudeSkillCommandsConfig): void` — a plain Cordis plugin function (matches `scoped-tool-subagent.ts`'s own top-level `apply` shape), mounted globally, that hooks `agent/created` to mount its per-agent logic under each `agent.ctx`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/interaction/claude-skill-commands/tests/plugin.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { apply as applyClaudeSkillCommands } from '../src/index.ts'

// Does not exist yet: RED-phase anchor for this suite. See
// .agents/notes/proposed/architecture/2026-09-02-claude-code-session-import.md

function fakeAgent(cwd: string, provider: string, homedir: string): {
  ctx: Context
  session: { requestHeader: () => { config: { provider: string; model: string } } | undefined }
} {
  const session = { requestHeader: () => ({ config: { provider, model: 'x' } }), header: { cwd } }
  const ctx = new Context()
  const agent = { ctx, session, steer: vi.fn() }
  ctx.set('agent', agent)
  return { ctx, session: session as never }
}

async function bootHost(homedir: string): Promise<Context> {
  const ctx = new Context()
  ctx.set('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek-official' }) } as never)
  await ctx.plugin(CommandRuntime)
  ctx.plugin(applyClaudeSkillCommands, { homedir })
  return ctx
}

describe('claude-skill-commands per-agent registration', () => {
  it('registers a scanned skill as a command when the agent is on anthropic', async () => {
    const ctx = await bootHost(fixturesHome())
    const { ctx: agentCtx } = fakeAgent(fixturesProject(), 'anthropic', fixturesHome())
    ctx.emit('agent/created', { agent: ctx.get('agent') as never })
    await Promise.resolve()
    expect(agentCtx.commands.list(ctx.get('agent') as never).some(c => c.name === 'valid-skill')).toBe(true)
  })

  it('does not register skill commands when the agent is on a non-anthropic provider', async () => {
    const ctx = await bootHost(fixturesHome())
    const { ctx: agentCtx } = fakeAgent(fixturesProject(), 'deepseek-official', fixturesHome())
    ctx.emit('agent/created', { agent: ctx.get('agent') as never })
    await Promise.resolve()
    expect(agentCtx.commands.list(ctx.get('agent') as never).some(c => c.name === 'valid-skill')).toBe(false)
  })
})

function fixturesProject(): string {
  return new URL('./fixtures/project-root', import.meta.url).pathname
}
function fixturesHome(): string {
  return new URL('./fixtures/home', import.meta.url).pathname
}
```

Note: this test sketch mounts `CommandRuntime` on the host `ctx` while skill registration happens on `agent.ctx` (a child) — before implementing, confirm from `packages/interaction/commands/src/index.ts`'s `ScopedLayers` usage exactly how a `commands` service on a parent context is reached from a child's own `ctx.inject(['commands'], ...)` (it must resolve up the context tree, since `dsh-plan-mode` and `dsh-tool-subagent` both rely on this reaching a host-mounted service from an agent-scoped mount) — adjust the test's `ctx.set`/`ctx.plugin` order if the real injection timing differs from this sketch.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/interaction/claude-skill-commands/tests/plugin.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/interaction/claude-skill-commands/src/index.ts
import { homedir as osHomedir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { currentProviderOf } from './model-gate.ts'
import { scanSkillDirectories } from './skill-scanner.ts'
import type { ScannedSkill } from './skill-scanner.ts'

export const name = 'claude-skill-commands'

/** Deployment-owned override of the home directory skills are read from. */
export interface ClaudeSkillCommandsConfig {
  /** Overrides `os.homedir()` — for tests only; production composition omits this. */
  homedir?: string
}

/** Which provider must be current for these commands to be registered. */
const GATED_PROVIDER = 'anthropic'

/**
 * Register one skill as a command whose handler steers its body (plus any
 * typed arguments) into the agent's next turn — the same mechanism
 * `dsh-plan-mode`'s `/plan [message]` uses.
 * @param agentCtx - the agent's own scoped context (`agent.ctx`).
 * @param agent - the agent this registration belongs to.
 * @param skill - the scanned skill to register.
 * @returns the effect disposer that unregisters this command.
 */
function registerSkillCommand(agentCtx: Context, agent: Agent, skill: ScannedSkill): () => void {
  let dispose: () => void = () => {}
  agentCtx.inject(['commands'], (commandCtx) => {
    dispose = commandCtx.commands.register({
      name: skill.name,
      description: skill.description,
      input: { hint: '[args]' },
      handler: ({ rawInput }) => {
        const args = rawInput.trim()
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: args === '' ? skill.body : `${skill.body}\n\nARGUMENTS: ${args}` }],
          source: { kind: 'user' },
        }))
        return { kind: 'success', text: `Invoked skill "${skill.name}".` }
      },
    })
  })
  return () => { dispose() }
}

/**
 * Per-agent controller: toggles this agent's Claude Code skill commands on
 * or off before every step, tracking the agent's current model provider so
 * they are re-evaluated rather than decided once at mount.
 * @param agentCtx - the agent's own scoped context.
 * @param homedir - the directory `~/.claude/skills` is read from.
 */
function mountPerAgent(agentCtx: Context, homedir: string): void {
  const agent = agentCtx.agent
  const skills = scanSkillDirectories(agent.session.header.cwd, homedir)
  if (skills.length === 0) return
  let registered: (() => void)[] | undefined
  agentCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const defaultModel = agentCtx.get('agentDefaultModel')
    if (defaultModel === undefined) return decision
    const provider = currentProviderOf(agent, defaultModel)
    const shouldBeRegistered = provider === GATED_PROVIDER
    if (shouldBeRegistered && registered === undefined) {
      registered = skills.map(skill => registerSkillCommand(agentCtx, agent, skill))
    } else if (!shouldBeRegistered && registered !== undefined) {
      for (const dispose of registered) dispose()
      registered = undefined
    }
    return decision
  })
  agentCtx.effect(() => () => {
    if (registered !== undefined) for (const dispose of registered) dispose()
  }, 'claude-skill-commands: dispose on agent teardown')
}

/**
 * Mount Claude Code skill-derived slash commands for every created agent.
 * @param ctx - Host context carrying `agent/created`.
 * @param config - optional homedir override, for tests.
 */
export function apply(ctx: Context, config: ClaudeSkillCommandsConfig = {}): void {
  const homedir = config.homedir ?? osHomedir()
  ctx.on('agent/created', ({ agent }) => {
    mountPerAgent(agent.ctx, homedir)
  })
}

export default apply
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/interaction/claude-skill-commands/tests/plugin.spec.ts`
Expected: PASS. If `agent/pre-step`'s exact payload/next shape (read `packages/core/agent/src/runtime-types.ts` around its declaration) differs from the sketch above, or if `agentCtx.agent`/`agentCtx.get('agentDefaultModel')` need a different accessor on a freshly-mounted child context, adjust the implementation to match the real types — do not change the test's asserted behavior (register-when-anthropic, not-when-otherwise) to make a mismatched implementation pass.

- [ ] **Step 5: Write the failing test for dynamic toggling across a provider switch**

```ts
// append to packages/interaction/claude-skill-commands/tests/plugin.spec.ts
it('removes skill commands once the agent switches away from anthropic', async () => {
  const ctx = await bootHost(fixturesHome())
  let provider = 'anthropic'
  const { ctx: agentCtx, session } = fakeAgent(fixturesProject(), provider, fixturesHome())
  session.requestHeader = () => ({ config: { provider, model: 'x' } })
  const agent = ctx.get('agent') as never
  ctx.emit('agent/created', { agent })
  await ctx.events.dispatch('waterfall', ['agent/pre-step', { agent, signal: new AbortController().signal }, async () => ({ kind: 'proceed', messages: [] })])[0]
  expect(agentCtx.commands.list(agent).some(c => c.name === 'valid-skill')).toBe(true)
  provider = 'deepseek-official'
  await ctx.events.dispatch('waterfall', ['agent/pre-step', { agent, signal: new AbortController().signal }, async () => ({ kind: 'proceed', messages: [] })])[0]
  expect(agentCtx.commands.list(agent).some(c => c.name === 'valid-skill')).toBe(false)
})
```

Before finalizing this step, check `packages/core/agent/src/runtime-types.ts`'s exact `agent/pre-step` waterfall signature (payload shape, `next()` return type) and correct this test's dispatch call to match it precisely — the shape above is a best-effort sketch from this plan's own research, not a confirmed signature.

- [ ] **Step 6: Run test to verify it fails, then passes**

Run: `pnpm vitest run packages/interaction/claude-skill-commands/tests/plugin.spec.ts`
Expected: FAILs first if the toggle logic from Step 3 has a bug (e.g. the `next()` await ordering), then PASS once corrected.

- [ ] **Step 7: Write the failing test for invoking a registered skill command end to end**

This is the spec's own required integration test: invoking `/skill-name args` through the real commands registry must submit that skill's content into the agent's next turn.

```ts
// append to packages/interaction/claude-skill-commands/tests/plugin.spec.ts
it('invoking the registered command steers the skill body and arguments into the next turn', async () => {
  const ctx = await bootHost(fixturesHome())
  const { ctx: agentCtx } = fakeAgent(fixturesProject(), 'anthropic', fixturesHome())
  const agent = ctx.get('agent') as { steer: ReturnType<typeof vi.fn> }
  ctx.emit('agent/created', { agent: agent as never })
  await ctx.events.dispatch('waterfall', ['agent/pre-step', { agent, signal: new AbortController().signal }, async () => ({ kind: 'proceed', messages: [] })])[0]

  await agentCtx.commands.invoke(agent as never, '/valid-skill do the thing')

  expect(agent.steer).toHaveBeenCalledTimes(1)
  const [message] = agent.steer.mock.calls[0] as [{ content: { type: string; text: string }[] }]
  expect(message.content[0]?.text).toContain('# Valid Skill')
  expect(message.content[0]?.text).toContain('ARGUMENTS: do the thing')
})
```

Before finalizing this step, confirm `ctx.commands`'s actual invocation entry point and its exact argument shape by reading `packages/interaction/commands/src/index.ts`'s public API (the sketch above assumes an `invoke(agent, rawLine)` method parsing the leading `/name` itself — adjust the call to match whatever the real registry exposes, without changing what the test asserts: one `steer()` call carrying the skill body and the typed arguments).

- [ ] **Step 8: Run test to verify it fails, then passes**

Run: `pnpm vitest run packages/interaction/claude-skill-commands/tests/plugin.spec.ts`
Expected: FAILs first (either the invocation call doesn't match the real API yet, or `registerSkillCommand`'s handler doesn't shape the message as asserted), then PASS once corrected.

- [ ] **Step 9: Write the failing test for `/refresh-skills` picking up a skill added after mount**

`scanSkillDirectories` reads real files, so this test writes a `SKILL.md` to a real temp directory mid-test rather than a static fixture — the whole point is proving a live re-scan, not a fixture snapshot.

```ts
// append to packages/interaction/claude-skill-commands/tests/plugin.spec.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('/refresh-skills picks up a skill added after the agent was created, and drops one removed', async () => {
  const project = mkdtempSync(join(tmpdir(), 'claude-skill-commands-refresh-'))
  try {
    const ctx = await bootHost(fixturesHome())
    const { ctx: agentCtx } = fakeAgent(project, 'anthropic', fixturesHome())
    const agent = ctx.get('agent') as { steer: ReturnType<typeof vi.fn> }
    ctx.emit('agent/created', { agent: agent as never })
    await ctx.events.dispatch('waterfall', ['agent/pre-step', { agent, signal: new AbortController().signal }, async () => ({ kind: 'proceed', messages: [] })])[0]

    // Nothing registered yet — project dir started empty.
    expect(agentCtx.commands.list(agent as never).some(c => c.name === 'new-skill')).toBe(false)

    // A skill appears on disk after the agent was already created.
    const skillDir = join(project, '.claude', 'skills', 'new-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: new-skill\ndescription: Added later\n---\n\nRefreshed in.\n')

    const result = await agentCtx.commands.invoke(agent as never, '/refresh-skills')
    expect(result).toMatchObject({ kind: 'success' })
    expect(agentCtx.commands.list(agent as never).some(c => c.name === 'new-skill')).toBe(true)

    // Removing it from disk and refreshing again drops the command.
    rmSync(skillDir, { recursive: true, force: true })
    await agentCtx.commands.invoke(agent as never, '/refresh-skills')
    expect(agentCtx.commands.list(agent as never).some(c => c.name === 'new-skill')).toBe(false)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
```

Before finalizing this step, confirm `ctx.commands.invoke`'s exact return shape (the sketch above assumes `{ kind: 'success', ... }` matching Step 7's handler contract) against the real registry API read in Step 7.

- [ ] **Step 10: Run test to verify it fails, then implement `/refresh-skills` and re-run to pass**

Run: `pnpm vitest run packages/interaction/claude-skill-commands/tests/plugin.spec.ts`
Expected: FAIL first — no `/refresh-skills` command is registered yet.

Extend `mountPerAgent` in `packages/interaction/claude-skill-commands/src/index.ts` to track the registered set by skill name (not a flat array) so it can be diffed on refresh, and register a `/refresh-skills` command under the same provider gate as the discovered skills themselves:

```ts
// packages/interaction/claude-skill-commands/src/index.ts — replace mountPerAgent's body
function mountPerAgent(agentCtx: Context, homedir: string): void {
  const agent = agentCtx.agent
  let registered: Map<string, () => void> | undefined
  let refreshCommandDispose: (() => void) | undefined

  function rescan(): { added: number; removed: number } {
    const skills = scanSkillDirectories(agent.session.header.cwd, homedir)
    const found = new Map(skills.map(skill => [skill.name, skill]))
    const current = registered ?? new Map<string, () => void>()
    let added = 0
    let removed = 0
    for (const [name, dispose] of [...current]) {
      if (!found.has(name)) { dispose(); current.delete(name); removed++ }
    }
    for (const [name, skill] of found) {
      if (!current.has(name)) { current.set(name, registerSkillCommand(agentCtx, agent, skill)); added++ }
    }
    registered = current.size > 0 ? current : undefined
    return { added, removed }
  }

  agentCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const defaultModel = agentCtx.get('agentDefaultModel')
    if (defaultModel === undefined) return decision
    const provider = currentProviderOf(agent, defaultModel)
    const shouldBeRegistered = provider === GATED_PROVIDER
    if (shouldBeRegistered && registered === undefined) {
      rescan()
      if (registered !== undefined) {
        refreshCommandDispose = agentCtx.commands.register({
          name: 'refresh-skills',
          description: 'Re-scan Claude Code skill directories and update registered commands',
          input: {},
          handler: () => {
            const { added, removed } = rescan()
            return { kind: 'success', text: `Refreshed skills: +${added}, -${removed}.` }
          },
        })
      }
    } else if (!shouldBeRegistered && registered !== undefined) {
      for (const dispose of registered.values()) dispose()
      registered = undefined
      refreshCommandDispose?.()
      refreshCommandDispose = undefined
    }
    return decision
  })
  agentCtx.effect(() => () => {
    if (registered !== undefined) for (const dispose of registered.values()) dispose()
    refreshCommandDispose?.()
  }, 'claude-skill-commands: dispose on agent teardown')
}
```

Note: `rescan()` disposing a command whose skill vanished, then `/refresh-skills` itself potentially vanishing too (if the LAST skill was removed, `registered` goes back to `undefined`) is intentional — `/refresh-skills` is only meaningful while there's something to refresh, matching the Global Constraint that it lives under the same gate as the skills themselves. If a follow-up refresh finds skills again, the next `agent/pre-step` tick re-registers everything including `/refresh-skills`, since `shouldBeRegistered && registered === undefined` is true again. Adjust the exact re-entry point (`agent/pre-step` vs. registering `/refresh-skills` unconditionally whenever anthropic-gated, regardless of whether any skill exists yet) if reading `packages/core/agent/src/runtime-types.ts`'s real hook contract suggests a cleaner seam — the test only asserts the observable add/remove behavior, not this internal structure.

Run: `pnpm vitest run packages/interaction/claude-skill-commands/tests/plugin.spec.ts`
Expected: PASS (all tests, including the new refresh test).

- [ ] **Step 11: Commit**

```powershell
git add packages/interaction/claude-skill-commands/src/index.ts packages/interaction/claude-skill-commands/tests/plugin.spec.ts
git commit -m "feat(interaction/claude-skill-commands): gate skill commands to anthropic-backed agents, re-evaluated per step, with an on-demand /refresh-skills"
```

---

### Task 4: Package scaffolding, mounting, and gates

**Files:**
- Create: `packages/interaction/claude-skill-commands/package.json` (copy `packages/plan/plan-mode/package.json`'s shape — same group, same server-only profile; rename to `@deepseek-ai/dsh-claude-skill-commands`).
- Modify: `packages/bundle/base/cordis.patch.yml` — add a row mounting this plugin, e.g.:
  ```yaml
  - id: claude-skill-commands
    name: '@deepseek-ai/dsh-claude-skill-commands'
  ```
  placed after `llm-pi-ai` (this plugin's model gate reads `ctx.agentDefaultModel`, which is already mounted earlier in the same file — no new `inject` dependency is required at the plugin-row level since the gate resolves `ctx.agentDefaultModel` per-step, not at construction).
- Modify: `packages/bundle/base/package.json` — add `@deepseek-ai/dsh-claude-skill-commands` as a dependency.

**Interfaces:** none new — packaging and composition only.

- [ ] **Step 1: Copy the package skeleton**

Copy `packages/plan/plan-mode/package.json` to `packages/interaction/claude-skill-commands/package.json`, rename `name`, update `description`, and set dependencies to `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/cordis`, plus `js-yaml` (already a repo devDependency at root — check whether it needs promoting to a runtime dependency of this package specifically, since this package consumes it at runtime, not just in tests or scripts).

- [ ] **Step 2: Run the workspace install**

Run: `pnpm install`
Expected: the new package links into the workspace with no errors.

- [ ] **Step 3: Add the bundle row and dependency**

Modify `packages/bundle/base/cordis.patch.yml` and `packages/bundle/base/package.json` per the Files section. Run `pnpm install` again.

- [ ] **Step 4: Verify the composed config mounts it**

Run: `pnpm run dsh -- web --dump-config`
Expected: output includes `id: claude-skill-commands` / `name: '@deepseek-ai/dsh-claude-skill-commands'`, mirroring how the earlier `authorization` mount was verified in this same repo's history.

- [ ] **Step 5: Run the build, typecheck, and lint**

Run:
```powershell
pnpm exec tsc -b tsconfig.host.json
pnpm exec tsx scripts/run-oxlint.ts packages/interaction/claude-skill-commands packages/bundle/base
```
Expected: clean.

- [ ] **Step 6: Run the full test suite for touched packages**

Run: `pnpm vitest run packages/interaction/claude-skill-commands packages/bundle/base`
Expected: PASS.

- [ ] **Step 7: Verify generated catalogs are unaffected**

Run: `pnpm run verify-cordis-api` and `pnpm run verify-cordis-catalog`
Expected: both report up to date. If either fails because the new plugin's public surface needs regenerating, run the corresponding `gen-*` script (`pnpm run gen-cordis-api` / `pnpm run gen-cordis-catalog`) and commit the resulting changes in this same task.

- [ ] **Step 8: Commit**

```powershell
git add packages/interaction/claude-skill-commands/package.json pnpm-lock.yaml packages/bundle/base
git commit -m "chore(interaction/claude-skill-commands): package scaffolding and bundle mount"
```

---

## Global Verification (run once, after all tasks)

```powershell
pnpm exec tsc -b tsconfig.host.json
pnpm exec tsx scripts/run-oxlint.ts packages/interaction/claude-skill-commands packages/bundle/base
pnpm vitest run packages/interaction/claude-skill-commands packages/bundle/base
pnpm run verify-cordis-api
pnpm run verify-cordis-catalog
```

Then run all five SPARC Phase 4 reviews (`modes:ai-pitfall-review`, `code-review`, `modes:security-review` + independent advisor, `modes:regressions-analyzer`, `modes:memory-and-performance-analyzer`) per this repo's own SPARC workflow before merging, and update `.agents/notes/proposed/architecture/2026-09-02-claude-code-session-import.md`'s `Status:` line from `proposed` to `implemented` (rewriting `## Proposal` to `## Decision`) once both this plan and the session-import plan have shipped — the spec covers both features together.
