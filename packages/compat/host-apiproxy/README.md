# @deepseek-ai/dsh-host-apiproxy (compatibility shim)

**Legacy package. Do not build new code against it.**

The Host API Proxy was removed in `dsh` 0.1.2-alpha.1 — unary operations moved
to their owning business Remotes (see
[the migration Agent Note](../../../.agents/notes/implemented/architecture/2026-08-10-unary-apiproxy-remote-migration.md)).
Third-party plugins published against the old harness (for example
`@linxin666/dsh-web-ui-all` 0.1.x) still hard-import this package, so this shim
provides exactly the surface they touch:

- `@deepseek-ai/dsh-host-apiproxy/api/rpc`, `api/rpc.schema`,
  `api/events.schema`, and the other `api/*` contract modules, vendored from
  the published `0.1.0-rc.6` (the version those plugins were built against).
  The api/ contract layer is zero Node dependencies (zod only).
- `lib/compat-provider.js` — a cordis entry that provides a stub `apiProxy`
  service so plugins that hard-inject it can activate. Every `apiProxy` method
  call throws an "unavailable" error: the remote/mobile data channel is
  effectively disabled because the service genuinely no longer exists.

The server-side `apiProxy` service is intentionally **not** implemented. When a
plugin author drops the `apiProxy` requirement, remove this shim and the
`dsh-host-apiproxy-compat` profile entry.
