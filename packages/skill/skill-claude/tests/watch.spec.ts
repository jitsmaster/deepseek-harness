import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Warn } from '../src/types.ts'

interface FakeWatcher {
  readonly emitter: EventEmitter & { close(): Promise<void> }
  readonly path: string
  readonly options: Record<string, unknown>
  closeCalls: number
}

const harness = vi.hoisted(() => ({ watchers: [] as FakeWatcher[], closeFails: false }))

vi.mock('chokidar', () => ({
  default: {
    watch(path: unknown, options: Record<string, unknown>) {
      const emitter = new EventEmitter() as FakeWatcher['emitter']
      const control: FakeWatcher = { emitter, path: String(path), options, closeCalls: 0 }
      emitter.close = async () => {
        control.closeCalls += 1
        if (harness.closeFails) throw new Error('close failed')
      }
      harness.watchers.push(control)
      return emitter
    },
  },
}))

const { RootWatcher } = await import('../src/watch.ts')

const tempDirs: string[] = []
beforeEach(() => {
  harness.watchers.length = 0
  harness.closeFails = false
})
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-skill-claude-watch-')))
  tempDirs.push(dir)
  return dir
}

const options = { usePolling: true, stabilityThresholdMs: 123, pollIntervalMs: 45 }

function setup(): { watcher: InstanceType<typeof RootWatcher>; changes: { count: number }; warnings: string[] } {
  const changes = { count: 0 }
  const warnings: string[] = []
  const warn: Warn = (_key, message) => { warnings.push(message) }
  return { watcher: new RootWatcher(options, () => { changes.count += 1 }, warn), changes, warnings }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('RootWatcher', () => {
  it('opens one watcher per existing target with the configured options', async () => {
    const dir = await tempDir()
    const { watcher } = setup()

    await watcher.sync([{ path: dir, shallow: false }, { path: join(dir, 'absent'), shallow: false }, { path: dir, shallow: true }])

    expect(harness.watchers.map(entry => entry.path)).toEqual([dir, dir])
    expect(harness.watchers[0]?.options).toMatchObject({
      persistent: true,
      ignoreInitial: true,
      atomic: true,
      usePolling: true,
      interval: 45,
      awaitWriteFinish: { stabilityThreshold: 123, pollInterval: 45 },
    })
    expect(harness.watchers[0]?.options.depth).toBeUndefined()
    expect(harness.watchers[0]?.options.ignored).toBeInstanceOf(RegExp)
    expect(harness.watchers[1]?.options.depth).toBe(0)
    await watcher.dispose()
  })

  it('does not reopen a watched target and retries a target that appears later', async () => {
    const dir = await tempDir()
    const { watcher } = setup()
    const target = { path: join(dir, 'late'), shallow: false }

    await watcher.sync([target])
    expect(harness.watchers).toHaveLength(0)

    const { mkdir } = await import('node:fs/promises')
    await mkdir(target.path)
    await watcher.sync([target])
    await watcher.sync([target])
    expect(harness.watchers).toHaveLength(1)
    await watcher.dispose()
  })

  it('opens a single watcher when two syncs overlap', async () => {
    const dir = await tempDir()
    const { watcher } = setup()

    await Promise.all([watcher.sync([{ path: dir, shallow: false }]), watcher.sync([{ path: dir, shallow: false }])])

    expect(harness.watchers).toHaveLength(1)
    await watcher.dispose()
  })

  it('coalesces a burst of events into one change notification', async () => {
    const dir = await tempDir()
    const { watcher, changes } = setup()
    await watcher.sync([{ path: dir, shallow: false }])

    harness.watchers[0]?.emitter.emit('all', 'add', join(dir, 'a'))
    harness.watchers[0]?.emitter.emit('all', 'change', join(dir, 'a'))
    harness.watchers[0]?.emitter.emit('all', 'unlink', join(dir, 'b'))
    await settle()
    expect(changes.count).toBe(1)

    harness.watchers[0]?.emitter.emit('all', 'add', join(dir, 'c'))
    await settle()
    expect(changes.count).toBe(2)
    await watcher.dispose()
  })

  it('reports watcher errors through the warning sink', async () => {
    const dir = await tempDir()
    const { watcher, warnings } = setup()
    await watcher.sync([{ path: dir, shallow: false }])

    harness.watchers[0]?.emitter.emit('error', new Error('native watch failed'))

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('native watch failed')
    await watcher.dispose()
  })

  it('closes every watcher on dispose, ignores later events and syncs, and is idempotent', async () => {
    const dir = await tempDir()
    const { watcher, changes } = setup()
    await watcher.sync([{ path: dir, shallow: false }])
    const emitter = harness.watchers[0]?.emitter

    await watcher.dispose()
    await watcher.dispose()
    emitter?.emit('all', 'add', join(dir, 'a'))
    await settle()
    await watcher.sync([{ path: dir, shallow: true }])

    expect(harness.watchers[0]?.closeCalls).toBe(1)
    expect(harness.watchers).toHaveLength(1)
    expect(changes.count).toBe(0)
  })

  it('does not notify for an event queued before dispose', async () => {
    const dir = await tempDir()
    const { watcher, changes } = setup()
    await watcher.sync([{ path: dir, shallow: false }])

    harness.watchers[0]?.emitter.emit('all', 'add', join(dir, 'a'))
    await watcher.dispose()
    await settle()

    expect(changes.count).toBe(0)
  })

  it('warns when a watcher fails to close', async () => {
    const dir = await tempDir()
    const { watcher, warnings } = setup()
    await watcher.sync([{ path: dir, shallow: false }])
    harness.closeFails = true

    await watcher.dispose()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('close failed')
  })
})
