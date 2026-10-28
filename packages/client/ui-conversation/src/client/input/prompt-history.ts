/** Cursor over a session's earlier prompts for ArrowUp / ArrowDown recall in the composer. */

import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'

/**
 * Direct human text prompts from a session's loaded events, oldest first.
 * @param entries - the binding's event window entries.
 * @returns prompt texts; injected context, images-only and empty messages are skipped.
 */
export function humanPromptHistory(entries: readonly SessionEventLikeEntry[]): string[] {
  const prompts: string[] = []
  for (const entry of entries) {
    if (entry.type !== 'event' || entry.event.type !== 'user/message') continue
    const data = entry.event.data
    if (data.source.kind !== 'user') continue
    const text = data.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
    if (text.trim() !== '') prompts.push(text)
  }
  return prompts
}

/** Recall position: `index` is null when not browsing; `draft` is the text typed before browsing began. */
export interface PromptRecallState {
  readonly index: number | null
  readonly draft: string
}

/** New state plus the text to put in the composer, or undefined when the key is not handled. */
export interface PromptRecallResult {
  readonly state: PromptRecallState
  readonly text: string | undefined
}

/**
 * Step the recall cursor.
 * @param history - the session's sent prompts, oldest first.
 * @param state - current recall state.
 * @param direction - ArrowUp (older) or ArrowDown (newer).
 * @param current - the composer's current text.
 * @returns the next state and the text to show; text is undefined when nothing applies.
 */
export function recallPrompt(
  history: readonly string[],
  state: PromptRecallState,
  direction: 'up' | 'down',
  current: string,
): PromptRecallResult {
  const unchanged: PromptRecallResult = { state, text: undefined }
  if (history.length === 0) return unchanged
  if (state.index === null) {
    if (direction === 'down' || current !== '') return unchanged
    const index = history.length - 1
    return { state: { index, draft: current }, text: history[index] }
  }
  if (direction === 'up') {
    const index = Math.max(0, state.index - 1)
    return { state: { index, draft: state.draft }, text: history[index] }
  }
  if (state.index >= history.length - 1) {
    return { state: { index: null, draft: '' }, text: state.draft }
  }
  const index = state.index + 1
  return { state: { index, draft: state.draft }, text: history[index] }
}
