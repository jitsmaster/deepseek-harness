/**
 * Opt-in real-binary check: one search through the user's own `claude` login (a Claude
 * subscription message, about ten seconds). Skipped when no executable resolves.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ClaudeCodeSearchProvider, defaultExecutable, locateExecutable } from '../src/index.ts'

describe.skipIf(locateExecutable(defaultExecutable()) === undefined)('real claude web search', () => {
  it('returns a cited answer and ordered sources from the real WebSearch tool', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    try {
      const provider = new ClaudeCodeSearchProvider({
        executable: defaultExecutable(),
        timeoutMs: 120_000,
        spawn: spec => ctx.subprocess.spawn(spec),
      })
      expect(provider.available()).toBe(true)
      const result = await provider.search({ query: 'node.js release schedule', maxResults: 3 })
      expect(result.sources.length).toBeGreaterThan(0)
      expect(result.sources.length).toBeLessThanOrEqual(3)
      for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
      expect(result.content?.length ?? 0).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 150_000)
})
