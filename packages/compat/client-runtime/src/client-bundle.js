/**
 * Browser bundle for the dsh-client-runtime compatibility shim.
 *
 * The published dsh-client-runtime 0.1.1-rc.2 bundle provided client-side
 * `sessions`/`workspaces` services, which collide with the services owned by
 * dsh-api-session-controller / dsh-api-workspace-controller in dsh 0.1.2-alpha.1.
 * Plugins in the wild (linxin666 dsh-web-ui-all 0.1.x) only consume the store
 * primitives `createSnapshotStore` and `defineStore` from this module, so this
 * shim exports exactly those two, with the same observable semantics, and
 * registers no services.
 * @module @deepseek-ai/dsh-client-runtime/client
 */
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-runtime",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /**
     * Create a snapshot store over a plain initial value.
     * Compatible with the old runtime's contract: `getSnapshot` returns the
     * current value with a stable reference until a change, `subscribe` takes
     * a listener and returns an unsubscribe, `update` mutates a draft copy
     * (immer-like), `set` replaces the value. `opts.persist.name` round-trips
     * the whole value through localStorage; `opts.flush === "raf"` batches
     * notifications on requestAnimationFrame.
     */
    function createSnapshotStore(init, opts) {
      let state = init;
      const listeners = new Set();
      let rafPending = false;
      const notify = () => {
        const snapshot = state;
        for (const fn of [...listeners]) fn(snapshot);
      };
      const notifyRaf = () => {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          notify();
        });
      };
      const emit = () => (opts !== undefined && opts.flush === "raf" ? notifyRaf : notify)();
      if (opts !== undefined && opts.persist !== undefined) {
        try {
          const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(opts.persist.name);
          if (raw !== null) state = JSON.parse(raw);
        } catch (error) {
          console.error(`snapshot store '${opts.persist.name}' rehydration failed:`, error);
        }
        if (typeof localStorage !== "undefined") {
          listeners.add(() => {
            try {
              localStorage.setItem(opts.persist.name, JSON.stringify(state));
            } catch (error) {
              console.error(`snapshot store '${opts.persist.name}' persistence failed:`, error);
            }
          });
        }
      }
      return {
        getSnapshot: () => state,
        subscribe: (fn) => {
          listeners.add(fn);
          return () => {
            listeners.delete(fn);
          };
        },
        update: (mutator) => {
          const next = cloneSnapshot(state);
          mutator(next);
          state = next;
          emit();
        },
        set: (next) => {
          state = next;
          emit();
        },
      };
    }

    /**
     * Clone a plain snapshot for the immer-style `update` draft. Structured
     * clone covers the plugins' plain-object states; the fallback shallow
     * copy keeps the draft usable for states that cannot be cloned.
     */
    function cloneSnapshot(value) {
      try {
        return structuredClone(value);
      } catch {
        return Array.isArray(value) ? [...value] : typeof value === "object" && value !== null ? { ...value } : value;
      }
    }

    /**
     * Declarative store builder used by dsh-pet: `{ init, actions, persist }`.
     * `create(scopeKey)` builds one snapshot store instance with bound actions.
     */
    function defineStore(decl) {
      return {
        spec: decl,
        create(scopeKey) {
          const persistKey = decl.persist === void 0 ? void 0 : scopeKey === void 0 ? decl.persist : `${decl.persist}.${scopeKey}`;
          const store = createSnapshotStore(decl.init(), persistKey !== void 0 ? { persist: { name: persistKey } } : void 0);
          const actions = {};
          for (const key of Object.keys(decl.actions)) {
            const mutate = decl.actions[key];
            actions[key] = (...params) => {
              store.update((draft) => {
                mutate(draft, ...params);
              });
            };
          }
          return {
            actions,
            getSnapshot: () => store.getSnapshot(),
            subscribe: (fn) => store.subscribe(fn),
            store,
            clearPersisted: () => {
              if (persistKey === void 0 || typeof localStorage === "undefined") return;
              try {
                localStorage.removeItem(persistKey);
              } catch {}
            },
          };
        },
      };
    }

    /**
     * No-op client plugin body: the legacy runtime provided `sessions` and
     * `workspaces` services here, which now belong to the api controllers.
     * Staying silent keeps the loader happy without colliding with them.
     */
    function apply(_ctx) {}

    module.exports = { apply, createSnapshotStore, defineStore };
    return module.exports;
  },
});
