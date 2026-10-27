---
description: "The Claude Code-backed search provider for ctx.web: how a deployment pins web search to the user's own headless Claude Code login instead of a search API key."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-claude-code

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-claude-code`, the harness answers each web search by running the user's own Claude Code in headless mode, so it uses the Claude subscription login already on the machine and needs no search API key. Choose it when the user has Claude Code installed and signed in and wants Claude's search for a session. Every search spawns one `claude -p` process restricted to the WebSearch tool, and the result carries Claude's short cited answer as `content` plus the search's links as sources. It searches only: there is no page fetch. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service and a subprocess runtime; it registers as the `claude-code` search provider. When another search provider is also usable the service reports `WEB_PROVIDER_AMBIGUOUS`, so pin this one with `searchProvider: claude-code` on `dsh-web`.

### When to choose it

Choose this backend when the machine has the official `claude` executable signed in to a Claude subscription and a session should search through it. The provider is unavailable — and a pinned search fails with `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` — when the executable does not resolve. The check is local and starts no process.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: claude-code
- name: '@deepseek-ai/dsh-web-search-claude-code'
```

| Field | Default | Meaning |
|---|---|---|
| `executable` | `claude` on `PATH`, else `~/.local/bin/claude` | Absolute path or `PATH` name of the user's `claude` executable; on Windows a native `.exe` is required because no shell shim is used |
| `model` | (unset) | Passed as `--model`; unset uses the Claude Code default |
| `timeoutMs` | `120000` | Whole-run deadline for one search |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-claude-code) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each search runs `claude -p --output-format stream-json --verbose --no-session-persistence --tools WebSearch --allowedTools WebSearch --strict-mcp-config --permission-mode dontAsk --disallowedTools AskUserQuestion` in a fresh empty temporary directory that is removed afterwards, with the prompt on stdin. Only WebSearch is available to the run, so a global Claude Code startup routine cannot write files. The sources come from the `Links: [...]` array of the WebSearch tool result, in order, each with `url` and `title`; the final result text is the `content`. A request's `maxResults` truncates the sources and sets `truncated`.

### Failures and recovery

Failures surface as `WebError`: `WEB_PROVIDER_ERROR` for a failed or missing result line, a run that never searched, a WebSearch tool error, a non-zero exit (the stderr tail is quoted), or a spawn failure; `WEB_SEARCH_TIMEOUT` when `timeoutMs` elapses; `WEB_ABORTED` when the caller aborts; `WEB_INVALID_QUERY` for a blank query, before any process starts. A timeout or abort terminates the child through the subprocess seam and waits for its process range to end before the directory is removed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Use the user's own client.** The provider launches the unmodified `claude` binary like an interactive `claude -p`, so the subscription is used only through Anthropic's own client and no credential is read or forwarded.
- **Restrict, do not trust.** The run exposes WebSearch alone and no MCP servers, and the prompt forbids startup routines and file access, so a user's global instructions have no tool to act with. Probes of the real binary showed `--tools WebSearch --allowedTools WebSearch --permission-mode dontAsk` runs the search with no permission denials, while a prompt demanding a Write or Bash call received neither tool.
- **Shared process owner.** Spawning, termination, and range teardown go through `ctx.subprocess`, never `node:child_process`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, defaults, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `ClaudeCodeSearchProvider`: argv, prompt, run lifecycle, failure mapping |
| [`src/stream.ts`](src/stream.ts) | Tolerant stream-json decoder: WebSearch calls, `Links` sources, result line |
| [`src/executable.ts`](src/executable.ts) | Synchronous executable lookup behind `available()` |

### Run flow

`search()` rejects a blank query, creates a temporary directory, arms a `dsh-timeout` deadline fused with the caller's signal, and spawns the child with the signal so the seam kills it on abort. Stdout lines are decoded as they arrive; malformed lines and link entries are skipped. After the child exits the run is checked in order: cancellation, exit status, result line, then WebSearch evidence.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web subsystem](../../../docs/subsystems/web.md) — the search request/result vocabulary and error codes.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's result.
- [dsh-subagent-claude-code](../../subagent/subagent-claude-code/README.md) — the sibling that delegates tasks to the same headless Claude Code.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-claude-code) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's answer text, `maxResults`-bounded links and titles, or its exact failure messages under the consumer's error wrapper. Each query spawns one headless Claude Code process that takes about ten seconds and consumes one Claude subscription message; the queries of one `web_search` call, up to its query cap, run as concurrent processes.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the provider is a poor fit. They are current package constraints.

- **Search only, no fetch** — the run is restricted to WebSearch, so there is no page-fetch provider and results carry no per-source snippet.
- **Depends on the user's `claude` executable and login** — the provider is unavailable without the executable, and a run fails with `WEB_PROVIDER_ERROR` when the login is missing or expired. The subprocess seam scrubs credential-shaped environment variables, so only a login Claude Code keeps on disk is used.
- **Subscription rate limits apply** — every search is one Claude message, so a quota or rate-limit failure surfaces as `WEB_PROVIDER_ERROR` and concurrent queries consume quota together.
- **The `Links` text format is not a versioned contract** — a Claude Code release that changes it makes results carry the answer but no sources.
