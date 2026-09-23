/**
 * Anthropic-native search through a direct Messages API call using the `web_search_20250305`
 * server tool, authenticated with the Claude *subscription* OAuth grant already stored for chat
 * (the `llm-pi-ai` route credential) rather than a metered API key. Each search costs one model
 * turn against that subscription. Anthropic's OAuth-authenticated endpoint only accepts requests
 * that present as Claude Code, so every request carries the same `anthropic-beta` features,
 * identity headers, and system-prompt identity block Claude Code itself sends; that framing is
 * inherited from how the harness already authenticates chat through the same grant, not invented
 * here. This provider does not refresh an expired grant itself — refreshing happens as a side
 * effect of a normal chat turn on the same route — so an expired token surfaces as an actionable
 * error rather than a silent hang.
 * @module @deepseek-ai/dsh-web-search-anthropic/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-session'
import type {
  AnthropicError,
  AnthropicResponse,
  ContentBlock,
  TextBlock,
  WebSearchToolResultBlock,
} from './types.ts'

/** Stable id this provider registers under. */
export const ANTHROPIC_PROVIDER_ID = 'anthropic-subscription'

/** Default Anthropic Messages endpoint, including `/v1`; `/messages` is appended. */
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1'

/** Default model id, matched to the harness's own Anthropic chat default (never Opus). */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5'

/** Default `anthropic-version` header value. */
export const ANTHROPIC_DEFAULT_API_VERSION = '2023-06-01'

/** Default upper bound on generated tokens for the Messages request. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096

/** Default maximum `web_search` server-tool uses per request. */
export const ANTHROPIC_DEFAULT_MAX_USES = 5

/** pi-ai route id whose stored OAuth grant this provider reuses by default. */
export const ANTHROPIC_DEFAULT_ROUTE = 'anthropic'

/**
 * `anthropic-beta` features an OAuth-authenticated Claude Code request always carries. Anthropic's
 * subscription endpoint refuses a request presenting neither of these as not coming from Claude Code.
 */
export const ANTHROPIC_OAUTH_BETA_FEATURES = ['claude-code-20250219', 'oauth-2025-04-20'] as const

/** Identity system-prompt block every OAuth-authenticated request must carry. */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

/** Attribution header sent on every request, matching the identity pi-ai's OAuth client sends. */
const USER_AGENT = 'claude-cli/2.1.251'

/**
 * Exact secret-free Anthropic Messages request recorded immediately before one
 * auxiliary search dispatch.
 */
export interface AnthropicSearchLlmRequest {
  /** Fully resolved Messages endpoint. */
  readonly endpoint: string
  /** `anthropic-version` header value. */
  readonly apiVersion: string
  /** Exact JSON body sent to the provider. */
  readonly body: {
    readonly model: string
    readonly max_tokens: number
    readonly system: readonly [{ readonly type: 'text'; readonly text: string }]
    readonly messages: readonly [{
      readonly role: 'user'
      readonly content: readonly [{
        readonly type: 'text'
        readonly text: string
      }]
    }]
    readonly tools: readonly [{
      readonly type: 'web_search_20250305'
      readonly name: 'web_search'
      readonly max_uses: number
    }]
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Secret-free auxiliary Anthropic search request recorded before dispatch. */
    'web/anthropic-search-llm-request': AnthropicSearchLlmRequest
  }
}

/** Resolved provider options (the plugin's `apply` supplies credential and constant defaults). */
export interface AnthropicSearchProviderOptions {
  /** Literal OAuth access token; when present it wins over {@link resolveAccessToken}. */
  apiKey?: string
  /** Resolve the current subscription OAuth access token for one search operation. */
  resolveAccessToken?: () => Promise<string | undefined>
  /** pi-ai route named by missing-credential diagnostics. */
  route?: string
  /** Endpoint base; `/messages` is appended. */
  baseURL: string
  /** Anthropic model id. */
  model: string
  /** `anthropic-version` header value. */
  apiVersion: string
  /** Upper bound on generated tokens for the Messages request. */
  maxTokens: number
  /** Maximum `web_search` server-tool uses per request. */
  maxUses: number
  /**
   * Record the exact secret-free request immediately before dispatch. A throw
   * prevents dispatch so model-visible auxiliary input cannot escape logging.
   */
  recordRequest?: (request: AnthropicSearchLlmRequest) => void
}

/**
 * Build a `url → cited_text` map from every `text` block's `citations[]`. This
 * is the snippet source: Anthropic `web_search_result` items carry
 * `url`/`title`/`page_age` but typically NO inline snippet — the excerpt lives
 * in a separate `text` block's citation, keyed by `url` (first occurrence wins).
 *
 * @param blocks - the response's content blocks; non-`text` blocks are skipped.
 * @returns the `url → cited_text` map (empty when no citations are present).
 */
export function citationSnippets(blocks: readonly ContentBlock[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'text') continue
    for (const cite of (block as TextBlock).citations ?? []) {
      if (cite.url != null && cite.url.length > 0 && cite.cited_text != null && cite.cited_text.length > 0 && !map.has(cite.url)) {
        map.set(cite.url, cite.cited_text)
      }
    }
  }
  return map
}

/**
 * Map an Anthropic Messages response to a normalized search result. Walks
 * `web_search_tool_result` blocks for citeable `web_search_result` items, joins each to its
 * citation excerpt as `snippet`, and dedupes by `url` (a `max_uses > 1` request can surface
 * the same URL across searches). The web service owns the final `maxResults` truncation, so
 * `truncated` is always `false` here.
 *
 * @param response - the parsed Messages response body.
 * @returns the normalized result with deduped, snippet-joined sources.
 * @throws {@link WebError} when native search produced no result block.
 */
export function mapAnthropicResponse(response: AnthropicResponse): WebSearchResult {
  const blocks = response.content ?? []
  const resultBlocks = blocks.filter(
    (block): block is WebSearchToolResultBlock => block.type === 'web_search_tool_result',
  )
  if (resultBlocks.length === 0) {
    throw new WebError(
      'Anthropic returned no web_search_tool_result blocks; the request may not have triggered native web search',
      'WEB_PROVIDER_ERROR',
    )
  }

  const snippets = citationSnippets(blocks)
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const block of resultBlocks) {
    for (const item of block.content ?? []) {
      if (item.type !== 'web_search_result' || item.url.length === 0 || seen.has(item.url)) continue
      seen.add(item.url)
      const snippet = snippets.get(item.url)
      sources.push({
        url: item.url,
        ...item.title != null && item.title.length > 0 ? { title: item.title } : {},
        ...snippet != null && snippet.length > 0 ? { snippet } : {},
        ...item.page_age != null && item.page_age.length > 0 ? { publishedAt: item.page_age } : {},
      })
    }
  }
  return { sources, truncated: false }
}

/**
 * The Anthropic-subscription-backed search provider. HTTP redirects fail as `WEB_PROVIDER_ERROR`;
 * failures after dispatch name the endpoint and tell the user how to recover.
 */
export class AnthropicSearchProvider implements WebSearchProvider {
  readonly id = ANTHROPIC_PROVIDER_ID

  /**
   * @param resolveOptions - the options for the NEXT operation, snapshotted
   * once at each operation's entry so one search never mixes two sections. A
   * thunk rather than a value because the plugin's settings section can change
   * between searches, and re-registering the provider to carry a new endpoint
   * would make the seam's selection observable to the user as a flicker.
   */
  constructor(private readonly resolveOptions: () => AnthropicSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveAccessToken !== undefined)
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.maxTokens)
      && isPositiveInteger(options.maxUses)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a
    // settings write landing inside that await must not send the token resolved
    // from the old section to the endpoint named by the new one.
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options, signal)
    throwIfSearchAborted(signal)
    const endpoint = `${options.baseURL}/messages`
    const body: AnthropicSearchLlmRequest['body'] = {
      model: options.model,
      max_tokens: options.maxTokens,
      system: [{ type: 'text', text: CLAUDE_CODE_IDENTITY }],
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `Perform a web search for the query: ${request.query}` }],
      }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: options.maxUses }],
    }
    options.recordRequest?.({
      endpoint,
      apiVersion: options.apiVersion,
      body,
    })
    throwIfSearchAborted(signal)
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'anthropic-version': options.apiVersion,
          'anthropic-beta': ANTHROPIC_OAUTH_BETA_FEATURES.join(','),
          'anthropic-dangerous-direct-browser-access': 'true',
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
          'x-app': 'cli',
        },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw searchEndpointError(
        endpoint,
        `Anthropic search request failed: ${String(error)}`,
        error,
      )
    }

    if (!response.ok) {
      const status = response.status
      let message = `Anthropic API error (HTTP ${status})`
      try {
        const parsed = await response.json() as AnthropicError
        const detail = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
        if (detail !== undefined && detail.length > 0) message += `: ${detail}`
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw searchEndpointError(endpoint, message)
    }

    try {
      const payload = await response.json() as AnthropicResponse
      return mapAnthropicResponse(payload)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      const message = error instanceof WebError
        ? error.message
        : `Anthropic returned an unprocessable response body: ${String(error)}`
      throw searchEndpointError(endpoint, message, error)
    }
  }

  /**
   * Resolve one operation's credential without retaining it on the provider.
   * @param options - the caller's snapshot, so the token and the endpoint it is sent to come from one section.
   * @param signal - abort signal for the surrounding search.
   * @returns the resolved OAuth access token.
   */
  private async apiKey(options: AnthropicSearchProviderOptions, signal?: AbortSignal): Promise<string> {
    throwIfSearchAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(options.resolveAccessToken?.() ?? Promise.resolve(undefined), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error)
      throw new WebError(
        `Anthropic search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    const route = options.route ?? ANTHROPIC_DEFAULT_ROUTE
    throw new WebError(
      `Anthropic search has no OAuth access token for route "${route}"; sign in to the Claude subscription on`
      + ' that route (Settings > Models) first, then retry the search',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** Add endpoint recovery instructions to failures that occur after request dispatch begins. */
function searchEndpointError(endpoint: string, message: string, cause?: unknown): WebError {
  return new WebError(
    `${message}\n\nThe web search request used endpoint ${JSON.stringify(endpoint)}. `
    + 'This provider reuses the Claude subscription sign-in from Settings > Models, not a metered API key. '
    + 'If the sign-in expired, send a chat message on that route to refresh it (or sign in again), then retry '
    + 'the search. If the endpoint itself is wrong, configure web-search-anthropic.baseURL to a trusted '
    + 'Anthropic Messages API base. Only the user should choose or change the endpoint.',
    'WEB_PROVIDER_ERROR',
    cause === undefined ? undefined : { cause },
  )
}

/**
 * Race a same-process asynchronous preflight against caller cancellation. The
 * attached settlement handlers keep observing an uncooperative operation after
 * abort so a later rejection cannot become unhandled.
 */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(searchAborted(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(searchAborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
      },
    )
  })
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw searchAborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('Anthropic search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** True for Anthropic request limits that can be sent to the Messages API. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
