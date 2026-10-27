/**
 * Shares the latest plan-usage reading with other plugins through one small JSON
 * file, so a status display never has to call Anthropic's usage endpoint itself.
 * Writes are serialized, atomic (temp file in the same directory, then rename),
 * best effort, and never throw.
 * @module @deepseek-ai/dsh-llm-claude-code/rate-limit
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isAccountId } from './account.ts'
import type { RateLimitReading, RateLimitWindow } from './decoder.ts'

function windowOf(value: unknown): RateLimitWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { utilization, resetsAt } = value as Record<string, unknown>
  return typeof utilization === 'number' && Number.isFinite(utilization) && typeof resetsAt === 'number' && Number.isFinite(resetsAt)
    ? { utilization, resetsAt }
    : undefined
}

/** The windows of the file as it stands now; an absent, unreadable, or malformed file gives none. */
async function readPrevious(path: string): Promise<RateLimitReading> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const { fiveHour, sevenDay } = parsed as Record<string, unknown>
    const five = windowOf(fiveHour)
    const seven = windowOf(sevenDay)
    return { ...five === undefined ? {} : { fiveHour: five }, ...seven === undefined ? {} : { sevenDay: seven } }
  } catch {
    return {}
  }
}

/** File name of the per-account reading inside an account's directory. */
export const USAGE_FILE = 'usage.json'

/** One account's latest plan-usage reading, as its `usage.json` holds it. */
export interface AccountUsage extends RateLimitReading {
  /** ISO timestamp of the write. */
  updatedAt: string
}

/**
 * Read the plan-usage reading kept for one account.
 * @param accountsDir - the accounts root.
 * @param id - an account id from the stored record.
 * @returns the reading, or `undefined` for an unsafe id or an absent, unreadable, or malformed file.
 */
export async function readAccountUsage(accountsDir: string, id: string): Promise<AccountUsage | undefined> {
  if (!isAccountId(id)) return undefined
  const path = join(accountsDir, id, USAGE_FILE)
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { updatedAt } = parsed as Record<string, unknown>
    return typeof updatedAt === 'string' ? { updatedAt, ...await readPrevious(path) } : undefined
  } catch {
    return undefined
  }
}

/** Serialized, atomic writer of the shared reading file. */
export class RateLimitFile {
  private tail: Promise<void> = Promise.resolve()
  private counter = 0

  /**
   * @param path - the JSON file to maintain.
   * @param warn - called with a reason when a write fails; the caller decides how often to log.
   */
  constructor(private readonly path: string, private readonly warn: (reason: string) => void) {}

  /**
   * Queue a write of `reading`, merged over the windows the file already holds.
   * @param reading - the run's reading.
   * @returns a promise that settles once this write was attempted; it never rejects.
   */
  write(reading: RateLimitReading): Promise<void> {
    const next = this.tail.then(() => this.store(reading))
    this.tail = next
    return next
  }

  private async store(reading: RateLimitReading): Promise<void> {
    const temp = `${this.path}.${process.pid}.${++this.counter}.tmp`
    try {
      const previous = await readPrevious(this.path)
      const fiveHour = reading.fiveHour ?? previous.fiveHour
      const sevenDay = reading.sevenDay ?? previous.sevenDay
      const body = {
        updatedAt: new Date().toISOString(),
        ...fiveHour === undefined ? {} : { fiveHour },
        ...sevenDay === undefined ? {} : { sevenDay },
      }
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(temp, JSON.stringify(body))
      await rename(temp, this.path)
    } catch (error: unknown) {
      await rm(temp, { force: true }).catch(() => undefined)
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'error'
      this.warn(`could not write the plan-usage file (${code})`)
    }
  }
}
