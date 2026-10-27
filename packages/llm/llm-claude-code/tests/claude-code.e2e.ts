/**
 * Opt-in real-binary check, gated by `DSH_CLAUDE_CODE_E2E=1` (each case is a
 * Claude subscription message, a few seconds to a minute). Skipped when the gate
 * is off or no executable resolves. Run with:
 * `$env:DSH_CLAUDE_CODE_E2E='1'; npx vitest run --config <e2e config> packages/llm/llm-claude-code/tests/claude-code.e2e.ts`
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ClaudeCodeLlmAdapter, defaultExecutable, locateExecutable, parseAuthStatus } from '../src/index.ts'

const EXECUTABLE = process.env.DSH_CLAUDE_CODE_EXECUTABLE ?? defaultExecutable()
const ENABLED = process.env.DSH_CLAUDE_CODE_E2E === '1' && locateExecutable(EXECUTABLE) !== undefined

const READ: ToolSchema = {
  name: 'read',
  description: 'Read a UTF-8 text file and return its contents.',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute file path' } }, required: ['path'] },
}

const SYSTEM = 'You are DSH, a coding assistant working in a user\'s repository. You act by calling the provided tools.'

/** Process ids whose command line names an adapter temp directory (the pattern cannot match this probe's own command line). */
function stray(): string[] {
  if (process.platform !== 'win32') return []
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '[d]sh-claude-llm-' } | ForEach-Object { $_.ProcessId }"], { encoding: 'utf8' })
  return out.split(/\s+/u).filter(Boolean)
}

describe.skipIf(!ENABLED)('real claude LLM adapter', () => {
  async function withAdapter<T>(run: (adapter: ClaudeCodeLlmAdapter) => Promise<T>): Promise<T> {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    try {
      return await run(new ClaudeCodeLlmAdapter({
        executable: EXECUTABLE,
        timeoutMs: 120_000,
        defaultContextWindow: 200_000,
        models: [],
        spawn: spec => ctx.subprocess.spawn(spec),
      }))
    } finally {
      await ctx.fiber.dispose()
    }
  }

  async function collect(adapter: ClaudeCodeLlmAdapter, options: GenerateOptions): Promise<{ chunks: StreamChunk[]; ms: number }> {
    const started = Date.now()
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    return { chunks, ms: Date.now() - started }
  }

  const base = { provider: 'claude-code', model: process.env.DSH_CLAUDE_CODE_MODEL ?? 'sonnet', system: SYSTEM }

  it('streams a plain answer and finishes with stop', async () => {
    await withAdapter(async (adapter) => {
      const { chunks, ms } = await collect(adapter, {
        ...base,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Reply with exactly the single word: pong' }], source: { kind: 'user' } })],
      })
      console.log(`[e2e] plain answer ${ms}ms`)
      const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.type === 'text-delta' ? chunk.text : '').join('')
      expect(text.toLowerCase()).toContain('pong')
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(chunks.some(chunk => chunk.type === 'usage')).toBe(true)
    })
  }, 150_000)

  it('turns a request that needs a tool into a tool-call chunk and finishes with tool-calls', async () => {
    await withAdapter(async (adapter) => {
      const { chunks, ms } = await collect(adapter, {
        ...base,
        tools: [READ],
        messages: [createUserMessage({ content: [{ type: 'text', text: 'Read the file C:\\temp\\hello.txt using the read tool and tell me its first word.' }], source: { kind: 'user' } })],
      })
      console.log(`[e2e] tool call ${ms}ms`)
      expect(ms).toBeLessThan(30_000)
      const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
      expect(call).toBeDefined()
      const block = call?.type === 'block-end' && call.block.type === 'tool-call' ? call.block : undefined
      expect(block?.name).toBe('read')
      expect(typeof (JSON.parse(block?.arguments ?? 'null') as { path?: unknown }).path).toBe('string')
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
      expect(stray()).toEqual([])
    })
  }, 150_000)

  it('answers from a replayed tool call and its result', async () => {
    await withAdapter(async (adapter) => {
      const { chunks, ms } = await collect(adapter, {
        ...base,
        tools: [READ],
        messages: [
          createUserMessage({ content: [{ type: 'text', text: 'Read C:\\temp\\hello.txt with the read tool and tell me the first word.' }], source: { kind: 'user' } }),
          createAssistantMessage({
            content: [{ type: 'tool-call', id: ToolCallId('toolu_e2e_1'), name: 'read', arguments: '{"path":"C:\\\\temp\\\\hello.txt"}' }],
            source: { provider: 'claude-code', model: base.model },
          }),
          createToolResultMessage({ callId: ToolCallId('toolu_e2e_1'), content: [{ type: 'text', text: 'Greetings from the test file. The code is 4711.' }], isError: false }),
        ],
      })
      console.log(`[e2e] replayed tool result ${ms}ms`)
      const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.type === 'text-delta' ? chunk.text : '').join('')
      expect(text).toContain('Greetings')
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    })
  }, 150_000)
})

describe.skipIf(!ENABLED)('real claude auth status', () => {
  it('reports not signed in for an empty config directory, without using quota or a browser', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    const directory = mkdtempSync(join(tmpdir(), 'dsh-claude-auth-e2e-'))
    try {
      // Only `auth status` runs here: the real `auth login` opens a browser and is never started by a test.
      const child = ctx.subprocess.spawn({
        argv: [locateExecutable(EXECUTABLE) as string, 'auth', 'status', '--json'],
        cwd: directory,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 8_192 } },
        graceMs: 2_000,
        env: {
          CLAUDE_CONFIG_DIR: directory,
          ANTHROPIC_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
          CLAUDE_CODE_OAUTH_TOKEN: undefined,
        },
      })
      await child.done
      expect(parseAuthStatus(child.collected.stdout?.readFrom(0).text ?? '')).toMatchObject({ loggedIn: false })
    } finally {
      await ctx.fiber.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
