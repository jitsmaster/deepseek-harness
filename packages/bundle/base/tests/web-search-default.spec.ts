/**
 * RED-phase anchor for the keyless web-search fix. See
 * .agents/notes/proposed/architecture/2026-09-01-browser-authorization-and-keyless-web-search.md
 * ("Web-search default fix"): the base bundle currently pins `web.searchProvider`
 * to `deepseek-official`, so a deployment with no DeepSeek credential gets a
 * DeepSeek-flavored `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` failure instead of the
 * neutral, provider-agnostic `WEB_PROVIDER_UNAVAILABLE`. These tests read the
 * REAL `cordis.patch.yml` (not a fixture) so they fail against the current
 * pinned config and pass once the one-line `searchProvider` pin is removed.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime, { type WebRuntimeConfig } from '@deepseek-ai/dsh-web'

interface PatchRow {
  readonly id?: string
  readonly config?: Record<string, unknown>
}

/** Read and flatten the base bundle's real patch rows, exactly as it ships. */
function loadBaseRows(): PatchRow[] {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const parsed = yaml.load(
    readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
    { schema: entryListSchema },
  )
  if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
  return parsed.flatMap((patch): PatchRow[] =>
    typeof patch === 'object' && patch !== null ? (patch as { insert?: PatchRow[] }).insert ?? [] : [])
}

/** The `web` row's own `config`, as actually shipped. */
function webRowConfig(): WebRuntimeConfig {
  const row = loadBaseRows().find(candidate => candidate.id === 'web')
  if (row?.config === undefined) throw new Error('base patch must mount the web row')
  return row.config as WebRuntimeConfig
}

describe('the base bundle web row no longer pins a DeepSeek-specific search provider', () => {
  it('drops the searchProvider pin while keeping fetchProvider untouched', () => {
    const config = webRowConfig()
    expect(config).not.toHaveProperty('searchProvider')
    expect(config).toMatchObject({ fetchProvider: 'http' })
  })
})

describe('WebRuntime.search() over the shipped web row config', () => {
  it('yields the neutral WEB_PROVIDER_UNAVAILABLE, never a DeepSeek-specific code, when no search credential is configured', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, webRowConfig())
    // Stands in for web-search-deepseek registered but unusable (no key
    // anywhere): auto-selection, not an explicit pin, must decide the outcome.
    ctx.web.registerSearchProvider({
      id: 'deepseek-official',
      available: () => false,
      search: () => Promise.reject(new Error('must not be called: provider is unavailable')),
    })

    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_UNAVAILABLE' }))
  })

  it('keeps auto-selecting a usable DeepSeek search provider unchanged — zero regression when a DeepSeek key IS present', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, webRowConfig())
    ctx.web.registerSearchProvider({
      id: 'deepseek-official',
      available: () => true,
      search: () => Promise.resolve({ content: 'answer', sources: [], truncated: false }),
    })

    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ content: 'answer' })
  })
})
