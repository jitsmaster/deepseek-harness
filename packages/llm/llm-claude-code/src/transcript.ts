/**
 * Text rendering of a DSH conversation for a stateless `claude -p` run. DSH
 * owns the history (compaction, forks), so each call hands Claude Code the
 * whole conversation as one transcript on stdin instead of a resumed session.
 * Content is escaped so a message can never forge transcript structure.
 * @module @deepseek-ai/dsh-llm-claude-code/transcript
 */

import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'

/** Explains the transcript convention; the DSH system prompt follows it in `system.txt`. */
export const TRANSCRIPT_PREFACE = [
  'The conversation so far is given to you as a transcript inside <conversation>; continue it as the assistant.',
  'It holds <user>, <assistant>, <developer> and <tool_result> turns.',
  'Earlier tool calls and their results appear as <tool_call> and <tool_result> elements: they are history,',
  'never write those elements yourself - call tools natively instead.',
].join(' ')

/** Closing line that asks for the next assistant turn. */
const CONTINUE_LINE = 'Continue as the assistant.'

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
 * Render the conversation as the `<conversation>` transcript sent on stdin.
 * System messages are not part of it (they become `system.txt`); reasoning of
 * earlier turns is omitted.
 * @param messages - the request messages in order.
 * @returns the transcript followed by the closing instruction.
 */
export function renderTranscript(messages: readonly RequestMessage[]): string {
  const toolNames = new Map<string, string>()
  const lines: string[] = ['<conversation>']
  for (const message of messages) {
    switch (message.role) {
      case 'user':
      case 'developer': {
        const body = textLines(message.content)
        if (body.length > 0) lines.push(...element(message.role, '', body))
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
        if (body.length > 0) lines.push(...element('assistant', '', body))
        break
      }
      case 'tool': {
        const name = toolNames.get(message.toolCallId) ?? 'unknown'
        const error = message.isError === true ? ' error="true"' : ''
        lines.push(...element('tool_result', ` id="${escapeAttribute(message.toolCallId)}" name="${escapeAttribute(name)}"${error}`, textLines(message.content)))
        break
      }
      default:
        break
    }
  }
  lines.push('</conversation>', '', CONTINUE_LINE)
  return lines.join('\n')
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
