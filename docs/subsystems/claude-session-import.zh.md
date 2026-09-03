# Claude Code 会话导入

[English](claude-session-import.md) | 中文

发现操作者的 Claude Code CLI 会话，并将其中一个一次性导入到全新的原生 DSH 会话中。两次调用均不会与 Claude Code 保持任何连接；设计理由见[Agent Note](../../.agents/notes/proposed/architecture/2026-09-02-claude-code-session-import.md)。类型定义来自 [`packages/session/claude-session-import/src/types.ts`](../../packages/session/claude-session-import/src/types.ts)。

`DiscoveredSessionView` 是 `claude agents --json --all` 一条记录的线路视图（`id`、`name`、`cwd`、`status`、`startedAt`）。`list()` 解析为携带已发现会话的 `ClaudeSessionImportListValue`；`createFrom()` 解析为携带新会话 id 的 `ClaudeSessionImportCreateValue`。两个稳定的 `RemoteErrorDetailsMap` 错误码覆盖了失败路径：`claude-session-import/not-found`（`list()` 不再报告指定的会话 id）与 `claude-session-import/transcript-unreadable`（无法读取或解析该记录文件）。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
