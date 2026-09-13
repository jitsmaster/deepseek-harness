/**
 * Legacy Host API Proxy contract barrel.
 *
 * The API Proxy service was removed in dsh 0.1.2-alpha.1 (see
 * .agents/notes/implemented/architecture/2026-08-10-unary-apiproxy-remote-migration.md).
 * This package survives only so third-party plugins published against the old
 * harness can keep resolving `@deepseek-ai/dsh-host-apiproxy/api/*`. The root
 * entry re-exports the zero-dependency contract layer; the `apiProxy` service
 * itself is a stub provided by {@link ./compat-provider.ts}.
 * @module @deepseek-ai/dsh-host-apiproxy
 */

export * from './api/index.js'
