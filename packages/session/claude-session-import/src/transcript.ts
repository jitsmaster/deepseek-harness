/**
 * One reconstructed turn from a Claude Code CLI transcript, text-only.
 * Tool calls and results are folded into readable text by
 * {@link parseClaudeCodeTranscript} rather than kept structured — see
 * .agents/notes/proposed/architecture/2026-09-02-claude-code-session-import.md.
 */
export interface ImportedTurn {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

interface RawTextBlock {
  type: 'text'
  text: string
}

interface RawToolUseBlock {
  type: 'tool_use'
  name: string
  input: unknown
}

interface RawToolResultBlock {
  type: 'tool_result'
  content: unknown
}

type RawBlock = RawTextBlock | RawToolUseBlock | RawToolResultBlock | { type: string }

interface RawEntry {
  type: string
  message?: { role: string; content: RawBlock[] | string }
}

/** Render one non-text content block as a readable summary line. */
function summarizeBlock(block: RawBlock): string | undefined {
  if (block.type === 'text') return (block as RawTextBlock).text
  if (block.type === 'tool_use') {
    const use = block as RawToolUseBlock
    return `(ran \`${use.name}\` with ${JSON.stringify(use.input)})`
  }
  if (block.type === 'tool_result') {
    const result = block as RawToolResultBlock
    const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
    return `(tool result: ${text})`
  }
  // Unrecognized block shape: degrade to a text summary instead of failing
  // the import, per the spec's Approach C.
  return `(unrecognized event: ${block.type})`
}

/** One entry's message content flattened to one text string, blocks joined by blank lines. */
function textOf(content: RawBlock[] | string): string {
  if (typeof content === 'string') return content
  return content.map(summarizeBlock).filter((line): line is string => line !== undefined).join('\n\n')
}

/**
 * Parse a Claude Code CLI session transcript into flattened text turns.
 * @param jsonl - the transcript file's raw contents, one JSON object per line.
 * @returns user/assistant turns in transcript order; malformed lines are skipped.
 */
export function parseClaudeCodeTranscript(jsonl: string): readonly ImportedTurn[] {
  const turns: ImportedTurn[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim().length === 0) continue
    let entry: RawEntry
    try {
      entry = JSON.parse(line) as RawEntry
      if (entry.message === undefined) continue
      if (entry.message.role !== 'user' && entry.message.role !== 'assistant') continue
      const text = textOf(entry.message.content)
      if (text.trim().length === 0) continue
      turns.push({ role: entry.message.role, text })
    } catch {
      // Skip entries that fail JSON parsing or content extraction
      continue
    }
  }
  return turns
}

/**
 * Render reconstructed turns as one plain-text block, suitable as the sole
 * content of a single injected {@link import('@deepseek-ai/dsh-llm').UserMessage}.
 * @param turns - turns in transcript order.
 * @returns the turns joined as `"**User:** ...\n\n**Claude:** ..."`.
 */
export function renderImportedTranscript(turns: readonly ImportedTurn[]): string {
  return turns
    .map(turn => `**${turn.role === 'user' ? 'User' : 'Claude'}:** ${turn.text}`)
    .join('\n\n')
}
