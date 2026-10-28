import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { constants, gzip } from 'node:zlib'
import type { RequestPayload } from '@deepseek-ai/dsh-llm'

const gzipAsync = promisify(gzip)
const NAME_PATTERN = /^[\w.-]+$/

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

export interface RequestPayloadBlob {
  /** Sidecar file name, `<name>.json.gz`, relative to `<dir>/payloads/`. */
  blob: string
  /** Original uncompressed JSON size in bytes. */
  bytes: number
  /** Size of the gzip file as stored. */
  storedBytes: number
  truncated: boolean
}

/**
 * Serialize `payload`, dropping the `stdin`, then `system` bodies, then the `tools`
 * list, then `argv` and `envKeys` (keeping their original byte lengths) until the
 * JSON fits `capBytes`.
 */
function fit(
  payload: RequestPayload,
  capBytes: number,
  full: string,
): { json: string; truncated: boolean } {
  let json = full
  if (Buffer.byteLength(json) <= capBytes) return { json, truncated: false }
  const stored: Record<string, unknown> = { ...payload, truncated: true }
  for (const field of ['stdin', 'system'] as const) {
    const length = Buffer.byteLength(payload[field])
    stored[field] = `[${field} omitted: ${length} bytes]`
    stored[`${field}Bytes`] = length
    json = JSON.stringify(stored)
    if (Buffer.byteLength(json) <= capBytes) break
  }
  if (Buffer.byteLength(json) > capBytes) {
    stored.toolsBytes = Buffer.byteLength(JSON.stringify(payload.tools))
    stored.tools = []
    json = JSON.stringify(stored)
  }
  if (Buffer.byteLength(json) > capBytes) {
    stored.argvBytes = Buffer.byteLength(JSON.stringify(payload.argv))
    stored.argv = []
    stored.envKeysBytes = Buffer.byteLength(JSON.stringify(payload.envKeys))
    stored.envKeys = []
    json = JSON.stringify(stored)
  }
  return { json, truncated: true }
}

/**
 * Write one request payload as a gzip sidecar at `<dir>/payloads/<name>.json.gz`
 * (temp file, then rename). Oversized payloads are stored truncated while `bytes`
 * still reports the original size.
 */
export async function writeRequestPayload(
  dir: string,
  name: string,
  payload: RequestPayload,
  capBytes = 5_000_000,
): Promise<RequestPayloadBlob> {
  if (!NAME_PATTERN.test(name)) throw new Error(`Invalid request payload name: ${JSON.stringify(name)}`)
  const full = JSON.stringify(payload)
  const bytes = Buffer.byteLength(full)
  const { json, truncated } = fit(payload, capBytes, full)
  // Fastest level: this runs on every LLM call and the blob is read rarely.
  const compressed = await gzipAsync(Buffer.from(json), { level: constants.Z_BEST_SPEED })
  const payloads = join(dir, 'payloads')
  await mkdir(payloads, { recursive: true, mode: 0o700 })
  // A resumed session restarts its attempt counter, so a name can already exist:
  // take the next free suffix instead of overwriting an earlier request's blob.
  let blob = `${name}.json.gz`
  for (let n = 1; await exists(join(payloads, blob)); n++) blob = `${name}-r${String(n)}.json.gz`
  const tmp = join(payloads, `${blob}.${process.pid}.tmp`)
  try {
    await writeFile(tmp, compressed, { mode: 0o600 })
    await rename(tmp, join(payloads, blob))
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
  return { blob, bytes, storedBytes: compressed.length, truncated }
}
