import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

/**
 * The client artifact is a self-registering loader bundle; exercising it
 * through its real registration surface keeps the test honest about what the
 * browser module table actually receives.
 */

/** Snapshot store surface the bundle exposes (structural, untyped at runtime). */
interface SnapshotStore {
  getSnapshot(): unknown
  subscribe(fn: (snapshot: unknown) => void): () => void
  update(mutator: (draft: Record<string, number>) => void): void
  set(next: unknown): void
}

/** Declarative store builder surface the bundle exposes. */
interface DefineStoreHandle {
  create(scopeKey?: string): {
    actions: Record<string, (...params: unknown[]) => void>
    getSnapshot(): unknown
    subscribe(fn: (snapshot: unknown) => void): () => void
    store: SnapshotStore
    clearPersisted(): void
  }
}

interface CompatRuntimeExports {
  apply(ctx: unknown): void
  createSnapshotStore(init: unknown, opts?: unknown): SnapshotStore
  defineStore(decl: unknown): DefineStoreHandle
}

function loadBundle(
  localStorageMock: Storage | undefined,
  run: (exports: CompatRuntimeExports) => void,
): string {
  const registrations: Array<{ id: string; factory(require: (spec: string) => unknown): unknown }> = []
  const win: Record<string, unknown> = {
    __ModuleLoader__: { load: (registration: unknown) => registrations.push(registration as never) },
  }
  const previous = (globalThis as { localStorage?: Storage }).localStorage
  if (localStorageMock === undefined) {
    delete (globalThis as { localStorage?: Storage }).localStorage
  } else {
    ;(globalThis as { localStorage?: Storage }).localStorage = localStorageMock
  }
  try {
    const code = readFileSync(fileURLToPath(new URL('../src/client-bundle.js', import.meta.url)), 'utf8')
    new Function('window', code)(win)
    expect(registrations).toHaveLength(1)
    const { id, factory } = registrations[0]!
    run(factory((spec) => {
      throw new Error(`unexpected module-table require: ${spec}`)
    }) as unknown as CompatRuntimeExports)
    return id
  } finally {
    if (previous === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage
    } else {
      ;(globalThis as { localStorage?: Storage }).localStorage = previous
    }
  }
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial))
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: key => store.get(key) ?? null,
    key: index => [...store.keys()][index] ?? null,
    removeItem: key => void store.delete(key),
    setItem: (key, value) => void store.set(key, value),
  }
}

describe('dsh-client-runtime compat bundle', () => {
  it('registers the legacy module id', () => {
    const id = loadBundle(undefined, () => {})
    expect(id).toBe('@deepseek-ai/dsh-client-runtime')
  })

  it('exports a no-op client plugin apply', () => {
    loadBundle(undefined, (exports) => {
      expect(typeof exports.apply).toBe('function')
      expect(() => exports.apply({})).not.toThrow()
    })
  })

  it('createSnapshotStore keeps a stable snapshot and notifies on set', () => {
    loadBundle(undefined, (exports) => {
      const store = exports.createSnapshotStore({ status: 'loading' })
      expect(store.getSnapshot()).toEqual({ status: 'loading' })
      const listener = vi.fn()
      const unsubscribe = store.subscribe(listener)
      store.set({ status: 'ready', value: 1 })
      expect(store.getSnapshot()).toEqual({ status: 'ready', value: 1 })
      expect(listener).toHaveBeenCalledTimes(1)
      unsubscribe()
      store.set({ status: 'ready', value: 2 })
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })

  it('update mutates a draft copy without touching the previous snapshot', () => {
    loadBundle(undefined, (exports) => {
      const store = exports.createSnapshotStore({ count: 0 })
      const previous = store.getSnapshot()
      store.update((draft) => {
        ;(draft as { count: number }).count += 1
      })
      expect(previous).toEqual({ count: 0 })
      expect(store.getSnapshot()).toEqual({ count: 1 })
    })
  })

  it('defineStore binds actions over an immer-style draft', () => {
    loadBundle(undefined, (exports) => {
      const defined = exports.defineStore({
        init: () => ({ count: 0 }),
        actions: {
          bump: (draft: { count: number }, by: number) => {
            draft.count += by
          },
        },
      })
      const created = defined.create()
      expect(created.getSnapshot()).toEqual({ count: 0 })
      created.actions.bump?.(2)
      expect(created.getSnapshot()).toEqual({ count: 2 })
    })
  })

  it('persists the whole value to localStorage and rehydrates it', () => {
    const storage = memoryStorage()
    loadBundle(storage, (firstExports) => {
      const store = firstExports.createSnapshotStore({ n: 1 }, { persist: { name: 'compat-test' } })
      store.set({ n: 2 })
      expect(JSON.parse(storage.getItem('compat-test') ?? 'null')).toEqual({ n: 2 })
      loadBundle(storage, (secondExports) => {
        const restored = secondExports.createSnapshotStore({ n: 0 }, { persist: { name: 'compat-test' } })
        expect(restored.getSnapshot()).toEqual({ n: 2 })
      })
    })
  })
})
