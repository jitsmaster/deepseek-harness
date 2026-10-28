/**
 * Pure breakdown of one recorded LLM request payload into categories and items
 * for the Inspect request panel. Bytes are exact; token counts are estimates
 * that scale each item's share of the bytes to the usage the provider reported.
 */

import type { RequestPayload } from '@deepseek-ai/dsh-llm'

/** Usage the provider reported for the call. */
export interface ReportedUsage {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** A payload as stored: oversized ones replace `stdin`/`system` and record the original sizes. */
export type ComposableRequestPayload = RequestPayload & {
  readonly truncated?: true
  readonly stdinBytes?: number
  readonly systemBytes?: number
}

export interface ComposedItem {
  readonly label: string
  readonly text: string
  readonly bytes: number
  /** Estimated tokens; absent when no usage was reported. */
  readonly tokens?: number
}

export type ComposedCategoryId = 'preface' | 'system' | 'tools' | 'transcript'

export interface ComposedCategory {
  readonly id: ComposedCategoryId
  readonly bytes: number
  readonly tokens?: number
  readonly items: readonly ComposedItem[]
}

export interface ComposedRequest {
  readonly categories: readonly ComposedCategory[]
  readonly totalBytes: number
  /** Reported input + cache read + cache write; absent when no usage was reported. */
  readonly totalTokens?: number
  readonly truncated?: true
}

/** Start of the convention text the Claude Code adapter puts before the system prompt. */
const PREFACE_START = 'The user message you receive is a transcript of the conversation so far'
/** Opening tag of a transcript element: `<user>`, `<assistant>`, `<developer>`, `<tool_result ...>`. */
const ELEMENT_OPEN = /^\x3c(user|assistant|developer|tool_result)\b([^>]*)>/u
const NAME_ATTRIBUTE = /\bname="([^"]*)"/u
const encoder = new TextEncoder()

function byteLength(text: string): number {
  return encoder.encode(text).length
}

function item(label: string, text: string, bytes = byteLength(text)): ComposedItem {
  return { label, text, bytes }
}

/** Split the system file into the transcript convention and the DSH system prompt. */
function systemItems(payload: ComposableRequestPayload): { preface: ComposedItem[]; system: ComposedItem[] } {
  if (payload.truncated === true && payload.systemBytes !== undefined) {
    return { preface: [], system: [item('System prompt', payload.system, payload.systemBytes)] }
  }
  const text = payload.system
  if (text.length === 0) return { preface: [], system: [] }
  if (!text.startsWith(PREFACE_START)) return { preface: [], system: [item('System prompt', text)] }
  const split = text.indexOf('\n\n')
  if (split < 0) return { preface: [item('Transcript convention', text)], system: [] }
  const rest = text.slice(split + 2)
  return {
    preface: [item('Transcript convention', text.slice(0, split))],
    system: rest.length === 0 ? [] : [item('System prompt', rest)],
  }
}

function labelOf(text: string): string {
  const match = ELEMENT_OPEN.exec(text)
  if (match === null) return 'text'
  const role = match[1] as string
  if (role !== 'tool_result') return role
  const name = NAME_ATTRIBUTE.exec(match[2] ?? '')?.[1]
  return name === undefined ? role : `${role}: ${name}`
}

/** One item per text block of the stream-json user message; a raw item when stdin has another shape. */
function transcriptItems(payload: ComposableRequestPayload): ComposedItem[] {
  if (payload.truncated === true && payload.stdinBytes !== undefined) {
    return [item('stdin', payload.stdin, payload.stdinBytes)]
  }
  if (payload.stdin.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(payload.stdin)
    const content = (parsed as { message?: { content?: unknown } }).message?.content
    if (Array.isArray(content)) {
      const blocks = content.filter((block): block is { type: 'text'; text: string } => typeof block === 'object'
        && block !== null && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string')
      if (blocks.length > 0) return blocks.map(block => item(labelOf(block.text), block.text))
    }
  } catch {
    // Not the stream-json envelope: shown raw below.
  }
  return [item('stdin', payload.stdin)]
}

/**
 * Distribute `total` over `weights` so the integer shares sum exactly to `total`
 * (largest-remainder rounding). All-zero weights yield all-zero shares.
 */
function shares(weights: readonly number[], total: number): number[] {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
  if (weightSum === 0) return weights.map(() => 0)
  const raw = weights.map(weight => weight * total / weightSum)
  const floors = raw.map(Math.floor)
  let remaining = total - floors.reduce((sum, value) => sum + value, 0)
  const order = raw.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index)
  for (const { index } of order) {
    if (remaining <= 0) break
    floors[index] = (floors[index] as number) + 1
    remaining -= 1
  }
  return floors
}

/**
 * Break a recorded request payload into the preface, system prompt, tool schemas
 * and transcript elements.
 * @param payload - the stored payload (possibly truncated).
 * @param reported - provider-reported usage; when given, items carry token estimates summing to its total.
 * @returns categories in display order with byte sizes and optional token estimates.
 */
export function composeRequest(payload: ComposableRequestPayload, reported?: ReportedUsage): ComposedRequest {
  const { preface, system } = systemItems(payload)
  const tools = payload.tools.map(tool => item(
    tool.name,
    JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema }, null, 2),
  ))
  const groups: readonly [ComposedCategoryId, ComposedItem[]][] = [
    ['preface', preface],
    ['system', system],
    ['tools', tools],
    ['transcript', transcriptItems(payload)],
  ]
  const totalTokens = reported === undefined ? undefined : reported.input + reported.cacheRead + reported.cacheWrite
  const flat = groups.flatMap(([, items]) => items)
  const tokenShares = totalTokens === undefined ? undefined : shares(flat.map(entry => entry.bytes), totalTokens)
  let cursor = 0
  const categories = groups.map(([id, items]): ComposedCategory => {
    const withTokens = tokenShares === undefined
      ? items
      : items.map((entry): ComposedItem => ({ ...entry, tokens: tokenShares[cursor++] as number }))
    const bytes = withTokens.reduce((sum, entry) => sum + entry.bytes, 0)
    return tokenShares === undefined
      ? { id, bytes, items: withTokens }
      : { id, bytes, tokens: withTokens.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0), items: withTokens }
  })
  return {
    categories,
    totalBytes: categories.reduce((sum, entry) => sum + entry.bytes, 0),
    ...totalTokens === undefined ? {} : { totalTokens },
    ...payload.truncated === true ? { truncated: true as const } : {},
  }
}
