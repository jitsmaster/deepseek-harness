import { describe, expect, it } from 'vitest'
import { buildToolAliases, MCP_TOOL_PREFIX } from '../src/names.ts'

const SAFE = /^[A-Za-z0-9_-]{1,64}$/u

describe('tool-name aliases', () => {
  it('keeps names that already fit the MCP tool-name rule', () => {
    const aliases = buildToolAliases(['read', 'bash', 'web_search', 'a-b', 'x'.repeat(54)])
    for (const name of ['read', 'bash', 'web_search', 'a-b', 'x'.repeat(54)]) {
      expect(aliases.aliasOf(name)).toBe(name)
      expect(aliases.nameOf(name)).toBe(name)
    }
  })

  it('gives unfit names a deterministic safe alias that fits behind the server prefix', () => {
    const names = ['web.search', 'x'.repeat(60), 'héllo wörld', 'a/b', '']
    const first = buildToolAliases(names)
    const second = buildToolAliases(names)
    for (const name of names) {
      const alias = first.aliasOf(name)
      expect(alias).toBe(second.aliasOf(name))
      expect(SAFE.test(MCP_TOOL_PREFIX + alias)).toBe(true)
      expect(MCP_TOOL_PREFIX.length + alias.length).toBeLessThanOrEqual(64)
      expect(first.nameOf(alias)).toBe(name)
    }
    expect(new Set(names.map(name => first.aliasOf(name))).size).toBe(names.length)
  })

  it('keeps names that sanitise identically apart', () => {
    const aliases = buildToolAliases(['a.b', 'a/b', 'a b'])
    expect(new Set(['a.b', 'a/b', 'a b'].map(name => aliases.aliasOf(name))).size).toBe(3)
  })

  it('never lets an alias collide with a tool that is literally named like it', () => {
    const first = buildToolAliases(['web.search'])
    const taken = first.aliasOf('web.search')
    const aliases = buildToolAliases(['web.search', taken])
    expect(aliases.aliasOf(taken)).toBe(taken)
    expect(aliases.aliasOf('web.search')).not.toBe(taken)
    expect(aliases.nameOf(taken)).toBe(taken)
    expect(aliases.nameOf(aliases.aliasOf('web.search'))).toBe('web.search')
  })

  it('passes an unknown alias through unchanged', () => {
    expect(buildToolAliases(['read']).nameOf('mystery')).toBe('mystery')
  })
})
