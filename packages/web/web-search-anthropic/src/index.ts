/**
 * Register an Anthropic-subscription-backed provider in `ctx.web`. It calls Anthropic's own
 * Messages API with native `web_search_20250305`, authenticated with the OAuth grant already
 * stored for chat under an `llm-pi-ai` route (default `anthropic`) — the same sign-in
 * Settings > Models writes — rather than a separate metered API key. This provider does not
 * perform its own OAuth refresh; an expired grant is refreshed the same way chat refreshes it
 * (send a message on that route, or sign in again).
 * @module @deepseek-ai/dsh-web-search-anthropic
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-credentials'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  AnthropicSearchProvider,
  ANTHROPIC_DEFAULT_API_VERSION,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_DEFAULT_MAX_USES,
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_DEFAULT_ROUTE,
} from './provider.ts'
import type { AnthropicSearchProviderOptions } from './provider.ts'

export {
  AnthropicSearchProvider,
  ANTHROPIC_DEFAULT_API_VERSION,
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_DEFAULT_MAX_USES,
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_DEFAULT_ROUTE,
  ANTHROPIC_OAUTH_BETA_FEATURES,
  ANTHROPIC_PROVIDER_ID,
} from './provider.ts'
export type { AnthropicSearchLlmRequest, AnthropicSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-anthropic'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills stored-grant and constant defaults). */
export interface Config {
  /** The `llm-pi-ai` provider route whose stored OAuth grant to reuse. Defaults to `anthropic`. */
  route?: string
  /** Anthropic Messages endpoint base; `/messages` is appended. */
  baseURL?: string
  /** Anthropic model id. Defaults to `claude-sonnet-5`. */
  model?: string
  /** `anthropic-version` header value. Defaults to `2023-06-01`. */
  apiVersion?: string
  /** Upper bound on generated tokens for the Messages request. Defaults to 4096. */
  maxTokens?: number
  /** Maximum `web_search` server-tool uses per request. Defaults to 5. */
  maxUses?: number
}

export const Config: z<Config> = z.object({
  route: z.string().default(ANTHROPIC_DEFAULT_ROUTE),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string().default(ANTHROPIC_DEFAULT_BASE_URL),
  model: z.string().default(ANTHROPIC_DEFAULT_MODEL),
  apiVersion: z.string().default(ANTHROPIC_DEFAULT_API_VERSION),
  maxTokens: z.number().step(1).min(1).default(ANTHROPIC_DEFAULT_MAX_TOKENS),
  maxUses: z.number().step(1).min(1).default(ANTHROPIC_DEFAULT_MAX_USES),
})

/** Settings namespace carrying this provider's route, endpoint, and model. */
export const WEB_SEARCH_ANTHROPIC_SETTINGS_NAMESPACE = 'web-search-anthropic'

/** Safety margin subtracted from a grant's `expires` timestamp before treating it as usable. */
const EXPIRY_SAFETY_MARGIN_MS = 30_000

/** The shape this provider expects inside a `llm-pi-ai`-owned OAuth grant record's payload. */
interface StoredOAuthGrant {
  type?: string
  access?: string
  expires?: number
}

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Reading the stored grant stays here rather than in the
 * provider: every value the provider reads is already fully resolved.
 * @param ctx - plugin context supplying the credentials plane.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config): AnthropicSearchProviderOptions {
  const route = config.route ?? ANTHROPIC_DEFAULT_ROUTE
  return {
    route,
    resolveAccessToken: async () => {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return undefined
      const record = await credentials.readRecord(recordKeyFor(route))
      if (record === undefined || record.kind !== 'grant') return undefined
      const payload = record.payload as StoredOAuthGrant
      if (payload.type !== 'oauth' || typeof payload.access !== 'string' || payload.access.length === 0) {
        return undefined
      }
      if (typeof payload.expires === 'number' && payload.expires <= Date.now() + EXPIRY_SAFETY_MARGIN_MS) {
        throw new WebError(
          `Anthropic search credential for route "${route}" has expired; this provider does not refresh it`
          + ' itself — send a chat message on that route (or sign in again through Settings > Models) to'
          + ' refresh the grant, then retry the search',
          'WEB_PROVIDER_ERROR',
        )
      }
      return payload.access
    },
    baseURL: config.baseURL ?? ANTHROPIC_DEFAULT_BASE_URL,
    model: config.model ?? ANTHROPIC_DEFAULT_MODEL,
    apiVersion: config.apiVersion ?? ANTHROPIC_DEFAULT_API_VERSION,
    maxTokens: config.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    maxUses: config.maxUses ?? ANTHROPIC_DEFAULT_MAX_USES,
    recordRequest: (request) => {
      ctx.get('agents')?.currentInitiator()?.session.append(
        'web/anthropic-search-llm-request',
        request,
      )
    },
  }
}

/** Register the Anthropic-subscription search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, WEB_SEARCH_ANTHROPIC_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source
      },
      // The registration carries no resolved value: the provider projects the
      // section per search, so a committed change needs no re-registration.
      onChange: () => {},
    })
  })
  ctx.web.registerSearchProvider(new AnthropicSearchProvider(() => resolveOptions(ctx, current())))
}
