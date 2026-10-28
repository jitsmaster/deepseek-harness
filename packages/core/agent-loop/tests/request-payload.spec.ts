import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RequestPayload } from '@deepseek-ai/dsh-llm'
import { writeRequestPayload } from '../src/request-payload.js'

const payload: RequestPayload = {
  argv: ['claude', '-p'],
  envKeys: ['PATH'],
  system: 'be helpful',
  tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
  stdin: 'hello',
}

describe('writeRequestPayload', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'req-payload-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const read = async (name: string): Promise<Record<string, unknown>> =>
    JSON.parse(gunzipSync(await readFile(join(dir, 'payloads', `${name}.json.gz`))).toString()) as Record<string, unknown>

  it('round-trips through gunzip', async () => {
    const result = await writeRequestPayload(dir, 't1-s2', payload)
    expect(result.blob).toBe('t1-s2.json.gz')
    expect(result.truncated).toBe(false)
    expect(result.bytes).toBe(Buffer.byteLength(JSON.stringify(payload)))
    const raw = await readFile(join(dir, 'payloads', result.blob))
    expect(raw.length).toBe(result.storedBytes)
    expect(JSON.parse(gunzipSync(raw).toString())).toEqual(payload)
  })

  it('truncates stdin then system over the cap and reports the original size', async () => {
    const big = { ...payload, stdin: 'x'.repeat(10_000), system: 'y'.repeat(10_000) }
    const original = Buffer.byteLength(JSON.stringify(big))
    const first = await writeRequestPayload(dir, 'a', big, 10_300)
    expect(first.truncated).toBe(true)
    const a = await read('a')
    expect(a.stdinBytes).toBe(10_000)
    expect(a.system).toBe(big.system)

    const both = await writeRequestPayload(dir, 'b', big, 1_000)
    expect(both.truncated).toBe(true)
    expect(both.bytes).toBe(original)
    const b = await read('b')
    expect(b.stdinBytes).toBe(10_000)
    expect(b.systemBytes).toBe(10_000)
    expect(b.argv).toEqual(payload.argv)
  })

  it('drops the tool definitions too when stdin and system alone still exceed the cap', async () => {
    const big = {
      ...payload,
      stdin: 'x'.repeat(2_000),
      system: 'y'.repeat(2_000),
      tools: [{ name: 't', description: 'd'.repeat(10_000), inputSchema: { type: 'object' } }],
    }
    const result = await writeRequestPayload(dir, 'c', big, 2_000)
    expect(result.truncated).toBe(true)
    const c = await read('c')
    expect(c.tools).toEqual([])
    expect(c.toolsBytes).toBe(Buffer.byteLength(JSON.stringify(big.tools)))
    expect(Buffer.byteLength(JSON.stringify(c))).toBeLessThanOrEqual(2_000)
  })

  it('still honours the cap when argv alone is oversized', async () => {
    const big = { ...payload, argv: ['claude', 'z'.repeat(10_000)], envKeys: Array.from({ length: 500 }, (_, i) => `KEY_${String(i)}`) }
    const result = await writeRequestPayload(dir, 'd', big, 2_000)
    expect(result.truncated).toBe(true)
    const d = await read('d')
    expect(d.argv).toEqual([])
    expect(d.envKeys).toEqual([])
    expect(d.argvBytes).toBe(Buffer.byteLength(JSON.stringify(big.argv)))
    expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThanOrEqual(2_000)
  })

  it('rejects when the directory is unwritable', async () => {
    const file = join(dir, 'file')
    await writeFile(file, 'x')
    await expect(writeRequestPayload(file, 'n', payload)).rejects.toThrow()
  })

  it.each(['', '../x', 'a/b', 'a b'])('rejects bad name %j', async (name) => {
    await expect(writeRequestPayload(dir, name, payload)).rejects.toThrow(/Invalid request payload name/)
  })
})
