import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { ClaudeSessionImportController, type ClaudeSessionImportInternals } from '../src/index.ts'

const DISCOVERED = { id: 's1', name: 'my-task', cwd: '/home/arnold/proj', status: 'done', startedAt: '2026-09-01T00:00:00Z' }

function bootController(overrides: Partial<ClaudeSessionImportInternals> = {}): ClaudeSessionImportController {
  const ctx = new Context()
  return new ClaudeSessionImportController(ctx, {
    discover: overrides.discover ?? (async () => [DISCOVERED]),
    readTranscript: overrides.readTranscript ?? (() => JSON.stringify({
      type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    })),
    ensureSession: overrides.ensureSession ?? (async () => {
      const agent = { session: { header: { cwd: '/tmp' } }, inject: vi.fn() }
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

  it('creates a session and injects the parsed transcript as one message', async () => {
    const inject = vi.fn()
    const controller = bootController({
      ensureSession: async () => ({ session: { header: { cwd: '/tmp' } }, inject }) as unknown as Agent,
    })
    const result = await controller.createFrom('s1', new AbortController().signal)
    expect(result.sessionId).toEqual(expect.any(String))
    expect(inject).toHaveBeenCalledTimes(1)
    const [message] = inject.mock.calls[0] as [{ content: { type: string; text: string }[] }]
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

  it('installs anthropic/claude-sonnet-5 as the imported session\'s model selection', async () => {
    const selectModel = vi.fn()
    const controller = bootController({ selectModel })
    await controller.createFrom('s1', new AbortController().signal)
    expect(selectModel).toHaveBeenCalledTimes(1)
    const [, , selection] = selectModel.mock.calls[0] as [unknown, unknown, { provider: string; model: string }]
    expect(selection).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' })
  })
})
