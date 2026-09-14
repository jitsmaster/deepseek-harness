import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { listClaudeCodeSessions } from '../src/discovery.ts'

function stubbedCtx(
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  resolveExecutable: (command: string) => Promise<string> = async command => command,
): Context {
  const ctx = new Context()
  ctx.provide('subprocess', { spawn, resolveExecutable } as unknown as Context['subprocess'])
  // Real Logger service is heavyweight (exporters, formatting); a plain
  // vi.fn() stub is this repo's established pattern for asserting on logger
  // calls (see e.g. subagent/subagent's tests/service.spec.ts).
  ctx.logger.warn = vi.fn()
  return ctx
}

function handleWithStdout(json: string, exitCode = 0): SubprocessHandle {
  const stdout = { readFrom: () => ({ text: json, nextOffset: json.length, lossy: false }) }
  return {
    pid: 123,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: () => {},
  } as unknown as SubprocessHandle
}

describe('listClaudeCodeSessions', () => {
  it('parses a well-formed session list — a bare array, per the real `claude agents --json --all` output', async () => {
    const raw = JSON.stringify([
      {
        id: 'd29f43be',
        sessionId: 'd29f43be-6571-4119-a9d2-af9ae95acc17',
        name: 'my-task',
        cwd: 'D:/dev/DSH',
        kind: 'background',
        state: 'working',
        startedAt: 1725100800000,
      },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([
      {
        id: 'd29f43be-6571-4119-a9d2-af9ae95acc17',
        name: 'my-task',
        cwd: 'D:/dev/DSH',
        status: 'working',
        startedAt: new Date(1725100800000).toISOString(),
      },
    ])
  })

  it('returns an empty list when the claude binary is missing, and logs why', async () => {
    const ctx = stubbedCtx(() => { throw new Error('ENOENT: claude not found') })
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/claude-session-import.*not found or could not be spawned.*ENOENT/))
  })

  it('returns an empty list when claude cannot be resolved on PATH at all', async () => {
    const ctx = stubbedCtx(
      () => handleWithStdout('[]'),
      async () => { throw new Error('subprocess-local: command "claude" was not found on PATH') },
    )
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
  })

  it('returns an empty list and logs a distinguishing message when the process exits non-zero', async () => {
    const ctx = stubbedCtx(() => handleWithStdout('[]', 1))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/claude-session-import.*did not exit successfully.*exit code 1/))
  })

  it('returns an empty list when output is not valid JSON, and logs why', async () => {
    const ctx = stubbedCtx(() => handleWithStdout('not json'))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/claude-session-import.*could not parse.*as JSON/))
  })

  it('returns an empty list for an empty array', async () => {
    const ctx = stubbedCtx(() => handleWithStdout(JSON.stringify([])))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
  })

  it('returns an empty list and logs a distinguishing message when output is the old wrapped-object shape instead of a bare array', async () => {
    const ctx = stubbedCtx(() => handleWithStdout(JSON.stringify({ sessions: [] })))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/claude-session-import.*not a JSON array/))
  })

  it('skips entries missing sessionId/state/startedAt without failing the whole parse', async () => {
    const raw = JSON.stringify([
      { id: 'ok1', sessionId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'good', cwd: '/tmp', kind: 'background', state: 'done', startedAt: 1725100800000 },
      { id: 'bad1', name: 'missing sessionId', cwd: '/tmp', kind: 'background', state: 'done', startedAt: 1725100800000 },
      { id: 'bad2', sessionId: 'bad2-full', name: 'missing state', cwd: '/tmp', kind: 'background', startedAt: 1725100800000 },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([
      { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'good', cwd: '/tmp', status: 'done', startedAt: new Date(1725100800000).toISOString() },
    ])
  })

  it('skips an entry whose sessionId is not UUID-shaped, and logs a warning', async () => {
    const raw = JSON.stringify([
      {
        id: 'not-a-uuid',
        sessionId: 'not-a-uuid',
        name: 'suspicious',
        cwd: '/tmp',
        kind: 'background',
        state: 'working',
        startedAt: 1725100800000,
      },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/claude-session-import/))
  })

  it('skips an entry whose sessionId is a too-short hex string, and logs a warning', async () => {
    const raw = JSON.stringify([
      {
        id: 'deadbeef',
        sessionId: 'deadbeef-cafe',
        name: 'suspicious',
        cwd: '/tmp',
        kind: 'background',
        state: 'working',
        startedAt: 1725100800000,
      },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/claude-session-import/))
  })

  it('skips an entry whose cwd is a relative path (would resolve unpredictably in ensureSession\'s cwd-scoping), and logs a warning', async () => {
    const raw = JSON.stringify([
      {
        id: 'd29f43be',
        sessionId: 'd29f43be-6571-4119-a9d2-af9ae95acc17',
        name: 'suspicious',
        cwd: '../../secrets',
        kind: 'background',
        state: 'working',
        startedAt: 1725100800000,
      },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/claude-session-import/))
  })

  it('skips an entry whose cwd is a bare relative path, and logs a warning', async () => {
    const raw = JSON.stringify([
      {
        id: 'd29f43be',
        sessionId: 'd29f43be-6571-4119-a9d2-af9ae95acc17',
        name: 'suspicious',
        cwd: 'foo/bar',
        kind: 'background',
        state: 'working',
        startedAt: 1725100800000,
      },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/claude-session-import/))
  })

  it('keeps an entry with a well-formed UUID sessionId and an absolute cwd (regression guard)', async () => {
    const raw = JSON.stringify([
      {
        id: 'd29f43be',
        sessionId: 'd29f43be-6571-4119-a9d2-af9ae95acc17',
        name: 'my-task',
        cwd: '/tmp',
        kind: 'background',
        state: 'working',
        startedAt: 1725100800000,
      },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([
      {
        id: 'd29f43be-6571-4119-a9d2-af9ae95acc17',
        name: 'my-task',
        cwd: '/tmp',
        status: 'working',
        startedAt: new Date(1725100800000).toISOString(),
      },
    ])
  })

  it('skips an entry whose startedAt is out of Date\'s valid range instead of crashing the whole call, and logs a warning', async () => {
    const raw = JSON.stringify([
      {
        id: 'd29f43be',
        sessionId: 'd29f43be-6571-4119-a9d2-af9ae95acc17',
        name: 'suspicious',
        cwd: '/tmp',
        kind: 'background',
        state: 'working',
        startedAt: Number.MAX_SAFE_INTEGER,
      },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/claude-session-import/))
  })

  it('skips an entry whose sessionId is not UUID-shaped with the specific reason in the warning, while keeping a valid entry in the same batch', async () => {
    const raw = JSON.stringify([
      { id: 'ok1', sessionId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'good', cwd: '/tmp', kind: 'background', state: 'done', startedAt: 1725100800000 },
      { id: 'bad1', sessionId: 'not-a-uuid', name: 'suspicious', cwd: '/tmp', kind: 'background', state: 'working', startedAt: 1725100800000 },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([
      { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'good', cwd: '/tmp', status: 'done', startedAt: new Date(1725100800000).toISOString() },
    ])
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('non-UUID-shaped sessionId'))
  })

  it('trims a whitespace-padded but otherwise-valid absolute cwd, so the value that passed validation is the value returned downstream', async () => {
    const raw = JSON.stringify([
      {
        id: 'd29f43be',
        sessionId: 'd29f43be-6571-4119-a9d2-af9ae95acc17',
        name: 'padded-cwd',
        cwd: '  /tmp\t',
        kind: 'background',
        state: 'working',
        startedAt: 1725100800000,
      },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([
      {
        id: 'd29f43be-6571-4119-a9d2-af9ae95acc17',
        name: 'padded-cwd',
        cwd: '/tmp',
        status: 'working',
        startedAt: new Date(1725100800000).toISOString(),
      },
    ])
  })

  it('skips an entry whose cwd is empty, with the specific reason in the warning', async () => {
    const raw = JSON.stringify([
      { id: 'd29f43be', sessionId: 'd29f43be-6571-4119-a9d2-af9ae95acc17', name: 'suspicious', cwd: '', kind: 'background', state: 'working', startedAt: 1725100800000 },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('non-absolute or empty cwd'))
  })

  it('skips an entry whose cwd is whitespace-only, with the specific reason in the warning', async () => {
    const raw = JSON.stringify([
      { id: 'd29f43be', sessionId: 'd29f43be-6571-4119-a9d2-af9ae95acc17', name: 'suspicious', cwd: '   ', kind: 'background', state: 'working', startedAt: 1725100800000 },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('non-absolute or empty cwd'))
  })

  it('skips an entry with an invalid (non-absolute) cwd with the specific reason in the warning, while keeping a valid entry in the same batch', async () => {
    const raw = JSON.stringify([
      { id: 'ok1', sessionId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'good', cwd: '/tmp', kind: 'background', state: 'done', startedAt: 1725100800000 },
      { id: 'bad1', sessionId: 'd29f43be-6571-4119-a9d2-af9ae95acc17', name: 'suspicious', cwd: 'relative/path', kind: 'background', state: 'working', startedAt: 1725100800000 },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([
      { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'good', cwd: '/tmp', status: 'done', startedAt: new Date(1725100800000).toISOString() },
    ])
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('non-absolute or empty cwd'))
  })

  it('skips an entry with an invalid startedAt with the specific reason in the warning, while keeping a valid entry in the same batch', async () => {
    const raw = JSON.stringify([
      { id: 'ok1', sessionId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'good', cwd: '/tmp', kind: 'background', state: 'done', startedAt: 1725100800000 },
      { id: 'bad1', sessionId: 'd29f43be-6571-4119-a9d2-af9ae95acc17', name: 'suspicious', cwd: '/tmp', kind: 'background', state: 'working', startedAt: Number.MAX_SAFE_INTEGER },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([
      { id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', name: 'good', cwd: '/tmp', status: 'done', startedAt: new Date(1725100800000).toISOString() },
    ])
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid startedAt'))
  })

  it('keeps an entry with a valid startedAt, producing a correctly-formatted ISO string (regression guard for the startedAt validity guard)', async () => {
    const raw = JSON.stringify([
      {
        id: 'd29f43be',
        sessionId: 'd29f43be-6571-4119-a9d2-af9ae95acc17',
        name: 'my-task',
        cwd: '/tmp',
        kind: 'background',
        state: 'working',
        startedAt: 1725100800000,
      },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([
      {
        id: 'd29f43be-6571-4119-a9d2-af9ae95acc17',
        name: 'my-task',
        cwd: '/tmp',
        status: 'working',
        startedAt: new Date(1725100800000).toISOString(),
      },
    ])
  })

  it('keeps a kind: "interactive" entry that carries status but no state at all, instead of silently dropping it', async () => {
    const raw = JSON.stringify([
      {
        id: 'e3a1b2c3',
        sessionId: 'e3a1b2c3-6571-4119-a9d2-af9ae95acc17',
        name: 'interactive-task',
        cwd: '/tmp',
        kind: 'interactive',
        status: 'idle',
        startedAt: 1725100800000,
      },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([
      {
        id: 'e3a1b2c3-6571-4119-a9d2-af9ae95acc17',
        name: 'interactive-task',
        cwd: '/tmp',
        status: 'idle',
        startedAt: new Date(1725100800000).toISOString(),
      },
    ])
  })

  it('prefers state over status when a background entry carries both (a live attached process)', async () => {
    const raw = JSON.stringify([
      {
        id: 'f4b2c3d4',
        sessionId: 'f4b2c3d4-6571-4119-a9d2-af9ae95acc17',
        name: 'attached-task',
        cwd: '/tmp',
        kind: 'background',
        state: 'blocked',
        pid: 4242,
        status: 'busy',
        startedAt: 1725100800000,
      },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([
      {
        id: 'f4b2c3d4-6571-4119-a9d2-af9ae95acc17',
        name: 'attached-task',
        cwd: '/tmp',
        status: 'blocked',
        startedAt: new Date(1725100800000).toISOString(),
      },
    ])
  })

  it('keeps a kind: "background" entry with only state (no status) — regression guard', async () => {
    const raw = JSON.stringify([
      {
        id: 'a5c3d4e5',
        sessionId: 'a5c3d4e5-6571-4119-a9d2-af9ae95acc17',
        name: 'background-only-state',
        cwd: '/tmp',
        kind: 'background',
        state: 'stopped',
        startedAt: 1725100800000,
      },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([
      {
        id: 'a5c3d4e5-6571-4119-a9d2-af9ae95acc17',
        name: 'background-only-state',
        cwd: '/tmp',
        status: 'stopped',
        startedAt: new Date(1725100800000).toISOString(),
      },
    ])
  })
})
