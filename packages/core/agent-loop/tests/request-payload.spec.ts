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

  it('rejects when the directory is unwritable', async () => {
    const file = join(dir, 'file')
    await writeFile(file, 'x')
    await expect(writeRequestPayload(file, 'n', payload)).rejects.toThrow()
  })

  it.each(['', '../x', 'a/b', 'a b'])('rejects bad name %j', async (name) => {
    await expect(writeRequestPayload(dir, name, payload)).rejects.toThrow(/Invalid request payload name/)
  })
})
