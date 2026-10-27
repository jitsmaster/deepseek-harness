import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RateLimitFile } from '../src/rate-limit.ts'

let scratch: string
let warnings: string[]

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-claude-rl-spec-'))
  warnings = []
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const FIVE = { utilization: 0.1, resetsAt: 1000 }
const SEVEN = { utilization: 0.6, resetsAt: 2000 }

function make(path: string): RateLimitFile {
  return new RateLimitFile(path, (reason) => { warnings.push(reason) })
}

async function read(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

describe('RateLimitFile', () => {
  it('creates the parent directory and writes both windows with an ISO updatedAt', async () => {
    const path = join(scratch, 'nested', 'deeper', 'usage.json')
    await make(path).write({ fiveHour: FIVE, sevenDay: SEVEN })
    const body = await read(path)
    expect(body).toMatchObject({ fiveHour: FIVE, sevenDay: SEVEN })
    expect(new Date(body.updatedAt as string).toISOString()).toBe(body.updatedAt)
    expect(warnings).toEqual([])
  })

  it('omits a window that was never reported', async () => {
    const path = join(scratch, 'usage.json')
    await make(path).write({ fiveHour: FIVE })
    const body = await read(path)
    expect(body.fiveHour).toEqual(FIVE)
    expect('sevenDay' in body).toBe(false)
  })

  it('keeps the previous window the new reading does not carry, and replaces the one it does', async () => {
    const path = join(scratch, 'usage.json')
    const file = make(path)
    await file.write({ fiveHour: FIVE, sevenDay: SEVEN })
    await file.write({ fiveHour: { utilization: 0.2, resetsAt: 1500 } })
    expect(await read(path)).toMatchObject({ fiveHour: { utilization: 0.2, resetsAt: 1500 }, sevenDay: SEVEN })
  })

  it('starts fresh over a malformed existing file', async () => {
    const path = join(scratch, 'usage.json')
    await writeFile(path, '{not json')
    await make(path).write({ sevenDay: SEVEN })
    const body = await read(path)
    expect(body.sevenDay).toEqual(SEVEN)
    expect('fiveHour' in body).toBe(false)
  })

  it('leaves no temp file behind and serializes concurrent writes', async () => {
    const path = join(scratch, 'usage.json')
    const file = make(path)
    await Promise.all(Array.from({ length: 20 }, (_, i) => file.write({ fiveHour: { utilization: i / 100, resetsAt: i } })))
    expect(await readdir(scratch)).toEqual(['usage.json'])
    expect((await read(path)).fiveHour).toEqual({ utilization: 0.19, resetsAt: 19 })
  })

  it('swallows an unwritable path and reports a secret-free reason', async () => {
    const blocker = join(scratch, 'blocker')
    await writeFile(blocker, 'a file, not a directory')
    const file = make(join(blocker, 'usage.json'))
    await expect(file.write({ fiveHour: FIVE })).resolves.toBeUndefined()
    await expect(file.write({ fiveHour: FIVE })).resolves.toBeUndefined()
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toContain('could not write the plan-usage file')
    expect(await readdir(scratch)).toEqual(['blocker'])
  })
})
