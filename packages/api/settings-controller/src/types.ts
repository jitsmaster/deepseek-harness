/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * The `authorization/notice`/`authorization/prompt` Events declarations and
 * the `AuthorizationEntryView`/`AuthorizationOutcomeView` Remote boundary
 * types below belong to `./authorization.ts`'s `AuthorizationController` in
 * every sense except reachability: they are wire concepts invented purely
 * for that controller's RPC (see its own doc comment), but the typert
 * generator requires a Remote method's boundary types to be exported from a
 * public non-root type subpath, and this package has no client-safe export
 * for `authorization.ts` itself — so they live here, the one module this
 * package already registers for the Client compilation face, and
 * `authorization.ts` re-exports/imports them rather than keeping a second copy.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

import type {
  AuthorizationMethod, AuthorizationNotice, AuthorizationOutcome, AuthorizationPrompt,
} from '@deepseek-ai/dsh-authorization/types'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'

/**
 * Distributes `Omit` across a union instead of collapsing it to the fields
 * common to every member — plain `Omit<Union, K>` reads `keyof Union` as only
 * those common fields, silently dropping variant-only fields like `options`.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** {@link AuthorizationPrompt} minus the field that cannot cross the wire. */
export type WireAuthorizationPrompt = DistributiveOmit<AuthorizationPrompt, 'signal'>

/** The wire view of one registered flow: {@link AuthorizationEntry} projected field-by-field. */
export interface AuthorizationEntryView {
  readonly key: CredentialKey
  readonly label: string
  readonly methods: readonly AuthorizationMethod[]
  readonly inFlight: boolean
}

/** The wire view of one finished `begin()` attempt. {@link AuthorizationOutcome} is already wire-safe verbatim. */
export type AuthorizationOutcomeView = AuthorizationOutcome

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A running authorization attempt reported progress, or told the human
     * what to do next. Fire-and-forget, same as the seam's own `notify`.
     * @param payload - `key` naming the attempt's flow, and the `notice` it reported.
     * @mode emit
     */
    'authorization/notice'(payload: { key: string; notice: AuthorizationNotice }): void
    /**
     * A running authorization attempt needs an answer before it can
     * continue. `promptId` correlates this prompt with the `respond()` or
     * `decline()` call that answers it; the prompt's own `signal` never
     * crosses the wire.
     * @param payload - `key` naming the attempt's flow, the `promptId` correlating
     *   the answering call, and the wire-safe `prompt` to answer.
     * @mode emit
     */
    'authorization/prompt'(payload: { key: string; promptId: string; prompt: WireAuthorizationPrompt }): void
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
    /** No authorization flow is registered for the requested key. */
    'authorization/no-flow': { readonly key: string }
    /** The requested method is not one the registered flow offers. */
    'authorization/unknown-method': { readonly key: string; readonly method: string }
    /** An authorization attempt for this key is already running. */
    'authorization/already-in-flight': { readonly key: string }
    /** The flow resolved without committing a credential record during the attempt. */
    'authorization/not-committed': { readonly key: string }
    /** `respond()`/`decline()` named a `(key, promptId)` with no pending prompt. */
    'authorization/unknown-prompt': { readonly key: string; readonly promptId: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** Result of opening or revealing one locally authored Agent preset directory. */
export type AgentPresetDirectoryOpenValue =
  | { readonly opened: true }
  | { readonly opened: false; readonly path: string }
