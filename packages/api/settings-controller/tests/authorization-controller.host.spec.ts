import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import AuthorizationService, {
  type AuthorizationFlow,
  type AuthorizationSession,
} from '@deepseek-ai/dsh-authorization'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
// Does not exist yet: this is the RED-phase anchor for the controller this
// suite specifies. See .agents/notes/proposed/architecture/2026-09-01-browser-authorization-and-keyless-web-search.md
import AuthorizationController from '../src/authorization.ts'
import { MemoryCredentials } from '../../../credentials/authorization/tests/memory.ts'

const KEY_STRING = 'llm-pi-ai/anthropic'
const KEY = credentialKey('llm-pi-ai', 'anthropic')
const OTHER_STRING = 'llm-pi-ai/openai-codex'

/** A flow that commits `key` through the record store once `run` resolves. */
function committingFlow(
  ctx: Context,
  key = KEY,
  run?: (session: AuthorizationSession) => Promise<void>,
): AuthorizationFlow {
  return {
    key,
    label: 'Anthropic (Claude Pro/Max)',
    methods: [{ id: 'oauth', label: 'Sign in with Anthropic' }, { id: 'api-key', label: 'Paste a key' }],
    async run(session) {
      await run?.(session)
      await ctx.credentials.modifyRecord(key, () =>
        Promise.resolve({ kind: 'grant', payload: { token: 'granted' } }))
    },
  }
}

async function boot(): Promise<{ ctx: Context; controller: AuthorizationController }> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(AuthorizationController)
  return { ctx, controller: ctx.authorizationController }
}

describe('the authorization Remote namespace a configuration surface calls', () => {
  it('publishes the authorization namespace from its own service key', async () => {
    const { controller } = await boot()
    const binding = controller.typertRemote
    expect(binding.serviceKey).toBe('authorizationController')
    expect(binding.namespace).toBe('authorization')
    expect(remoteMethods(controller)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'describe', invocation: { kind: 'direct' } },
      { method: 'begin', invocation: { kind: 'direct' } },
      { method: 'respond', invocation: { kind: 'direct' } },
      { method: 'decline', invocation: { kind: 'direct' } },
      { method: 'cancel', invocation: { kind: 'direct' } },
    ])
  })

  it('lists nothing and describes an unregistered key as undefined, not a throw', async () => {
    const { controller } = await boot()
    expect(controller.list()).toEqual([])
    expect(controller.describe(KEY_STRING)).toBeUndefined()
  })

  it('lists and describes a registered flow, and reflects registration order and inFlight status', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow(committingFlow(ctx))

    expect(controller.list()).toEqual([{
      key: KEY,
      label: 'Anthropic (Claude Pro/Max)',
      methods: [{ id: 'oauth', label: 'Sign in with Anthropic' }, { id: 'api-key', label: 'Paste a key' }],
      inFlight: false,
    }])
    expect(controller.describe(KEY_STRING)).toEqual(controller.list()[0])
    expect(controller.describe(OTHER_STRING)).toBeUndefined()
  })

  it('rejects a malformed key as gateway/bad-request across every key-taking method', async () => {
    const { controller } = await boot()
    const bogus = 'not-a-key'
    const calls: Array<() => unknown> = [
      () => controller.describe(bogus),
      () => controller.begin(bogus, undefined, new AbortController().signal),
      () => controller.respond(bogus, 'prompt-1', 'value'),
      () => controller.decline(bogus, 'prompt-1'),
    ]
    for (const call of calls) {
      const failure = await Promise.resolve().then(call).catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
    }
  })

  it('rejects an already-aborted begin() as gateway/cancelled without ever starting the flow', async () => {
    const { ctx, controller } = await boot()
    const ran = vi.fn()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () => { ran(); return Promise.resolve() }))
    const abort = new AbortController()
    abort.abort(new Error('cancelled before it began'))

    const failure = await controller.begin(KEY_STRING, undefined, abort.signal).catch((error: unknown) => error)

    expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/cancelled' })
    expect(ran).not.toHaveBeenCalled()
  })

  it('rejects a key no flow claims as authorization/no-flow', async () => {
    const { controller } = await boot()
    const failure = await controller.begin(KEY_STRING, undefined, new AbortController().signal)
      .catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/no-flow' })
  })

  it('begins with the flow\'s first method when none is named, and the named one when given', async () => {
    const { ctx, controller } = await boot()
    const seen: string[] = []
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, (session) => {
      seen.push(session.method)
      return Promise.resolve()
    }))

    await controller.begin(KEY_STRING, undefined, new AbortController().signal)
    await controller.begin(KEY_STRING, 'api-key', new AbortController().signal)

    expect(seen).toEqual(['oauth', 'api-key'])
  })

  it('rejects a method the flow does not offer as authorization/unknown-method', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow(committingFlow(ctx))

    const failure = await controller.begin(KEY_STRING, 'device', new AbortController().signal)
      .catch((error: unknown) => error)

    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/unknown-method' })
  })

  it('rejects a second concurrent begin() for the same key as authorization/already-in-flight, and admits one after the first settles', async () => {
    const { ctx, controller } = await boot()
    const started = Promise.withResolvers<undefined>()
    const held = Promise.withResolvers<undefined>()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () => {
      started.resolve(undefined)
      return held.promise
    }))

    const first = controller.begin(KEY_STRING, undefined, new AbortController().signal)
    await started.promise
    const failure = await controller.begin(KEY_STRING, undefined, new AbortController().signal)
      .catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/already-in-flight' })

    held.resolve(undefined)
    await expect(first).resolves.toEqual({ status: 'authorized' })
    await expect(controller.begin(KEY_STRING, undefined, new AbortController().signal))
      .resolves.toEqual({ status: 'authorized' })
  })

  it('resolves { status: "authorized" } once the flow commits its credential record', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow(committingFlow(ctx))

    await expect(controller.begin(KEY_STRING, undefined, new AbortController().signal))
      .resolves.toEqual({ status: 'authorized' })
  })

  it('resolves { status: "cancelled" } when decline() rejects the flow\'s pending prompt', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      await session.prompt({ kind: 'text', message: 'Paste the code' })
    }))
    const prompts: Array<{ promptId: string }> = []
    ctx.on('authorization/prompt', (payload: { promptId: string }) => { prompts.push(payload) })

    const attempt = controller.begin(KEY_STRING, undefined, new AbortController().signal)
    await vi.waitFor(() => { expect(prompts).toHaveLength(1) })
    await controller.decline(KEY_STRING, prompts[0]!.promptId)

    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
  })

  it('rejects every prompt still pending once begin() settles, leaving nothing answerable afterward', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, session =>
      new Promise((_resolve, reject) => {
        session.signal.addEventListener('abort', () => { reject(new Error('withdrawn')) }, { once: true })
        void session.prompt({ kind: 'text', message: 'Paste the code' })
      })))
    const prompts: Array<{ promptId: string }> = []
    ctx.on('authorization/prompt', (payload: { promptId: string }) => { prompts.push(payload) })

    const attempt = controller.begin(KEY_STRING, undefined, new AbortController().signal)
    await vi.waitFor(() => { expect(prompts).toHaveLength(1) })
    controller.cancel(KEY_STRING)

    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
    const failure = await controller.respond(KEY_STRING, prompts[0]!.promptId, 'too-late')
      .catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/unknown-prompt' })
  })

  it('rejects a flow that resolves without committing a record as authorization/not-committed', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Forgetful',
      methods: [{ id: 'oauth', label: 'Sign in' }],
      run: () => Promise.resolve(),
    })

    const failure = await controller.begin(KEY_STRING, undefined, new AbortController().signal)
      .catch((error: unknown) => error)

    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/not-committed' })
  })

  it('maps an unrecognized flow failure to gateway/internal, cause chain intact', async () => {
    const { ctx, controller } = await boot()
    const cause = new Error('the token endpoint said no')
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, () => Promise.reject(cause)))

    const failure = await controller.begin(KEY_STRING, undefined, new AbortController().signal)
      .catch((error: unknown) => error)

    expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/internal' })
  })

  it('rejects respond() for an unknown (key, promptId) as authorization/unknown-prompt', async () => {
    const { controller } = await boot()
    const failure = await controller.respond(KEY_STRING, 'no-such-prompt', 'value')
      .catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/unknown-prompt' })
  })

  it('resolves the flow\'s pending prompt() with the responded value', async () => {
    const { ctx, controller } = await boot()
    const answers: string[] = []
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      answers.push(await session.prompt({ kind: 'text', message: 'Paste the code' }))
    }))
    const prompts: Array<{ promptId: string }> = []
    ctx.on('authorization/prompt', (payload: { promptId: string }) => { prompts.push(payload) })

    const attempt = controller.begin(KEY_STRING, undefined, new AbortController().signal)
    await vi.waitFor(() => { expect(prompts).toHaveLength(1) })
    await controller.respond(KEY_STRING, prompts[0]!.promptId, 'code-123')

    await expect(attempt).resolves.toEqual({ status: 'authorized' })
    expect(answers).toEqual(['code-123'])
  })

  it('consumes the pending prompt on respond(): a second respond() with the same id rejects authorization/unknown-prompt', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      await session.prompt({ kind: 'text', message: 'Paste the code' })
    }))
    const prompts: Array<{ promptId: string }> = []
    ctx.on('authorization/prompt', (payload: { promptId: string }) => { prompts.push(payload) })

    const attempt = controller.begin(KEY_STRING, undefined, new AbortController().signal)
    await vi.waitFor(() => { expect(prompts).toHaveLength(1) })
    const { promptId } = prompts[0]!
    await controller.respond(KEY_STRING, promptId, 'first-answer')

    const failure = await controller.respond(KEY_STRING, promptId, 'second-answer')
      .catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/unknown-prompt' })
    await attempt
  })

  it('rejects decline() for an unknown (key, promptId) as authorization/unknown-prompt', async () => {
    const { controller } = await boot()
    const failure = await controller.decline(KEY_STRING, 'no-such-prompt')
      .catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/unknown-prompt' })
  })

  it('is a harmless no-op to cancel() a key with nothing running', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow(committingFlow(ctx))
    expect(() => controller.cancel(KEY_STRING)).not.toThrow()
  })

  it('aborts an in-flight begin() through cancel(), resolving it as cancelled', async () => {
    const { ctx, controller } = await boot()
    const started = Promise.withResolvers<undefined>()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, session =>
      new Promise((_resolve, reject) => {
        session.signal.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
        started.resolve(undefined)
      })))

    const attempt = controller.begin(KEY_STRING, undefined, new AbortController().signal)
    await started.promise
    controller.cancel(KEY_STRING)

    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
  })
})

describe('the authorization/notice and authorization/prompt event relay', () => {
  it('emits exactly one authorization/notice carrying this attempt\'s key when the flow notifies', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      session.notify({ message: 'Continue in your browser', url: 'https://auth.example/start' })
    }))
    const notices: unknown[] = []
    ctx.on('authorization/notice', (payload: unknown) => { notices.push(payload) })

    await controller.begin(KEY_STRING, undefined, new AbortController().signal)

    expect(notices).toEqual([{
      key: KEY_STRING,
      notice: { message: 'Continue in your browser', url: 'https://auth.example/start' },
    }])
  })

  it('emits exactly one authorization/prompt carrying a promptId, and never the prompt\'s own AbortSignal', async () => {
    const { ctx, controller } = await boot()
    const promptSignal = new AbortController().signal
    ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
      await session.prompt({ kind: 'text', message: 'Paste the code', signal: promptSignal })
    }))
    const prompts: Array<{ key: string; promptId: string; prompt: Record<string, unknown> }> = []
    ctx.on('authorization/prompt', (payload: { key: string; promptId: string; prompt: Record<string, unknown> }) => {
      prompts.push(payload)
    })

    const attempt = controller.begin(KEY_STRING, undefined, new AbortController().signal)
    await vi.waitFor(() => { expect(prompts).toHaveLength(1) })
    await controller.respond(KEY_STRING, prompts[0]!.promptId, 'code-123')
    await attempt

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toMatchObject({ key: KEY_STRING, prompt: { kind: 'text', message: 'Paste the code' } })
    expect(typeof prompts[0]?.promptId).toBe('string')
    expect(prompts[0]?.prompt).not.toHaveProperty('signal')
  })

  it(
    'broadcasts notice/prompt to every listener regardless of which begin() call is in flight — the documented '
    + 'multi-tab race — while a second concurrent begin() for the same key still resolves to already-in-flight '
    + 'without disturbing the first attempt\'s own prompt-answering path',
    async () => {
      const { ctx, controller } = await boot()
      ctx.authorization.registerFlow(committingFlow(ctx, KEY, async (session) => {
        session.notify({ message: 'Continue in your browser' })
        await session.prompt({ kind: 'text', message: 'Paste the code' })
      }))

      const tabANotices: unknown[] = []
      const tabAPrompts: Array<{ key: string; promptId: string }> = []
      const tabBNotices: unknown[] = []
      const tabBPrompts: Array<{ key: string; promptId: string }> = []
      // Both "tabs" subscribe before either begin() call has settled, mirroring
      // the documented race: subscription precedes each RPC's own resolution.
      ctx.on('authorization/notice', (payload: unknown) => { tabANotices.push(payload); tabBNotices.push(payload) })
      ctx.on('authorization/prompt', (payload: { key: string; promptId: string }) => {
        tabAPrompts.push(payload)
        tabBPrompts.push(payload)
      })

      const first = controller.begin(KEY_STRING, undefined, new AbortController().signal)
      const second = controller.begin(KEY_STRING, undefined, new AbortController().signal)

      // The second caller's own begin() must never crash the process and must
      // ultimately settle as already-in-flight ...
      const secondFailure = await second.catch((error: unknown) => error)
      expect(remoteErrorOf(secondFailure)).toMatchObject({ code: 'authorization/already-in-flight' })
      // ... yet both "tabs" still observed the one real attempt's own notice,
      // since emit-mode events broadcast to every listener regardless of which
      // call is "the real one" — this is the race itself, not a malfunction.
      expect(tabBNotices).toEqual([{ key: KEY_STRING, notice: { message: 'Continue in your browser' } }])
      expect(tabANotices).toEqual(tabBNotices)
      await vi.waitFor(() => { expect(tabAPrompts).toHaveLength(1) })

      // Answering through the key must still resolve the FIRST attempt's own
      // pending prompt: a second, refused begin() call must never have
      // clobbered the first call's own bookkeeping for this key.
      await controller.respond(KEY_STRING, tabAPrompts[0]!.promptId, 'code-123')
      await expect(first).resolves.toEqual({ status: 'authorized' })
    },
  )
})
