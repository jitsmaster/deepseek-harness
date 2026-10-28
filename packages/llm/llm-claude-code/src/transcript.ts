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

/** Stands in for an image whose bytes were not resolved for this request. */
const IMAGE_PLACEHOLDER = '[image omitted: its bytes were not available to this request]'
const FILE_PLACEHOLDER = '[file omitted: this route reads text only]'

/** The durable reference of an image block. */
export type ImageRef = Extract<ContentBlock, { type: 'image' }>['attachment']

/** One image resolved for the request: base64 bytes with their media type. */
export interface RequestImage {
  mediaType: string
  /** Base64 of the encoded request bytes. */
  data: string
}

/** Finds the resolved bytes of an image reference; `undefined` renders the placeholder text. */
export type ImageLookup = (ref: ImageRef) => RequestImage | undefined

/** One content block of the stdin user message (a stream-json content block). */
export type StdinPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** A line of an element: text, or a resolved image that ends the surrounding text block. */
type Line = string | RequestImage

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

/** Visible lines of a block list; tool calls, reasoning, and tool-change blocks are not text. */
function textLines(content: readonly ContentBlock[], images: ImageLookup | undefined): Line[] {
  const lines: Line[] = []
  for (const block of content) {
    if (block.type === 'text') {
      lines.push(escapeContent(block.text))
    } else if (block.type === 'image') {
      lines.push(images?.(block.attachment) ?? IMAGE_PLACEHOLDER)
    } else if (block.type === 'file') {
      lines.push(FILE_PLACEHOLDER)
    }
  }
  return lines
}

/** One transcript element as content blocks: consecutive text lines share a block, an image is its own block. */
function element(tag: string, attributes: string, lines: readonly Line[]): StdinPart[] {
  const parts: StdinPart[] = []
  let text: string[] = []
  const flush = (): void => {
    if (text.length === 0) return
    parts.push({ type: 'text', text: text.join('\n') })
    text = []
  }
  text.push(`<${tag}${attributes}>`)
  for (const line of lines) {
    if (typeof line === 'string') {
      text.push(line)
    } else {
      flush()
      parts.push({ type: 'image', source: { type: 'base64', media_type: line.mediaType, data: line.data } })
    }
  }
  text.push(`</${tag}>`)
  flush()
  return parts
}

/** Every transcript element as its content blocks; see `renderTranscriptBlocks`. */
function renderElements(messages: readonly RequestMessage[], images: ImageLookup | undefined): StdinPart[][] {
  const toolNames = new Map<string, string>()
  const blocks: StdinPart[][] = []
  for (const message of messages) {
    switch (message.role) {
      case 'user':
      case 'developer': {
        const body = textLines(message.content, images)
        if (body.length > 0) blocks.push(element(message.role, '', body))
        break
      }
      case 'assistant': {
        const body: Line[] = []
        for (const block of message.content) {
          if (block.type === 'tool-call') {
            toolNames.set(block.id, block.name)
            body.push(`<tool_call id="${escapeAttribute(block.id)}" name="${escapeAttribute(block.name)}">${escapeContent(block.arguments)}</tool_call>`)
          } else {
            body.push(...textLines([block], images))
          }
        }
        if (body.length > 0) blocks.push(element('assistant', '', body))
        break
      }
      case 'tool': {
        const name = toolNames.get(message.toolCallId) ?? 'unknown'
        const error = message.isError === true ? ' error="true"' : ''
        blocks.push(element('tool_result', ` id="${escapeAttribute(message.toolCallId)}" name="${escapeAttribute(name)}"${error}`, textLines(message.content, images)))
        break
      }
      default:
        break
    }
  }
  return blocks
}

/**
 * Render the conversation as transcript elements, one per turn.
 * System messages are not part of it (they become `system.txt`); reasoning of
 * earlier turns is omitted. Each element becomes its own content block of the
 * stdin user message (see `renderStdin`): Anthropic's prompt cache matches a
 * previous call's prefix only at block boundaries, so a history sent as one
 * growing text block is never read back from cache. Images appear as their
 * placeholder text here; `renderStdin` sends the real image blocks.
 * @param messages - the request messages in order.
 * @returns the elements in order; the same history always renders to the same leading elements.
 */
export function renderTranscriptBlocks(messages: readonly RequestMessage[]): string[] {
  return renderElements(messages, undefined).map(parts => parts.map(part => part.type === 'text' ? part.text : '').join('\n'))
}

/**
 * The content blocks of the stdin message: one text block per transcript element,
 * with each resolved image as its own image block inside its element.
 * @param messages - the request messages in order.
 * @param images - resolves an image reference to its bytes; an image it does not resolve renders as placeholder text.
 * @param redact - replace each image block with a text note of its type and size (for the inspected payload).
 * @returns the content blocks in order; never empty.
 */
export function renderStdinParts(messages: readonly RequestMessage[], images?: ImageLookup, redact = false): StdinPart[] {
  const parts = renderElements(messages, images).flat()
  if (parts.length === 0) return [{ type: 'text', text: EMPTY_TRANSCRIPT }]
  if (!redact) return parts
  // The inspected copy names each image and leaves its base64 out: it would dwarf the rest of the request.
  return parts.map((part): StdinPart => part.type === 'image'
    ? { type: 'text', text: `[image ${part.source.media_type}, ${Math.floor(part.source.data.length * 3 / 4)} bytes sent as an image block]` }
    : part)
}

/**
 * The stdin of one run: a single `--input-format stream-json` user message whose
 * content has one text block per transcript element, plus an image block per resolved image.
 * @param messages - the request messages in order.
 * @param images - resolves an image reference to its bytes.
 * @returns one JSON line, newline-terminated.
 */
export function renderStdin(messages: readonly RequestMessage[], images?: ImageLookup, redact = false): string {
  const content = renderStdinParts(messages, images, redact)
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
