---
description: "The Anthropic-subscription-backed search provider for ctx.web: native web_search authenticated with the Claude OAuth grant already stored for chat, not a separate metered API key."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-anthropic

## Summary

With `dsh-web-search-anthropic`, the harness searches the web through Anthropic's own native `web_search_20250305` server tool, authenticated with the same Claude subscription OAuth grant `llm-pi-ai` already stores for chat (default route `anthropic`) — no separate metered API key. Anthropic's OAuth-authenticated endpoint only accepts requests that present as Claude Code, so every search carries the same `anthropic-beta` features, identity headers, and system-prompt identity block Claude Code itself sends. This provider does not perform its own OAuth refresh: an expired grant is refreshed the same way chat refreshes it (send a message on that route, or sign in again), and this provider surfaces that as an actionable error rather than a silent failure. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [What a search returns](#what-a-search-returns)
- [Failures and recovery](#failures-and-recovery)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider alongside the web service and an already-signed-in `llm-pi-ai` `anthropic` route; it registers as the `anthropic-subscription` search provider.

### When to choose it

Choose this backend when a deployment has already signed a Claude subscription into an `llm-pi-ai` route (Settings > Models) and wants web search billed against that subscription instead of a separate Exa, Perplexity, or DeepSeek key. The provider is unavailable when no stored grant resolves and no literal token is configured.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-anthropic'
```

| Field | Default | Meaning |
|---|---|---|
| `route` | `anthropic` | The `llm-pi-ai` provider route whose stored OAuth grant to reuse |
| `baseURL` | `https://api.anthropic.com/v1` | Anthropic Messages endpoint base; `/messages` is appended |
| `model` | `claude-sonnet-5` | Anthropic model id |
| `apiVersion` | `2023-06-01` | `anthropic-version` header value |
| `maxTokens` | `4096` | Positive-integer upper bound on generated tokens for the Messages request |
| `maxUses` | `5` | Positive-integer maximum `web_search` server-tool uses per request |

<a id="what-a-search-returns"></a>
### What a search returns

Each result maps to a `WebSearchSource`: `url`, `title`, a citation-joined `snippet`, and `page_age` as `publishedAt`. Anthropic returns no generated answer for this provider's request shape, so the result carries no `content`.

<a id="failures-and-recovery"></a>
### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable or wrong-shape bodies — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`; no stored grant at all surfaces as `WEB_PROVIDER_CREDENTIAL_MISSING`. An expired grant is a distinct `WEB_PROVIDER_ERROR` naming that this provider does not refresh it itself — send a chat message on the same route, or sign in again, then retry.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No self-refresh.** This provider reads the stored grant but never rotates it; an expired token surfaces as an actionable error instead of hanging or silently failing.
- **OAuth framing is hand-maintained, not delegated.** Anthropic's OAuth beta headers and Claude Code identity framing are reproduced here directly (mirroring `@earendil-works/pi-ai`'s internal client) because `pi-ai` offers no seam to pass through a raw provider-native server tool; a `pi-ai` upgrade that changes this framing needs a matching update here.
- **Bilingual/generated docs are not yet in parity** with sibling `web-search-*` packages (`README.zh.md`, `README.i18n.yaml`, and the generated config-catalog entry) — regenerate via the repo's `gen-config-catalog`/doc-sync scripts before treating this package as documentation-complete.
