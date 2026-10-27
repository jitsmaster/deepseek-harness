/**
 * The Claude Code accounts card, browser half: it registers into the Models
 * page's `settings.models.footer` slot, so Claude accounts sit beside the
 * provider cards. The card lists the emails of the Claude Code LLM plugin with
 * their plan usage, switches the account DSH runs Claude Code as, opens the
 * plugin's sign-in flow, and can make one account the default for every Claude
 * Code on the machine. It renders nothing unless the Host serves that plugin's
 * settings entry.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the Models page's SlotMap merge (the 'settings.models.footer' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ClaudeAccountsCard } from './ClaudeAccountsCard.tsx'
import type { ClaudeAccountsFace } from './ClaudeAccountsCard.tsx'
import { createAuthorizationOperations } from './authorization-operations.ts'
import { ClaudeAccountsController } from './controller.ts'
import { en, ja, es, fr, de, ru, pt, zh, type ClaudeAccountsLocaleKey } from './locales.ts'
import { createClaudeAccountsOperations } from './operations.ts'

export type { ClaudeAccountsCardProps, ClaudeAccountsFace } from './ClaudeAccountsCard.tsx'
export type { AccountRow, CardNotice, ClaudeAccountsState } from './controller.ts'
export type { ClaudeAccountsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Claude accounts card copy. */
    'settings.claudeAccounts': ClaudeAccountsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.claudeAccounts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.settings', 'remote.authorization', 'remote.claudeAccounts']

/**
 * Register the card into the Models page footer and keep it fresh on every pushed
 * invalidation (settings document, finished sign-in, reconnect).
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-settings-claude-accounts: dictionaries')
  const controller = new ClaudeAccountsController(createClaudeAccountsOperations(ctx))
  const authOperations = createAuthorizationOperations(ctx)
  const face: ClaudeAccountsFace = { hooks: { claudeAccounts: controller.store }, controller, authOperations }
  ctx.effect(() => {
    const disposers = [
      ctx.remote.$on('settings/document-updated', () => { void controller.refresh(true) }),
      ctx.remote.$on('authorization/settled', () => { void controller.refresh(true) }),
      ctx.on('connection/reset', () => { void controller.refresh(true) }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
      controller.dispose()
    }
  }, 'ui-settings-claude-accounts: pushed invalidations')
  ctx.effect(() => ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'claude-accounts',
    order: 100,
    locale: NS,
    inject: () => face,
  }, ClaudeAccountsCard)), 'ui-settings-claude-accounts: card')
}
