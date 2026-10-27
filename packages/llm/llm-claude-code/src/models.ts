/**
 * Static Claude model catalog and reasoning efforts for the Claude Code route.
 * Claude Code accepts any model id or alias, so the catalog is advisory: it
 * feeds selectors and context-window metadata, never request validation.
 * @module @deepseek-ai/dsh-llm-claude-code/models
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmReasoningEffortInfo } from '@deepseek-ai/dsh-llm'

/** One selectable model, from the built-in catalog or the plugin config. */
export interface ClaudeModelEntry {
  /** Value passed to `--model` (a full id or an alias such as `sonnet`). */
  id: string
  /** Display name for selectors. */
  name: string
  /** Context window in tokens; the configured default applies when absent. */
  contextWindow?: number
  /** Optional user-facing distinction from similar entries. */
  description?: string
}

/** Context window of the current 5.x Claude models. */
const CURRENT_WINDOW = 1_000_000

/**
 * Current Claude models (ids, names, and windows from the installed pi-ai
 * Anthropic catalog) and the aliases Claude Code resolves to the latest of each family.
 * The full ids come first: selectors that take the first match (the first
 * `haiku`, for instance) land on a pinned id rather than a moving alias.
 */
export const BUILTIN_MODELS: readonly ClaudeModelEntry[] = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: CURRENT_WINDOW },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: CURRENT_WINDOW },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextWindow: CURRENT_WINDOW },
  { id: 'sonnet', name: 'Claude Sonnet (latest)', contextWindow: CURRENT_WINDOW, description: 'Alias: the latest Sonnet that Claude Code resolves' },
  { id: 'opus', name: 'Claude Opus (latest)', contextWindow: CURRENT_WINDOW, description: 'Alias: the latest Opus that Claude Code resolves' },
  { id: 'haiku', name: 'Claude Haiku (latest)', contextWindow: CURRENT_WINDOW, description: 'Alias: the latest Haiku that Claude Code resolves' },
]

/** Efforts `claude --effort` accepts, from least to greatest. */
export const CLAUDE_EFFORTS: readonly LlmReasoningEffortInfo[] = [
  { id: ReasoningEffortId('low'), name: 'Low' },
  { id: ReasoningEffortId('medium'), name: 'Medium' },
  { id: ReasoningEffortId('high'), name: 'High' },
  { id: ReasoningEffortId('xhigh'), name: 'Extra high' },
  { id: ReasoningEffortId('max'), name: 'Max' },
]

/**
 * Layer configured models over the built-in catalog: a matching id replaces the
 * built-in entry in place, new ids are appended.
 * @param configured - entries from the plugin config.
 * @returns the effective catalog in display order.
 */
export function mergeModels(configured: readonly ClaudeModelEntry[]): readonly ClaudeModelEntry[] {
  const merged = new Map<string, ClaudeModelEntry>(BUILTIN_MODELS.map(model => [model.id, model]))
  for (const model of configured) merged.set(model.id, { ...merged.get(model.id), ...model })
  return [...merged.values()]
}
