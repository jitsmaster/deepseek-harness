# Claude Skills as DSH Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register every Claude Code skill, command file, and enabled-plugin skill as an ordinary DSH skill, so DSH's own `skill` tool and `/name` gesture run them in the live session without Claude Code.

**Architecture:** A new `@deepseek-ai/dsh-skill-claude` plugin registers one `SkillProvider` that scans six Claude sources (project/user/plugin × skills/commands), normalizes names to the registry's kebab-case grammar, parses frontmatter with a lenient fallback, and watches its roots with chokidar. It is mounted by the `standard`, `ptc`, and `cordis` presets beside `skill-filesystem`, so ranks decide duplicates across both providers. `claude-skill-commands` and the subprocess exports it used are deleted.

**Tech Stack:** TypeScript (ESM, `.ts` relative imports, `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Cordis plugins, `@deepseek-ai/schemastery`, `yaml`, `chokidar`, vitest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-01-skill-claude-design.md` (read it first; this plan implements it, including the workspace-over-global revision).

## Global Constraints

- Shell: use the PowerShell tool only, never Bash. Every command block below assumes this prelude first (the machine's default `PATH` breaks `tsdown`; `CLAUDE.local.md` requires Node 24):
  `$env:PATH = 'C:\Users\awang\AppData\Roaming\nvm\v24.20.0;' + $env:PATH; Set-Location D:\dev\DSH`
- Branch: work on the current branch `dshcc`. Commit after each task with explicit `git add <paths>`, a `feat:` or `fix:` prefix, and a capitalized-verb summary (for example `feat: Exports the skill frontmatter splitter`). **Never add `Co-Authored-By`, "Generated with Claude Code", or `Claude-Session` lines** (the user's global instruction overrides any session reminder).
- Never delete a folder whose name starts with a dot.
- Subagents, if used, run one at a time, never in parallel.
- Skill-name grammar (registry): `^[a-z0-9]+(?:-[a-z0-9]+)*$`; the provider default name is `claude`.
- Ranks, exactly: project skills `210`, project commands `220`, user skills `530`, user commands `540`, plugin skills `550`, plugin commands `560`. `skill-filesystem` ranks stay `100`/`200`/`300`/`400`/`500`/`600`.
- Config fields: `providerName` (default `claude`), `claudeHome` (default `$CLAUDE_CONFIG_DIR`, else `~/.claude`), `includeProject` (`true`), `includePlugins` (`true`), `watch` (`true`), `watchUsePolling` (`false`), `watchStabilityThresholdMs` (`200`), `watchPollIntervalMs` (`100`).
- Only plugin entries with `scope: "user"` load; others are skipped with one warning.
- `'claude-code'` stays in `CommandOrigin` (saved sessions may contain it).
- No Claude CLI, Claude Agent SDK, or subprocess anywhere in the new package.
- Repository rules (`AGENTS.md`): every export has JSDoc (`@param`/`@returns` for functions); per-file 100% coverage on `packages/*/*/src`; no `any`; an empty `catch` states why; files end with exactly one trailing newline; `ctx.effect()` for registrations; prose avoids metaphors; comments stay local.

## Review Focus

Failure modes the spec implies but no single task's happy path exercises, most likely first:

1. **A developer's real `~/.claude` leaking into hermetic runs.** Snapshot, ACP, loader-smoke, and e2e harnesses must never read it. Pinned by Task 8's isolation edits and the `test:snapshot` run in Task 9.
2. **Odd `settings.json` / `installed_plugins.json` shapes** (arrays, missing `plugins`, non-boolean flags, invalid JSON, absent files) must never throw or blank the catalog. Pinned by Task 4's shape tests.
3. **Frontmatter oddities:** BOM, CRLF, unclosed `---`, empty frontmatter, unquoted `: ` in a value. Pinned by Task 3.
4. **A broken entry mid-scan** (directory named `SKILL.md`, unreadable directory, dangling symlink, deep command tree) must skip that entry only. Pinned by Task 5.
5. **Windows paths:** backslash-separated command paths must become `a:b` identifiers, and project-root discovery must work on drive-letter paths. Pinned by Tasks 2 and 4.

---

### Task 1: Export the frontmatter splitter from `skill-filesystem`

**Files:**
- Modify: `packages/skill/skill-filesystem/src/index.ts` (the private `parseFrontmatter` at about line 917)
- Test: `packages/skill/skill-filesystem/tests/skill-frontmatter.spec.ts` (create)

**Interfaces:**
- Produces: `splitSkillFrontmatter(raw: string): { yaml: string; body: string } | undefined` exported from `@deepseek-ai/dsh-skill-filesystem`. `yaml` is the text between the delimiters, unparsed.

- [ ] **Step 1: Write the failing test**

Create `packages/skill/skill-filesystem/tests/skill-frontmatter.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { splitSkillFrontmatter } from '../src/index.ts'

describe('splitSkillFrontmatter', () => {
  it('returns the unparsed YAML text and the body', () => {
    expect(splitSkillFrontmatter('---\nname: a\ndescription: b: c\n---\n\nBody.\n')).toEqual({
      yaml: 'name: a\ndescription: b: c\n',
      body: '\nBody.\n',
    })
  })

  it('accepts CRLF delimiters', () => {
    expect(splitSkillFrontmatter('---\r\nname: a\r\n---\r\nBody.\r\n')).toEqual({
      yaml: 'name: a\r\n',
      body: 'Body.\r\n',
    })
  })

  it('returns undefined when the first line is not a delimiter', () => {
    expect(splitSkillFrontmatter('# Title\n---\nx\n---\n')).toBeUndefined()
  })

  it('returns undefined for text without a newline', () => {
    expect(splitSkillFrontmatter('---')).toBeUndefined()
  })

  it('returns undefined when the closing delimiter is missing', () => {
    expect(splitSkillFrontmatter('---\nname: a\n')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/skill/skill-filesystem/tests/skill-frontmatter.spec.ts`
Expected: FAIL, `splitSkillFrontmatter is not a function` (not exported yet).

- [ ] **Step 3: Implement**

In `packages/skill/skill-filesystem/src/index.ts`, replace the whole `parseFrontmatter` function (from `function parseFrontmatter(raw: string)` through its closing `}`) with:

```ts
/**
 * Split `---` delimited frontmatter from a skill file without parsing the YAML.
 * @param raw - complete file text.
 * @returns the YAML text between the delimiters and the text after the closing
 *   delimiter, or `undefined` when the file has no complete frontmatter block.
 */
export function splitSkillFrontmatter(raw: string): { yaml: string; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  return { yaml: raw.slice(start, closing.start), body: raw.slice(closing.bodyStart) }
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const split = splitSkillFrontmatter(raw)
  if (split === undefined) return undefined
  const parsed = parseYaml(split.yaml) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return { data: parsed as Record<string, unknown>, body: split.body }
}
```

- [ ] **Step 4: Run all `skill-filesystem` tests**

Run: `pnpm exec vitest run packages/skill/skill-filesystem`
Expected: PASS, including the new spec and every existing spec.

- [ ] **Step 5: Commit**

```powershell
git add packages/skill/skill-filesystem/src/index.ts packages/skill/skill-filesystem/tests/skill-frontmatter.spec.ts
git commit -m "feat: Exports the skill frontmatter splitter for sibling providers"
```

---

### Task 2: Scaffold `skill-claude` and its name normalization

**Files:**
- Create: `packages/skill/skill-claude/package.json`
- Create: `packages/skill/skill-claude/tsconfig.json`
- Create: `packages/skill/skill-claude/src/types.ts`
- Create: `packages/skill/skill-claude/src/names.ts`
- Create: `packages/skill/skill-claude/tests/names.spec.ts`
- Modify: `tsconfig.base.json` (add one path after the `@deepseek-ai/dsh-skill-badge` line)
- Modify: `tsconfig.host.json` (add one project reference after the `./packages/skill/skill-badge` line)

**Interfaces:**
- Produces from `types.ts`:
  ```ts
  export type Warn = (key: string, message: string) => void
  export type SourceKind = 'skills' | 'commands'
  export interface SkillRoot { readonly kind: SourceKind; readonly dir: string; readonly rank: number; readonly source: string; readonly plugin?: string }
  export interface ResolvedSources { readonly roots: readonly SkillRoot[]; readonly shallowDirs: readonly string[] }
  export interface ClaudeLocator { readonly path: string }
  ```
- Produces from `names.ts`: `toSkillName(identifier: string): string | undefined`, `commandIdentifier(relativePath: string): string`, `qualifiedIdentifier(plugin: string | undefined, identifier: string): string`.

- [ ] **Step 1: Create the package manifest and tsconfig**

`packages/skill/skill-claude/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-skill-claude",
  "description": "Claude Code skills, command files, and plugin skills as DeepSeek Harness skills",
  "version": "0.1.6-alpha.2",
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/skill/skill-claude"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/index.js",
    "lib/types/**/*.d.ts"
  ],
  "license": "MIT",
  "peerDependencies": {
    "@deepseek-ai/dsh-skill": "workspace:^",
    "@deepseek-ai/dsh-skill-filesystem": "workspace:^",
    "@deepseek-ai/cordis": "workspace:^"
  },
  "dependencies": {
    "chokidar": "^5.0.0",
    "@deepseek-ai/schemastery": "workspace:^",
    "yaml": "^2.4.2"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-skill": "workspace:^",
    "@deepseek-ai/dsh-skill-filesystem": "workspace:^",
    "@deepseek-ai/cordis": "workspace:^"
  }
}
```

`packages/skill/skill-claude/tsconfig.json`:

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib/types"
  },
  "include": ["src"],
  "references": [
    { "path": "../../../vendor/cosmokit" },
    { "path": "../../../vendor/cordis" },
    { "path": "../../../vendor/schemastery" },
    { "path": "../skill" },
    { "path": "../skill-filesystem" }
  ]
}
```

- [ ] **Step 2: Register the package in the root tsconfigs and link it**

In `tsconfig.base.json`, insert after the line `"@deepseek-ai/dsh-skill-badge": ["./packages/skill/skill-badge/src"],`:

```json
      "@deepseek-ai/dsh-skill-claude": ["./packages/skill/skill-claude/src"],
```

In `tsconfig.host.json`, insert after the line `{ "path": "./packages/skill/skill-badge" },`:

```json
    { "path": "./packages/skill/skill-claude" },
```

Run: `pnpm install`
Expected: succeeds; `packages/skill/skill-claude/node_modules/yaml` and `chokidar` now exist; `pnpm-lock.yaml` gains an `importers` entry for `packages/skill/skill-claude`.

- [ ] **Step 3: Create the shared types**

`packages/skill/skill-claude/src/types.ts`:

```ts
/**
 * Shared types for the Claude skill provider.
 *
 * @module @deepseek-ai/dsh-skill-claude/types
 */

/** Reports a warning at most once per key; the key is usually the file or directory path. */
export type Warn = (key: string, message: string) => void

/** Whether a root holds `<dir>/SKILL.md` bundles or flat `*.md` command files. */
export type SourceKind = 'skills' | 'commands'

/** One directory scanned for Claude skills or command files. */
export interface SkillRoot {
  /** Layout of the directory. */
  readonly kind: SourceKind
  /** Absolute directory path. */
  readonly dir: string
  /** Registry rank; lower wins a duplicate name inside one layer. */
  readonly rank: number
  /** Prompt-visible origin label. */
  readonly source: string
  /** Plugin name that prefixes every skill name from this root; absent for project and user roots. */
  readonly plugin?: string
}

/** Directories to scan plus directories whose direct children signal a configuration change. */
export interface ResolvedSources {
  /** Skill and command roots, best rank first. */
  readonly roots: readonly SkillRoot[]
  /** Directories watched non-recursively so new roots and configuration files are noticed. */
  readonly shallowDirs: readonly string[]
}

/** Opaque handle the provider stores in each candidate and receives back in `get()`. */
export interface ClaudeLocator {
  /** Absolute path of the `SKILL.md` or command file. */
  readonly path: string
}
```

- [ ] **Step 4: Write the failing name tests**

`packages/skill/skill-claude/tests/names.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { commandIdentifier, qualifiedIdentifier, toSkillName } from '../src/names.ts'

describe('toSkillName', () => {
  it.each([
    ['obsidian-vault', 'obsidian-vault'],
    ['modes:sparc', 'modes-sparc'],
    ['superpowers:Brainstorming', 'superpowers-brainstorming'],
    ['Foo_Bar baz', 'foo-bar-baz'],
    ['--edge--', 'edge'],
    ['a:b-c', 'a-b-c'],
  ])('normalizes %s to %s', (identifier, expected) => {
    expect(toSkillName(identifier)).toBe(expected)
  })

  it('returns undefined when no letters or digits remain', () => {
    expect(toSkillName('::')).toBeUndefined()
    expect(toSkillName('')).toBeUndefined()
  })
})

describe('commandIdentifier', () => {
  it('joins path segments with a colon and drops the extension', () => {
    expect(commandIdentifier('modes/sparc.md')).toBe('modes:sparc')
    expect(commandIdentifier('a/b/c.md')).toBe('a:b:c')
    expect(commandIdentifier('plain.MD')).toBe('plain')
  })

  it('accepts Windows separators', () => {
    expect(commandIdentifier('modes\\sparc.md')).toBe('modes:sparc')
  })
})

describe('qualifiedIdentifier', () => {
  it('prefixes plugin identifiers with the plugin name', () => {
    expect(qualifiedIdentifier(undefined, 'grill-me')).toBe('grill-me')
    expect(qualifiedIdentifier('superpowers', 'brainstorming')).toBe('superpowers:brainstorming')
  })
})
```

- [ ] **Step 5: Run to verify failure**

Run: `pnpm exec vitest run packages/skill/skill-claude/tests/names.spec.ts`
Expected: FAIL, cannot resolve `../src/names.ts`.

- [ ] **Step 6: Implement `names.ts`**

`packages/skill/skill-claude/src/names.ts`:

```ts
/**
 * Name derivation for Claude skills: Claude names may contain `:` and mixed
 * case, while the DSH skill registry accepts only lowercase kebab-case.
 *
 * @module @deepseek-ai/dsh-skill-claude/names
 */

/** Every run of characters a DSH skill name cannot contain. */
const NON_NAME_RUN = /[^a-z0-9]+/g
/** Leading and trailing dashes left after replacement. */
const EDGE_DASHES = /^-+|-+$/g

/**
 * Normalize a Claude identifier to a DSH skill name.
 * @param identifier - Claude skill or command identifier, for example `modes:sparc`.
 * @returns the kebab-case name, or `undefined` when no letters or digits remain.
 */
export function toSkillName(identifier: string): string | undefined {
  const name = identifier.toLowerCase().replaceAll(NON_NAME_RUN, '-').replaceAll(EDGE_DASHES, '')
  return name === '' ? undefined : name
}

/**
 * Derive Claude's namespaced command identifier from a path below `commands/`.
 * @param relativePath - file path relative to the commands root, with `/` or `\` separators.
 * @returns the identifier with segments joined by `:` and no `.md` extension.
 */
export function commandIdentifier(relativePath: string): string {
  return relativePath.replace(/\.md$/i, '').split(/[\\/]/).join(':')
}

/**
 * Prefix a plugin's identifiers with the plugin name.
 * @param plugin - plugin name, or `undefined` for project and user sources.
 * @param identifier - skill or command identifier inside the source.
 * @returns the identifier, namespaced by the plugin when there is one.
 */
export function qualifiedIdentifier(plugin: string | undefined, identifier: string): string {
  return plugin === undefined ? identifier : `${plugin}:${identifier}`
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm exec vitest run packages/skill/skill-claude/tests/names.spec.ts`
Expected: PASS (all cases).

- [ ] **Step 8: Commit**

```powershell
git add packages/skill/skill-claude/package.json packages/skill/skill-claude/tsconfig.json packages/skill/skill-claude/src/types.ts packages/skill/skill-claude/src/names.ts packages/skill/skill-claude/tests/names.spec.ts tsconfig.base.json tsconfig.host.json pnpm-lock.yaml
git commit -m "feat: Scaffolds the Claude skill provider package with name normalization"
```

---

### Task 3: Frontmatter parsing with a lenient fallback

**Files:**
- Create: `packages/skill/skill-claude/src/fs-error.ts`
- Create: `packages/skill/skill-claude/src/frontmatter.ts`
- Test: `packages/skill/skill-claude/tests/fs-error.spec.ts`, `packages/skill/skill-claude/tests/frontmatter.spec.ts`

**Interfaces:**
- Consumes: `splitSkillFrontmatter` (Task 1); `SkillInvocationPolicy` type from `@deepseek-ai/dsh-skill`.
- Produces from `fs-error.ts`: `isMissing(error: unknown): boolean`.
- Produces from `frontmatter.ts`:
  ```ts
  export interface ClaudeDocument { readonly data: Record<string, unknown>; readonly body: string }
  export function parseClaudeDocument(raw: string): ClaudeDocument
  export function textField(data: Record<string, unknown>, key: string): string | undefined
  export function invocationPolicy(data: Record<string, unknown>): SkillInvocationPolicy
  export function describeCommand(data: Record<string, unknown>, body: string): string | undefined
  ```

- [ ] **Step 1: Write the failing tests**

`packages/skill/skill-claude/tests/fs-error.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isMissing } from '../src/fs-error.ts'

describe('isMissing', () => {
  it('is true for ENOENT and ENOTDIR', () => {
    expect(isMissing({ code: 'ENOENT' })).toBe(true)
    expect(isMissing({ code: 'ENOTDIR' })).toBe(true)
  })

  it('is false for other errors and non-objects', () => {
    expect(isMissing({ code: 'EACCES' })).toBe(false)
    expect(isMissing(new Error('plain'))).toBe(false)
    expect(isMissing(null)).toBe(false)
    expect(isMissing('ENOENT')).toBe(false)
  })
})
```

`packages/skill/skill-claude/tests/frontmatter.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { describeCommand, invocationPolicy, parseClaudeDocument, textField } from '../src/frontmatter.ts'

describe('parseClaudeDocument', () => {
  it('parses strict YAML frontmatter and returns the body', () => {
    const document = parseClaudeDocument('---\nname: grill-me\ndescription: A relentless interview.\ndisable-model-invocation: true\n---\n\nBody text.\n')
    expect(document.data).toEqual({ name: 'grill-me', description: 'A relentless interview.', 'disable-model-invocation': true })
    expect(document.body).toBe('\nBody text.\n')
  })

  it('treats a file without frontmatter as all body', () => {
    expect(parseClaudeDocument('# Title\n\nText')).toEqual({ data: {}, body: '# Title\n\nText' })
  })

  it('ignores a leading byte order mark', () => {
    expect(parseClaudeDocument('\uFEFF---\nname: a\n---\nB').data).toEqual({ name: 'a' })
  })

  it('falls back to line parsing when a value contains an unquoted colon', () => {
    const document = parseClaudeDocument('---\nname: ado-worktree-cleanup\ndescription: Remove worktrees: then empty the bin.\n---\nBody')
    expect(document.data).toEqual({ name: 'ado-worktree-cleanup', description: 'Remove worktrees: then empty the bin.' })
    expect(document.body).toBe('Body')
  })

  it('unquotes values in the fallback and ignores lines that are not fields', () => {
    const document = parseClaudeDocument([
      '---',
      'broken: a: b',
      'double: "quoted value"',
      "single: 'single value'",
      'open: "never closed',
      'lone: "',
      '  - not a field',
      '',
      '---',
      'Body',
    ].join('\n'))
    expect(document.data).toEqual({
      broken: 'a: b',
      double: 'quoted value',
      single: 'single value',
      open: '"never closed',
      lone: '"',
    })
  })

  it('treats a scalar or empty frontmatter block as no fields', () => {
    expect(parseClaudeDocument('---\njust a string\n---\nBody')).toEqual({ data: {}, body: 'Body' })
    expect(parseClaudeDocument('---\n---\nBody')).toEqual({ data: {}, body: 'Body' })
  })

  it('treats an unclosed frontmatter block as all body', () => {
    expect(parseClaudeDocument('---\nname: a\n').data).toEqual({})
  })
})

describe('textField', () => {
  it('returns trimmed non-empty strings only', () => {
    expect(textField({ k: '  x ' }, 'k')).toBe('x')
    expect(textField({ k: '   ' }, 'k')).toBeUndefined()
    expect(textField({ k: 3 }, 'k')).toBeUndefined()
    expect(textField({}, 'k')).toBeUndefined()
  })
})

describe('invocationPolicy', () => {
  it('permits both surfaces by default', () => {
    expect(invocationPolicy({})).toEqual({ modelInvocable: true, userInvocable: true })
  })

  it('honors boolean and string flags', () => {
    expect(invocationPolicy({ 'disable-model-invocation': true })).toEqual({ modelInvocable: false, userInvocable: true })
    expect(invocationPolicy({ 'user-invocable': false })).toEqual({ modelInvocable: true, userInvocable: false })
    expect(invocationPolicy({ 'disable-model-invocation': ' TRUE ', 'user-invocable': 'false' })).toEqual({ modelInvocable: false, userInvocable: false })
  })

  it('ignores unrecognized flag values', () => {
    expect(invocationPolicy({ 'disable-model-invocation': 'maybe', 'user-invocable': 1 })).toEqual({ modelInvocable: true, userInvocable: true })
  })
})

describe('describeCommand', () => {
  it('prefers the frontmatter description', () => {
    expect(describeCommand({ description: 'From frontmatter' }, '# Heading\nText')).toBe('From frontmatter')
  })

  it('falls back to the first Markdown heading at any level', () => {
    expect(describeCommand({}, 'Intro line\n\n### Boomerang Commander Mode: Orchestration  \nMore')).toBe('Boomerang Commander Mode: Orchestration')
  })

  it('falls back to the first non-empty line when there is no heading', () => {
    expect(describeCommand({ description: '   ' }, '\n\n  Do the thing.\nSecond')).toBe('Do the thing.')
  })

  it('returns undefined for an empty body', () => {
    expect(describeCommand({}, '\n  \n')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/skill/skill-claude/tests/fs-error.spec.ts packages/skill/skill-claude/tests/frontmatter.spec.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `fs-error.ts`**

```ts
/**
 * Filesystem error classification shared by the Claude skill scanners.
 *
 * @module @deepseek-ai/dsh-skill-claude/fs-error
 */

/**
 * Return whether a Node filesystem error means the path does not exist.
 * @param error - value caught from a `node:fs` call.
 * @returns whether the code is `ENOENT` or `ENOTDIR`.
 */
export function isMissing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}
```

- [ ] **Step 4: Implement `frontmatter.ts`**

```ts
/**
 * Frontmatter parsing for Claude `SKILL.md` and command files. Claude Code
 * accepts values YAML rejects (an unquoted `: ` inside a description), so a
 * failed YAML parse falls back to a line parser that splits at the first colon.
 *
 * @module @deepseek-ai/dsh-skill-claude/frontmatter
 */

import { parse as parseYaml } from 'yaml'
import type { SkillInvocationPolicy } from '@deepseek-ai/dsh-skill'
import { splitSkillFrontmatter } from '@deepseek-ai/dsh-skill-filesystem'

/** One Claude file split into frontmatter fields and body. */
export interface ClaudeDocument {
  /** Frontmatter fields; empty when the file has no usable frontmatter. */
  readonly data: Record<string, unknown>
  /** Text after the frontmatter, or the whole file when there is none. */
  readonly body: string
}

/** A `key: value` frontmatter line; the key starts with a letter. */
const FIELD_LINE = /^([A-Za-z][\w-]*):[ \t]*(.*)$/
/** A Markdown heading of any level. */
const HEADING = /^#{1,6}[ \t]+(.+?)[ \t]*$/m

/**
 * Split and parse a Claude file.
 * @param raw - complete file text.
 * @returns the frontmatter fields and body.
 */
export function parseClaudeDocument(raw: string): ClaudeDocument {
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw
  const split = splitSkillFrontmatter(text)
  if (split === undefined) return { data: {}, body: text }
  return { data: strictFields(split.yaml) ?? lenientFields(split.yaml), body: split.body }
}

function strictFields(yaml: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = parseYaml(yaml)
  } catch {
    // Values such as `description: a: b` are valid for Claude Code; the line parser handles them.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

function lenientFields(yaml: string): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const line of yaml.split(/\r?\n/)) {
    const match = FIELD_LINE.exec(line)
    if (match !== null) data[match[1] as string] = unquote((match[2] as string).trim())
  }
  return data
}

function unquote(value: string): string {
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Read a non-empty string field.
 * @param data - frontmatter fields.
 * @param key - field name.
 * @returns the trimmed string, or `undefined` when absent, blank, or not a string.
 */
export function textField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function flagField(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return undefined
}

/**
 * Resolve the invocation policy from `disable-model-invocation` and `user-invocable`.
 * @param data - frontmatter fields.
 * @returns a policy that permits both surfaces unless a flag restricts one.
 */
export function invocationPolicy(data: Record<string, unknown>): SkillInvocationPolicy {
  return {
    modelInvocable: flagField(data, 'disable-model-invocation') !== true,
    userInvocable: flagField(data, 'user-invocable') !== false,
  }
}

/**
 * Describe a command file: its frontmatter description, else its first Markdown
 * heading, else its first non-empty line.
 * @param data - frontmatter fields.
 * @param body - text after the frontmatter.
 * @returns the description, or `undefined` when the file has no text.
 */
export function describeCommand(data: Record<string, unknown>, body: string): string | undefined {
  const described = textField(data, 'description')
  if (described !== undefined) return described
  const heading = HEADING.exec(body)
  if (heading !== null) return heading[1]
  return body.split(/\r?\n/).map(line => line.trim()).find(line => line !== '')
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm exec vitest run packages/skill/skill-claude/tests`
Expected: PASS for names, fs-error, and frontmatter specs.

- [ ] **Step 6: Commit**

```powershell
git add packages/skill/skill-claude/src/fs-error.ts packages/skill/skill-claude/src/frontmatter.ts packages/skill/skill-claude/tests/fs-error.spec.ts packages/skill/skill-claude/tests/frontmatter.spec.ts
git commit -m "feat: Parses Claude frontmatter with a lenient fallback for colon values"
```

---

### Task 4: Source resolution (roots, plugins, project root)

**Files:**
- Create: `packages/skill/skill-claude/src/sources.ts`
- Test: `packages/skill/skill-claude/tests/sources.spec.ts`

**Interfaces:**
- Consumes: `isMissing` (Task 3); `Warn`, `SkillRoot`, `ResolvedSources` (Task 2).
- Produces:
  ```ts
  export const CLAUDE_RANK: { readonly projectSkills: 210; readonly projectCommands: 220; readonly userSkills: 530; readonly userCommands: 540; readonly pluginSkills: 550; readonly pluginCommands: 560 }
  export function resolveClaudeHome(configured: string | undefined, env?: NodeJS.ProcessEnv): string
  export function findProjectRoot(cwd: string): Promise<string>
  export interface ResolveOptions { readonly claudeHome: string; readonly projectRoot: string | undefined; readonly includePlugins: boolean; readonly warn: Warn }
  export function resolveSources(options: ResolveOptions): Promise<ResolvedSources>
  ```
  `shallowDirs` order: `claudeHome`, `claudeHome/plugins` (only with `includePlugins`), `<projectRoot>/.claude` (only with a project root).

- [ ] **Step 1: Write the failing tests**

`packages/skill/skill-claude/tests/sources.spec.ts`:

```ts
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_RANK, findProjectRoot, resolveClaudeHome, resolveSources } from '../src/sources.ts'
import type { Warn } from '../src/types.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-skill-claude-${name}-`))
  tempDirs.push(dir)
  return await realpath(dir)
}

function collector(): { warn: Warn; messages: string[] } {
  const messages: string[] = []
  return { warn: (_key, message) => { messages.push(message) }, messages }
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, JSON.stringify(value))
}

describe('resolveClaudeHome', () => {
  it('prefers the configured directory, then CLAUDE_CONFIG_DIR, then ~/.claude', () => {
    expect(resolveClaudeHome('/configured', { CLAUDE_CONFIG_DIR: '/env' })).toBe('/configured')
    expect(resolveClaudeHome(undefined, { CLAUDE_CONFIG_DIR: '/env' })).toBe('/env')
    expect(resolveClaudeHome(undefined, { CLAUDE_CONFIG_DIR: '' })).toBe(join(homedir(), '.claude'))
    expect(resolveClaudeHome(undefined, {})).toBe(join(homedir(), '.claude'))
  })
})

describe('findProjectRoot', () => {
  it('returns the nearest ancestor containing .git', async () => {
    const root = await tempDir('git-root')
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(join(root, 'src', 'deep'), { recursive: true })
    expect(await findProjectRoot(join(root, 'src', 'deep'))).toBe(root)
  })

  it('returns the starting directory when no ancestor has .git', async () => {
    const root = await tempDir('no-git')
    expect(await findProjectRoot(root)).toBe(root)
  })
})

describe('resolveSources', () => {
  it('lists project and user roots with their ranks and the shallow watch directories', async () => {
    const home = await tempDir('home')
    const project = await tempDir('project')
    const { warn, messages } = collector()

    const sources = await resolveSources({ claudeHome: home, projectRoot: project, includePlugins: false, warn })

    expect(sources.roots.map(root => [root.kind, root.dir, root.rank, root.source])).toEqual([
      ['skills', join(project, '.claude', 'skills'), CLAUDE_RANK.projectSkills, 'claude-project'],
      ['commands', join(project, '.claude', 'commands'), CLAUDE_RANK.projectCommands, 'claude-project'],
      ['skills', join(home, 'skills'), CLAUDE_RANK.userSkills, 'claude-user'],
      ['commands', join(home, 'commands'), CLAUDE_RANK.userCommands, 'claude-user'],
    ])
    expect(sources.shallowDirs).toEqual([home, join(project, '.claude')])
    expect(messages).toEqual([])
  })

  it('omits project roots without a project and plugin roots when plugins are off', async () => {
    const home = await tempDir('home-only')
    const { warn } = collector()
    const sources = await resolveSources({ claudeHome: home, projectRoot: undefined, includePlugins: false, warn })
    expect(sources.roots.map(root => root.rank)).toEqual([CLAUDE_RANK.userSkills, CLAUDE_RANK.userCommands])
    expect(sources.shallowDirs).toEqual([home])
  })

  it('resolves enabled user-scope plugins from installed_plugins.json', async () => {
    const home = await tempDir('plugins')
    const { warn, messages } = collector()
    const cache = (name: string): string => join(home, 'plugins', 'cache', name)
    await writeJson(join(home, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: {
        'superpowers@claude-plugins-official': [{ scope: 'user', installPath: cache('superpowers') }],
        'disabled@market': [{ scope: 'user', installPath: cache('disabled') }],
        'scoped@market': [{ scope: 'project', installPath: cache('scoped') }],
        bare: [{ scope: 'user', installPath: cache('bare') }],
      },
    })
    await writeJson(join(home, 'settings.json'), {
      enabledPlugins: {
        'superpowers@claude-plugins-official': true,
        'disabled@market': false,
        'scoped@market': true,
        'ghost@market': true,
        bare: true,
        ignored: 'yes',
      },
    })

    const sources = await resolveSources({ claudeHome: home, projectRoot: undefined, includePlugins: true, warn })

    const plugins = sources.roots.filter(root => root.plugin !== undefined)
    expect(plugins.map(root => [root.plugin, root.kind, root.rank, root.dir, root.source])).toEqual([
      ['bare', 'skills', CLAUDE_RANK.pluginSkills, join(cache('bare'), 'skills'), 'claude-plugin'],
      ['bare', 'commands', CLAUDE_RANK.pluginCommands, join(cache('bare'), 'commands'), 'claude-plugin'],
      ['superpowers', 'skills', CLAUDE_RANK.pluginSkills, join(cache('superpowers'), 'skills'), 'claude-plugin'],
      ['superpowers', 'commands', CLAUDE_RANK.pluginCommands, join(cache('superpowers'), 'commands'), 'claude-plugin'],
    ])
    expect(sources.shallowDirs).toEqual([home, join(home, 'plugins')])
    expect(messages).toEqual([
      'plugin ghost@market is enabled but not installed',
      'plugin scoped@market skipped: only scope "user" entries are supported',
    ])
  })

  it('lets project settings override user settings in order', async () => {
    const home = await tempDir('override-home')
    const project = await tempDir('override-project')
    const { warn } = collector()
    await writeJson(join(home, 'plugins', 'installed_plugins.json'), {
      plugins: {
        'on@market': [{ scope: 'user', installPath: join(home, 'cache', 'on') }],
        'off@market': [{ scope: 'user', installPath: join(home, 'cache', 'off') }],
      },
    })
    await writeJson(join(home, 'settings.json'), { enabledPlugins: { 'on@market': false, 'off@market': true } })
    await writeJson(join(project, '.claude', 'settings.json'), { enabledPlugins: { 'on@market': true } })
    await writeJson(join(project, '.claude', 'settings.local.json'), { enabledPlugins: { 'off@market': false } })

    const sources = await resolveSources({ claudeHome: home, projectRoot: project, includePlugins: true, warn })

    expect([...new Set(sources.roots.flatMap(root => root.plugin === undefined ? [] : [root.plugin]))]).toEqual(['on'])
    expect(sources.shallowDirs).toEqual([home, join(home, 'plugins'), join(project, '.claude')])
  })

  it('tolerates absent files, wrong shapes, and invalid JSON without throwing', async () => {
    const home = await tempDir('shapes')
    const { warn, messages } = collector()
    await writeText(join(home, 'settings.json'), '{not json')
    await writeJson(join(home, 'plugins', 'installed_plugins.json'), ['not', 'an', 'object'])

    const sources = await resolveSources({ claudeHome: home, projectRoot: undefined, includePlugins: true, warn })

    expect(sources.roots.every(root => root.plugin === undefined)).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('invalid JSON')
    expect(messages[0]).toContain(join(home, 'settings.json'))
  })

  it('reads enabledPlugins only when it is an object', async () => {
    const home = await tempDir('enabled-shape')
    const { warn, messages } = collector()
    await writeJson(join(home, 'settings.json'), { enabledPlugins: ['a@b'] })
    await writeJson(join(home, 'plugins', 'installed_plugins.json'), { plugins: { 'a@b': [{ scope: 'user', installPath: join(home, 'x') }] } })

    const sources = await resolveSources({ claudeHome: home, projectRoot: undefined, includePlugins: true, warn })

    expect(sources.roots.every(root => root.plugin === undefined)).toBe(true)
    expect(messages).toEqual([])
  })

  it('warns when a settings file cannot be read for a reason other than absence', async () => {
    const home = await tempDir('unreadable')
    const { warn, messages } = collector()
    await mkdir(join(home, 'settings.json'), { recursive: true })

    await resolveSources({ claudeHome: home, projectRoot: undefined, includePlugins: true, warn })

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(join(home, 'settings.json'))
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/skill/skill-claude/tests/sources.spec.ts`
Expected: FAIL, cannot resolve `../src/sources.ts`.

- [ ] **Step 3: Implement `sources.ts`**

```ts
/**
 * Resolution of the Claude directories to scan: project and user skills and
 * commands, plus the skills and commands of enabled user-scope plugins.
 *
 * @module @deepseek-ai/dsh-skill-claude/sources
 */

import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isMissing } from './fs-error.ts'
import type { ResolvedSources, SkillRoot, Warn } from './types.ts'

/** Registry ranks; every workspace source outranks every global source. */
export const CLAUDE_RANK = {
  projectSkills: 210,
  projectCommands: 220,
  userSkills: 530,
  userCommands: 540,
  pluginSkills: 550,
  pluginCommands: 560,
} as const

/** Inputs for {@link resolveSources}. */
export interface ResolveOptions {
  /** Claude configuration directory. */
  readonly claudeHome: string
  /** Project root whose `.claude` directory is scanned, or `undefined` to skip project sources. */
  readonly projectRoot: string | undefined
  /** Whether enabled plugins are resolved. */
  readonly includePlugins: boolean
  /** Warning sink. */
  readonly warn: Warn
}

/**
 * Resolve the Claude configuration directory.
 * @param configured - explicit directory from provider configuration.
 * @param env - environment to read `CLAUDE_CONFIG_DIR` from.
 * @returns the configured directory, else a non-empty `CLAUDE_CONFIG_DIR`, else `~/.claude`.
 */
export function resolveClaudeHome(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (configured !== undefined) return configured
  const fromEnv = env.CLAUDE_CONFIG_DIR
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return join(homedir(), '.claude')
}

/**
 * Find the project root of a working directory.
 * @param cwd - directory a session works in.
 * @returns the nearest ancestor containing `.git`, else `cwd`.
 */
export async function findProjectRoot(cwd: string): Promise<string> {
  let current = cwd
  while (true) {
    if (await exists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // A missing .git entry only means this ancestor is not the project root.
    return false
  }
}

/**
 * Resolve every directory to scan and every directory to watch.
 * @param options - Claude home, project root, plugin switch, and warning sink.
 * @returns scan roots (project, user, then plugin roots) and shallow watch directories.
 */
export async function resolveSources(options: ResolveOptions): Promise<ResolvedSources> {
  const { claudeHome, projectRoot, includePlugins, warn } = options
  const roots: SkillRoot[] = []
  const shallowDirs: string[] = [claudeHome]
  if (projectRoot !== undefined) {
    const projectClaude = join(projectRoot, '.claude')
    roots.push(
      { kind: 'skills', dir: join(projectClaude, 'skills'), rank: CLAUDE_RANK.projectSkills, source: 'claude-project' },
      { kind: 'commands', dir: join(projectClaude, 'commands'), rank: CLAUDE_RANK.projectCommands, source: 'claude-project' },
    )
  }
  roots.push(
    { kind: 'skills', dir: join(claudeHome, 'skills'), rank: CLAUDE_RANK.userSkills, source: 'claude-user' },
    { kind: 'commands', dir: join(claudeHome, 'commands'), rank: CLAUDE_RANK.userCommands, source: 'claude-user' },
  )
  if (includePlugins) {
    const pluginsDir = join(claudeHome, 'plugins')
    shallowDirs.push(pluginsDir)
    const settingsPaths = [join(claudeHome, 'settings.json')]
    if (projectRoot !== undefined) {
      settingsPaths.push(join(projectRoot, '.claude', 'settings.json'), join(projectRoot, '.claude', 'settings.local.json'))
    }
    const settings = await Promise.all(settingsPaths.map(path => readJson(path, warn)))
    const installed = await readJson(join(pluginsDir, 'installed_plugins.json'), warn)
    roots.push(...pluginRoots(installed, enabledPluginKeys(settings), warn))
  }
  if (projectRoot !== undefined) shallowDirs.push(join(projectRoot, '.claude'))
  return { roots, shallowDirs }
}

async function readJson(path: string, warn: Warn): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (!isMissing(error)) warn(path, `${path} ignored: ${String(error)}`)
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    warn(path, `${path} ignored: invalid JSON: ${String(error)}`)
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Later settings documents override earlier ones, matching Claude Code's user, project, local order. */
function enabledPluginKeys(settings: readonly unknown[]): Set<string> {
  const flags = new Map<string, boolean>()
  for (const document of settings) {
    if (!isRecord(document) || !isRecord(document.enabledPlugins)) continue
    for (const [key, value] of Object.entries(document.enabledPlugins)) {
      if (typeof value === 'boolean') flags.set(key, value)
    }
  }
  return new Set([...flags].filter(([, enabled]) => enabled).map(([key]) => key))
}

function pluginRoots(installed: unknown, enabled: ReadonlySet<string>, warn: Warn): SkillRoot[] {
  const registry = isRecord(installed) && isRecord(installed.plugins) ? installed.plugins : {}
  const roots: SkillRoot[] = []
  for (const key of [...enabled].sort()) {
    const entries = registry[key]
    if (!Array.isArray(entries)) {
      warn(key, `plugin ${key} is enabled but not installed`)
      continue
    }
    const installPath = userInstallPath(entries)
    if (installPath === undefined) {
      warn(key, `plugin ${key} skipped: only scope "user" entries are supported`)
      continue
    }
    const at = key.indexOf('@')
    const plugin = at === -1 ? key : key.slice(0, at)
    roots.push(
      { kind: 'skills', dir: join(installPath, 'skills'), rank: CLAUDE_RANK.pluginSkills, source: 'claude-plugin', plugin },
      { kind: 'commands', dir: join(installPath, 'commands'), rank: CLAUDE_RANK.pluginCommands, source: 'claude-plugin', plugin },
    )
  }
  return roots
}

function userInstallPath(entries: readonly unknown[]): string | undefined {
  for (const entry of entries) {
    if (isRecord(entry) && entry.scope === 'user' && typeof entry.installPath === 'string') return entry.installPath
  }
  return undefined
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run packages/skill/skill-claude/tests/sources.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/skill/skill-claude/src/sources.ts packages/skill/skill-claude/tests/sources.spec.ts
git commit -m "feat: Resolves Claude project, user, and enabled-plugin skill roots"
```

---

### Task 5: Root scanning and skill loading

**Files:**
- Create: `packages/skill/skill-claude/src/scan.ts`
- Test: `packages/skill/skill-claude/tests/scan.spec.ts`, `packages/skill/skill-claude/tests/scan-errors.spec.ts`

**Interfaces:**
- Consumes: Tasks 2–4 modules.
- Produces:
  ```ts
  export function scanRoot(root: SkillRoot, providerName: string, warn: Warn): Promise<SkillCandidate[]>
  export function loadDefinition(candidate: SkillCandidate, warn: Warn): Promise<SkillDefinition | undefined>
  ```
  Each candidate: `name`, `description`, optional `whenToUse`, `invocation`, `source`, `provider` (= `providerName`), `rank`, `path`, `resourceBase: { kind: 'directory', path: dirname(file) }`, `locator: ClaudeLocator`.

- [ ] **Step 1: Write the failing scan tests**

`packages/skill/skill-claude/tests/scan.spec.ts`:

```ts
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDefinition, scanRoot } from '../src/scan.ts'
import type { SkillRoot, Warn } from '../src/types.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-skill-claude-${name}-`))
  tempDirs.push(dir)
  return await realpath(dir)
}

function collector(): { warn: Warn; messages: string[] } {
  const messages: string[] = []
  return { warn: (_key, message) => { messages.push(message) }, messages }
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

function skillsRoot(dir: string, extra: Partial<SkillRoot> = {}): SkillRoot {
  return { kind: 'skills', dir, rank: 530, source: 'claude-user', ...extra }
}

function commandsRoot(dir: string, extra: Partial<SkillRoot> = {}): SkillRoot {
  return { kind: 'commands', dir, rank: 540, source: 'claude-user', ...extra }
}

describe('scanRoot skills', () => {
  it('builds candidates from SKILL.md bundles', async () => {
    const root = await tempDir('skills')
    await writeText(join(root, 'grill-me', 'SKILL.md'), '---\nname: grill-me\ndescription: A relentless interview.\nwhen_to_use: Before building.\ndisable-model-invocation: true\n---\n\nAsk questions.\n')
    const { warn, messages } = collector()

    const candidates = await scanRoot(skillsRoot(root), 'claude', warn)

    expect(candidates).toEqual([{
      name: 'grill-me',
      description: 'A relentless interview.',
      whenToUse: 'Before building.',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'claude-user',
      provider: 'claude',
      rank: 530,
      path: join(root, 'grill-me', 'SKILL.md'),
      resourceBase: { kind: 'directory', path: join(root, 'grill-me') },
      locator: { path: join(root, 'grill-me', 'SKILL.md') },
    }])
    expect(messages).toEqual([])
  })

  it('prefers the frontmatter name over the directory name and normalizes it', async () => {
    const root = await tempDir('skills-name')
    await writeText(join(root, 'Some_Dir', 'SKILL.md'), '---\nname: Real Name\ndescription: d\n---\nB')
    await writeText(join(root, 'Dir_Only', 'SKILL.md'), '---\ndescription: d\n---\nB')
    const { warn } = collector()

    const names = (await scanRoot(skillsRoot(root), 'claude', warn)).map(candidate => candidate.name)

    expect(names).toEqual(['dir-only', 'real-name'])
  })

  it('prefixes plugin skills with the plugin name', async () => {
    const root = await tempDir('plugin-skills')
    await writeText(join(root, 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\ndescription: d\n---\nB')
    const { warn } = collector()

    const candidates = await scanRoot(skillsRoot(root, { plugin: 'superpowers', rank: 550, source: 'claude-plugin' }), 'claude', warn)

    expect(candidates.map(candidate => candidate.name)).toEqual(['superpowers-brainstorming'])
  })

  it('skips directories without SKILL.md and plain files silently', async () => {
    const root = await tempDir('skills-quiet')
    await mkdir(join(root, 'synced'), { recursive: true })
    await writeText(join(root, 'note.txt'), 'x')
    const { warn, messages } = collector()

    expect(await scanRoot(skillsRoot(root), 'claude', warn)).toEqual([])
    expect(messages).toEqual([])
  })

  it('follows a symlinked skill directory and skips a dangling one', async () => {
    const root = await tempDir('skills-links')
    const target = await tempDir('skills-link-target')
    await writeText(join(target, 'SKILL.md'), '---\nname: linked\ndescription: d\n---\nB')
    await symlink(target, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(join(root, 'missing-target'), join(root, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
    const { warn } = collector()

    const names = (await scanRoot(skillsRoot(root), 'claude', warn)).map(candidate => candidate.name)

    expect(names).toEqual(['linked'])
  })

  it('skips a skill without a description or without a usable name, with a warning', async () => {
    const root = await tempDir('skills-invalid')
    await writeText(join(root, 'no-description', 'SKILL.md'), '---\nname: no-description\n---\nB')
    await writeText(join(root, 'punctuation', 'SKILL.md'), '---\nname: "!!!"\ndescription: d\n---\nB')
    const { warn, messages } = collector()

    expect(await scanRoot(skillsRoot(root), 'claude', warn)).toEqual([])
    expect(messages).toHaveLength(2)
    expect(messages.some(message => message.includes('no description'))).toBe(true)
    expect(messages.some(message => message.includes('has no letters or digits'))).toBe(true)
  })

  it('warns and skips a SKILL.md that cannot be read as a file', async () => {
    const root = await tempDir('skills-unreadable')
    await mkdir(join(root, 'broken', 'SKILL.md'), { recursive: true })
    const { warn, messages } = collector()

    expect(await scanRoot(skillsRoot(root), 'claude', warn)).toEqual([])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(join(root, 'broken', 'SKILL.md'))
  })

  it('returns nothing, silently, for a missing root or a root that is a file', async () => {
    const root = await tempDir('skills-missing')
    await writeText(join(root, 'file-root'), 'x')
    const { warn, messages } = collector()

    expect(await scanRoot(skillsRoot(join(root, 'absent')), 'claude', warn)).toEqual([])
    expect(await scanRoot(skillsRoot(join(root, 'file-root')), 'claude', warn)).toEqual([])
    expect(messages).toEqual([])
  })
})

describe('scanRoot commands', () => {
  it('namespaces nested command files and describes them from their heading', async () => {
    const root = await tempDir('commands')
    await writeText(join(root, 'modes', 'sparc.md'), '# Boomerang Commander Mode\n\nYou are the commander.\n')
    await writeText(join(root, 'dream.md'), '---\ndescription: Force-invoke the dream skill.\n---\nInvoke it.\n')
    await writeText(join(root, 'modes', 'notes.txt'), 'ignored')
    const { warn } = collector()

    const candidates = await scanRoot(commandsRoot(root), 'claude', warn)

    expect(candidates.map(candidate => [candidate.name, candidate.description])).toEqual([
      ['dream', 'Force-invoke the dream skill.'],
      ['modes-sparc', 'Boomerang Commander Mode'],
    ])
    expect(candidates[1]?.resourceBase).toEqual({ kind: 'directory', path: join(root, 'modes') })
  })

  it('prefixes plugin commands and skips empty files with a warning', async () => {
    const root = await tempDir('plugin-commands')
    await writeText(join(root, 'review.md'), 'Review the diff.\n')
    await writeText(join(root, 'empty.md'), '\n\n')
    const { warn, messages } = collector()

    const candidates = await scanRoot(commandsRoot(root, { plugin: 'superpowers', rank: 560, source: 'claude-plugin' }), 'claude', warn)

    expect(candidates.map(candidate => candidate.name)).toEqual(['superpowers-review'])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('no description')
  })

  it('does not descend into symlinked directories', async () => {
    const root = await tempDir('commands-loop')
    await writeText(join(root, 'a.md'), 'Command a.\n')
    await symlink(root, join(root, 'loop'), process.platform === 'win32' ? 'junction' : 'dir')
    const { warn } = collector()

    expect((await scanRoot(commandsRoot(root), 'claude', warn)).map(candidate => candidate.name)).toEqual(['a'])
  })
})

describe('loadDefinition', () => {
  it('returns the trimmed body without frontmatter and the candidate metadata', async () => {
    const root = await tempDir('load')
    await writeText(join(root, 'grill-me', 'SKILL.md'), '---\nname: grill-me\ndescription: d\nwhen_to_use: now\n---\n\n  Body line.  \n\n')
    const { warn } = collector()
    const [candidate] = await scanRoot(skillsRoot(root), 'claude', warn)

    const definition = await loadDefinition(candidate as NonNullable<typeof candidate>, warn)

    expect(definition).toEqual({
      name: 'grill-me',
      description: 'd',
      whenToUse: 'now',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'claude-user',
      provider: 'claude',
      path: join(root, 'grill-me', 'SKILL.md'),
      resourceBase: { kind: 'directory', path: join(root, 'grill-me') },
      content: 'Body line.',
    })
  })

  it('omits whenToUse when the candidate has none and returns undefined when the file vanished', async () => {
    const root = await tempDir('load-gone')
    await writeText(join(root, 'a', 'SKILL.md'), '---\nname: a\ndescription: d\n---\nB')
    const { warn } = collector()
    const [candidate] = await scanRoot(skillsRoot(root), 'claude', warn)
    const live = await loadDefinition(candidate as NonNullable<typeof candidate>, warn)
    expect(live && 'whenToUse' in live).toBe(false)

    await rm(join(root, 'a'), { recursive: true, force: true })
    expect(await loadDefinition(candidate as NonNullable<typeof candidate>, warn)).toBeUndefined()
  })
})
```

`packages/skill/skill-claude/tests/scan-errors.spec.ts` (covers a non-missing `readdir` failure, which cannot be forced portably on disk):

```ts
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillRoot, Warn } from '../src/types.ts'

const fsHarness = vi.hoisted(() => ({ denied: new Set<string>() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async readdir(...args: Parameters<typeof actual.readdir>) {
      if (fsHarness.denied.has(String(args[0]))) throw Object.assign(new Error('access denied'), { code: 'EACCES' })
      return await actual.readdir(...args)
    },
  }
})

const { scanRoot } = await import('../src/scan.ts')

const tempDirs: string[] = []
afterEach(async () => {
  fsHarness.denied.clear()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('scanRoot when a directory cannot be listed', () => {
  it('warns once for the denied directory and returns no candidates', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-skill-claude-denied-')))
    tempDirs.push(dir)
    fsHarness.denied.add(dir)
    const messages: string[] = []
    const warn: Warn = (_key, message) => { messages.push(message) }
    const root: SkillRoot = { kind: 'skills', dir, rank: 530, source: 'claude-user' }

    expect(await scanRoot(root, 'claude', warn)).toEqual([])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(dir)
    expect(messages[0]).toContain('access denied')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/skill/skill-claude/tests/scan.spec.ts packages/skill/skill-claude/tests/scan-errors.spec.ts`
Expected: FAIL, cannot resolve `../src/scan.ts`.

- [ ] **Step 3: Implement `scan.ts`**

```ts
/**
 * Scanning of one Claude skill or command root into registry candidates, and
 * loading of a candidate's body on demand.
 *
 * @module @deepseek-ai/dsh-skill-claude/scan
 */

import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { SkillCandidate, SkillDefinition } from '@deepseek-ai/dsh-skill'
import { isMissing } from './fs-error.ts'
import { describeCommand, invocationPolicy, parseClaudeDocument, textField } from './frontmatter.ts'
import { commandIdentifier, qualifiedIdentifier, toSkillName } from './names.ts'
import type { ClaudeLocator, SkillRoot, Warn } from './types.ts'

/** A file to read plus the identifier its path implies. */
interface SourceFile {
  readonly path: string
  readonly identifier: string
}

/**
 * Scan one root into candidates.
 * @param root - directory and layout to scan.
 * @param providerName - registry provider name every candidate must carry.
 * @param warn - warning sink for unreadable or invalid entries.
 * @returns candidates in directory order; invalid entries are skipped.
 */
export async function scanRoot(root: SkillRoot, providerName: string, warn: Warn): Promise<SkillCandidate[]> {
  const files = root.kind === 'skills'
    ? await skillFiles(root.dir, warn)
    : await commandFiles(root.dir, root.dir, warn)
  const candidates: SkillCandidate[] = []
  for (const file of files) {
    const candidate = await toCandidate(root, file, providerName, warn)
    if (candidate !== undefined) candidates.push(candidate)
  }
  return candidates
}

/**
 * Load a candidate's body.
 * @param candidate - candidate previously returned by {@link scanRoot}.
 * @param warn - warning sink for an unreadable file.
 * @returns the definition with the body after the frontmatter, or `undefined` when the file is gone.
 */
export async function loadDefinition(candidate: SkillCandidate, warn: Warn): Promise<SkillDefinition | undefined> {
  const locator = candidate.locator as ClaudeLocator
  const raw = await readSource(locator.path, warn)
  if (raw === undefined) return undefined
  return {
    name: candidate.name,
    description: candidate.description,
    ...candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse },
    invocation: candidate.invocation,
    source: candidate.source,
    provider: candidate.provider,
    path: locator.path,
    resourceBase: { kind: 'directory', path: dirname(locator.path) },
    content: parseClaudeDocument(raw).body.trim(),
  }
}

async function listDirectory(dir: string, warn: Warn): Promise<Dirent[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.sort((left, right) => left.name.localeCompare(right.name))
  } catch (error) {
    if (!isMissing(error)) warn(dir, `${dir} skipped: ${String(error)}`)
    return []
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    // A dangling symbolic link or a removed entry is not a skill directory.
    return false
  }
}

async function skillFiles(dir: string, warn: Warn): Promise<SourceFile[]> {
  const files: SourceFile[] = []
  for (const entry of await listDirectory(dir, warn)) {
    const directory = join(dir, entry.name)
    if (await isDirectory(directory)) files.push({ path: join(directory, 'SKILL.md'), identifier: entry.name })
  }
  return files
}

async function commandFiles(dir: string, root: string, warn: Warn): Promise<SourceFile[]> {
  const files: SourceFile[] = []
  for (const entry of await listDirectory(dir, warn)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await commandFiles(path, root, warn))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push({ path, identifier: commandIdentifier(relative(root, path)) })
    }
  }
  return files
}

async function readSource(path: string, warn: Warn): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (!isMissing(error)) warn(path, `${path} skipped: ${String(error)}`)
    return undefined
  }
}

async function toCandidate(
  root: SkillRoot,
  file: SourceFile,
  providerName: string,
  warn: Warn,
): Promise<SkillCandidate | undefined> {
  const raw = await readSource(file.path, warn)
  if (raw === undefined) return undefined
  const { data, body } = parseClaudeDocument(raw)
  const declared = root.kind === 'skills' ? textField(data, 'name') : undefined
  const identifier = qualifiedIdentifier(root.plugin, declared ?? file.identifier)
  const name = toSkillName(identifier)
  if (name === undefined) {
    warn(file.path, `${file.path} skipped: "${identifier}" has no letters or digits to form a skill name`)
    return undefined
  }
  const description = root.kind === 'skills' ? textField(data, 'description') : describeCommand(data, body)
  if (description === undefined) {
    warn(file.path, `${file.path} skipped: no description`)
    return undefined
  }
  const whenToUse = textField(data, 'when_to_use') ?? textField(data, 'whenToUse')
  const locator: ClaudeLocator = { path: file.path }
  return {
    name,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    invocation: invocationPolicy(data),
    source: root.source,
    provider: providerName,
    rank: root.rank,
    path: file.path,
    resourceBase: { kind: 'directory', path: dirname(file.path) },
    locator,
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run packages/skill/skill-claude/tests`
Expected: PASS for every spec so far.

- [ ] **Step 5: Commit**

```powershell
git add packages/skill/skill-claude/src/scan.ts packages/skill/skill-claude/tests/scan.spec.ts packages/skill/skill-claude/tests/scan-errors.spec.ts
git commit -m "feat: Scans Claude skill and command roots into registry candidates"
```

---

### Task 6: Change watching

**Files:**
- Create: `packages/skill/skill-claude/src/watch.ts`
- Test: `packages/skill/skill-claude/tests/watch.spec.ts`

**Interfaces:**
- Consumes: `Warn` (Task 2).
- Produces:
  ```ts
  export interface WatchTarget { readonly path: string; readonly shallow: boolean }
  export interface WatchOptions { readonly usePolling: boolean; readonly stabilityThresholdMs: number; readonly pollIntervalMs: number }
  export class RootWatcher {
    constructor(options: WatchOptions, onChange: () => void, warn: Warn)
    sync(targets: readonly WatchTarget[]): Promise<void>   // opens a watcher per existing, not-yet-watched target
    dispose(): Promise<void>                               // closes all; later sync() calls do nothing
  }
  ```

- [ ] **Step 1: Write the failing tests**

`packages/skill/skill-claude/tests/watch.spec.ts`:

```ts
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Warn } from '../src/types.ts'

interface FakeWatcher {
  readonly emitter: EventEmitter & { close(): Promise<void> }
  readonly path: string
  readonly options: Record<string, unknown>
  closeCalls: number
}

const harness = vi.hoisted(() => ({ watchers: [] as FakeWatcher[], closeFails: false }))

vi.mock('chokidar', () => ({
  default: {
    watch(path: unknown, options: Record<string, unknown>) {
      const emitter = new EventEmitter() as FakeWatcher['emitter']
      const control: FakeWatcher = { emitter, path: String(path), options, closeCalls: 0 }
      emitter.close = async () => {
        control.closeCalls += 1
        if (harness.closeFails) throw new Error('close failed')
      }
      harness.watchers.push(control)
      return emitter
    },
  },
}))

const { RootWatcher } = await import('../src/watch.ts')

const tempDirs: string[] = []
beforeEach(() => {
  harness.watchers.length = 0
  harness.closeFails = false
})
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-skill-claude-watch-')))
  tempDirs.push(dir)
  return dir
}

const options = { usePolling: true, stabilityThresholdMs: 123, pollIntervalMs: 45 }

function setup(): { watcher: InstanceType<typeof RootWatcher>; changes: { count: number }; warnings: string[] } {
  const changes = { count: 0 }
  const warnings: string[] = []
  const warn: Warn = (_key, message) => { warnings.push(message) }
  return { watcher: new RootWatcher(options, () => { changes.count += 1 }, warn), changes, warnings }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('RootWatcher', () => {
  it('opens one watcher per existing target with the configured options', async () => {
    const dir = await tempDir()
    const { watcher } = setup()

    await watcher.sync([{ path: dir, shallow: false }, { path: join(dir, 'absent'), shallow: false }, { path: dir, shallow: true }])

    expect(harness.watchers.map(entry => entry.path)).toEqual([dir, dir])
    expect(harness.watchers[0]?.options).toMatchObject({
      persistent: true,
      ignoreInitial: true,
      atomic: true,
      usePolling: true,
      interval: 45,
      awaitWriteFinish: { stabilityThreshold: 123, pollInterval: 45 },
    })
    expect(harness.watchers[0]?.options.depth).toBeUndefined()
    expect(harness.watchers[0]?.options.ignored).toBeInstanceOf(RegExp)
    expect(harness.watchers[1]?.options.depth).toBe(0)
    await watcher.dispose()
  })

  it('does not reopen a watched target and retries a target that appears later', async () => {
    const dir = await tempDir()
    const { watcher } = setup()
    const target = { path: join(dir, 'late'), shallow: false }

    await watcher.sync([target])
    expect(harness.watchers).toHaveLength(0)

    const { mkdir } = await import('node:fs/promises')
    await mkdir(target.path)
    await watcher.sync([target])
    await watcher.sync([target])
    expect(harness.watchers).toHaveLength(1)
    await watcher.dispose()
  })

  it('opens a single watcher when two syncs overlap', async () => {
    const dir = await tempDir()
    const { watcher } = setup()

    await Promise.all([watcher.sync([{ path: dir, shallow: false }]), watcher.sync([{ path: dir, shallow: false }])])

    expect(harness.watchers).toHaveLength(1)
    await watcher.dispose()
  })

  it('coalesces a burst of events into one change notification', async () => {
    const dir = await tempDir()
    const { watcher, changes } = setup()
    await watcher.sync([{ path: dir, shallow: false }])

    harness.watchers[0]?.emitter.emit('all', 'add', join(dir, 'a'))
    harness.watchers[0]?.emitter.emit('all', 'change', join(dir, 'a'))
    harness.watchers[0]?.emitter.emit('all', 'unlink', join(dir, 'b'))
    await settle()
    expect(changes.count).toBe(1)

    harness.watchers[0]?.emitter.emit('all', 'add', join(dir, 'c'))
    await settle()
    expect(changes.count).toBe(2)
    await watcher.dispose()
  })

  it('reports watcher errors through the warning sink', async () => {
    const dir = await tempDir()
    const { watcher, warnings } = setup()
    await watcher.sync([{ path: dir, shallow: false }])

    harness.watchers[0]?.emitter.emit('error', new Error('native watch failed'))

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('native watch failed')
    await watcher.dispose()
  })

  it('closes every watcher on dispose, ignores later events and syncs, and is idempotent', async () => {
    const dir = await tempDir()
    const { watcher, changes } = setup()
    await watcher.sync([{ path: dir, shallow: false }])
    const emitter = harness.watchers[0]?.emitter

    await watcher.dispose()
    await watcher.dispose()
    emitter?.emit('all', 'add', join(dir, 'a'))
    await settle()
    await watcher.sync([{ path: dir, shallow: true }])

    expect(harness.watchers[0]?.closeCalls).toBe(1)
    expect(harness.watchers).toHaveLength(1)
    expect(changes.count).toBe(0)
  })

  it('does not notify for an event queued before dispose', async () => {
    const dir = await tempDir()
    const { watcher, changes } = setup()
    await watcher.sync([{ path: dir, shallow: false }])

    harness.watchers[0]?.emitter.emit('all', 'add', join(dir, 'a'))
    await watcher.dispose()
    await settle()

    expect(changes.count).toBe(0)
  })

  it('warns when a watcher fails to close', async () => {
    const dir = await tempDir()
    const { watcher, warnings } = setup()
    await watcher.sync([{ path: dir, shallow: false }])
    harness.closeFails = true

    await watcher.dispose()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('close failed')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/skill/skill-claude/tests/watch.spec.ts`
Expected: FAIL, cannot resolve `../src/watch.ts`.

- [ ] **Step 3: Implement `watch.ts`**

```ts
/**
 * Change detection for Claude skill roots. Deep targets are watched
 * recursively for skill and command edits; shallow targets are watched one
 * level deep so a newly created root or configuration file is noticed.
 *
 * @module @deepseek-ai/dsh-skill-claude/watch
 */

import { access } from 'node:fs/promises'
import chokidar, { type FSWatcher } from 'chokidar'
import type { Warn } from './types.ts'

/** Dependency folders hold no skills and can contain very large trees. */
const IGNORED_DEPENDENCIES = /(^|[\\/])node_modules([\\/]|$)/

/** One path to watch. */
export interface WatchTarget {
  /** Absolute path of an existing directory. */
  readonly path: string
  /** Whether only the directory's direct children are watched. */
  readonly shallow: boolean
}

/** Chokidar behavior shared by every watcher of one provider. */
export interface WatchOptions {
  /** Whether polling replaces native filesystem events. */
  readonly usePolling: boolean
  /** Milliseconds a changed file must stay unchanged before its event fires. */
  readonly stabilityThresholdMs: number
  /** Milliseconds between stability and polling probes. */
  readonly pollIntervalMs: number
}

/** Owns the chokidar watchers of one provider and turns their events into change notifications. */
export class RootWatcher {
  private readonly options: WatchOptions
  private readonly onChange: () => void
  private readonly warn: Warn
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly reserved = new Set<string>()
  private pending = false
  private disposed = false

  /**
   * @param options - chokidar behavior.
   * @param onChange - called once per event-loop turn that saw any event.
   * @param warn - warning sink for watcher failures.
   */
  constructor(options: WatchOptions, onChange: () => void, warn: Warn) {
    this.options = options
    this.onChange = onChange
    this.warn = warn
  }

  /**
   * Open a watcher for every existing target that is not already watched.
   * Targets that do not exist yet are retried on the next call.
   * @param targets - paths the provider currently scans or depends on.
   */
  async sync(targets: readonly WatchTarget[]): Promise<void> {
    for (const target of targets) {
      if (this.disposed) return
      const key = `${target.shallow ? 'shallow' : 'deep'}:${target.path}`
      if (this.watchers.has(key) || this.reserved.has(key)) continue
      this.reserved.add(key)
      try {
        if (await pathExists(target.path) && !this.disposed) this.watchers.set(key, this.open(key, target))
      } finally {
        this.reserved.delete(key)
      }
    }
  }

  /** Close every watcher and ignore all later events and syncs. */
  async dispose(): Promise<void> {
    this.disposed = true
    const open = [...this.watchers.entries()]
    this.watchers.clear()
    await Promise.all(open.map(async ([key, watcher]) => {
      try {
        await watcher.close()
      } catch (error) {
        this.warn(key, `closing the watcher for ${key} failed: ${String(error)}`)
      }
    }))
  }

  private open(key: string, target: WatchTarget): FSWatcher {
    const watcher = chokidar.watch(target.path, {
      persistent: true,
      ignoreInitial: true,
      ...target.shallow ? { depth: 0 } : {},
      ignored: IGNORED_DEPENDENCIES,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: this.options.stabilityThresholdMs,
        pollInterval: this.options.pollIntervalMs,
      },
      usePolling: this.options.usePolling,
      interval: this.options.pollIntervalMs,
    })
    watcher.on('all', () => { this.schedule() })
    watcher.on('error', (error) => { this.warn(key, `watcher for ${target.path} failed: ${String(error)}`) })
    return watcher
  }

  private schedule(): void {
    if (this.pending || this.disposed) return
    this.pending = true
    queueMicrotask(() => {
      this.pending = false
      if (!this.disposed) this.onChange()
    })
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // A target that does not exist yet is retried on the next sync.
    return false
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run packages/skill/skill-claude/tests/watch.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/skill/skill-claude/src/watch.ts packages/skill/skill-claude/tests/watch.spec.ts
git commit -m "feat: Watches Claude skill roots and configuration for changes"
```

---

### Task 7: The provider plugin

**Files:**
- Create: `packages/skill/skill-claude/src/index.ts`
- Test: `packages/skill/skill-claude/tests/skill-claude.spec.ts`, `packages/skill/skill-claude/tests/skill-claude-watch.spec.ts`

**Interfaces:**
- Consumes: Tasks 2–6 modules; `SkillProvider`, `SkillProviderControl`, `SkillLookupOptions`, `SkillCandidate`, `SkillDefinition` from `@deepseek-ai/dsh-skill`.
- Produces: the plugin entry — `name = 'skill-claude'`, `inject = ['skills']`, `interface Config`, `const Config: Schema<Config>`, `apply(ctx, config?)`, and `class ClaudeSkillProvider implements SkillProvider` with `constructor(config: Config, control: SkillProviderControl, log: (message: string) => void)`, `list(options)`, `get(candidate)`, `dispose()`.

- [ ] **Step 1: Write the failing registry-integration tests**

`packages/skill/skill-claude/tests/skill-claude.spec.ts`:

```ts
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import * as SkillClaude from '../src/index.ts'

const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-skill-claude-${name}-`))
  tempDirs.push(dir)
  return await realpath(dir)
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

async function writeSkill(root: string, name: string, description: string, body = 'Skill body.'): Promise<void> {
  await writeText(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

async function setup(
  config: Partial<SkillClaude.Config>,
  filesystem?: Partial<SkillFileSystem.Config>,
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  if (filesystem !== undefined) await ctx.plugin(SkillFileSystem, { watch: false, ...filesystem })
  await ctx.plugin(SkillClaude, { watch: false, ...config })
  return ctx
}

describe('dsh-skill-claude plugin exports', () => {
  it('declares stable plugin metadata', () => {
    expect(SkillClaude.name).toBe('skill-claude')
    expect(SkillClaude.inject).toEqual(['skills'])
  })
})

describe('ClaudeSkillProvider', () => {
  it('registers user skills, command files, and enabled plugin skills as DSH skills', async () => {
    const home = await tempDir('home')
    await writeSkill(join(home, 'skills'), 'grill-me', 'A relentless interview.')
    await writeText(join(home, 'commands', 'modes', 'sparc.md'), '# Boomerang Commander\n\nOrchestrate phases.\n')
    const plugin = join(home, 'plugins', 'cache', 'superpowers')
    await writeSkill(join(plugin, 'skills'), 'brainstorming', 'Explore intent first.')
    await writeText(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'superpowers@claude-plugins-official': [{ scope: 'user', installPath: plugin }] },
    }))
    await writeText(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@claude-plugins-official': true } }))
    const ctx = await setup({ claudeHome: home })

    const skills = await ctx.skills.list()

    expect(skills.map(skill => skill.name)).toEqual(['grill-me', 'modes-sparc', 'superpowers-brainstorming'])
    expect(skills.map(skill => skill.provider)).toEqual(['claude', 'claude', 'claude'])
    const sparc = await ctx.skills.get('modes-sparc')
    expect(sparc?.content).toBe('# Boomerang Commander\n\nOrchestrate phases.')
    expect(sparc?.resourceBase).toEqual({ kind: 'directory', path: join(home, 'commands', 'modes') })
    expect((await ctx.skills.get('superpowers-brainstorming'))?.content).toBe('Skill body.')
  })

  it('uses a custom provider name', async () => {
    const home = await tempDir('home-name')
    await writeSkill(join(home, 'skills'), 'one', 'd')
    const ctx = await setup({ claudeHome: home, providerName: 'cc' })

    expect((await ctx.skills.list()).map(skill => skill.provider)).toEqual(['cc'])
  })

  it('scans the project .claude directory only when includeProject is on and a cwd is given', async () => {
    const home = await tempDir('home-project')
    const project = await tempDir('project')
    await mkdir(join(project, '.git'), { recursive: true })
    await writeSkill(join(project, '.claude', 'skills'), 'project-only', 'd')
    const withProject = await setup({ claudeHome: home })
    const withoutProject = await setup({ claudeHome: home, includeProject: false })

    expect((await withProject.skills.list({ cwd: join(project, 'src') })).map(skill => skill.name)).toEqual(['project-only'])
    expect(await withProject.skills.list()).toEqual([])
    expect(await withoutProject.skills.list({ cwd: join(project, 'src') })).toEqual([])
  })

  it('skips plugins when includePlugins is off', async () => {
    const home = await tempDir('home-noplugins')
    const plugin = join(home, 'cache', 'p')
    await writeSkill(join(plugin, 'skills'), 'x', 'd')
    await writeText(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ scope: 'user', installPath: plugin }] } }))
    await writeText(join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'p@m': true } }))
    const ctx = await setup({ claudeHome: home, includePlugins: false })

    expect(await ctx.skills.list()).toEqual([])
  })

  it('lets a workspace skill override a global skill and ranks the six sources', async () => {
    const claudeHome = await tempDir('prec-claude-home')
    const dshHome = await tempDir('prec-dsh-home')
    const agentsHome = await tempDir('prec-agents-home')
    const project = await tempDir('prec-project')
    await mkdir(join(project, '.git'), { recursive: true })

    await writeSkill(join(project, '.agents', 'skills'), 'dsh-ws-over-claude-ws', 'dsh workspace')
    await writeSkill(join(project, '.claude', 'skills'), 'dsh-ws-over-claude-ws', 'claude workspace')

    await writeSkill(join(project, '.claude', 'skills'), 'claude-ws-over-dsh-global', 'claude workspace')
    await writeSkill(join(agentsHome, 'skills'), 'claude-ws-over-dsh-global', 'dsh global')

    await writeSkill(join(project, '.claude', 'skills'), 'claude-ws-over-claude-global', 'claude workspace')
    await writeSkill(join(claudeHome, 'skills'), 'claude-ws-over-claude-global', 'claude global')

    await writeSkill(join(agentsHome, 'skills'), 'dsh-global-over-claude-global', 'dsh global')
    await writeSkill(join(claudeHome, 'skills'), 'dsh-global-over-claude-global', 'claude global')

    await writeText(join(project, '.claude', 'commands', 'command-ws-over-skill-global.md'), 'claude workspace command\n')
    await writeSkill(join(claudeHome, 'skills'), 'command-ws-over-skill-global', 'claude global skill')

    await writeSkill(join(project, '.claude', 'skills'), 'skill-over-command-same-tier', 'project skill')
    await writeText(join(project, '.claude', 'commands', 'skill-over-command-same-tier.md'), 'project command\n')

    const ctx = await setup({ claudeHome }, { dshHome, agentsHome })

    const skills = await ctx.skills.list({ cwd: join(project, 'src') })
    const description = (name: string): string | undefined => skills.find(skill => skill.name === name)?.description
    expect(description('dsh-ws-over-claude-ws')).toBe('dsh workspace')
    expect(description('claude-ws-over-dsh-global')).toBe('claude workspace')
    expect(description('claude-ws-over-claude-global')).toBe('claude workspace')
    expect(description('dsh-global-over-claude-global')).toBe('dsh global')
    expect(description('command-ws-over-skill-global')).toBe('claude workspace command')
    expect(description('skill-over-command-same-tier')).toBe('project skill')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/skill/skill-claude/tests/skill-claude.spec.ts`
Expected: FAIL, cannot resolve `../src/index.ts`.

- [ ] **Step 3: Implement `index.ts`**

```ts
/**
 * Claude Code skills, command files, and enabled-plugin skills as DSH skills.
 * The provider reads Claude's files directly and registers them with the skill
 * registry; no Claude process runs.
 *
 * @module @deepseek-ai/dsh-skill-claude
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
} from '@deepseek-ai/dsh-skill'
import { loadDefinition, scanRoot } from './scan.ts'
import { findProjectRoot, resolveClaudeHome, resolveSources } from './sources.ts'
import type { Warn } from './types.ts'
import { RootWatcher, type WatchTarget } from './watch.ts'

export const name = 'skill-claude'
export const inject = ['skills']

const DEFAULT_PROVIDER_NAME = 'claude'
const DEFAULT_WATCH_STABILITY_THRESHOLD_MS = 200
const DEFAULT_WATCH_POLL_INTERVAL_MS = 100

/** Claude skill provider configuration. */
export interface Config {
  /** Unique provider name. Defaults to `claude`. */
  providerName?: string
  /** Claude configuration root. Defaults to `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claudeHome?: string
  /** Whether the project's `.claude/skills` and `.claude/commands` are scanned. */
  includeProject?: boolean
  /** Whether skills and commands of enabled user-scope plugins are scanned. */
  includePlugins?: boolean
  /** Whether scanned roots and configuration files are watched for catalog changes. */
  watch?: boolean
  /** Whether Chokidar uses polling instead of native filesystem events. */
  watchUsePolling?: boolean
  /** Milliseconds a changed file must remain stable before it is observed. */
  watchStabilityThresholdMs?: number
  /** Milliseconds between Chokidar stability or polling probes. */
  watchPollIntervalMs?: number
}

export const Config: Schema<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  claudeHome: z.string(),
  includeProject: z.boolean().default(true),
  includePlugins: z.boolean().default(true),
  watch: z.boolean().default(true),
  watchUsePolling: z.boolean().default(false),
  watchStabilityThresholdMs: z.number().default(DEFAULT_WATCH_STABILITY_THRESHOLD_MS),
  watchPollIntervalMs: z.number().default(DEFAULT_WATCH_POLL_INTERVAL_MS),
})

/** Register the Claude skill provider on `ctx.skills`. */
export function apply(ctx: Context, config: Config = {}): void {
  let provider!: ClaudeSkillProvider
  ctx.skills.registerProvider((control) => {
    provider = new ClaudeSkillProvider(config, control, (message) => { ctx.logger.warn(message) })
    return provider
  })
  ctx.effect(function* () {
    yield async () => { await provider.dispose() }
  }, 'skill-claude watcher')
}

/** Provider that maps Claude skill and command files into `ctx.skills`. */
export class ClaudeSkillProvider implements SkillProvider {
  readonly name: string
  private readonly claudeHome: string
  private readonly includeProject: boolean
  private readonly includePlugins: boolean
  private readonly warned = new Set<string>()
  private readonly warn: Warn
  private readonly watcher: RootWatcher | undefined

  /**
   * @param config - provider configuration; omitted fields use the documented defaults.
   * @param control - registration control; `invalidate()` runs when a watched path changes.
   * @param log - sink for provider warnings.
   */
  constructor(config: Config, control: SkillProviderControl, log: (message: string) => void) {
    this.name = config.providerName ?? DEFAULT_PROVIDER_NAME
    this.claudeHome = resolveClaudeHome(config.claudeHome)
    this.includeProject = config.includeProject ?? true
    this.includePlugins = config.includePlugins ?? true
    this.warn = (key, message) => {
      const id = `${key}\u0000${message}`
      if (this.warned.has(id)) return
      this.warned.add(id)
      log(`skill-claude: ${message}`)
    }
    this.watcher = (config.watch ?? true)
      ? new RootWatcher({
        usePolling: config.watchUsePolling ?? false,
        stabilityThresholdMs: config.watchStabilityThresholdMs ?? DEFAULT_WATCH_STABILITY_THRESHOLD_MS,
        pollIntervalMs: config.watchPollIntervalMs ?? DEFAULT_WATCH_POLL_INTERVAL_MS,
      }, () => { control.invalidate() }, this.warn)
      : undefined
  }

  /**
   * List every Claude skill and command visible from a working directory.
   * @param options - lookup options; `cwd` selects the project, `signal` cancels work.
   * @returns candidates from the project, user, and plugin roots.
   */
  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    const projectRoot = this.includeProject && options.cwd !== undefined
      ? await findProjectRoot(options.cwd)
      : undefined
    const sources = await resolveSources({
      claudeHome: this.claudeHome,
      projectRoot,
      includePlugins: this.includePlugins,
      warn: this.warn,
    })
    const targets: WatchTarget[] = [
      ...sources.roots.map(root => ({ path: root.dir, shallow: false })),
      ...sources.shallowDirs.map(path => ({ path, shallow: true })),
    ]
    await this.watcher?.sync(targets)
    options.signal?.throwIfAborted()
    const scanned = await Promise.all(sources.roots.map(root => scanRoot(root, this.name, this.warn)))
    return scanned.flat()
  }

  /**
   * Load a candidate's body.
   * @param candidate - candidate returned by {@link ClaudeSkillProvider.list}.
   * @returns the definition, or `undefined` when the file no longer exists.
   */
  async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
    return await loadDefinition(candidate, this.warn)
  }

  /** Close every watcher. */
  async dispose(): Promise<void> {
    await this.watcher?.dispose()
  }
}
```

- [ ] **Step 4: Run to verify the integration tests pass**

Run: `pnpm exec vitest run packages/skill/skill-claude/tests/skill-claude.spec.ts`
Expected: PASS. If `ctx.skills.list()` ordering differs, the registry sorts by name — the expectations above are already sorted.

- [ ] **Step 5: Write the watcher-wiring tests**

`packages/skill/skill-claude/tests/skill-claude-watch.spec.ts`:

```ts
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'

interface FakeWatcher {
  readonly emitter: EventEmitter & { close(): Promise<void> }
  readonly path: string
  readonly options: Record<string, unknown>
  closeCalls: number
}

const harness = vi.hoisted(() => ({ watchers: [] as FakeWatcher[] }))

vi.mock('chokidar', () => ({
  default: {
    watch(path: unknown, options: Record<string, unknown>) {
      const emitter = new EventEmitter() as FakeWatcher['emitter']
      const control: FakeWatcher = { emitter, path: String(path), options, closeCalls: 0 }
      emitter.close = async () => { control.closeCalls += 1 }
      harness.watchers.push(control)
      return emitter
    },
  },
}))

const SkillClaude = await import('../src/index.ts')

const tempDirs: string[] = []
beforeEach(() => { harness.watchers.length = 0 })
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-skill-claude-wire-')))
  tempDirs.push(dir)
  return dir
}

async function writeSkill(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nBody\n`)
}

describe('skill-claude change watching', () => {
  it('watches existing roots deeply and configuration directories shallowly with default options', async () => {
    const home = await tempDir()
    await writeSkill(join(home, 'skills'), 'one')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillClaude, { claudeHome: home })

    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['one'])

    const byPath = new Map(harness.watchers.map(entry => [entry.path, entry]))
    expect(byPath.get(join(home, 'skills'))?.options.depth).toBeUndefined()
    expect(byPath.get(home)?.options.depth).toBe(0)
    expect(byPath.get(home)?.options).toMatchObject({
      usePolling: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    })
    await fiber.dispose()
  })

  it('honors explicit watch options', async () => {
    const home = await tempDir()
    await writeSkill(join(home, 'skills'), 'one')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillClaude, {
      claudeHome: home,
      watchUsePolling: true,
      watchStabilityThresholdMs: 7,
      watchPollIntervalMs: 9,
    })

    await ctx.skills.list()

    expect(harness.watchers[0]?.options).toMatchObject({ usePolling: true, awaitWriteFinish: { stabilityThreshold: 7, pollInterval: 9 } })
    await fiber.dispose()
  })

  it('refreshes the catalog and notifies observers when a watched path changes', async () => {
    const home = await tempDir()
    await writeSkill(join(home, 'skills'), 'one')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillClaude, { claudeHome: home })
    let changes = 0
    ctx.on('skills/change', () => { changes += 1 })
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['one'])

    await writeSkill(join(home, 'skills'), 'two')
    harness.watchers.find(entry => entry.path === join(home, 'skills'))?.emitter.emit('all', 'addDir', join(home, 'skills', 'two'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(changes).toBeGreaterThan(0)
    expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['one', 'two'])
    await fiber.dispose()
  })

  it('closes its watchers when the plugin is disposed', async () => {
    const home = await tempDir()
    await writeSkill(join(home, 'skills'), 'one')
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillClaude, { claudeHome: home })
    await ctx.skills.list()

    await fiber.dispose()

    expect(harness.watchers.length).toBeGreaterThan(0)
    expect(harness.watchers.every(entry => entry.closeCalls === 1)).toBe(true)
  })

  it('forwards provider warnings to the context logger', async () => {
    const home = await tempDir()
    await mkdir(join(home, 'settings.json'), { recursive: true })
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const fiber = await ctx.plugin(SkillClaude, { claudeHome: home })

    await ctx.skills.list()
    await ctx.skills.list()

    expect(warnings.filter(message => message.startsWith('skill-claude: ') && message.includes('settings.json'))).toHaveLength(1)
    await fiber.dispose()
  })
})
```

Note: `dirname` is imported but unused in this file; remove that import when writing the file if lint flags it (the snippet above does not call `dirname`).

- [ ] **Step 6: Run both specs and check package coverage**

Run: `pnpm exec vitest run packages/skill/skill-claude --coverage --coverage.include="packages/skill/skill-claude/src/**"`
Expected: PASS; every file under `src/` reports 100% statements, branches, functions, lines. Any uncovered branch means a missing test, not an ignore comment: add the test.

- [ ] **Step 7: Commit**

```powershell
git add packages/skill/skill-claude/src/index.ts packages/skill/skill-claude/tests/skill-claude.spec.ts packages/skill/skill-claude/tests/skill-claude-watch.spec.ts
git commit -m "feat: Registers Claude skills as DSH skills through a provider plugin"
```

---

### Task 8: Wire into presets, remove the subprocess path, isolate test environments

**Files:**
- Modify: `packages/preset/agent-presets/presets/standard/agent.cordis.yml` (rows near line 84)
- Modify: `packages/preset/agent-presets/presets/ptc/agent.cordis.yml` (rows near line 91)
- Modify: `packages/preset/agent-presets/presets/cordis/agent.cordis.yml` (rows near line 270)
- Modify: `packages/bundle/base/cordis.patch.yml` (delete the `claude-skill-commands` row at lines 123–125)
- Modify: `packages/bundle/base/package.json` (swap one dependency line)
- Modify: `apps/cli/package.json` (add one dependency near line 72), plus any manifest `verify-cordis-config` names
- Modify: `tsconfig.base.json` (remove two `claude-skill-commands` paths), `tsconfig.host.json` (remove one reference)
- Delete: `packages/interaction/claude-skill-commands/` (tracked files via `git rm -r`)
- Delete: `packages/subagent/subagent-claude-code/src/list-commands.ts`, `tests/list-commands.spec.ts`, `tests/real-command-listing.spec.ts`
- Modify: `packages/subagent/subagent-claude-code/src/index.ts` (remove the re-export block at lines 31–38)
- Modify stale references: `packages/core/agent/src/model-selection.ts:68`, `packages/interaction/commands/src/types.ts:56-64` and `src/index.ts:33`, `packages/client/ui-commands/src/client/service.ts:233`, `packages/session/claude-session-import/src/index.ts:366`
- Modify (isolation): `packages/test-support/session-snapshot/src/harness.ts:274`, `packages/test-support/session-snapshot/src/launcher.ts:132`, `packages/test-support/loader-smoke/src/index.ts:226`, `snapshots/session/headless.snapshot.ts:667`, `snapshots/sdk/sdk.snapshot.ts:575`, `apps/web/tests/scaffold.ts:507`, and every `*.e2e.ts` listed by the grep in Step 9

**Interfaces:**
- Consumes: the plugin from Task 7 by its package name `@deepseek-ai/dsh-skill-claude`.

- [ ] **Step 1: Add the `skill-claude` row to the three presets**

In each preset file, read the `skill-filesystem` row first, then insert the new row directly after it (before `tool-skill`).

`standard/agent.cordis.yml` and `ptc/agent.cordis.yml` — replace

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'

- id: tool-skill
```

with

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'

- id: skill-claude
  name: '@deepseek-ai/dsh-skill-claude'

- id: tool-skill
```

`cordis/agent.cordis.yml` — insert after the `skill-filesystem` row's `config:` block (the line `      - !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"`):

```yaml

- id: skill-claude
  name: '@deepseek-ai/dsh-skill-claude'
```

Also add one sentence to the comment block above each `skill-filesystem` row in `standard` and `ptc`: `# \`skill-claude\` adds Claude Code skills, command files, and enabled plugins in the same layer, so rank order decides duplicates across both providers.`

- [ ] **Step 2: Remove the base-bundle row and swap the dependency**

In `packages/bundle/base/cordis.patch.yml`, delete exactly these lines (and the blank line after them):

```yaml
    - id: claude-skill-commands
      name: '@deepseek-ai/dsh-claude-skill-commands'

```

In `packages/bundle/base/package.json`, delete the line `"@deepseek-ai/dsh-claude-skill-commands": "workspace:^",` and add, immediately before the `"@deepseek-ai/dsh-skill-filesystem": "workspace:^",` line, `"@deepseek-ai/dsh-skill-claude": "workspace:^",`.

In `apps/cli/package.json`, add `"@deepseek-ai/dsh-skill-claude": "workspace:^",` immediately before its `"@deepseek-ai/dsh-skill-filesystem": "workspace:^",` line.

- [ ] **Step 3: Delete the old package and its path entries**

```powershell
git rm -r packages/interaction/claude-skill-commands
```

In `tsconfig.base.json` delete the two lines for `@deepseek-ai/dsh-claude-skill-commands` and `@deepseek-ai/dsh-claude-skill-commands/invariant`. In `tsconfig.host.json` delete `{ "path": "./packages/interaction/claude-skill-commands" },`.

Then remove leftover untracked build output of the deleted package and refresh links:

```powershell
if (Test-Path packages\interaction\claude-skill-commands) { Remove-Item -Recurse -Force packages\interaction\claude-skill-commands }
pnpm install
```

Expected: install succeeds; `pnpm-lock.yaml` loses the `claude-skill-commands` importer.

- [ ] **Step 4: Remove the subprocess exports**

First prove nothing else uses them:

```powershell
git grep -n "listClaudeCodeCommands\|runClaudeCodeSlashCommand" -- ':!docs/superpowers' ':!.agents/notes' ':!docs/persistence-changes'
```

Expected: hits only in `packages/subagent/subagent-claude-code/src/list-commands.ts`, `src/index.ts`, `tests/list-commands.spec.ts`, `tests/real-command-listing.spec.ts`. If any other file appears, stop and report it.

Then delete the four and edit the barrel:

```powershell
git rm packages/subagent/subagent-claude-code/src/list-commands.ts packages/subagent/subagent-claude-code/tests/list-commands.spec.ts packages/subagent/subagent-claude-code/tests/real-command-listing.spec.ts
```

In `packages/subagent/subagent-claude-code/src/index.ts`, delete the comment block beginning `// Re-exported for \`dsh-claude-skill-commands\`` (lines 31–37) and the line `export { listClaudeCodeCommands, runClaudeCodeSlashCommand } from './list-commands.ts'`.

Check which `run.ts` exports became unused:

```powershell
git grep -n "claudeQueryOptions\|disposeClaudeCodeChild" -- packages/subagent/subagent-claude-code
```

If `claudeQueryOptions` or `disposeClaudeCodeChild` are referenced only inside `run.ts` and its own tests, remove the `export` keyword from those definitions (keep them if `run.ts` tests import them).

- [ ] **Step 5: Update stale references**

- `packages/interaction/commands/src/types.ts` — replace the `CommandOrigin` JSDoc (lines 56–63) with:

```ts
/**
 * Provenance tag an owning plugin may attach to a registration so UI rows and
 * dispatch logic can tell a command imported from an external agent tool
 * apart from a command DSH itself defines. `'claude-code'` marks a command
 * derived from a Claude Code skill or command file. No current plugin
 * registers such commands (Claude files are served as skills by
 * `@deepseek-ai/dsh-skill-claude`); the value stays so saved sessions that
 * carry it still parse.
 */
```

- `packages/interaction/commands/src/index.ts:33` — read the surrounding comment; it names `@deepseek-ai/dsh-claude-skill-commands` as a consumer of the exported `COMMAND_NAME`. If no other package imports that export, reword the comment to drop the example; if the export has no remaining consumer, keep it exported (public API) and say only what it is.
- `packages/core/agent/src/model-selection.ts:68`, `packages/client/ui-commands/src/client/service.ts:233`, `packages/session/claude-session-import/src/index.ts:366` — reword each comment so it no longer names `claude-skill-commands` (state the rule it documents without the removed package).

Verify no references remain:

```powershell
git grep -n "claude-skill-commands\|claudeSkillCommands" -- ':!docs/superpowers' ':!.agents/notes' ':!docs/persistence-changes' ':!pnpm-lock.yaml'
```

Expected: no output.

- [ ] **Step 6: Satisfy `verify-cordis-config`**

Run: `pnpm run verify-cordis-config`
Expected: it reports any manifest whose `dependencies` lack `@deepseek-ai/dsh-skill-claude` while a preset or bundle row references it. Add `"@deepseek-ai/dsh-skill-claude": "workspace:^",` to exactly the manifests it names (likely also `python/sdk-runtime/package.json`, next to its `dsh-skill-filesystem` line), run `pnpm install`, rerun until it prints no error.

- [ ] **Step 7: Typecheck the touched surfaces**

Run: `pnpm run typecheck`
Expected: no errors. A leftover import of a deleted export is the likely failure; fix it at the import site.

- [ ] **Step 8: Run the touched packages' tests**

Run: `pnpm exec vitest run packages/skill packages/subagent/subagent-claude-code packages/interaction/commands packages/preset/agent-presets packages/bundle`
Expected: PASS. A failing preset or bundle test that enumerates plugin rows must be updated to include `skill-claude` (and drop `claude-skill-commands`) — that is the intended behavior change.

- [ ] **Step 9: Isolate every harness from the machine's real `~/.claude`**

For each central site, add `CLAUDE_CONFIG_DIR` beside the existing home pins.

`packages/test-support/session-snapshot/src/harness.ts`, `src/launcher.ts`, and `packages/test-support/loader-smoke/src/index.ts` — after the line `DSH_AGENTS_HOME: join(cwd, '.agents'),` add:

```ts
      CLAUDE_CONFIG_DIR: join(cwd, '.claude-home'),
```

(match the file's indentation). `snapshots/session/headless.snapshot.ts` (the env object at about line 667): after `DSH_HOME: join(cwd, '.dsh'),` add `CLAUDE_CONFIG_DIR: join(cwd, '.claude-home'),`. `snapshots/sdk/sdk.snapshot.ts:575` and `apps/web/tests/scaffold.ts:507`: after the `DSH_AGENTS_HOME:` line add `CLAUDE_CONFIG_DIR:` with a sibling directory built the same way (`join(<same base>, '.claude-home')`).

Then enumerate the remaining sites and apply the same one-line addition to each:

```powershell
git grep -n "DSH_AGENTS_HOME:" -- "*.ts" ':!packages/test-support' ':!snapshots' ':!benchmarks'
```

Each hit gets a sibling `CLAUDE_CONFIG_DIR: join(<same root expression>, '.claude-home'),`. Where a file builds the env with `process.env.DSH_AGENTS_HOME = …` (for example `apps/web/tests/scaffold-hermetic.e2e.ts`), add the matching `CLAUDE_CONFIG_DIR` assignment and restore it where `DSH_AGENTS_HOME` is restored.

Verify counts agree:

```powershell
(git grep -c "DSH_AGENTS_HOME" -- "*.ts" ':!benchmarks' ':!packages/skill').Count
(git grep -c "CLAUDE_CONFIG_DIR" -- "*.ts" ':!packages/skill').Count
```

The second list must cover every file in the first (compare the file names, not only the counts).

- [ ] **Step 10: Commit**

```powershell
git add -A packages/preset packages/bundle packages/subagent packages/interaction packages/core packages/client packages/session packages/test-support snapshots apps tsconfig.base.json tsconfig.host.json pnpm-lock.yaml python
git status --short
git commit -m "feat: Mounts Claude skills in the presets and removes the subprocess command path"
```

Before committing, read `git status --short`: it must list only files this task touched, and none of the repository's untracked logs, screenshots, or `.debug-*` files.

---

### Task 9: Keyless snapshot scenario for a Claude skill

**Files:**
- Create: `snapshots/session/claude-skill-load/` (copied from `snapshots/session/skill-load/`, then edited)

**Interfaces:**
- Consumes: the snapshot harness (`packages/test-support/session-snapshot`) with the isolation from Task 8, and the provider via the `standard`/headless composition.

- [ ] **Step 1: Confirm existing snapshots are unaffected by the new provider**

Run: `pnpm run test:snapshot`
Expected: PASS with no recorded-output change. A diff that adds Claude skills to a catalog means a harness still reads the real `~/.claude`: return to Task 8 Step 9 and find the missing `CLAUDE_CONFIG_DIR`.

- [ ] **Step 2: Copy the scenario**

```powershell
Copy-Item -Recurse snapshots\session\skill-load snapshots\session\claude-skill-load
Remove-Item snapshots\session\claude-skill-load\session.v2.jsonl
Remove-Item -Recurse snapshots\session\claude-skill-load\workspace\.dsh
```

(`session.v3.jsonl` is the highest generation; replay selects it. `workspace\.dsh` here is the copy's own seed directory inside the new scenario, not a project dot-folder.)

- [ ] **Step 3: Seed Claude skills in the scenario workspace**

Create `snapshots/session/claude-skill-load/workspace/.claude/skills/claude-snapshot-skill/SKILL.md`:

```markdown
---
name: claude-snapshot-skill
description: Exercise Claude project skill discovery and loading in snapshot tests.
---

Follow these Claude snapshot instructions.
Resolve referenced resources relative to this skill directory.
```

Create `snapshots/session/claude-skill-load/workspace/.claude/skills/claude-user-only-skill/SKILL.md`:

```markdown
---
name: claude-user-only-skill
description: Prove model-disabled Claude skills stay outside the model catalog.
disable-model-invocation: true
---

Follow these Claude user-only snapshot instructions.
```

- [ ] **Step 4: Point the manifest at the new scenario**

In `snapshots/session/claude-skill-load/snapshot.yml` change `scenario: skill-load` to `scenario: claude-skill-load` and delete the `workspace:` block (`setup: editing-cordis-skill`). The scenario's task asks for a project skill, not the editing-cordis one.

- [ ] **Step 5: Run the replay and reconcile the authored session**

Run: `pnpm run test:snapshot -t claude-skill-load`
Expected on the first run: FAIL with a diff between the replayed output and `session.v3.jsonl`. Edit `session.v3.jsonl` line by line until the diff is empty, changing only what the new skill changes:

- the first `agent/inbox/spliced` and `user/message` prompt text: `Load the claude-snapshot-skill skill with the skill tool, then reply DONE.`
- the `skill-catalog` `user/message` line: the `<available_skills>` entries now list `claude-snapshot-skill` with its description, and omit `claude-user-only-skill` (model-disabled)
- the `tool/call` arguments: `{"name":"claude-snapshot-skill"}`, and the `assistant/message` tool-call id and text that mirror it
- the `tool/result` body: the `<skill_content name="claude-snapshot-skill">` wrapper, `Base directory for this skill:` pointing at `{{cwd}}/.claude/skills/claude-snapshot-skill` in whatever token form the neighboring committed lines use, and the instructions text from Step 3
- `session/title`: derived title for the new prompt

Fix fixtures, never normalizers. Rerun until PASS.

- [ ] **Step 6: Commit**

```powershell
git add snapshots/session/claude-skill-load
git commit -m "feat: Adds a keyless snapshot for loading a Claude project skill"
```

---

### Task 10: Documentation, generated catalogs, and gates

**Files:**
- Create: `packages/skill/skill-claude/README.md`, `packages/skill/skill-claude/README.zh.md`, `packages/skill/skill-claude/README.i18n.yaml` (generated)
- Modify: `docs/subsystems/skills.md`, `docs/subsystems/skills.zh.md`
- Modify (generated): `docs/config-catalog.md`, `docs/config-catalog.zh.md`, `docs/capability-seams*.md`, `docs/module-graph*.md`, `docs/dependency-catalog.json`, `apps/cli/composition.md`, and whatever else the generators below change

- [ ] **Step 1: Write the English README**

`packages/skill/skill-claude/README.md` — mirror the section list of `packages/skill/skill-filesystem/README.md` (same headings, same order). Use this content:

```markdown
---
description: "The Claude skill provider for users who keep skills in Claude Code and want DSH to run them, and for maintainers of how Claude skills, command files, and plugin skills are discovered."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-claude

English | [中文](README.zh.md)

## Summary

DSH runs the skills you already keep for Claude Code. The provider reads `SKILL.md` bundles and command files from the project's `.claude` directory, from `~/.claude`, and from enabled Claude Code plugins, registers each as an ordinary DSH skill, and watches those directories so edits appear without a restart. The skill runs in the live session through DSH's `skill` tool or the `/name` gesture; no Claude process starts. Choose it when your skills live in Claude Code's folders; `dsh-skill-filesystem` serves DSH's own `.dsh/skills` and `.agents/skills`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

### When to choose it

Choose it when skills, `commands/*.md` files, or plugin skills already exist under `.claude`. Use `dsh-skill-filesystem` alone when skills live only in DSH's roots.

### Skill format

A skill is `<root>/<dir>/SKILL.md` with YAML frontmatter (`name`, `description`, optional `when_to_use`, `disable-model-invocation`, `user-invocable`). A command is a flat `*.md` file whose name comes from its path (`commands/modes/sparc.md` is `modes:sparc`); its description is the frontmatter `description`, else the first Markdown heading, else the first non-empty line. Values that YAML rejects but Claude Code accepts, such as `description: a: b`, are read with a line parser. Names are lowercased and every run of other characters becomes `-`, so `modes:sparc` registers as `modes-sparc` and a plugin skill as `superpowers-brainstorming`.

### Roots and priority

| Rank | Source | Root |
|---|---|---|
| 210 | project skills | `<project>/.claude/skills` |
| 220 | project commands | `<project>/.claude/commands` |
| 530 | user skills | `<claudeHome>/skills` |
| 540 | user commands | `<claudeHome>/commands` |
| 550 | plugin skills | `<installPath>/skills` |
| 560 | plugin commands | `<installPath>/commands` |

For one name, the best match is: DSH workspace skill, Claude workspace skill, DSH custom and global skill, Claude global skill, Claude plugin skill, bundled skill. Plugins come from `<claudeHome>/plugins/installed_plugins.json`, limited to keys enabled in the user or project `settings.json` / `settings.local.json`, and only entries with `scope: "user"`.

### Mount and configure

Presets mount the plugin directly after `skill-filesystem` so both providers share one registry layer:

~~~yaml
- id: skill-claude
  name: '@deepseek-ai/dsh-skill-claude'
~~~

`claudeHome` defaults to `$CLAUDE_CONFIG_DIR`, else `~/.claude`. `includeProject` and `includePlugins` switch those sources off. `watch`, `watchUsePolling`, `watchStabilityThresholdMs`, and `watchPollIntervalMs` tune change detection. The full field list is in the [config catalog](../../../docs/config-catalog.md).

### Change detection

Existing roots are watched recursively; `<claudeHome>`, `<claudeHome>/plugins`, and `<project>/.claude` are watched one level deep so a new root, a plugin install, or a settings change reaches the catalog. Events within one turn produce one invalidation.

### Observable success and failures

A working setup lists the Claude skills in the session's skill catalog and the `/` menu. A file that cannot be read or has no description is skipped with one warning per path; a missing root is silent. A plugin that is enabled but not installed, or installed with a scope other than `user`, logs one warning.

## Understand the implementation

### Design concept

Claude's files are read as data. The provider returns registry candidates and loads bodies on demand; the skill registry, `tool-skill`, and the `/name` gesture run them like any other skill. Nothing here starts a process.

### Source map

| File | Responsibility |
|---|---|
| `src/index.ts` | Plugin entry, `Config`, and the provider. |
| `src/sources.ts` | Roots, project root, enabled plugins. |
| `src/scan.ts` | Directory scan, candidate construction, body loading. |
| `src/frontmatter.ts` | Strict and lenient frontmatter parsing. |
| `src/names.ts` | Name normalization. |
| `src/watch.ts` | Chokidar watchers and invalidation. |

### Discovery flow

`list()` finds the project root, resolves roots and plugins, syncs watchers, and scans every root in parallel. `get()` rereads the file so edits apply on the next load.

### Watching and invalidation

Each root and configuration directory has one watcher; a target that does not exist is retried on the next listing. A burst of events becomes one `control.invalidate()`.

## Further Exploration

- [`dsh-skill`](../skill/README.md) — the registry and the provider interface.
- [`dsh-skill-filesystem`](../skill-filesystem/README.md) — DSH's own skill roots.
- [`dsh-tool-skill`](../tool-skill/README.md) — the model-facing `skill` tool and `/name` gesture.

## Model Experience

The model sees Claude skills in the catalog under their normalized names and loads them with the `skill` tool. Skill bodies are loaded unchanged, so text that names Claude Code tools (`Skill`, `Bash`, `Task`) refers to tools DSH may not have.

## Known Limitations and Deferred Work

### Dev Note

- `$ARGUMENTS` in command bodies is left as written; the user's own words accompany the skill.
- Plugin entries with a scope other than `user` are not loaded.
- Tool names inside Claude skill bodies are not translated to DSH tools.
- Names that normalize to the same string collide; the higher rank wins and the registry warns.
```

- [ ] **Step 2: Write the Chinese README**

`packages/skill/skill-claude/README.zh.md` — same structure and headings translated, same tables and code. Use this content:

```markdown
---
description: "Claude skill（技能）提供方，面向把技能放在 Claude Code 目录里并希望 DSH 直接运行它们的用户，以及维护 Claude 技能、命令文件和插件技能发现逻辑的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-claude

[English](README.md) | 中文

## 摘要

DSH 可以直接运行你已为 Claude Code 准备好的技能。该提供方读取项目 `.claude` 目录、`~/.claude` 以及已启用的 Claude Code 插件中的 `SKILL.md` 包和命令文件，把每一项注册为普通的 DSH 技能，并监听这些目录，因此编辑后无需重启即可生效。技能在当前会话内通过 DSH 的 `skill` 工具或 `/name` 手势运行，不会启动任何 Claude 进程。技能放在 Claude Code 目录时选用它；`dsh-skill-filesystem` 负责 DSH 自己的 `.dsh/skills` 和 `.agents/skills`。

## 目录

- [使用本包](#使用本包)
- [理解实现](#理解实现)
- [延伸阅读](#延伸阅读)
- [模型体验](#模型体验)
- [已知限制与延后工作](#已知限制与延后工作)

## 使用本包

### 何时选用

技能、`commands/*.md` 文件或插件技能已存在于 `.claude` 下时选用。技能只在 DSH 自己的根目录时，单独使用 `dsh-skill-filesystem` 即可。

### 技能格式

技能是 `<root>/<dir>/SKILL.md`，带 YAML frontmatter（`name`、`description`，以及可选的 `when_to_use`、`disable-model-invocation`、`user-invocable`）。命令是平铺的 `*.md` 文件，名称取自路径（`commands/modes/sparc.md` 即 `modes:sparc`）；描述依次取 frontmatter 的 `description`、第一个 Markdown 标题、第一行非空文本。YAML 拒绝但 Claude Code 接受的值（例如 `description: a: b`）由逐行解析器读取。名称转为小写，其余字符的每一段连续序列替换为 `-`，因此 `modes:sparc` 注册为 `modes-sparc`，插件技能注册为 `superpowers-brainstorming`。

### 根目录与优先级

| 等级 | 来源 | 根目录 |
|---|---|---|
| 210 | 项目技能 | `<project>/.claude/skills` |
| 220 | 项目命令 | `<project>/.claude/commands` |
| 530 | 用户技能 | `<claudeHome>/skills` |
| 540 | 用户命令 | `<claudeHome>/commands` |
| 550 | 插件技能 | `<installPath>/skills` |
| 560 | 插件命令 | `<installPath>/commands` |

同名时的优先顺序为：DSH 工作区技能、Claude 工作区技能、DSH 自定义与全局技能、Claude 全局技能、Claude 插件技能、内置技能。插件来自 `<claudeHome>/plugins/installed_plugins.json`，仅限用户或项目 `settings.json` / `settings.local.json` 中已启用的键，且只加载 `scope: "user"` 的条目。

### 挂载与配置

预设把该插件直接挂在 `skill-filesystem` 之后，使两个提供方共用同一注册层：

~~~yaml
- id: skill-claude
  name: '@deepseek-ai/dsh-skill-claude'
~~~

`claudeHome` 默认取 `$CLAUDE_CONFIG_DIR`，否则取 `~/.claude`。`includeProject` 和 `includePlugins` 可关闭对应来源。`watch`、`watchUsePolling`、`watchStabilityThresholdMs` 和 `watchPollIntervalMs` 调整变更检测。完整字段见[配置目录](../../../docs/config-catalog.zh.md)。

### 变更检测

已存在的根目录被递归监听；`<claudeHome>`、`<claudeHome>/plugins` 和 `<project>/.claude` 只监听一层，使新增的根目录、插件安装或设置变更都能进入目录。同一轮事件只触发一次失效。

### 可观察的成功与失败

配置正确时，会话的技能目录和 `/` 菜单会列出这些 Claude 技能。无法读取或没有描述的文件会被跳过，每个路径只警告一次；根目录不存在则静默。已启用但未安装的插件，或安装范围不是 `user` 的插件，各记录一条警告。

## 理解实现

### 设计思路

Claude 的文件只作为数据读取。提供方返回注册表候选项并按需加载正文；技能注册表、`tool-skill` 和 `/name` 手势像对待其他技能一样运行它们。这里不会启动任何进程。

### 源码地图

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口、`Config` 与提供方。 |
| `src/sources.ts` | 根目录、项目根、已启用插件。 |
| `src/scan.ts` | 目录扫描、候选项构造、正文加载。 |
| `src/frontmatter.ts` | 严格与宽松的 frontmatter 解析。 |
| `src/names.ts` | 名称规范化。 |
| `src/watch.ts` | Chokidar 监听与失效通知。 |

### 发现流程

`list()` 查找项目根，解析根目录与插件，同步监听器，并并行扫描每个根目录。`get()` 重新读取文件，使编辑在下一次加载时生效。

### 监听与失效

每个根目录和配置目录各有一个监听器；尚不存在的目标会在下一次列举时重试。一批事件合并为一次 `control.invalidate()`。

## 延伸阅读

- [`dsh-skill`](../skill/README.zh.md) — 注册表与提供方接口。
- [`dsh-skill-filesystem`](../skill-filesystem/README.zh.md) — DSH 自己的技能根目录。
- [`dsh-tool-skill`](../tool-skill/README.zh.md) — 面向模型的 `skill` 工具与 `/name` 手势。

## 模型体验

模型在目录中看到规范化后的 Claude 技能名，并用 `skill` 工具加载。技能正文原样加载，因此提到 Claude Code 工具（`Skill`、`Bash`、`Task`）的文字所指的工具 DSH 可能没有。

## 已知限制与延后工作

### 开发备注

- 命令正文中的 `$ARGUMENTS` 保持原样；用户自己的话随技能一并发送。
- 范围不是 `user` 的插件条目不会加载。
- Claude 技能正文中的工具名不会被翻译为 DSH 工具。
- 规范化后同名的技能会冲突；等级较高者胜出，注册表会发出警告。
```

If `skill-filesystem`'s README links its siblings with different relative paths, match its link style for the three `Further Exploration` links.

- [ ] **Step 3: Record the bilingual pair**

Run: `pnpm run verify-translation-pairing --write packages/skill/skill-claude/README.md`
Expected: creates `packages/skill/skill-claude/README.i18n.yaml` with blob hashes for both files.

- [ ] **Step 4: Add the Claude provider to the skills subsystem page**

In `docs/subsystems/skills.md`, directly after the paragraph that begins `Chokidar watches existing roots` (end of the "Local discovery priority" section), add:

```markdown
## Claude skill provider

`dsh-skill-claude` registers Claude Code skills, command files, and enabled user-scope plugin skills as DSH skills, in the same preset layer as the local provider so ranks decide duplicates across both. Workspace sources outrank global ones: project skills take rank 210 and project commands 220, between `project-agents` (200) and `custom` (300); user skills take 530, user commands 540, plugin skills 550, plugin commands 560. Claude names are lowercased and non-alphanumeric runs become `-` (`modes:sparc` registers as `modes-sparc`). Details: [package README](../../packages/skill/skill-claude/README.md).
```

In `docs/subsystems/skills.zh.md`, add the equivalent section after the matching local-discovery section:

```markdown
## Claude skill 提供方

`dsh-skill-claude` 把 Claude Code 的技能、命令文件和已启用的用户级插件技能注册为 DSH 技能，并与本地提供方处于同一预设层，因此两者的等级共同决定同名项的归属。工作区来源优先于全局来源：项目技能为等级 210，项目命令为 220，介于 `project-agents`（200）与 `custom`（300）之间；用户技能 530，用户命令 540，插件技能 550，插件命令 560。Claude 名称转为小写，非字母数字的连续字符替换为 `-`（`modes:sparc` 注册为 `modes-sparc`）。详见[包 README](../../packages/skill/skill-claude/README.zh.md)。
```

- [ ] **Step 5: Regenerate catalogs and graphs**

```powershell
pnpm run gen-config-catalog
pnpm run gen-doc-graphs
pnpm run gen-cordis-catalog
pnpm run gen-dependency-catalog
pnpm run gen-persistence-catalog
pnpm run gen-client-catalog
pnpm run gen-tool-catalog
pnpm run gen-cordis-inspect-catalog
git status --short
```

Expected: only generated documentation changes appear (`docs/config-catalog*.md`, `docs/capability-seams*.md`, `docs/module-graph*.md`, `docs/dependency-catalog.json`, `apps/cli/composition.md`, and similar). Inspect the diff of each: the `skill-claude` additions and the `claude-skill-commands` removals are expected; any unrelated change means a generator drifted before this work and must not be committed here (run `git checkout -- <file>` for those).

- [ ] **Step 6: Run the documentation gates**

```powershell
pnpm run verify-doc-budgets
pnpm run verify-doc-refs
pnpm run test:docs
pnpm run doc-sync
```

Expected: all pass. A `verify-doc-budgets` failure on the README means trimming prose until under the ceiling (do not raise the ceiling unless the required content genuinely needs it).

- [ ] **Step 7: Run the code gates**

```powershell
pnpm run typecheck
pnpm run lint
pnpm run duplication
pnpm run hygiene
pnpm run verify-export-jsdoc
pnpm exec vitest run packages/skill --coverage --coverage.include="packages/skill/**/src/**"
```

Expected: all pass; `skill-claude` and `skill-filesystem` stay at 100% per file. Fix findings at their source; do not add ignore comments.

- [ ] **Step 8: Commit**

```powershell
git add packages/skill/skill-claude/README.md packages/skill/skill-claude/README.zh.md packages/skill/skill-claude/README.i18n.yaml docs apps/cli/composition.md
git status --short
git commit -m "feat: Documents the Claude skill provider and regenerates catalogs"
```

Read `git status --short` first: stage only documentation and generated catalogs from this task.

---

### Task 11: Local configuration cleanup and live verification

This task changes the user's local `~/.dsh` files (outside the repository) and checks the result in the running web app. Do it only after Tasks 1–10 pass.

**Files:**
- Modify: `C:\Users\awang\.dsh\profiles\web\cordis.patch.yml`
- Modify: `C:\Users\awang\.dsh\.agent-presets\standard-cc\agent.cordis.yml`

- [ ] **Step 1: Remove the obsolete disable patch**

Replace the contents of `C:\Users\awang\.dsh\profiles\web\cordis.patch.yml` with the original template:

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
```

- [ ] **Step 2: Replace the extra skill directories with the provider row**

In `C:\Users\awang\.dsh\.agent-presets\standard-cc\agent.cordis.yml`, replace the whole `skill-filesystem` row (including its `config:` block with `customSkillDirs`) with:

```yaml
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'

- id: skill-claude
  name: '@deepseek-ai/dsh-skill-claude'
```

- [ ] **Step 3: Check the composed configuration**

Run: `pnpm dsh --profile web --dump-config`
Expected: exits 0; no `claude-skill-commands` row; no parse error for the user patch.

- [ ] **Step 4: Restart the web server and test in the browser**

Stop the old server tree (the launcher window owning port 3080) and start `C:\Users\awang\AppData\Local\DSH\Start-DSH-Server.ps1` in a separate window. Then, in Playwright against the printed `http://127.0.0.1:3080/?token=…` URL, with the `dsh-plugins` workspace and the "Standard + Claude Code" preset:

1. Type `/` and confirm the Skills group lists Claude skills, including `modes-sparc` and `superpowers-brainstorming`.
2. Send `/grill-me` followed by a one-line task, typed so the chip is preserved (type `/grill-me`, press Enter to make the chip, then type the rest with `slowly`, then Enter). In the Trajectory tab confirm a `CONTEXT` entry `<skill_content name="grill-me">` whose base directory is `C:\Users\awang\.claude\skills\grill-me`, and no subprocess tool-call card.
3. Send `/modes-sparc` with a harmless request and confirm `<skill_content name="modes-sparc">` appears in the Trajectory tab and the agent's reply is a normal turn in the same conversation.
4. In a scratch project directory under the workspace, add `.claude/skills/duplicate-check/SKILL.md` with description `workspace version`, and a user-level `~/.claude/skills/duplicate-check/SKILL.md` with description `global version`; confirm the `/` menu shows `workspace version`.
5. Edit the scratch workspace skill's description and confirm the `/` menu updates without a server restart. Then delete both scratch skills.

- [ ] **Step 5: Log the result**

Append one bullet to today's daily note (`D:\dev\Notes\Dev Tasks\Daily Notes\2026-10 October 2026\2026-10-01.md`) stating the package name, the six source ranks, that the old subprocess path was removed, and what the browser check showed.

---

## Self-Review

**1. Spec coverage**
- Goal / success criteria (runs in DSH, any provider, no Claude Code, no restart, workspace beats global, tool-call-card path gone): Tasks 7–8, 11.
- Package, config, mounting in three presets, base row deleted: Tasks 2, 7, 8.
- Sources and ranks (210/220/530–560), plugin enablement, user-scope only, warnings: Tasks 4, 7.
- Names (normalization, plugin prefix, skill-over-command by rank, empty-name warning): Tasks 2, 5, 7.
- Parsing (keys, lenient fallback, command heading fallback, missing description, body, `resourceBase`, `$ARGUMENTS`): Tasks 3, 5.
- Refresh (watch roots, shallow config dirs, invalidate, missing roots silent, warn once per path): Tasks 4–7.
- Shared parser export (`splitSkillFrontmatter`, deliberate rename from the spec's `parseSkillFrontmatter` because the lenient fallback needs the raw YAML): Task 1.
- Removals (package, tsconfig paths, dependency, subprocess exports, command-origin JSDoc, stale comments): Task 8.
- Local cleanup (including replacing the dir entries with a `skill-claude` row): Task 11.
- Testing (unit, registry integration, six-way precedence, snapshot, removal checks): Tasks 3–9; test isolation: Task 8 Step 9.
- Documentation (READMEs, config catalog, skills subsystem page): Task 10.
- Risks (tool names in bodies, name collisions): documented in the README (Task 10).

**2. Placeholder scan:** no `TBD`/`TODO`. The two places that depend on repository state not visible when this plan was written are bounded procedures with explicit commands and acceptance output: Task 8 Step 6 (`verify-cordis-config` names the manifests) and Task 9 Step 5 (replay diff drives edits to the authored session).

**3. Type consistency:** `Warn`, `SkillRoot`, `ResolvedSources`, `ClaudeLocator` are defined once in Task 2 and used unchanged in Tasks 4–7. `scanRoot(root, providerName, warn)`, `loadDefinition(candidate, warn)`, `resolveSources(options)`, `findProjectRoot(cwd)`, `resolveClaudeHome(configured, env?)`, `RootWatcher(options, onChange, warn)` with `sync`/`dispose`, and `ClaudeSkillProvider(config, control, log)` keep identical signatures wherever referenced. `CLAUDE_RANK` keys match the values in Global Constraints.

**4. Review Focus:** each of the five items has a named task whose tests pin it (isolation: Task 8 Step 9 and Task 9 Step 1; odd shapes: Task 4; frontmatter oddities: Task 3; mid-scan breakage: Task 5; Windows paths: Tasks 2 and 4).
