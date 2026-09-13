# @deepseek-ai/dsh-client-runtime (compatibility shim)

**Legacy package. Do not build new code against it.**

The old client runtime was migrated in `dsh` 0.1.2-alpha.1: the `sessions` and
`workspaces` client services it provided now belong to
`@deepseek-ai/dsh-api-session-controller` and
`@deepseek-ai/dsh-api-workspace-controller`. Third-party client bundles
published against the old harness (for example `@linxin666/dsh-web-ui-all`
0.1.x) still `require("@deepseek-ai/dsh-client-runtime/client")` from the
browser module table, so this shim provides a module-table row that exports
exactly the members those bundles consume:

- `createSnapshotStore(init, opts)` — snapshot store with `getSnapshot`,
  `subscribe`, `update` (immer-style draft mutation), and `set`, plus optional
  whole-value `localStorage` persistence (`opts.persist.name`) and
  `requestAnimationFrame`-batched notifications (`opts.flush === "raf"`).
- `defineStore(decl)` — declarative store builder (`{ init, actions, persist }`)
  returning `{ spec, create(scopeKey) }`.

The shim registers **no** `sessions`/`workspaces` services, so it cannot
collide with the api controllers that own those names today. Its client entry
`apply` is a no-op.
