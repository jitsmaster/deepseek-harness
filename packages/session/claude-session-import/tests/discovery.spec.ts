import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { listClaudeCodeSessions } from '../src/discovery.ts'

function stubbedCtx(spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle): Context {
  const ctx = new Context()
  ctx.provide('subprocess', { spawn } as unknown as Context['subprocess'])
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
  it('parses a well-formed session list', async () => {
    const raw = JSON.stringify({
      sessions: [{ id: 's1', name: 'my-task', cwd: 'D:/dev/DSH', status: 'working', startedAt: '2026-09-01T00:00:00Z' }],
    })
    const ctx = stubbedCtx(() => handleWithStdout(raw))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([
      { id: 's1', name: 'my-task', cwd: 'D:/dev/DSH', status: 'working', startedAt: '2026-09-01T00:00:00Z' },
    ])
  })

  it('returns an empty list when the claude binary is missing', async () => {
    const ctx = stubbedCtx(() => { throw new Error('ENOENT: claude not found') })
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
  })

  it('returns an empty list when output is not valid JSON', async () => {
    const ctx = stubbedCtx(() => handleWithStdout('not json'))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
  })

  it('returns an empty list for an empty session array', async () => {
    const ctx = stubbedCtx(() => handleWithStdout(JSON.stringify({ sessions: [] })))
    const sessions = await listClaudeCodeSessions(ctx, new AbortController().signal)
    expect(sessions).toEqual([])
  })
})
