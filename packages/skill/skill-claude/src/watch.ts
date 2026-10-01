/**
 * Change detection for Claude skill roots. Deep targets are watched
 * recursively for skill and command edits; shallow targets are watched one
 * level deep so a newly created root or configuration file is noticed.
 *
 * @module @deepseek-ai/dsh-skill-claude/watch
 */

import { access } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { Warn } from './types.ts'

/** Dependency folders hold no skills and can contain very large trees. */
const IGNORED_DEPENDENCIES = /(^|[\\/])node_modules([\\/]|$)/

/** A directory watched recursively. */
export interface DeepWatchTarget {
  /** Absolute path of an existing directory. */
  readonly path: string
  readonly shallow: false
}

/** A directory whose listed direct children are watched, and nothing deeper. */
export interface ShallowWatchTarget {
  /** Absolute path of an existing directory. */
  readonly path: string
  readonly shallow: true
  /** Basenames of the direct children that raise events; every other entry is ignored. */
  readonly names: readonly string[]
}

/** One path to watch. */
export type WatchTarget = DeepWatchTarget | ShallowWatchTarget

/** Chokidar behavior shared by every watcher of one provider. */
export interface WatchOptions {
  /** Whether polling replaces native filesystem events. */
  readonly usePolling: boolean
  /** Milliseconds a changed file must stay unchanged before its event fires. */
  readonly stabilityThresholdMs: number
  /** Milliseconds between stability and polling probes. */
  readonly pollIntervalMs: number
}

/** Owns the chokidar watchers of one provider and turns their events into change notifications. */
export class RootWatcher {
  private readonly options: WatchOptions
  private readonly onChange: () => void
  private readonly warn: Warn
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly reserved = new Set<string>()
  private pending = false
  private disposed = false

  /**
   * @param options - chokidar behavior.
   * @param onChange - called once per event-loop turn that saw any event.
   * @param warn - warning sink for watcher failures.
   */
  constructor(options: WatchOptions, onChange: () => void, warn: Warn) {
    this.options = options
    this.onChange = onChange
    this.warn = warn
  }

  /**
   * Open a watcher for every existing target that is not already watched.
   * Targets that do not exist yet are retried on the next call.
   * @param targets - paths the provider currently scans or depends on.
   */
  async sync(targets: readonly WatchTarget[]): Promise<void> {
    for (const target of targets) {
      if (this.disposed) return
      const key = `${target.shallow ? 'shallow' : 'deep'}:${target.path}`
      if (this.watchers.has(key) || this.reserved.has(key)) continue
      this.reserved.add(key)
      try {
        if (await pathExists(target.path) && !this.isDisposed()) this.watchers.set(key, this.open(key, target))
      } finally {
        this.reserved.delete(key)
      }
    }
  }

  /** Close every watcher and ignore all later events and syncs. */
  async dispose(): Promise<void> {
    this.disposed = true
    const open = [...this.watchers.entries()]
    this.watchers.clear()
    await Promise.all(open.map(async ([key, watcher]) => {
      try {
        await watcher.close()
      } catch (error) {
        this.warn(key, `closing the watcher for ${key} failed: ${String(error)}`)
      }
    }))
  }

  /** Re-reads the flag after an await, where control flow analysis still treats it as unchanged. */
  private isDisposed(): boolean {
    return this.disposed
  }

  private open(key: string, target: WatchTarget): FSWatcher {
    const watcher = chokidar.watch(target.path, {
      persistent: true,
      ignoreInitial: true,
      ...target.shallow ? { depth: 0 } : {},
      ignored: target.shallow ? admitOnly(target.path, target.names) : IGNORED_DEPENDENCIES,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: this.options.stabilityThresholdMs,
        pollInterval: this.options.pollIntervalMs,
      },
      usePolling: this.options.usePolling,
      interval: this.options.pollIntervalMs,
    })
    watcher.on('all', () => { this.schedule() })
    watcher.on('error', (error) => { this.warn(key, `watcher for ${target.path} failed: ${String(error)}`) })
    return watcher
  }

  private schedule(): void {
    if (this.pending || this.disposed) return
    this.pending = true
    queueMicrotask(() => {
      this.pending = false
      if (!this.disposed) this.onChange()
    })
  }
}

/**
 * Build a chokidar `ignored` predicate that admits the watched directory and its listed direct children.
 * @param root - the watched directory; chokidar tests it too, and ignoring it would silence the watcher.
 * @param names - basenames of the direct children to admit.
 * @returns a predicate that is `true` for every other path.
 */
function admitOnly(root: string, names: readonly string[]): (path: string) => boolean {
  const base = resolve(root)
  const admitted = new Set(names)
  return (path) => {
    const full = resolve(path)
    if (full === base) return false
    return dirname(full) !== base || !admitted.has(basename(full))
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    // A target that does not exist yet is retried on the next sync.
    return false
  }
}
