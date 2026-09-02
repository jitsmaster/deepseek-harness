// @vitest-environment jsdom
/** The sign-in affordance (ProviderEditor) and the AuthorizationDialog it opens. */
import {
  cleanup, fireEvent, render, screen, waitFor, within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type {
  AuthorizationEntry, AuthorizationNotice, AuthorizationOutcome, SettingsNamespaceView, WireAuthorizationPrompt,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ProviderEditor } from '../src/client/ProviderEditor.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import type { AuthorizationOperations } from '../src/client/authorization-operations.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

/** The pi-ai profile shape as the host serializes it. */
const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKey: Schema.string().role('secret'),
    apiKeyEnv: Schema.string().role('credential-ref'),
    baseURL: Schema.string(),
  })),
})

const DeepSeekConfig = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref'),
  baseURL: Schema.string(),
})

function piAiNamespace(providers: Record<string, JsonValue>): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai',
    schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
    value: { providers },
    base: { providers: {} },
    user: { providers },
    applies: 'live',
    secrets: [],
    revision: 1,
  }
}

function deepseekNamespace(): SettingsNamespaceView {
  return {
    ns: 'llm-deepseek',
    schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as JsonValue,
    value: {},
    base: {},
    user: {},
    applies: 'live',
    secrets: [],
    revision: 1,
  }
}

/**
 * Never-configured credential and never-writable settings: the card's own
 * writes are not this test's concern. `describeCredential` is also handed
 * back on its own so assertions can target the mock function handle directly
 * rather than `operations.describeCredential`, which `unbound-method` flags
 * (`ModelsOperations` declares it via method shorthand).
 */
function stubOperations(): { operations: ModelsOperations; describeCredential: ReturnType<typeof vi.fn> } {
  const describeCredential = vi.fn(() => Promise.resolve(undefined))
  const operations: ModelsOperations = {
    describeCredential,
    storeCredential: vi.fn(() => Promise.resolve(undefined)),
    removeCredential: vi.fn(() => Promise.resolve(undefined)),
    writeSettings: vi.fn(),
    discoverModels: vi.fn(),
  }
  return { operations, describeCredential }
}

/** One scripted authorization flow: `entry` is what `describeAuthorization` answers with. */
function stubAuthOperations(overrides: {
  entry?: AuthorizationEntry
  begin?: (
    key: string,
    method: string | undefined,
    signal: AbortSignal,
    handlers: {
      onNotice: (notice: AuthorizationNotice) => void
      onPrompt: (promptId: string, prompt: WireAuthorizationPrompt) => void
    },
  ) => Promise<AuthorizationOutcome>
} = {}) {
  const entry = overrides.entry ?? {
    key: credentialKey('llm-pi-ai', 'anthropic'),
    label: 'Anthropic',
    methods: [{ id: 'oauth', label: 'Sign in with Anthropic' }],
    inFlight: false,
  }
  const begin = vi.fn(overrides.begin ?? (() => new Promise<AuthorizationOutcome>(() => {})))
  const describeAuthorization = vi.fn(() => Promise.resolve(entry))
  const respondAuthorization = vi.fn(() => Promise.resolve(undefined))
  const declineAuthorization = vi.fn(() => Promise.resolve(undefined))
  const cancelAuthorization = vi.fn(() => Promise.resolve(undefined))
  const authOperations: AuthorizationOperations = {
    describeAuthorization,
    beginAuthorization: begin,
    respondAuthorization,
    declineAuthorization,
    cancelAuthorization,
  }
  return {
    authOperations, begin, describeAuthorization, respondAuthorization, declineAuthorization, cancelAuthorization, entry,
  }
}

describe('ProviderEditor authorization affordance', () => {
  it('renders no sign-in affordance for the deepseek layout', async () => {
    const { operations, describeCredential } = stubOperations()
    const { authOperations, begin } = stubAuthOperations()
    render(<ProviderEditor
      provider="deepseek-official"
      displayName="DeepSeek"
      namespace={deepseekNamespace()}
      schema={settingsSchema}
      settingsPath={[]}
      operations={operations}
      authOperations={authOperations}
      t={t}
      readOnly={false}
      onClose={vi.fn()}
    />)
    await waitFor(() => { expect(describeCredential).toHaveBeenCalled() })
    expect(begin).not.toHaveBeenCalled()
    expect(screen.queryByText('Sign in with Anthropic')).toBeNull()
  })

  it('renders one sign-in button for a pi-ai route with a single method, and opens the dialog on click', async () => {
    const { operations } = stubOperations()
    const { authOperations } = stubAuthOperations()
    render(<ProviderEditor
      provider="anthropic"
      displayName="Anthropic"
      namespace={piAiNamespace({ anthropic: {} })}
      schema={settingsSchema}
      settingsPath={['providers', 'anthropic']}
      operations={operations}
      authOperations={authOperations}
      t={t}
      readOnly={false}
      onClose={vi.fn()}
    />)
    const button = await screen.findByText('Sign in with Anthropic')
    fireEvent.click(button)
    expect(await screen.findByText(en.authSigningIn)).toBeTruthy()
  })

  it('drives beginAuthorization and relays a notice with a url and code', async () => {
    const { operations } = stubOperations()
    let deliver: ((notice: AuthorizationNotice) => void) | undefined
    const { authOperations } = stubAuthOperations({
      begin: (_key, _method, _signal, handlers) => {
        deliver = handlers.onNotice
        return new Promise(() => {})
      },
    })
    render(<ProviderEditor
      provider="anthropic"
      displayName="Anthropic"
      namespace={piAiNamespace({ anthropic: {} })}
      schema={settingsSchema}
      settingsPath={['providers', 'anthropic']}
      operations={operations}
      authOperations={authOperations}
      t={t}
      readOnly={false}
      onClose={vi.fn()}
    />)
    fireEvent.click(await screen.findByText('Sign in with Anthropic'))
    await waitFor(() => { expect(deliver).not.toBeUndefined() })
    deliver?.({ message: 'Open this page and enter the code.', url: 'https://example.com/device', code: 'ABCD-1234' })
    expect(await screen.findByText('Open this page and enter the code.')).toBeTruthy()
    expect(screen.getByText('https://example.com/device')).toBeTruthy()
    expect(screen.getByText('ABCD-1234')).toBeTruthy()
  })

  it('renders a non-http(s) notice url as plain text, never a clickable link', async () => {
    const { operations } = stubOperations()
    let deliver: ((notice: AuthorizationNotice) => void) | undefined
    const { authOperations } = stubAuthOperations({
      begin: (_key, _method, _signal, handlers) => {
        deliver = handlers.onNotice
        return new Promise(() => {})
      },
    })
    render(<ProviderEditor
      provider="anthropic"
      displayName="Anthropic"
      namespace={piAiNamespace({ anthropic: {} })}
      schema={settingsSchema}
      settingsPath={['providers', 'anthropic']}
      operations={operations}
      authOperations={authOperations}
      t={t}
      readOnly={false}
      onClose={vi.fn()}
    />)
    fireEvent.click(await screen.findByText('Sign in with Anthropic'))
    await waitFor(() => { expect(deliver).not.toBeUndefined() })
    // A crafted non-http(s) scheme must never become a clickable anchor: the
    // isHttpUrl() guard should still render the raw text (locking in the
    // round-1 security fix), not a navigable/executable link.
    deliver?.({ message: 'Open this page and enter the code.', url: 'javascript:alert(1)' })
    const renderedUrl = await screen.findByText('javascript:alert(1)')
    expect(renderedUrl.tagName).not.toBe('A')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('submits a text prompt through respondAuthorization with the typed answer', async () => {
    const { operations } = stubOperations()
    let deliverPrompt: ((promptId: string, prompt: WireAuthorizationPrompt) => void) | undefined
    const { authOperations, respondAuthorization } = stubAuthOperations({
      begin: (_key, _method, _signal, handlers) => {
        deliverPrompt = handlers.onPrompt
        return new Promise(() => {})
      },
    })
    render(<ProviderEditor
      provider="anthropic"
      displayName="Anthropic"
      namespace={piAiNamespace({ anthropic: {} })}
      schema={settingsSchema}
      settingsPath={['providers', 'anthropic']}
      operations={operations}
      authOperations={authOperations}
      t={t}
      readOnly={false}
      onClose={vi.fn()}
    />)
    fireEvent.click(await screen.findByText('Sign in with Anthropic'))
    await waitFor(() => { expect(deliverPrompt).not.toBeUndefined() })
    deliverPrompt?.('p1', { kind: 'text', message: 'Paste the code' })
    const dialog = within(await screen.findByRole('dialog'))
    await dialog.findByText('Paste the code')
    const input = dialog.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'the-code' } })
    fireEvent.click(dialog.getByText(en.authContinue))
    await waitFor(() => { expect(respondAuthorization).toHaveBeenCalledWith('llm-pi-ai/anthropic', 'p1', 'the-code') })
  })

  it('answers a select prompt directly on option click, with no separate submit step', async () => {
    const { operations } = stubOperations()
    let deliverPrompt: ((promptId: string, prompt: WireAuthorizationPrompt) => void) | undefined
    const { authOperations, respondAuthorization } = stubAuthOperations({
      begin: (_key, _method, _signal, handlers) => {
        deliverPrompt = handlers.onPrompt
        return new Promise(() => {})
      },
    })
    render(<ProviderEditor
      provider="anthropic"
      displayName="Anthropic"
      namespace={piAiNamespace({ anthropic: {} })}
      schema={settingsSchema}
      settingsPath={['providers', 'anthropic']}
      operations={operations}
      authOperations={authOperations}
      t={t}
      readOnly={false}
      onClose={vi.fn()}
    />)
    fireEvent.click(await screen.findByText('Sign in with Anthropic'))
    await waitFor(() => { expect(deliverPrompt).not.toBeUndefined() })
    deliverPrompt?.('p1', {
      kind: 'select',
      message: 'Choose a workspace',
      options: [{ id: 'ws-1', label: 'Workspace One' }, { id: 'ws-2', label: 'Workspace Two' }],
    })
    fireEvent.click(await screen.findByText('Workspace One'))
    await waitFor(() => { expect(respondAuthorization).toHaveBeenCalledWith('llm-pi-ai/anthropic', 'p1', 'ws-1') })
  })

  it('declines the pending prompt through declineAuthorization', async () => {
    const { operations } = stubOperations()
    let deliverPrompt: ((promptId: string, prompt: WireAuthorizationPrompt) => void) | undefined
    const { authOperations, declineAuthorization } = stubAuthOperations({
      begin: (_key, _method, _signal, handlers) => {
        deliverPrompt = handlers.onPrompt
        return new Promise(() => {})
      },
    })
    render(<ProviderEditor
      provider="anthropic"
      displayName="Anthropic"
      namespace={piAiNamespace({ anthropic: {} })}
      schema={settingsSchema}
      settingsPath={['providers', 'anthropic']}
      operations={operations}
      authOperations={authOperations}
      t={t}
      readOnly={false}
      onClose={vi.fn()}
    />)
    fireEvent.click(await screen.findByText('Sign in with Anthropic'))
    await waitFor(() => { expect(deliverPrompt).not.toBeUndefined() })
    deliverPrompt?.('p1', { kind: 'text', message: 'Paste the code' })
    fireEvent.click(await screen.findByText(en.authDecline))
    await waitFor(() => { expect(declineAuthorization).toHaveBeenCalledWith('llm-pi-ai/anthropic', 'p1') })
  })

  it('cancels the attempt on the dialog close action, aborting the local signal and calling cancelAuthorization', async () => {
    const { operations } = stubOperations()
    let capturedSignal: AbortSignal | undefined
    const { authOperations, cancelAuthorization } = stubAuthOperations({
      begin: (_key, _method, signal) => {
        capturedSignal = signal
        return new Promise(() => {})
      },
    })
    render(<ProviderEditor
      provider="anthropic"
      displayName="Anthropic"
      namespace={piAiNamespace({ anthropic: {} })}
      schema={settingsSchema}
      settingsPath={['providers', 'anthropic']}
      operations={operations}
      authOperations={authOperations}
      t={t}
      readOnly={false}
      onClose={vi.fn()}
    />)
    fireEvent.click(await screen.findByText('Sign in with Anthropic'))
    const dialog = within(await screen.findByRole('dialog'))
    await waitFor(() => { expect(capturedSignal).not.toBeUndefined() })
    fireEvent.click(dialog.getByText(en.cancel))
    expect(capturedSignal?.aborted).toBe(true)
    expect(cancelAuthorization).toHaveBeenCalledWith('llm-pi-ai/anthropic')
    // The dialog closes quietly: no failure banner from a dismissal.
    expect(screen.queryByText(en.authSigningIn)).toBeNull()
  })

  it('on an authorized outcome, re-describes the credential and authorization state and drops the affordance\'s busy state', async () => {
    const { operations, describeCredential } = stubOperations()
    let resolveBegin: ((outcome: AuthorizationOutcome) => void) | undefined
    const inFlightEntry: AuthorizationEntry = {
      key: credentialKey('llm-pi-ai', 'anthropic'),
      label: 'Anthropic',
      methods: [{ id: 'oauth', label: 'Sign in with Anthropic' }],
      inFlight: false,
    }
    const { authOperations, describeAuthorization } = stubAuthOperations({
      entry: inFlightEntry,
      begin: () => new Promise((resolve) => { resolveBegin = resolve }),
    })
    render(<ProviderEditor
      provider="anthropic"
      displayName="Anthropic"
      namespace={piAiNamespace({ anthropic: {} })}
      schema={settingsSchema}
      settingsPath={['providers', 'anthropic']}
      operations={operations}
      authOperations={authOperations}
      t={t}
      readOnly={false}
      onClose={vi.fn()}
    />)
    fireEvent.click(await screen.findByText('Sign in with Anthropic'))
    await screen.findByText(en.authSigningIn)
    resolveBegin?.({ status: 'authorized' })
    await waitFor(() => { expect(screen.queryByText(en.authSigningIn)).toBeNull() })
    // Re-described on the way back to "already configured": one extra call
    // each, beyond the mount-time describe.
    expect(describeCredential).toHaveBeenCalledTimes(2)
    expect(describeAuthorization).toHaveBeenCalledTimes(2)
  })
})
