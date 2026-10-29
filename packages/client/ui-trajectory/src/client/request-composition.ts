/**
 * Pure breakdown of one recorded LLM request payload into categories and items
 * for the Summary tab request breakdown. Bytes are exact; token counts are estimates
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
  /** Original byte length of `tools` when the writer dropped the list. */
  readonly toolsBytes?: number
}

export interface ComposedItem {
  readonly label: string
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
/** UTF-8 byte length without allocating an encoded copy; lone surrogates count as U+FFFD (3 bytes). */
function byteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
      && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4
      index++
    } else bytes += 3
  }
  return bytes
}

function item(label: string, text: string): ComposedItem {
  return { label, bytes: byteLength(text) }
}

/** An item whose size is already known, e.g. the original size of a truncated part. */
function sizedItem(label: string, bytes: number): ComposedItem {
  return { label, bytes }
}

/** Split the system file into the transcript convention and the DSH system prompt. */
function systemItems(payload: ComposableRequestPayload): { preface: ComposedItem[]; system: ComposedItem[] } {
  if (payload.truncated === true && payload.systemBytes !== undefined) {
    return { preface: [], system: [sizedItem('System prompt', payload.systemBytes)] }
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
    return [sizedItem('stdin', payload.stdinBytes)]
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
 * Measure a recorded request payload: preface, system prompt, tool schemas and
 * transcript elements, as byte sizes only (no item text is kept).
 * @param payload - the stored payload (possibly truncated).
 * @returns categories in display order with byte sizes and no token estimates.
 */
export function measureRequest(payload: ComposableRequestPayload): ComposedRequest {
  const { preface, system } = systemItems(payload)
  const tools = payload.truncated === true && payload.toolsBytes !== undefined && payload.tools.length === 0
    ? [sizedItem('Tools', payload.toolsBytes)]
    // Compact JSON approximates the schema size the provider receives; only truncated payloads record it exactly.
    : payload.tools.map(tool => item(
      tool.name,
      JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema }),
    ))
  const groups: readonly [ComposedCategoryId, ComposedItem[]][] = [
    ['preface', preface],
    ['system', system],
    ['tools', tools],
    ['transcript', transcriptItems(payload)],
  ]
  const categories = groups.map(([id, items]): ComposedCategory => ({
    id,
    bytes: items.reduce((sum, entry) => sum + entry.bytes, 0),
    items,
  }))
  return {
    categories,
    totalBytes: categories.reduce((sum, entry) => sum + entry.bytes, 0),
    ...payload.truncated === true ? { truncated: true as const } : {},
  }
}

/**
 * Attach token estimates to a measurement. Does not mutate measured.
 * @param measured - result of {@link measureRequest}.
 * @param reported - provider-reported usage; when given, items carry token estimates summing to its total.
 * @returns measured itself when no usage was reported, otherwise a copy with tokens.
 */
export function applyUsage(measured: ComposedRequest, reported?: ReportedUsage): ComposedRequest {
  if (reported === undefined) return measured
  const totalTokens = reported.input + reported.cacheRead + reported.cacheWrite
  const flat = measured.categories.flatMap(category => category.items)
  const tokenShares = shares(flat.map(entry => entry.bytes), totalTokens)
  let cursor = 0
  const categories = measured.categories.map((category): ComposedCategory => {
    const items = category.items.map((entry): ComposedItem => ({ ...entry, tokens: tokenShares[cursor++] as number }))
    return { id: category.id, bytes: category.bytes, tokens: items.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0), items }
  })
  return { ...measured, categories, totalTokens }
}

/**
 * Break a recorded request payload into the preface, system prompt, tool schemas
 * and transcript elements.
 * @param payload - the stored payload (possibly truncated).
 * @param reported - provider-reported usage; when given, items carry token estimates summing to its total.
 * @returns categories in display order with byte sizes and optional token estimates.
 */
export function composeRequest(payload: ComposableRequestPayload, reported?: ReportedUsage): ComposedRequest {
  return applyUsage(measureRequest(payload), reported)
}
