/**
 * Decoder for the `claude -p --output-format stream-json --include-partial-messages`
 * stdout of one run: the `stream_event` lines become DSH stream chunks and the
 * terminal `result` line is kept for failure classification. Claude's block
 * indexes are remapped to DSH's sequential first-emitted order, and a thinking
 * block that stays empty (Claude streams only a signature) produces nothing.
 * @module @deepseek-ai/dsh-llm-claude-code/decoder
 */

import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { MCP_TOOL_PREFIX } from './names.ts'
import type { ToolAliases } from './names.ts'

/** Cumulative usage counters as Claude reports them. */
interface ClaudeUsage {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
  output_tokens_details?: { thinking_tokens?: number }
}

/** The terminal `result` line fields this adapter reads. */
export interface ResultLine {
  readonly subtype?: string
  readonly is_error?: boolean
  readonly result?: string
  readonly errors?: readonly string[]
  readonly stop_reason?: string
  readonly usage?: ClaudeUsage
}

/** One plan-usage window: `utilization` is a 0..1 fraction, `resetsAt` epoch seconds. */
export interface RateLimitWindow {
  readonly utilization: number
  readonly resetsAt: number
}

/** The latest plan-usage reading of a run (only the windows Claude reported well-formed). */
export interface RateLimitReading {
  readonly fiveHour?: RateLimitWindow
  readonly sevenDay?: RateLimitWindow
}

/** Claude-side state of one open content block. */
interface OpenBlock {
  kind: 'text' | 'thinking' | 'tool' | 'ignored'
  /** DSH index once the block was announced; thinking and text announce lazily on their first text. */
  dsh?: number
  text: string
  id: string
  name: string
  args: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function windowOf(value: unknown): RateLimitWindow | undefined {
  if (!isRecord(value)) return undefined
  const utilization = numberOf(value.utilization)
  const resetsAt = numberOf(value.resetsAt)
  return utilization === undefined || resetsAt === undefined ? undefined : { utilization, resetsAt }
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function finishReasonOf(stopReason: string | undefined): FinishReason {
  if (stopReason === 'tool_use') return { kind: 'tool-calls' }
  if (stopReason === 'max_tokens') return { kind: 'max-tokens' }
  return { kind: 'stop' }
}

/** Stateful decoder for one run; feed it stdout lines in order. */
export class ClaudeStreamDecoder {
  /** The terminal `result` line, once it arrived. */
  result: ResultLine | undefined
  /** Whether the assistant message reached `message_stop`. */
  messageComplete = false
  /** Claude's stop reason of the message (`end_turn`, `tool_use`, ...), once known. */
  stopReason: string | undefined
  /** Whether any DSH block was announced. */
  hasContent = false
  /** The latest well-formed plan-usage reading from a `rate_limit_event` line, if any arrived. */
  rateLimit: RateLimitReading | undefined

  private readonly open = new Map<number, OpenBlock>()
  private nextIndex = 0
  private usage: ClaudeUsage | undefined

  constructor(private readonly aliases: ToolAliases) {}

  /**
   * Decode one stdout line.
   * @param line - a stdout line; anything that is not a known JSON event is ignored.
   * @returns the content chunks this line produced (never usage or finish).
   */
  push(line: string): StreamChunk[] {
    if (!line.startsWith('{')) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return []
    }
    if (!isRecord(parsed)) return []
    if (parsed.type === 'result') {
      this.result = parsed
      return []
    }
    if (parsed.type === 'rate_limit_event') {
      this.captureRateLimit(parsed.rate_limit_info)
      return []
    }
    if (parsed.type !== 'stream_event' || !isRecord(parsed.event) || this.messageComplete) return []
    return this.event(parsed.event)
  }

  /**
   * The usage and finish chunks that end the call.
   * @returns `[usage, finish]` for the message that completed (or the result line when no message did).
   */
  terminalChunks(): StreamChunk[] {
    const raw = this.usage ?? this.result?.usage ?? {}
    const input = numberOf(raw.input_tokens)
    const output = numberOf(raw.output_tokens)
    const cacheRead = numberOf(raw.cache_read_input_tokens)
    const cacheWrite = numberOf(raw.cache_creation_input_tokens)
    const reasoning = numberOf(raw.output_tokens_details?.thinking_tokens)
    const usage: TokenUsage = {
      inputTokens: input ?? 0,
      outputTokens: output ?? 0,
      ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
      ...cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite },
      ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
      ...input !== undefined && output !== undefined ? { totalTokens: input + output + (cacheRead ?? 0) + (cacheWrite ?? 0) } : {},
    }
    return [
      { type: 'usage', usage },
      { type: 'finish', reason: finishReasonOf(this.stopReason ?? this.result?.stop_reason) },
    ]
  }

  /**
   * Chunks for a successful run whose answer arrived only on the `result` line.
   * @returns a single text block, or nothing when content was streamed or the result has no text.
   */
  fallbackChunks(): StreamChunk[] {
    const text = this.result?.result
    if (this.hasContent || this.result?.is_error === true || typeof text !== 'string' || text.length === 0) return []
    this.hasContent = true
    return [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
    ]
  }

  private captureRateLimit(info: unknown): void {
    if (!isRecord(info) || !isRecord(info.unifiedWindows)) return
    const fiveHour = windowOf(info.unifiedWindows.five_hour)
    const sevenDay = windowOf(info.unifiedWindows.seven_day)
    if (fiveHour === undefined && sevenDay === undefined) return
    this.rateLimit = {
      ...fiveHour === undefined ? {} : { fiveHour },
      ...sevenDay === undefined ? {} : { sevenDay },
    }
  }

  private announce(block: OpenBlock, blockType: 'text' | 'reasoning'): StreamChunk {
    block.dsh = this.nextIndex++
    this.hasContent = true
    return { type: 'block-start', index: block.dsh, blockType }
  }

  private event(event: Record<string, unknown>): StreamChunk[] {
    switch (event.type) {
      case 'message_start': {
        const message = event.message
        if (isRecord(message) && isRecord(message.usage)) this.usage = message.usage
        return []
      }
      case 'content_block_start':
        return this.blockStart(numberOf(event.index), event.content_block)
      case 'content_block_delta':
        return this.blockDelta(numberOf(event.index), event.delta)
      case 'content_block_stop':
        return this.blockStop(numberOf(event.index))
      case 'message_delta': {
        const delta = event.delta
        if (isRecord(delta) && typeof delta.stop_reason === 'string') this.stopReason = delta.stop_reason
        if (isRecord(event.usage)) this.usage = { ...this.usage, ...event.usage as ClaudeUsage }
        return []
      }
      case 'message_stop':
        this.messageComplete = true
        return []
      default:
        return []
    }
  }

  private toolName(claudeName: string): string {
    return claudeName.startsWith(MCP_TOOL_PREFIX) ? this.aliases.nameOf(claudeName.slice(MCP_TOOL_PREFIX.length)) : claudeName
  }

  private blockStart(index: number | undefined, content: unknown): StreamChunk[] {
    if (index === undefined || !isRecord(content)) return []
    const block: OpenBlock = { kind: 'ignored', text: '', id: '', name: '', args: '' }
    this.open.set(index, block)
    if (content.type === 'text') {
      block.kind = 'text'
      return this.blockDelta(index, { type: 'text_delta', text: content.text })
    }
    if (content.type === 'thinking') {
      block.kind = 'thinking'
      return this.blockDelta(index, { type: 'thinking_delta', thinking: content.thinking })
    }
    if (content.type === 'tool_use') {
      block.kind = 'tool'
      block.id = stringOf(content.id)
      block.name = this.toolName(stringOf(content.name))
      block.dsh = this.nextIndex++
      this.hasContent = true
      return [
        { type: 'block-start', index: block.dsh, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: block.dsh, id: ToolCallId(block.id), name: block.name, argumentsDelta: '' },
      ]
    }
    return []
  }

  private blockDelta(index: number | undefined, delta: unknown): StreamChunk[] {
    const block = index === undefined ? undefined : this.open.get(index)
    if (block === undefined || !isRecord(delta)) return []
    if (block.kind === 'text' && delta.type === 'text_delta') {
      const text = stringOf(delta.text)
      if (text.length === 0) return []
      const chunks: StreamChunk[] = block.dsh === undefined ? [this.announce(block, 'text')] : []
      block.text += text
      chunks.push({ type: 'text-delta', index: block.dsh as number, text })
      return chunks
    }
    if (block.kind === 'thinking' && delta.type === 'thinking_delta') {
      const text = stringOf(delta.thinking)
      if (text.length === 0) return []
      const chunks: StreamChunk[] = block.dsh === undefined ? [this.announce(block, 'reasoning')] : []
      block.text += text
      chunks.push({ type: 'reasoning-delta', index: block.dsh as number, text })
      return chunks
    }
    if (block.kind === 'tool' && delta.type === 'input_json_delta') {
      const partial = stringOf(delta.partial_json)
      if (partial.length === 0) return []
      block.args += partial
      return [{ type: 'tool-call-delta', index: block.dsh as number, id: ToolCallId(block.id), argumentsDelta: partial }]
    }
    return []
  }

  private blockStop(index: number | undefined): StreamChunk[] {
    const block = index === undefined ? undefined : this.open.get(index)
    if (index === undefined || block === undefined) return []
    this.open.delete(index)
    if (block.dsh === undefined) return []
    switch (block.kind) {
      case 'text':
        return [{ type: 'block-end', index: block.dsh, block: { type: 'text', text: block.text } }]
      case 'thinking':
        return [{ type: 'block-end', index: block.dsh, block: { type: 'reasoning', text: block.text } }]
      case 'tool':
        return [{
          type: 'block-end',
          index: block.dsh,
          block: { type: 'tool-call', id: ToolCallId(block.id), name: block.name, arguments: block.args.length > 0 ? block.args : '{}' },
        }]
      default:
        return []
    }
  }
}
