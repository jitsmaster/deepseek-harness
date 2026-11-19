import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, validateArgs, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'

const signal = new AbortController().signal

const probe = defineTool({
  name: 'probe',
  description: 'echo the arguments the body received',
  parameters: {
    n: { type: 'number' },
    i: { type: 'integer' },
    b: { type: 'boolean' },
    s: { type: 'string' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args) {
    return JSON.stringify(args)
  },
})

async function setup(config?: { coerceScalarStrings?: boolean }) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, config)
  await ctx.plugin(NativeToolExecutor)
  ctx.tools.register(probe)
  return ctx
}

async function call(ctx: Context, args: unknown) {
  const result = await executeToolFixture(ctx, { signal, callId: ToolCallId('c1'), name: 'probe', arguments: args })
  const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
  return { isError: result.isError === true, text }
}

describe('scalar string coercion (default on)', () => {
  it('turns clean numeric and boolean strings into real scalars', async () => {
    const ctx = await setup()
    const result = await call(ctx, { n: '600000', i: '5', b: 'true' })
    expect(result.isError).toBe(false)
    expect(result.text).toBe('{"n":600000,"i":5,"b":true}')
  })

  it('keeps exec.arguments raw for hooks while the body receives scalars', async () => {
    const ctx = await setup()
    const seen: unknown[] = []
    ctx.on('tools/pre-execute', async (exec, next) => {
      seen.push(exec.arguments)
      return next()
    })
    const result = await call(ctx, { n: '600000', b: 'true' })
    expect(result.isError).toBe(false)
    expect(result.text).toBe('{"n":600000,"b":true}')
    expect(seen).toEqual([{ n: '600000', b: 'true' }])
  })

  it('accepts negative and decimal numbers and "false"', async () => {
    const ctx = await setup()
    const result = await call(ctx, { n: '-2.5', b: 'false' })
    expect(result.isError).toBe(false)
    expect(result.text).toBe('{"n":-2.5,"b":false}')
  })

  it('leaves string parameters and real scalars untouched', async () => {
    const ctx = await setup()
    const result = await call(ctx, { s: '123', n: 7, b: true })
    expect(result.isError).toBe(false)
    expect(result.text).toBe('{"s":"123","n":7,"b":true}')
  })

  it.each([
    [{ n: 'soon' }, /"n" must be a number/],
    [{ n: '1e3' }, /"n" must be a number/],
    [{ n: ' 5' }, /"n" must be a number/],
    [{ n: '' }, /"n" must be a number/],
    [{ n: '0x10' }, /"n" must be a number/],
    [{ n: '1234567.1234567890' }, /"n" must be a number/],
    [{ n: '007' }, /"n" must be a number/],
    [{ i: '00123' }, /"i" must be an integer/],
    [{ i: '1.5' }, /"i" must be an integer/],
    [{ b: 'yes' }, /"b" must be a boolean/],
    [{ b: 'True' }, /"b" must be a boolean/],
    [{ b: '1' }, /"b" must be a boolean/],
  ])('still rejects a non-clean string %j', async (args, pattern) => {
    const ctx = await setup()
    const result = await call(ctx, args)
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(pattern)
  })

  it.each([
    ['a 16-digit string', { n: '1234567890123456' }],
    ['negative zero', { n: '-0' }],
  ])('leaves %s uncoerced and rejected', async (_label, args) => {
    const ctx = await setup()
    const result = await call(ctx, args)
    expect(result.isError).toBe(true)
    expect(result.text).toBe('Error: invalid arguments: "n" must be a number')
  })

  it('leaves an unknown nested property untouched', async () => {
    const ctx = await setup()
    const result = await call(ctx, { o: { n: '5' } })
    expect(result.text).toBe('{"o":{"n":"5"}}')
  })

  it('never turns an array or object into a scalar', async () => {
    const ctx = await setup()
    expect((await call(ctx, { n: ['1'] })).isError).toBe(true)
    expect((await call(ctx, { b: { v: 'true' } })).isError).toBe(true)
  })
})

describe('scalar string coercion in the concurrency classifier', () => {
  const readOnlyTool = defineTool({
    name: 'ro-probe',
    description: 'parallel only when readOnly is exactly true',
    parameters: { readOnly: { type: 'boolean' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: args => args.readOnly === true,
    async execute() { return 'ok' },
  })

  it('classifies on the coerced arguments when the flag is on', async () => {
    const ctx = await setup()
    ctx.tools.register(readOnlyTool)
    const mode = new ToolExecutionPipeline(ctx).executionMode({ signal, callId: ToolCallId('m1'), name: 'ro-probe', arguments: { readOnly: 'true' } })
    expect(mode).toEqual({ kind: 'parallel' })
  })

  it('classifies on the raw arguments when the flag is off', async () => {
    const ctx = await setup({ coerceScalarStrings: false })
    ctx.tools.register(readOnlyTool)
    const mode = new ToolExecutionPipeline(ctx).executionMode({ signal, callId: ToolCallId('m2'), name: 'ro-probe', arguments: { readOnly: 'true' } })
    expect(mode).toEqual({ kind: 'exclusive' })
  })
})

describe('scalar string coercion (flag off)', () => {
  it('keeps strict validation and explains the fix', async () => {
    const ctx = await setup({ coerceScalarStrings: false })
    const result = await call(ctx, { n: '600000' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('"n" must be a number')
    expect(result.text).toContain('pass a JSON number without quotes, e.g. 600000')
  })

  it('still accepts real numbers', async () => {
    const ctx = await setup({ coerceScalarStrings: false })
    const result = await call(ctx, { n: 600000 })
    expect(result.isError).toBe(false)
  })
})

describe('validateArgs error text for quoted scalars', () => {
  const spec = { n: { type: 'number' }, i: { type: 'integer' }, b: { type: 'boolean' } } satisfies ParameterSchemaSpec

  it('hints at unquoting for a clean numeric string', () => {
    expect(validateArgs(spec, { n: '600000' })).toEqual(['"n" must be a number: pass a JSON number without quotes, e.g. 600000'])
    expect(validateArgs(spec, { i: '5' })).toEqual(['"i" must be an integer: pass a JSON number without quotes, e.g. 5'])
  })

  it('hints at unquoting for a clean boolean string', () => {
    expect(validateArgs(spec, { b: 'true' })).toEqual(['"b" must be a boolean: pass a JSON boolean without quotes, e.g. true'])
  })

  it('keeps the plain message for other strings', () => {
    expect(validateArgs(spec, { n: 'x' })).toEqual(['"n" must be a number'])
    expect(validateArgs(spec, { b: 'yes' })).toEqual(['"b" must be a boolean'])
  })
})

describe('scalar string coercion in the presenters (logged raw args)', () => {
  const presented = defineTool({
    name: 'presented',
    description: 'has call and result presenters keyed on a number argument',
    parameters: { n: { type: 'number' }, b: { type: 'boolean' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    presentCall: args => ({ card: 'generic', title: `n=${typeof args.n}:${String(args.n)}` }),
    presentResult: args => ({ card: 'generic', title: `done n=${typeof args.n}` }),
    async execute() { return 'ok' },
  })
  const result = { content: [], isError: false }

  it('presentCall shows the presenter view for a quoted clean scalar', () => {
    expect(presented.presentCall?.({ n: '600000' })).toEqual({ card: 'generic', title: 'n=number:600000' })
  })

  it('presentResult shows the presenter view for a quoted clean scalar', () => {
    expect(presented.presentResult?.({ b: 'true', n: '5' }, result)).toEqual({ card: 'generic', title: 'done n=number' })
  })

  it('still falls back (undefined) for a non-clean string', () => {
    expect(presented.presentCall?.({ n: 'soon' })).toBeUndefined()
    expect(presented.presentResult?.({ n: 'soon' }, result)).toBeUndefined()
  })
})
