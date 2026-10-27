import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { STUB_SOURCE } from '../src/stub.ts'

let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dir = undefined
})

const TOOLS = [
  { name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'bash', description: 'Run a command', inputSchema: { type: 'object', properties: {} } },
]

/** Run the stub for real with `node -e`, exactly as the generated mcp.json launches it. */
async function startStub(): Promise<{
  send(message: unknown): void
  next(timeoutMs?: number): Promise<unknown>
  closeStdin(): void
  exited: Promise<number | null>
}> {
  dir = await mkdtemp(join(tmpdir(), 'dsh-claude-stub-'))
  const toolsPath = join(dir, 'tools.json')
  await writeFile(toolsPath, JSON.stringify(TOOLS))
  const child = spawn(process.execPath, ['-e', STUB_SOURCE, toolsPath], { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] })
  const queue: unknown[] = []
  const waiting: ((value: unknown) => void)[] = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    const value: unknown = JSON.parse(line)
    const waiter = waiting.shift()
    if (waiter === undefined) queue.push(value)
    else waiter(value)
  })
  return {
    send: (message) => { child.stdin.write(JSON.stringify(message) + '\n') },
    next: timeoutMs => new Promise<unknown>((resolve, reject) => {
      const ready = queue.shift()
      if (ready !== undefined) { resolve(ready); return }
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => { reject(new Error('no reply')) }, timeoutMs)
      waiting.push((value) => { clearTimeout(timer); resolve(value) })
    }),
    closeStdin: () => { child.stdin.end() },
    exited: new Promise(resolve => child.on('close', (code) => { resolve(code) })),
  }
}

describe('MCP stub source', () => {
  it('answers initialize, lists the tools, and never answers tools/call', async () => {
    const stub = await startStub()
    stub.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude', version: '1' } } })
    expect(await stub.next(10_000)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'dsh', version: '0.0.1' } },
    })
    stub.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    stub.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(await stub.next(10_000)).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: TOOLS } })

    stub.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read', arguments: { path: 'a' } } })
    stub.send({ jsonrpc: '2.0', id: 4, method: 'ping' })
    // The ping after the call is answered, the call itself never is.
    expect(await stub.next(10_000)).toEqual({ jsonrpc: '2.0', id: 4, result: {} })
    await expect(stub.next(300)).rejects.toThrow('no reply')

    stub.closeStdin()
    expect(await stub.exited).toBe(0)
  }, 30_000)

  it('defaults the protocol version and ignores unparseable lines', async () => {
    const stub = await startStub()
    stub.send('not an object')
    stub.send({ jsonrpc: '2.0', id: 'a', method: 'initialize' })
    expect(await stub.next(10_000)).toMatchObject({ id: 'a', result: { protocolVersion: '2025-06-18' } })
    stub.closeStdin()
    expect(await stub.exited).toBe(0)
  }, 30_000)
})
