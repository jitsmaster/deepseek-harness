/**
 * Wire view of one `claude agents --json --all` entry, as `list()` returns it.
 *
 * Mirrors `DiscoveredSessionView` in `@deepseek-ai/dsh-claude-session-import`.
 * That package is host-only, so the client face cannot re-export its types
 * across faces; the shapes are structurally identical.
 */
export interface DiscoveredSessionView {
  readonly id: string
  readonly name: string
  readonly cwd: string
  readonly status: string
  readonly startedAt: string
}
