import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { buildToolAliases } from '../src/names.ts'
import { ClaudeStreamDecoder } from '../src/decoder.ts'

function fixture(name: string): string[] {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
  return readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0)
}

function decode(lines: readonly string[], names: readonly string[] = ['read', 'bash']): { decoder: ClaudeStreamDecoder; chunks: StreamChunk[] } {
  const decoder = new ClaudeStreamDecoder(buildToolAliases(names))
  const chunks: StreamChunk[] = []
  for (const line of lines) chunks.push(...decoder.push(line))
  return { decoder, chunks }
}

describe('stream decoder over recorded claude output', () => {
  it('turns a streamed MCP tool_use into tool-call chunks and a tool-calls finish', () => {
    const { decoder, chunks } = decode(fixture('native-tool-call.jsonl'))
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    const deltas = chunks.filter(chunk => chunk.type === 'tool-call-delta')
    expect(deltas[0]).toMatchObject({ index: 0, name: 'read', argumentsDelta: '' })
    expect(deltas.slice(1).every(chunk => chunk.type === 'tool-call-delta' && chunk.name === undefined)).toBe(true)
    const end = chunks.at(-1)
    expect(end).toMatchObject({ type: 'block-end', index: 0, block: { type: 'tool-call', name: 'read' } })
    const block = end?.type === 'block-end' && end.block.type === 'tool-call' ? end.block : undefined
    expect(block?.id).toMatch(/^toolu_/u)
    expect(JSON.parse(block?.arguments ?? '')).toEqual({ path: 'C:\\temp\\hello.txt' })

    expect(decoder.messageComplete).toBe(true)
    expect(decoder.stopReason).toBe('tool_use')
    expect(decoder.result).toBeUndefined()
    const terminal = decoder.terminalChunks()
    expect(terminal.map(chunk => chunk.type)).toEqual(['usage', 'finish'])
    expect(terminal[1]).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(terminal[0]).toMatchObject({
      type: 'usage',
      usage: { inputTokens: 2, cacheWriteTokens: 359, cacheReadTokens: 798, outputTokens: 63, reasoningTokens: 0, totalTokens: 1222 },
    })
  })

  it('maps the mcp__dsh__ prefix back to the DSH tool name', () => {
    const { chunks } = decode(fixture('mcp-tool-call.jsonl'))
    const end = chunks.find(chunk => chunk.type === 'block-end')
    expect(end).toMatchObject({ block: { type: 'tool-call', name: 'bash', arguments: '{"command": "dir C:\\\\temp"}' } })
  })

  it('maps an aliased tool back to its original name', () => {
    const names = ['web.search']
    const aliases = buildToolAliases(names)
    const line = (event: unknown): string => JSON.stringify({ type: 'stream_event', event })
    const { chunks } = decode([
      line({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }),
      line({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: `mcp__dsh__${aliases.aliasOf('web.search')}`, input: {} } }),
      line({ type: 'content_block_stop', index: 0 }),
      line({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 1, output_tokens: 3 } }),
      line({ type: 'message_stop' }),
    ], names)
    expect(chunks.find(chunk => chunk.type === 'block-end')).toMatchObject({ block: { name: 'web.search', arguments: '{}' } })
  })

  it('streams text and reads the stop reason, usage, and result of a plain answer', () => {
    const { decoder, chunks } = decode(fixture('text-after-tool-result.jsonl'))
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.type === 'text-delta' ? chunk.text : '').join('')
    expect(text).toBe('The first word is **"Greetings"**.\n\nThe full line reads: "Greetings from the test file. The code is 4711."')
    expect(chunks.at(-1)).toEqual({ type: 'block-end', index: 0, block: { type: 'text', text } })
    expect(decoder.stopReason).toBe('end_turn')
    expect(decoder.result).toMatchObject({ subtype: 'success', is_error: false })
    const terminal = decoder.terminalChunks()
    expect(terminal[1]).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(terminal[0]).toMatchObject({ type: 'usage', usage: { inputTokens: 2, outputTokens: 39, cacheWriteTokens: 1389, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 1430 } })
  })

  it('emits nothing for a thinking block that stayed empty but counts its tokens', () => {
    const { decoder, chunks } = decode(fixture('thinking-then-text.jsonl'))
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks.some(chunk => chunk.type === 'reasoning-delta')).toBe(false)
    expect(chunks.filter(chunk => chunk.type === 'block-start')).toHaveLength(1)
    expect(decoder.terminalChunks()[0]).toMatchObject({ usage: { outputTokens: 46, reasoningTokens: 43 } })
  })

  it('assembles into the expected message through the real BlockAssembler', () => {
    const { decoder, chunks } = decode(fixture('text-after-tool-result.jsonl'))
    const assembler = new BlockAssembler()
    for (const chunk of [...chunks, ...decoder.terminalChunks()]) assembler.push(chunk)
    const blocks = assembler.blocks()
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    expect(assembler.finish).toEqual({ kind: 'stop' })
  })

  it('streams non-empty thinking as a reasoning block with sequential indexes', () => {
    const line = (event: unknown): string => JSON.stringify({ type: 'stream_event', event })
    const { chunks } = decode([
      line({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
      line({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      line({ type: 'content_block_stop', index: 0 }),
      line({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }),
      line({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'hmm ' } }),
      line({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'ok' } }),
      line({ type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig' } }),
      line({ type: 'content_block_stop', index: 1 }),
      line({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
      line({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'done' } }),
      line({ type: 'content_block_stop', index: 2 }),
      line({ type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 't1', name: 'mcp__dsh__read', input: {} } }),
      line({ type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } }),
      line({ type: 'content_block_stop', index: 3 }),
      line({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 1, output_tokens: 9 } }),
      line({ type: 'message_stop' }),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'hmm ' },
      { type: 'reasoning-delta', index: 0, text: 'ok' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'hmm ok' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'done' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'done' } },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: 't1', name: 'read', argumentsDelta: '' },
      { type: 'tool-call-delta', index: 2, id: 't1', argumentsDelta: '{"a":1}' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: 't1', name: 'read', arguments: '{"a":1}' } },
    ])
  })

  it('maps every stop reason', () => {
    const finish = (stopReason: string): unknown => {
      const line = (event: unknown): string => JSON.stringify({ type: 'stream_event', event })
      const { decoder } = decode([
        line({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }),
        line({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { input_tokens: 1, output_tokens: 1 } }),
        line({ type: 'message_stop' }),
      ])
      return decoder.terminalChunks()[1]
    }
    for (const reason of ['end_turn', 'stop_sequence', 'pause_turn', 'refusal']) {
      expect(finish(reason)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    }
    expect(finish('tool_use')).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(finish('max_tokens')).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('ignores noise lines and events after the message completed', () => {
    const lines = fixture('text-after-tool-result.jsonl')
    const { decoder, chunks } = decode(['not json', '', '[1,2]', '{"type":"stream_event"}', ...lines, ...lines])
    expect(chunks.filter(chunk => chunk.type === 'block-start')).toHaveLength(1)
    expect(decoder.messageComplete).toBe(true)
  })

  it('falls back to the result text when no stream events arrived', () => {
    const { decoder, chunks } = decode(['{"type":"result","subtype":"success","is_error":false,"result":"plain answer","stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":4}}'])
    expect(chunks).toEqual([])
    expect(decoder.fallbackChunks()).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'plain answer' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'plain answer' } },
    ])
    expect(decoder.terminalChunks()[0]).toMatchObject({ usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } })
  })
})
