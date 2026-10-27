/**
 * Fake `claude -p` for the llm-claude-code specs. `harness.ts` routes the
 * adapter's spawn of the configured executable to `node fake-claude.cjs <the
 * real claude argv>`. This script reads the prompt from stdin, appends one JSON
 * record per run to `$FAKE_CLAUDE_LOG` (argv, cwd, the files the adapter wrote
 * into it, stdin, env), then prints canned stream-json chosen by the
 * `scenario:<word>` found in the prompt.
 */
'use strict'

const { appendFileSync, readdirSync, readFileSync } = require('node:fs')

const USAGE = { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 7, output_tokens_details: { thinking_tokens: 2 } }

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n')
}

function stream(event) {
  emit({ type: 'stream_event', event, session_id: 's' })
}

function messageStart() {
  stream({ type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [], usage: { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 1 } } })
}

function textBlock(index, parts) {
  stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
  for (const text of parts) stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
  stream({ type: 'content_block_stop', index })
}

function toolBlock(index, id, name, parts) {
  stream({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } })
  for (const partial_json of parts) stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })
  stream({ type: 'content_block_stop', index })
}

function messageEnd(stopReason) {
  stream({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: USAGE })
  stream({ type: 'message_stop' })
}

function success(result) {
  emit({ type: 'result', subtype: 'success', is_error: false, result, stop_reason: 'end_turn', usage: USAGE })
}

function hang() {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ hanging: process.pid }) + '\n')
  setInterval(() => {}, 1000)
}

/** Scenarios that end the process by themselves return normally; `hang` ones keep it alive. */
const scenarios = {
  text() {
    emit({ type: 'system', subtype: 'init' })
    messageStart()
    textBlock(0, ['Hello ', 'world'])
    messageEnd('end_turn')
    success('Hello world')
  },
  tool() {
    messageStart()
    toolBlock(0, 'toolu_1', 'mcp__dsh__read', ['', '{"path":', '"a.txt"}'])
    messageEnd('tool_use')
    hang()
  },
  multitool() {
    messageStart()
    textBlock(0, ['Reading both.'])
    toolBlock(1, 'toolu_1', 'mcp__dsh__read', ['{"path":"a"}'])
    toolBlock(2, 'toolu_2', 'mcp__dsh__bash', ['{"command":"ls"}'])
    messageEnd('tool_use')
    hang()
  },
  firsttool() {
    const tools = JSON.parse(readFileSync('tools.json', 'utf8'))
    messageStart()
    toolBlock(0, 'toolu_1', `mcp__dsh__${tools[0].name}`, ['{}'])
    messageEnd('tool_use')
    hang()
  },
  thinking() {
    messageStart()
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } })
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } })
    stream({ type: 'content_block_stop', index: 0 })
    textBlock(1, ['Answer'])
    messageEnd('end_turn')
    success('Answer')
  },
  maxtokens() {
    messageStart()
    textBlock(0, ['cut off'])
    messageEnd('max_tokens')
    success('cut off')
  },
  loggedout() {
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
    process.exitCode = 1
  },
  limited() {
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1793134800' })
    process.exitCode = 1
  },
  overloaded() {
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' })
    process.exitCode = 1
  },
  toolong() {
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long' })
    process.exitCode = 1
  },
  maxturns() {
    emit({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'] })
    process.exitCode = 1
  },
  exit3() {
    process.stderr.write('claude: something broke badly\n')
    process.exitCode = 3
  },
  noresult() {
    messageStart()
    textBlock(0, ['partial'])
    messageEnd('end_turn')
  },
  empty() {
    messageStart()
    messageEnd('end_turn')
    success('')
  },
  hang() {
    hang()
  },
  slowhang() {
    messageStart()
    textBlock(0, ['started'])
    hang()
  },
}

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { stdin += chunk })
process.stdin.on('end', () => {
  const read = name => { try { return readFileSync(name, 'utf8') } catch { return undefined } }
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    cwdEntries: readdirSync(process.cwd()).sort(),
    files: { system: read('system.txt'), tools: read('tools.json'), mcp: read('mcp.json') },
    stdin,
    maxOutputTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    apiKey: process.env.ANTHROPIC_API_KEY,
  }) + '\n')
  const word = /scenario:(\w+)/.exec(stdin)?.[1] ?? 'text'
  scenarios[word]()
  if (word === 'tool' || word === 'multitool' || word === 'firsttool' || word === 'hang' || word === 'slowhang') return
  // Let buffered stdout flush, then end with the scenario's exit code.
  process.stdout.write('', () => process.exit(process.exitCode ?? 0))
})
