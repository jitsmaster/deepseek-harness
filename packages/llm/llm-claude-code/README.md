---
description: "The Claude Code-backed LLM adapter for ctx.llm: how a deployment serves every model call through the user's own headless Claude Code login instead of an Anthropic API key."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-claude-code

English | [中文](README.zh.md)

## Summary

With `dsh-llm-claude-code`, the harness serves every model call by running the user's own Claude Code headless, so it uses the Claude subscription login already on the machine and DSH never holds an Anthropic key. Choose it when Claude Code is installed and signed in and Claude should be the session model. Each `stream()` call is one stateless `claude -p` process whose output is decoded into the harness stream, including native tool calls that DSH's own loop executes. The route id is `claude-code`; the real, unmodified `claude` binary does the talking.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the adapter in a composition that already loads the LLM service and a subprocess runtime; it registers the `claude-code` provider route. Select it like any other route: provider `claude-code`, and a model id or alias.

### When to choose it

Choose this backend when the machine has the official `claude` executable signed in to a Claude subscription and a session should run on Claude through it. A call fails with `PROVIDER_UNAVAILABLE` when the executable does not resolve; the check is local and starts no process.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-llm-claude-code'
```

| Field | Default | Meaning |
|---|---|---|
| `executable` | `claude` on `PATH`, else `~/.local/bin/claude` | Absolute path or `PATH` name of the user's `claude` executable; on Windows a native `.exe` is required because no shell shim is used |
| `nodeExecutable` | the harness's own Node | Node binary that runs the tool-schema MCP stub |
| `timeoutMs` | `1800000` | Whole-call deadline |
| `defaultContextWindow` | `200000` | Context window assumed for a model id the catalog does not list |
| `accountsDir` | `<DSH home>/claude-code/accounts` | Root of the Claude Code config directories of the accounts signed in from DSH, one `<id>` directory per account; see "Signing in Claude accounts from DSH" below |
| `accounts` | (none) | Emails of the Claude accounts offered at sign-in; live: an edit applies to the next sign-in without a remount |
| `activeAccount` | (unset) | Email of the signed-in account every call runs as; live: an edit applies to the next call without a remount |
| `privateBrowser` | `true` | Open the sign-in page in a private window of the first installed Chrome, Edge, or Firefox, else in the default browser |
| `credential` | (unset) | Credential record key (for example `llm-pi-ai/anthropic`) whose stored access token or API key authenticates the `claude` child when no signed-in account is usable; unset leaves Claude Code on its own login |
| `rateLimitFile` | (unset) | JSON file that receives the latest plan-usage reading after each call; see "Sharing the plan-usage reading" below |
| `models` | (none) | `{ id, name, contextWindow?, description? }` entries added to, or overriding, the built-in catalog |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-claude-code) is the exhaustive source for every accepted field and its JSDoc.

### Models and request controls

`listModels` returns the current Claude models (`claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-5-5`) plus the aliases `sonnet`, `opus`, and `haiku`. The catalog is advisory: any model id is accepted and passed to `--model` verbatim, and an unlisted id gets `defaultContextWindow`. Every model declares text input only (the runtime turns images and files into text for such routes) and the efforts `low`, `medium`, `high`, `xhigh`, and `max`, passed as `--effort`; no default effort is declared, so a profile's own effort applies. `maxTokens` becomes the `CLAUDE_CODE_MAX_OUTPUT_TOKENS` environment variable of the run. `temperature` and `stop` have no `claude -p` equivalent and are ignored.

### What a call does

Each call creates a fresh temporary directory (the process working directory, removed afterwards) holding `system.txt`, and for requests with tools also `tools.json` and `mcp.json`. It runs `claude -p --output-format stream-json --verbose --include-partial-messages --no-session-persistence --setting-sources "" --strict-mcp-config --tools "" --permission-mode dontAsk --system-prompt-file <dir>/system.txt --model <model>`, adds `--effort <effort>` when one is selected, and for requests with tools adds `--mcp-config <dir>/mcp.json --allowedTools mcp__dsh`. The prompt travels on stdin, so it has no command-line length limit. `--setting-sources ""` keeps the user's global `CLAUDE.md` out and `--tools ""` removes every built-in tool.

DSH owns the conversation, so the run is stateless: the history is written as a `<conversation>` transcript (`<user>`, `<assistant>` with `<tool_call>` elements, `<tool_result>`, `<developer>`) and the DSH system prompt, behind a short note explaining that convention, becomes `system.txt`. Message text is escaped so content cannot forge transcript elements, and reasoning of earlier turns is omitted.

Tools reach Claude through a stdio MCP stub started with `node -e` whose `tools/call` is never answered, so Claude can emit a call but never run one. Claude sees each tool as `mcp__dsh__<name>`; a name that does not fit Claude's 64-character rule gets a deterministic safe alias that is mapped back. The moment a message ends with `tool_use`, the adapter emits usage and a `tool-calls` finish and terminates the process instead of waiting for Claude's next turn.

### Signing in Claude accounts from DSH

The plugin registers one authorization flow with the optional `authorization` seam: record `llm-claude-code/claude-account`, label "Claude (Claude Code)", one method "Sign in with Claude". A surface that renders flows can then add and switch Claude accounts without `llm-pi-ai`. A composition without the seam loads and runs as before; there is just nothing to sign in from.

Which account signs in is chosen inside the flow. It asks with a list of the emails from `accounts` and the ones already signed in, plus an "another email address" entry, then runs the real `claude auth login --claudeai --email=<email>` headless with `CLAUDE_CONFIG_DIR` set to a staging directory next to the account's final directory `<accountsDir>/<id>`. The `<id>` is a filesystem-safe slug of the lowercased email plus a short hash (`name-at-example.com-1a2b3c4d`), so two addresses never share a directory and no id can name a path outside the root. When the child prints its sign-in page, the flow hands that URL to the human as a notice and asks for the code the page shows, which it writes to the child's stdin; a login the browser completes by itself also works. With `privateBrowser` on, the child's `BROWSER` is a small launcher written into the staging directory that opens the page in a private window, so a claude.ai session already open in the normal profile cannot sign in the wrong account.

After the child exits 0 the flow runs `claude auth status --json` in the staging directory to read the account that actually signed in (its email wins over the one asked for), replaces that account's previous files with the staging directory (retrying briefly while a running Claude Code holds them, then failing with a clear error), and commits ONE record under the flow key: `{ type: 'claude-code-accounts', accounts: [{ id, email, signedInAt }] }`, merged with the accounts already listed so signing in a second account keeps the first. A failed, cancelled, or timed-out (ten minutes) sign-in kills the child and leaves every account as it was. The staging directory is always removed, and is left alone if it holds a link.

The record holds no secret and DSH calls no Anthropic endpoint: the tokens stay in each account's directory, where Claude Code stores and refreshes them itself. Before each call the adapter reads `activeAccount` (re-read on every call) and the record; when that email is listed and its directory holds `.credentials.json`, the child starts with `CLAUDE_CONFIG_DIR=<accountsDir>/<id>`. This takes precedence over `credential`, which takes precedence over Claude Code's own login. An active account that cannot be used (never signed in, files missing, no credentials service) logs one warning per distinct reason and falls back; no active account is silent. Only file-based credential storage is supported, so a platform that keeps Claude Code's login in a keychain cannot use this route.

Each call that reports plan usage also keeps the reading of the account it ran as in `<accountsDir>/<id>/usage.json` (`fiveHour` and `sevenDay` `{ utilization, resetsAt }` plus `updatedAt`, written atomically and holding no secret), next to the shared `rateLimitFile`. `readAccountUsage(accountsDir, id)` reads one back for a status display.

### Authenticating with a stored DSH credential

Set `credential` to a credential record key, such as `llm-pi-ai/anthropic`, to run Claude Code under the Anthropic credential DSH already stores. Before each spawn the adapter reads that record through the optional credentials service. A pi-ai OAuth grant with more than 60 seconds left hands only its **access token** to the child as `CLAUDE_CODE_OAUTH_TOKEN`; an `api-key` record hands its key as `ANTHROPIC_API_KEY`. The refresh token is never shared, because a refresh by Claude Code would rotate it and break DSH's stored copy.

This route never refreshes a grant and is used only when no signed-in account is usable. When the grant is expired, malformed, or missing, when no credentials service is mounted, or when the read fails, the call does not fail: the child starts with no extra environment, uses Claude Code's own login, and one warning per distinct reason is logged (never the secret). While the `llm-pi-ai` route is off nobody refreshes the token, so the grant goes stale after about 6 hours and the route falls back to Claude Code's own login.

### Sharing the plan-usage reading

Claude Code reports the subscription's plan usage on a `rate_limit_event` line of every run. Set `rateLimitFile` to a path and the adapter keeps the latest reading there, so a status display can show it without calling Anthropic's usage endpoint itself. The file is JSON:

```json
{
  "updatedAt": "2026-10-27T17:42:00.000Z",
  "fiveHour": { "utilization": 0.02, "resetsAt": 1793134800 },
  "sevenDay": { "utilization": 0.53, "resetsAt": 1793232000 }
}
```

`utilization` is a fraction from 0 to 1 and `resetsAt` is epoch **seconds**. Only the `five_hour` and `seven_day` windows are kept, nothing else from the event. A window the latest run did not report keeps its previous value. The file is updated only when a call completes (a call that ends in a failure or in a tool call counts when the line had already arrived), so it is as old as the last call. Writes go through a temp file in the same directory and a rename, are serialized inside the plugin, and create the parent directory. They are best effort: a failure never fails the call and logs one warning per distinct reason.

### Failures and recovery

Failures are thrown as `LlmError`, which the runtime normalizes into a terminal error finish: `AUTH` (not logged in), `QUOTA` (usage limit), `RATE_LIMIT`, `SERVER` (overloaded or 5xx), `CONTEXT_WINDOW_EXCEEDED` (prompt too long), `EMPTY_RESPONSE`, `TIMEOUT` when `timeoutMs` elapses, `ABORTED` when the caller aborts, `PROVIDER_UNAVAILABLE` for a missing executable or spawn failure, and `PROVIDER_ERROR` for anything else (a failed result, a non-zero exit with the stderr tail quoted, or no result line). Messages never include the prompt. A timeout or abort terminates the child through the subprocess seam and waits for its whole process range to end before the directory is removed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

- **Use the user's own client.** The adapter launches the unmodified `claude` binary like an interactive `claude -p`, so the subscription is used only through Anthropic's own client and no credential is read or forwarded.
- **Claude proposes, DSH executes.** Claude's own tools are off and its MCP tools never answer, so the only thing a run can do is emit a tool call; DSH's loop keeps permission, execution, and history.
- **Stateless runs.** Resuming Claude sessions would split history between two owners, so every call re-sends the whole transcript.
- **Shared process owner.** Spawning, termination, and range teardown go through `ctx.subprocess`, never `node:child_process`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, defaults, route registration |
| [`src/adapter.ts`](src/adapter.ts) | The `ClaudeCodeLlmAdapter`: argv, temp files, run lifecycle, failure mapping, model metadata |
| [`src/decoder.ts`](src/decoder.ts) | stream-json decoder: block remapping, usage, stop reasons, result line |
| [`src/transcript.ts`](src/transcript.ts) | Escaped conversation transcript and `system.txt` text |
| [`src/names.ts`](src/names.ts) | `mcp__dsh__` prefix and safe tool-name aliases |
| [`src/stub.ts`](src/stub.ts) | Inline source of the never-answering MCP stub |
| [`src/models.ts`](src/models.ts) | Built-in model catalog and efforts |
| [`src/credential.ts`](src/credential.ts) | Stored credential record to child environment mapping |
| [`src/account.ts`](src/account.ts) | Account ids, the accounts record, its child environment, and the sign-in URL and status parsers |
| [`src/login.ts`](src/login.ts) | The `claude auth login` authorization flow and the guarded account swap |
| [`src/browser.ts`](src/browser.ts) | Private-window browser selection and the generated launcher script |
| [`src/rate-limit.ts`](src/rate-limit.ts) | Serialized atomic writer of the shared plan-usage file |
| [`src/executable.ts`](src/executable.ts) | Synchronous executable lookup |

### Run flow

`stream()` rejects an already aborted signal, locates the executable, creates the temporary directory, and arms a `dsh-timeout` deadline fused with the caller's signal. It writes the files, spawns the child with the fused signal so the seam kills it on abort, and decodes stdout lines as they arrive: thinking blocks that stay empty vanish (their tokens still count as `reasoningTokens`), block indexes are renumbered in first-emitted order, and usage is Claude's cumulative counters mapped to disjoint input, cache-read, cache-write, and output counts. A `tool_use` message ends the call at once; any other message waits for the `result` line, which decides success or the failure code.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-llm](../llm/README.md) — the LLM service this adapter registers into and the stream vocabulary it emits.
- [dsh-web-search-claude-code](../../web/web-search-claude-code/README.md) — the sibling that serves web search through the same headless Claude Code.
- [dsh-subagent-claude-code](../../subagent/subagent-claude-code/README.md) — the sibling that delegates tasks to the same headless Claude Code.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-claude-code) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Provider request through Claude Code

#### What the model sees

Claude receives a system prompt made of a short note explaining the transcript convention followed by the DSH system prompt (the leading system message, else one-shot `GenerateOptions.system`), and stdin holding the conversation as one `<conversation>` transcript of `<user>`, `<assistant>` (visible text plus `<tool_call id name>` elements with the raw JSON arguments), `<tool_result id name [error]>`, and `<developer>` turns, ending with `Continue as the assistant.` Message text is escaped so content cannot forge those elements. Reasoning of earlier turns, later system messages, and tool-change blocks are not rendered; images and files arrive as text placeholders. The request's complete tool list is exposed as native `mcp__dsh__<name>` tools, with a deterministic alias for any name Claude's tool-name rule rejects; Claude's own tools, settings, and the user's global `CLAUDE.md` are not available to the run.

#### Token effect

Every call re-sends the whole transcript as input on the subscription of the account the run authenticates as (the account signed in from DSH, else a stored credential, else Claude Code's own login), counted by Claude's own tokenizer, plus a small constant overhead for the transcript note, tags, and tool definitions. Usage comes back as disjoint input, cache-read, cache-write, and output counts, with thinking tokens reported separately as `reasoningTokens`.

#### KV Cache effect

The transcript is rebuilt for every call, and its prefix stays byte-stable only while earlier messages are unchanged: appended turns reuse Claude Code's prompt cache, while a compaction or fork rewrites the prefix and the cache restarts from the changed point.

### Provider response

#### What the model sees

Claude's text, non-empty thinking, and `tool_use` blocks become harness text, reasoning, and tool-call blocks in first-emitted order; a thinking block that stays empty is dropped. A tool call carries Claude's id, the DSH tool name (aliases mapped back), and Claude's raw JSON arguments. The run is stopped at the first message that ends with `tool_use`, so only that message's content is recorded and DSH's loop runs the tools.

#### Token effect

Generated content affects later inputs only after the loop records it, and it is then re-rendered into the next transcript; reasoning is omitted from later transcripts, so it adds no later input.

#### KV Cache effect

Recorded response content appends to the next transcript and does not change its earlier prefix; omitting reasoning renders identically on every call, so it never invalidates reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the adapter is a poor fit. They are current package constraints.

- **Text input only** — the route declares no image input; images and files arrive as text.
- **No `temperature` or `stop`** — `claude -p` offers neither, so the request fields are ignored; `maxTokens` is honored only through `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
- **Depends on the user's `claude` executable and login** — a call fails with `AUTH` when the login is missing or expired. The subprocess seam scrubs credential-shaped environment variables, so only an account signed in from DSH, a login Claude Code keeps on disk, or the stored credential selected by `credential`, is used.
- **Signing in replaces that account, and needs files** — a new sign-in of an email swaps that account's directory, which fails while a running Claude Code holds files in it; a platform that stores the login in a keychain is not supported, and the private-window launcher is a batch file or shell script for Chrome, Edge, or Firefox only.
- **Subscription rate limits apply** — every call is one Claude message, so quota and rate-limit failures surface as `QUOTA` or `RATE_LIMIT`.
- **Process start cost** — every call starts a `claude` process (and a Node MCP stub when tools are present), so every call pays a fixed start-up delay before the first token.
- **The stream-json format is not a versioned contract** — a Claude Code release that changes it can make a call fail with `PROVIDER_ERROR` or return no content.
