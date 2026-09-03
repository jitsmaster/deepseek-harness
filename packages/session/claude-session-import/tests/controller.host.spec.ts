import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { ClaudeSessionImportController, RAW_TRANSCRIPT_MAX_BYTES, readTranscriptCapped, type ClaudeSessionImportInternals } from '../src/index.ts'

const DISCOVERED = { id: 's1', name: 'my-task', cwd: '/home/arnold/proj', status: 'done', startedAt: '2026-09-01T00:00:00Z' }

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
}

function bootController(overrides: Partial<ClaudeSessionImportInternals> = {}): ClaudeSessionImportController {
  const ctx = new Context()
  return new ClaudeSessionImportController(ctx, {
    discover: overrides.discover ?? (async () => [DISCOVERED]),
    readTranscript: overrides.readTranscript ?? (() => JSON.stringify({
      type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    })),
    ensureSession: overrides.ensureSession ?? (async () => {
      const agent = { session: { header: { cwd: '/tmp' } }, followup: vi.fn() }
      return agent as unknown as Agent
    }),
    resolveCallConfig: overrides.resolveCallConfig ?? (async (_ctx, config) => config),
    selectModel: overrides.selectModel ?? vi.fn(),
  })
}

describe('the claudeSessionImport Remote namespace', () => {
  it('publishes list and createFrom from its own service key', () => {
    const controller = bootController()
    expect(remoteMethods(controller)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'createFrom', invocation: { kind: 'direct' } },
    ])
  })

  it('lists discovered sessions', async () => {
    const controller = bootController()
    const result = await controller.list(new AbortController().signal)
    expect(result).toEqual({ sessions: [DISCOVERED] })
  })

  it('returns an empty list when discovery finds nothing', async () => {
    const controller = bootController({ discover: async () => [] })
    const result = await controller.list(new AbortController().signal)
    expect(result).toEqual({ sessions: [] })
  })

  it('creates a session and starts a followup turn with the parsed transcript as one message', async () => {
    const followup = vi.fn()
    const controller = bootController({
      ensureSession: async () => ({ session: { header: { cwd: '/tmp' } }, followup }) as unknown as Agent,
    })
    const result = await controller.createFrom('s1', new AbortController().signal)
    expect(result.sessionId).toEqual(expect.any(String))
    expect(followup).toHaveBeenCalledTimes(1)
    const [message] = followup.mock.calls[0] as [{ content: { type: string; text: string }[] }]
    expect(message.content[0]?.text).toContain('**User:** hi')
  })

  it('rejects createFrom for an unknown session id', async () => {
    const controller = bootController({ discover: async () => [] })
    const failure = await controller.createFrom('missing', new AbortController().signal).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'claude-session-import/not-found' })
  })

  it('rejects createFrom when the transcript cannot be read', async () => {
    const controller = bootController({
      readTranscript: () => { throw new Error('ENOENT') },
    })
    const failure = await controller.createFrom('s1', new AbortController().signal).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'claude-session-import/transcript-unreadable' })
  })

  it('rejects createFrom when the transcript parses to zero usable turns, instead of silently importing an empty session', async () => {
    const controller = bootController({
      readTranscript: () => fixture('zero-turns.jsonl'),
    })
    const failure = await controller.createFrom('s1', new AbortController().signal).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'claude-session-import/transcript-unreadable' })
  })

  it('installs anthropic/claude-sonnet-5 as the imported session\'s model selection', async () => {
    const selectModel = vi.fn()
    const controller = bootController({ selectModel })
    await controller.createFrom('s1', new AbortController().signal)
    expect(selectModel).toHaveBeenCalledTimes(1)
    const [, , selection] = selectModel.mock.calls[0] as [unknown, unknown, { provider: string; model: string }]
    expect(selection).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' })
  })
})

describe('the claudeSessionImport Remote namespace, mounted the way production does (ctx.plugin, not direct construction)', () => {
  it('reaches ctx.subprocess through the real default discover without a missing-inject error', async () => {
    const ctx = new Context()
    ctx.provide('subprocess', {
      resolveExecutable: async () => { throw new Error('subprocess-local: command "claude" was not found on PATH') },
    } as unknown as Context['subprocess'])
    ctx.provide('llm', {} as unknown as Context['llm'])
    const fiber = ctx.plugin(ClaudeSessionImportController, {
      ensureSession: async () => ({ session: { header: { cwd: '/tmp' } }, followup: vi.fn() }) as unknown as Agent,
      selectModel: vi.fn(),
    })
    await fiber
    const controller = ctx.get('claudeSessionImportController')
    if (controller === undefined) throw new Error('claudeSessionImportController did not mount')
    const result = await controller.list(new AbortController().signal)
    expect(result).toEqual({ sessions: [] })
  })

  it('reaches ctx.llm through the real default resolveCallConfig without a missing-inject error', async () => {
    const ctx = new Context()
    ctx.provide('subprocess', {
      resolveExecutable: async () => { throw new Error('not found') },
    } as unknown as Context['subprocess'])
    ctx.provide('llm', {
      resolveCallConfig: async (config: unknown) => config,
    } as unknown as Context['llm'])
    const followup = vi.fn()
    const fiber = ctx.plugin(ClaudeSessionImportController, {
      discover: async () => [DISCOVERED],
      readTranscript: () => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      ensureSession: async () => ({ session: { header: { cwd: '/tmp' } }, followup }) as unknown as Agent,
      selectModel: vi.fn(),
    })
    await fiber
    const controller = ctx.get('claudeSessionImportController')
    if (controller === undefined) throw new Error('claudeSessionImportController did not mount')
    const result = await controller.createFrom('s1', new AbortController().signal)
    expect(result.sessionId).toEqual(expect.any(String))
  })
})

describe('readTranscriptCapped (the default readTranscript, guarding against an unbounded synchronous read)', () => {
  it('refuses a transcript file above the raw byte cap instead of reading it into memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-session-import-'))
    try {
      const path = join(dir, 'oversized.jsonl')
      writeFileSync(path, 'x'.repeat(RAW_TRANSCRIPT_MAX_BYTES + 1))
      expect(() => readTranscriptCapped(path)).toThrow(/exceeding the .*-byte cap/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a transcript file at or below the raw byte cap normally', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-session-import-'))
    try {
      const path = join(dir, 'ok.jsonl')
      const content = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })
      writeFileSync(path, content)
      expect(readTranscriptCapped(path)).toBe(content)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createFrom, wired to the real default readTranscript (not a test stub)', () => {
  it('rejects with claude-session-import/transcript-unreadable when the transcript file exceeds the raw byte cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-session-import-'))
    try {
      const path = join(dir, 'oversized.jsonl')
      writeFileSync(path, 'x'.repeat(RAW_TRANSCRIPT_MAX_BYTES + 1))
      // readTranscript is only ever called by createFrom with the real
      // homedir-derived transcript path, which this test cannot control
      // directly — so this delegates to the real readTranscriptCapped
      // against a controlled oversized file, proving the cap is honored and
      // that createFrom wraps its throw into the documented RemoteError.
      const controller = bootController({ readTranscript: () => readTranscriptCapped(path) })
      const failure = await controller.createFrom('s1', new AbortController().signal).catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({ code: 'claude-session-import/transcript-unreadable' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
