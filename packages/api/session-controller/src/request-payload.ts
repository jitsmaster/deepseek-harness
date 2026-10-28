/** Read path for the gzip request-payload sidecars written beside a stored Session. */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import type { RequestPayload } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

const gunzipAsync = promisify(gunzip)

/** File names the writer produces: no separators, no leading dot, `.json.gz` suffix. */
const BLOB_PATTERN = /^\w[\w.-]*\.json\.gz$/
/** Stored files are capped at 5 MB of JSON by the writer; refuse to inflate beyond this. */
const MAX_INFLATED_BYTES = 8_000_000

/** A stored request payload; oversized ones carry the writer's truncation marker. */
export type StoredRequestPayload = RequestPayload & { readonly truncated?: true }

/**
 * Read one recorded request payload for a Session.
 * @param persistence - stored-session backend, or undefined when none is composed.
 * @param request - Session identity and blob file name from a `request/payload` event.
 * @param signal - caller cancellation.
 * @returns the payload, or undefined when the Session or blob does not exist.
 * @throws RemoteError `gateway/bad-request` for an unsafe blob name, `gateway/internal` for an unreadable blob.
 */
export async function readRequestPayload(
  persistence: Pick<SessionPersistence, 'stat' | 'sessionDirectory'> | undefined,
  request: { readonly sessionId: SessionId; readonly blob: string },
  signal: AbortSignal,
): Promise<StoredRequestPayload | undefined> {
  if (!BLOB_PATTERN.test(request.blob)) {
    throw new RemoteError('gateway/bad-request', 'blob must be a request payload file name', {})
  }
  if (persistence === undefined) return undefined
  const stored = await persistence.stat(request.sessionId, { signal })
  signal.throwIfAborted()
  if (stored === undefined) return undefined
  const dir = persistence.sessionDirectory(stored.header)
  if (dir === undefined) return undefined
  const file = join(dir, 'payloads', request.blob)
  let compressed: Buffer
  try {
    const info = await stat(file)
    if (!info.isFile()) return undefined
    if (info.size > MAX_INFLATED_BYTES) throw new Error('stored payload is too large')
    compressed = await readFile(file, { signal })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (signal.aborted) throw error
    throw new RemoteError('gateway/internal', 'request payload could not be read', {}, { cause: error })
  }
  try {
    const inflated = await gunzipAsync(compressed, { maxOutputLength: MAX_INFLATED_BYTES })
    return JSON.parse(inflated.toString('utf8')) as StoredRequestPayload
  } catch (error: unknown) {
    throw new RemoteError('gateway/internal', 'request payload is corrupt', {}, { cause: error })
  }
}
