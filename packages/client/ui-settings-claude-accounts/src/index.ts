/**
 * Claude Code accounts card, node half. The empty apply exists so the plugin
 * appears in the host cordis.yml / Loader; the browser half owns the card
 * through exports["./client"], discovered from the package.json dsh.client
 * declaration. The accounts, their usage, and the default-login swap come from
 * the `claudeAccounts` Remote namespace of the Claude Code LLM plugin, so this
 * package registers no namespace of its own.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
