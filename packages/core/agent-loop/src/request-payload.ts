import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type { RequestPayload } from '@deepseek-ai/dsh-llm'

const gzipAsync = promisify(gzip)
const NAME_PATTERN = /^[\w.-]+$/

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
 * Serialize `payload`, dropping the `stdin` then `system` bodies (keeping their
 * original byte lengths) until the JSON fits `capBytes`.
 */
function fit(payload: RequestPayload, capBytes: number): { json: string; truncated: boolean } {
  let json = JSON.stringify(payload)
  if (Buffer.byteLength(json) <= capBytes) return { json, truncated: false }
  const stored: Record<string, unknown> = { ...payload, truncated: true }
  for (const field of ['stdin', 'system'] as const) {
    const length = Buffer.byteLength(payload[field])
    stored[field] = `[${field} omitted: ${length} bytes]`
    stored[`${field}Bytes`] = length
    json = JSON.stringify(stored)
    if (Buffer.byteLength(json) <= capBytes) break
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
  const bytes = Buffer.byteLength(JSON.stringify(payload))
  const { json, truncated } = fit(payload, capBytes)
  const compressed = await gzipAsync(Buffer.from(json))
  const payloads = join(dir, 'payloads')
  const blob = `${name}.json.gz`
  const tmp = join(payloads, `${blob}.${process.pid}.tmp`)
  await mkdir(payloads, { recursive: true, mode: 0o700 })
  try {
    await writeFile(tmp, compressed, { mode: 0o600 })
    await rename(tmp, join(payloads, blob))
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
  return { blob, bytes, storedBytes: compressed.length, truncated }
}
