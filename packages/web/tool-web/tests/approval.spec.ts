import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type PreToolDecision, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import ApprovalService, { type ApprovalOutcome, type ApprovalPolicy, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebSearchProvider } from '@deepseek-ai/dsh-web'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'

const signal = new AbortController().signal

interface Mounted {
  ctx: Context
  fetch: ReturnType<typeof vi.fn<WebFetchProvider['fetch']>>
  asked: ApprovalRequest[]
  agent: Agent
  call: (name: string, args: unknown, withAgent?: boolean) => Promise<ToolExecutionResult>
}

/**
 * Mount the real registry, approval service, sandbox policy, and tool-web over
 * a stub fetch provider. `answer` is the human answerer's outcome; omitting it
 * mounts no answerer at all.
 */
async function mount(opts: {
  policy?: ApprovalPolicy
  sandboxMode?: 'workspace-write' | 'danger-full-access'
  approval?: boolean
  answer?: ApprovalOutcome
  config?: ToolWeb.Config
} = {}): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (opts.approval !== false) await ctx.plugin(ApprovalService, { policy: opts.policy ?? 'ask' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write' })
  await ctx.plugin(WebRuntime, { fetchProvider: 'stub-fetch', searchProvider: 'stub-search' })
  const fetch = vi.fn<WebFetchProvider['fetch']>(request => Promise.resolve({
    url: request.url, statusCode: 200, body: { kind: 'text' as const, content: 'page' }, truncated: false,
  }))
  const fetchProvider: WebFetchProvider = { id: 'stub-fetch', available: () => true, fetch }
  const searchProvider: WebSearchProvider = {
    id: 'stub-search', available: () => true, search: () => Promise.resolve({ sources: [], truncated: false }),
  }
  ctx.web.registerFetchProvider(fetchProvider)
  ctx.web.registerSearchProvider(searchProvider)
  await ctx.plugin(ToolWeb, opts.config ?? {})

  const asked: ApprovalRequest[] = []
  if (opts.answer !== undefined) {
    const outcome = opts.answer
    ctx.on('approval/request', (req) => {
      asked.push(req)
      return Promise.resolve(outcome)
    })
  }

  const session = Session.create(SessionId('tool-web-approval'))
  session.append('turn/start', { turn: 1 })
  if (opts.sandboxMode !== undefined) session.append('sandbox/mode', { mode: opts.sandboxMode })
  const agent = { session } as Agent
  let counter = 0
  const call = (name: string, args: unknown, withAgent = true) => ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${++counter}`),
    name,
    arguments: args,
    ...withAgent ? { agent } : {},
  })
  return { ctx, fetch, asked, agent, call }
}

/** Text of the first content block of a tool result. */
function firstText(result: ToolExecutionResult): string {
  const block = result.content[0]
  return block?.type === 'text' ? block.text : ''
}

describe('web_fetch approval under the default ask policy', () => {
  it('asks the user with the URL, then fetches once approved', async () => {
    const { fetch, asked, agent, call } = await mount({ answer: 'allowed-once' })
    const result = await call('web_fetch', { url: 'https://example.test/page' })

    expect(result.isError).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      agent,
      toolName: 'web_fetch',
      callId: 'call-1',
      reason: 'web_fetch requests a network fetch of https://example.test/page',
    })
    expect(asked[0]?.displayReason?.en).toContain('https://example.test/page')
    expect(asked[0]?.displayReason?.zh).toContain('https://example.test/page')
  })

  it('makes no network request when the user rejects', async () => {
    const { fetch, asked, call } = await mount({ answer: 'rejected' })
    const result = await call('web_fetch', { url: 'https://example.test/page' })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe('Error: the user rejected tool "web_fetch"')
    expect(asked).toHaveLength(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('makes no network request when the approval is cancelled', async () => {
    const { fetch, call } = await mount({ answer: 'cancelled' })
    const result = await call('web_fetch', { url: 'https://example.test/page' })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe('Error: approval for tool "web_fetch" was cancelled')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails closed when no answerer is composed', async () => {
    const { fetch, call } = await mount()
    const result = await call('web_fetch', { url: 'https://example.test/page' })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe('Error: tool "web_fetch" requires approval, but no approval channel is available')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks for every call, not once per session', async () => {
    const { fetch, asked, call } = await mount({ answer: 'allowed-once' })
    await call('web_fetch', { url: 'https://a.test' })
    await call('web_fetch', { url: 'https://b.test' })

    expect(asked.map(req => req.reason)).toEqual([
      'web_fetch requests a network fetch of https://a.test',
      'web_fetch requests a network fetch of https://b.test',
    ])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('denies an agent-less call without fetching', async () => {
    const { fetch, asked, call } = await mount({ answer: 'allowed-once' })
    const result = await call('web_fetch', { url: 'https://example.test/page' }, false)

    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('the call has no agent to route it through')
    expect(asked).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['oops', null, {}, { url: 5 }])('still asks, without a URL, for malformed arguments %j', async (args) => {
    const { asked, call } = await mount({ answer: 'allowed-once' })
    const result = await call('web_fetch', args)

    expect(asked.map(req => req.reason)).toEqual(['web_fetch requests a network fetch of a URL'])
    expect(result.error?.info?.code).toBe('INVALID_ARGS')
  })

  it('leaves web_search unprompted', async () => {
    const { asked, call } = await mount({ answer: 'rejected' })
    const result = await call('web_search', { queries: ['q'] })

    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(0)
  })

  it('lets another listener deny a call before the approval is requested', async () => {
    const { ctx, fetch, asked, call } = await mount({ answer: 'allowed-once' })
    ctx.on('tools/pre-execute', (exec, next): Promise<PreToolDecision> => exec.name === 'web_fetch'
      ? Promise.resolve({ kind: 'deny', reason: 'blocked by policy' })
      : next())
    const result = await call('web_fetch', { url: 'https://example.test/page' })

    expect(firstText(result)).toBe('Error: blocked by policy')
    expect(asked).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('web_fetch approval under never and full access', () => {
  it('rejects without prompting anyone under the never policy in a confined sandbox', async () => {
    const { fetch, asked, call } = await mount({ policy: 'never', answer: 'allowed-once' })
    const result = await call('web_fetch', { url: 'https://example.test/page' })

    expect(result.isError).toBe(true)
    expect(firstText(result)).toBe('Error: the user rejected tool "web_fetch"')
    expect(asked).toHaveLength(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps Full access (danger-full-access sandbox plus never) fetching without an approval request', async () => {
    const { fetch, asked, agent, call } = await mount({ policy: 'never', sandboxMode: 'danger-full-access', answer: 'rejected' })
    const seqBefore = agent.session.seq
    const result = await call('web_fetch', { url: 'https://example.test/page' })

    expect(result.isError).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(asked).toHaveLength(0)
    // No approval/asked + approval/decided pair was appended to the session log.
    expect(agent.session.seq).toBe(seqBefore)
  })

  it('does not ask when the full-access sandbox runs under the ask policy (Auto preset)', async () => {
    const { fetch, asked, call } = await mount({ policy: 'ask', sandboxMode: 'danger-full-access', answer: 'rejected' })
    const result = await call('web_fetch', { url: 'https://example.test/page' })

    expect(result.isError).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(asked).toHaveLength(0)
  })

  it('fetches without prompting when no approval service is composed', async () => {
    const { fetch, call } = await mount({ approval: false })
    const result = await call('web_fetch', { url: 'https://example.test/page' })

    expect(result.isError).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fetches without prompting when fetchApproval is disabled', async () => {
    const { fetch, asked, call } = await mount({ answer: 'rejected', config: { fetchApproval: false } })
    const result = await call('web_fetch', { url: 'https://example.test/page' })

    expect(result.isError).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(asked).toHaveLength(0)
  })

  it('registers no approval gate when fetch is disabled', async () => {
    const { ctx, asked } = await mount({ answer: 'rejected', config: { fetch: false } })

    expect(ctx.tools.get('web_fetch')).toBeUndefined()
    expect(asked).toHaveLength(0)
  })
})
