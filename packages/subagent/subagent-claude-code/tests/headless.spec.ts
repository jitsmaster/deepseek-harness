import { describe, expect, it } from 'vitest'
import { consumeHeadlessLines, headlessArgv, SUBAGENT_SYSTEM_PROMPT, successfulHeadlessResult, type HeadlessRunSpec } from '../src/headless.ts'

const spec = (over: Partial<HeadlessRunSpec> = {}): HeadlessRunSpec => ({
  executable: 'C:/u/claude.exe',
  cwd: '/w',
  permissionMode: 'dontAsk',
  env: {},
  disposeGraceMs: 1000,
  spawn: () => { throw new Error('unused') },
  ...over,
})

async function* lines(...values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value
}

describe('headless claude -p', () => {
  it('builds the fixed argv with the task kept off the command line', () => {
    expect(headlessArgv(spec())).toEqual([
      'C:/u/claude.exe', '-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--system-prompt', SUBAGENT_SYSTEM_PROMPT,
      '--settings', '{"disableAllHooks":true}',
      '--permission-mode', 'dontAsk', '--disallowedTools', 'AskUserQuestion',
    ])
  })

  it('switches the user\'s Claude Code hooks off but leaves permission rules, CLAUDE.md, MCP servers and skills loading', () => {
    const argv = headlessArgv(spec())
    expect(JSON.parse(argv[argv.indexOf('--settings') + 1] as string)).toEqual({ disableAllHooks: true })
    // A SPARC brief tells the child to start with Skill(modes:<slug>): the Skill tool must stay available.
    expect(argv).not.toContain('--disable-slash-commands')
    expect(argv).not.toContain('--setting-sources')
    expect(argv).not.toContain('--strict-mcp-config')
  })

  it('replaces Claude Code\'s own system prompt with the short DSH one, never appending to it', () => {
    const argv = headlessArgv(spec())
    expect(argv).not.toContain('--append-system-prompt')
    expect(SUBAGENT_SYSTEM_PROMPT).toMatch(/^You are a Claude Code delegate working for DSH/)
    expect(SUBAGENT_SYSTEM_PROMPT.length).toBeLessThan(700)
  })

  it('adds the model and plan-mode tool denials', () => {
    const argv = headlessArgv(spec({ model: 'opus', permissionMode: 'plan' }))
    expect(argv.slice(-2)).toEqual(['--model', 'opus'])
    expect(argv).toContain('AskUserQuestion,ExitPlanMode')
  })

  it('completes with the final result text', async () => {
    const result = await consumeHeadlessLines(lines(
      '{"type":"system","subtype":"init"}',
      'not json',
      '{"type":"result","subtype":"success","is_error":false,"result":"done"}',
    ))
    expect(result).toEqual({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' })
  })

  it('rejects a stream without a result line', async () => {
    await expect(consumeHeadlessLines(lines('{"type":"system"}'))).rejects.toThrow(/invalid-result/)
  })

  it('passes a requested output schema to the CLI as one compact argument', () => {
    const schema: NonNullable<Parameters<typeof headlessArgv>[1]> = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] }
    const argv = headlessArgv(spec({ model: 'opus' }), schema)
    expect(argv.slice(-2)).toEqual(['--json-schema', JSON.stringify(schema)])
    expect(argv).toContain('opus')
    expect(headlessArgv(spec())).not.toContain('--json-schema')
  })

  it('returns the structured object of a schema-bound success', async () => {
    const result = await consumeHeadlessLines(lines(
      '{"type":"result","subtype":"success","is_error":false,"result":"{\\"status\\":\\"complete\\"}","structured_output":{"status":"complete"}}',
    ), undefined, true)
    expect(result).toEqual({
      output: [{ type: 'text', text: '{"status":"complete"}' }],
      structured: { status: 'complete' },
      stopReason: 'completed',
    })
  })

  it('rejects a schema-bound success without a structured object', async () => {
    for (const extra of ['', ',"structured_output":null', ',"structured_output":[1]', ',"structured_output":"x"']) {
      await expect(consumeHeadlessLines(lines(
        `{"type":"result","subtype":"success","is_error":false,"result":"text"${extra}}`,
      ), undefined, true)).rejects.toThrow(/invalid-result/)
    }
  })

  it('maps the CLI structured-output retry exhaustion to a failure', async () => {
    await expect(consumeHeadlessLines(lines(
      '{"type":"result","subtype":"error_max_structured_output_retries","is_error":true,"errors":["no valid output"]}',
    ), undefined, true)).rejects.toThrow()
  })

  it('ignores a structured value when no schema was requested', async () => {
    const result = await consumeHeadlessLines(lines(
      '{"type":"result","subtype":"success","is_error":false,"result":"done","structured_output":{"a":1}}',
    ))
    expect(result).toEqual({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' })
  })

  it('rejects error and empty results', () => {
    expect(() => successfulHeadlessResult({ type: 'result', subtype: 'error_max_turns', errors: ['x'] })).toThrow(/limit/)
    expect(() => successfulHeadlessResult({ type: 'result', subtype: 'success', is_error: true, result: 'x' })).toThrow(/invalid-result/)
    expect(() => successfulHeadlessResult({ type: 'result', subtype: 'success', result: '  ' })).toThrow(/invalid-result/)
  })
})
