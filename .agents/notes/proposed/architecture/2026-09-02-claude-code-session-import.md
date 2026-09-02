# Agent Note: Claude Code session import and skill-derived slash commands

Status: proposed

## Problem

DSH now has a working Claude (Anthropic) route through `llm-pi-ai` (browser OAuth sign-in; see [browser authorization and keyless web search](2026-09-01-browser-authorization-and-keyless-web-search.md)). A user who also drives Claude Code CLI sessions on the same machine wants to carry a Claude Code conversation into DSH and keep going, without re-explaining context, and wants the same Claude Code Skills they use there available as DSH slash commands once they're working on a Claude-backed DSH session.

Two adjacent asks were considered and rejected before this proposal:

- **Live-attach into a running `claude --bg` session.** Feasible in principle (`claude agents --json` for discovery/status), but the only ways to read a live session's turns or inject new input are the transcript JSONL (Anthropic's own docs: internal format, changes between releases) and an undocumented cross-session messaging socket. Coupling DSH to both, continuously, for the life of an attached session is a standing maintenance liability against a surface DSH does not control.
- **Byte-perfect structural replay into DSH's session log.** Mapping Claude Code's own tool-call content blocks onto DSH's `SessionEventMap` would require an extensive, version-fragile translation layer and likely a `SESSION_FORMAT_VERSION` bump for a foreign event shape DSH does not own.

## Proposal

Two independent, server-side-only capabilities. Neither keeps a live connection to Claude Code once its one-shot work is done.

### 1. `claude-session-import`

A one-time import, not a live bridge:

- **Discovery**: shell out to `claude agents --json --all`; surface `{id, name, cwd, status, startedAt}` to a new "Import from Claude Code" entry point in DSH's session-creation UI.
- **Import**: on selection, map the chosen session's `cwd` to its Claude Code project directory and read `~/.claude/projects/<project>/<id>.jsonl` **once**. Extract user/assistant text turns; render recognizable `tool_use`/`tool_result` blocks as readable text summaries (e.g. "ran `ls -la`, output: …") rather than attempting structural fidelity — an unrecognized block degrades to a text summary instead of failing the import.
- **Session creation**: seed a new DSH session with the reconstructed turns as opening context, default its model to `anthropic`/`claude-sonnet-5`. From this point the session is fully DSH-native — its own agent loop and tools own everything that happens next. No further contact with Claude Code, the `claude` binary, or the source JSONL.
- **RPC surface**: a new controller exposing `list()` and `createFrom(id)`, following the `AuthorizationController` pattern from the OAuth feature (RPC methods + wire types, no bespoke transport).

### 2. `claude-skill-commands`

- Mounts **per-agent** (agent-scoped, the same shape `dsh-plan-mode` uses), reading that agent's session `cwd`.
- Scans `<cwd>/.claude/skills/` and `~/.claude/skills/` for `SKILL.md` files and parses each one's frontmatter (`name`, `description`).
- Registers one `ctx.commands.register()` entry per skill through the existing `dsh-commands` registry — no new command infrastructure. Project-level skills shadow user-level ones of the same name, matching the registry's existing agent-scoped-shadows-global precedence.
- Invoking `/skill-name [args]` reads that skill's full body and submits it as the agent's next-turn input, the same mechanism `/plan [message]` already uses.
- **Gated to Claude-backed sessions only**: the plugin checks the agent's *current* model selection and registers these commands only while that agent is running on the `anthropic` route. Switching a session's model away from `anthropic` mid-conversation removes them again — they are re-evaluated, not decided once at mount. Claude Code Skills are authored against Claude's own conventions and should not silently apply to a DeepSeek-backed agent.

### Error handling

- `claude` binary missing/not on PATH: discovery returns an empty list with a clear "Claude Code CLI not found" message, not a crash.
- Transcript JSONL missing, unreadable, or its shape has drifted: import fails loud with a specific error, never a silent partial or garbled import.
- Malformed or frontmatter-less `SKILL.md`: skipped with a logged warning; the rest of the scan still completes — this is foreign, best-effort discovery over files DSH does not own, not DSH's own configuration.

### Testing

- Transcript-parser unit tests over fixture JSONL: plain text turns, `tool_use`/`tool_result` blocks, and malformed/unrecognized block shapes.
- Skill-scanner unit tests: valid skill, malformed frontmatter, project-vs-user precedence, missing directories.
- `claude agents --json --all` wrapper unit tests against a stubbed subprocess: binary missing, malformed JSON, empty list, well-formed list.
- RPC controller host tests mirroring `authorization-controller.host.spec.ts`.
- Model-gating test: skill commands present for an `anthropic`-selected agent, absent otherwise, re-evaluated on model switch.
- Client picker component test: list rendering, selection triggers RPC, error states.
- A recorded-session snapshot test importing a fixture transcript and asserting the new session's opening turns, per this repo's snapshot testing policy.
- Integration test invoking `/skill-name args` through the real commands registry, confirming the agent's next turn receives that skill's content.

## Alternatives considered

- **Live-attach bridge (JSONL tail + cross-session messaging socket).** Rejected: couples DSH continuously to two surfaces Anthropic's own docs describe as internal/undocumented, for the life of every attached session, rather than once at import time.
- **Byte-perfect structural import into DSH's own session-log event types.** Rejected: no clean mapping exists from Claude Code's tool-call content blocks onto `SessionEventMap`; would need an extensive, version-fragile translation layer and likely a format-version bump for a foreign event shape.
- **Plain-text-only import, dropping tool call/result content entirely.** Rejected in favor of rendering recognized tool blocks as readable text summaries: nearly as simple and robust, but preserves more of what Claude Code actually did before the import instead of losing it outright.
- **Headless relay (`claude -p --resume <id> --output-format json` per message) instead of a one-time import.** Rejected: this is a genuinely documented, stable interface, but it is not "continue in DSH" — it keeps every subsequent turn dependent on the Claude Code CLI and could conflict with the same session running or attached elsewhere.
- **Ungated skill commands (available regardless of the session's model).** Rejected: Claude Code Skills are authored against Claude's own conventions; surfacing them unconditionally risks a DeepSeek-backed agent receiving instructions written for a different model's behavior.

## Acceptance criteria

- A user can open "Import from Claude Code" in DSH's session-creation UI, see their `claude agents --json --all` sessions listed, pick one, and land in a new DSH session whose opening context reflects that Claude Code conversation's prior turns (including readable summaries of any tool calls it ran).
- The imported session runs entirely on DSH's own agent loop and tools going forward; nothing it does after creation touches Claude Code, the `claude` binary, or the source transcript file.
- While a session's active model is `anthropic`, `/`-typing surfaces that session's Claude Code Skills (from its `cwd` and the user's home skills directory) as commands; switching to a non-Claude model removes them.
- `claude` being absent, a corrupt transcript, or a malformed skill file each fail predictably (empty list / loud import error / skipped skill with a warning) without breaking anything else in DSH.

## Risks

- Claude Code's JSONL transcript format is explicitly documented as internal and subject to change between releases; the parser will need maintenance when it drifts. Mitigated by scope: it is read once at import time, not tailed live, so a format change surfaces as a loud, contained import failure rather than corrupting an in-progress session.
- `claude agents --json --all`'s own output shape is a CLI-surface dependency DSH does not control; a breaking change there degrades discovery to an empty list rather than a crash, per the error-handling section above, but the feature is unusable until adjusted.
- Rendering `tool_use`/`tool_result` blocks as text summaries is a lossy, best-effort translation with no fixed spec; summaries may read awkwardly for tool shapes not yet seen in practice. Acceptable because the alternative (dropping them, or attempting full structural fidelity) is strictly worse per the alternatives above.
- Skill-command gating reads the agent's *current* model selection, which must be re-evaluated on every relevant change (not cached at mount) — an implementation that decides once at mount would silently leak Claude-authored instructions into a later non-Claude turn.
