# Agent Note: Provide legacy-package compatibility shims for pre-0.1.2 plugins

Status: implemented

## Problem

`dsh` 0.1.2-alpha.1 migrated two surfaces that third-party plugins still depend on:

- The Host API Proxy (`@deepseek-ai/dsh-host-apiproxy`, plus the `apiProxy`
  service) was removed; unary operations moved to owning business Remotes
  ([migration note](2026-08-10-unary-apiproxy-remote-migration.md)).
- The client runtime (`@deepseek-ai/dsh-client-runtime`, plus its `sessions`
  and `workspaces` client services) was split into the api controllers
  (`@deepseek-ai/dsh-api-session-controller`,
  `@deepseek-ai/dsh-api-workspace-controller`).

Published plugin bundles in the wild (for example `@linxin666/dsh-web-ui-all`
0.1.x — and its 0.3.x line, which still targets the old surface) hard-import
`@deepseek-ai/dsh-host-apiproxy/api/rpc`, hard-inject the `apiProxy` service,
and `require("@deepseek-ai/dsh-client-runtime/client")` from the browser module
table. Against an unmodified 0.1.2-alpha.1 tree those plugins fail: server boot
dies on `ERR_MODULE_NOT_FOUND`, and the web boot page reports loader fiber
failures.

Upgrading the plugins does not help: every published version of
`@linxin666/dsh-remote-web-ui` (0.1.20 through 0.3.6) still imports
`dsh-host-apiproxy`, and `@linxin666/dsh-client-ui-web-ui-settings` 0.3.6 still
imports `dsh-client-runtime`. Installing the old npm packages does not work
either: they drag the old `0.1.1-rc.2`/`0.1.0-rc.6` dependency closures into the
profile, shadowing the new harness's packages.

## Decision

Ship two private legacy compatibility packages under `packages/compat/`,
providing only the surface third-party bundles actually consume, with no
dependency closures:

- `packages/compat/host-apiproxy` — `@deepseek-ai/dsh-host-apiproxy`.
  - The zero-dependency `api/*` contract layer (zod only), vendored verbatim
    from the published `0.1.0-rc.6` (the version the plugins were built
    against): `api/rpc`, `api/rpc.schema`, `api/events.schema`, and the
    transitive schema modules, plus the type declarations.
  - `lib/compat-provider.js` — a profile entry that registers a stub
    `apiProxy` service. Every method call throws an explicit "unavailable"
    error, so cordis injection succeeds while the remote/mobile data channel
    stays disabled. The `apiProxy` service is deliberately not implemented:
    the harness no longer owns one.
- `packages/compat/client-runtime` — `@deepseek-ai/dsh-client-runtime`.
  - A browser module-table row (`dsh.client` declaration, no injects) whose
    bundle exports exactly `createSnapshotStore` and `defineStore` with the old
    observable semantics (snapshot store with getSnapshot/subscribe/update/set,
    optional localStorage persistence, optional rAF batching; declarative store
    builder). The client entry `apply` is a no-op: it must not register
    `sessions`/`workspaces`, which the api controllers own today — the original
    failure mode of installing the full old runtime was exactly that service
    collision (the web boot page then reported
    `@deepseek-ai/dsh-api-session-controller` and
    `@deepseek-ai/dsh-api-workspace-controller` fiber failures).

Profiles consume the packages through `link:` dependencies (the same pattern as
out-of-tree user plugins such as `dsh-cost-balance`) and enable them with two
`cordis.patch.yml` inserts: `dsh-host-apiproxy-compat` and `client-runtime`.

## Consequences

- Third-party plugins that target the removed surfaces activate and load; their
  runtime calls into the old API degrade gracefully (the mobile channel and the
  task-board preset roster, for example, log errors instead of crashing boot).
- The shims are private and never published; they are a stopgap for the plugin
  ecosystem, not a supported surface. When plugin authors migrate, delete
  `packages/compat/` and the profile entries.
- The api/ contract files are vendored and frozen at `0.1.0-rc.6`; do not
  extend them with new API surface.
