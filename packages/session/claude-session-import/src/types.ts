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
