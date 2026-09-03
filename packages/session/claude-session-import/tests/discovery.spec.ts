import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { listClaudeCodeSessions } from '../src/discovery.ts'

function stubbedCtx(
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  resolveExecutable: (command: string) => Promise<string> = async command => command,
): Context {
  const ctx = new Context()
  ctx.provide('subprocess', { spawn, resolveExecutable } as unknown as Context['subprocess'])
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

  it('returns an empty list when the claude binary is missing', async () => {
    const ctx = stubbedCtx(() => { throw new Error('ENOENT: claude not found') })
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
  })

  it('returns an empty list when claude cannot be resolved on PATH at all', async () => {
    const ctx = stubbedCtx(
      () => handleWithStdout('[]'),
      async () => { throw new Error('subprocess-local: command "claude" was not found on PATH') },
    )
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
  })

  it('returns an empty list when output is not valid JSON', async () => {
    const ctx = stubbedCtx(() => handleWithStdout('not json'))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
  })

  it('returns an empty list for an empty array', async () => {
    const ctx = stubbedCtx(() => handleWithStdout(JSON.stringify([])))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
  })

  it('returns an empty list when output is the old wrapped-object shape instead of a bare array', async () => {
    const ctx = stubbedCtx(() => handleWithStdout(JSON.stringify({ sessions: [] })))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
  })

  it('skips entries missing sessionId/state/startedAt without failing the whole parse', async () => {
    const raw = JSON.stringify([
      { id: 'ok1', sessionId: 'ok1-full', name: 'good', cwd: '/tmp', kind: 'background', state: 'done', startedAt: 1725100800000 },
      { id: 'bad1', name: 'missing sessionId', cwd: '/tmp', kind: 'background', state: 'done', startedAt: 1725100800000 },
      { id: 'bad2', sessionId: 'bad2-full', name: 'missing state', cwd: '/tmp', kind: 'background', startedAt: 1725100800000 },
    ])
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([
      { id: 'ok1-full', name: 'good', cwd: '/tmp', status: 'done', startedAt: new Date(1725100800000).toISOString() },
    ])
  })
})
