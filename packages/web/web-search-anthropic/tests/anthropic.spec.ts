import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { recordKeyFor } from '@deepseek-ai/dsh-llm-pi-ai'
import WebRuntime, { WebError } from '@deepseek-ai/dsh-web'
import {
  AnthropicSearchProvider,
  ANTHROPIC_PROVIDER_ID,
} from '@deepseek-ai/dsh-web-search-anthropic'
import * as anthropicPlugin from '@deepseek-ai/dsh-web-search-anthropic'
import { citationSnippets, mapAnthropicResponse } from '../src/provider.ts'
import type { AnthropicResponse } from '@deepseek-ai/dsh-web-search-anthropic/src/types.ts'

/** Construct the provider over a fixed options value; production passes a live thunk. */
import type { AnthropicSearchProviderOptions } from '@deepseek-ai/dsh-web-search-anthropic'

const searchProvider = (options: AnthropicSearchProviderOptions): AnthropicSearchProvider =>
  new AnthropicSearchProvider(() => options)

/** Return the provider's rejected WebError, or propagate an unexpected outcome. */
async function rejectedWebError(operation: Promise<unknown>): Promise<WebError> {
  try {
    await operation
  } catch (error: unknown) {
    if (error instanceof WebError) return error
    throw error
  }
  throw new Error('expected search operation to reject')
}

const options = {
  apiKey: 'sk-ant-oat-token',
  baseURL: 'https://api.anthropic.test/v1',
  model: 'claude-sonnet-5',
  apiVersion: '2023-06-01',
  maxTokens: 4096,
  maxUses: 5,
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** A response with one result block plus a text block carrying the snippet. */
function searchResponse(): AnthropicResponse {
  return {
    content: [
      { type: 'text', text: 'Here is what I found.', citations: [{ type: 'web_search_result_location', url: 'https://a.test', cited_text: 'excerpt for A' }] },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://a.test', title: 'A', page_age: '2026-02-02' },
          { type: 'web_search_result', url: 'https://b.test', title: 'B' },
        ],
      },
    ],
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('citationSnippets', () => {
  it('maps url → cited_text from text blocks, first occurrence wins', () => {
    const map = citationSnippets([
      { type: 'text', citations: [{ url: 'https://a.test', cited_text: 'first' }, { url: 'https://a.test', cited_text: 'second' }] },
      { type: 'text', citations: [{ url: 'https://b.test', cited_text: 'b text' }] },
    ])
    expect(map.get('https://a.test')).toBe('first')
    expect(map.get('https://b.test')).toBe('b text')
  })
})

describe('mapAnthropicResponse', () => {
  it('joins result items to citation snippets and maps page_age to publishedAt', () => {
    const result = mapAnthropicResponse(searchResponse())
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'excerpt for A', publishedAt: '2026-02-02' },
        { url: 'https://b.test', title: 'B' },
      ],
      truncated: false,
    })
  })

  it('dedupes repeated urls across result blocks (first wins)', () => {
    const result = mapAnthropicResponse({
      content: [
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test', title: 'first' }] },
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test', title: 'second' }] },
      ],
    })
    expect(result.sources).toEqual([{ url: 'https://a.test', title: 'first' }])
  })

  it('throws WEB_PROVIDER_ERROR when no result block is present', () => {
    expect(() => mapAnthropicResponse({ content: [{ type: 'text', text: 'just prose, no search' }] }))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })
})

describe('AnthropicSearchProvider availability', () => {
  it('is unavailable without a token', () => {
    expect(searchProvider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a token', () => {
    expect(searchProvider(options).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(searchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when request limits are not positive integers', () => {
    expect(searchProvider({ ...options, maxTokens: 0 }).available()).toBe(false)
    expect(searchProvider({ ...options, maxUses: 0 }).available()).toBe(false)
    expect(searchProvider({ ...options, maxUses: 1.5 }).available()).toBe(false)
  })
})

describe('AnthropicSearchProvider request mapping', () => {
  it('records and posts the OAuth-framed Anthropic Messages request with the web_search server tool', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    const recordRequest = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, recordRequest }).search({ query: 'hello' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.test/v1/messages')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['authorization']).toBe('Bearer sk-ant-oat-token')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-beta']).toBe('claude-code-20250219,oauth-2025-04-20')
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(headers['x-app']).toBe('cli')
    const body = {
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: hello' }] }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    }
    expect(JSON.parse(init.body as string)).toEqual(body)
    expect(recordRequest).toHaveBeenCalledOnce()
    expect(recordRequest).toHaveBeenCalledWith({
      endpoint: url,
      apiVersion: '2023-06-01',
      body,
    })
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await searchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('AnthropicSearchProvider settings changes mid-search', () => {
  it('serves one search from one section even when settings land during credential resolution', async () => {
    const before = { ...options, apiKey: '', baseURL: 'https://before.test/v1', model: 'model-before', maxUses: 2 }
    const after = { ...options, apiKey: '', baseURL: 'https://after.test/v1', model: 'model-after', maxUses: 9 }
    let current = before
    let commitSettings = () => {}
    const resolveAccessToken = () => new Promise<string>((resolve) => {
      commitSettings = () => { current = after; resolve('token-from-before') }
    })
    const fetchMock = vi.fn(async () => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new AnthropicSearchProvider(() => ({ ...current, resolveAccessToken }))
    const search = provider.search({ query: 'q' })
    await vi.waitFor(() => { expect(typeof commitSettings).toBe('function') })
    commitSettings()
    await search

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }]
    // The token resolved from `before` must never reach `after`'s origin.
    expect(endpoint).toBe('https://before.test/v1/messages')
    expect(init.headers['authorization']).toBe('Bearer token-from-before')
    expect(JSON.parse(init.body)).toMatchObject({ model: 'model-before' })
  })
})

describe('AnthropicSearchProvider error handling', () => {
  it('does not start credential resolution or dispatch for a pre-aborted call', async () => {
    const resolveAccessToken = vi.fn(async () => 'late-token')
    const recordRequest = vi.fn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(searchProvider({
      ...options,
      apiKey: '',
      resolveAccessToken,
      recordRequest,
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveAccessToken).not.toHaveBeenCalled()
    expect(recordRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the default route when no resolver supplies a token', async () => {
    await expect(searchProvider({ ...options, apiKey: '' }).search({ query: 'q' }))
      .rejects.toThrow('Anthropic search has no OAuth access token for route "anthropic"')
  })

  it('propagates an expired-grant diagnostic from the resolver', async () => {
    const error = await rejectedWebError(searchProvider({
      ...options,
      apiKey: '',
      resolveAccessToken: () => Promise.reject(new WebError('Anthropic search credential for route "anthropic" has expired', 'WEB_PROVIDER_ERROR')),
    }).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('has expired')
  })

  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: { message: 'rate limited' } }, { status: 429 })))
    const error = await rejectedWebError(searchProvider(options).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
    expect(error.message).toContain('Anthropic API error (HTTP 429): rate limited')
    expect(error.message).toContain('reuses the Claude subscription sign-in')
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('strict mode flows through search(): a prose-only response throws WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ content: [{ type: 'text', text: 'no search happened' }] })))
    const error = await rejectedWebError(searchProvider(options).search({ query: 'q' }))
    expect(error.code).toBe('WEB_PROVIDER_ERROR')
  })
})

describe('web-search-anthropic plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(searchResponse())))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ANTHROPIC_PROVIDER_ID })
    const fiber = await ctx.plugin(anthropicPlugin, {})
    // No credentials seam mounted: the resolver returns undefined, so the
    // provider reports the actionable missing-credential diagnostic.
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('rejects maxTokens: 0 at plugin construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ANTHROPIC_PROVIDER_ID })
    await expect(ctx.plugin(anthropicPlugin, { maxTokens: 0 }))
      .rejects.toThrow(/maxTokens expected number >= 1/)
  })

  it('rejects a fractional maxUses at plugin construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ANTHROPIC_PROVIDER_ID })
    await expect(ctx.plugin(anthropicPlugin, { maxUses: 1.5 }))
      .rejects.toThrow(/maxUses expected number multiple of 1/)
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in anthropicPlugin).toBe(false)
  })

  it('survives the real Loader unwrapExports path keeping name/inject/Config', () => {
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(anthropicPlugin) as Record<string, unknown>
    expect(unwrapped).toBe(anthropicPlugin)
    expect(unwrapped.name).toBe('web-search-anthropic')
    expect(unwrapped.inject).toEqual(['web'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('reads the stored llm-pi-ai OAuth grant for the configured route so a fresh sign-in needs no restart', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(searchResponse()))
    vi.stubGlobal('fetch', fetchMock)
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-anthropic-credentials-'))
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: ANTHROPIC_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(anthropicPlugin, {})

      await expect(ctx.web.search({ query: 'missing' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))

      const key = recordKeyFor('anthropic')
      await ctx.credentials.modifyRecord(key, async () => ({
        kind: 'grant',
        payload: { type: 'oauth', access: 'sk-ant-oat-stored', refresh: 'sk-ant-ort-stored', expires: Date.now() + 3_600_000 },
      }))
      await ctx.web.search({ query: 'stored' })

      const headers = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>)
      expect(headers.map(value => value['authorization'])).toEqual(['Bearer sk-ant-oat-stored'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces an actionable error for a grant that has already expired', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-anthropic-credentials-'))
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: ANTHROPIC_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(anthropicPlugin, {})

      const key = recordKeyFor('anthropic')
      await ctx.credentials.modifyRecord(key, async () => ({
        kind: 'grant',
        payload: { type: 'oauth', access: 'sk-ant-oat-stale', expires: Date.now() - 1_000 },
      }))

      const error = await rejectedWebError(ctx.web.search({ query: 'q' }))
      expect(error.code).toBe('WEB_PROVIDER_ERROR')
      expect(error.message).toContain('does not refresh it itself')
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
