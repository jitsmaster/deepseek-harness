import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as claudeCodePlugin from '../src/index.ts'
import { CLAUDE_CODE_PROVIDER_ID, DEFAULT_CLAUDE_EXECUTABLE, defaultExecutable } from '../src/index.ts'
import { FakeClaudeSubprocess } from './harness.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

async function mount(config: claudeCodePlugin.Config = { executable: process.execPath }): Promise<{ ctx: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const root = new Context()
  ctx = root
  await root.plugin(FakeClaudeSubprocess)
  await root.plugin(WebRuntime, {})
  const fiber = await root.plugin(claudeCodePlugin, config)
  return { ctx: root, fiber }
}

describe('web-search-claude-code plugin shape', () => {
  it('has no default export and keeps name/inject/Config through the Loader unwrap', () => {
    expect('default' in claudeCodePlugin).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(claudeCodePlugin) as Record<string, unknown>
    expect(unwrapped).toBe(claudeCodePlugin)
    expect(unwrapped.name).toBe('web-search-claude-code')
    expect(unwrapped.inject).toEqual(['web', 'subprocess'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('defaults the executable to claude on PATH, else the standard install location', () => {
    expect(DEFAULT_CLAUDE_EXECUTABLE).toBe('claude')
    const bin = mkdtempSync(join(tmpdir(), 'dsh-ws-claude-bin-'))
    const file = join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude')
    try {
      writeFileSync(file, '', { mode: 0o755 })
      expect(defaultExecutable({ PATH: bin, Path: bin })).toBe(file)
      expect(defaultExecutable({ PATH: '', Path: '' })).toBe(
        join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
      )
    } finally {
      rmSync(file)
      rmdirSync(bin)
    }
  })
})

describe('web-search-claude-code registry disposal (HMR safety)', () => {
  it('registers the provider on ctx.web and removes it when the fiber is disposed', async () => {
    const mounted = await mount()
    expect(await mounted.ctx.web.searchReady()).toBe(true)
    // Pin the provider by id: it is selectable only while registered.
    const selected = mounted.ctx.web.search({ query: '   ' })
    await expect(selected).rejects.toMatchObject({ code: 'WEB_INVALID_QUERY' })

    await mounted.fiber.dispose()
    await expect(mounted.ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
  })

  it('can re-register after disposal without a duplicate-provider error', async () => {
    const mounted = await mount()
    await mounted.fiber.dispose()
    const again = await mounted.ctx.plugin(claudeCodePlugin, { executable: process.execPath })
    await expect(mounted.ctx.web.search({ query: '  ' })).rejects.toMatchObject({ code: 'WEB_INVALID_QUERY' })
    await again.dispose()
  })

  it('stays unselectable while its executable is missing', async () => {
    const mounted = await mount({ executable: 'dsh-no-such-claude-binary' })
    await expect(mounted.ctx.web.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
  })

  it('exposes the provider id as the pinning value', () => {
    expect(CLAUDE_CODE_PROVIDER_ID).toBe('claude-code')
  })

  it('rejects a non-positive timeout at apply', async () => {
    await expect(mount({ executable: process.execPath, timeoutMs: -5 })).rejects.toThrow(/timeoutMs/)
  })
})
