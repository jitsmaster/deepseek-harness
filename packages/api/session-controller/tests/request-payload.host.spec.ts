/** Read path for the gzip request-payload sidecars written by the agent loop. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { readRequestPayload } from '@deepseek-ai/dsh-api-session-controller/src/request-payload.ts'

const gzipAsync = promisify(gzip)
const sid = (id: string): SessionId => id as SessionId
const signal = new AbortController().signal

const PAYLOAD = {
  argv: ['claude', '-p'],
  envKeys: ['PATH'],
  system: 'be brief',
  tools: [{ name: 'mcp__dsh__read', description: 'read', inputSchema: {} }],
  stdin: 'hello',
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-request-payload-read-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Persistence double: known sessions map to their own directory. */
function persistence(dirs: Record<string, string>) {
  return {
    stat: async (id: SessionId) => (dirs[id] === undefined ? undefined : { header: { id, cwd: '/p' } }),
    sessionDirectory: (header: { id: SessionId }) => dirs[header.id],
  } as never
}

async function store(dir: string, name: string, value: unknown): Promise<void> {
  await mkdir(join(dir, 'payloads'), { recursive: true })
  await writeFile(join(dir, 'payloads', name), await gzipAsync(Buffer.from(JSON.stringify(value))))
}

describe('readRequestPayload', () => {
  it('returns the stored payload', async () => {
    const dir = join(root, 's1')
    await store(dir, '4-1-0.json.gz', PAYLOAD)
    const value = await readRequestPayload(persistence({ s1: dir }), { sessionId: sid('s1'), blob: '4-1-0.json.gz' }, signal)
    expect(value).toEqual(PAYLOAD)
  })

  it('passes the truncated marker through', async () => {
    const dir = join(root, 's1')
    await store(dir, 'a.json.gz', { ...PAYLOAD, truncated: true, stdinBytes: 9 })
    const value = await readRequestPayload(persistence({ s1: dir }), { sessionId: sid('s1'), blob: 'a.json.gz' }, signal)
    expect(value).toMatchObject({ truncated: true, stdinBytes: 9 })
  })

  it('returns undefined for a missing blob, an unknown session, or no persistence', async () => {
    const dir = join(root, 's1')
    await mkdir(join(dir, 'payloads'), { recursive: true })
    expect(await readRequestPayload(persistence({ s1: dir }), { sessionId: sid('s1'), blob: 'nope.json.gz' }, signal)).toBeUndefined()
    expect(await readRequestPayload(persistence({ s1: dir }), { sessionId: sid('s2'), blob: 'nope.json.gz' }, signal)).toBeUndefined()
    expect(await readRequestPayload(undefined, { sessionId: sid('s1'), blob: 'nope.json.gz' }, signal)).toBeUndefined()
    expect(await readRequestPayload(persistence({ s1: dir }), { sessionId: sid('s1'), blob: 'nope.json.gz' }, signal)).toBeUndefined()
  })

  it('does not read another session\'s blob', async () => {
    const one = join(root, 's1')
    const two = join(root, 's2')
    await store(one, 'x.json.gz', PAYLOAD)
    await mkdir(join(two, 'payloads'), { recursive: true })
    const value = await readRequestPayload(persistence({ s1: one, s2: two }), { sessionId: sid('s2'), blob: 'x.json.gz' }, signal)
    expect(value).toBeUndefined()
  })

  it.each([
    '../x.json.gz', '..\\x.json.gz', 'sub/x.json.gz', '/etc/passwd', 'C:\\x.json.gz', '..', '.', '', 'x.json', '.hidden.json.gz', 'x.json.gz\0',
  ])('rejects the blob name %j', async (blob) => {
    const dir = join(root, 's1')
    await store(dir, 'x.json.gz', PAYLOAD)
    await writeFile(join(root, 'x.json.gz'), await gzipAsync(Buffer.from(JSON.stringify(PAYLOAD))))
    await expect(readRequestPayload(persistence({ s1: dir }), { sessionId: sid('s1'), blob }, signal))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('rejects a blob that is not valid gzip JSON without leaking its content', async () => {
    const dir = join(root, 's1')
    await mkdir(join(dir, 'payloads'), { recursive: true })
    await writeFile(join(dir, 'payloads', 'bad.json.gz'), 'not gzip secret-text')
    const result = readRequestPayload(persistence({ s1: dir }), { sessionId: sid('s1'), blob: 'bad.json.gz' }, signal)
    await expect(result).rejects.toMatchObject({ code: 'gateway/internal' })
    await expect(result).rejects.not.toThrow(/secret-text/)
  })

  it('refuses to inflate an oversized payload', async () => {
    const dir = join(root, 's1')
    await store(dir, 'big.json.gz', { ...PAYLOAD, stdin: 'a'.repeat(9_000_000) })
    await expect(readRequestPayload(persistence({ s1: dir }), { sessionId: sid('s1'), blob: 'big.json.gz' }, signal))
      .rejects.toMatchObject({ code: 'gateway/internal' })
  }, 30_000)
})
