# Claude skills as DSH skills — design

Status: approved 2026-10-01; revised the same day for workspace-over-global precedence across providers (ranks 210/220, preset mounting, test isolation). Date: 2026-10-01.

## Goal

Every Claude Code skill and command file is usable in DSH without Claude Code running them. DSH reads the files itself, registers them with the skill registry, and runs them through DSH's own `skill` tool and `/name` gesture inside the live session.

Success criteria:

- `/obsidian-vault`, `/modes-sparc`, and plugin skills such as `superpowers-brainstorming` load into the current DSH session on any model provider.
- Do not use Claude Code to invoke these skills, use DSH.
- Workspace skills (DSH `.dsh/skills` and `.agents/skills`, Claude `<project>/.claude/...`) and Claude global skills (`~/.claude/...`, enabled plugins) all work in one session. When a workspace skill and a global skill share a name, the workspace skill wins.
- A skill the user edits or installs appears without a server restart.
- The tool-call-card path (`runClaudeCodeSlashCommand`) no longer exists.

Out of scope: Claude Code built-in session commands (`/compact`, `/clear`, …), hooks, and MCP servers declared by plugins.

## Problem

`@deepseek-ai/dsh-claude-skill-commands` registers each Claude skill as a DSH command whose handler spawns a one-shot Claude Code process. That process cannot ask the user anything back (`AskUserQuestion` is disabled), has no timeout, and renders as a tool-call card instead of a conversation turn. It also works only while the active provider is Anthropic and the Claude CLI is present.

## Design

### Package

New `packages/skill/skill-claude`, published as `@deepseek-ai/dsh-skill-claude`, plugin name `skill-claude`, injecting `skills`. It registers one `SkillProvider` through `ctx.skills.registerProvider()` inside `apply()`; disposal goes through the registry's returned disposer. It is mounted by each shipped preset that mounts `skill-filesystem` (`standard`, `ptc`, `cordis`), as a row directly after the `skill-filesystem` row, and the `claude-skill-commands` row in `packages/bundle/base/cordis.patch.yml` is deleted without replacement. Both providers then register in the same preset layer of the skill registry. The registry lets a preset-layer entry beat any global-layer entry of the same name regardless of rank, so a global-layer `skill-claude` would lose every duplicate to `skill-filesystem` and could not honor "workspace beats global" across the two providers.

`Config`:

| Field | Meaning |
|---|---|
| `providerName` | Registry provider name, default `claude`. |
| `claudeHome` | Claude config root. Default `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Resolved in one explicit `resolveClaudeHome()` step. |
| `includeProject` | Whether `<project>/.claude/` roots are scanned. Default `true`. |
| `includePlugins` | Whether enabled plugins are scanned. Default `true`. |
| `watch`, `watchUsePolling`, `watchStabilityThresholdMs`, `watchPollIntervalMs` | Same meaning as in `skill-filesystem`. |

### Sources and precedence

Lower rank wins a duplicate name inside one registry layer. `skill-filesystem` uses 100 (`.dsh/skills` of the project), 200 (`.agents/skills` of the project), 300 (custom directories), 400 (`~/.dsh/skills`), 500 (`~/.agents/skills`), and 600 (bundled). Every workspace source must outrank every global source, so the Claude workspace sources take 210 and 220, between the DSH workspace roots and all global roots; the Claude global sources take 530–560 after the DSH global roots. The result for one name, best first: DSH workspace, Claude workspace, DSH custom and global, Claude global, Claude plugins, bundled.

| Rank | Source | Files |
|---|---|---|
| 210 | project skills | `<project>/.claude/skills/<dir>/SKILL.md` |
| 220 | project commands | `<project>/.claude/commands/**/*.md` |
| 530 | user skills | `<claudeHome>/skills/<dir>/SKILL.md` |
| 540 | user commands | `<claudeHome>/commands/**/*.md` |
| 550 | plugin skills | `<installPath>/skills/<dir>/SKILL.md` |
| 560 | plugin commands | `<installPath>/commands/**/*.md` |

Plugins are the entries of `<claudeHome>/plugins/installed_plugins.json` whose `<plugin>@<marketplace>` key is `true` in `enabledPlugins` of the user `settings.json` or the project `.claude/settings.json` / `settings.local.json`. Only entries with `scope: "user"` are loaded; an entry with any other scope is skipped with one warning, because no project-scoped entry was available to confirm its recorded fields. The recorded `installPath` is used as written, so plugin upgrades need no configuration change.

### Names

The registry accepts only `^[a-z0-9]+(?:-[a-z0-9]+)*$`. The provider derives a name as follows:

1. Skill directory: the frontmatter `name`, else the directory name.
2. Command file: the path below `commands/` without `.md`, segments joined by `:` (Claude's own namespacing), for example `modes:sparc`.
3. Plugin sources are prefixed with the plugin name and `:` (`superpowers:brainstorming`).
4. The result is lowercased, every run of characters outside `[a-z0-9]` becomes one `-`, and leading and trailing `-` are trimmed. `modes:sparc` registers as `modes-sparc`.

A name that normalizes to the empty string is skipped with a warning. When two sources of the same rank normalize to one name, the registry's existing duplicate warning applies.

When a skill and a command resolve to the same name, the skill wins by rank. This removes wrapper commands such as `commands/dream.md` ("Invoke the Skill tool with name dream").

### Parsing

- Frontmatter keys read: `name`, `description`, `when_to_use` / `whenToUse`, `disable-model-invocation`, `user-invocable`. These match the invocation policy `skill-filesystem` already parses. All other keys (`allowed-tools`, `argument-hint`, `model`) are ignored.
- Frontmatter is parsed with `yaml`. When that throws (for example an unquoted `: ` inside `description`), a line parser splits each `key: value` line at the first colon, so skills Claude Code accepts also load here.
- A command file without a `description` uses its first Markdown heading, then its first non-empty line; the catalog consumer applies its own length bound.
- A candidate without a description after those fallbacks is skipped with a warning.
- The body is the text after the frontmatter. `resourceBase` is `{ kind: 'directory', path }` for the skill directory or command file's directory. `$ARGUMENTS` is left as written; the user's own words accompany the skill through the existing `skill-invocation` injection.

### Refresh

The provider watches the existing roots, `installed_plugins.json`, and the three `settings.json` files with `chokidar` (already a workspace dependency of `skill-filesystem`). A debounced change calls `control.invalidate()`, which re-runs `list()` for every consumer. Missing roots are not an error. An unreadable root or file is skipped with one `ctx.logger.warn` per path per failure. The provider reads files with `node:fs/promises` directly; Claude files are host-local user content, and the skill-filesystem sandbox read path is not used.

### Shared parser

`skill-filesystem` exports its frontmatter splitter as `splitSkillFrontmatter(raw)`, returning `{ yaml, body }` (the YAML text unparsed) or `undefined`, so both providers share one splitter and `skill-claude` can retry a failed YAML parse with its lenient parser. The lenient fallback and the command-file heading fallback live in `skill-claude` and are not added to `skill-filesystem`.

### Removals

- Delete `packages/interaction/claude-skill-commands`, its `tsconfig.base.json` / `tsconfig.host.json` paths, the `dsh-base` dependency, and the base bundle row. Add the `skill-claude` row to the `standard`, `ptc`, and `cordis` preset files, and add `@deepseek-ai/dsh-skill-claude` to every manifest `verify-cordis-config` names as a resolver for those rows.
- Delete `runClaudeCodeSlashCommand` and `listClaudeCodeCommands` from `dsh-subagent-claude-code` with their tests, once a repository search shows no other consumer.
- Keep the `'claude-code'` value of the command origin in `packages/interaction/commands/src/types.ts`; saved sessions may contain it. Update its JSDoc to say no current code produces it.
- Remove the stale references in `model-selection.ts`, `ui-commands` `service.ts`, and `claude-session-import` comments, and the `refresh-skills` command mention in docs.

### Local configuration cleanup (outside the repository)

After the package passes, remove the `claude-skill-commands` disable patch from `~/.dsh/profiles/web/cordis.patch.yml` (a patch for a missing row id would fail), replace the two `customSkillDirs` entries in `~/.dsh/.agent-presets/standard-cc/agent.cordis.yml` with a `skill-claude` row after its `skill-filesystem` row (that preset file is a user copy and does not follow the shipped presets), then restart the web server.

## Testing

All tests use a temporary `claudeHome` and project directory; none touches the real `~/.claude`.

- Unit, per-file 100% coverage on `src`: source discovery for each of the six sources; rank and shadowing; name normalization table (`modes:sparc`, `Foo_Bar`, empty result); plugin enablement from user and project settings; non-`user` plugin scope skipped with a warning; strict and lenient frontmatter; command heading fallback; `disable-model-invocation` and `user-invocable`; unreadable and missing roots; invalidation on a watched file change.
- Registry integration: the provider's skills appear in `ctx.skills.list()` and `tool-skill` loads one by name.
- Precedence with `skill-filesystem` mounted in the same scoped layer, one test per pair of same-named skills: DSH workspace over Claude workspace; Claude workspace over a DSH global (`~/.agents/skills`) skill; Claude workspace over a Claude global skill; DSH global over Claude global.
- Keyless snapshot: a session with a fixture Claude skill shows it in the catalog and the `/name` gesture injects its body.
- Removal checks: a repository search finds no import of the deleted package or exports; `pnpm run typecheck`, `lint`, `duplication`, `hygiene`, and `doc-sync` pass.

### Test isolation

Every harness that already pins `DSH_HOME` and `DSH_AGENTS_HOME` to a scratch directory also sets `CLAUDE_CONFIG_DIR` to a scratch directory, so a developer's real `~/.claude` never enters a recorded prompt or an expected output. The central sites are `packages/test-support/session-snapshot/src/harness.ts`, `packages/test-support/session-snapshot/src/launcher.ts`, and `packages/test-support/loader-smoke/src/index.ts`; the scattered `*.e2e.ts` and web scaffolds that set `DSH_AGENTS_HOME` get the same line.

## Documentation

- `packages/skill/skill-claude/README.md` and `README.zh.md`.
- Config catalog entry generated for `@deepseek-ai/dsh-skill-claude`.
- `docs/subsystems/skills.md` (and `.zh.md`): add the Claude provider and its ranks.
- No Agent Note is required; the decision rationale is this spec's Problem section.

## Risks

- Skill bodies written for Claude Code mention tools such as `Skill`, `Bash`, `Task`. DSH's model sees those names in the body and may call tools DSH does not have. The skill body is loaded unchanged; tool-name translation is deferred.
- Flattened names can collide across sources (`a:b-c` and `a-b:c`); the registry warns and the higher rank wins.
