/**
 * Import-from-Claude-Code plugin, browser half. One registration: ImportFlow
 * fills ui-workspace's `sidebar.workspaces.importFlow` hole with the discover
 * + import dialog, driven by the `claudeSessionImport` Remote namespace
 * (Task 4's `@Remote list()`/`createFrom()` on `ClaudeSessionImportController`).
 * Export discipline: packages/client/AGENTS.md.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotMap merge declaring the import-flow hole.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ImportFlow } from './ImportFlow.tsx'
import type { ImportFlowInjected } from './ImportFlow.tsx'
import { en, zh, type SessionImportKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The "Import from Claude Code" dialog copy. */
    'session-import': SessionImportKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'session-import'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-workspace's apply, whose activation order relative to this one is NOT
 * constrained; registration depends on that declaration through `slots.inject()`.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.claudeSessionImport']

/**
 * Register the copy dictionaries and the import flow once
 * `sidebar.workspaces.importFlow` is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-session-import: dictionaries')

  const injected = (): ImportFlowInjected => ({
    operations: {
      list: async (signal) => {
        const response = await ctx.remote.claudeSessionImport.list(signal)
        if (!response.ok) throw response.error
        return response.value
      },
      createFrom: async (sessionId, signal) => {
        const response = await ctx.remote.claudeSessionImport.createFrom(sessionId, signal)
        if (!response.ok) throw response.error
        return response.value
      },
    },
    t: ctx.locale.bind(NS),
  })
  ctx.slots.inject('sidebar.workspaces.importFlow', () => ctx.slots.register({
    name: 'sidebar.workspaces.importFlow',
    inject: injected,
  }, ImportFlow))
}
