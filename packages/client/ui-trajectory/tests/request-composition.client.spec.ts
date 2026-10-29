import { describe, expect, it } from 'vitest'
import type { RequestPayload } from '@deepseek-ai/dsh-llm'
import { applyUsage, composeRequest, measureRequest } from '../src/client/request-composition.ts'

const LT = String.fromCharCode(60)
const PREFACE = 'The user message you receive is a transcript of the conversation so far, one element per content block; continue it as the assistant.'
const bytes = (text: string): number => new TextEncoder().encode(text).length

/** One transcript element exactly as the Claude Code adapter renders it. */
function element(tag: string, attributes: string, body: string): string {
  return `${LT}${tag}${attributes}>\n${body}\n${LT}/${tag}>`
}

/** Build the stdin line the Claude Code adapter writes: one text block per transcript element. */
function stdinOf(blocks: readonly string[]): string {
  const content = blocks.map(text => ({ type: 'text', text }))
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`
}

function payload(over: Partial<RequestPayload> = {}): RequestPayload {
  return {
    argv: ['claude', '-p'],
    envKeys: ['PATH'],
    system: `${PREFACE}\n\nYou are DSH.`,
    tools: [
      { name: 'mcp__dsh__read', description: 'Read a file', inputSchema: { type: 'object' } },
      { name: 'mcp__dsh__write', description: 'Write a file', inputSchema: { type: 'object' } },
    ],
    stdin: stdinOf([
      element('user', '', 'hello'),
      element('assistant', '', `hi ${LT}tool_call id="t1" name="read">{}${LT}/tool_call>`),
      element('tool_result', ' id="t1" name="read"', 'file text'),
    ]),
    ...over,
  }
}

function category(result: ReturnType<typeof composeRequest>, id: string) {
  const found = result.categories.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`no category ${id}`)
  return found
}

describe('composeRequest', () => {
  it('returns the four categories in order', () => {
    expect(composeRequest(payload()).categories.map(candidate => candidate.id))
      .toEqual(['preface', 'system', 'tools', 'transcript'])
  })

  it('splits the transcript preface from the system prompt', () => {
    const result = composeRequest(payload())
    expect(category(result, 'preface').items[0]?.bytes).toBe(bytes(PREFACE))
    expect(category(result, 'system').items[0]?.bytes).toBe(bytes('You are DSH.'))
  })

  it('keeps the whole system text as system when there is no preface', () => {
    const result = composeRequest(payload({ system: 'plain prompt' }))
    expect(category(result, 'preface').items).toEqual([])
    expect(category(result, 'system').items[0]?.bytes).toBe(bytes('plain prompt'))
  })

  it('makes one tool item per schema', () => {
    const tools = category(composeRequest(payload()), 'tools')
    expect(tools.items.map(item => item.label)).toEqual(['mcp__dsh__read', 'mcp__dsh__write'])
    expect(tools.items[0]?.bytes).toBeGreaterThan(bytes('Read a file'))
  })

  it('splits stdin into one item per transcript element, labelled by role', () => {
    const transcript = category(composeRequest(payload()), 'transcript')
    expect(transcript.items.map(item => item.label)).toEqual(['user', 'assistant', 'tool_result: read'])
    expect(transcript.items[0]?.bytes).toBe(bytes(element('user', '', 'hello')))
  })

  it('carries sizes only, never the item text', () => {
    for (const entry of composeRequest(payload()).categories) {
      for (const item of entry.items) expect(item).not.toHaveProperty('text')
    }
  })

  it('counts UTF-8 bytes of multi-byte text, surrogate pairs and lone surrogates exactly', () => {
    const text = `é日本語😀${String.fromCharCode(0xd800)}x`
    const result = composeRequest(payload({ system: text }))
    expect(category(result, 'system').items[0]?.bytes).toBe(bytes(text))
  })

  it('sums items to their category and categories to the total', () => {
    const result = composeRequest(payload())
    for (const entry of result.categories) {
      expect(entry.items.reduce((sum, item) => sum + item.bytes, 0)).toBe(entry.bytes)
    }
    expect(result.totalBytes).toBe(result.categories.reduce((sum, entry) => sum + entry.bytes, 0))
  })

  it('reports bytes only when no usage is supplied', () => {
    const result = composeRequest(payload())
    expect(result.totalTokens).toBeUndefined()
    for (const entry of result.categories) {
      expect(entry.tokens).toBeUndefined()
      for (const item of entry.items) expect(item.tokens).toBeUndefined()
    }
  })

  it('scales token estimates so they sum to the reported input plus cache read and write', () => {
    const result = composeRequest(payload(), { input: 100, cacheRead: 2000, cacheWrite: 53 })
    expect(result.totalTokens).toBe(2153)
    const items = result.categories.flatMap(entry => entry.items)
    expect(items.reduce((sum, item) => sum + (item.tokens ?? 0), 0)).toBe(2153)
    for (const entry of result.categories) {
      expect(entry.tokens).toBe(entry.items.reduce((sum, item) => sum + (item.tokens ?? 0), 0))
    }
    const biggest = [...items].sort((left, right) => right.bytes - left.bytes)[0]
    const smallest = [...items].sort((left, right) => left.bytes - right.bytes)[0]
    expect(biggest?.tokens ?? 0).toBeGreaterThanOrEqual(smallest?.tokens ?? 0)
  })

  it('falls back to one raw item when stdin is not the stream-json envelope', () => {
    const transcript = category(composeRequest(payload({ stdin: 'not json' })), 'transcript')
    expect(transcript.items).toHaveLength(1)
    expect(transcript.items[0]).toMatchObject({ label: 'stdin', bytes: bytes('not json') })
  })

  it('uses the original sizes for a truncated payload', () => {
    const truncated = {
      ...payload({ stdin: '[stdin omitted: 9000 bytes]' }),
      truncated: true as const,
      stdinBytes: 9000,
    }
    const result = composeRequest(truncated)
    expect(result.truncated).toBe(true)
    const transcript = category(result, 'transcript')
    expect(transcript.bytes).toBe(9000)
    expect(transcript.items).toHaveLength(1)
    expect(transcript.items[0]?.bytes).toBe(9000)
  })

  it('keeps the original size of tool definitions the writer dropped', () => {
    const truncated = {
      ...payload({ tools: [] }),
      truncated: true as const,
      toolsBytes: 7000,
    }
    const tools = category(composeRequest(truncated), 'tools')
    expect(tools.bytes).toBe(7000)
    expect(tools.items).toHaveLength(1)
    expect(tools.items[0]).toMatchObject({ label: 'Tools', bytes: 7000 })
  })

  it('handles an empty payload without throwing', () => {
    const empty = payload({ system: '', tools: [], stdin: '' })
    expect(composeRequest(empty).totalBytes).toBe(0)
    expect(composeRequest(empty, { input: 1, cacheRead: 0, cacheWrite: 0 }).totalTokens).toBe(1)
  })
})

describe('measureRequest and applyUsage', () => {
  it('measures sizes without tokens', () => {
    const measured = measureRequest(payload())
    expect(measured.totalTokens).toBeUndefined()
    expect(measured.totalBytes).toBeGreaterThan(0)
  })

  it('applying usage to a measurement equals composing with that usage', () => {
    const usage = { input: 100, cacheRead: 2000, cacheWrite: 53 }
    expect(applyUsage(measureRequest(payload()), usage)).toEqual(composeRequest(payload(), usage))
  })

  it('returns the measurement unchanged when no usage was reported', () => {
    const measured = measureRequest(payload())
    expect(applyUsage(measured)).toBe(measured)
  })

  it('does not mutate the measurement, so new usage can be applied later', () => {
    const measured = measureRequest(payload())
    const first = applyUsage(measured, { input: 10, cacheRead: 0, cacheWrite: 0 })
    const second = applyUsage(measured, { input: 500, cacheRead: 0, cacheWrite: 0 })
    expect(first.totalTokens).toBe(10)
    expect(second.totalTokens).toBe(500)
    expect(measured.totalTokens).toBeUndefined()
  })
})
