import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensurePrimaryRuntime } from '../scripts/ensure-primary-runtime.ts'

const roots: string[] = []

function runtimeDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ensure-runtime-test-'))
  roots.push(root)
  return root
}

function populate(runtime: string): void {
  mkdirSync(join(runtime, 'primary-runtime'), { recursive: true })
  writeFileSync(join(runtime, 'primary-runtime', 'runtime.json'), '{}')
  mkdirSync(join(runtime, 'office-skills'), { recursive: true })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('ensurePrimaryRuntime', () => {
  it('prepares once and skips while the fingerprint is unchanged', async () => {
    const runtime = runtimeDirectory()
    const prepare = vi.fn(async () => { populate(runtime) })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await ensurePrimaryRuntime({ runtimeDirectory: runtime, fingerprint: () => 'a', prepare })
    await ensurePrimaryRuntime({ runtimeDirectory: runtime, fingerprint: () => 'a', prepare })
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('rebuilds when the fingerprint changes', async () => {
    const runtime = runtimeDirectory()
    const prepare = vi.fn(async () => { populate(runtime) })
    await ensurePrimaryRuntime({ runtimeDirectory: runtime, fingerprint: () => 'a', prepare })
    await ensurePrimaryRuntime({ runtimeDirectory: runtime, fingerprint: () => 'b', prepare })
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('rebuilds when the prepared payload was removed', async () => {
    const runtime = runtimeDirectory()
    const prepare = vi.fn(async () => { populate(runtime) })
    await ensurePrimaryRuntime({ runtimeDirectory: runtime, fingerprint: () => 'a', prepare })
    rmSync(join(runtime, 'office-skills'), { recursive: true })
    await ensurePrimaryRuntime({ runtimeDirectory: runtime, fingerprint: () => 'a', prepare })
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('rebuilds when forced', async () => {
    const runtime = runtimeDirectory()
    const prepare = vi.fn(async () => { populate(runtime) })
    await ensurePrimaryRuntime({ runtimeDirectory: runtime, fingerprint: () => 'a', prepare })
    vi.stubEnv('DSH_DESKTOP_FORCE_RUNTIME', '1')
    await ensurePrimaryRuntime({ runtimeDirectory: runtime, fingerprint: () => 'a', prepare })
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('writes no stamp when preparation fails, so the next launch retries', async () => {
    const runtime = runtimeDirectory()
    const failing = vi.fn(async () => { populate(runtime); throw new Error('smoke failed') })
    await expect(ensurePrimaryRuntime({ runtimeDirectory: runtime, fingerprint: () => 'a', prepare: failing })).rejects.toThrow('smoke failed')
    const prepare = vi.fn(async () => undefined)
    await ensurePrimaryRuntime({ runtimeDirectory: runtime, fingerprint: () => 'a', prepare })
    expect(prepare).toHaveBeenCalledTimes(1)
  })
})
