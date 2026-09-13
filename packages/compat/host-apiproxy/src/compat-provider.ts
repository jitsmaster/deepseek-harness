/**
 * Compatibility service provider for plugins that hard-inject the legacy
 * `apiProxy` service (for example `@linxin666/dsh-remote-web-ui`).
 *
 * The Host API Proxy was removed in dsh 0.1.2-alpha.1; this entry satisfies the
 * cordis injection so those plugins can activate. Every `apiProxy` method call
 * throws an explicit "unavailable" error, so the remote/mobile data channel is
 * effectively disabled.
 * @module @deepseek-ai/dsh-host-apiproxy/compat-provider
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-host-apiproxy-compat'

const unavailableMessage =
  'apiProxy service is unavailable: the Host API Proxy was removed in dsh 0.1.2-alpha.1; ' +
  'the remote/mobile data channel is disabled'

/**
 * Register the apiProxy service stub so legacy plugins activate.
 * @param ctx - cordis context.
 */
export function apply(ctx: Context): void {
  const stub = new Proxy(function apiProxyUnavailable() {}, {
    get(_target, property) {
      // Never assimilate into a Promise chain.
      if (property === 'then') return undefined
      return stub
    },
    apply() {
      throw new Error(unavailableMessage)
    },
    construct() {
      throw new Error(unavailableMessage)
    },
  })
  ctx.provide('apiProxy', stub)
}
