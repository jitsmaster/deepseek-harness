import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, RequestPayload, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ClaudeCodeLlmAdapter, CLAUDE_CODE_LLM_PROVIDER_ID } from '../src/adapter.ts'
import { imageTarget, MAX_IMAGE_BYTES, MAX_IMAGE_LONG_EDGE } from '../src/images.ts'
import { FakeClaudeSubprocess, readRuns, subprocessContext } from './harness.ts'

let ctx: Context
let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-claude-llm-image-'))
  FakeClaudeSubprocess.logPath = join(scratch, 'runs.jsonl')
  FakeClaudeSubprocess.spawned = []
  ctx = await subprocessContext()
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const REF = { attachmentId: 'sha256:abcdef0123456789', mediaType: 'image/png', bytes: 3, width: 40, height: 20 } as unknown as ImageAttachmentRef

/** An attachment service that hands back three fixed bytes (base64 `AQID`). */
function store(): { service: AttachmentStore; read: ReturnType<typeof vi.fn> } {
  const read = vi.fn(() => Promise.resolve({ mediaType: 'image/png', data: Uint8Array.of(1, 2, 3) }))
  return { service: { readImageRequest: read } as unknown as AttachmentStore, read }
}

function makeAdapter(attachments?: AttachmentStore): ClaudeCodeLlmAdapter {
  return new ClaudeCodeLlmAdapter({
    executable: process.execPath,
    timeoutMs: 60_000,
    defaultContextWindow: 200_000,
    models: [],
    spawn: spec => ctx.subprocess.spawn(spec),
    ...attachments === undefined ? {} : { resolveAttachments: () => attachments },
  })
}

function request(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: CLAUDE_CODE_LLM_PROVIDER_ID,
    model: 'sonnet',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'what is this? scenario:text' }, { type: 'image', attachment: REF }], source: { kind: 'user' } })],
    ...extra,
  }
}

async function collect(adapter: ClaudeCodeLlmAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

describe('image input', () => {
  it('advertises image input for every model', async () => {
    const adapter = makeAdapter()
    for (const model of await adapter.listModels(CLAUDE_CODE_LLM_PROVIDER_ID)) expect(model.inputModalities).toEqual(['text', 'image'])
    expect((await adapter.resolveModel(CLAUDE_CODE_LLM_PROVIDER_ID, 'anything')).inputModalities).toEqual(['text', 'image'])
  })

  it('sends the image to claude as a base64 image block on stdin', async () => {
    const { service, read } = store()
    await collect(makeAdapter(service), request())
    expect(read).toHaveBeenCalledTimes(1)
    const run = readRuns().find(entry => entry.argv !== undefined)!
    const content = (JSON.parse(run.stdin) as { message: { content: { type: string; source?: unknown }[] } }).message.content
    expect(content.find(block => block.type === 'image')).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } })
  })

  it('reads one image once however often it appears', async () => {
    const { service, read } = store()
    const twice = createUserMessage({ content: [{ type: 'text', text: 'scenario:text' }, { type: 'image', attachment: REF }, { type: 'image', attachment: REF }], source: { kind: 'user' } })
    await collect(makeAdapter(service), request({ messages: [twice] }))
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('keeps the base64 out of the inspected payload', async () => {
    const { service } = store()
    const payloads: RequestPayload[] = []
    await collect(makeAdapter(service), request({ onRequest: (payload) => { payloads.push(payload) } }))
    expect(payloads[0]!.stdin).not.toContain('AQID')
    expect(payloads[0]!.stdin).toContain('[image image/png, 3 bytes sent as an image block]')
  })

  it('replaces an image the surface offloaded with its placeholder and never reads it', async () => {
    const { service, read } = store()
    const offloaded = createUserMessage({ content: [{ type: 'text', text: 'scenario:text' }, { type: 'image', attachment: REF, offloaded: true }], source: { kind: 'user' } })
    await collect(makeAdapter(service), request({ messages: [offloaded] }))
    expect(read).not.toHaveBeenCalled()
    const run = readRuns().find(entry => entry.argv !== undefined)!
    expect(run.stdin).toContain('image omitted to fit request image limits')
    expect(run.stdin).not.toContain('"type":"image"')
  })

  it('fails clearly, before claude starts, when no attachment service is mounted', async () => {
    const chunks = collect(makeAdapter(), request())
    await expect(chunks).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT', message: expect.stringContaining('attachment service') })
    expect(FakeClaudeSubprocess.spawned).toHaveLength(0)
  })

  it('fails clearly when the image bytes cannot be read', async () => {
    const service = { readImageRequest: () => Promise.reject(new Error('object is gone')) } as unknown as AttachmentStore
    await expect(collect(makeAdapter(service), request())).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT', message: expect.stringContaining('object is gone') })
    expect(FakeClaudeSubprocess.spawned).toHaveLength(0)
  })

  it('asks the attachment service for a bounded size', () => {
    expect(imageTarget({ width: 40, height: 20 })).toEqual({ width: 40, height: 20, maxBytes: MAX_IMAGE_BYTES })
    const big = imageTarget({ width: 3136, height: 1568 })
    expect(big).toEqual({ width: MAX_IMAGE_LONG_EDGE, height: 784, maxBytes: MAX_IMAGE_BYTES })
    expect(makeAdapter().imageRequestTarget(CLAUDE_CODE_LLM_PROVIDER_ID, 'sonnet', { ...REF, width: 3136, height: 1568 })).toEqual(big)
  })
})
