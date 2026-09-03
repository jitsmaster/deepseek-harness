# Claude Code session import

English | [中文](claude-session-import.zh.md)

Discovers the operator's Claude Code CLI sessions and imports one, once, into a brand-new native DSH session. No connection to Claude Code survives either call; see the [Agent Note](../../.agents/notes/proposed/architecture/2026-09-02-claude-code-session-import.md) for the design rationale. Types come from [`packages/session/claude-session-import/src/types.ts`](../../packages/session/claude-session-import/src/types.ts).

`DiscoveredSessionView` is the wire view of one `claude agents --json --all` entry (`id`, `name`, `cwd`, `status`, `startedAt`). `list()` resolves a `ClaudeSessionImportListValue` carrying the discovered sessions; `createFrom()` resolves a `ClaudeSessionImportCreateValue` carrying the new session's id. Two stable `RemoteErrorDetailsMap` codes cover the failure paths: `claude-session-import/not-found` (the named session id is no longer reported by `list()`) and `claude-session-import/transcript-unreadable` (the transcript file could not be read or parsed).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxclaudesessionimportcontroller--claudesessionimportcontroller"></a>

### `ctx.claudeSessionImportController` — `ClaudeSessionImportController`

Host service backing `ctx.remote.claudeSessionImport`: discovers Claude Code CLI sessions and imports one, once, into a brand-new native DSH session. No connection to Claude Code survives either call — see .agents/notes/proposed/architecture/2026-09-02-claude-code-session-import.md.

```ts cordis-catalog
/**
 * List the operator's Claude Code CLI sessions.
 * @param signal - withdraws the discovery call.
 * @returns discovered sessions; empty when `claude` is unavailable.
 */
@Remote async list(signal: AbortSignal): Promise<ClaudeSessionImportListValue>

/**
 * Import one Claude Code CLI session into a brand-new native DSH session,
 * defaulting its model to {@link IMPORTED_SESSION_MODEL}.
 * @param sessionId - the id `list()` reported.
 * @param signal - withdraws discovery; the transcript read, session
 *   creation, and model selection that follow are not cancellable once
 *   discovery settles.
 * @returns the new DSH session's id.
 * @throws RemoteError `claude-session-import/not-found` when `sessionId`
 *   is not currently reported by `list()`, or
 *   `claude-session-import/transcript-unreadable` when the transcript
 *   cannot be read or parsed.
 */
@Remote async createFrom(sessionId: string, signal: AbortSignal): Promise<ClaudeSessionImportCreateValue>
```

Source: [`packages/session/claude-session-import/src/index.ts`](../../packages/session/claude-session-import/src/index.ts)
<!-- END GENERATED cordis-surface -->
