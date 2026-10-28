/**
 * Text rendering of a DSH conversation for a stateless `claude -p` run. DSH
 * owns the history (compaction, forks), so each call hands Claude Code the
 * whole conversation as one transcript on stdin instead of a resumed session.
 * Content is escaped so a message can never forge transcript structure.
 * @module @deepseek-ai/dsh-llm-claude-code/transcript
 */

import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'

/**
 * Explains the transcript convention; the DSH system prompt follows it in `system.txt`.
 * The request to continue lives here, not after the transcript: the transcript must end on
 * its own last element so that the previous call's cached prefix is still a prefix of this one.
 */
export const TRANSCRIPT_PREFACE = [
  'The user message you receive is a transcript of the conversation so far, one element per content block;',
  'continue it as the assistant with the next assistant turn.',
  'It holds <user>, <assistant>, <developer> and <tool_result> turns.',
  'Earlier tool calls and their results appear as <tool_call> and <tool_result> elements: they are history,',
  'never write those elements yourself - call tools natively instead.',
].join(' ')

/** Stands in for a conversation that has no renderable turn, so the user message is never empty. */
const EMPTY_TRANSCRIPT = '(The conversation is empty.)'

const IMAGE_PLACEHOLDER = '[image omitted: this route reads text only]'
const FILE_PLACEHOLDER = '[file omitted: this route reads text only]'

/** The `<` of any tag name the transcript itself uses; escaping only these keeps ordinary markup readable. */
const RESERVED_TAG_OPEN = /<(?=\/?(?:conversation|user|assistant|developer|tool_call|tool_result)(?:[\s>/]|$))/giu

function escapeContent(text: string): string {
  return text.replace(RESERVED_TAG_OPEN, '&lt;')
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/** Visible text lines of a block list; tool calls, reasoning, and tool-change blocks are not text. */
function textLines(content: readonly ContentBlock[]): string[] {
  const lines: string[] = []
  for (const block of content) {
    if (block.type === 'text') lines.push(escapeContent(block.text))
    else if (block.type === 'image') lines.push(IMAGE_PLACEHOLDER)
    else if (block.type === 'file') lines.push(FILE_PLACEHOLDER)
  }
  return lines
}

function element(tag: string, attributes: string, lines: readonly string[]): string[] {
  return [`<${tag}${attributes}>`, ...lines, `</${tag}>`]
}

/**
 * Render the conversation as transcript elements, one per turn.
 * System messages are not part of it (they become `system.txt`); reasoning of
 * earlier turns is omitted. Each element becomes its own content block of the
 * stdin user message (see `renderStdin`): Anthropic's prompt cache matches a
 * previous call's prefix only at block boundaries, so a history sent as one
 * growing text block is never read back from cache.
 * @param messages - the request messages in order.
 * @returns the elements in order; the same history always renders to the same leading elements.
 */
export function renderTranscriptBlocks(messages: readonly RequestMessage[]): string[] {
  const toolNames = new Map<string, string>()
  const blocks: string[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'user':
      case 'developer': {
        const body = textLines(message.content)
        if (body.length > 0) blocks.push(element(message.role, '', body).join('\n'))
        break
      }
      case 'assistant': {
        const body: string[] = []
        for (const block of message.content) {
          if (block.type === 'tool-call') {
            toolNames.set(block.id, block.name)
            body.push(`<tool_call id="${escapeAttribute(block.id)}" name="${escapeAttribute(block.name)}">${escapeContent(block.arguments)}</tool_call>`)
          } else {
            body.push(...textLines([block]))
          }
        }
        if (body.length > 0) blocks.push(element('assistant', '', body).join('\n'))
        break
      }
      case 'tool': {
        const name = toolNames.get(message.toolCallId) ?? 'unknown'
        const error = message.isError === true ? ' error="true"' : ''
        blocks.push(element('tool_result', ` id="${escapeAttribute(message.toolCallId)}" name="${escapeAttribute(name)}"${error}`, textLines(message.content)).join('\n'))
        break
      }
      default:
        break
    }
  }
  return blocks
}

/**
 * The stdin of one run: a single `--input-format stream-json` user message whose
 * content has one text block per transcript element.
 * @param messages - the request messages in order.
 * @returns one JSON line, newline-terminated.
 */
export function renderStdin(messages: readonly RequestMessage[]): string {
  const blocks = renderTranscriptBlocks(messages)
  const content = (blocks.length > 0 ? blocks : [EMPTY_TRANSCRIPT]).map(text => ({ type: 'text', text }))
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`
}

/**
 * Compose the system prompt file: the transcript convention, then the DSH system prompt.
 * @param options - the request; its leading system message wins over `system`.
 * @returns the text of `system.txt`.
 */
export function renderSystemText(options: Pick<GenerateOptions, 'messages' | 'system'>): string {
  const leading = options.messages[0]
  const fromMessage = leading?.role === 'system'
    ? leading.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    : ''
  const prompt = fromMessage.length > 0 ? fromMessage : options.system ?? ''
  return prompt.length > 0 ? `${TRANSCRIPT_PREFACE}\n\n${prompt}` : TRANSCRIPT_PREFACE
}
