/**
 * Decoder for the `claude -p --output-format stream-json` events one headless
 * WebSearch run emits: the sources come from the WebSearch `tool_result`
 * `Links: [...]` array, the answer from the terminal `result` line.
 * @module @deepseek-ai/dsh-web-search-claude-code/stream
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'

/** Tool the run is restricted to and whose result carries the sources. */
export const WEB_SEARCH_TOOL = 'WebSearch'

/** Everything one run's stdout contributed. */
export interface SearchRun {
  /** `tool_use` ids of the WebSearch calls seen. */
  readonly searchIds: Set<string>
  /** Sources from every WebSearch result, in order, without duplicate URLs. */
  readonly sources: WebSearchSource[]
  /** Text of the first WebSearch `tool_result` flagged `is_error`. */
  searchError?: string
  /** Whether a WebSearch `tool_result` arrived. */
  searchResult: boolean
  /** The terminal `result` line, when seen. */
  result?: ResultLine
}

/** The `result` line fields this provider reads. */
export interface ResultLine {
  readonly subtype?: string
  readonly is_error?: boolean
  readonly result?: string
  readonly errors?: readonly string[]
}

/** @returns an empty accumulator for one run. */
export function newSearchRun(): SearchRun {
  return { searchIds: new Set(), sources: [], searchResult: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contentBlocks(event: Record<string, unknown>): Record<string, unknown>[] {
  const message = event.message
  if (!isRecord(message) || !Array.isArray(message.content)) return []
  return message.content.filter(isRecord)
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(isRecord)
    .map(block => typeof block.text === 'string' ? block.text : '')
    .join('')
}

/**
 * Parse the `Links: [{"title":..,"url":..}, ...]` line of a WebSearch result.
 * @param text - the tool_result text.
 * @returns the valid entries in order; empty when the line is absent or malformed.
 */
export function parseLinks(text: string): WebSearchSource[] {
  const match = /^Links: (\[.*\])[ \t]*$/mu.exec(text)
  if (match === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1] as string)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const sources: WebSearchSource[] = []
  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.url !== 'string' || entry.url.length === 0) continue
    sources.push({
      url: entry.url,
      ...typeof entry.title === 'string' && entry.title.length > 0 ? { title: entry.title } : {},
    })
  }
  return sources
}

/**
 * Fold one stdout line into the run. Blank, non-JSON, and unrecognized lines are ignored.
 * @param run - the accumulator.
 * @param line - one stdout line.
 */
export function readLine(run: SearchRun, line: string): void {
  if (!line.startsWith('{')) return
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return
  }
  if (!isRecord(event)) return
  if (event.type === 'assistant') {
    for (const block of contentBlocks(event)) {
      if (block.type === 'tool_use' && block.name === WEB_SEARCH_TOOL && typeof block.id === 'string') run.searchIds.add(block.id)
    }
  } else if (event.type === 'user') {
    for (const block of contentBlocks(event)) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string' || !run.searchIds.has(block.tool_use_id)) continue
      run.searchResult = true
      const text = toolResultText(block.content)
      if (block.is_error === true) {
        run.searchError ??= text
        continue
      }
      const seen = new Set(run.sources.map(source => source.url))
      for (const source of parseLinks(text)) {
        if (!seen.has(source.url)) {
          seen.add(source.url)
          run.sources.push(source)
        }
      }
    }
  } else if (event.type === 'result') {
    run.result = event
  }
}
