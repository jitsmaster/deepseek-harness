---
description: "The Claude skill provider for users who keep skills in Claude Code and want DSH to run them, and for maintainers of how Claude skills, command files, and plugin skills are discovered."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-claude

English | [中文](README.zh.md)

## Summary

Skills you already keep for Claude Code run in DSH sessions: the provider registers `SKILL.md` bundles and command files from the project's `.claude` directory, from `~/.claude`, and from enabled Claude Code plugins as ordinary DSH skills. It watches those directories, so edits reach agents without a restart. Skills run in the live session through the `skill` tool or the `/name` gesture, and no Claude process starts. Choose it when skills live in Claude Code's folders; `dsh-skill-filesystem` serves DSH's own `.dsh/skills` and `.agents/skills`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin to make Claude Code skills, command files, and plugin skills available to agents. It scans the Claude roots below, parses each file's frontmatter into a catalog entry, and loads the body on demand.

### When to choose it

Choose it when skills, `commands/*.md` files, or plugin skills already exist under `.claude`. Use `dsh-skill-filesystem` alone when skills live only in DSH's own roots; the two providers can be mounted together.

### Skill format

A skill is a directory `<root>/<dir>/SKILL.md` with YAML frontmatter: `name` (the directory name when omitted), `description` (required), and optional `when_to_use`, `disable-model-invocation`, and `user-invocable`. A command is a `*.md` file anywhere below a `commands` root; its name comes from its path (`commands/modes/sparc.md` is `modes:sparc`), and its description is the frontmatter `description`, else the first Markdown heading, else the first non-empty line. A file with no description is skipped.

Values that YAML rejects but Claude Code accepts, such as `description: a: b`, are read with a line parser. The two invocation keys accept `true` and `false` (YAML booleans or case-insensitive text); any other value leaves that surface permitted.

Names are lowercased and every run of characters outside `a-z0-9` becomes `-`, so `modes:sparc` registers as `modes-sparc`. A plugin's skills and commands take the plugin name as a prefix: skill `brainstorming` of plugin `superpowers@marketplace` registers as `superpowers-brainstorming`. An identifier with no letters or digits is skipped with a warning.

The catalog and the body have separate lifecycles: discovery parses frontmatter into the catalog entry, and every load re-reads the current file, so editing a skill body needs no cache invalidation.

### Roots and priority

Roots are scanned in rank order, and a lower rank wins a duplicate name:

| Rank | Source | Root |
|---|---|---|
| 210 | `claude-project` skills | `<project>/.claude/skills` |
| 220 | `claude-project` commands | `<project>/.claude/commands` |
| 530 | `claude-user` skills | `<claudeHome>/skills` |
| 540 | `claude-user` commands | `<claudeHome>/commands` |
| 550 | `claude-plugin` skills | `<installPath>/skills` |
| 560 | `claude-plugin` commands | `<installPath>/commands` |

The project root is the nearest ancestor of the session's working directory containing `.git`; without one, the working directory is used. When `<project>/.claude` is the same directory as `claudeHome`, the project sources and project settings are skipped so nothing is listed twice.

In the same layer as `dsh-skill-filesystem` (ranks 100 to 500, and 600 for a bundled root), a duplicate name resolves to the first of: DSH project skills (100, 200), Claude project skills and commands (210, 220), DSH custom and user skills (300 to 500), Claude user skills and commands (530, 540), Claude plugin skills and commands (550, 560), bundled skills (600). Ties on rank go to the provider registered first, and the registry does not warn about the losing entry.

Plugins come from `<claudeHome>/plugins/installed_plugins.json`, limited to keys that `enabledPlugins` turns on in `<claudeHome>/settings.json`, then the project's `settings.json` and `settings.local.json`, each overriding the one before. Only an installed entry with `scope: "user"` and an `installPath` loads.

### Mount and configure

Load the plugin after the skill registry and the local provider so both share one registry layer; the shipped presets mount it directly after `skill-filesystem`:

```yaml
- id: skill-claude
  name: '@deepseek-ai/dsh-skill-claude'
```

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `claude` | Unique provider name registered on `ctx.skills` |
| `claudeHome` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | Claude configuration root; its `skills`, `commands`, `plugins`, and `settings.json` are read |
| `includeProject` | `true` | Scan the project's `.claude/skills` and `.claude/commands` and read its settings files |
| `includePlugins` | `true` | Scan skills and commands of enabled user-scope plugins |
| `watch` | `true` | Watch the roots and configuration files and invalidate the provider when the catalog may have changed |

The remaining `watch*` fields tune Chokidar: polling, stability window, and poll interval. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-skill-claude) is the exhaustive source for every field.

### Change detection

Existing roots are watched recursively, excluding `node_modules`. `<claudeHome>`, `<claudeHome>/plugins`, and `<project>/.claude` are watched one level deep, so a new root, a plugin install, or a settings change reaches the catalog. A target that does not exist is retried on the next listing. Events that arrive in one event-loop turn produce one invalidation.

### Observable success and failures

A working setup lists the Claude skills in the session's skill catalog and the `/` menu. Each of these logs one warning per path and message, and the rest of the catalog still loads: an unreadable file or directory, a file with no description, a name with no letters or digits, a `settings.json` or `installed_plugins.json` that is unreadable or invalid JSON, a plugin that is enabled but not installed, and an installed plugin with no `scope: "user"` entry. A missing root or a skill directory without `SKILL.md` is silent. A watcher failure only costs live updates; the scan still serves the catalog.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how discovery and watching are organized; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

Claude's files are read as data. The provider returns registry candidates carrying the file path, and the skill registry, `tool-skill`, and the `/name` gesture run them like any other skill. Discovery and watching are separate: `list()` scans, and a watcher object owns the Chokidar handles and invalidation.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, `Config`, and the provider |
| [`src/sources.ts`](src/sources.ts) | Ranks, project root, settings, enabled plugins |
| [`src/scan.ts`](src/scan.ts) | Directory scan, candidate construction, body loading |
| [`src/frontmatter.ts`](src/frontmatter.ts) | Strict and lenient frontmatter parsing, invocation policy |
| [`src/names.ts`](src/names.ts) | Name normalization |
| [`src/watch.ts`](src/watch.ts) | Chokidar watchers and coalesced invalidation |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Discovery flow

`list()` finds the project root, resolves the roots and enabled plugins, syncs the watchers, and scans every root in parallel. Skill roots contribute each direct subdirectory's `SKILL.md`, symlinked directories included; command roots contribute every `.md` file below them. `get()` re-reads the file and returns the body after the frontmatter, or `undefined` when the file is gone.

### Watching and invalidation

Each deep root and each shallow configuration directory has one watcher. The watcher waits for a changed file to stay stable for `watchStabilityThresholdMs` before reporting it, and a burst of events becomes one `control.invalidate()` per microtask batch. Teardown closes every watcher.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the registry contract to the local provider that shares its layer and the consumer that renders discovered skills.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry contract and the discovery priority tables.
- [skill package](../skill/README.md) — the registry this provider registers on.
- [skill-filesystem package](../skill-filesystem/README.md) — DSH's own skill roots, ranked alongside these.
- [tool-skill package](../tool-skill/README.md) — how discovered skills reach the session catalog and the model.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which renders this provider's invocable names and capped descriptions into the initial or replacement catalog and a selected current instruction body plus resource-base guidance into retained tool history while paths, provider ranks, and disabled skills remain hidden. Skill bodies load unchanged, so text that names Claude Code tools such as `Skill`, `Bash`, or `Task` refers to tools DSH may not provide.

#### KV Cache effect

Watcher invalidation can cause the named consumer to append a replacement catalog to the existing request history. Body-only edits leave the catalog digest unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Plugin scope** — only `scope: "user"` plugin entries load; project-scope and local-scope installs are skipped with a warning.
- **Claude Code tool names are not translated** — a loaded body keeps its references to Claude Code tools, and `$ARGUMENTS` placeholders stay as written.
- **Name collisions are silent** — names that normalize to the same string (`a:b` and `a-b`) resolve by rank and then provider order, and the registry does not report the loser.
- **Discovery is one level deep for skills** — only `<root>/<dir>/SKILL.md` is recognized; nested skill trees are ignored.
- **A root is watched only once it exists** — creating a directory directly under `<claudeHome>`, `<claudeHome>/plugins`, or `<project>/.claude` reaches the catalog; a new `<project>/.claude` or a plugin's new `skills` directory is attached only after another change invalidates the catalog.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
