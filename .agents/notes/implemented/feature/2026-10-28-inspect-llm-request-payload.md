# Agent Note: Inspect LLM request payload

Status: implemented

English | [中文](2026-10-28-inspect-llm-request-payload.zh.md)

## Problem

A Trajectory row showed what the model answered but not what DSH sent: the system prompt, the tool schemas and the transcript the Claude Code adapter rendered into the `claude -p` stdin. Token usage was visible per call, but nothing explained where those tokens went, so cache misses and prompt bloat could only be guessed at.

## Decision

Right-clicking an assistant row in the Trajectory ledger opens a small menu with "Inspect request", which docks a panel beside the ledger showing the exact payload of that call by category (transcript convention, system prompt, tools, transcript) and item, with byte sizes and token estimates scaled to the usage the provider reported.

- **Capture.** `GenerateOptions.onRequest` is an optional hook; only the Claude Code adapter calls it, with the argv, environment variable names (never values), system text, tool definitions and stdin it is about to spawn with. Image bytes are omitted from the reported stdin. A failing hook never fails the call.
- **Storage.** After each call the agent loop writes the payload as a gzip sidecar at `<session directory>/payloads/<turn or header seq>-<step>-<attempt>.json.gz` (temp file then rename, a `-rN` suffix when the name exists) and appends a `request/payload` event naming the blob. The JSON is capped at 5 MB: `stdin`, then `system`, then `tools`, then `argv` and `envKeys` are replaced by placeholders while their original byte lengths (`stdinBytes`, `systemBytes`, `toolsBytes`, `argvBytes`, `envKeysBytes`) and `truncated: true` are kept. Writing is best effort and logged. `SessionPersistence.sessionDirectory` supplies the directory; backends without one record nothing.
- **Read.** The session controller exposes `requestPayload({ sessionId, blob })`, surfaced to clients as `Session.readRequestPayload`. It accepts only names matching `^\w[\w.-]*\.json\.gz$` of at most 255 characters and not a Windows device name, resolves the directory from the stored session header rather than the request, bounds the stored file and the inflated output at 8 MB, and checks the payload shape. Missing sessions or blobs read as `undefined`; the wire type is its own JSON-typed shape.
- **UI.** The request view carries `payloadBlob`/`payloadTruncated` from the event; `TrajectoryTable` takes an optional `onInspectRequest` and shows the shared `Menu` only on assistant rows with that prop; `TrajectoryView` loads the blob on demand, ignores stale results, and shows loading, "not captured" or the ready panel. `composeRequest` is pure; items over 64,000 characters preview with a "Show all" control. The strings live in `inspect.*` keys in all eight locales.

## Alternatives considered

- **Reconstruct the payload from the prompt snapshot.** Rejected: it would be an approximation labelled as exact, and the point is to see precisely what was sent. Sessions recorded before this change simply show "not captured".
- **Store the payload inline in the session log.** Rejected: payloads reach megabytes per call and repeat the whole transcript, which would bloat the log every replay reads; a sidecar is read only on demand.
- **Report payloads for every provider.** Rejected for now: only the Claude Code adapter builds a process payload whose exact bytes differ from the messages DSH already holds; other adapters can adopt the hook later.
- **Hand-rolled context menu.** Rejected in review in favour of the shared `Menu`, which already handles placement, dismissal and focus.

## Consequences

- The exact request is inspectable per call, and a truncated payload still reports original sizes, at the cost of the cap hiding bodies of oversized items.
- Each call writes a blob of up to 5 MB compressed and awaits that write before the next step; blobs grow with the transcript, and there is no per-session disk budget. They live beside the session and go with it.
- Blobs hold the full conversation, including tool results; they carry the same exposure as the session log, and the Remote method has no per-caller check beyond knowing the session id, like its neighbours.
- A request still running when inspected shows "not captured", because the event is appended after the stream ends, and a failed read shows the same message.
- `request/payload` is a first-party event, so older builds cannot open sessions that contain it.
- Forked sessions do not copy the blobs, so inspecting a parent's calls from a fork shows "not captured".

## Testing

Writer coverage pins round trip, cap order, the original byte sizes, name rejection and no overwrite on a repeated name. Reader coverage pins unsafe and device names, cross-session isolation, shape rejection, corrupt blobs and the inflate bound. Loop coverage pins the event, a failing sink and absent payloads. Client coverage pins composition, the panel (preview cap, memoized usage, truncated note), the row menu on assistant rows only, and the view's loading, missing and ready states.

## Related

[`llm-claude-code`](../../../../packages/llm/llm-claude-code) hosts the adapter that reports the payload; the request view comes from the trajectory assistant definition.
