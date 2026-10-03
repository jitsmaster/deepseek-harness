/**
 * Per-call user approval for the model-facing `web_fetch` tool. A fetch sends
 * the request line to an arbitrary public host, so a prompt-injected model could
 * use it to move data off the machine. The gate is a `tools/pre-execute` listener
 * that answers `ask`; `ctx.approval` then applies the session policy (`ask`
 * prompts the user, `never` rejects) before the tool body can reach the network.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'

/** The registered tool name this gate applies to. */
const WEB_FETCH_TOOL_NAME = 'web_fetch'

/** Pull the requested URL out of unvalidated tool arguments for the approval prompt. */
function requestedUrl(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || !('url' in args)) return undefined
  return typeof args.url === 'string' ? args.url : undefined
}

/**
 * Whether this call must be approved. Deployments that compose no approval
 * service (the pinned full-access `sdk-minimal` tree) have nothing to ask, and a
 * session in the `danger-full-access` sandbox mode (the Full access and Auto
 * presets, and children delegated from them) has already given up confinement,
 * the same condition under which sandbox escalation needs no approval.
 */
function requiresApproval(ctx: Context, exec: ToolExecution): boolean {
  if (ctx.get('approval') === undefined) return false
  const mode = ctx.get('sandboxPolicy')?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session }).mode
  return mode !== 'danger-full-access'
}

/** Build the `ask` decision naming the URL in both the audit reason and the localized prompt. */
function askToFetch(url: string | undefined): PreToolDecision {
  const target = url ?? 'a URL'
  return {
    kind: 'ask',
    reason: `web_fetch requests a network fetch of ${target}`,
    displayReason: {
      en: `Fetch ${target}? The request can send data to that host.`,
      zh: `获取 ${target}？该请求可能向该主机发送数据。`,
    },
  }
}

/**
 * Gate every `web_fetch` call (including `run_code` sub-calls) behind the
 * approval seam. Other listeners' `deny`, `cancel`, and `ask` decisions win over
 * this gate; an otherwise-allowed call becomes an `ask`, which the registry runs
 * only after `ctx.approval` returns `allowed-once` and denies for every other
 * outcome, so a rejected or unavailable approval never reaches `ctx.web.fetch`.
 *
 * @param ctx - context whose `tools/pre-execute` waterfall receives the listener;
 *   the listener is effect-scoped and unregisters on plugin dispose.
 */
export function applyWebFetchApproval(ctx: Context): void {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name !== WEB_FETCH_TOOL_NAME || !requiresApproval(ctx, exec)) return next()
    const downstream = await next()
    return downstream.kind === 'allow' ? askToFetch(requestedUrl(exec.arguments)) : downstream
  })
}
